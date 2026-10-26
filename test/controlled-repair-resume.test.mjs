import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite, getRecord, hash, initialize, loadRecords, readConfig, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { controlControlledWorkflow, controlledStatus, startControlledHost, startControlledWorkflow } from '../dist/controlled-workflow.js';
import { verify } from '../dist/engineering.js';

// Real signed Bridge/MCP and child commands; deterministic model/editor fixtures.
class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (name, input) => ({ name, input });
const product = 'source/value.json', checker = 'checks/check.cjs', wrong = 'checks/wrong.json';
async function fixture(t, checkerFailure = false) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-repair-resume-')));
  initialize(root, { project_id: 'RESUME-REPAIR', platforms: ['copilot'], repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: policy.worker_models.map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  const plan = { title: 'Scalar with independently reviewed marker', objective: 'Save JSON value one with a marker independently reviewed as true.',
    rationale: 'Value assertions and independent marker review exercise distinct bounded obligations.',
    acceptance_criteria: ['The JSON value is one.', 'The independent Reviewer observes marker true.'],
    allowed_paths: [product], verification_paths: ['checks'], outputs: [product], documentation_paths: [], risk: 'elevated',
    checks: [{ title: 'Value assertion', command: [process.execPath, checker, product], baseline_paths: [product, checker],
      negative_controls: [{ title: 'Wrong value rejected', command: [process.execPath, checker, wrong], baseline_paths: [checker, wrong], expected_exit_code: 1 }] }] };
  const counts = new Map(), stages = [], conversations = new WeakMap();
  let holdEntered = false;
  const report = extra => call('assignment_report', { outcome: 'completed', summary: 'Bounded own-scope result.', ...extra });
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (messages, _options, token) => {
      let state = conversations.get(messages);
      if (!state) {
        const prompt = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const stage = /Your stage: (planning|implementation|verification|review)/.exec(prompt)?.[1]; assert.ok(stage);
        const attempt = (counts.get(stage) ?? 0) + 1; counts.set(stage, attempt); stages.push(stage);
        let actions;
        if (stage === 'planning') actions = [call('workflow_plan', plan), report({})];
        else if (stage === 'implementation') actions = [call('project_read', { path: product }),
          call('task_file_write', { path: product, content: JSON.stringify({ value: 1, marker: checkerFailure || attempt >= 3 }) }), report({ artifacts: [product] })];
        else if (stage === 'verification') actions = [call('project_read', { path: checker }),
          call('task_file_write', { path: checker, content: `const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.equal(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).value,${checkerFailure && attempt <= 2 ? 2 : 1});\n` }),
          call('project_read', { path: wrong }), call('task_file_write', { path: wrong, content: '{"value":2,"marker":true}' }), call('check_run', {}),
          report({ verdict: checkerFailure && attempt <= 2 ? 'fail' : 'pass',
            ...(checkerFailure && attempt <= 2 ? { failure_kind: 'checker', summary: 'Checker expectation is incorrect; completed inspection reports a failing verdict.' } : {}) })];
        else actions = [call('project_read', { path: product }), prior => {
          const current = JSON.parse(JSON.parse(prior.content[0].text).text);
          return report(current.marker ? { verdict: 'pass' } : { outcome: 'failed', verdict: 'fail', failure_kind: 'implementation', summary: 'Independent Reviewer observed marker false; implementation repair is required.' });
        }];
        state = { stage, attempt, actions, round: 0 }; conversations.set(messages, state);
      }
      const result = messages.at(-1)?.content?.[0], prior = result instanceof Result ? JSON.parse(result.content[0].value) : null;
      assert.ok(!prior?.isError, JSON.stringify(prior));
      if (checkerFailure && state.stage === 'verification' && state.attempt === 3) {
        holdEntered = true; while (!token.isCancellationRequested) await delay(20);
        return { stream: (async function* () { yield new Text('Cancelled after observing the resumed checker ownership.'); })() };
      }
      const next = state.actions[state.round++], action = typeof next === 'function' ? next(prior) : next;
      return { stream: (async function* () { yield action ? new Call(`repair-${state.round}`, action.name, action.input) : new Text('Typed result saved.'); })() };
    } }] } };
  const bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, stages, counts, holdEntered: () => holdEntered };
}
async function until(root, id, predicate) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { const run = controlledStatus(root, id); if (predicate(run)) return run; await delay(30); }
  assert.fail(JSON.stringify(controlledStatus(root, id)));
}
function increase(root) {
  atomicWrite(safePath(root, '.neomind/config.json'), JSON.stringify({ ...readConfig(root), repair_attempts: 3 }));
}

