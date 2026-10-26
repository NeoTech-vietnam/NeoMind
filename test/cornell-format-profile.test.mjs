import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { researchFixture } from './cornell-research-fixture.mjs';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { createRecord, getRecord, updateRecord, hash, safePath } from '../dist/storage.js';
import { controlledCornellResult } from '../dist/controlled-cornell-sources.js';
import { persistControlledCornellNote } from '../dist/controlled-cornell-write.js';

const fixtures = fileURLToPath(new URL('./fixtures/cornell-format-assets/', import.meta.url));
const templateHash = '143d7be4ea4d7e00fcc3067b7843939cdfe63e14d4dcf11411c99a52c8eb6a37';
const validatorHash = '052b08835e19d17fd06dc7450251926400dff960c0893ef9113cd07cf5e8b5e0';
function fixture(t) {
  const a = researchFixture(t), template = '.github/skills/research-layout/assets/layout.md', validator = '.github/skills/research-layout/scripts/check.py';
  for (const [path, source] of [[template,'cornell-note-template.md'],[validator,'validate_notes.py']]) {
    mkdirSync(join(a.root, path, '..'), { recursive: true }); copyFileSync(join(fixtures, source), safePath(a.root, path));
  }
  assert.equal(hash(readFileSync(safePath(a.root, template))), templateHash);
  assert.equal(hash(readFileSync(safePath(a.root, validator))), validatorHash);
  const contract = { plan: { input_paths: [template,validator] }, preserved_hashes: { [template]: templateHash, [validator]: validatorHash } };
  const profile = { schema_version: 1, id: 'leetcode-cornell-v1', template: { path: template, sha256: templateHash }, validator: { path: validator, sha256: validatorHash } };
  const task = createRecord(a.root, { type: 'task', title: 'Render the supplied research under its approved format contract.', owner: 'developer',
    links: [{ type: 'satisfies', target: a.requirement.meta.id }], data: { workflow_id: a.workflow.meta.id } });
  // Structural research fixture; this is not a claim about an actual numbered exercise.
  const input = { ...a.input, topic: 'Leetcode - 4242 - Format profile fixture', task_id: task.meta.id, worked_example: { ...a.input.worked_example } };
  delete input.worked_example.observed; delete input.worked_example.evidence_ids;
  return { ...a, input, task, contract, profile, template, validator };
}
function externalValidation(a, note) {
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, [safePath(a.root,a.validator), safePath(a.root,note.meta.data.artifact_path)], {
    encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('same semantic research is rendered compatibly for the actual pinned validator without replacing the default research format', t => {
  const a = fixture(t), originalInput = JSON.stringify(a.input);
  const generic = compileCornellResearch(a.root,a.input), first = createCornellNote(a.root,generic.note), originalBytes = readFileSync(safePath(a.root,generic.note.path));
  assert.equal(externalValidation(a,first).status,1,'The reviewed local validator really rejects the incompatible generic date/headings.');
  const compiled = compileCornellResearch(a.root,a.input,{ approved_source_files: [], format_profile: a.profile });
  const context = { workflow_id: a.workflow.meta.id, epoch_id: 'profile-fixture-epoch', task_id: a.task.meta.id,
    requirement_ids: [a.requirement.meta.id], evidence: [], saved_results: [controlledCornellResult(generic,first)], file_allowed: () => false };
  const second = persistControlledCornellNote(a.root,compiled,context), result = externalValidation(a,second);
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  assert.equal(validateCornellNote(a.root,second.meta.id).ok,true);
  assert.notEqual(compiled.input_hash,generic.input_hash,'Private format identity prevents replaying the wrong canonical rendering.');
  assert.equal(JSON.stringify(a.input),originalInput,'No model/research semantic source was rewritten.');
  assert.equal(second.meta.revision,first.meta.revision+1);
  assert.deepEqual(readFileSync(safePath(a.root,second.meta.data.revision_history[0].artifacts[generic.note.path].history_path)),originalBytes);
  const body = readFileSync(safePath(a.root,compiled.note.path),'utf8');
  assert.match(body,/^## Date: 23\/10\/2026$/m); assert.match(body,/^#### Function Contract$/m);
  assert.ok(body.includes(`#### Function Contract\n\n${a.input.context}\n\n${a.input.constraints.map(value=>`- ${value}`).join('\n')}`));
  assert.ok(body.includes(compiled.note.main_notes)); assert.equal(second.meta.data.demonstration.expected,a.input.worked_example.expected);
  assert.deepEqual(second.meta.data.research.learning_objectives,a.input.learning_objectives);
  context.saved_results.push(controlledCornellResult(compiled,second));
  assert.equal(persistControlledCornellNote(a.root,compiled,context).meta.revision,second.meta.revision);
});

test('profile selection uses both declared approved content fingerprints rather than repository names, destinations or criteria prose', async t => {
  const { resolveControlledCornellFormatProfile: resolve } = await import('../dist/cornell-format-profile.js');
  const a = fixture(t);
  assert.deepEqual(resolve(a.root,a.contract),a.profile);
  assert.equal(resolve(a.root,{ plan: { input_paths: [] }, preserved_hashes: a.contract.preserved_hashes }),undefined);
  assert.equal(resolve(a.root,{ plan: { input_paths: ['unrelated.md'] }, preserved_hashes: { 'unrelated.md': hash('unrelated') } }),undefined);
  assert.throws(()=>resolve(a.root,{ plan: { input_paths: [a.template] }, preserved_hashes: a.contract.preserved_hashes }),/complete approved template\/validator/);
  assert.throws(()=>resolve(a.root,{ ...a.contract,preserved_hashes: { ...a.contract.preserved_hashes,[a.validator]: '0'.repeat(64) } }),/complete approved template\/validator/);
  writeFileSync(safePath(a.root,a.template),'An external template edit must never be adopted.\n');
  assert.throws(()=>resolve(a.root,a.contract));
  assert.equal(a.contract.preserved_hashes[a.template],templateHash);
});

test('changed format assets are rejected before generated files or record metadata can be replaced', async t => {
  const { resolveControlledCornellFormatProfile: resolve } = await import('../dist/cornell-format-profile.js');
  const a = fixture(t), profile=resolve(a.root,a.contract), generic=compileCornellResearch(a.root,a.input), first=createCornellNote(a.root,generic.note);
  const compiled=compileCornellResearch(a.root,a.input,{ approved_source_files:[],format_profile:profile });
  const context={workflow_id:a.workflow.meta.id,epoch_id:'profile-fixture-epoch',task_id:a.task.meta.id,requirement_ids:[a.requirement.meta.id],evidence:[],
    saved_results:[controlledCornellResult(generic,first)],file_allowed:()=>false};
  const before=readFileSync(safePath(a.root,generic.note.path)), record=getRecord(a.root,first.meta.id);
  writeFileSync(safePath(a.root,a.validator),'# Validator changed outside its frozen fingerprint.\n');
  assert.throws(()=>persistControlledCornellNote(a.root,compiled,context));
  assert.deepEqual(readFileSync(safePath(a.root,generic.note.path)),before); assert.deepEqual(getRecord(a.root,first.meta.id),record);
  assert.throws(()=>compileCornellResearch(a.root,a.input,{ approved_source_files:[],format_profile:profile }));
});

test('default compiler identity stays unchanged and format provenance is validated independently of note text', async t => {
  const { resolveControlledCornellFormatProfile: resolve } = await import('../dist/cornell-format-profile.js');
  const a=fixture(t), generic=compileCornellResearch(a.root,a.input), emptyPolicy=compileCornellResearch(a.root,a.input,{approved_source_files:[]});
  assert.deepEqual(emptyPolicy,generic); assert.equal(Object.hasOwn(generic.note,'format_profile'),false);
  const profile=resolve(a.root,a.contract),compiled=compileCornellResearch(a.root,a.input,{approved_source_files:[],format_profile:profile}),note=createCornellNote(a.root,compiled.note);
  assert.equal(validateCornellNote(a.root,note.meta.id).ok,true);
  updateRecord(a.root,note.meta.id,{data:{format_profile:{...profile,validator:{...profile.validator,sha256:'0'.repeat(64)}}}});
  const validation=validateCornellNote(a.root,note.meta.id);
  assert.equal(validation.ok,false); assert.ok(validation.problems.some(message=>message.includes('format profile')));
  const {controlledCornellResearchSchema}=await import('../dist/controlled-cornell-sources.js');
  const {requirement_id,expected_requirement_revision,workflow_id,task_id,owner,output_dir,...semantic}=a.input;
  assert.equal(controlledCornellResearchSchema().safeParse(semantic).success,true);
  assert.equal(controlledCornellResearchSchema().safeParse({...semantic,format_profile:profile}).success,false,'Models cannot select a backend format profile.');
});

test('a missing approved format asset produces fixed runtime-owned feedback without exposing filesystem errors', async t => {
  const { resolveControlledCornellFormatProfile: resolve } = await import('../dist/cornell-format-profile.js');
  const { controlledValidation } = await import('../dist/controlled-observability.js');
  const a = fixture(t); rmSync(safePath(a.root,a.validator));
  let failure;
  try { resolve(a.root,a.contract); } catch (error) { failure = error; }
  assert.equal(failure?.code,'CORNELL_FORMAT_PROFILE_UNSUPPORTED');
  assert.doesNotMatch(failure.message,/ENOENT|lstat|neomind-research-|check\.py/);
  const feedback=controlledValidation(failure.code,failure.message);
  assert.equal(feedback.owner,'runtime'); assert.equal(feedback.code,'CORNELL_FORMAT_PROFILE_UNSUPPORTED');
  assert.match(feedback.rule,/do not rewrite research or rebaseline/);
});

test('compatible layout never rewrites literal research prose that happens to contain Cornell heading examples', t => {
  const a = fixture(t), context = `${a.input.context}\n\nLiteral Markdown example:\n\n\`\`\`md\n## Cue Column\n\nKeep this literal cue example unchanged.\n\n## Main Notes\n\nKeep this literal notes example unchanged.\n\n## Summary\n\nKeep this literal summary example unchanged.\n\`\`\``;
  const input = { ...a.input, context }, compiled = compileCornellResearch(a.root,input,{approved_source_files:[],format_profile:a.profile});
  const note = createCornellNote(a.root,compiled.note), body = readFileSync(safePath(a.root,compiled.note.path),'utf8');
  assert.equal(body.split(context).length-1,2,'Problem description and function contract preserve the supplied context verbatim.');
  assert.equal(body.split('### Cue Column (Questions, Keywords, or Prompts)').length-1,1);
  assert.equal(body.split('### Notes Section (Main Notes)').length-1,1);
  assert.equal(body.split('### Summary Section (Summary of Notes)').length-1,1);
  assert.equal(externalValidation(a,note).status,0); assert.equal(validateCornellNote(a.root,note.meta.id).ok,true);
});

test('active assignment guidance reports the backend format and reuses only a current readable retained semantic source', async t => {
  const {controlledCornellFormatContext:context}=await import('../dist/controlled-cornell-format-context.js');
  const a=fixture(t), contract={...a.contract,plan:{...a.contract.plan,cornell_output_dir:a.input.output_dir}},compiled=compileCornellResearch(a.root,a.input),note=createCornellNote(a.root,compiled.note);
  const sourcePath='research-source.json', json=JSON.stringify(a.input); writeFileSync(safePath(a.root,sourcePath),json);
  const saved={...controlledCornellResult(compiled,note),payload_source:{path:sourcePath,sha256:hash(json),size_bytes:Buffer.byteLength(json)}};
  const allowed={sourceAllowed:path=>path===sourcePath};
  const active=context(a.root,contract,[saved],allowed);
  assert.match(active,/leetcode-cornell-v1/); assert.match(active,/JSON date in ISO YYYY-MM-DD/); assert.match(active,/renderer displays DD\/MM\/YYYY/);
  assert.match(active,/cornell_research_compile\(\{input_path:"research-source\.json"\}\)/);
  assert.match(active,/do not reconstruct or copy/); assert.match(active,/Do not add a model format\/profile argument/);
  const denied=context(a.root,contract,[saved],{sourceAllowed:()=>false}); assert.doesNotMatch(denied,/research-source\.json/);
  const bound=context(a.root,{...contract,plan:{...contract.plan,cornell_input_path:sourcePath},preserved_hashes:{...contract.preserved_hashes,[sourcePath]:hash(json)}},[],allowed);
  assert.match(bound,/Call cornell_research_compile\(\{\}\)/); assert.doesNotMatch(bound,/No prior semantic input path/);
  writeFileSync(safePath(a.root,sourcePath),json+'\n');
  const stale=context(a.root,contract,[saved],allowed); assert.doesNotMatch(stale,/research-source\.json/); assert.match(stale,/No prior semantic input path/);
  assert.equal(context(a.root,{plan:{input_paths:[]},preserved_hashes:{}},[saved],allowed),'','Default requests receive no new profile-specific instruction.');
});
