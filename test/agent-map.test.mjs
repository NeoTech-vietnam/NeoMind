import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { initialize, createRecord, hash } from '../dist/storage.js';
import { canonicalJson } from '../dist/routing.js';
import { readAgentMap, agentMapLimits } from '../dist/agent-map.js';
import { reportAgentActivity, agentActivityTtlMs } from '../dist/agent-activity.js';
import { lightweightRun } from '../dist/lightweight.js';
import { observeNativeHook } from '../dist/agent-hooks.js';
import { serveHost } from '../dist/vscode-wire.js';

function setup(t, cleanup = true) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-map-'));
  initialize(root, { project_id: 'MAP', name: 'Map test' });
  if (cleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
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

function nativeWorkflow(root) {
  return createRecord(root, { type: 'knowledge', title: 'Native activity increment', owner: 'manager', status: 'in-progress',
    data: { kind: 'manager-workflow', execution_mode: 'copilot-native', routing_required: false,
      assurance: 'unsigned-native-report', phase: 'intake' }, body: 'PRIVATE WORKFLOW BODY' });
}
function inventory(root, directory = '') {
  return readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(item => {
      const path = join(directory, item.name);
      return item.isDirectory() ? inventory(root, path) : [[path, hash(readFileSync(join(root, path)))]];
    });
}

test('bounded receipt history does not suppress a fresh native hook observation', t => {
  const { root, receipt } = setup(t);
  for (let index = 0; index < agentMapLimits.receipts; index++) receipt({ state: 'completed' });
  const observed = observeNativeHook(root, 'codex', { session_id: 'current-session', agent_id: 'current-agent',
    agent_type: 'neomind-explorer', cwd: root }, 'SubagentStart');
  const map = readAgentMap(root);
  assert.ok(map.nodes.some(node => node.id === `native-hook:${observed.observation.id}` && node.state === 'running'));
  assert.ok(map.nodes.filter(node => node.kind === 'agent').length <= agentMapLimits.receipts);
  assert.ok(map.diagnostics.omitted_receipts > 0, 'Displaced history remains explicitly counted.');
});

test('native progress appears before assignment reports with unsigned provenance and a read-only projection', t => {
  const { root } = setup(t), workflow = nativeWorkflow(root);
  const event = reportAgentActivity(root, { workflow_id: workflow.meta.id, assignment_id: 'explore-entrypoints',
    profile_id: 'explorer', state: 'running', summary: 'Trace entrypoint ownership', invocation_id: 'reported-explorer-session' });
  const before = inventory(root), map = readAgentMap(root), id = `progress:${workflow.meta.id}:explore-entrypoints`;
  const agent = map.nodes.find(node => node.id === id);
  assert.ok(agent, 'An explicitly started native profile is visible before its final work report.');
  assert.equal(agent.label, 'NeoMind Explorer Agent');
  assert.equal(agent.role, 'codebase-analyst');
  assert.equal(agent.profile_id, 'explorer');
  assert.equal(agent.assignment_id, 'explore-entrypoints');
  assert.equal(agent.source, 'native-activity');
  assert.equal(agent.source_id, event.id);
  assert.equal(agent.execution_mode, 'unsigned-native-progress');
  assert.equal(agent.state, 'running');
  assert.equal(agent.reported_state, 'running');
  assert.equal(agent.expired, false);
  assert.equal(agent.activity_summary, 'Trace entrypoint ownership');
  assert.equal(agent.reported_at, event.observed_at);
  assert.equal(agent.confirmed_model, null);
  assert.equal(agent.requested_model, null);
  assert.equal(agent.provider, null);
  assert.ok(map.edges.some(edge => edge.kind === 'handoff' && edge.from === workflow.meta.id && edge.to === id &&
    edge.source === 'native-activity' && edge.evidence_id === event.id && edge.at === event.observed_at));
  assert.equal(map.nodes.some(node => node.id === `progress:${workflow.meta.id}:coordinator`), false);
  assert.equal(JSON.stringify(map).includes('PRIVATE WORKFLOW BODY'), false);
  assert.deepEqual(inventory(root), before, 'Reading activity must not create locks, records or files or modify existing state.');
});

test('reported allocations and returns connect to an actually reported Coordinator without duplicating progress messages', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { root } = setup(t), workflow = nativeWorkflow(root);
  const task = createRecord(root, { type: 'task', title: 'Refine criteria', owner: 'requirements', status: 'ready',
    data: { workflow_id: workflow.meta.id, routing_required: false } });
  const workflowBefore = readFileSync(join(root, workflow.path)), taskBefore = readFileSync(join(root, task.path));
  reportAgentActivity(root, { workflow_id: workflow.meta.id, assignment_id: 'coordinator', profile_id: 'coordinator',
    state: 'running', summary: 'Coordinate the requirement increment' });
  t.mock.timers.tick(1);
  const input = { workflow_id: workflow.meta.id, assignment_id: 'plan', profile_id: 'planner', task_id: task.meta.id,
    invocation_id: 'reported-planner' };
  const allocation = reportAgentActivity(root, { ...input, state: 'dispatched', summary: 'Allocate acceptance planning' });
  const coordinator = `progress:${workflow.meta.id}:coordinator`, planner = `progress:${workflow.meta.id}:plan`;
  const dispatched = readAgentMap(root);
  assert.equal(dispatched.nodes.find(node => node.id === planner).state, 'waiting');
  assert.equal(dispatched.nodes.find(node => node.id === planner).reported_state, 'dispatched');
  assert.ok(dispatched.edges.some(edge => edge.from === coordinator && edge.to === planner && edge.kind === 'handoff' && edge.evidence_id === allocation.id));
  t.mock.timers.tick(1);
  reportAgentActivity(root, { ...input, state: 'running', summary: 'Refine measurable acceptance criteria' });
  t.mock.timers.tick(1);
  const returned = reportAgentActivity(root, { ...input, state: 'completed', summary: 'Return proposed acceptance criteria' });
  const map = readAgentMap(root), node = map.nodes.find(node => node.id === planner);
  assert.equal(node.state, 'completed');
  assert.equal(node.source_id, returned.id);
  assert.equal(node.confirmed_model, null);
  assert.equal(map.edges.filter(edge => edge.kind === 'handoff' && edge.to === planner).length, 1);
  assert.ok(map.edges.some(edge => edge.from === planner && edge.to === coordinator && edge.kind === 'report' &&
    edge.source === 'native-activity' && edge.evidence_id === returned.id && edge.at === returned.observed_at));
  assert.ok(map.edges.some(edge => edge.from === planner && edge.to === task.meta.id && edge.kind === 'works-on'));
  assert.deepEqual(readFileSync(join(root, workflow.path)), workflowBefore);
  assert.deepEqual(readFileSync(join(root, task.path)), taskBefore, 'Activity completion cannot accept or submit an engineering task.');
});

