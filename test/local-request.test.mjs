import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeLocalRequestSchema, nativeRequestControlSchema } from '../dist/native-local-contract.js';
import * as nativeDomain from '../dist/native-request.js';
import { initialize, loadRecords } from '../dist/storage.js';

const require = createRequire(import.meta.url);
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const { nativeActivity } = require('../extensions/vscode-model-bridge/local-activity.cjs');
const roles = ['WF.FnD', 'WF.Reviewer', 'WF.Tester'];
const opaque = Object.freeze({ opaque: Symbol('host-issued invocation context') });
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = title => ({ requirement: `Implement ${title}`, title, context: [], plan: {
  summary: 'Use the existing project tools', requirements: ['Return a verified product'], design: 'Small existing module',
  outputs: ['product.mjs'], checks: [{ title: 'Existing tests', command: ['node', '--test', 'product.test.mjs'], level: 'unit' }],
} });
function cancellation() {
  const listeners = new Set();
  return { isCancellationRequested: false,
    onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    cancel() { this.isCancellationRequested = true; for (const listener of listeners) listener(); } };
}

function fixture(options = {}) {
  const states = new Map(), calls = [], trace = [], sources = [];
  let count = 0;
  const read = ref => { assert.ok(states.has(ref)); return states.get(ref); };
  const runtime = {
    nativeLocalRequestSchema,
    openNativeRequest(root, request) {
      assert.equal(root, '/project');
      const state = { request_ref: `private-request-${++count}`, request_key: `WF-R${count}`, title: request.title,
        status: 'planning', accepted: false, record_ids: ['private-record'], assignments: [], checks: [], artifacts: [] };
      states.set(state.request_ref, state); trace.push(['open', state.request_ref]); return clone(state);
    },
    planNativeRequest(_root, ref, plan) {
      const state = read(ref); state.plan = plan; state.status = 'working'; state.checks = plan.checks.map(check => ({ ...check, state: 'pending' }));
      if (options.skillContexts) state.skill_contexts = clone(options.skillContexts);
      trace.push(['plan', ref]); return clone(state);
    },
    nextNativeAssignment(_root, ref) {
      const state = read(ref), role = roles[state.assignments.length];
      if (options.noAssignment) return;
      const job = { assignment_ref: `${ref}-assignment-${role}`, agentName: role,
        prompt: `Private backend handoff for ${state.title}: ${role}`, description: `${state.title}: ${role}`, state: 'issued' };
      state.assignments.push(job); trace.push(['issue', ref, role]); return clone(job);
    },
    recordNativeResult(_root, packet) {
      const state = read(packet.request_ref), job = state.assignments.find(item => item.assignment_ref === packet.assignment_ref);
      assert.ok(job); assert.equal(packet.invocation.invoked, true); assert.equal(packet.invocation.tool, 'runSubagent');
      job.invocation = packet.invocation;
      let report;
      try { report = JSON.parse(packet.raw_result.content[0].value); } catch { /* Incomplete results are retained. */ }
      job.report = report;
      job.state = packet.invocation.status === 'cancelled' ? 'cancelled' : packet.invocation.status !== 'returned' || !report ? 'uncertain'
        : report.verdict === 'pass' && report.findings.length === 0 ? 'completed' : 'findings';
      state.status = job.state === 'completed' ? 'working' : job.state;
      if (job.agentName === 'WF.FnD') state.artifacts = [{ path: 'product.mjs', exists: true }];
      if (options.echoPrivate && report) report.summary += ` ${job.prompt} ${job.assignment_ref} ${packet.invocation.host_call_id}`;
      trace.push(['record', packet.request_ref, job.agentName]); return clone(state);
    },
    recordNativeDispatchFailure(_root, packet) {
      const state = read(packet.request_ref), job = state.assignments.find(item => item.assignment_ref === packet.assignment_ref);
      job.state = packet.category === 'cancellation' ? 'cancelled' : 'uncertain'; state.status = job.state;
      trace.push(['preflight', packet.request_ref, packet.code]); return clone(state);
    },
    interruptNativeRequest(_root, ref, error) {
      if (options.interruptFailure) throw new Error('private runtime stack and credentials');
      const state = read(ref); state.status = error.category === 'cancellation' ? 'cancelled' : 'uncertain';
      trace.push(['interrupt', ref, error.code]); return clone(state);
    },
    getNativeRequest(_root, ref) { return clone(read(ref)); },
    async runNativeChecks(_root, ref, { signal }) {
      trace.push(['checks', ref]);
      await options.checks?.(signal);
      const state = read(ref);
      state.checks = state.checks.map(check => ({ ...check, state: signal.aborted ? 'uncertain' : options.checkFailure ? 'failed' : 'passed',
        result: { exit_code: options.checkFailure ? 1 : 0, stdout: 'Private process output must not leak' }, log_path: 'evidence/check.log' }));
      if (signal.aborted) state.status = 'cancelled';
      else if (options.checkFailure) state.status = 'findings';
      return clone(state);
    },
    finishNativeRequest(_root, ref) {
      const state = read(ref); assert.equal(state.status, 'working'); assert.ok(state.checks.every(check => check.state === 'passed'));
      state.status = 'accepted'; state.accepted = true; trace.push(['finish', ref]); return clone(state);
    },
  };
  const vscode = { CancellationTokenSource: class {
    constructor() { this.token = cancellation(); sources.push(this); }
    cancel() { this.token.cancel(); }
    dispose() { this.disposed = true; }
  }, lm: {
    tools: options.tools ?? [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
      properties: Object.fromEntries(['prompt', 'description', 'agentName', 'model'].map(key => [key, { type: 'string' }])) } }],
    selectChatModels() { if (options.inventory) return options.inventory; assert.fail('Inherited native requests must not probe or select models'); },
    async invokeTool(name, payload, token) {
      assert.equal(name, 'runSubagent'); calls.push({ payload, token });
      assert.equal('assignment_ref' in payload.input, false);
      if (!options.modelForRole) assert.equal('model' in payload.input, false);
      if (options.invoke) return options.invoke(payload.input, token);
      return { content: [{ value: JSON.stringify({ summary: `Observed ${payload.input.agentName} work`,
        verdict: options.findings === payload.input.agentName ? 'findings' : 'pass', findings: options.findings === payload.input.agentName ? ['A concrete product defect'] : [] }) }] };
    },
  } };
  const runner = createLocalRequestRunner(vscode, runtime, '/project', { modelForRole: options.modelForRole });
  return { runner, runtime, vscode, states, calls, trace, sources };
}

