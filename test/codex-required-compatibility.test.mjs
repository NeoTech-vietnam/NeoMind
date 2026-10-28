// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../dist/storage.js';
import { adapterOutputs } from '../dist/adapters.js';
import { canonicalJson, ensureRoutingPolicy, readInvocation, routingConfigurationHashes, invocationConfigurationHashes, routingProblems } from '../dist/routing.js';
import { onlyAddedRequiredNeoMindMcp } from '../dist/codex-required-compatibility.js';
import { controlledToolNames } from '../dist/controlled-tools.js';

const path = '.codex/config.toml';
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-required-compat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialize(root, { platforms: ['codex'] }), policy = { ...ensureRoutingPolicy(root), vscode_effort_policy: 'allow-unavailable' };
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ execution_mode: 'neomind-controlled' }));
  const generated = adapterOutputs(root, config).find(output => output.path === path && output.key === 'mcp-neomind');
  const content = generated?.content ?? adapterOutputs(root, config).find(output => output.path === path && output.content?.startsWith('[mcp_servers.neomind]')).content;
  assert.equal((content.match(/^required = true$/gm) ?? []).length, 1);
  const before = `model = "parent-model"\nmodel_provider = "parent-provider"\n\n${content.replace('required = true\n', '')}`;
  mkdirSync(join(root, '.codex'), { recursive: true }); writeFileSync(join(root, path), before);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem), id = randomUUID();
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true }); mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.neomind/native/keys/${keyId}.pem`), pem);
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const scope = controlledToolNames({ workflow_id: 'owned-workflow', role: 'developer', stage: 'implementation',
    implementation_paths: [], verification_paths: [], execution_steps: [], procedure_bound: false, cornell_bound: false });
  const receipt = { schema_version: 1, id, issuer: 'neomind-vscode-lm', execution_mode: 'vscode-extension-host',
    identity_provenance: 'local-vscode-extension-host', project_id: config.project_id,
    receipt_path: `.neomind/native/receipts/${id}.json`, key_id: keyId, role: 'developer', owner_pid: process.pid,
    host_instance: 'a'.repeat(64), native_thread_id: `vscode-host:conversation:${randomUUID()}`, native_turn_id: `vscode-host:turn:${randomUUID()}`,
    workflow_id: 'owned-workflow', task_id: 'owned-task',
    requested_model: policy.worker_models[0], confirmed_model: policy.worker_models[0], model_provider: 'copilot',
    native_tool_scope: scope, gateway_policy_sha256: hash(canonicalJson(scope)), native_sandbox: null,
    reasoning_effort: policy.worker_effort, confirmed_reasoning_effort: null, effort_support: 'unavailable', client_version: '1.109.0',
    runtime_integrity: '', protocol_sha256: hash('neomind-vscode-lm-v1'), routing_sha256: hash(canonicalJson(policy)),
    state: 'running', inference_completed: false, permissions: [], reroutes: [],
    configuration_hashes: routingConfigurationHashes(root),
    controlled_execution: { schema_version: 1, epoch_id: randomUUID(), stage: 'implementation', routing_policy: policy,
      tool_contract: { version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: false, research: false } }, ...options };
  const save = value => { const unsigned = JSON.parse(JSON.stringify(value));
    writeFileSync(join(root, receipt.receipt_path), JSON.stringify({ ...unsigned,
      signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') })); };
  save(receipt);
  const after = `model = "parent-model"\nmodel_provider = "parent-provider"\n\n${content}`;
  writeFileSync(join(root, path), after);
  return { root, receipt, before, after, save, read: () => readInvocation(root, id) };
}

test('the actual generated required line is a byte-exact upgrade only for verified controlled VS Code receipts', t => {
  const a = fixture(t), signed = a.read();
  assert.equal(onlyAddedRequiredNeoMindMcp(Buffer.from(a.after), hash(a.before)), true);
  assert.equal(invocationConfigurationHashes(a.root, signed)[path], hash(a.before));
  assert.equal(invocationConfigurationHashes(a.root, a.receipt)[path], hash(a.before), 'Owner in-memory receipt still needs fresh signed verification.');
  assert.deepEqual(routingProblems(a.root, 'developer', signed.id, { require_completed: false }), [], 'A real v3 controlled scope retains its full signed routing checks.');
  assert.equal(routingConfigurationHashes(a.root)[path], hash(a.after), 'Ordinary current configuration hashes are never normalized.');
  for (const newline of ['\n', '\r\n']) {
    const before = a.before.replaceAll('\n', newline), after = a.after.replaceAll('\n', newline);
    assert.equal(onlyAddedRequiredNeoMindMcp(Buffer.from(after), hash(before)), true);
  }
});

test('native, noncontrolled, unverified and caller-modified receipts never receive the compatibility hash', t => {
  for (const options of [{ controlled_execution: undefined }, { issuer: 'neomind-codex-app-server', execution_mode: 'native' },
    { execution_mode: 'native' }, { identity_provenance: 'reported-native' }]) {
    const a = fixture(t, options);
    assert.equal(invocationConfigurationHashes(a.root, a.read())[path], hash(a.after));
  }
  const a = fixture(t);
  for (const changed of [{ task_id: 'other-task' }, { role: 'manager' }, { owner_pid: process.pid + 1 },
    { permissions: [{ method: 'unsafe', reason: 'changed authorization' }] },
    { controlled_execution: { ...a.receipt.controlled_execution, epoch_id: randomUUID() } }])
    assert.equal(invocationConfigurationHashes(a.root, { ...a.receipt, ...changed })[path], hash(a.after));
  const saved = JSON.parse(readFileSync(join(a.root, a.receipt.receipt_path), 'utf8')); saved.signature = 'invalid';
  writeFileSync(join(a.root, a.receipt.receipt_path), JSON.stringify(saved));
  assert.equal(invocationConfigurationHashes(a.root, a.receipt)[path], hash(a.after));
});

test('server commands, model/provider, tool and permission edits or any other bytes remain guarded', t => {
  const a = fixture(t);
  const variants = [
    a.after.replace('parent-model', 'different-model'), a.after.replace('parent-provider', 'different-provider'),
    a.after.replace('command = ', 'command = "substitute" # '),
    a.after.replace('"manager_control"', '"record_update"'), a.after + '\n[sandbox_workspace_write]\nnetwork_access = true\n',
    a.after.replace('required = true', 'required = false'), a.after + '# another byte change\n',
  ];
  for (const value of variants) {
    writeFileSync(join(a.root, path), value);
    assert.equal(onlyAddedRequiredNeoMindMcp(Buffer.from(value), hash(a.before)), false);
    assert.equal(invocationConfigurationHashes(a.root, a.read())[path], hash(value));
  }
  assert.equal(onlyAddedRequiredNeoMindMcp(Buffer.from(a.after), hash(a.before.replace('[mcp_servers.neomind]\n', '[mcp_servers.neomind]\nrequired = false\n'))), false);
});

test('TOML multiline strings cannot impersonate the owned MCP table or required key', () => {
  const before = 'description = """\n[mcp_servers.neomind]\nexample\n"""\n[mcp_servers.neomind]\ncommand = "node"\n';
  const fake = before.replace('example\n', 'required = true\nexample\n');
  assert.equal(onlyAddedRequiredNeoMindMcp(Buffer.from(fake), hash(before)), false);
  const both = fake + 'required = true\n';
  assert.equal(onlyAddedRequiredNeoMindMcp(Buffer.from(both), hash(before)), false, 'Removing a line inside prose cannot hide another actual change.');
  const real = before + 'required = true\n';
  assert.equal(onlyAddedRequiredNeoMindMcp(Buffer.from(real), hash(before)), true);
});

test('other project configuration changes remain visible alongside the exact readiness-only upgrade', t => {
  const a = fixture(t), signed = a.read();
  writeFileSync(join(a.root, '.neomind/tools.json'), '{"providers":["changed-policy"]}\n');
  const hashes = invocationConfigurationHashes(a.root, signed);
  assert.equal(hashes[path], signed.configuration_hashes[path]);
  assert.notEqual(hashes['.neomind/tools.json'], signed.configuration_hashes['.neomind/tools.json']);
});