test('expired native progress becomes unknown instead of finished and stops its allocation animation', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { root } = setup(t), workflow = nativeWorkflow(root);
  const event = reportAgentActivity(root, { workflow_id: workflow.meta.id, assignment_id: 'diagnose', profile_id: 'debugger',
    state: 'running', summary: 'Reproduce the reported failure' });
  t.mock.timers.tick(agentActivityTtlMs + 1);
  const before = inventory(root), map = readAgentMap(root), id = `progress:${workflow.meta.id}:diagnose`;
  const node = map.nodes.find(node => node.id === id);
  assert.equal(node.state, 'unknown');
  assert.equal(node.reported_state, 'running');
  assert.equal(node.expired, true);
  assert.equal(Date.parse(node.expires_at), Date.parse(event.observed_at) + agentActivityTtlMs);
  assert.equal(node.confirmed_model, null);
  assert.equal(map.edges.find(edge => edge.to === id && edge.kind === 'handoff').animated, false);
  assert.equal(map.edges.some(edge => edge.from === id && edge.kind === 'report'), false);
  assert.deepEqual(inventory(root), before);
});

test('lightweight workflows expose explicitly reported activity without requiring a full-lifecycle report', t => {
  const { root } = setup(t);
  const result = lightweightRun(root, { requirement: 'Inspect a bounded local feature', request_id: 'activity-map-lightweight' });
  const workflowId = result.workflow.workflow_id;
  reportAgentActivity(root, { workflow_id: workflowId, assignment_id: 'coordinator', profile_id: 'coordinator',
    state: 'running', summary: 'Check the lightweight plan and evidence' });
  const before = inventory(root), map = readAgentMap(root);
  assert.equal(map.nodes.find(node => node.id === workflowId).kind, 'workflow');
  const coordinator = map.nodes.find(node => node.id === `progress:${workflowId}:coordinator`);
  assert.equal(coordinator.label, 'NeoMind Coordinator Agent');
  assert.equal(coordinator.source, 'native-activity');
  assert.equal(coordinator.state, 'running');
  assert.equal(coordinator.execution_mode, 'unsigned-native-progress');
  assert.deepEqual(inventory(root), before);
});