test('public resume keeps exhausted policy blocked, then charges one newly authorized repair and dispatches Producer directly', async t => {
  const a = await fixture(t), first = await startControlledWorkflow(a.root, { requirement: 'Deliver a reviewed scalar marker.', request_id: 'resume-exhausted-product' });
  const blocked = await until(a.root, first.workflow_id, run => run.status === 'blocked');
  assert.match(blocked.blocker.message, /^Product\/checker repair budget exhausted\./);
  assert.equal(blocked.phase, 'review'); assert.equal(blocked.repair_budget.product, 1);
  const history = structuredClone(blocked.attempts), stageCount = a.stages.length;
  const contractPath = safePath(a.root, `.neomind/controlled/workflows/${hash(first.workflow_id)}.${blocked.epoch_id}.contract.json`);
  const contractBytes = readFileSync(contractPath);
  const refused = await controlControlledWorkflow(a.root, { workflow_id: first.workflow_id, action: 'resume' });
  assert.equal(refused.status, 'blocked'); assert.equal(refused.repair_budget.product, 1);
  await delay(100); assert.equal(a.stages.length, stageCount, 'Unchanged exhausted policy never dispatches another model.');
  increase(a.root);
  const resumed = await controlControlledWorkflow(a.root, { workflow_id: first.workflow_id, action: 'resume' });
  assert.equal(resumed.phase, 'implementation'); assert.equal(resumed.repair_budget.product, 2);
  assert.equal(resumed.blocker.kind, 'implementation');
  assert.match(resumed.blocker.message, /marker false/);
  const done = await until(a.root, first.workflow_id, run => ['completed', 'blocked'].includes(run.status));
  assert.equal(done.status, 'completed', JSON.stringify(done.blocker));
  assert.deepEqual(a.stages.slice(stageCount), ['implementation', 'verification', 'review']);
  assert.equal(done.repairs, 2); assert.equal(done.repair_budget.product, 2);
  assert.deepEqual(done.attempts.slice(0, history.length), history, 'Completed rejected attempts and their reports remain unchanged.');
  assert.deepEqual(readFileSync(contractPath), contractBytes);
  const task = loadRecords(a.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === done.epoch_id);
  assert.equal(verify(a.root, task.meta.id, 'accepted').ok, true);
  for (const attempt of done.attempts.slice(history.length)) assert.equal(readInvocation(a.root, attempt.invocation_id).inference_completed, true);
});

test('completed Verifier with failing verdict resumes its matching checker repair and retains prior product usage', async t => {
  const a = await fixture(t, true), first = await startControlledWorkflow(a.root, { requirement: 'Deliver a reviewed scalar marker.', request_id: 'resume-exhausted-checker' });
  const blocked = await until(a.root, first.workflow_id, run => run.status === 'blocked');
  assert.equal(blocked.phase, 'verification'); assert.equal(blocked.repair_budget.product, 1);
  assert.equal(blocked.attempts.at(-1).report.outcome, 'completed'); assert.equal(blocked.attempts.at(-1).report.verdict, 'fail');
  const stages = a.stages.length, history = structuredClone(blocked.attempts);
  assert.equal((await controlControlledWorkflow(a.root, { workflow_id: first.workflow_id, action: 'resume' })).status, 'blocked');
  await delay(100); assert.equal(a.stages.length, stages);
  increase(a.root);
  const resumed = await controlControlledWorkflow(a.root, { workflow_id: first.workflow_id, action: 'resume' });
  assert.equal(resumed.phase, 'verification'); assert.equal(resumed.repair_budget.product, 2);
  await until(a.root, first.workflow_id, () => a.holdEntered());
  assert.deepEqual(a.stages.slice(stages), ['verification']);
  const current = controlledStatus(a.root, first.workflow_id);
  assert.deepEqual(current.attempts.slice(0, history.length), history);
  assert.equal(current.repair_budget.product, 2);
});
