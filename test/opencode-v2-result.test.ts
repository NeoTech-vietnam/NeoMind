import test from 'node:test';
import assert from 'node:assert/strict';
import { openCodeV2Result } from '../src/runners/opencode-v2-result.js';

const args = { outcome: 'succeeded', userMessageId: 'msg_1', sessionId: 'logical', turnId: 'turn', provider: 'openai', model: 'model', variant: 'high' };
const reply = () => ({ id: 'msg_2', type: 'assistant', agent: 'build', model: { id: 'model', providerID: 'openai', variant: 'high' }, finish: 'stop', content: [{ type: 'text', text: 'answer' }] });
const response = (messages: unknown[], next: string | null = null) => ({ data: messages, cursor: { next } });

test('OpenCode V2 result belongs to the dispatched prompt and successful model', () => {
  const result = openCodeV2Result({ ...args, response: response([{ id: 'msg_1', type: 'user' }, reply()]) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.messages, ['answer']);
});

test('OpenCode V2 refuses partial, failed, unrelated or ambiguous output', () => {
  const cases = [
    { ...args, outcome: 'failed', response: response([{ id: 'msg_1', type: 'user' }, reply()]) },
    { ...args, response: response([{ id: 'msg_1', type: 'user' }, reply()], 'more') },
    { ...args, response: response([reply()]) },
    { ...args, response: response([{ id: 'msg_1', type: 'user' }, { id: 'msg_other', type: 'user' }, reply()]) },
    { ...args, response: response([{ id: 'msg_1', type: 'user' }, { ...reply(), finish: 'length' }]) },
    { ...args, response: response([{ id: 'msg_1', type: 'user' }, { ...reply(), error: { secret: 'do not expose' } }]) },
    { ...args, response: response([{ id: 'msg_1', type: 'user' }, { ...reply(), model: { id: 'other', providerID: 'openai' } }]) },
  ];
  for (const input of cases) {
    const result = openCodeV2Result(input);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.messages, []);
    assert.doesNotMatch(result.error ?? '', /secret|do not expose/);
  }
});
