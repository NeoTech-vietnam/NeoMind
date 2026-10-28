// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWrite, hash, loadRecords, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { controlledPlanConflicts } from '../dist/controlled-plan-queue.js';
import { controlledStatus, startControlledHost, startControlledWorkflow, controlControlledWorkflow } from '../dist/controlled-workflow.js';

class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const proposed = () => ({ title: 'Read a stable completed producer', objective: 'Preserve the completed shared input and deliver another scalar.',
  rationale: 'A frozen reader must not capture an active writer midway through its assignment.', acceptance_criteria: ['The shared input stays unchanged during this task.'],
  allowed_paths: ['reader/value.txt'], verification_paths: ['reader-checks'], outputs: ['reader/value.txt'], documentation_paths: [],
  preservation_paths: ['shared'], execution_steps: [], risk: 'low', checks: [{ title: 'Independent reader check',
    command: [process.execPath, 'reader-checks/check.cjs', 'reader/value.txt'], baseline_paths: ['shared/value.txt'],
    negative_controls: [{ title: 'Reject wrong reader', command: [process.execPath, 'reader-checks/check.cjs', 'reader-checks/bad.txt'], expected_exit_code: 1 }] }] });

async function fixture(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-plan-scope-queue-')));
  initialize(root, { project_id: 'PLAN-QUEUE', platforms: ['copilot'], repair_attempts: 1 });
  atomicWrite(safePath(root, 'shared/value.txt'), 'before owner completion\n');
  const writer = { workflow_id: 'FIXTURE-WRITER', epoch_id: randomUUID(), status: 'running', phase: 'implementation' };
  const writerPlan = { allowed_paths: ['shared'], verification_paths: ['writer-checks'] };
  const writerContract = { workflow_id: writer.workflow_id, epoch_id: writer.epoch_id, plan: writerPlan, plan_hash: hash(JSON.stringify(writerPlan)) };
  const writerBytes = JSON.stringify(writerContract); writer.contract_hash = hash(writerBytes);
  const writerPath = safePath(root, `.neomind/controlled/workflows/${hash(writer.workflow_id)}.json`);
  const contractPath = safePath(root, `.neomind/controlled/workflows/${hash(writer.workflow_id)}.${writer.epoch_id}.contract.json`);
  atomicWrite(writerPath, JSON.stringify(writer)); atomicWrite(contractPath, writerBytes);
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, 'catalog.json'), JSON.stringify([
    { name: 'fixture-strong', vendor: 'fixture-strong', models: [{ id: policy.strong_model, name: policy.strong_model }] },
    { name: 'fixture-worker', vendor: 'fixture-worker', models: policy.worker_models.map(id => ({ id, name: id })) },
  ]));
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, language_models_file: 'catalog.json',
    strong_provider: 'fixture-strong', worker_provider: 'fixture-worker', vscode_effort_policy: 'allow-unavailable' }));
  const conversations = new WeakMap(), errors = [], stages = []; let planningRequests = 0;
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result, LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (messages, _options, token) => {
      let state = conversations.get(messages);
      if (!state) { const text = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const stage = /Your stage: (planning|implementation)/.exec(text)?.[1]; assert.ok(stage); state = { stage, round: 0 }; conversations.set(messages, state); stages.push(stage); }
      if (state.stage === 'implementation') return { stream: (async function* () { while (!token.isCancellationRequested) await delay(10); })() };
      planningRequests++;
      const previous = messages.at(-1)?.content?.[0];
      if (previous instanceof Result) { const value = JSON.parse(previous.content[0].value); if (value.isError) { errors.push(value); throw new Error('Queue fixture semantic input failed.'); } }
      const round = state.round++;
      const part = round === 0 ? new Call('queue-plan', 'workflow_plan', proposed())
        : round === 1 ? new Call('queue-report', 'assignment_report', { outcome: 'completed', summary: 'The bounded plan is saved; runtime owns waiting and fresh freezing.' })
          : new Text('Completed Coordinator result retained; no polling is needed.');
      return { stream: (async function* () { yield part; })() };
    } }] } };
  let bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  const stop = async () => { await owner.close(); await shutdownNative(root); await bridge.close(); };
  t.after(async () => { await stop(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const initial = await startControlledWorkflow(root, { requirement: 'Read only the stable completed shared producer, then deliver a separate scalar.', request_id: 'queued-reader' });
  const until = async predicate => { const deadline = Date.now() + 60000; do { const run = controlledStatus(root, initial.workflow_id);
    if (predicate(run)) return run;
    if (['blocked', 'uncertain'].includes(run.status)) assert.fail(JSON.stringify({ blocker: run.blocker, errors }));
    await delay(30);
  } while (Date.now() < deadline); assert.fail('Scope queue did not reach the expected state.'); };
  return { root, initial, writer, writerPath, contractPath, stages, errors, until, planningRequests: () => planningRequests,
    finishWriter: () => { atomicWrite(safePath(root, 'shared/value.txt'), 'fresh completed owner bytes\n');
      atomicWrite(writerPath, JSON.stringify({ ...writer, status: 'completed', phase: 'completed' })); },
    restart: async () => { await stop(); bridge = await enableVSCodeHost(api, root); owner = await startControlledHost(root); } };
}

test('actual signed Coordinator waits without a task/model polling and freezes fresh hashes after the writer completes', async t => {
  const a = await fixture(t), waiting = await a.until(run => run.status === 'waiting');
  assert.equal(waiting.contract_hash, undefined); assert.equal(waiting.pending_plan.conflicts[0].workflow_id, a.writer.workflow_id);
  assert.equal(loadRecords(a.root).filter(record => record.meta.type === 'task').length, 0);
  const planner = waiting.attempts[0], calls = a.planningRequests();
  assert.equal(planner.report.outcome, 'completed'); assert.equal(readInvocation(a.root, planner.invocation_id).inference_completed, true);
  await delay(1200); assert.equal(a.planningRequests(), calls, 'Backend scope waiting must not ask the model to poll.');
  a.finishWriter(); const running = await a.until(run => run.phase === 'implementation' && run.attempts.at(-1)?.state === 'running');
  const frozen = JSON.parse(readFileSync(safePath(a.root, `.neomind/controlled/workflows/${hash(initialId(a))}.${running.epoch_id}.contract.json`), 'utf8'));
  assert.equal(frozen.preserved_hashes['shared/value.txt'], hash('fresh completed owner bytes\n'));
  assert.equal(running.pending_plan, undefined); assert.equal(running.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
  assert.equal(running.attempts[0].report_id, planner.report_id); assert.equal(running.attempts[0].report_fingerprint, planner.report_fingerprint);
  assert.equal(a.planningRequests(), calls); assert.equal(running.repairs, 0); assert.deepEqual(a.errors, []);
});
const initialId = fixture => fixture.initial.workflow_id;

test('cancelling a queued plan preserves its Coordinator result and never freezes after the owner finishes', async t => {
  const a = await fixture(t), waiting = await a.until(run => run.status === 'waiting');
  const cancelled = await controlControlledWorkflow(a.root, { workflow_id: initialId(a), action: 'cancel' });
  a.finishWriter(); await delay(1200);
  const after = controlledStatus(a.root, initialId(a)); assert.equal(cancelled.status, 'cancelled'); assert.equal(after.status, 'cancelled');
  assert.equal(after.contract_hash, undefined); assert.equal(after.attempts[0].report_id, waiting.attempts[0].report_id);
  assert.equal(loadRecords(a.root).filter(record => record.meta.type === 'task').length, 0);
});

test('waiting survives owner restart and explicit resume without replacing its completed Coordinator', async t => {
  const a = await fixture(t), waiting = await a.until(run => run.status === 'waiting'), calls = a.planningRequests();
  await a.restart(); await controlControlledWorkflow(a.root, { workflow_id: initialId(a), action: 'resume' });
  await a.until(run => run.status === 'waiting'); a.finishWriter();
  const running = await a.until(run => run.phase === 'implementation' && run.attempts.at(-1)?.state === 'running');
  assert.equal(a.planningRequests(), calls); assert.equal(running.attempts[0].report_id, waiting.attempts[0].report_id);
  assert.equal(running.attempts.filter(attempt => attempt.stage === 'planning').length, 1);
});

test('scope conflict detection ignores blocked completed history and unfrozen proposals but retains unresolved process effects', async t => {
  const a = await fixture(t); await a.until(run => run.status === 'waiting');
  assert.equal(controlledPlanConflicts(a.root, initialId(a), proposed()).length, 1);
  atomicWrite(a.writerPath, JSON.stringify({ ...a.writer, status: 'blocked', phase: 'completed' }));
  assert.deepEqual(controlledPlanConflicts(a.root, initialId(a), proposed()), []);
  atomicWrite(a.writerPath, JSON.stringify({ ...a.writer, status: 'waiting', contract_hash: undefined, pending_plan: { plan: proposed() } }));
  assert.deepEqual(controlledPlanConflicts(a.root, initialId(a), proposed()), []);
  atomicWrite(a.writerPath, JSON.stringify({ ...a.writer, status: 'cancelled', local_executions: [{ state: 'running' }] }));
  assert.equal(controlledPlanConflicts(a.root, initialId(a), proposed()).length, 1);
});

test('a later writer also waits for an earlier active reader preservation, checker baseline or execution input', async t => {
  const a = await fixture(t); await a.until(run => run.status === 'waiting');
  const candidate = { ...proposed(), preservation_paths: [], allowed_paths: ['protected/input.txt'],
    verification_paths: ['later-checks'], outputs: ['protected/input.txt'], checks: [] };
  for (const reads of [{ preservation_paths: ['protected'] }, { input_paths: ['protected/input.txt'] },
    { checks: [{ baseline_paths: ['protected/input.txt'], negative_controls: [] }] },
    { execution_steps: [{ command: ['node', 'other/script.mjs'], input_paths: ['protected/input.txt'] }] }]) {
    const plan = { allowed_paths: ['unrelated-output'], verification_paths: ['unrelated-checks'], ...reads };
    const contract = { workflow_id: a.writer.workflow_id, epoch_id: a.writer.epoch_id, plan, plan_hash: hash(JSON.stringify(plan)) };
    const bytes = JSON.stringify(contract); atomicWrite(a.contractPath, bytes);
    atomicWrite(a.writerPath, JSON.stringify({ ...a.writer, contract_hash: hash(bytes) }));
    const conflicts = controlledPlanConflicts(a.root, initialId(a), candidate);
    assert.equal(conflicts.length, 1); assert.deepEqual(conflicts[0].paths, ['protected/input.txt']);
  }
});
