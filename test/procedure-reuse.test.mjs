import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { initializeLegacy } from './helpers/legacy-project.mjs';
import {
  listProcedures, qualifyProcedure, registerProcedure, reviewProcedure, runProcedure, validateProcedureParameters,
} from '../dist/procedures.js';
import { normalizeProcedureQuery, prepareWork, rebuildProcedureIndex } from '../dist/procedure-reuse.js';

function project(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-procedure-reuse-'));
  initializeLegacy(root, { project_id: 'PROCEDURE-REUSE' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'checks'), { recursive: true });
  writeFileSync(join(root, 'scripts/generate.cjs'), `
const {mkdirSync,writeFileSync}=require('node:fs');
const {dirname}=require('node:path');
(async()=>{let raw='';for await(const part of process.stdin)raw+=part;const packet=JSON.parse(raw);
const path=packet.outputs[0];mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(packet.parameters)+'\\n');})();
`);
  writeFileSync(join(root, 'scripts/verify.cjs'), `
const assert=require('node:assert/strict');const {readFileSync}=require('node:fs');
(async()=>{let raw='';for await(const part of process.stdin)raw+=part;const packet=JSON.parse(raw);
assert.deepEqual(JSON.parse(readFileSync(packet.outputs[0],'utf8')),packet.parameters);
if(packet.parameters.argument==='FAIL')process.exitCode=1;})();
`);
  const manifest = registerProcedure(root, {
    id: 'cornell-format', version: '1.0.0', title: 'Cornell research note formatting',
    description: 'Compile a Cornell research note with practice questions and answers.',
    task_family: 'cornell-note', keywords: ['Cornell', 'research note', 'practice', 'answers'],
    author: 'script-author', script: 'scripts/generate.cjs', verification_script: 'scripts/verify.cjs',
    parameters: { name: { type: 'string', path: true }, argument: { type: 'string', required: false, default: '--Case=Keep' } },
    outputs: [{ path: 'Output/{name}.json', min_bytes: 2 }],
    environment: { platforms: [process.platform], clients: ['cli', 'codex', 'copilot'], node_major_min: 24 },
    effects: { write_roots: ['Output'], network: false, publication: false },
    ...overrides,
  });
  return { root, manifest };
}
function request(overrides = {}) {
  return {
    request: 'Create another Cornell research note with practice and answers.', request_id: 'incoming-request',
    parameters: { name: 'MixedCase', argument: '--KeepCase=Value' },
    environment: { client: 'codex' }, scope: { allowed_paths: ['Output'], network: false, publication: false },
    ...overrides,
  };
}
async function qualify(work) {
  let observed;
  try { validateProcedureParameters(work.root, work.manifest, {}); } catch (error) { observed = error.message; }
  assert.match(observed, /Missing procedure parameter name/);
  writeFileSync(join(work.root, 'checks/negative.json'), JSON.stringify({ input: {}, observed_error: observed }));
  reviewProcedure(work.root, { procedure_id: work.manifest.id, reviewer: 'independent-reviewer', verdict: 'pass',
    rationale: 'Checked parameter rejection and independent output verification for this local-process sample.',
    negative_cases: [{ name: 'Required input rejection', evidence_path: 'checks/negative.json' }] });
  for (let index = 0; index < 3; index++) {
    const run = await runProcedure(work.root, { procedure_id: work.manifest.id,
      parameters: { name: `pilot-${index}`, argument: `pilot-value-${index}` }, request_id: `pilot-${index}`, actor: 'local-runner', client: 'cli', mode: 'pilot',
      authorized_effects: { write_roots: ['Output'], network: false, publication: false } });
    assert.equal(run.status, 'succeeded');
  }
  assert.equal(qualifyProcedure(work.root, { procedure_id: work.manifest.id, actor: 'coordinator' }).status, 'eligible');
}