test('concurrent requests share the configured worker limit without mixing their results', { timeout: 5000 }, async () => {
  let releaseFirst, firstStarted;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { firstStarted = resolve; });
  let running = 0, maximum = 0, first = true;
  const app = fixture({ invoke: async input => {
    running++; maximum = Math.max(maximum, running);
    try {
      if (first) { first = false; firstStarted(); await held; }
      await tick();
      return { content: [{ value: JSON.stringify({ summary: input.description, verdict: 'pass', findings: [] }) }] };
    } finally { running--; }
  } });
  app.runtime.readConfig = () => ({ max_workers: 1 });
  const firstResult = app.runner.run(input('First product'), opaque);
  await started;
  const secondResult = app.runner.run(input('Second product'), opaque);
  await tick(); await tick();
  assert.equal(app.calls.length, 1, 'the second request must wait before invoking its native agent');
  assert.equal(nativeActivity('/project').queued_calls.length, 1);
  releaseFirst();
  const results = await Promise.all([firstResult, secondResult]);
  assert.equal(maximum, 1);
  assert.equal(nativeActivity('/project').queued_calls.length, 0);
  assert.ok(results.every(result => result.request.accepted));
  assert.notEqual(results[0].request.request_key, results[1].request.request_key);
  for (const state of app.states.values()) assert.ok(state.assignments.every(job => job.report.summary.startsWith(state.title)));
  await app.runner.dispose();
});

