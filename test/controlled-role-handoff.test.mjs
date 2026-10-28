// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWrite, getRecord, hash, loadRecords, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { controlledRepairBudget, startControlledHost, startControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';
import { verify } from '../dist/engineering.js';

class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (name, input) => ({ name, input });

test('exact legacy repair events separate reconciliation from product usage; unknown usage stays conservative', () => {
  const events = [{ kind: 'repair', summary: 'Backend routes environment to implementation.' }], before = structuredClone(events);
  assert.deepEqual(controlledRepairBudget({ repairs: 1, events }), { schema_version: 1, product: 0, protocol: 0, environment: 1 });
  assert.deepEqual(events, before, 'Migration derives facts without rewriting saved history.');
  assert.deepEqual(controlledRepairBudget({ repairs: 2, events }), { schema_version: 1, product: 1, protocol: 0, environment: 1 });
  const product = [...events, { kind: 'repair', summary: 'Backend routes implementation to implementation.' }, { kind: 'repair', summary: 'Backend routes checker to verification.' }];
  assert.equal(controlledRepairBudget({ repairs: 3, events: product }).product, 2, 'Product and checker usage share one counter.');
  assert.equal(controlledRepairBudget({ repairs: 1, events: [{ kind: 'repair', summary: 'environment fixed maybe' }] }).product, 1);
});

