// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { hash } from '../dist/storage.js';
import { registerProcedure, registerProcedureSchema } from '../dist/procedures.js';
import { controlledRegistrationEvidence } from '../dist/controlled-registration-evidence.js';
import { createControlledMcpServer, controlledToolNames } from '../dist/controlled-tools.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-registration-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'REGISTRATION', name: 'Scoped registry evidence' });
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'checks'));
  for (const path of ['scripts/generate.mjs', 'checks/verify.mjs', 'scripts/schema.json']) writeFileSync(join(root, path), '{}\n');
  const workflow_id = 'REGISTRATION-KNW-0001', epoch_id = 'actual-epoch', author = 'actual-latest-producer';
  const definition = registerProcedureSchema.omit({ id: true, version: true, author: true }).parse({
    title: 'Reusable artifact', description: 'Generate and independently check a future artifact.',
    script: 'scripts/generate.mjs', verification_script: 'checks/verify.mjs', dependencies: ['scripts/schema.json'],
    parameters: { output: { type: 'string', path: true, required: true },
      language: { type: 'string' }, optional_note: { type: 'string', required: false } }, outputs: [{ path: '{output}', min_bytes: 1 }],
    environment: { platforms: [process.platform], clients: ['codex', 'copilot', 'cli'] },
    effects: { write_roots: ['generated'], network: false, publication: false },
  });
  const run = { workflow_id, epoch_id, attempts: [{ id: 'producer-attempt', stage: 'implementation',
    invocation_id: author, state: 'completed', report: { outcome: 'completed' } }],
    procedure_candidate_id: `workflow-${hash(workflow_id).slice(0, 24)}`, procedure_candidate_version: '1.0.3' };
  const contract = { workflow_id, epoch_id, task_id: 'REGISTRATION-TASK-0001', plan: { procedure_candidate: definition } };
  const register = (overrides = {}) => registerProcedure(root, { ...definition, id: run.procedure_candidate_id,
    version: run.procedure_candidate_version, author, ...overrides });
  const snapshot = () => JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath, entry.name); return [path, hash(readFileSync(path))];
    }).sort(([a], [b]) => a.localeCompare(b)));
  return { root, run, contract, register, snapshot };
}

test('actual scoped registry evidence exposes manifest rules and fresh hashes without execution history or qualification', t => {
  const { root, run, contract, register, snapshot } = fixture(t), manifest = register(), before = snapshot();
  const evidence = controlledRegistrationEvidence(root, run, contract);
  assert.equal(evidence.registered, true); assert.equal(evidence.status, 'candidate');
  assert.equal(evidence.id, manifest.id); assert.equal(evidence.version, '1.0.3');
  assert.equal(evidence.created_at, manifest.created_at); assert.equal(evidence.contract_hash, manifest.contract_hash);
  assert.equal(evidence.task_id, contract.task_id); assert.equal(evidence.author_matches_latest_producer, true);
  assert.equal(evidence.immutable_plan_matches, true); assert.equal(evidence.current_code_matches, true);
  assert.equal(evidence.script.registered_sha256, evidence.script.current_sha256);
  assert.equal(evidence.verification_script.registered_sha256, evidence.verification_script.current_sha256);
  assert.ok(evidence.dependencies.every(item => item.matches));
  assert.equal(evidence.parameters.output.type, 'string'); assert.equal(evidence.parameters.output.path, true);
  assert.equal(evidence.parameters.output.required, true); assert.deepEqual(evidence.outputs, manifest.outputs);
  assert.equal(evidence.parameters.language.required, true, 'An omitted required flag follows the actual procedure validator default.');
  assert.equal(evidence.parameters.optional_note.required, false);
  assert.deepEqual(evidence.environment.platforms, manifest.environment.platforms);
  assert.deepEqual(evidence.environment.clients, manifest.environment.clients); assert.deepEqual(evidence.effects, manifest.effects);
  assert.deepEqual(evidence.history_counts, { reviews: 0, runs: 0, local_process_successes: 0, fixture_runs: 0 });
  assert.match(evidence.qualification, /does not qualify or execute/);
  for (const field of ['reviews', 'runs', 'reason', 'author', 'description']) assert.equal(field in evidence, false);
  assert.equal(snapshot(), before, 'Reading registration evidence must not mutate any registry, record or artifact.');
});

test('valid credential-bearing manifest rules remain private while full immutable-definition matching is enforced', t => {
  const { root, run, contract, register } = fixture(t);
  const parameters = { ...contract.plan.procedure_candidate.parameters,
    api_key: { type: 'string', default: 'SHOULD_NEVER_REACH_REVIEWER_DEFAULT', enum: ['SHOULD_NEVER_REACH_REVIEWER_DEFAULT'] },
    selector: { type: 'string', pattern: '^SHOULD_NEVER_REACH_REVIEWER_PATTERN$' } };
  const environment = { ...contract.plan.procedure_candidate.environment, tools: { provider: 'SHOULD_NEVER_REACH_REVIEWER_TOOL' },
    modes: ['SHOULD_NEVER_REACH_REVIEWER_MODE'], assurance: ['SHOULD_NEVER_REACH_REVIEWER_ASSURANCE'] };
  contract.plan.procedure_candidate = { ...contract.plan.procedure_candidate, parameters, environment };
  register({ parameters, environment });
  const evidence = controlledRegistrationEvidence(root, run, contract);
  assert.equal(evidence.registered, true); assert.equal(evidence.parameters.api_key.default_present, true);
  assert.equal(evidence.parameters.api_key.enum_count, 1); assert.equal(evidence.parameters.selector.pattern_present, true);
  assert.equal(evidence.environment.tool_requirement_count, 1); assert.equal(evidence.environment.mode_constraint_count, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /SHOULD_NEVER_REACH_REVIEWER/);
  const changed = structuredClone(contract); changed.plan.procedure_candidate.parameters.api_key.default = 'different secret';
  assert.equal(controlledRegistrationEvidence(root, run, changed).reason, 'REGISTERED_PLAN_MISMATCH');
});

