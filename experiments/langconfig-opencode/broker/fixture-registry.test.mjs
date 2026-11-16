import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureBroker } from './broker.mjs';

const request = runner => ({ version: 1, taskId: 'task', idempotencyKey: 'attempt', access: 'read', prompt: 'fixture',
  binding: { runner, provider: 'fixture', model: 'fake-readonly', reasoning: 'high' } });

test('broker dispatches through the selected fake registry factory', async () => {
  for (const id of ['codex', 'claude-code', 'opencode']) {
    const trace = [];
    const broker = new FixtureBroker(undefined, { trace: step => trace.push(step) });
    assert.deepEqual(await broker.execute(request(id)), { ok: true, result: { runner: id, status: 'completed', messages: [`fixture:${id}`] } });
    assert.deepEqual(trace, [`models:${id}`, `capabilities:${id}`, `factory:${id}`, 'open', 'verify', 'startTurn', 'wait', 'stop']);
  }
});

test('failures are sticky, scope is stopped when allocated, and no other runner is selected', async () => {
  for (const fault of ['capability', 'factory', 'open', 'session', 'delegation', 'start', 'wait', 'stop', 'stop-throws', 'stop-active']) {
    const trace = [];
    const broker = new FixtureBroker(undefined, { fault, trace: step => trace.push(step) });
    const expected = { ok: false, error: fault.startsWith('stop') ? 'stop_unconfirmed' : 'dispatch_failed' };
    assert.deepEqual(await broker.execute(request('codex')), expected, fault);
    const previous = [...trace];
    assert.deepEqual(await broker.execute(request('codex')), expected, fault);
    assert.deepEqual(trace, previous, fault);
    assert.equal(trace.some(step => step.includes('opencode') || step.includes('claude-code')), false, fault);
    assert.equal(trace.includes('stop'), trace.includes('open'), fault);
    if (fault === 'session' || fault === 'delegation') assert.equal(trace.includes('startTurn'), false, fault);
  }
});

test('wire input cannot select a test fault or writable access', async () => {
  let calls = 0;
  const broker = new FixtureBroker(() => calls++);
  for (const input of [{ ...request('codex'), fault: 'stop' }, { ...request('codex'), access: 'write' }]) {
    assert.deepEqual(await broker.execute(input), { ok: false, error: 'invalid_request' });
  }
  assert.equal(calls, 0);
});