async function fixture(t, options = {}) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-role-handoff-')));
  initialize(root, { project_id: 'HANDOFF', platforms: ['copilot'], max_workers: 3, repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, vscode_effort_policy: 'allow-unavailable' }));
  const plan = { title: 'Produce a bounded scalar', objective: 'Save the scalar one and verify its value independently.', rationale: 'A small local scalar delivery with disjoint producer and checker ownership.',
    acceptance_criteria: ['The saved scalar is integer one.', 'The independent checker rejects integer two.'],
    allowed_paths: ['source/value.txt'], verification_paths: ['checks'], outputs: ['source/value.txt'], documentation_paths: [], risk: 'low',
    checks: [{ title: 'Check scalar', command: [process.execPath, 'checks/check.cjs', 'source/value.txt'], baseline_paths: ['source/value.txt', 'checks/check.cjs'],
      negative_controls: [{ title: 'Reject incorrect scalar', command: [process.execPath, 'checks/check.cjs', 'checks/bad.txt'], baseline_paths: ['checks/check.cjs', 'checks/bad.txt'], expected_exit_code: 1 }] }] };
  const state = () => {
    const workflow = loadRecords(root).find(record => record.meta.data.kind === 'manager-workflow');
    return JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(workflow.meta.id)}.json`), 'utf8'));
  };
  const saveState = value => atomicWrite(safePath(root, `.neomind/controlled/workflows/${hash(value.workflow_id)}.json`), JSON.stringify(value, null, 2));
  const conversations = new WeakMap(), counts = new Map(), denials = [];
  const actions = (stage, attempt) => {
    const report = extra => call('assignment_report', { outcome: 'completed', summary: `${stage} saved its honest own-scope result.`, ...extra });
    if (stage === 'planning') return [call('workflow_plan', plan), report({})];
    if (stage === 'implementation') {
      const denied = attempt === 1 || options.repeat;
      return [call('project_read', { path: 'source/value.txt' }),
        ...(attempt === 1 || attempt >= 3 || options.explicitProduct ? [call('task_file_write', { path: 'source/value.txt', content: (options.product || options.explicitProduct) && attempt === 1 ? '2\n' : '1\n' })] : []),
        ...(denied ? [call('task_file_write', { path: 'checks/check.cjs', content: 'Producer must never own this checker.\n' })] : []),
        report({ outcome: denied ? 'blocked' : 'completed', artifacts: ['source/value.txt'],
          ...(denied ? { findings: ['The producer files are saved. Independent verification has not run.'],
            ...(options.explicitProduct ? { failure_kind: 'implementation' } : {}) } : {}) })];
    }
    if (stage === 'verification') return [call('project_read', { path: 'checks/check.cjs' }),
      call('task_file_write', { path: 'checks/check.cjs', content: "const fs=require('node:fs');process.exit(Number(fs.readFileSync(process.argv[2],'utf8'))===1?0:1);\n" }),
      call('project_read', { path: 'checks/bad.txt' }), call('task_file_write', { path: 'checks/bad.txt', content: '2\n' }), call('check_run', {}),
      report({ outcome: options.product && attempt === 1 ? 'failed' : 'completed', verdict: options.product && attempt === 1 ? 'fail' : 'pass',
        ...(options.product && attempt === 1 ? { failure_kind: 'implementation' } : {}), artifacts: ['source/value.txt', 'checks/check.cjs', 'checks/bad.txt'] })];
    throw new Error(`Unexpected diagnostic stage ${stage}`);
  };
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async messages => {
      let conversation = conversations.get(messages);
      if (!conversation) {
        const prompt = messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
        const stage = /Your stage: (planning|implementation|verification|review|diagnosis)/.exec(prompt)?.[1];
        assert.ok(stage); const attempt = (counts.get(stage) ?? 0) + 1; counts.set(stage, attempt);
        conversation = { stage, attempt, actions: actions(stage, attempt), round: 0 }; conversations.set(messages, conversation);
      }
      const result = messages.at(-1)?.content?.[0];
      const prior = result instanceof Result ? JSON.parse(result.content[0].value) : null;
      if (prior?.isError) {
        const error = JSON.parse(prior.content[0].text);
        assert.equal(error.code, 'SCOPE_DENIED'); denials.push(error);
        if (options.legacy && conversation.attempt === 1) {
          const saved = state(); delete saved.repair_budget; saved.repairs = 1;
          saved.events.push({ id: randomUUID(), at: new Date().toISOString(), kind: 'repair', stage: 'implementation', summary: 'Backend routes environment to implementation.' });
          saveState(saved); // Fault injection of a known pre-split saved counter.
          for (const name of readdirSync(safePath(root, '.neomind/controlled/traces'))) {
            const path = `.neomind/controlled/traces/${name}`, trace = JSON.parse(readFileSync(safePath(root, path), 'utf8'));
            if (trace.attempt_id === saved.attempts.at(-1).id && trace.event === 'tool-result' && trace.code === 'SCOPE_DENIED') {
              for (const key of ['rule', 'target_owner', 'target_path', 'ownership', 'validation', 'backend_binding', 'request_sha256']) delete trace[key];
              atomicWrite(safePath(root, path), JSON.stringify(trace)); // Actual-shaped 2f result; the bound request stays intact.
            }
          }
        }
      }
      const action = conversation.actions[conversation.round++];
      return { stream: (async function* () { yield action ? new Call(`handoff-${conversation.round}`, action.name, action.input) : new Text('Own typed result persisted.'); })() };
    } }] } };
  const bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, denials, counts };
}
async function terminal(root, id) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const run = controlledStatus(root, id);
    if (['completed', 'blocked', 'uncertain'].includes(run.status)) return run;
    await delay(100);
  }
  assert.fail(`Handoff workflow did not reach a terminal checkpoint: ${JSON.stringify(controlledStatus(root, id))}`);
}

test('actual legacy scope denial schedules one honest producer followup, then independent verification and one product repair', async t => {
  const a = await fixture(t, { legacy: true, product: true });
  const receipt = await startControlledWorkflow(a.root, { requirement: 'Deliver integer one with independent positive and negative checking.', request_id: 'legacy-role-handoff' });
  const run = await terminal(a.root, receipt.workflow_id);
  assert.equal(run.status, 'completed', JSON.stringify(run.blocker));
  assert.equal(run.role_handoff.legacy_trace, true); assert.equal(run.repair_budget.protocol, 1); assert.equal(run.repair_budget.environment, 1);
  assert.equal(run.repairs, 1); assert.equal(run.repair_budget.product, 1); assert.equal(run.repair_counter_migration.legacy_count, 1);
  assert.equal(run.attempts[1].report.outcome, 'blocked', 'The original partial result is retained, never rewritten to completed.');
  assert.equal(getRecord(a.root, run.attempts[1].report_id).meta.data.outcome, 'blocked');
  assert.deepEqual(run.attempts.map(attempt => attempt.stage), ['planning', 'implementation', 'implementation', 'verification', 'implementation', 'verification']);
  const task = loadRecords(a.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === run.epoch_id);
  assert.equal(verify(a.root, task.meta.id, 'accepted').ok, true);
  assert.equal(a.denials.length, 1); assert.equal(a.counts.get('verification'), 2);
});

test('repeated verified role-handoff misunderstanding stops after one protocol reconciliation without submitting the producer', async t => {
  const a = await fixture(t, { repeat: true });
  const receipt = await startControlledWorkflow(a.root, { requirement: 'Deliver integer one with separate producer and independent checker ownership.', request_id: 'bounded-role-handoff' });
  const run = await terminal(a.root, receipt.workflow_id);
  assert.equal(run.status, 'blocked'); assert.match(run.blocker.message, /Protocol reconciliation budget exhausted/);
  assert.equal(run.repair_budget.protocol, 1); assert.equal(run.repairs, 0); assert.equal(a.counts.get('implementation'), 2);
  assert.equal(a.counts.get('verification'), undefined); assert.equal(run.final_report_id, undefined);
  const task = loadRecords(a.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === run.epoch_id);
  assert.notEqual(task.meta.status, 'submitted'); assert.notEqual(task.meta.status, 'accepted');
  assert.equal(run.attempts.filter(attempt => attempt.stage === 'implementation').every(attempt => attempt.report.outcome === 'blocked'), true);
});

test('explicit product failure is not reclassified as protocol even with a genuine verifier-scope denial', async t => {
  const a = await fixture(t, { explicitProduct: true });
  const receipt = await startControlledWorkflow(a.root, { requirement: 'Deliver integer one with independent checking.', request_id: 'explicit-product-not-handoff' });
  const run = await terminal(a.root, receipt.workflow_id);
  assert.equal(run.status, 'completed', JSON.stringify(run.blocker));
  assert.equal(run.role_handoff, undefined);
  assert.equal(run.repair_budget.product, 1); assert.equal(run.repair_budget.protocol, 0);
  assert.equal(run.attempts[1].report.failure_kind, 'implementation');
  assert.equal(run.attempts[1].report.outcome, 'blocked', 'Original failure remains retained and unsubmitted.');
  assert.equal(a.denials.length, 1); assert.equal(a.counts.get('implementation'), 2); assert.equal(a.counts.get('verification'), 1);
  const task = loadRecords(a.root).find(record => record.meta.type === 'task' && record.meta.data.epoch_id === run.epoch_id);
  assert.equal(verify(a.root, task.meta.id, 'accepted').ok, true);
});
