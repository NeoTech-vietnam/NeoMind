import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexReadOnlyAdapter } from '../src/adapters/codex-readonly.js';

test('Codex read-only adapter pins restrictions and preserves turn and thread identities', async () => {
  const calls: { method: string; params: unknown }[] = [];
  const adapter = new CodexReadOnlyAdapter({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  } });
  assert.equal(await adapter.startThread('/tmp/project', 'model-1'), 'thread-1');
  assert.equal(await adapter.resumeThread('thread-1', '/tmp/project', 'model-1'), 'thread-1');
  assert.equal(await adapter.startTurn('thread-1', 'Inspect the project', 'medium'), 'turn-1');
  await adapter.interrupt('thread-1', 'turn-1');
  assert.deepEqual(calls[0]?.params, { cwd: '/tmp/project', model: 'model-1', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false });
  assert.deepEqual(calls[2]?.params, { threadId: 'thread-1', effort: 'medium', input: [{ type: 'text', text: 'Inspect the project' }] });
  assert.deepEqual(calls[3]?.params, { threadId: 'thread-1', turnId: 'turn-1' });
});

test('Codex read-only adapter rejects changed thread identity and malformed responses', async () => {
  const adapter = new CodexReadOnlyAdapter({ request: async () => ({ thread: { id: 'other' } }) });
  await assert.rejects(adapter.resumeThread('expected', '/tmp/project', 'model-1'), /identity mismatch/);
  await assert.rejects(adapter.startTurn('thread-1', 'task', 'medium'));
});

test('verified thread rejects a server-selected model, provider, workspace or sandbox', async () => {
  let response: Record<string, unknown> = { thread: { id: 'verified' }, model: 'gpt-6-luna', modelProvider: 'openai',
    cwd: '/tmp/project', approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
  const adapter = new CodexReadOnlyAdapter({ request: async () => response });
  assert.equal(await adapter.startVerifiedThread('/tmp/project', 'gpt-6-luna', 'openai'), 'verified');
  assert.equal(await adapter.resumeVerifiedThread('verified', '/tmp/project', 'gpt-6-luna', 'openai'), 'verified');
  await assert.rejects(adapter.resumeVerifiedThread('other', '/tmp/project', 'gpt-6-luna', 'openai'), /identity mismatch/);
  for (const change of [{ model: 'other' }, { modelProvider: 'other' }, { cwd: '/tmp/other' },
    { approvalPolicy: 'on-request' }, { sandbox: { type: 'workspaceWrite' } }]) {
    const original = response;
    response = { ...original, ...change };
    await assert.rejects(adapter.startVerifiedThread('/tmp/project', 'gpt-6-luna', 'openai'));
    response = original;
  }
});

test('bound turns require a verified thread and explicitly pin model and reasoning', async () => {
  const calls: { method: string; params: unknown }[] = [];
  const adapter = new CodexReadOnlyAdapter({ request: async (method, params) => {
    calls.push({ method, params });
    return method === 'turn/start' ? { turn: { id: 'turn' } } : { thread: { id: 'thread' }, model: 'gpt-6-luna',
      modelProvider: 'openai', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
  } });
  const binding = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  await assert.rejects(adapter.startBoundTurn('thread', 'task', binding), /not been verified/);
  await adapter.startVerifiedThread('/tmp/project', binding.model, binding.provider);
  await assert.rejects(adapter.startBoundTurn('thread', 'task', { ...binding, model: 'other' }), /not been verified/);
  assert.equal(await adapter.startBoundTurn('thread', 'task', binding), 'turn');
  assert.deepEqual(calls.at(-1)?.params, { threadId: 'thread', model: 'gpt-6-luna', effort: 'low', input: [{ type: 'text', text: 'task' }] });
  await adapter.resumeThread('thread', '/tmp/project', binding.model);
  await assert.rejects(adapter.startBoundTurn('thread', 'task', binding), /not been verified/);
});