test('controlled English and Vietnamese aliases retrieve the same candidate while original strings remain untouched', (t) => {
  const work = project(t);
  const original = 'Tạo ghi chú nghiên cứu Cornell, với bài tập và đáp án.';
  const result = prepareWork(work.root, request({ request: original }));
  assert.equal(result.original_request, original);
  assert.equal(result.intent_id, 'cornell-note');
  assert.equal(result.request_id, 'incoming-request');
  assert.equal(result.decision, 'adapt');
  assert.equal(result.candidates[0].id, work.manifest.id);
  assert.ok(result.candidates[0].reasons.some(item => item.code === 'NOT_QUALIFIED'));
  assert.equal(result.parameters.name, 'MixedCase');
  assert.equal(result.parameters.argument, '--KeepCase=Value');
  assert.equal(result.execution_authorized, false);
  assert.equal(existsSync(join(work.root, 'Output')), false, 'Searching never launches a procedure');
  assert.match(normalizeProcedureQuery('danh sách liên kết và thuật toán'), /linked list.*algorithm/);
});

test('only current qualified compatible procedures match exactly; relevant drift and missing scope prevent it', async (t) => {
  const work = project(t);
  await qualify(work);
  const exact = prepareWork(work.root, request());
  assert.equal(exact.decision, 'exact');
  assert.equal(exact.candidates[0].compatible, true);
  assert.equal(exact.selected_procedure.contract_hash, work.manifest.contract_hash);
  assert.equal(exact.candidates[0].prior_runs.succeeded, 3);
  assert.match(exact.manager_brief, /fresh authorized procedure run/);
  assert.equal(prepareWork(work.root, request()).context_digest, exact.context_digest);
  assert.notEqual(prepareWork(work.root, request({ parameters: { name: 'mixedcase', argument: '--KeepCase=Value' } })).context_digest, exact.context_digest);
  assert.notEqual(prepareWork(work.root, request({ request: 'Create Cornell notes with entirely new acceptance conditions.' })).context_digest, exact.context_digest);
  const otherPlatform = process.platform === 'linux' ? 'win32' : 'linux';
  const platform = prepareWork(work.root, request({ environment: { client: 'codex', platform: otherPlatform } }));
  assert.equal(platform.decision, 'adapt');
  assert.ok(platform.candidates[0].reasons.some(item => item.code === 'PLATFORM_MISMATCH'));
  const missing = prepareWork(work.root, request({ parameters: {} }));
  assert.equal(missing.decision, 'blocked');
  assert.ok(missing.candidates[0].reasons.some(item => item.code === 'MISSING_PARAMETER'));
  assert.equal(prepareWork(work.root, request({ scope: { allowed_paths: ['OtherOutput'] } })).decision, 'blocked');
  assert.equal(prepareWork(work.root, request({ environment: {} })).decision, 'blocked');
  writeFileSync(join(work.root, 'Output/MixedCase.json'), 'Existing authored content');
  const conflict = prepareWork(work.root, request());
  assert.equal(conflict.decision, 'blocked');
  assert.ok(conflict.candidates[0].reasons.some(item => item.code === 'OUTPUT_CONFLICT'));
  assert.equal(readFileSync(join(work.root, 'Output/MixedCase.json'), 'utf8'), 'Existing authored content');
  rmSync(join(work.root, 'Output/MixedCase.json'));
  const unknownOutput = prepareWork(work.root, request({ outputs: ['Output/MixedCase.json', 'Output/Extra.pdf'] }));
  assert.equal(unknownOutput.decision, 'adapt');
  assert.ok(unknownOutput.candidates[0].reasons.some(item => item.code === 'OUTPUT_MISMATCH'));
  const priorCode = readFileSync(join(work.root, 'scripts/generate.cjs'), 'utf8');
  writeFileSync(join(work.root, 'scripts/generate.cjs'), priorCode + '\n// changed version\n');
  const stale = prepareWork(work.root, request());
  assert.equal(stale.decision, 'blocked');
  assert.equal(stale.candidates[0].status, 'suspended', 'Fresh authoritative hashes override a previously cached eligible row');
});

