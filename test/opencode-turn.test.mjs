import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeTurnObserver } from '../dist/opencode-turn.js';
import { OpenCodeToolFailureGuard } from '../dist/opencode-tool-observation.js';

const identity = { sessionID: 'owned-session', messageID: 'owned-user', directory: 'fixture-only',
  modelID: 'worker-models', providerID: 'workforce-router' };
const user = { info: { role: 'user', id: identity.messageID, sessionID: identity.sessionID }, parts: [] };
function assistant(overrides = {}, parts = []) {
  return { info: { role: 'assistant', id: 'owned-result', sessionID: identity.sessionID, parentID: identity.messageID,
    modelID: identity.modelID, providerID: identity.providerID, time: { created: 1, completed: 2 }, finish: 'stop', ...overrides }, parts };
}
const tool = (id, status, input = {}) => ({ id, sessionID: identity.sessionID, messageID: 'owned-result', type: 'tool',
  callID: `call-${id}`, tool: 'wf_project_read', state: { status, input, raw: '' } });
const ok = data => ({ response: { ok: true }, data });

function fixture(t, behavior = {}, policy = {}) {
  const controller = new AbortController(); let clock = 0, reads = 0, aborts = 0, statusReads = 0, submissions = 0;
  const observations = [], parts = [];
  const state = { get clock() { return clock; }, get reads() { return reads; }, get aborts() { return aborts; },
    get statusReads() { return statusReads; }, get submissions() { return submissions; }, observations, parts, controller };
  t.after(() => controller.abort());
  const client = { session: {
    async messages() { clock += 5000; reads++; if (reads > 30) controller.abort(new Error('Test safety stop: reconciliation did not terminate.'));
      return ok(await behavior.messages?.(state) ?? [user, assistant()]); },
    async status() { statusReads++; return ok(await behavior.status?.(state) ?? { [identity.sessionID]: { type: 'idle' } }); },
    async abort() { aborts++; if (behavior.abort) return behavior.abort(state); return ok(true); },
    async prompt() { submissions++; throw new Error('An observer cannot replay inference.'); },
    async promptAsync() { submissions++; throw new Error('An observer cannot replay admission.'); },
  } };
  const observer = new OpenCodeTurnObserver(client, identity, { signal: controller.signal, assertCurrent() {},
    now: () => clock, poll_ms: 1, http_timeout_ms: 10, model_idle_ms: 1000000,
    onObservation: value => observations.push(value), onToolPart: part => parts.push(part), ...policy });
  return { observer, state };
}

test('saved exact user/assistant results reconcile after a lost acknowledgment without submitting another prompt', { timeout: 3000 }, async t => {
  const { observer, state } = fixture(t);
  const result = await observer.wait();
  assert.equal(result.info.id, 'owned-result'); assert.equal(result.info.parentID, identity.messageID);
  assert.equal(state.submissions, 0); assert.equal(state.aborts, 0);
});

for (const [field, wrong] of [['sessionID', 'different-session'], ['modelID', 'different-model'], ['providerID', 'different-provider']])
  test(`completed assistant with a different ${field} cannot finish the owned turn`, { timeout: 3000 }, async t => {
    const { observer, state } = fixture(t, { messages: () => [user, assistant({ [field]: wrong })] });
    await assert.rejects(observer.wait(), error => error.code === 'OPENCODE_TURN_IDENTITY');
    assert.equal(state.submissions, 0); assert.equal(state.aborts, 0);
  });

test('unrelated parent and intermediate tool-call completion are not the final owned assistant', { timeout: 3000 }, async t => {
  const { observer, state } = fixture(t, { messages: state => state.reads === 1
    ? [user, assistant({ id: 'foreign', parentID: 'other-user' }), assistant({ id: 'intermediate', finish: 'tool-calls' })]
    : [user, assistant({ id: 'final', time: { created: 2, completed: 3 } })] });
  const result = await observer.wait();
  assert.equal(result.info.id, 'final'); assert.equal(state.reads, 2); assert.equal(state.aborts, 0);
});

test('readable completed messages cannot mask a persistent status transport failure or trigger a false provider abort', { timeout: 3000 }, async t => {
  const { observer, state } = fixture(t, { status() { throw new Error('Fixture status reply unavailable.'); } }, { model_idle_ms: 10000 });
  await assert.rejects(observer.wait(), error => error.code === 'OPENCODE_DELIVERY_UNKNOWN');
  assert.ok(state.clock >= 30000 && state.clock <= 50000, 'The full required reconciliation has its own bounded failure window.');
  assert.equal(state.aborts, 0, 'A completed inference with unavailable status is not an idle provider.');
  assert.equal(state.submissions, 0);
});

test('a transient required-status outage recovers the same completed assistant without aborting or resubmitting', { timeout: 3000 }, async t => {
  const { observer, state } = fixture(t, { status(state) { if (state.statusReads <= 3) throw new Error('Transient fixture status delivery.'); } }, { model_idle_ms: 10000 });
  const result = await observer.wait();
  assert.equal(result.info.id, 'owned-result'); assert.equal(state.statusReads, 4);
  assert.equal(state.aborts, 0); assert.equal(state.submissions, 0);
});

