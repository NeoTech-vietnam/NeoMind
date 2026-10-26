import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { controlledValidation, controlledResultFailure } from '../dist/controlled-observability.js';
import { expandControlledSchemaIssues } from '../dist/controlled-schema-diagnostics.js';
import { controlledPayloadSchema } from '../dist/controlled-payload.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('nested practice union identifies the closest branch concrete objective and answer types without inventing required command', () => {
  const question=z.strictObject({objective_ids:z.array(z.string()),answer:z.string()});
  const schema=z.strictObject({practice:z.union([
    z.strictObject({questions:z.array(question),command:z.array(z.string()),procedure:z.array(z.string()).optional()}),
    z.strictObject({questions:z.array(question),command:z.array(z.string()).optional(),procedure:z.array(z.string())})])});
  const parsed=schema.safeParse({practice:{procedure:['Explain the procedure.'],questions:[{objective_ids:'O1',answer:{text:'SECRET_VALUE'}}]}});
  assert.equal(parsed.success,false);
  const before=JSON.stringify(parsed.error.issues),result=controlledValidation('SCHEMA_INVALID',undefined,parsed.error.issues);
  assert.deepEqual(result.issues.map(issue=>[issue.path,issue.code,issue.message]),[
    [['practice','questions',0,'objective_ids'],'invalid_type','Expected array.'],
    [['practice','questions',0,'answer'],'invalid_type','Expected string.']]);
  assert.equal(result.code,'SCHEMA_INVALID');assert.equal(result.owner,'agent-content');
  assert.equal(JSON.stringify(parsed.error.issues),before);assert.doesNotMatch(JSON.stringify(result),/SECRET_VALUE/);
  const encoded=controlledResultFailure({isError:true,content:[{type:'text',text:'Input validation error: '+JSON.stringify(parsed.error.issues)}]});
  assert.deepEqual(encoded.issues,result.issues);
});

test('ambiguous nested unions are deterministic and bounded without leaking raw values, custom messages or field names', () => {
  const secret='SECRET_SCHEMA_CANARY';
  const leaf={code:'custom',path:['practice','api_key',secret],message:secret,received:secret,values:[secret]};
  const union={code:'invalid_union',path:['practice'],errors:Array.from({length:1000},()=>Array.from({length:1000},()=>leaf)),message:secret};
  const first=controlledValidation('SCHEMA_INVALID',secret,[union]),second=controlledValidation('SCHEMA_INVALID',secret,[union]);
  assert.deepEqual(first,second);assert.ok(first.issues.length<=8);assert.ok(first.issues.every(issue=>issue.path.length<=8));
  assert.doesNotMatch(JSON.stringify(first),/SECRET_SCHEMA_CANARY|api_key/);assert.ok(JSON.stringify(first).length<8000);
  const cycle={code:'invalid_union',path:['practice']};cycle.errors=[[cycle]];
  assert.ok(controlledValidation('SCHEMA_INVALID',undefined,[cycle]).issues.length<=8);
  const hostile={code:'invalid_union',path:['practice'],errors:[[{code:'invalid_type',expected:secret,path:['answer'],message:secret}]]};
  Object.defineProperty(hostile,'message',{get(){throw new Error('Raw custom message must never be read.');}});
  assert.doesNotThrow(()=>controlledValidation('SCHEMA_INVALID',undefined,[hostile]));
  assert.doesNotMatch(JSON.stringify(controlledValidation('SCHEMA_INVALID',undefined,[hostile])),/SECRET_SCHEMA_CANARY/);
});

test('ordinary safe validation feedback remains unchanged and traversal uses only bounded metadata', () => {
  const original=[{code:'invalid_type',path:['questions',0,'answer'],expected:'string',message:'SECRET_CUSTOM'}];
  assert.deepEqual(controlledValidation('SCHEMA_INVALID',undefined,original).issues,
    [{path:['questions',0,'answer'],code:'invalid_type',message:'Expected string.'}]);
  let reads=0;const hostile={code:'invalid_union',path:['practice']};
  Object.defineProperty(hostile,'errors',{get(){reads++;throw new Error('Do not invoke getters.');}});
  assert.deepEqual(expandControlledSchemaIssues([hostile],issue=>({code:issue.code,path:issue.path})),
    [{code:'invalid_union',path:['practice']}]);assert.equal(reads,0);
});

