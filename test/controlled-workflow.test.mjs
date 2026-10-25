import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initialize, atomicWrite, getRecord, hash, loadRecords, safePath } from '../dist/storage.js';
import { executionModes } from '../dist/execution-mode.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { startControlledHost, startControlledWorkflow, controlControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';
import { setRoleModel } from '../dist/model-control.js';
import { readAgentMap } from '../dist/agent-map.js';

// These tests exercise the actual signed local Bridge, MCP, filesystem and child runner.
// The language model and editor API are deterministic fixtures, not actual Copilot/Codex inference.
class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (name, input) => ({ name, input });
const prohibited = new Set(['workflow_id', 'task_id', 'invocation_id', 'reported_assignment', 'claim_token', 'access_token', 'operation_id', 'expected_hash']);
function assertSemanticSchemas(tools) {
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const name of Object.keys(value.properties ?? {})) assert.ok(!prohibited.has(name), `model must not construct ${name}`);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  for (const tool of tools) {
    assert.ok(!['assignment_open', 'assignment_claim', 'assignment_progress', 'record_create', 'record_update', 'manager_run', 'native_dispatch', 'run_in_terminal'].includes(tool.name));
    visit(tool.inputSchema);
  }
}
function lastToolResult(messages) {
  const result = messages.at(-1)?.content?.[0];
  if (!(result instanceof Result)) return;
  let decoded = JSON.parse(result.content[0].value);
  return decoded;
}
function planFor(name, options = {}) {
  const output = `${name}/src/value.txt`, checker = `${name}/verify/check.cjs`, bad = `${name}/verify/bad.txt`;
  const baseline = [output, checker];
  return { title: `Produce ${name} scalar`, objective: 'Persist a scalar equal to one with independent positive and negative verification.',
    rationale: 'A bounded test artifact demonstrates actual workflow transitions and execution evidence.',
    acceptance_criteria: ['The delivered scalar is one.', 'The independent checker rejects a scalar equal to two.'],
    allowed_paths: [output], verification_paths: [`${name}/verify`], outputs: [output], documentation_paths: [],
    checks: [{ title: 'Validate scalar', command: [process.execPath, checker, output], baseline_paths: baseline,
      negative_controls: [{ title: 'Reject incorrect scalar', command: [process.execPath, checker, bad], baseline_paths: [checker, bad], expected_exit_code: 1 }] }],
    risk: options.highRisk ? 'high' : 'low' };
}
function scriptFor(name, stage, attempt, options, held) {
  const plan = planFor(name, options), output = plan.outputs[0], checker = plan.checks[0].command[1], bad = plan.checks[0].negative_controls[0].command[2];
  const report = (extra = {}) => call('assignment_report', { outcome: 'completed', summary: `${stage} completed with actual scoped artifacts.`,
    findings: [`Independent ${stage} result recorded.`], ...extra });
  if (stage === 'planning') return [call('project_list', { path: '.' }), call('workflow_plan', plan), report()];
  if (stage === 'implementation') {
    const value = options.productFailure && attempt === 1 ? '2\n' : '1\n';
    return [call('project_read', { path: output }), call('task_file_write', { path: output, content: value }),
      ...(options.holdImplementation && attempt === 1 ? [async ({ token }) => {
        held.entered = true;
        while (!token.isCancellationRequested && !held.release) await delay(10);
        return new Text('Canceled deterministic model fixture.');
      }] : []), report({ artifacts: [output] })];
  }
  if (stage === 'verification') {
    const wrongChecker = options.checkerFailure && attempt === 1;
    const content = options.exitZeroChecker ? 'process.exit(0);\n'
      : `const assert=require('node:assert/strict'); const fs=require('node:fs'); assert.equal(Number(fs.readFileSync(process.argv[2],'utf8')),${wrongChecker ? 2 : 1}); console.log('scalar validated');\n`;
    const defect = wrongChecker || options.productFailure && attempt === 1;
    return [call('project_read', { path: output }), call('project_read', { path: checker }), call('task_file_write', { path: checker, content }),
      call('project_read', { path: bad }), call('task_file_write', { path: bad, content: '2\n' }), call('check_run', {}),
      report({ outcome: defect ? 'failed' : 'completed', verdict: defect ? 'fail' : 'pass', artifacts: [output, checker, bad],
        negative_controls: ['The prescribed incorrect scalar fixture must exit one.'],
        ...(defect ? { failure_kind: wrongChecker ? 'checker' : 'implementation' } : {}) })];
  }
  if (stage === 'review') return [call('project_read', { path: output }), call('project_read', { path: checker }),
    report({ verdict: 'pass', artifacts: [output, checker, bad] })];
  if (stage === 'diagnosis') return [call('project_read', { path: checker }), report({ failure_kind: 'checker' })];
  throw new Error(`Unexpected fixture stage ${stage}`);
}

