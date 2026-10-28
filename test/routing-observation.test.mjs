// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, readConfig } from '../dist/storage.js';
import * as routing from '../dist/routing.js';
import { roleCapabilities } from '../dist/tools.js';

const physical = path => process.platform === 'win32' ? resolve(String(path)).toLowerCase() : resolve(String(path));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-routing-observation-'));
  initialize(root, { project_id: 'OBSERVATION' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = { ...routing.ensureRoutingPolicy(root), vscode_effort_policy: 'allow-unavailable' };
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  writeFileSync(join(root, '.neomind/tools.json'), JSON.stringify({ providers: [] }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem);
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true });
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, '.neomind/native/keys', `${keyId}.pem`), pem);
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const id = randomUUID(), scope = roleCapabilities('reviewer').operations;
  const receipt = { schema_version: 1, issuer: 'neomind-vscode-lm', execution_mode: 'vscode-extension-host', id,
    project_id: readConfig(root).project_id, receipt_path: `.neomind/native/receipts/${id}.json`, key_id: keyId,
    role: 'reviewer', state: 'running', owner_pid: process.pid, identity_provenance: 'local-vscode-extension-host',
    host_instance: 'a'.repeat(64), protocol_sha256: hash('neomind-vscode-lm-v1'), runtime_integrity: '', native_sandbox: null,
    native_thread_id: `vscode-host:conversation:${randomUUID()}`, native_turn_id: `vscode-host:turn:${randomUUID()}`,
    client_version: '1.109.0', effort_support: 'unavailable', reasoning_effort: 'high', confirmed_reasoning_effort: null,
    native_tool_scope: scope, gateway_policy_sha256: hash(routing.canonicalJson(scope)), requested_model: policy.strong_model,
    confirmed_model: policy.strong_model, model_provider: 'copilot', workflow_id: null, task_id: null,
    routing_sha256: hash(routing.canonicalJson(policy)), inference_completed: false, reroutes: [],
    configuration_hashes: routing.routingConfigurationHashes(root) };
  const path = join(root, receipt.receipt_path);
  const save = (changes = {}) => { const next = { ...receipt, ...changes };
    writeFileSync(path, JSON.stringify({ ...next, signature: sign(null, Buffer.from(routing.canonicalJson(next)), privateKey).toString('base64') })); };
  save();
  return { root, id, receipt, path, keyId, save };
}
function reads(action) {
  const original = fs.readFileSync, counts = new Map();
  fs.readFileSync = function (path, ...args) {
    if (typeof path === 'string') { const key = physical(path); counts.set(key, (counts.get(key) || 0) + 1); }
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { return { value: action(), counts }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

test('one authoritative host evaluation reads the signed receipt and independent configuration once', t => {
  const f = fixture(t);
  const observed = reads(() => {
    if (routing.observeInvocation) return routing.observeInvocation(f.root, 'reviewer', f.id, { require_completed: false });
    // Reproduce the pre-optimization host boundary on an old dist for red proof.
    const receipt = routing.readInvocation(f.root, f.id);
    return { receipt, current_configuration_hashes: routing.invocationConfigurationHashes(f.root, receipt),
      problems: routing.routingProblems(f.root, 'reviewer', f.id, { require_completed: false }) };
  });
  assert.deepEqual(observed.value.problems, []);
  for (const path of [f.path, join(f.root, '.neomind/native/trust.json'), join(f.root, '.neomind/native/keys', `${f.keyId}.pem`),
    join(f.root, '.neomind/tools.json')])
    assert.equal(observed.counts.get(physical(path)), 1, 'The same host check must not physically repeat receipt, trust, key or configuration-hash reads.');
});

test('every later observation freshly detects signature, trust and configuration mutation without trusting caller objects', t => {
  const f = fixture(t), options = { require_completed: false };
  const first = routing.observeInvocation(f.root, 'reviewer', f.id, options);
  assert.deepEqual(first.problems, []);
  const original = readFileSync(f.path, 'utf8');
  writeFileSync(f.path, JSON.stringify({ ...JSON.parse(original), confirmed_model: 'forged-model' }));
  const invalid = routing.observeInvocation(f.root, 'reviewer', f.id, { ...options, receipt: first.receipt,
    current_configuration_hashes: first.current_configuration_hashes });
  assert.equal(invalid.receipt, null);
  assert.match(invalid.problems.join(' '), /receipt cannot be verified.*signature/);
  writeFileSync(f.path, original);
  assert.deepEqual(routing.observeInvocation(f.root, 'reviewer', f.id, options).problems, []);
  const tools = join(f.root, '.neomind/tools.json'), before = readFileSync(tools);
  writeFileSync(tools, JSON.stringify({ providers: ['changed'] }));
  const changed = routing.observeInvocation(f.root, 'reviewer', f.id, options);
  assert.match(changed.problems.join(' '), /Relevant native configuration changed/);
  assert.notDeepEqual(changed.current_configuration_hashes, first.current_configuration_hashes);
  writeFileSync(tools, before);
  const trust = join(f.root, '.neomind/native/trust.json'); writeFileSync(trust, JSON.stringify({ keys: [] }));
  assert.match(routing.observeInvocation(f.root, 'reviewer', f.id, options).problems.join(' '), /trusted public key/);
  writeFileSync(trust, JSON.stringify({ keys: [f.keyId] }));
  assert.deepEqual(routing.observeInvocation(f.root, 'reviewer', f.id, options).problems, []);
});

test('fresh observation retains signed owner, role and gateway authority checks', t => {
  const f = fixture(t), inspect = () => routing.observeInvocation(f.root, 'reviewer', f.id, { require_completed: false });
  f.save({ owner_pid: 2147483647 });
  assert.match(inspect().problems.join(' '), /owner is absent/);
  f.save({ native_tool_scope: [] });
  assert.match(inspect().problems.join(' '), /gateway scope is invalid/);
  f.save({ role: 'developer' });
  assert.match(inspect().problems.join(' '), /different engineering role/);
  f.save(); assert.deepEqual(inspect().problems, []);
});

test('assertRouting returns the same freshly verified receipt without a second physical read and legacy diagnostics stay intact', t => {
  const f = fixture(t), observed = reads(() => routing.assertRouting(f.root, 'reviewer', f.id, { require_completed: false }));
  assert.equal(observed.value.id, f.id);
  assert.equal(observed.counts.get(physical(f.path)), 1);
  assert.deepEqual(routing.routingProblems(f.root, 'reviewer', undefined), ['Strict routing requires a bridge-issued native invocation receipt.']);
  rmSync(join(f.root, '.neomind/routing.json'));
  assert.deepEqual(routing.routingProblems(f.root, 'reviewer', 'legacy-invocation'), []);
  assert.deepEqual(routing.observeInvocation(f.root, 'reviewer', 'legacy-invocation'),
    { receipt: null, current_configuration_hashes: null, problems: [] });
});