test('real MCP SDK practice rejection preserves concrete safe union fields before the callback and does not weaken validation', async t => {
  const question=z.strictObject({objective_ids:z.array(z.string()),answer:z.string()});
  const semantic=z.strictObject({practice:z.union([
    z.strictObject({questions:z.array(question),command:z.array(z.string()),procedure:z.array(z.string()).optional()}),
    z.strictObject({questions:z.array(question),command:z.array(z.string()).optional(),procedure:z.array(z.string())})])});
  const server=new McpServer({name:'bounded-union-diagnostics',version:'1'}),client=new Client({name:'union-test',version:'1'});
  let called=0;
  server.registerTool('research',{inputSchema:controlledPayloadSchema(semantic)},()=>{called++;return{content:[{type:'text',text:'{}'}]};});
  const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  const input={practice:{procedure:['Complete the actual exercise.'],questions:[{objective_ids:'O1',answer:{text:'SECRET_RAW_VALUE'}}]}};
  assert.equal(semantic.safeParse(input).success,false);
  const result=await client.callTool({name:'research',arguments:input});
  assert.equal(result.isError,true);assert.equal(called,0,'The same invalid semantic request cannot reach its callback.');
  const failure=controlledResultFailure(result);
  assert.equal(failure.code,'SCHEMA_INVALID');
  assert.deepEqual(failure.issues.map(issue=>[issue.path,issue.code,issue.message]),[
    [['practice','questions',0,'objective_ids'],'invalid_type','Expected array.'],
    [['practice','questions',0,'answer'],'invalid_type','Expected string.']]);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_RAW_VALUE/);
  const valid={practice:{procedure:['Complete the actual exercise.'],questions:[{objective_ids:['O1'],answer:'A concrete answer.'}]}};
  assert.equal(semantic.safeParse(valid).success,true);
  const passed=await client.callTool({name:'research',arguments:valid});
  assert.notEqual(passed.isError,true);assert.equal(called,1,'Existing valid semantic requests still reach the callback unchanged.');
});

test('diagnostic field wrapper preserves defaults, coercion, preprocess, omitted fields, prepared paths and extra-field rejection', () => {
  const semantic=z.strictObject({title:z.string().trim(),number:z.coerce.number().int(),
    optional:z.string().default('existing-default'),preprocessed:z.preprocess(v=>typeof v==='string'?v.trim():v,z.string())});
  const original=controlledPayloadSchema(semantic);
  // Recreate the unchanged previous accepted-input predicate and transforms.
  const fields=Object.fromEntries(Object.entries(semantic.shape).map(([key,field])=>[key,z.preprocess(value=>value,field).optional()]));
  const prior=z.strictObject({...fields,input_path:z.string().min(1).max(1024).optional()}).superRefine((value,context)=>{
    if(Object.hasOwn(value,'input_path')){if(Object.keys(value).some(key=>key!=='input_path'))context.addIssue({code:'custom',message:'Mixed input rejected.'});return;}
    const parsed=semantic.safeParse(value);if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue({code:'custom',path:issue.path,message:issue.message});
  });
  const cases=[{title:'  Actual title  ',number:'12',preprocessed:'  preserve  '},
    {title:'Actual title',number:12,optional:undefined,preprocessed:'valid'}, {input_path:'prepared.json'},
    {input_path:'prepared.json',title:'mixed'}, {input_path:''}, {input_path:17},
    {title:'Actual title',number:'wrong',preprocessed:'valid'}, {title:'Actual title',number:12,preprocessed:'valid',extra:'SECRET_EXTRA'}];
  for(const input of cases){const before=prior.safeParse(input),after=original.safeParse(input);assert.equal(after.success,before.success);
    if(before.success)assert.deepEqual(after.data,before.data);}
  assert.equal(Object.hasOwn(original.parse({title:'Actual title',number:12,preprocessed:'valid'}),'optional'),false);
});
