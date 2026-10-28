import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync,copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { researchFixture } from './cornell-research-fixture.mjs';
import { compileCornellResearch, cornellResearchSchema, cornellCanonical } from '../dist/cornell-workflow.js';
import { createCornellNote, previewCornellArtifacts } from '../dist/notes.js';
import { createRecord, safePath, hash, getRecord, loadRecords } from '../dist/storage.js';
import { recordFingerprint } from '../dist/engineering.js';
import { controlledCornellResult } from '../dist/controlled-cornell-sources.js';
import { persistControlledCornellNote } from '../dist/controlled-cornell-write.js';

const assets=fileURLToPath(new URL('./fixtures/cornell-format-assets/',import.meta.url));
function fixture(t,letters=['A']) {
  const a=researchFixture(t),template='.agents/skills/format/assets/template.md',validator='.agents/skills/format/scripts/validate_notes.py';
  for(const [path,name] of [[template,'cornell-note-template.md'],[validator,'validate_notes.py']]) {
    mkdirSync(join(a.root,path,'..'),{recursive:true});copyFileSync(join(assets,name),safePath(a.root,path));
  }
  const profile={schema_version:1,id:'leetcode-cornell-v1',template:{path:template,sha256:'143d7be4ea4d7e00fcc3067b7843939cdfe63e14d4dcf11411c99a52c8eb6a37'},validator:{path:validator,sha256:'052b08835e19d17fd06dc7450251926400dff960c0893ef9113cd07cf5e8b5e0'}};
  const task=createRecord(a.root,{type:'task',title:'Compile the complete strategy and two distinct flow contract.',owner:'developer',links:[{type:'satisfies',target:a.requirement.meta.id}],data:{workflow_id:a.workflow.meta.id}});
  const flow='```mermaid\nflowchart TD\n    A[Input] --> B[Count pairs]\n    classDef step fill:#223344,color:#ffffff;\n    class A,B step;\n```';
  const input={...a.input,topic:'Leetcode - 4243 - Strategy contract fixture',task_id:task.meta.id,
    worked_example:{body:a.input.worked_example.body,expected:a.input.worked_example.expected},
    explanations:letters.flatMap(letter=>[
      {heading:`Strategy ${letter}: Enumerate finite pairs`,body:'[inferred] Enumerating each ordered pair explains the independent counting procedure [S1].'},
      {heading:`Strategy ${letter} Flow`,body:flow},
      {heading:`Strategy ${letter} Worked Example Flow`,body:flow},
    ])};
  const validate=path=>{const result=spawnSync(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),['-I','-B',safePath(a.root,validator),path],{encoding:'utf8',timeout:10000,windowsHide:true});assert.ifError(result.error);return result;};
  return {...a,input,profile,validate,task};
}