test('explicit unavailable skills return a content capability reason before any native model call', async () => {
  const app = fixture();
  app.runtime.planNativeRequest = () => { throw Object.assign(new Error('private paths and raw receipt bytes'), { code: 'SELECTED_SKILL_UNAVAILABLE' }); };
  const result = await app.runner.run(input('Selected capability'), opaque);
  assert.equal(result.error.code, 'SELECTED_SKILL_UNAVAILABLE');
  assert.equal(result.error.category, 'capability');
  assert.match(result.error.message, /omit optional skills to use ordinary project tools/);
  assert.doesNotMatch(JSON.stringify(result), /private paths|raw receipt|AUTH|claim_token/);
  assert.equal(app.calls.length, 0);
  await app.runner.dispose();
});

test('ordinary requests perform no optional skill preflight storage reads', async () => {
  const app = fixture();
  app.runtime.assertNativeRequestSkillsCurrent = () => assert.fail('Omitted skills must not add a host state read per role');
  const completed = await app.runner.run(input('Ordinary product'), opaque);
  assert.equal(completed.request.accepted, true);
  assert.equal(app.calls.length, 3);
  await app.runner.dispose();
});

test('ordinary direct-role jobs perform no optional skill preflight storage reads', async () => {
  const app = fixture();
  app.runtime.nativeRoleJobSchema = { parse: input => input };
  app.runtime.openNativeRoleJob = () => ({ request_ref: 'private-ordinary-role', request_key: 'WF-R0098',
    assignment_ref: 'private-ordinary-assignment', role: 'WF.Reviewer', title: 'Ordinary report', prompt: 'Scoped report',
    description: 'Review only', status: 'queued', completion: 'incomplete', artifacts: [] });
  app.runtime.assertNativeRoleSkillsCurrent = () => assert.fail('Omitted skills must not add a direct-role host state read');
  app.runtime.recordNativeRoleResult = (_root, packet) => {
    assert.equal(packet.invocation.invoked, true);
    return { request_key: 'WF-R0098', role: 'WF.Reviewer', title: 'Ordinary report', status: 'submitted', completion: 'role-completed', artifacts: [] };
  };
  const completed = await app.runner.role({ role: 'WF.Reviewer', requirement: 'Review only' }, opaque);
  assert.equal(completed.job.completion, 'role-completed');
  assert.equal(app.calls.length, 1);
  await app.runner.dispose();
});

test('selected skill context is revalidated after worker queue admission without dispatching changed input', { timeout: 5000 }, async () => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let first = true, secondChanged = false;
  const app = fixture({ skillContexts: { 'WF.FnD': [{ name: 'review-guide' }] }, invoke: async input => {
    if (first) { first = false; started(); await held; }
    return { content: [{ value: JSON.stringify({ summary: input.description, verdict: 'pass', findings: [] }) }] };
  } });
  app.runtime.readConfig = () => ({ max_workers: 1 });
  app.runtime.assertNativeRequestSkillsCurrent = (_root, ref) => {
    if ([...app.states.values()].find(state => state.request_ref === ref)?.title === 'Changed selected skill' && secondChanged)
      throw Object.assign(new Error('secret receipt contents'), { code: 'SELECTED_SKILL_CHANGED' });
  };
  const active = app.runner.run(input('Active independent product'), opaque);
  await entered;
  const queued = app.runner.run(input('Changed selected skill'), opaque);
  await tick(); await tick();
  assert.equal(app.calls.length, 1);
  secondChanged = true; release();
  const [completed, stopped] = await Promise.all([active, queued]);
  assert.equal(completed.request.accepted, true);
  assert.equal(stopped.error.code, 'SELECTED_SKILL_CHANGED');
  assert.equal(stopped.error.category, 'capability');
  assert.equal(stopped.request.accepted, false);
  assert.equal(stopped.request.status, 'uncertain');
  assert.ok(app.calls.every(call => !call.payload.input.description.startsWith('Changed selected skill')));
  assert.equal(nativeActivity('/project').queued_calls.length, 0);
  await app.runner.dispose();
});