test('unregistered, foreign, wrong-author and wrong-plan manifests cannot substitute for the bound candidate', t => {
  const { root, run, contract, register } = fixture(t);
  assert.equal(controlledRegistrationEvidence(root, { ...run, procedure_candidate_id: undefined }, contract).reason, 'CANDIDATE_NOT_REGISTERED');
  assert.equal(controlledRegistrationEvidence(root, run, contract).reason, 'REGISTERED_MANIFEST_UNAVAILABLE');
  const foreign = register({ id: 'foreign-workflow' });
  const result = controlledRegistrationEvidence(root, { ...run, procedure_candidate_id: foreign.id }, contract);
  assert.equal(result.reason, 'CANDIDATE_BINDING_MISMATCH'); assert.equal('id' in result, false);
  register({ author: 'another-producer' });
  assert.equal(controlledRegistrationEvidence(root, run, contract).reason, 'REGISTERED_AUTHOR_MISMATCH');
  const actualRun = { ...run, attempts: [{ ...run.attempts[0], invocation_id: 'another-producer' }] };
  assert.equal(controlledRegistrationEvidence(root, actualRun, { ...contract,
    plan: { procedure_candidate: { ...contract.plan.procedure_candidate, timeout_ms: 12345 } } }).reason, 'REGISTERED_PLAN_MISMATCH');
  assert.equal(controlledRegistrationEvidence(root, actualRun, { ...contract, epoch_id: 'foreign-epoch' }).reason, 'CONTRACT_BINDING_MISMATCH');
  assert.equal(controlledRegistrationEvidence(root, { ...actualRun, attempts: [...actualRun.attempts,
    { stage: 'implementation', state: 'running', invocation_id: 'new-producer' }] }, contract).reason, 'COMPLETED_PRODUCER_REQUIRED');
});

test('current script, checker and dependency drift is visible without rewriting pinned registration or exposing raw reasons', t => {
  for (const path of ['scripts/generate.mjs', 'checks/verify.mjs', 'scripts/schema.json']) {
    const { root, run, contract, register, snapshot } = fixture(t); register();
    writeFileSync(join(root, path), 'changed bytes\n'); const before = snapshot();
    const evidence = controlledRegistrationEvidence(root, run, contract);
    assert.equal(evidence.registered, true); assert.equal(evidence.status, 'suspended'); assert.equal(evidence.current_code_matches, false);
    const artifact = [evidence.script, evidence.verification_script, ...evidence.dependencies].find(item => item.path === path);
    assert.equal(artifact.matches, false); assert.notEqual(artifact.registered_sha256, artifact.current_sha256);
    assert.equal('reason' in evidence, false); assert.equal(snapshot(), before);
  }
});

test('real MCP advertises optional registration kind on the unchanged tool and returns actual bound evidence', async t => {
  const { root, run, contract, register } = fixture(t); const manifest = register();
  const actor = { workflow_id: run.workflow_id, task_id: contract.task_id, invocation_id: 'actual-reviewer',
    role: 'reviewer', stage: 'review', implementation_paths: ['scripts'], verification_paths: ['checks'] };
  const server = createControlledMcpServer(root, actor, { assertActive() {}, saveReport: () => ({ saved: true }),
    readEvidence: (_title, kind) => kind === 'registration' ? controlledRegistrationEvidence(root, run, contract) : [{ title: 'Current execution', passed: true }] });
  const client = new Client({ name: 'registry-evidence-sdk', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools, declared = tools.find(tool => tool.name === 'check_evidence');
  assert.deepEqual(tools.map(tool => tool.name).sort(), controlledToolNames(actor).sort());
  assert.deepEqual(declared.inputSchema.properties.kind.enum, ['execution', 'registration', 'workflow']);
  assert.ok(!declared.inputSchema.required?.includes('kind')); assert.equal(declared.inputSchema.additionalProperties, false);
  const value = result => JSON.parse(result.content[0].text);
  const registration = value(await client.callTool({ name: 'check_evidence', arguments: { kind: 'registration' } }));
  assert.equal(registration.id, manifest.id); assert.equal(registration.current_code_matches, true); assert.equal(registration.status, 'candidate');
  assert.deepEqual(value(await client.callTool({ name: 'check_evidence', arguments: {} })), [{ title: 'Current execution', passed: true }]);
  assert.equal((await client.callTool({ name: 'check_evidence', arguments: { kind: 'registration', procedure_id: 'foreign' } })).isError, true);
});