test('near matches find reference material but incompatible task intent never becomes exact reuse', (t) => {
  const work = project(t);
  const result = prepareWork(work.root, request({ request: 'Create an algorithm exercise on linked lists with Cornell notes.' }));
  assert.equal(result.intent_id, 'algorithm-exercise');
  assert.equal(result.decision, 'new');
  assert.match(result.next_action, /Capture a candidate only when registration is part of the user request/);
  assert.match(result.manager_brief, /otherwise deliver the requested work/);
  assert.equal(result.selected_procedure, undefined);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0].reasons.some(item => item.code === 'INTENT_MISMATCH'));
  assert.equal(prepareWork(work.root, request({ request: 'Analyze atmospheric turbulence in a wind tunnel.', tags: [] })).decision, 'new');
  const unavailable = prepareWork(work.root, request({ procedure_id: 'does-not-exist' }));
  assert.equal(unavailable.decision, 'blocked');
  assert.equal(unavailable.selected_procedure, undefined);
});

test('tool versions, workflow mode, assurance and publication authorization remain explicit compatibility conditions', (t) => {
  const work = project(t, {
    environment: { platforms: [process.platform], clients: ['codex'], archs: [process.arch], node_major_min: 26,
      tools: { compiler: '12.2.0' }, modes: ['native'], assurance: ['unsigned-local'] },
    effects: { write_roots: ['Output'], network: true, publication: true },
  });
  const result = prepareWork(work.root, request({ environment: { client: 'copilot', arch: 'other-arch', node: '24.0.0', tools: { compiler: '13.1.0' } }, scope: { allowed_paths: ['Output'], mode: 'strict', assurance: 'signed' } }));
  const codes = new Set(result.candidates[0].reasons.map(item => item.code));
  for (const code of ['CLIENT_MISMATCH', 'ARCH_MISMATCH', 'NODE_VERSION_MISMATCH', 'TOOL_VERSION_MISMATCH', 'MODE_MISMATCH', 'ASSURANCE_MISMATCH', 'NETWORK_DENIED', 'PUBLICATION_DENIED']) assert.ok(codes.has(code), code);
  assert.equal(result.decision, 'blocked');
  const absentTool = prepareWork(work.root, request());
  assert.ok(absentTool.candidates[0].reasons.some(item => item.code === 'MISSING_TOOL'));
});

test('cache deletion rebuilds candidates and deliberate corruption requires explicit repair', (t) => {
  const work = project(t);
  prepareWork(work.root, request());
  const path = join(work.root, '.neomind/cache/procedures.sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM procedures').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  db.close();
  rmSync(path);
  assert.equal(prepareWork(work.root, request()).candidates[0].status, 'candidate');
  writeFileSync(path, 'This is a deliberately damaged SQLite projection.');
  assert.throws(() => prepareWork(work.root, request()), error => error.code === 'PROCEDURE_INDEX_CORRUPT' && /explicit.*rebuild/.test(error.message));
  assert.equal(rebuildProcedureIndex(work.root).procedures, 1);
  assert.equal(prepareWork(work.root, request()).decision, 'adapt');
});

test('editing cached eligibility cannot qualify a procedure and missing sources are an explicit repair condition', (t) => {
  const work = project(t);
  prepareWork(work.root, request());
  const path = join(work.root, '.neomind/cache/procedures.sqlite');
  const db = new DatabaseSync(path);
  const metadata = JSON.parse(db.prepare('SELECT metadata FROM procedures').get().metadata);
  metadata.status = 'eligible';
  db.prepare('UPDATE procedures SET metadata=?').run(JSON.stringify(metadata));
  db.close();
  assert.equal(prepareWork(work.root, request()).candidates[0].status, 'candidate');
  rmSync(join(work.root, '.neomind/procedures/cornell-format'), { recursive: true, force: true });
  assert.throws(() => prepareWork(work.root, request()), error => error.code === 'PROCEDURE_SOURCE_MISSING');
  assert.equal(rebuildProcedureIndex(work.root).procedures, 0);
  assert.equal(prepareWork(work.root, request()).decision, 'new');
});

