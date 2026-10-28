import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer } from '../dist/controlled-tools.js';
import { authorizedControlledExecutionRepair, archiveControlledRegenerationOutputs } from '../dist/controlled-execution-regeneration.js';
import { hash, atomicWrite, safePath } from '../dist/storage.js';

function fixture(t) {
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'neomind-regeneration-proof-')));
  mkdirSync(join(root,'source'));writeFileSync(join(root,'source/generate.mjs'),'// original producer\n');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const binding={stage:'implementation',role:'developer',implementation_paths:['source'],verification_paths:['checks'],read_paths:['.']};
  return {root,binding};
}

test('repair authority requires the actual immutable file-write proof, not the mutable journal flag',async t=>{
  const {root,binding}=fixture(t),invocation='bounded-repair-actor',script='source/generate.mjs',before={[script]:hash(readFileSync(join(root,script)))};
  const server=createControlledMcpServer(root,{...binding,workflow_id:'WORKFLOW',task_id:'TASK',invocation_id:invocation},
    {assertActive(){},saveReport(){return{saved:true}}});
  const client=new Client({name:'repair-proof-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close()});
  assert.notEqual((await client.callTool({name:'project_read',arguments:{path:script}})).isError,true);
  assert.notEqual((await client.callTool({name:'task_file_write',arguments:{path:script,content:'// repaired producer\n'}})).isError,true);
  const current={[script]:hash(readFileSync(join(root,script)))};
  assert.ok(authorizedControlledExecutionRepair(root,invocation,before,current,binding));
  const state=JSON.parse(readFileSync(safePath(root,`.neomind/controlled-tools/${hash(invocation)}/state.json`),'utf8'));
  const folder=`.neomind/controlled-tools/${hash(invocation)}/writes/${state.writes[0].operation}`;
  for(const name of ['completion.json','intent.json','next.utf8','previous.utf8']){
    const target=safePath(root,`${folder}/${name}`),bytes=readFileSync(target);
    unlinkSync(target);assert.equal(authorizedControlledExecutionRepair(root,invocation,before,current,binding),undefined,name+' missing');
    atomicWrite(target,Buffer.concat([bytes,Buffer.from('changed')]));
    assert.equal(authorizedControlledExecutionRepair(root,invocation,before,current,binding),undefined,name+' corrupt');
    atomicWrite(target,bytes);
  }
  assert.ok(authorizedControlledExecutionRepair(root,invocation,before,current,binding));
  assert.equal(authorizedControlledExecutionRepair(root,invocation,before,current,{...binding,protected_paths:[script]}),undefined);
  assert.equal(authorizedControlledExecutionRepair(root,'foreign-actor',before,current,binding),undefined);
  writeFileSync(join(root,script),'// external producer edit\n');
  assert.equal(authorizedControlledExecutionRepair(root,invocation,before,{[script]:hash(readFileSync(join(root,script)))},binding),undefined);
});

test('regeneration archives the complete exact output set before exclusive replacement and refuses changed output',t=>{
  const{root,binding}=fixture(t),paths=['source/one.txt','source/two.txt'];
  paths.forEach((p,i)=>writeFileSync(join(root,p),`old output ${i}\n`));
  const expected=Object.fromEntries(paths.map(p=>[p,hash(readFileSync(join(root,p)))])),directory='.neomind/controlled/executions/11111111-1111-4111-8111-111111111111/regeneration';
  writeFileSync(join(root,paths[1]),'user edit\n');
  assert.throws(()=>archiveControlledRegenerationOutputs(root,directory,expected,binding),/changed outside/);
  assert.equal(readFileSync(join(root,paths[0]),'utf8'),'old output 0\n');
  assert.equal(readFileSync(join(root,paths[1]),'utf8'),'user edit\n');
  assert.equal(existsSync(safePath(root,directory)),false,'Whole-set preflight must precede archive/removal.');
  writeFileSync(join(root,paths[1]),'old output 1\n');
  const result=archiveControlledRegenerationOutputs(root,directory,expected,binding);
  assert.equal(result.files.length,2);assert.ok(paths.every(p=>!existsSync(join(root,p))));
  for(const file of result.files)assert.equal(hash(readFileSync(safePath(root,file.archive_path))),expected[file.path]);
  assert.equal(JSON.parse(readFileSync(safePath(root,`${directory}/removed.json`),'utf8')).removed,true);
});

test('regeneration never removes hardlinked, enlarged or protected generated files',t=>{
  const{root,binding}=fixture(t),p='source/output.txt',target=join(root,p),directory='.neomind/controlled/executions/22222222-2222-4222-8222-222222222222/regeneration';
  writeFileSync(target,'original');const expected={[p]:hash('original')};
  linkSync(target,join(root,'user-link.txt'));
  assert.throws(()=>archiveControlledRegenerationOutputs(root,directory,expected,binding),/bounded ordinary/);
  assert.equal(readFileSync(target,'utf8'),'original');unlinkSync(join(root,'user-link.txt'));
  writeFileSync(target,Buffer.alloc(10*1024*1024+1));
  assert.throws(()=>archiveControlledRegenerationOutputs(root,directory,expected,binding),/bounded ordinary/);
  assert.ok(existsSync(target));writeFileSync(target,'original');
  assert.throws(()=>archiveControlledRegenerationOutputs(root,directory,expected,{...binding,protected_paths:[p]}),/protected/);
  assert.equal(readFileSync(target,'utf8'),'original');
});