test('direct-role preflight skill change retains a non-invoked incomplete outcome', async () => {
  const app = fixture(); let retained;
  app.runtime.nativeRoleJobSchema = { parse: input => input };
  app.runtime.openNativeRoleJob = () => ({ request_ref: 'private-direct-request', request_key: 'WF-R0099',
    assignment_ref: 'private-direct-assignment', role: 'WF.Reviewer', title: 'Selected report', prompt: 'Private role context',
    description: 'Review only', status: 'queued', completion: 'incomplete', artifacts: [], skill_contexts: [{ name: 'review-guide' }] });
  app.runtime.assertNativeRoleSkillsCurrent = () => { throw Object.assign(new Error('private changed skill'), { code: 'SELECTED_SKILL_CHANGED' }); };
  app.runtime.recordNativeRoleResult = (_root, packet) => {
    retained = packet;
    return { request_key: 'WF-R0099', role: 'WF.Reviewer', title: 'Selected report', status: 'uncertain', completion: 'incomplete', artifacts: [] };
  };
  const stopped = await app.runner.role({ role: 'WF.Reviewer', requirement: 'Review only', skills: ['review-guide'] }, opaque);
  assert.equal(stopped.error.code, 'SELECTED_SKILL_CHANGED');
  assert.equal(stopped.job.status, 'uncertain');
  assert.equal(stopped.job.completion, 'incomplete');
  assert.equal(retained.invocation, undefined);
  assert.deepEqual(retained.error, { code: 'SELECTED_SKILL_CHANGED', category: 'capability' });
  assert.equal(app.calls.length, 0);
  await app.runner.dispose();
});

test('cancelling a request queued behind another worker never dispatches it or cancels the active owner', { timeout: 5000 }, async () => {
  let releaseFirst, firstStarted;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { firstStarted = resolve; });
  let first = true;
  const app = fixture({ invoke: async input => {
    if (first) { first = false; firstStarted(); await held; }
    return { content: [{ value: JSON.stringify({ summary: input.description, verdict: 'pass', findings: [] }) }] };
  } });
  app.runtime.readConfig = () => ({ max_workers: 1 });
  const active = app.runner.run(input('Active product'), opaque);
  await started;
  const caller = cancellation();
  const queued = app.runner.run(input('Queued product'), opaque, caller);
  await tick(); await tick(); caller.cancel();
  const stopped = await queued;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(nativeActivity('/project').queued_calls.length, 0);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].token.isCancellationRequested, false);
  releaseFirst();
  assert.equal((await active).request.accepted, true);
  assert.ok(app.calls.every(call => !call.payload.input.description.startsWith('Queued')));
  await app.runner.dispose();
});

test('a duplicate public recheck joins its active request instead of interrupting or restarting its owner', { timeout: 5000 }, async () => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let first = true;
  const app = fixture({ invoke: async input => {
    if (first) { first = false; started(); await held; }
    return { content: [{ value: JSON.stringify({ summary: input.description, verdict: 'pass', findings: [] }) }] };
  } });
  app.runtime.nativeRequestControlSchema = nativeRequestControlSchema;
  app.runtime.getNativeRequestByKey = () => clone([...app.states.values()][0]);
  app.runtime.recheckNativeRequest = () => { throw new Error('An active request must not be re-opened'); };
  const original = app.runner.run(input('Current product'), opaque);
  await entered;
  const saved = [...app.states.values()][0]; saved.request_key = 'WF-R0001';
  const duplicate = app.runner.control({ request_key: saved.request_key, action: 'recheck' }, { second: true });
  await tick();
  assert.equal(app.calls.length, 1);
  assert.equal(app.trace.some(event => event[0] === 'interrupt'), false);
  release();
  const results = await Promise.all([original, duplicate]);
  assert.ok(results.every(result => result.request?.accepted));
  assert.equal(app.calls.length, 3);
  assert.equal(app.states.size, 1);
  await app.runner.dispose();
});