test('failed and fixture histories stay diagnostic and cannot promote a candidate through the search projection', async (t) => {
  const work = project(t);
  let observed;
  try { validateProcedureParameters(work.root, work.manifest, {}); } catch (error) { observed = error.message; }
  writeFileSync(join(work.root, 'checks/negative.json'), JSON.stringify({ input: {}, observed_error: observed }));
  reviewProcedure(work.root, { procedure_id: work.manifest.id, reviewer: 'independent-reviewer', verdict: 'pass', rationale: 'Required parameter rejection was observed.',
    negative_cases: [{ name: 'Required input rejection', evidence_path: 'checks/negative.json' }] });
  const run = await runProcedure(work.root, { procedure_id: work.manifest.id, parameters: { name: 'failure', argument: 'FAIL' },
    request_id: 'failed-check', actor: 'local-runner', client: 'cli', mode: 'pilot', observation: 'fixture',
    authorized_effects: { write_roots: ['Output'], network: false, publication: false } });
  assert.equal(run.status, 'failed');
  const result = prepareWork(work.root, request());
  assert.equal(result.decision, 'blocked');
  assert.equal(result.candidates[0].prior_runs.failed, 1);
  const diagnostic = prepareWork(work.root, request({ request: 'Diagnose verification failed output limit.' }));
  assert.equal(diagnostic.candidates.length, 1, 'Prior run failures are searchable diagnostic references');
  assert.equal(diagnostic.decision, 'blocked');
  const db = new DatabaseSync(join(work.root, '.neomind/cache/procedures.sqlite'), { readOnly: true });
  const cached = JSON.parse(db.prepare('SELECT summary FROM runs').get().summary);
  assert.equal(cached.status, 'failed');
  assert.equal(cached.observation, 'fixture');
  assert.equal(Object.hasOwn(cached, 'parameters'), false);
  assert.equal(Object.hasOwn(cached, 'generator'), false);
  db.close();
});

for (const legacy of ['.verythinker', '.taskforces']) test(`legacy managed storage ${legacy} retains registered procedures and a single physical root`, t => {
  const work = project(t);
  renameSync(join(work.root, '.neomind'), join(work.root, legacy));
  const result = prepareWork(work.root, request());
  assert.equal(result.candidates[0]?.id, work.manifest.id);
  assert.equal(result.decision, 'adapt');
  assert.equal(existsSync(join(work.root, '.neomind')), false);
  assert.equal(existsSync(join(work.root, legacy, 'cache/procedures.sqlite')), true);
  assert.equal(listProcedures(work.root).length, 1);
});

test('invalid inputs fail before search and a supplied request ID is preserved independently of newly generated IDs', (t) => {
  const work = project(t);
  assert.throws(() => prepareWork(work.root, request({ scope: { network: 'yes' } })), /must be boolean/);
  assert.throws(() => prepareWork(work.root, request({ request: '' })), /nonempty request/);
  assert.throws(() => prepareWork(work.root, request({ procedure_version: '1.0.0' })), /requires procedure_id/);
  const wrongPath = prepareWork(work.root, request({ parameters: { name: '../escape', argument: 'KeepThisCase' } }));
  assert.equal(wrongPath.decision, 'blocked');
  const first = prepareWork(work.root, request({ request_id: undefined }));
  const second = prepareWork(work.root, request({ request_id: undefined }));
  assert.notEqual(first.request_id, second.request_id);
  const expression = prepareWork(work.root, request({ request: 'Cornell " OR * DROP TABLE procedures; --', intent_id: 'cornell-note' }));
  assert.equal(expression.candidates.length, 1, 'FTS tokens are parameterized data, not SQL or raw MATCH syntax');
});
