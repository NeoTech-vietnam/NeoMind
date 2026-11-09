import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { initialize, createRecord, getRecord, saveStatus, loadRecords } from '../dist/storage.js';
import { saveAcceptedRequestExperience } from '../dist/request-experience.js';
import { prepareNativeWork, nativeWorkPrepareSchema } from '../dist/native-work.js';
import { registerProcedure, reviewProcedure, runProcedure, qualifyProcedure, validateProcedureParameters, resolveProcedure } from '../dist/procedures.js';
import { openNativeRequest, planNativeRequest, prepareNativeImplementation } from '../dist/native-request.js';
import { executePreparedNativeProcedure } from '../dist/native-procedure.js';
import { saveAgentCapabilityCatalog } from '../dist/agent-capability-cache.js';
import { discoverAgentMarketplace, inspectAgentMarketplacePlugin } from '../dist/agent-marketplace.js';
import { installWorkspaceSkillComponents, controlWorkspaceSkillComponent } from '../dist/workspace-skill-components.js';

function project(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-work-'));
  initialize(root, { project_id: 'WF-WORK', ...options });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function capabilityMetadata() {
  const descriptions = { 'technical-writing': 'Readable technical documentation and research explanations.',
    'test-analysis': 'Independent testing, coverage and unit verification.' };
  const catalog = JSON.stringify({ name: 'team-capabilities', plugins: Object.entries(descriptions)
    .map(([name, description]) => ({ name, description, source: `plugins/${name}` })) });
  // Only ordinary metadata bytes from a pinned fixture source are read. No
  // component is downloaded, installed, loaded or used by this test transport.
  const reader = async input => ({ ...input, kind: 'file', complete: true,
    content: input.path.endsWith('marketplace.json') ? catalog : JSON.stringify({
      name: input.path.split('/')[1], description: descriptions[input.path.split('/')[1]],
      version: '1.0.0', license: 'MIT', skills: ['skills/capability'],
    }) });
  const discovered = await discoverAgentMarketplace({ repository: 'https://github.com/example/native-capabilities', commit: 'a'.repeat(40) }, reader);
  const plugins = [];
  for (const candidate of discovered.candidates) plugins.push({ inspection: await inspectAgentMarketplacePlugin(candidate, reader),
    role_hints: [candidate.name === 'technical-writing' ? 'WF.FnD' : 'WF.Tester'] });
  return { catalog_id: 'any-publisher/team-capabilities', provenance: discovered.provenance, plugins };
}

test('native capability discovery returns pinned domain and role candidates without authorizing execution or mutating records', async t => {
  const root = project(t), metadata = await capabilityMetadata();
  assert.equal(saveAgentCapabilityCatalog(root, metadata).state, 'stored');
  const before = loadRecords(root), originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw new Error('Advisory retrieval must not access the network'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const docs = prepareNativeWork(root, { requirement: 'Write readable documentation', role: 'WF.FnD', outputs: ['notes/new.md'] });
  assert.equal(docs.strategy, 'ordinary'); assert.equal(docs.capability_discovery.state, 'available');
  assert.deepEqual(docs.capability_discovery.candidates.map(item => item.name), ['technical-writing']);
  assert.equal(docs.capability_discovery.candidates[0].source.commit, 'a'.repeat(40));
  assert.equal(docs.capability_discovery.candidates[0].declared_license, 'MIT');
  assert.equal(docs.capability_discovery.authorization, 'not-granted');
  assert.ok(Object.values(docs.capability_discovery.candidates[0].states).every(value => value === 'not-observed'));
  const checks = prepareNativeWork(root, { requirement: 'Independent unit testing', role: 'WF.Tester' });
  assert.deepEqual(checks.capability_discovery.candidates.map(item => item.name), ['test-analysis']);
  assert.deepEqual(prepareNativeWork(root, { requirement: 'Documentation', role: 'WF.Tester' }).capability_discovery.candidates, []);
  assert.equal(prepareNativeWork(root, { requirement: 'Documentation and testing' }).capability_discovery.candidates.length, 2);
  assert.equal(nativeWorkPrepareSchema.safeParse({ requirement: 'Documentation', role: 'arbitrary-role' }).success, false);
  assert.equal(docs.execution, 'not-executed'); assert.equal(docs.execution_authorized, false);
  assert.equal(networkCalls, 0); assert.equal(existsSync(join(root, 'notes/new.md')), false);
  assert.deepEqual(loadRecords(root), before, 'Optional metadata lookup neither opens a request nor records model/tool execution');
});

test('native capability discovery is advisory when absent, expired or corrupt, including the procedure fallback path', async t => {
  const root = project(t, { execution_engine: 'vscode-lm' }), input = { requirement: 'Technical documentation', outputs: ['notes/new.md'] };
  assert.equal(prepareNativeWork(root, input).capability_discovery.state, 'absent');
  const metadata = await capabilityMetadata();
  saveAgentCapabilityCatalog(root, metadata, { now: new Date(Date.now() - 5000), ttl_ms: 1000 });
  const expired = prepareNativeWork(root, input);
  assert.equal(expired.capability_discovery.state, 'expired'); assert.deepEqual(expired.capability_discovery.candidates, []);
  assert.equal(expired.strategy, 'ordinary'); assert.equal(expired.capability_discovery.fallback, 'ordinary-work');
  saveAgentCapabilityCatalog(root, metadata);
  writeFileSync(join(root, '.workforce/cache/procedures.sqlite'), 'Corrupt optional procedure index');
  const registryFallback = prepareNativeWork(root, input);
  assert.equal(registryFallback.registry_state, 'unavailable'); assert.equal(registryFallback.strategy, 'ordinary');
  assert.equal(registryFallback.capability_discovery.state, 'available', 'The existing procedure catch preserves independently retrieved metadata');
  writeFileSync(join(root, '.workforce/cache/agent-capabilities.sqlite'), 'Corrupt optional capability index');
  const corrupt = prepareNativeWork(root, input);
  assert.equal(corrupt.strategy, 'ordinary'); assert.equal(corrupt.capability_discovery.state, 'unavailable');
  assert.equal(corrupt.capability_discovery.fallback, 'ordinary-work'); assert.equal(corrupt.execution_authorized, false);
  assert.equal(readFileSync(join(root, '.workforce/cache/agent-capabilities.sqlite'), 'utf8'), 'Corrupt optional capability index');
});

test('native preparation exposes actual installed skill components separately from catalog hints without granting execution', async t => {
  const root = project(t), metadata = await capabilityMetadata();
  assert.equal(prepareNativeWork(root, { requirement: 'Technical writing' }).installed_skill_components.state, 'absent');
  saveAgentCapabilityCatalog(root, metadata);
  const descriptions = { 'technical-writing': 'Readable technical documentation and research explanations.',
    'test-analysis': 'Independent unit testing and coverage verification.' };
  const files = new Map([['LICENSE', 'MIT License\nCopyright Fixture Authors\n']]);
  const skills = Object.entries(descriptions).map(([name, description]) => {
    const source_path = `plugins/${name}/skills/${name}`, path = `${source_path}/SKILL.md`;
    files.set(path, `---\nname: ${name}\ndescription: ${description}\n---\n# Original ${name}\n`);
    return { source_path, target_name: name, files: [path] };
  });
  const reader = async input => ({ ...input, kind: 'file', complete: true, content: files.get(input.path) });
  const installed = await installWorkspaceSkillComponents(root, { approved: true, repository: 'https://github.com/example/native-capabilities',
    commit: 'a'.repeat(40), license_path: 'LICENSE', skills }, reader);
  const before = loadRecords(root), receipt = join(root, '.workforce/capabilities', `${installed.components[0].id}.json`), receiptBytes = readFileSync(receipt);
  const originalFetch = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw new Error('Preparation cannot download or install components'); };
  try {
    const docs = prepareNativeWork(root, { requirement: 'Write readable technical documentation', role: 'WF.FnD', outputs: ['notes/new.md'] });
    assert.equal(docs.strategy, 'ordinary'); assert.equal(docs.execution_authorized, false);
    assert.equal(docs.capability_discovery.candidates[0].states.installed, 'not-observed', 'Catalog discovery remains a distinct observation');
    const component = docs.installed_skill_components.components.find(item => item.name === 'technical-writing');
    assert.equal(component.available, true); assert.equal(component.skill_path, '.github/skills/technical-writing/SKILL.md');
    assert.equal(component.files.state, 'current'); assert.equal(component.source.commit, 'a'.repeat(40));
    assert.ok(Object.values(component.observations).every(value => value === 'not-observed'));
    assert.equal(docs.installed_skill_components.authorization, 'not-granted');
    assert.equal(prepareNativeWork(root, { requirement: 'Independent unit testing', role: 'WF.Tester' }).installed_skill_components.components[0].name, 'test-analysis');
    assert.deepEqual(readFileSync(receipt), receiptBytes); assert.deepEqual(loadRecords(root), before); assert.equal(networkCalls, 0);
    assert.equal(existsSync(join(root, 'notes/new.md')), false);
    controlWorkspaceSkillComponent(root, installed.components[0].id, 'disable');
    const disabled = prepareNativeWork(root, { requirement: 'Technical writing' });
    assert.equal(disabled.installed_skill_components.components[0].state, 'disabled');
    assert.equal(disabled.installed_skill_components.components[0].available, false);
    writeFileSync(join(root, '.workforce/cache/procedures.sqlite'), 'Corrupt optional procedure index');
    // A disposable index can recover from canonical manifests. Make the actual
    // optional registry inaccessible to exercise its distinct fallback path.
    writeFileSync(join(root, '.workforce/procedures'), 'A file is not a procedure registry directory');
    const fallback = prepareNativeWork(root, { requirement: 'Independent unit testing' });
    assert.equal(fallback.strategy, 'ordinary'); assert.equal(fallback.registry_state, 'unavailable');
    assert.equal(fallback.installed_skill_components.components[0].available, true, 'Optional procedure fallback retains independent component observations');
    assert.deepEqual(loadRecords(root), before);
  } finally { globalThis.fetch = originalFetch; }
});

test('native preparation leaves ordinary delivery available with no match or a corrupt optional history cache', t => {
  const root = project(t), before = loadRecords(root).length;
  const input = { requirement: 'Implement a new function and its tests', outputs: [join(root, 'src/new.mjs')] };
  const empty = prepareNativeWork(root, input);
  assert.equal(empty.strategy, 'ordinary');
  assert.equal(empty.execution, 'not-executed');
  assert.equal(empty.execution_authorized, false);
  assert.deepEqual(empty.matches, []);
  mkdirSync(join(root, '.workforce/cache'), { recursive: true });
  writeFileSync(join(root, '.workforce/cache/request-experience.sqlite'), 'Invalid optional SQLite cache');
  const degraded = prepareNativeWork(root, input);
  assert.equal(degraded.history_state, 'unavailable');
  assert.equal(degraded.strategy, 'ordinary');
  assert.equal(loadRecords(root).length, before, 'Retrieval neither opens a request nor creates execution reports');
  assert.equal(nativeWorkPrepareSchema.safeParse({ ...input, assignment_ref: 'model-invented' }).success, false);
  assert.throws(() => prepareNativeWork(root, { ...input, outputs: [join(root, '..', 'outside.mjs')] }), /inside this workspace/);
});

test('historical matches are advisory and tampered acceptance records are filtered before reaching the worker', t => {
  const root = project(t);
  // Construct an accepted history snapshot at the storage seam. Desktop
  // acceptance is exercised separately; this test does not claim native calls.
  const request = createRecord(root, { type: 'knowledge', title: 'Cornell research note', data: { kind: 'workforce-request' } });
  const delivery = createRecord(root, { type: 'knowledge', title: 'Cornell verified delivery', body: 'A reviewed research note with practice questions.',
    data: { workflow_id: request.meta.id } });
  saveStatus(root, request.meta.id, 'accepted');
  const accepted = saveStatus(root, delivery.meta.id, 'accepted');
  saveAcceptedRequestExperience(root, { workflow_id: request.meta.id, task_family: 'cornell-note',
    summary: 'Cornell research note with practice questions and answers' + ' Detailed historical criteria.'.repeat(100), acceptance: { record_id: accepted.meta.id, revision: accepted.meta.revision },
    artifact_paths: ['notes/old.md'] });
  const query = { requirement: 'Tạo ghi chú nghiên cứu Cornell với bài tập và đáp án.', outputs: ['notes/new.md'] };
  const prepared = prepareNativeWork(root, query);
  assert.equal(prepared.matches.length, 1);
  assert.ok(prepared.matches[0].summary.startsWith('Cornell research note with practice questions and answers'));
  assert.ok(prepared.matches[0].summary.length <= 800, 'Retrieval supplies a compact brief instead of repeating all historical requirements');
  assert.equal(prepareNativeWork(root, { ...query, task_family: 'unrelated-task-family' }).matches.length, 0);
  assert.equal(prepared.strategy, 'ordinary', 'A similar accepted request alone is not a qualified executable procedure');
  assert.equal(prepared.execution_authorized, false);
  const path = join(root, getRecord(root, delivery.meta.id).path);
  writeFileSync(path, readFileSync(path, 'utf8') + '\nUser changed the accepted source.\n');
  assert.equal(prepareNativeWork(root, query).matches.length, 0);
});

test('history preparation reads one current record snapshot instead of rescanning it for every matching candidate', t => {
  const root = project(t);
  for (let number = 0; number < 5; number++) {
    const request = createRecord(root, { type: 'knowledge', title: `SQL review ${number}`, data: { kind: 'workforce-request' } });
    const delivery = createRecord(root, { type: 'knowledge', title: `SQL delivery ${number}`, data: { workflow_id: request.meta.id } });
    saveStatus(root, request.meta.id, 'accepted');
    const accepted = saveStatus(root, delivery.meta.id, 'accepted');
    saveAcceptedRequestExperience(root, { workflow_id: request.meta.id, task_family: number ? 'other-sql-review' : 'one-sql-review',
      summary: 'SQL query security review', acceptance: { record_id: accepted.meta.id, revision: accepted.meta.revision } });
  }
  const original = fs.readFileSync;
  function observe(input) {
    let reads = 0;
    fs.readFileSync = function(path, ...args) {
      if (typeof path === 'string' && path.startsWith(root) && path.endsWith('.md')) reads++;
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try { return { result: prepareNativeWork(root, input), reads }; }
    finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  }
  const single = observe({ requirement: 'SQL query security review', task_family: 'one-sql-review' });
  const multiple = observe({ requirement: 'SQL query security review' });
  assert.equal(single.result.matches.length, 1); assert.equal(multiple.result.matches.length, 5);
  assert.ok(single.reads > 0, 'The source records are actually read, not trusted from historical search data');
  assert.ok(multiple.reads <= single.reads + loadRecords(root).length,
    `More matches must not multiply whole-project record reads: one=${single.reads}, five=${multiple.reads}`);
  assert.equal(multiple.result.execution_authorized, false);
});

test('accepted capability choices are compact historical advice, never current skill eligibility or loading proof', t => {
  const root = project(t);
  function acceptedHistory(label, capability) {
    const request = createRecord(root, { type: 'knowledge', title: label,
      data: { kind: 'workforce-request' } });
    const delivery = createRecord(root, { type: 'knowledge', title: label + ' delivery',
      data: { workflow_id: request.meta.id, ...(capability === undefined ? {} : { native_capability_plan: capability }) } });
    saveStatus(root, request.meta.id, 'accepted');
    const accepted = saveStatus(root, delivery.meta.id, 'accepted');
    saveAcceptedRequestExperience(root, { workflow_id: request.meta.id, task_family: label,
      summary: 'Independent SQL query security review', acceptance: { record_id: accepted.meta.id, revision: accepted.meta.revision } });
    return delivery;
  }
  const role_skills = { 'WF.Reviewer': ['sql-code-review'] };
  const delivery = acceptedHistory('valid-capability-history', { schema_version: 1, role_skills,
    roles: { 'WF.Reviewer': [{ name: 'sql-code-review', unneeded_large_detail: 'Do not send this text to the new worker.' }] } });
  const before = loadRecords(root);
  const query = { requirement: 'SQL security query review', task_family: 'valid-capability-history' };
  const match = prepareNativeWork(root, query).matches[0];
  assert.deepEqual(match.capability_plan, { role_skills, source: 'accepted-request-history', current_eligibility: 'not-evaluated',
    loaded: 'not-observed', used: 'not-observed', verified: 'not-observed' });
  assert.equal(prepareNativeWork(root, query).installed_skill_components.state, 'absent');
  assert.equal(prepareNativeWork(root, query).execution_authorized, false);
  assert.equal(JSON.stringify(match).includes('Do not send this text'), false);
  assert.deepEqual(loadRecords(root), before, 'Historical lookup does not rewrite source records or create capability state');
  const path = join(root, getRecord(root, delivery.meta.id).path);
  writeFileSync(path, readFileSync(path, 'utf8') + '\nChanged accepted capability source.\n');
  assert.deepEqual(prepareNativeWork(root, query).matches, [], 'The accepted source snapshot remains authoritative');
  for (const [label, invalid] of [
    ['old-no-capability', undefined],
    ['unknown-role', { schema_version: 1, role_skills: { 'invented-admin': ['sql-code-review'] } }],
    ['path-not-name', { schema_version: 1, role_skills: { 'WF.Reviewer': ['../../secret'] } }],
    ['duplicate-name', { schema_version: 1, role_skills: { 'WF.Reviewer': ['sql-code-review', 'sql-code-review'] } }],
    ['empty-plan', { schema_version: 1, role_skills: {} }],
  ]) {
    acceptedHistory(label, invalid);
    const result = prepareNativeWork(root, { ...query, task_family: label });
    assert.equal(result.matches.length, 1, 'Unavailable optional capability details retain useful ordinary experience');
    assert.equal(result.matches[0].capability_plan, undefined);
    assert.equal(result.execution_authorized, false);
  }
});

test('the native host reuses a truly qualified exact procedure once and keeps independent acceptance pending', { timeout: 90000 }, async t => {
  const root = project(t);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'checks'));
  writeFileSync(join(root, 'scripts/generate.cjs'), `
const fs=require('node:fs'); (async()=>{let raw='';for await(const p of process.stdin)raw+=p;
const v=JSON.parse(raw);fs.mkdirSync('output',{recursive:true});fs.writeFileSync(v.outputs[0],JSON.stringify(v.parameters));})();`);
  writeFileSync(join(root, 'scripts/check.cjs'), `
const fs=require('node:fs'),a=require('node:assert/strict');(async()=>{let raw='';for await(const p of process.stdin)raw+=p;
const v=JSON.parse(raw);a.deepEqual(JSON.parse(fs.readFileSync(v.outputs[0],'utf8')),v.parameters);})();`);
  const manifest = registerProcedure(root, { id: 'native-text', version: '1.0.0', title: 'Generate verified text fixture',
    description: 'Generate verified text fixture JSON', task_family: 'text-fixture', author: 'fixture-author',
    script: 'scripts/generate.cjs', verification_script: 'scripts/check.cjs',
    parameters: { name: { type: 'string', path: true }, text: { type: 'string' } }, outputs: [{ path: 'output/{name}.json', min_bytes: 2 }],
    environment: { clients: ['cli', 'copilot'], platforms: [process.platform], node_major_min: 24 },
    effects: { write_roots: ['output'], network: false, publication: false } });
  let rejected;
  try { validateProcedureParameters(root, manifest, {}); } catch (error) { rejected = error.message; }
  assert.match(rejected, /Missing procedure parameter/);
  writeFileSync(join(root, 'checks/negative.json'), JSON.stringify({ input: {}, observed_error: rejected }));
  reviewProcedure(root, { procedure_id: manifest.id, reviewer: 'fixture-independent-reviewer', verdict: 'pass',
    rationale: 'The verifier compares complete outputs and required input rejection was observed.',
    negative_cases: [{ name: 'Missing name', evidence_path: 'checks/negative.json' }] });
  for (let index = 0; index < 3; index++) {
    const run = await runProcedure(root, { procedure_id: manifest.id, parameters: { name: `pilot${index}`, text: `content${index}` }, request_id: `pilot${index}`,
      actor: 'fixture-runner', client: 'cli', mode: 'pilot', authorized_effects: { write_roots: ['output'], network: false, publication: false } });
    assert.equal(run.status, 'succeeded');
  }
  assert.equal(qualifyProcedure(root, { procedure_id: manifest.id, actor: 'fixture-manager' }).status, 'eligible');
  const request = openNativeRequest(root, { requirement: 'Generate verified text fixture JSON', context: ['scripts'] });
  const planned = planNativeRequest(root, request.request_ref, { summary: 'Reuse the verified text fixture generator',
    requirements: ['Exact JSON parameters'], design: 'Use the existing qualified generator', task_family: 'text-fixture',
    parameters: { name: 'final', text: 'new content' }, outputs: ['output/final.json'],
    checks: [{ title: 'Current product check', level: 'acceptance', command: [process.execPath, '-e', "require('node:assert/strict').deepEqual(require('./output/final.json'),{name:'final',text:'new content'})"] }] });
  assert.equal(planned.reuse.strategy, 'qualified-procedure');
  const executed = await prepareNativeImplementation(root, request.request_ref);
  assert.equal(executed.reuse_execution.status, 'succeeded');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'output/final.json'), 'utf8')), { name: 'final', text: 'new content' });
  assert.equal(executed.accepted, false);
  assert.equal(executed.assignments.length, 0);
  assert.equal(executed.checks[0].execution_id, undefined);
  const repeated = await prepareNativeImplementation(root, request.request_ref);
  assert.equal(repeated.reuse_execution.run_id, executed.reuse_execution.run_id);
  assert.equal(resolveProcedure(root, manifest.id).runs.length, 4, 'three real qualification runs plus exactly one native host run');

  const procedure = planned.reuse.procedure;
  const continuation = { request_ref: request.request_ref, requirement: 'Generate verified text fixture JSON',
    task_family: 'text-fixture', parameters: { name: 'next', text: 'next content' }, outputs: ['output/next.json'], procedure };
  for (const changed of [
    { task_family: 'different-family' },
    { parameters: { name: 'next', text: 'next content', extra: 'not supported' } },
    { outputs: ['unrelated/next.json'] },
  ]) {
    const result = await executePreparedNativeProcedure(root, { ...continuation, ...changed });
    assert.equal(result.status, 'skipped', 'A semantic match never executes with a different family, unsupported inputs or undeclared products');
  }
  assert.equal(resolveProcedure(root, manifest.id).runs.length, 4, 'Inapplicable reuse adds no process runs');
  assert.throws(() => readFileSync(join(root, 'output/next.json')), /ENOENT/);

  const adapted = openNativeRequest(root, { requirement: 'Generate verified text fixture JSON and a separate short explanation', context: ['scripts'] });
  const adaptation = planNativeRequest(root, adapted.request_ref, { summary: 'Reuse the qualified JSON generator and implement only the explanation',
    requirements: ['Exact JSON parameters', 'A separate explanation'], design: 'Generate the existing format, then add only its new companion',
    task_family: 'text-fixture', parameters: { name: 'adapted', text: 'different content' },
    outputs: ['output/adapted.json', 'output/adapted-summary.md'],
    checks: [{ title: 'Both products exist', level: 'acceptance', command: [process.execPath, '-e',
      "require('node:fs').readFileSync('output/adapted.json');require('node:fs').readFileSync('output/adapted-summary.md')"] }] });
  assert.equal(adaptation.reuse.strategy, 'adapt');
  const partial = await prepareNativeImplementation(root, adapted.request_ref);
  assert.equal(partial.reuse_execution?.status, 'succeeded', 'A qualified subset can run before the worker implements the delta');
  assert.deepEqual(partial.reuse_execution.output_paths, ['output/adapted.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'output/adapted.json'), 'utf8')), { name: 'adapted', text: 'different content' });
  assert.throws(() => readFileSync(join(root, 'output/adapted-summary.md')), /ENOENT/, 'The generator cannot invent success for the requested delta');
  assert.equal(partial.accepted, false);

  const script = join(root, manifest.script), original = readFileSync(script);
  writeFileSync(script, Buffer.concat([original, Buffer.from("\nrequire('node:fs').writeFileSync('must-not-run.txt','stale script executed');\n")]));
  const stale = await executePreparedNativeProcedure(root, continuation);
  assert.equal(stale.status, 'skipped', 'A script changed after selection is rejected before process execution');
  assert.throws(() => readFileSync(join(root, 'must-not-run.txt')), /ENOENT/);
  assert.throws(() => readFileSync(join(root, 'output/next.json')), /ENOENT/);
  writeFileSync(script, original);
});