test('one native request saves three independent actual results, runs checks, then accepts', { timeout: 5000 }, async () => {
  const app = fixture({ echoPrivate: true });
  const result = await app.runner.run(input('Product'), opaque);
  assert.equal(result.status, 'accepted'); assert.equal(result.request.accepted, true);
  assert.deepEqual(app.calls.map(call => call.payload.input.agentName), roles);
  assert.ok(app.calls.every(call => call.payload.toolInvocationToken === opaque));
  assert.equal(new Set([...app.states.values()][0].assignments.map(job => job.invocation.host_call_id)).size, 3);
  assert.deepEqual(app.trace.map(event => event[0]), ['open', 'plan', 'issue', 'record', 'issue', 'record', 'issue', 'record', 'checks', 'finish']);
  assert.equal(result.request.checks[0].exit_code, 0);
  const publicText = JSON.stringify(result);
  assert.doesNotMatch(publicText, /private-request|private-record|Private backend handoff|Private process output|host_call_id|assignment_ref|raw_result/);
  assert.ok(app.sources.every(source => source.disposed));
  await app.runner.dispose();
});

test('changing a role preference leaves its current invocation on A and uses B for its next request', { timeout: 5000 }, async () => {
  let preference = { id: 'a', vendor: 'endpoint' }, release, started;
  const waiting = new Promise(resolve => { release = resolve; }), issued = new Promise(resolve => { started = resolve; });
  let first = true;
  const app = fixture({ modelForRole: role => role === 'WF.FnD' ? preference : undefined,
    inventory: [{ id: 'a', vendor: 'endpoint', name: 'A' }, { id: 'b', vendor: 'endpoint', name: 'B' }],
    async invoke(input) {
      if (input.agentName === 'WF.FnD' && first) { first = false; started(); await waiting; assert.equal(input.model, 'A (endpoint)'); }
      return { content: [{ value: JSON.stringify({ summary: 'Observed role result', verdict: 'pass', findings: [] }) }] };
    } });
  const running = app.runner.run(input('First'), opaque);
  await issued;
  preference = { id: 'b', vendor: 'endpoint' };
  assert.equal(app.calls[0].payload.input.model, 'A (endpoint)');
  release();
  assert.equal((await running).status, 'accepted');
  assert.equal((await app.runner.run(input('Second'), opaque)).status, 'accepted');
  assert.deepEqual(app.calls.filter(call => call.payload.input.agentName === 'WF.FnD').map(call => call.payload.input.model), ['A (endpoint)', 'B (endpoint)']);
  assert.ok(app.calls.filter(call => call.payload.input.agentName !== 'WF.FnD').every(call => !('model' in call.payload.input)));
  await app.runner.dispose();
});

test('professional findings and incomplete reports retain work without running later roles or claiming acceptance', { timeout: 5000 }, async () => {
  const app = fixture({ findings: 'WF.Reviewer' });
  const result = await app.runner.run(input('Product'), opaque);
  assert.equal(result.status, 'findings'); assert.equal(result.request.accepted, false);
  assert.deepEqual(result.request.roles.at(-1).findings, ['A concrete product defect']);
  assert.equal(app.calls.length, 2); assert.equal(app.trace.some(event => event[0] === 'checks'), false);
  const incomplete = fixture({ invoke: () => ({ content: [{ value: 'Stopped without a professional report' }] }) });
  assert.equal((await incomplete.runner.run(input('Incomplete'), opaque)).status, 'uncertain');
  assert.equal(incomplete.calls.length, 1); assert.equal(incomplete.trace.some(event => event[0] === 'finish'), false);
});