async function setup(t, scenarios) {
  const parent = realpathSync(tmpdir()), root = realpathSync(mkdtempSync(join(parent, 'neomind-controlled-flow-')));
  initialize(root, { project_id: 'CONTROLLED', name: 'Controlled Bridge fixture', platforms: ['codex', 'copilot'], max_workers: 3, repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: [...policy.worker_models, 'next-worker'].map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  const conversations = new WeakMap(), counts = new Map(), observed = [], errors = [], held = { entered: false };
  const api = {
    version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (messages, options, token) => {
      assertSemanticSchemas(options.tools);
      let conversation = conversations.get(messages);
      if (!conversation) {
        const text = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const name = /Scenario: ([a-z0-9-]+)/.exec(text)?.[1], stage = /Your stage: (planning|implementation|verification|review|diagnosis)/.exec(text)?.[1];
        assert.ok(name && stage, 'controller must provide meaningful stage/request context');
        const key = `${name}:${stage}`, attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt);
        conversation = { name, stage, attempt, actions: scriptFor(name, stage, attempt, scenarios[name] ?? {}, held), round: 0 };
        conversations.set(messages, conversation);
        observed.push({ name, stage, attempt, tools: options.tools.map(tool => tool.name) });
      }
      const prior = lastToolResult(messages);
      if (prior?.isError) {
        errors.push({ name: conversation.name, stage: conversation.stage, round: conversation.round, result: prior });
        throw new Error('Deterministic fixture encountered a failed semantic MCP call.');
      }
      const action = conversation.actions[conversation.round++];
      let part = action ? typeof action === 'function' ? await action({ token, messages })
        : new Call(`fixture-call-${conversation.round}`, action.name, action.input) : new Text('Typed result persisted; deterministic fixture session complete.');
      return { stream: (async function* () { yield part; })() };
    } }] },
  };
  let bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, observed, errors, held, restart: async () => {
    await owner.close(); await shutdownNative(root); await bridge.close();
    bridge = await enableVSCodeHost(api, root); owner = await startControlledHost(root);
  } };
}
async function until(root, workflow, predicate, message, errors = []) {
  const deadline = Date.now() + 60000;
  let snapshot;
  do {
    snapshot = controlledStatus(root, workflow);
    if (predicate(snapshot)) return snapshot;
    if (snapshot.status === 'blocked') assert.fail(`${message}: ${JSON.stringify({ blocker: snapshot.blocker, phase: snapshot.phase,
      attempts: snapshot.attempts.map(attempt => ({ stage: attempt.stage, state: attempt.state, outcome: attempt.report?.outcome })),
      checks: snapshot.checks.map(check => ({ title: check.title, passed: check.passed, exit_code: check.exit_code })), events: snapshot.events.slice(-5), errors })}`);
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify({ status: snapshot.status, phase: snapshot.phase, errors })}`);
}
const submit = (root, name) => startControlledWorkflow(root, { requirement: `Scenario: ${name}\nCreate and independently verify the requested scalar.`, request_id: `fixture-${name}` });

test('controlled execution mode is explicit and distinct from unsigned native modes', () => {
  assert.ok(executionModes.includes('neomind-controlled'));
});

test('real signed Bridge/MCP drives normal and risk-based workflows with actual command evidence', async t => {
  const env = await setup(t, { ordinary: {}, sensitive: { highRisk: true } });
  for (const name of ['ordinary', 'sensitive']) {
    const initial = await submit(env.root, name);
    assert.ok(initial.workflow_id); assert.equal(initial.process_contract, 'software-tools/v2');
    const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'workflow should complete', env.errors);
    assert.deepEqual(done.attempts.map(attempt => attempt.stage), name === 'ordinary'
      ? ['planning', 'implementation', 'verification'] : ['planning', 'implementation', 'verification', 'review']);
    assert.equal(new Set(done.attempts.map(attempt => attempt.invocation_id)).size, done.attempts.length);
    for (const attempt of done.attempts) {
      const receipt = readInvocation(env.root, attempt.invocation_id);
      assert.equal(receipt.issuer, 'neomind-vscode-lm'); assert.equal(receipt.inference_completed, true);
      assert.ok(!receipt.native_tool_scope.some(name => ['assignment_open', 'assignment_progress', 'record_update'].includes(name)));
    }
    assert.ok(done.checks.length >= 2, 'actual positive and negative command receipts are required');
    assert.ok(done.checks.every(check => check.passed));
    assert.ok(done.checks.some(check => check.exit_code === 1), 'negative control must execute and reject the bad fixture');
    for (const check of done.checks) assert.equal(hash(readFileSync(join(env.root, check.log_path))), check.log_sha256);
    assert.equal(getRecord(env.root, done.workflow_id).meta.data.phase, 'completed');
    assert.equal(getRecord(env.root, done.final_report_id).meta.data.assurance, 'invocation-bound-local');
    const repeated = await submit(env.root, name);
    assert.equal(repeated.workflow_id, done.workflow_id); assert.equal(repeated.attempts.length, done.attempts.length);
  }
  assert.equal(env.errors.length, 0);
});

test('product and checker defects route repairs to the correct bounded stage', async t => {
  const env = await setup(t, { product: { productFailure: true }, checker: { checkerFailure: true } });
  for (const name of ['product', 'checker']) {
    const initial = await submit(env.root, name);
    const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'repair should complete', env.errors);
    assert.equal(done.repairs, 1);
    assert.deepEqual(done.attempts.map(attempt => attempt.stage), name === 'product'
      ? ['planning', 'implementation', 'verification', 'implementation', 'verification']
      : ['planning', 'implementation', 'verification', 'verification']);
    assert.ok(done.checks.some(check => !check.passed));
    const lastVerifier = done.attempts.filter(attempt => attempt.stage === 'verification').at(-1);
    assert.ok(done.checks.filter(check => check.attempt_id === lastVerifier.id).every(check => check.passed));
  }
  assert.equal(env.errors.length, 0);
});

test('prose claims and an always-exit-zero checker cannot close a controlled workflow', async t => {
  const env = await setup(t, { falseproof: { exitZeroChecker: true } });
  const initial = await submit(env.root, 'falseproof');
  const done = await until(env.root, initial.workflow_id, run => ['blocked', 'uncertain'].includes(run.status), 'false evidence must be rejected', env.errors);
  assert.notEqual(done.status, 'completed'); assert.equal(done.final_report_id, undefined);
  assert.ok(done.checks.some(check => !check.passed));
  assert.notEqual(getRecord(env.root, initial.workflow_id).meta.data.phase, 'completed');
});

test('pause and owner restart retain checkpoint artifacts and resume the same workflow', async t => {
  const env = await setup(t, { resumed: { holdImplementation: true } });
  const initial = await submit(env.root, 'resumed');
  await until(env.root, initial.workflow_id, () => env.held.entered, 'implementation should reach the controlled pause point', env.errors);
  const paused = await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'pause' });
  assert.equal(paused.status, 'paused');
  assert.equal(readFileSync(join(env.root, 'resumed/src/value.txt'), 'utf8'), '1\n');
  assert.equal(paused.final_report_id, undefined);
  await env.restart();
  await controlControlledWorkflow(env.root, { workflow_id: initial.workflow_id, action: 'resume' });
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'checkpoint should resume', env.errors);
  assert.equal(done.workflow_id, initial.workflow_id);
  assert.equal(done.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
  assert.ok(done.attempts.some(attempt => attempt.state === 'interrupted'));
  assert.equal(loadRecords(env.root).filter(record => record.meta.data.kind === 'manager-workflow').length, 1);
});

test('parallel workflows retain their own tasks, artifacts, reports and receipt correlations', async t => {
  const env = await setup(t, { left: {}, right: {} });
  const initial = await Promise.all([submit(env.root, 'left'), submit(env.root, 'right')]);
  assert.notEqual(initial[0].workflow_id, initial[1].workflow_id);
  const done = await Promise.all(initial.map(run => until(env.root, run.workflow_id, value => value.status === 'completed', 'parallel workflow should complete', env.errors)));
  for (const run of done) for (const attempt of run.attempts) {
    assert.equal(readInvocation(env.root, attempt.invocation_id).workflow_id, run.workflow_id);
    assert.equal(getRecord(env.root, attempt.report_id).meta.data.workflow_id, run.workflow_id);
  }
  assert.notEqual(done[0].final_report_id, done[1].final_report_id);
  assert.equal(env.errors.length, 0);
});

test('changing a controlled role model affects the next invocation without invalidating current receipt evidence', async t => {
  const env = await setup(t, { frozen: { holdImplementation: true } });
  const initial = await submit(env.root, 'frozen');
  const running = await until(env.root, initial.workflow_id, () => env.held.entered, 'producer should be active', env.errors);
  const old = readInvocation(env.root, running.attempts.at(-1).invocation_id);
  setRoleModel(env.root, { role: 'developer', model: 'next-worker', provider: 'fixture-worker' });
  const map = readAgentMap(env.root), current = map.nodes.find(node => node.invocation_id === old.id);
  assert.equal(current.source, 'controlled-runtime'); assert.equal(current.state, 'running');
  assert.ok(map.edges.some(edge => edge.kind === 'handoff' && edge.to === current.id && edge.source === 'controlled-runtime'));
  env.held.release = true;
  const done = await until(env.root, initial.workflow_id, run => run.status === 'completed', 'policy update must preserve active provenance', env.errors);
  assert.equal(readInvocation(env.root, old.id).requested_model, old.requested_model);
  assert.equal(done.status, 'completed');
});