test('a partial tool name with empty arguments is not model progress and requires acknowledged abort plus observed idle', { timeout: 3000 }, async t => {
  const pending = assistant({ time: { created: 1 } }, [tool('partial', 'pending')]);
  const { observer, state } = fixture(t, { messages: () => [user, pending], status: state => ({ [identity.sessionID]: { type: state.aborts ? 'idle' : 'busy' } }) }, { model_idle_ms: 10000 });
  await assert.rejects(observer.wait(), error => error.code === 'OPENCODE_PROVIDER_STALLED');
  assert.equal(state.aborts, 1); assert.equal(state.submissions, 0);
  assert.ok(state.observations.some(value => value.event === 'model-progress-stalled' && value.abort_acknowledged && value.session_idle_observed));
});

test('a missing stalled-abort reply stays delivery-unknown rather than claiming provider cancellation', { timeout: 3000 }, async t => {
  const { observer, state } = fixture(t, { messages: () => [user, assistant({ time: { created: 1 } }, [tool('partial', 'pending')])],
    abort() { throw new Error('Fixture abort reply lost.'); } }, { model_idle_ms: 10000 });
  await assert.rejects(observer.wait(), error => error.code === 'OPENCODE_DELIVERY_UNKNOWN');
  assert.equal(state.aborts, 1); assert.equal(state.submissions, 0);
  assert.equal(state.observations.some(value => value.abort_acknowledged === true), false);
});

test('fresh saved tool parts replace stale SSE running state before idle classification', { timeout: 3000 }, async t => {
  const { observer, state } = fixture(t, { messages: () => [user, assistant({ time: { created: 1 } }, [tool('partial', 'pending')])],
    status: state => ({ [identity.sessionID]: { type: state.aborts ? 'idle' : 'busy' } }) }, { model_idle_ms: 10000 });
  observer.note({ type: 'message.part.updated', properties: { sessionID: identity.sessionID, part: tool('stale-sse', 'running', { path: 'file.txt' }) } });
  await assert.rejects(observer.wait(), error => error.code === 'OPENCODE_PROVIDER_STALLED');
  assert.equal(state.aborts, 1); assert.equal(state.submissions, 0);
});

test('successful read-only capability nonce churn does not reset an unchanged protocol failure', () => {
  const guard = new OpenCodeToolFailureGuard(identity.sessionID, ['project_read', 'runtime_context', 'capability_invoke']);
  const event = (id, tool, state) => ({ id, type: 'message.part.updated', properties: { sessionID: identity.sessionID,
    part: { type: 'tool', callID: id, tool: `wf_${tool}`, state } } });
  const failure = id => event(id, 'project_read', { status: 'error', input: { path: 'input.txt', start_line: 2, start_char: 2 }, error: 'Conflicting cursors.' });
  assert.equal(guard.observe(failure('failure-one')).repeated_failures, 1);
  for (let index = 0; index < 5; index++) {
    guard.observe(event(`capability-${index}`, 'capability_invoke', { status: 'completed', input: { provider: 'context7' },
      output: JSON.stringify({ ready: true, observed_at: `time-${index}`, nonce: `fresh-${index}` }) }));
    guard.observe(event(`read-${index}`, 'runtime_context', { status: 'completed', input: {}, output: JSON.stringify({ nonce: `fresh-${index}` }) }));
  }
  const repeated = guard.observe(failure('failure-two'));
  assert.equal(repeated.repeated_failures, 2); assert.equal(repeated.halt, true);
});

test('fresh failed-check evidence locators never refund identical protocol errors within the owned session', () => {
  const guard = new OpenCodeToolFailureGuard(identity.sessionID, ['project_read', 'check_run']);
  const event = (id, tool, state) => ({ id, type: 'message.part.updated', properties: { sessionID: identity.sessionID,
    part: { type: 'tool', callID: id, tool: `wf_${tool}`, state } } });
  const failures = [];
  for (let index = 0; index < 5; index++) {
    failures.push(guard.observe(event(`invalid-read-${index}`, 'project_read', { status: 'error',
      input: { path: 'input.txt', start_line: 2, start_char: 2 }, error: 'Conflicting cursors.' })));
    guard.observe(event(`repeated-check-${index}`, 'check_run', { status: 'completed', input: { title: 'Same frozen check' },
      output: JSON.stringify({ checks: [{ title: 'Same frozen check', passed: false, observed_passed: false,
        checker_scope_current: true, exit_code: 1, evidence: `.workforce/controlled/checks/fresh-${index}/log.json` }] }) }));
  }
  assert.deepEqual(failures.filter(Boolean).map(value => value.repeated_failures), [1, 2]);
  assert.equal(failures[1].halt, true, 'The second unchanged input/error stops the session despite a new evidence filename.');
  assert.deepEqual(failures.slice(2), [undefined, undefined, undefined]);
});