test('native provider failure and preflight rejection are saved through their distinct backend methods once', { timeout: 5000 }, async () => {
  const provider = fixture({ invoke() { throw { status: 429, message: 'private credentials' }; } });
  const failed = await provider.runner.run(input('Provider'), opaque);
  assert.equal(failed.status, 'uncertain'); assert.equal(failed.error.code, 'PROVIDER_QUOTA');
  assert.equal(provider.calls.length, 1); assert.equal(provider.trace.filter(event => event[0] === 'record').length, 1);
  assert.doesNotMatch(JSON.stringify(failed), /private credentials/);
  const preflight = fixture({ tools: [] });
  const rejected = await preflight.runner.run(input('No tool'), opaque);
  assert.equal(rejected.status, 'uncertain'); assert.equal(rejected.error.code, 'NATIVE_TOOL_UNAVAILABLE');
  assert.equal(preflight.calls.length, 0); assert.equal(preflight.trace.filter(event => event[0] === 'preflight').length, 1);
  assert.equal(preflight.trace.some(event => event[0] === 'record'), false);
});

test('actual failed checks prevent finish even when all native roles returned pass', { timeout: 5000 }, async () => {
  const app = fixture({ checkFailure: true });
  const result = await app.runner.run(input('Failing check'), opaque);
  assert.equal(result.status, 'findings'); assert.equal(result.request.checks[0].exit_code, 1);
  assert.equal(result.request.accepted, false); assert.equal(app.calls.length, 3);
  assert.equal(app.trace.some(event => event[0] === 'finish'), false);
});

test('invalid content and missing context do not open backend requests', { timeout: 5000 }, async () => {
  const app = fixture();
  assert.equal((await app.runner.run({ ...input('Invalid'), assignment_ref: 'model-invented' }, opaque)).error.code, 'INVALID_REQUEST');
  assert.equal((await app.runner.run(input('No context'), undefined)).error.code, 'INVOCATION_TOKEN_REQUIRED');
  assert.equal(app.states.size, 0); assert.equal(app.calls.length, 0);
});

test('concurrent native requests keep backend assignments, invocation tokens and results separate', { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = fixture({ async invoke(handoff) {
    if (handoff.description === 'First: WF.FnD') await gate;
    return { content: [{ value: JSON.stringify({ summary: handoff.description, verdict: 'pass', findings: [] }) }] };
  } });
  const secondToken = Object.freeze({ opaque: Symbol('second native context') });
  const first = app.runner.run(input('First'), opaque);
  const second = await app.runner.run(input('Second'), secondToken);
  assert.equal(second.status, 'accepted'); assert.equal(second.request.title, 'Second');
  release();
  const result = await first;
  assert.equal(result.status, 'accepted'); assert.equal(result.request.title, 'First');
  assert.notEqual(result.request.request_key, second.request.request_key);
  assert.ok(app.calls.filter(call => call.payload.input.description.startsWith('First:')).every(call => call.payload.toolInvocationToken === opaque));
  assert.ok(app.calls.filter(call => call.payload.input.description.startsWith('Second:')).every(call => call.payload.toolInvocationToken === secondToken));
});

test('dispose cancels native work but waits for its real response to drain before completing', { timeout: 5000 }, async () => {
  let drain;
  const gate = new Promise(resolve => { drain = resolve; });
  const app = fixture({ async invoke(_handoff, token) {
    await gate;
    assert.equal(token.isCancellationRequested, true);
    throw Object.assign(new Error('cancelled native call'), { name: 'CancellationError' });
  } });
  const running = app.runner.run(input('Cancel native'), opaque);
  await tick(); assert.equal(app.calls.length, 1);
  let disposed = false;
  const disposing = app.runner.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(disposed, false);
  assert.equal(app.calls[0].token.isCancellationRequested, true);
  drain();
  const result = await running; await disposing;
  assert.equal(result.status, 'cancelled'); assert.equal(result.error.code, 'EDITOR_CLOSED');
  assert.equal(app.trace.some(event => event[0] === 'finish'), false);
  assert.equal((await app.runner.run(input('Too late'), opaque)).error.code, 'RUNNER_DISPOSED');
});

