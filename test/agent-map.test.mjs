import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { initialize, createRecord, hash } from '../dist/storage.js';
import { canonicalJson } from '../dist/routing.js';
import { readAgentMap, agentMapLimits } from '../dist/agent-map.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-map-'));
  initialize(root, { project_id: 'MAP', name: 'Map test' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }), keyId = hash(pem);
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true });
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  writeFileSync(join(root, `.neomind/native/keys/${keyId}.pem`), pem);
  function receipt(patch = {}) {
    const id = randomUUID(), timestamp = new Date().toISOString();
    const unsigned = {
      schema_version: 1, issuer: 'neomind-vscode-lm', execution_mode: 'vscode-extension-host',
      id, receipt_path: `.neomind/native/receipts/${id}.json`, project_id: 'MAP', role: 'developer',
      workflow_id: null, task_id: null, prior_invocation_id: null, state: 'running',
      requested_model: 'requested-model', confirmed_model: 'observed-model', model_provider: 'test-provider',
      owner_pid: process.pid, created_at: timestamp, updated_at: timestamp, key_id: keyId,
      input_text: 'SECRET PROMPT', output: 'SECRET OUTPUT', error: 'SECRET ERROR',
      ...patch,
    };
    const value = { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') };
    writeFileSync(join(root, value.receipt_path), JSON.stringify(value));
    return value;
  }
  return { root, receipt };
}

test('map uses verified receipts and explicit engineering edges without disclosing prompts or record bodies', t => {
  const { root, receipt } = setup(t);
  const workflow = createRecord(root, { type: 'knowledge', title: 'Bounded increment', owner: 'manager',
    status: 'in-progress', data: { kind: 'manager-workflow', original_requirement: 'SECRET REQUIREMENT' }, body: 'SECRET BODY' });
  const task = createRecord(root, { type: 'task', title: 'Implement feature', owner: 'developer',
    status: 'ready', data: { workflow_id: workflow.meta.id } });
  const manager = receipt({ role: 'manager', workflow_id: workflow.meta.id });
  const worker = receipt({ workflow_id: workflow.meta.id, task_id: task.meta.id });
  const resumed = receipt({ workflow_id: workflow.meta.id, task_id: task.meta.id, prior_invocation_id: worker.id, state: 'completed' });
  const report = createRecord(root, { type: 'knowledge', title: 'Work report', owner: 'developer',
    data: { kind: 'work-record', workflow_id: workflow.meta.id, invocation_id: resumed.id },
    links: [{ type: 'documents', target: task.meta.id }], body: 'SECRET REPORT' });
  const map = readAgentMap(root), serialized = JSON.stringify(map);
  assert.equal(map.nodes.filter(node => node.kind === 'agent').length, 3);
  assert.ok(map.edges.some(edge => edge.from === `agent:${manager.id}` && edge.kind === 'coordinates'));
  assert.ok(map.edges.some(edge => edge.from === `agent:${worker.id}` && edge.kind === 'works-on'));
  assert.ok(map.edges.some(edge => edge.from === `agent:${worker.id}` && edge.to === `agent:${resumed.id}` && edge.kind === 'handoff'));
  assert.ok(map.edges.some(edge => edge.kind === 'report' && edge.evidence_id === report.meta.id && edge.source === 'project-record'));
  assert.equal(map.edges.some(edge => edge.from === `agent:${manager.id}` && edge.to === `agent:${worker.id}`), false);
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(map.nodes.find(node => node.source_id === worker.id).confirmed_model, 'observed-model');
});

test('tampered or foreign receipts cannot create agents or signed relationships', t => {
  const { root, receipt } = setup(t);
  const value = receipt();
  writeFileSync(join(root, value.receipt_path), JSON.stringify({ ...value, confirmed_model: 'forged' }));
  receipt({ project_id: 'OTHER' });
  const map = readAgentMap(root);
  assert.equal(map.nodes.length, 0);
  assert.equal(map.diagnostics.invalid_receipts, 2);
  assert.equal(JSON.stringify(map).includes('SECRET'), false);
});

test('waiting, failed, interrupted and absent owners remain visibly distinct from running agents', t => {
  const { root, receipt } = setup(t);
  const waiting = receipt({ state: 'waiting-native-permission' });
  const failed = receipt({ state: 'failed' });
  const interrupted = receipt({ state: 'interrupted' });
  const absent = receipt({ owner_pid: 2147483647 });
  const map = readAgentMap(root);
  const state = id => map.nodes.find(node => node.source_id === id).state;
  assert.equal(state(waiting.id), 'waiting');
  assert.equal(state(failed.id), 'failed');
  assert.equal(state(interrupted.id), 'blocked');
  assert.equal(state(absent.id), 'blocked');
});

test('native self-reports retain reported provenance and cannot invent observed models', t => {
  const { root } = setup(t);
  const workflow = createRecord(root, { type: 'knowledge', title: 'Native increment', owner: 'manager',
    data: { kind: 'manager-workflow', assurance: 'unsigned-native-report' } });
  createRecord(root, { type: 'knowledge', title: 'Reported agent', owner: 'developer',
    data: { kind: 'manager-discussion', workflow_id: workflow.meta.id, invocation_id: 'reported-only', confirmed_model: 'FORGED MODEL' } });
  const beforeMap = readAgentMap(root), reported = beforeMap.nodes.find(node => node.kind === 'agent');
  assert.equal(reported.source, 'project-record');
  assert.equal(reported.execution_mode, 'unsigned-native-report');
  assert.equal(reported.confirmed_model, null);
  assert.equal(reported.state, 'completed');
  assert.ok(beforeMap.edges.some(edge => edge.kind === 'contribution' && edge.source === 'project-record'));
  const template = createRecord(root, { type: 'task', title: 'Fixture task', data: { workflow_id: workflow.meta.id } });
  const source = readFileSync(join(root, template.path), 'utf8');
  // Write a large valid fixture directly; repeated createRecord calls would test
  // ID allocation and rescan all prior records rather than this bounded reader.
  for (let index = 2; index <= agentMapLimits.records + 4; index++) {
    const id = `MAP-TASK-${String(index).padStart(4, '0')}`;
    writeFileSync(join(root, `.neomind/records/${id}.md`), source.replaceAll(template.meta.id, id));
  }
  const configPath = join(root, '.neomind/config.json'), before = readFileSync(configPath, 'utf8');
  const map = readAgentMap(root);
  assert.equal(map.nodes.filter(node => node.kind === 'agent').length, 0);
  assert.equal(map.nodes.filter(node => node.kind !== 'agent').length, agentMapLimits.records);
  assert.ok(map.diagnostics.omitted_records > 0);
  assert.equal(readFileSync(configPath, 'utf8'), before);
});
