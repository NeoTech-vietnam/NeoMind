import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { initialize, safePath, createRecord } from '../dist/storage.js';
import { discoverProcedures, listProcedures, registerProcedure, reviewProcedure, qualifyProcedure,
  runProcedure, validateProcedureParameters } from '../dist/procedures.js';
import { prepareWork } from '../dist/procedure-reuse.js';

// Disk-bounded local-process fixtures. No API/model calls or user workspaces.
const temporary = resolve('artifacts/test-temp');
function put(root, path, bytes) { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes); }
function fixture(t, engine = 'opencode') {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'workforce-procedure-fallback-'));
  t.after(() => { assert.equal(dirname(resolve(root)), temporary); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'WF-PROCEDURES', execution_engine: engine });
  put(root, 'scripts/generate.cjs', `
const {mkdirSync,writeFileSync}=require('node:fs');const{dirname}=require('node:path');
(async()=>{let raw='';for await(const chunk of process.stdin)raw+=chunk;const packet=JSON.parse(raw);
const output=packet.outputs[0];mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify({value:packet.parameters.value}));})();
`);
  put(root, 'scripts/verify.cjs', `
const assert=require('node:assert/strict');const{readFileSync}=require('node:fs');
(async()=>{let raw='';for await(const chunk of process.stdin)raw+=chunk;const packet=JSON.parse(raw);
assert.deepEqual(JSON.parse(readFileSync(packet.outputs[0],'utf8')),{value:packet.parameters.value});})();
`);
  const manifest = registerProcedure(root, { id: 'json-result', version: '1.0.0', title: 'Reusable JSON result generation',
    description: 'Generate and independently verify a JSON result.', task_family: 'json-result', keywords: ['JSON', 'result'],
    author: 'producer', script: 'scripts/generate.cjs', verification_script: 'scripts/verify.cjs',
    parameters: { name: { type: 'string', path: true }, value: { type: 'integer' } }, outputs: [{ path: 'out/{name}.json', min_bytes: 2 }],
    environment: { platforms: [process.platform], clients: ['cli', 'copilot', 'codex'], node_major_min: 24 },
    effects: { write_roots: ['out'], network: false, publication: false } });
  return { root, manifest };
}
function request(overrides = {}) { return { request: 'Create another JSON result.', intent_id: 'json-result',
  parameters: { name: 'next', value: 42 }, environment: { client: 'cli' },
  scope: { allowed_paths: ['out'], network: false, publication: false }, ...overrides }; }
function runInput(overrides = {}) { return { procedure_id: 'json-result', version: '1.0.0',
  parameters: { name: 'next', value: 42 }, request_id: 'explicit-run', actor: 'runner', client: 'cli', mode: 'automatic',
  authorized_effects: { write_roots: ['out'], network: false, publication: false }, ...overrides }; }
async function qualify(root, manifest) {
  let observed;
  assert.throws(() => validateProcedureParameters(root, manifest, {}), error => { observed = error.message; return /Missing procedure parameter/.test(error.message); });
  put(root, 'checks/negative.json', JSON.stringify({ input: {}, observed_error: observed }) + '\n');
  reviewProcedure(root, { procedure_id: manifest.id, version: manifest.version, reviewer: 'independent-reviewer', verdict: 'pass',
    rationale: 'Observed parameter rejection and reviewed the independent JSON oracle.',
    negative_cases: [{ name: 'Reject absent required parameters', evidence_path: 'checks/negative.json' }] });
  for (let index = 0; index < 3; index++) {
    const result = await runProcedure(root, runInput({ request_id: `pilot-${index}`, mode: 'pilot', parameters: { name: `pilot-${index}`, value: index + 1 } }));
    assert.equal(result.status, 'succeeded');
  }
  assert.equal(qualifyProcedure(root, { procedure_id: manifest.id, actor: 'coordinator' }).status, 'eligible');
}

test('one invalid optional entry degrades discovery without modifying canonical sources or a complete cache', t => {
  const { root, manifest } = fixture(t);
  assert.equal(prepareWork(root, request()).retrieval.source, 'sqlite');
  const index = safePath(root, '.workforce/cache/procedures.sqlite'), indexBytes = readFileSync(index);
  const path = '.workforce/procedures/invalid_entry/marker.txt', bytes = Buffer.from('Preserve the invalid source exactly.\r\n');
  put(root, path, bytes);
  assert.throws(() => listProcedures(root), 'Strict catalog listing remains a validation operation.');
  const result = prepareWork(root, request());
  assert.equal(result.registry.state, 'degraded'); assert.equal(result.retrieval.source, 'canonical');
  assert.equal(result.candidates[0].id, manifest.id);
  assert.equal(result.decision, 'adapt', 'Discovery does not promote an unqualified candidate.');
  assert.ok(result.candidates[0].reasons.some(reason => reason.code === 'NOT_QUALIFIED'));
  assert.match(result.manager_brief, /registry degraded/); assert.match(result.manager_brief, /excluded without modifying/);
  assert.equal(result.execution_authorized, false);
  assert.deepEqual(readFileSync(join(root, path)), bytes); assert.deepEqual(readFileSync(index), indexBytes);
  assert.equal(existsSync(join(root, 'out/next.json')), false);
});