test('actual pinned validator accepts main Strategy H2 and both H3 flows rendered from the professional source',t=>{
  const a=fixture(t),original=JSON.stringify(a.input);
  const compiled=compileCornellResearch(a.root,a.input,{approved_source_files:[],format_profile:a.profile});
  const note=createCornellNote(a.root,compiled.note),path=safePath(a.root,note.meta.data.artifact_path),result=a.validate(path);
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  const body=readFileSync(path,'utf8');
  assert.match(body,/^## Strategy A: Enumerate finite pairs$/m);
  assert.match(body,/^### Strategy A Flow$/m);assert.match(body,/^### Strategy A Worked Example Flow$/m);
  assert.equal(JSON.stringify(a.input),original,'Rendering cannot rewrite the semantic research source.');
});

test('profile supports multiple generic strategy letters and preserves source code, JSON escapes and both flow bodies',t=>{
  const a=fixture(t,['A','B','Z']);
  const literal='```json\n{"path":"C:\\\\notes","value":"\\n","heading":"## Strategy C"}\n```';
  a.input.explanations[0].body+='\n\n'+literal;
  const before=JSON.stringify(a.input),recordsBefore=loadRecords(a.root).length,
    compiled=compileCornellResearch(a.root,a.input,{approved_source_files:[],format_profile:a.profile});
  const preview=previewCornellArtifacts(a.root,compiled.note),path=safePath(a.root,compiled.note.path);
  assert.equal(loadRecords(a.root).length,recordsBefore,'Preview must not reserve or create a knowledge record.');
  assert.throws(()=>readFileSync(path),'Preview must not write the visible note.');
  const note=createCornellNote(a.root,compiled.note),body=readFileSync(path,'utf8');
  assert.equal(body,preview[compiled.note.path]);
  assert.equal(a.validate(path).status,0);
  for(const letter of ['A','B','Z'])assert.match(body,new RegExp(`^## Strategy ${letter}:`,'m'));
  assert.ok(body.includes(literal));assert.equal(JSON.stringify(a.input),before);
  assert.equal(note.meta.data.research.format_renderer_revision,2);
});

test('mixed ordinary prose, CRLF bodies and indented literal code retain their exact authored bytes',t=>{
  const a=fixture(t);
  const mixed='[inferred] Read the two passes independently [S1].\r\n\r\n    printf("literal \\n output");\r\n    // Strategy B is only a code comment.';
  a.input.explanations.unshift({heading:'Ordinary explanation',body:mixed});
  const before=JSON.stringify(a.input),compiled=compileCornellResearch(a.root,a.input,{approved_source_files:[],format_profile:a.profile});
  const preview=previewCornellArtifacts(a.root,compiled.note),body=preview[compiled.note.path];
  assert.match(body,/^### Ordinary explanation$/m);
  assert.ok(body.includes('    printf("literal \\n output");\r\n    // Strategy B is only a code comment.'));
  assert.equal(JSON.stringify(a.input),before);
  const note=createCornellNote(a.root,compiled.note),result=a.validate(safePath(a.root,note.meta.data.artifact_path));
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
});

test('literal heading examples inside fenced Markdown are never silently rewritten to satisfy a validator',t=>{
  const a=fixture(t),literal='```markdown\n## Strategy B: Literal documentation example\n```';
  a.input.explanations[0].body+='\n\n'+literal;
  const original=JSON.stringify(a.input),compiled=compileCornellResearch(a.root,a.input,{approved_source_files:[],format_profile:a.profile});
  const preview=previewCornellArtifacts(a.root,compiled.note),path=join(a.root,'literal-heading-candidate.md');
  assert.ok(preview[compiled.note.path].includes(literal));
  writeFileSync(path,preview[compiled.note.path]);
  const result=a.validate(path);
  // This reviewed validator parses this literal as a strategy. Preserve its rejection;
  // renderer compatibility is not permission to alter the professional example.
  assert.equal(result.status,1);assert.match(result.stdout,/strategies missing.*flows: B/);
  assert.equal(JSON.stringify(a.input),original);
});

test('actual validator still rejects absent flows, orphan flows, malformed fences and missing Mermaid styling',t=>{
  const a=fixture(t),compiled=compileCornellResearch(a.root,a.input,{approved_source_files:[],format_profile:a.profile});
  const body=previewCornellArtifacts(a.root,compiled.note)[compiled.note.path];
  const cases=[
    ['missing-worked-flow',body.replace(/^### Strategy A Worked Example Flow$/m,'### Example details'),'strategies missing worked-example Mermaid flows: A'],
    ['orphan-flow',body.replace(/^## Strategy A:/m,'### Strategy A:'),'flows without matching strategies: A'],
    ['unbalanced-fence',body.replace('```mermaid','````mermaid'),'unbalanced Markdown code fences'],
    ['missing-style',body.replaceAll('classDef step fill:#223344,color:#ffffff;','class step fill:#223344;'),'lacks Mermaid classDef styling'],
  ];
  for(const [name,invalid,diagnostic] of cases){const path=join(a.root,`${name}.md`);writeFileSync(path,invalid);const result=a.validate(path);assert.equal(result.status,1,name);assert.ok(result.stdout.includes(diagnostic),result.stdout);}
});

test('default research rendering is unchanged and does not inherit LeetCode heading rules',t=>{
  const a=fixture(t),compiled=compileCornellResearch(a.root,a.input);
  assert.match(compiled.note.main_notes,/^### Strategy A:/m);
  assert.equal(compiled.note.research.format_renderer_revision,undefined);
});

test('same semantic input upgrades a legacy generated bundle once, archives it and then replays the validated generation',t=>{
  const a=fixture(t),compiled=compileCornellResearch(a.root,a.input,{approved_source_files:[],format_profile:a.profile});
  const legacy=structuredClone(compiled);
  legacy.input_hash=hash(cornellCanonical({input:cornellResearchSchema.parse(a.input),requirement_fingerprint:recordFingerprint(a.requirement),format_profile:a.profile}));
  legacy.note.main_notes=legacy.note.main_notes.replace(/^## Strategy A:/m,'### Strategy A:');
  legacy.note.research.input_hash=legacy.input_hash;delete legacy.note.research.format_renderer_revision;
  legacy.recipe_input.parameters.note=legacy.note;
  const old=createCornellNote(a.root,legacy.note),path=safePath(a.root,compiled.note.path),oldBytes=readFileSync(path);
  assert.equal(a.validate(path).status,1,'The legacy generation must reproduce the user failure.');
  assert.notEqual(compiled.input_hash,legacy.input_hash);
  const context={workflow_id:a.workflow.meta.id,epoch_id:'strategy-upgrade',task_id:a.task.meta.id,requirement_ids:[a.requirement.meta.id],evidence:[],saved_results:[controlledCornellResult(legacy,old)],file_allowed:()=>false};
  const revised=persistControlledCornellNote(a.root,compiled,context);
  assert.equal(revised.meta.revision,old.meta.revision+1);assert.equal(a.validate(path).status,0);
  const archived=revised.meta.data.revision_history[0].artifacts[compiled.note.path].history_path;
  assert.deepEqual(readFileSync(safePath(a.root,archived)),oldBytes);
  context.saved_results.push(controlledCornellResult(compiled,revised));
  const replay=persistControlledCornellNote(a.root,compiled,context);
  assert.equal(replay.meta.revision,revised.meta.revision);
  assert.equal(getRecord(a.root,old.meta.id).meta.revision,revised.meta.revision);
  writeFileSync(path,readFileSync(path,'utf8')+'\nUser edit must survive.\n');
  assert.throws(()=>persistControlledCornellNote(a.root,compiled,context),/Preserve|changed|differs/i);
});
