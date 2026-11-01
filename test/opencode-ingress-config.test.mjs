import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initialize, safePath, hash, readConfig } from '../dist/storage.js';
import { canonicalJson, ensureRoutingPolicy, routingConfigurationHashes, invocationConfigurationHashes,
  readInvocation, routingProblems } from '../dist/routing.js';
import { controlledToolNames } from '../dist/controlled-tools.js';
import { openCodeVersion, openCodeIntegrity, openCodeProtocolHash } from '../dist/execution-attestation.js';

const codex = '.codex/config.toml';
const beforeCodex = '[mcp_servers.workforce]\ncommand = "node"\nargs = ["D:/tools/workforce/previous/dist/cli.js", "mcp"]\n';
const afterCodex = beforeCodex.replace('/previous/', '/updated/');
function fixture(t, absent = false) {
  const root = mkdtempSync(join(tmpdir(), 'wf-ingress-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-INGRESS', execution_engine: 'opencode' });
  const put = (path, value) => { const target = safePath(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value); };
  put('catalog.json', JSON.stringify([{ name: 'customendpoint', models: [{ id: 'worker-models', url: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key' }] }]));
  const policy = { ...ensureRoutingPolicy(root), language_models_file: 'catalog.json' };
  put('.neomind/routing.json', JSON.stringify(policy));
  if (!absent) put(codex, beforeCodex);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem), id = randomUUID();
  put(`.neomind/native/keys/${keyId}.pem`, pem); put('.neomind/native/trust.json', JSON.stringify({ keys: [keyId] }));
  const controlled = { schema_version: 1, epoch_id: randomUUID(), stage: 'implementation', process_contract: 'workforce/v1', routing_policy: policy,
    tool_contract: { version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: false, research: false } };
  const scope = controlledToolNames({ workflow_id: 'WF-INGRESS-KNW-1', role: 'developer', stage: 'implementation',
    process_contract: 'workforce/v1', implementation_paths: [], verification_paths: [], execution_steps: [], procedure_bound: false, cornell_bound: false });
  const receipt = { schema_version: 1, id, issuer: 'workforce-opencode', execution_mode: 'opencode-local', identity_provenance: 'local-opencode',
    project_id: readConfig(root).project_id, receipt_path: `.neomind/native/receipts/${id}.json`, key_id: keyId,
    role: 'developer', workflow_id: 'WF-INGRESS-KNW-1', task_id: 'WF-INGRESS-TASK-1', request_id: randomUUID(), prior_invocation_id: null,
    input_text: 'Bound offline configuration-scope fixture.', input_sha256: hash('Bound offline configuration-scope fixture.'),
    requested_model: policy.worker_models[0], confirmed_model: policy.worker_models[0], model_provider: 'workforce-router',
    native_sandbox: null, native_tool_scope: scope, gateway_policy_sha256: hash(canonicalJson(scope)),
    reasoning_effort: policy.worker_effort, confirmed_reasoning_effort: null, effort_support: 'unavailable',
    client_version: openCodeVersion, runtime_integrity: openCodeIntegrity, protocol_sha256: openCodeProtocolHash,
    opencode: { version: openCodeVersion, binary_sha256: 'b'.repeat(64), gateway_instance: 'a'.repeat(64) },
    native_thread_id: `ses_${randomUUID()}`, native_turn_id: `msg_${randomUUID()}`, host_instance: 'a'.repeat(64),
    routing_sha256: hash(canonicalJson(policy)), configuration_hashes: routingConfigurationHashes(root), effective_configuration_sha256: null,
    controlled_execution: controlled, state: 'completed', inference_completed: true, output: 'Substantive fixture result.', error: null,
    fallback_evidence: null, reroutes: [], permissions: [], owner_pid: process.pid, server_pid: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const save = value => { const { signature: _signature, ...input } = value, unsigned = JSON.parse(JSON.stringify(input));
    put(receipt.receipt_path, JSON.stringify({ ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') })); };
  save(receipt);
  const path = safePath(root, receipt.receipt_path), original = readFileSync(path);
  const signed = readInvocation(root, id);
  assert.deepEqual(routingProblems(root, 'developer', id), [], 'Fixture starts with a fully verified signed worker receipt.');
  return { root, put, signed, path, original, save, policy };
}

test('verified OpenCode evidence survives a Codex ingress runtime-path upgrade without changing its signed bytes', t => {
  const f = fixture(t);
  for (const current of [afterCodex, 'model = "different-client-model"\nmodel_provider = "different-client-provider"\n' + afterCodex + '\n[sandbox_workspace_write]\nnetwork_access = true\n']) {
    f.put(codex, current);
    assert.equal(routingConfigurationHashes(f.root)[codex], hash(current), 'Raw current configuration remains observable.');
    assert.equal(invocationConfigurationHashes(f.root, f.signed)[codex], hash(beforeCodex));
    assert.deepEqual(routingProblems(f.root, 'developer', f.signed.id), []);
    assert.deepEqual(readFileSync(f.path), f.original);
  }
});

test('verified OpenCode ingress independence also preserves the signed absent encoding', t => {
  const f = fixture(t, true); assert.equal(f.signed.configuration_hashes[codex], 'absent');
  f.put(codex, afterCodex);
  assert.equal(invocationConfigurationHashes(f.root, f.signed)[codex], 'absent');
  assert.deepEqual(routingProblems(f.root, 'developer', f.signed.id), []);
  assert.deepEqual(readFileSync(f.path), f.original);
});

test('OpenCode ingress compatibility needs fresh disk authority and the complete stable binding', t => {
  const f = fixture(t); f.put(codex, afterCodex);
  for (const changed of [{ issuer: 'neomind-codex-app-server' }, { execution_mode: 'native' }, { identity_provenance: 'reported-native' },
    { task_id: 'different-task' }, { workflow_id: 'different-workflow' }, { request_id: randomUUID() }, { owner_pid: process.pid + 1 },
    { native_tool_scope: [] }, { configuration_hashes: { ...f.signed.configuration_hashes, [codex]: 'c'.repeat(64) } },
    { controlled_execution: undefined }, { controlled_execution: { ...f.signed.controlled_execution, epoch_id: randomUUID() } }])
    assert.equal(invocationConfigurationHashes(f.root, { ...f.signed, ...changed })[codex], hash(afterCodex));
  assert.equal(invocationConfigurationHashes(f.root, { ...f.signed, signature: 'caller-is-not-an-authority', state: 'running',
    output: 'A stale owner lifecycle view.', error: null, updated_at: 'earlier', inference_completed: false })[codex], hash(beforeCodex),
    'Only the authenticated disk binding grants compatibility; caller lifecycle/signature metadata cannot add authority.');
  f.put(f.signed.receipt_path, JSON.stringify({ ...f.signed, signature: 'invalid' }));
  assert.equal(invocationConfigurationHashes(f.root, f.signed)[codex], hash(afterCodex));
  assert.match(routingProblems(f.root, 'developer', f.signed.id).join(' '), /receipt cannot be verified/);
  assert.deepEqual(readFileSync(f.path), Buffer.from(JSON.stringify({ ...f.signed, signature: 'invalid' })));
  writeFileSync(f.path, f.original); f.put('.neomind/native/trust.json', '{"keys":[]}');
  assert.equal(invocationConfigurationHashes(f.root, f.signed)[codex], hash(afterCodex));
  assert.match(routingProblems(f.root, 'developer', f.signed.id).join(' '), /trusted public key/);
  assert.deepEqual(readFileSync(f.path), f.original);
});

test('all other worker configuration hashes remain strict alongside a benign Codex path upgrade', t => {
  const f = fixture(t); f.put(codex, afterCodex);
  const changes = [
    ['catalog.json', JSON.stringify([{ name: 'customendpoint', models: [{ id: 'worker-models', url: 'http://127.0.0.1:2/v1', apiKey: 'different-fixture-key' }] }])],
    ['.neomind/routing.json', JSON.stringify({ ...f.policy, strong_effort: 'medium' })],
    ['.neomind/tools.json', '{"approved_providers":[]}'], ['.neomind/native-runtime.lock.json', '{"changed":true}'],
    ['.neomind/router.json', '{"changed":true}'], ['.neomind/rea.json', '{"changed":true}'],
    ['.neomind/upstreams.json', '{"schema_version":1,"minimum_stars":0,"sources":[]}'],
    ['.neomind/config.json', JSON.stringify({ ...readConfig(f.root), name: 'Changed project configuration' })],
  ];
  for (const [path, value] of changes) {
    const target = safePath(f.root, path), previous = existsSync(target) ? readFileSync(target) : null;
    f.put(path, value);
    assert.match(routingProblems(f.root, 'developer', f.signed.id).join(' '), /configuration changed/, path);
    if (previous === null) rmSync(target); else writeFileSync(target, previous);
  }
  assert.deepEqual(routingProblems(f.root, 'developer', f.signed.id), []);
  assert.deepEqual(readFileSync(f.path), f.original);
});

test('legacy native and VS Code receipts retain strict Codex configuration checks', t => {
  const f = fixture(t); f.put(codex, afterCodex);
  for (const issuer of ['neomind-codex-app-server', 'neomind-vscode-lm']) {
    const legacy = { ...f.signed, issuer, execution_mode: issuer.endsWith('vscode-lm') ? 'vscode-extension-host' : 'native',
      identity_provenance: issuer.endsWith('vscode-lm') ? 'local-vscode-extension-host' : undefined };
    f.save(legacy); const signed = readInvocation(f.root, f.signed.id);
    assert.equal(invocationConfigurationHashes(f.root, signed)[codex], hash(afterCodex));
    assert.match(routingProblems(f.root, 'developer', signed.id).join(' '), /configuration changed/);
  }
});