test('an invalid sole manifest reports unavailable rather than a false no-match and cannot be explicitly executed', async t => {
  const { root } = fixture(t), path = '.workforce/procedures/json-result/1.0.0/manifest.json';
  const bytes = Buffer.from('{"not":"a valid manifest"}\r\n'); put(root, path, bytes);
  const ordinary = prepareWork(root, request());
  assert.equal(ordinary.decision, 'new'); assert.equal(ordinary.registry.state, 'unavailable');
  assert.equal(ordinary.retrieval.source, 'unavailable'); assert.equal(ordinary.candidates.length, 0);
  assert.match(ordinary.manager_brief, /discovery is incomplete/);
  assert.doesNotMatch(ordinary.manager_brief, /No applicable saved procedure was found/);
  const explicit = prepareWork(root, request({ procedure_id: 'json-result', procedure_version: '1.0.0' }));
  assert.equal(explicit.decision, 'blocked'); assert.equal(explicit.selected_procedure, undefined);
  assert.equal(explicit.execution_authorized, false);
  await assert.rejects(() => runProcedure(root, runInput()));
  assert.deepEqual(readFileSync(join(root, path)), bytes); assert.equal(existsSync(join(root, 'out/next.json')), false);
  assert.ok(createRecord(root, { type: 'requirement', title: 'Ordinary work remains available' }).meta.id);
});

test('an unavailable registry root does not block ordinary WorkForce record creation or overwrite source', t => {
  const { root } = fixture(t);
  renameSync(join(root, '.workforce/procedures'), join(root, '.workforce/preserved-procedures'));
  const bytes = Buffer.from('This is an invalid directory replacement, preserve it.\n'); put(root, '.workforce/procedures', bytes);
  const result = prepareWork(root, request());
  assert.equal(result.registry.state, 'unavailable'); assert.equal(result.registry.issues[0].code, 'PROCEDURE_REGISTRY_UNAVAILABLE');
  assert.equal(result.decision, 'new'); assert.equal(result.execution_authorized, false);
  assert.ok(createRecord(root, { type: 'task', title: 'Continue ordinary product work' }).meta.id);
  assert.deepEqual(readFileSync(join(root, '.workforce/procedures')), bytes);
});

test('a corrupt disposable index falls back to qualified canonical sources without weakening execution scope', async t => {
  const { root, manifest } = fixture(t); await qualify(root, manifest);
  assert.equal(prepareWork(root, request()).decision, 'exact');
  const path = safePath(root, '.workforce/cache/procedures.sqlite'), bytes = Buffer.from('Not a SQLite database.\n');
  writeFileSync(path, bytes);
  const result = prepareWork(root, request());
  assert.equal(result.decision, 'exact'); assert.equal(result.registry.state, 'available');
  assert.equal(result.retrieval.source, 'canonical'); assert.equal(result.retrieval.incident, 'PROCEDURE_INDEX_UNAVAILABLE');
  assert.equal(result.execution_authorized, false); assert.deepEqual(readFileSync(path), bytes);
  const denied = prepareWork(root, request({ scope: { allowed_paths: ['other'], network: false, publication: false } }));
  assert.equal(denied.decision, 'blocked'); assert.ok(denied.candidates[0].reasons.some(reason => reason.code === 'SCOPE_DENIED'));
  await assert.rejects(() => runProcedure(root, runInput({ authorized_effects: { write_roots: ['other'], network: false, publication: false } })), /scope exceeds/);
  assert.equal(existsSync(join(root, 'out/next.json')), false);
});

test('a healthy qualified version remains selectable but an explicitly requested invalid latest cannot silently downgrade', async t => {
  const { root, manifest } = fixture(t); await qualify(root, manifest);
  put(root, '.workforce/procedures/json-result/2.0.0/manifest.json', '{broken-json');
  const ordinary = prepareWork(root, request());
  assert.equal(ordinary.registry.state, 'degraded'); assert.equal(ordinary.decision, 'exact');
  assert.equal(ordinary.selected_procedure.version, '1.0.0');
  const latest = prepareWork(root, request({ procedure_id: 'json-result' }));
  assert.equal(latest.decision, 'blocked'); assert.equal(latest.selected_procedure, undefined);
  const invalid = prepareWork(root, request({ procedure_id: 'json-result', procedure_version: '2.0.0' }));
  assert.equal(invalid.decision, 'blocked'); assert.equal(invalid.selected_procedure, undefined);
  const pinned = prepareWork(root, request({ procedure_id: 'json-result', procedure_version: '1.0.0' }));
  assert.equal(pinned.decision, 'exact'); assert.equal(pinned.selected_procedure.version, '1.0.0');
  assert.equal(pinned.execution_authorized, false); assert.equal(existsSync(join(root, 'out/next.json')), false);
});

test('explicit legacy engines preserve strict invalid-registry and corrupt-index failures', t => {
  const { root } = fixture(t, 'vscode-lm');
  assert.equal(prepareWork(root, request()).retrieval.source, 'sqlite');
  const index = safePath(root, '.workforce/cache/procedures.sqlite'); writeFileSync(index, 'Corrupt SQLite bytes.');
  assert.throws(() => prepareWork(root, request()), error => error.code === 'PROCEDURE_INDEX_CORRUPT');
  put(root, '.workforce/procedures/invalid_entry/marker', 'Keep source.');
  assert.throws(() => prepareWork(root, request())); assert.throws(() => listProcedures(root));
});
