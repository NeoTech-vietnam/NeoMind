// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { hash, readConfig } from '../dist/storage.js';
import { canonicalJson, ensureRoutingPolicy, readInvocation, routingProblems, routingConfigurationHashes } from '../dist/routing.js';
import { controlledToolNames } from '../dist/controlled-tools.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-controlled-tool-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'TOOL-CONTRACT' });
  const policy = { ...ensureRoutingPolicy(root), vscode_effort_policy: 'allow-unavailable' };
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem);
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true });
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, '.neomind/native/keys', `${keyId}.pem`), pem);
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const save = (toolContract, operations, extra = {}) => {
    const id = randomUUID(), receipt = { schema_version: 1, issuer: 'neomind-vscode-lm', id,
      project_id: readConfig(root).project_id, receipt_path: `.neomind/native/receipts/${id}.json`, key_id: keyId,
      role: 'developer', state: 'completed', owner_pid: process.pid, execution_mode: 'vscode-extension-host',
      identity_provenance: 'local-vscode-extension-host', host_instance: 'a'.repeat(64), protocol_sha256: hash('neomind-vscode-lm-v1'),
      runtime_integrity: '', native_sandbox: null, native_thread_id: `vscode-host:conversation:${randomUUID()}`,
      native_turn_id: `vscode-host:turn:${randomUUID()}`, client_version: '1.109.0', effort_support: 'unavailable',
      reasoning_effort: 'low', confirmed_reasoning_effort: null, native_tool_scope: operations, gateway_policy_sha256: hash(canonicalJson(operations)),
      requested_model: policy.worker_models[0], confirmed_model: policy.worker_models[0], model_provider: 'copilot',
      workflow_id: 'TOOL-CONTRACT-KNW-0001', task_id: 'TOOL-CONTRACT-TASK-0001', routing_sha256: hash(canonicalJson(policy)),
      inference_completed: true, reroutes: [], configuration_hashes: routingConfigurationHashes(root),
      controlled_execution: { schema_version: 1, epoch_id: randomUUID(), stage: 'implementation', routing_policy: policy,
        ...(toolContract?.version === 3 && toolContract.evidence_documentation === true ? { documentation_source_sha256: 'd'.repeat(64) } : {}),
        ...(toolContract ? { tool_contract: toolContract } : {}) }, ...extra };
    const signed = { ...receipt, signature: sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64') };
    const path = join(root, `.neomind/native/receipts/${id}.json`); writeFileSync(path, JSON.stringify(signed));
    return { id, path, receipt: signed };
  };
  return { root, policy, save };
}
const originalV2 = ['runtime_context', 'project_read', 'project_list', 'project_search', 'assignment_report',
  'task_file_write', 'procedure_run', 'task_run', 'cornell_research_compile'];

test('historical signed v2 producer scopes remain valid without receiving newly added evidence tools', t => {
  const { root, save } = fixture(t);
  for (const local_execution of [false, true]) for (const qualified_procedure of [false, true]) {
    const scope = originalV2.filter(name => (local_execution || name !== 'task_run') && (qualified_procedure || name !== 'procedure_run'));
    const old = save({ version: 2, local_execution, qualified_procedure }, scope), before = readFileSync(old.path, 'utf8');
    assert.deepEqual(routingProblems(root, 'developer', old.id), []);
    assert.deepEqual(readInvocation(root, old.id).native_tool_scope, scope);
    assert.equal(readFileSync(old.path, 'utf8'), before, 'Compatibility cannot rewrite an old signed receipt or widen its recorded tools.');
  }
});

test('historical signed v1 producer scopes keep their original context/execution/evidence exclusions', t => {
  const { root, save } = fixture(t), original = originalV2.filter(name => !['runtime_context', 'task_run'].includes(name));
  const old = save(undefined, original);
  assert.deepEqual(routingProblems(root, 'developer', old.id), []);
  assert.deepEqual(readInvocation(root, old.id).native_tool_scope, original);
});

test('v3 signed documentation scope binds its report-only purpose and excludes producer execution and Cornell compilation', t => {
  const { root, save } = fixture(t);
  const binding = { workflow_id: 'TOOL-CONTRACT-KNW-0001', role: 'developer', stage: 'implementation',
    implementation_paths: ['docs/report.md'], verification_paths: ['checks'], evidence_documentation: true,
    execution_steps: [], procedure_bound: false };
  const operations = controlledToolNames(binding);
  assert.ok(operations.includes('check_evidence'));
  for (const unavailable of ['task_run', 'procedure_run', 'cornell_research_compile']) assert.ok(!operations.includes(unavailable));
  const receipt = save({ version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: true, research: false }, operations);
  assert.deepEqual(routingProblems(root, 'developer', receipt.id), []);
  const original = readFileSync(receipt.path, 'utf8'), tampered = JSON.parse(original);
  tampered.controlled_execution.tool_contract.evidence_documentation = false;
  writeFileSync(receipt.path, JSON.stringify(tampered));
  assert.match(routingProblems(root, 'developer', receipt.id).join('\n'), /signature or trusted public key is invalid/);
  writeFileSync(receipt.path, original);
  const mismatchedPurpose = save({ version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: false, research: true }, operations);
  assert.match(routingProblems(root, 'developer', mismatchedPurpose.id).join('\n'), /gateway scope is invalid/);
});

test('v3 ordinary producer evidence access is explicit and cannot be retroactively added to v2', t => {
  const { root, save } = fixture(t);
  const operations = [...originalV2, 'check_evidence'];
  const current = save({ version: 3, local_execution: true, qualified_procedure: true, evidence_documentation: false, research: true }, operations);
  assert.deepEqual(routingProblems(root, 'developer', current.id), []);
  const widened = save({ version: 2, local_execution: true, qualified_procedure: true }, operations);
  assert.match(routingProblems(root, 'developer', widened.id).join('\n'), /gateway scope is invalid/);
});

test('v3 ordinary work without requested Cornell output records an exact no-research scope', t => {
  const { root, save } = fixture(t);
  const operations = [...originalV2, 'check_evidence'].filter(name => name !== 'cornell_research_compile');
  const current = save({ version: 3, local_execution: true, qualified_procedure: true, evidence_documentation: false, research: false }, operations);
  assert.deepEqual(routingProblems(root, 'developer', current.id), []);
  const incorrectlyWidened = save({ version: 3, local_execution: true, qualified_procedure: true, evidence_documentation: false, research: false },
    [...originalV2, 'check_evidence']);
  assert.match(routingProblems(root, 'developer', incorrectlyWidened.id).join('\n'), /gateway scope is invalid/);
});

test('malformed or capability-escalating v3 documentation contracts fail closed even with valid receipt signatures', t => {
  const { root, save } = fixture(t), narrow = ['runtime_context', 'project_read', 'project_list', 'project_search',
    'assignment_report', 'task_file_write', 'check_evidence'];
  for (const declaration of [
    { version: 3, local_execution: false, qualified_procedure: false },
    { version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: 'true', research: false },
    { version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: true },
    { version: 3, local_execution: false, qualified_procedure: false, evidence_documentation: true, research: true },
    { version: 3, local_execution: true, qualified_procedure: false, evidence_documentation: true, research: false },
    { version: 3, local_execution: false, qualified_procedure: true, evidence_documentation: true, research: false },
    { version: 99, local_execution: false, qualified_procedure: false, evidence_documentation: true, research: false },
  ]) {
    const receipt = save(declaration, narrow);
    assert.match(routingProblems(root, 'developer', receipt.id).join('\n'), /tool contract version is invalid/);
  }
});
