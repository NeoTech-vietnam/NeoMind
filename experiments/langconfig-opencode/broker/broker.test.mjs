import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureBroker } from './broker.mjs';

const request = (runner = 'codex') => ({ version: 1, taskId: 'task-1', idempotencyKey: 'attempt-1',
  binding: { runner, provider: 'fixture', model: 'fake-readonly', reasoning: 'high' }, access: 'read', prompt: 'review fixture' });

test('all three IDs use only their matching fake runner', async () => {
  for (const runner of ['codex', 'claude-code', 'opencode']) {
    const calls = [];
    const broker = new FixtureBroker(id => calls.push(id));
    assert.deepEqual(await broker.execute(request(runner)), { ok: true, result: { runner, status: 'completed', messages: [`fixture:${runner}`] } });
    assert.deepEqual(calls, [runner]);
  }
});

test('invalid requests fail closed without dispatch', async () => {
  let calls = 0;
  const broker = new FixtureBroker(() => calls++);
  const bad = [
    { ...request(), version: 2 }, { ...request(), access: 'write' }, { ...request(), workspace: '/tmp' },
    { ...request(), prompt: '' }, { ...request(), prompt: 'x'.repeat(4097) }, { ...request(), taskId: '../task' },
    { ...request(), binding: { ...request().binding, runner: 'unknown' } },
    { ...request(), binding: { ...request().binding, provider: 'openai' } },
    { ...request(), binding: { ...request().binding, model: 'gpt-6-luna' } },
    { ...request(), binding: { ...request().binding, reasoning: 'low' } },
    { ...request(), binding: { ...request().binding, fallback: [] } }, null, [],
  ];
  for (const input of bad) assert.deepEqual(await broker.execute(input), { ok: false, error: 'invalid_request' });
  assert.equal(calls, 0);
});

test('concurrent duplicates share one dispatch and changed payload conflicts', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const broker = new FixtureBroker(async () => { calls++; await gate; });
  const first = broker.execute(request());
  const duplicate = broker.execute(request());
  assert.deepEqual(await broker.execute({ ...request(), prompt: 'different' }), { ok: false, error: 'idempotency_conflict' });
  release();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.deepEqual(one, two);
  one.result.messages.push('mutation');
  assert.deepEqual((await broker.execute(request())).result.messages, ['fixture:codex']);
  assert.equal(calls, 1);
  await broker.execute({ ...request(), taskId: 'task-2' });
  assert.equal(calls, 2);
});

test('failure is sticky and never triggers fallback or retry', async () => {
  let calls = 0;
  const broker = new FixtureBroker(() => { calls++; throw Error('secret detail'); });
  assert.deepEqual(await broker.execute(request('opencode')), { ok: false, error: 'dispatch_failed' });
  assert.deepEqual(await broker.execute(request('opencode')), { ok: false, error: 'dispatch_failed' });
  assert.equal(calls, 1);
});

test('request is copied before the runner can observe later mutation', async () => {
  let observed;
  const broker = new FixtureBroker((_runner, value) => { observed = value.prompt; });
  const input = request();
  const pending = broker.execute(input);
  input.prompt = 'changed';
  await pending;
  assert.equal(observed, 'review fixture');
});