test('caller cancellation aborts a running checker and waits for its drain before returning', { timeout: 5000 }, async () => {
  let started, drain, observedSignal;
  const checking = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { drain = resolve; });
  const app = fixture({ async checks(signal) { observedSignal = signal; started(); await gate; } });
  const caller = cancellation();
  const running = app.runner.run(input('Cancel checker'), opaque, caller);
  await checking;
  caller.cancel(); assert.equal(observedSignal.aborted, true);
  let returned = false; running.then(() => { returned = true; });
  await tick(); assert.equal(returned, false);
  drain();
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(result.error.code, 'CANCELLED');
  assert.equal(app.trace.some(event => event[0] === 'finish'), false);
});

test('unexpected runtime failure is retained honestly without exposing raw errors or accepting work', { timeout: 5000 }, async () => {
  const app = fixture();
  app.runtime.nextNativeAssignment = () => { throw new Error('private backend stack and credential'); };
  const result = await app.runner.run(input('Backend error'), opaque);
  assert.equal(result.status, 'uncertain'); assert.equal(result.error.code, 'NATIVE_BACKEND_FAILED');
  assert.equal(app.trace.at(-1)[0], 'interrupt'); assert.equal(app.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private backend stack|credential/);
  const unavailable = fixture({ noAssignment: true, interruptFailure: true });
  const unconfirmed = await unavailable.runner.run(input('Unavailable state'), opaque);
  assert.equal(unconfirmed.status, 'uncertain'); assert.equal(unconfirmed.saved_state_confirmed, false);
  assert.equal(unconfirmed.error.code, 'NATIVE_STATE_UNAVAILABLE');
});

// The native model boundary is mocked. The domain, records, files and checker
// processes below are real; these tests are not desktop acceptance evidence.
test('runner with the real backend accepts only an actual passing checker and keeps per-request evidence', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-local-runner-'));
  const runners = [];
  const abort = () => { for (const runner of runners) void runner.dispose(); };
  t.signal.addEventListener('abort', abort, { once: true });
  t.after(async () => {
    await Promise.all(runners.map(runner => runner.dispose()));
    t.signal.removeEventListener('abort', abort);
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'NATIVE-RUNNER' });
  for (const good of [true, false]) {
    const output = good ? 'product-good.txt' : 'product-bad.txt';
    const checker = good ? 'check-good.cjs' : 'check-bad.cjs';
    writeFileSync(join(root, checker), `const assert=require('node:assert/strict');
const fs=require('node:fs');
assert.equal(fs.readFileSync(${JSON.stringify(output)},'utf8'),${JSON.stringify(good ? 'hello\n' : 'a different expected product')});
console.log('REAL_NATIVE_RUNNER_CHECK');\n`);
    const app = fixture({ invoke(handoff) {
      if (handoff.agentName === 'WF.FnD') writeFileSync(join(root, output), 'hello\n');
      else assert.equal(readFileSync(join(root, output), 'utf8'), 'hello\n');
      return { content: [{ value: JSON.stringify({ summary: 'Observed current product', verdict: 'pass', findings: [] }) }] };
    } });
    const runner = createLocalRequestRunner(app.vscode, { ...nativeDomain, nativeLocalRequestSchema }, root, { automaticRepair: false });
    runners.push(runner);
    const request = input(good ? 'Actual pass' : 'Actual failure');
    request.plan.outputs = [output];
    request.plan.checks = [{ title: 'Actual Node check', command: [process.execPath, checker], level: 'acceptance' }];
    const result = await runner.run(request, opaque);
    assert.equal(result.status, good ? 'accepted' : 'findings');
    assert.equal(result.request.accepted, good);
    assert.equal(result.request.checks[0].exit_code, good ? 0 : 1);
    assert.equal(app.calls.length, 3);
    const record = loadRecords(root).find(item => item.meta.data.kind === 'workforce-request' && item.meta.title === request.title);
    const saved = nativeDomain.getNativeRequest(root, record.meta.id);
    assert.equal(saved.accepted, good);
    assert.equal(new Set(saved.assignments.map(job => job.invocation.host_call_id)).size, 3);
    assert.equal(existsSync(join(root, saved.checks[0].log_path)), true);
    assert.equal(Boolean(saved.final_report_id), good);
    await runner.dispose();
  }
});