test('native progress shares the existing agent cap and surfaces invalid or omitted activity diagnostics', t => {
  const { root, receipt } = setup(t), workflow = nativeWorkflow(root);
  reportAgentActivity(root, { workflow_id: workflow.meta.id, assignment_id: 'explore', profile_id: 'explorer',
    state: 'running', summary: 'Inspect bounded code paths' });
  writeFileSync(join(root, `.neomind/runs/agent-activity/${randomUUID()}.json`), '{invalid');
  for (let index = 0; index < agentMapLimits.receipts; index++) receipt({ state: 'completed' });
  const before = inventory(root), map = readAgentMap(root);
  assert.equal(map.nodes.filter(node => node.kind === 'agent').length, agentMapLimits.receipts);
  assert.equal(map.nodes.some(node => node.source === 'native-activity'), true);
  assert.equal(map.diagnostics.invalid_activity, 1);
  assert.ok(map.diagnostics.omitted_receipts >= 1, 'Fresh assignment progress takes precedence over completed receipt history.');
  assert.deepEqual(inventory(root), before);
});

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

test('controlled current markers distinguish actual execution and the latest recoverable blocker from immutable attempt history', async t => {
  const { root, receipt } = setup(t, false), host = await serveHost(root, async () => ({}));
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  const workflow = nativeWorkflow(root), foreign = nativeWorkflow(root);
  const legacyActivity = reportAgentActivity(root, { workflow_id: workflow.meta.id, assignment_id: 'legacy-implementer', profile_id: 'implementer', state: 'blocked', summary: 'Earlier unsigned implementation was blocked.' });
  const foreignActivity = reportAgentActivity(root, { workflow_id: foreign.meta.id, assignment_id: 'foreign-implementer', profile_id: 'implementer', state: 'running', summary: 'Independent unsigned workflow is still working.' });
  const foreignSigned = receipt({ workflow_id: foreign.meta.id, state: 'running' });
  const epoch = randomUUID(), old = receipt({ workflow_id: workflow.meta.id, role: 'manager', state: 'blocked' }), interrupted = receipt({ workflow_id: workflow.meta.id, state: 'interrupted' }), current = receipt({ workflow_id: workflow.meta.id, state: 'running' });
  const attempts = [old, interrupted, current].map((value, index) => ({ id: randomUUID(), invocation_id: value.id, role: value.role,
    stage: index === 0 ? 'planning' : 'implementation', state: index === 0 ? 'completed' : index === 1 ? 'interrupted' : 'running' }));
  const run = { schema_version: 1, process_contract: 'software-tools/v2', workflow_id: workflow.meta.id, epoch_id: epoch,
    status: 'running', phase: 'implementation', owner_pid: process.pid, owner_instance: host.instance, attempts, checks: [],
    updated_at: new Date().toISOString(), events: attempts.map(attempt => ({ id: randomUUID(), at: new Date().toISOString(), kind: 'dispatch', invocation_id: attempt.invocation_id })) };
  const dir = join(root, '.neomind/controlled/workflows'); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash(workflow.meta.id)}.json`), save = () => writeFileSync(path, JSON.stringify(run)); save();
  const beforeReceipts = [old, interrupted, current].map(value => readFileSync(join(root, value.receipt_path)));
  const controlled = () => readAgentMap(root).nodes.filter(node => node.kind === 'agent' && node.source === 'controlled-runtime');
  const first = controlled();
  assert.deepEqual(first.filter(node => node.controlled_current).map(node => node.invocation_id), [current.id]);
  assert.equal(first.find(node => node.invocation_id === old.id).state, 'blocked');
  assert.equal(first.find(node => node.invocation_id === interrupted.id).state, 'interrupted');
  assert.ok(first.every(node => typeof node.controlled_current === 'boolean'));
  assert.ok(first.every(node => node.signed_receipt === true), 'Runtime classification retains each validated receipt provenance marker.');
  const snapshot = readAgentMap(root), legacy = snapshot.nodes.find(node => node.source_id === legacyActivity.id), unrelated = snapshot.nodes.find(node => node.source_id === foreignActivity.id);
  assert.equal(legacy.source, 'native-activity'); assert.equal(legacy.state, 'blocked'); assert.equal(legacy.controlled_superseded, true);
  assert.equal(legacy.signed_receipt, undefined);
  assert.ok(snapshot.edges.filter(edge => edge.from === legacy.id || edge.to === legacy.id).every(edge => edge.animated === false));
  assert.equal(unrelated.source, 'native-activity'); assert.equal(unrelated.state, 'running'); assert.equal(unrelated.controlled_superseded, undefined);
  const signedOther = snapshot.nodes.find(node => node.invocation_id === foreignSigned.id);
  assert.equal(signedOther.source, 'signed-receipt'); assert.equal(signedOther.state, 'running'); assert.equal(signedOther.controlled_superseded, undefined);
  assert.equal(signedOther.signed_receipt, true);
  const dispatched = readAgentMap(root).edges.filter(edge => edge.source === 'controlled-runtime' && edge.kind === 'handoff');
  assert.equal(dispatched.length, attempts.length); assert.ok(dispatched.every(edge => edge.from === workflow.meta.id), 'The runtime workflow, not a past Coordinator model, dispatches controlled workers.');
  assert.equal(dispatched.filter(edge => edge.animated).length, 1);
  for (const status of ['completed', 'cancelled']) { run.status = status; save(); assert.equal(controlled().some(node => node.controlled_current), false, status); }
  attempts[2].state = 'interrupted'; run.status = 'queued'; save();
  assert.equal(controlled().some(node => node.controlled_current), false, 'A queued workflow cannot invent an invocation.');
  for (const status of ['blocked', 'paused', 'interrupted', 'uncertain']) {
    run.status = status; save(); const nodes = controlled();
    assert.deepEqual(nodes.filter(node => node.controlled_current).map(node => node.invocation_id), [current.id], status);
  }
  const completed = receipt({ workflow_id: workflow.meta.id, state: 'completed' });
  run.attempts.push({ id: randomUUID(), invocation_id: completed.id, role: 'developer', stage: 'implementation', state: 'completed' });
  run.status = 'blocked'; save();
  const context = controlled().find(node => node.invocation_id === completed.id);
  assert.equal(context.controlled_current, true); assert.equal(context.state, 'completed'); assert.equal(context.controlled_workflow_state, 'blocked');
  [old, interrupted, current].forEach((value, index) => assert.deepEqual(readFileSync(join(root, value.receipt_path)), beforeReceipts[index], 'Projection must not rewrite receipts or prior outcomes.'));
});

test('native self-reports retain reported provenance and cannot invent observed models', t => {
  const { root } = setup(t);
  const workflow = createRecord(root, { type: 'knowledge', title: 'Native increment', owner: 'manager',
    data: { kind: 'manager-workflow', assurance: 'unsigned-native-report' } });
  createRecord(root, { type: 'knowledge', title: 'Reported agent', owner: 'developer',
    data: { kind: 'manager-discussion', workflow_id: workflow.meta.id, invocation_id: 'reported-only', confirmed_model: 'FORGED MODEL', signed_receipt: true } });
  const beforeMap = readAgentMap(root), reported = beforeMap.nodes.find(node => node.kind === 'agent');
  assert.equal(reported.source, 'project-record');
  assert.equal(reported.execution_mode, 'unsigned-native-report');
  assert.equal(reported.confirmed_model, null);
  assert.equal(reported.signed_receipt, undefined, 'A project record cannot manufacture signed receipt provenance.');
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