test('disposing the runner aborts and drains an actual backend checker process', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-local-runner-cancel-'));
  let runner;
  const abort = () => { void runner?.dispose(); };
  t.signal.addEventListener('abort', abort, { once: true });
  t.after(async () => {
    await runner?.dispose();
    t.signal.removeEventListener('abort', abort);
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'NATIVE-RUNNER-CANCEL' });
  writeFileSync(join(root, 'wait.cjs'), "require('node:fs').writeFileSync('checker-started','yes'); setInterval(()=>{},1000);\n");
  const app = fixture({ invoke(handoff) {
    if (handoff.agentName === 'WF.FnD') writeFileSync(join(root, 'product.txt'), 'hello\n');
    return { content: [{ value: JSON.stringify({ summary: 'Observed product', verdict: 'pass', findings: [] }) }] };
  } });
  runner = createLocalRequestRunner(app.vscode, { ...nativeDomain, nativeLocalRequestSchema }, root);
  const request = input('Cancel actual process'); request.plan.outputs = ['product.txt'];
  request.plan.checks = [{ title: 'Running real checker', command: [process.execPath, 'wait.cjs'], level: 'acceptance' }];
  const running = runner.run(request, opaque);
  // Wait for the real process, including durable request/record IO on Windows.
  // This is a readiness deadline, not a change to the product check timeout.
  const deadline = Date.now() + 30000;
  while (!existsSync(join(root, 'checker-started')) && Date.now() < deadline && !t.signal.aborted)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(join(root, 'checker-started')), true);
  await runner.dispose();
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(result.request.accepted, false);
  const record = loadRecords(root).find(item => item.meta.data.kind === 'workforce-request');
  const saved = nativeDomain.getNativeRequest(root, record.meta.id);
  assert.equal(saved.checks[0].result.cancelled, true);
  assert.equal(saved.checks[0].state, 'uncertain');
  assert.equal(Boolean(saved.final_report_id), false);
});

test('runner resumes the same retained request after a corrected role contract without opening another request', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'workforce-local-resume-'));
  let runner;
  t.after(async () => { await runner?.dispose(); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'NATIVE-RESUME' });
  writeFileSync(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('product.txt','utf8'),'hello');\n");
  let implementationAttempts = 0;
  const app = fixture({ invoke(handoff) {
    const first = handoff.agentName === 'WF.FnD' && ++implementationAttempts === 1;
    if (handoff.agentName === 'WF.FnD') writeFileSync(join(root, 'product.txt'), 'hello');
    return { content: [{ value: JSON.stringify({ summary: 'Observed product', verdict: first ? 'findings' : 'pass',
      findings: first ? ['Earlier contract incorrectly required later workflow acceptance.'] : [] }) }] };
  } });
  runner = createLocalRequestRunner(app.vscode, { ...nativeDomain, nativeLocalRequestSchema, nativeRequestControlSchema }, root, { automaticRepair: false });
  const request = input('Continue retained product');
  request.plan.outputs = ['product.txt'];
  request.plan.checks = [{ title: 'Actual product check', command: [process.execPath, 'check.cjs'], level: 'acceptance' }];
  assert.equal((await runner.run(request, opaque)).status, 'findings');
  const before = loadRecords(root).filter(item => item.meta.data.kind === 'workforce-request');
  assert.equal(before.length, 1);
  const result = await runner.control({ request_key: nativeDomain.getNativeRequest(root, before[0].meta.id).request_key, action: 'resume' }, opaque);
  assert.equal(result.status, 'accepted');
  assert.equal(result.request.accepted, true);
  assert.equal(result.request.roles.length, 3);
  assert.equal(result.request.roles.every(role => role.state === 'completed'), true);
  assert.equal(result.request.retained_attempts, 1);
  assert.equal(result.request.request_key, nativeDomain.getNativeRequest(root, before[0].meta.id).request_key);
  assert.equal(loadRecords(root).filter(item => item.meta.data.kind === 'workforce-request').length, 1);
  assert.equal(app.calls.length, 4);
});
