import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOpenCodeV2Turn } from '../src/runners/opencode-v2-dispatch.js';
import { openCodeV2Rules } from '../src/runners/opencode-v2-contract.js';

const spec = { logicalId: 'logical', workspace: '/workspace', provider: 'openai', model: 'model', variant: 'high', permissions: openCodeV2Rules(false, false) };
const data = { id: 'ses_ABC123', agent: 'build', model: { id: spec.model, providerID: spec.provider, variant: spec.variant },
  metadata: { neomindSession: spec.logicalId }, location: { directory: spec.workspace }, permissions: spec.permissions, outcome: 'succeeded' };
const input = { nativeId: data.id, spec, prompt: 'hello', turnId: 'turn' };

test('OpenCode V2 dispatch verifies session, receipt, completion and message', async () => {
  const calls: string[] = [];
  const server = { request: async (method: 'GET' | 'POST', endpoint: string) => {
    calls.push(`${method} ${endpoint}`);
    if (endpoint.endsWith('/prompt')) return { data: { id: 'msg_1', sessionID: data.id, type: 'user' } };
    if (endpoint.endsWith('/wait')) return undefined;
    if (endpoint.includes('/message?')) return { data: [{ id: 'msg_1', type: 'user' }, { id: 'msg_2', type: 'assistant', agent: 'build', model: data.model, finish: 'stop', content: [{ type: 'text', text: 'answer' }] }], cursor: { next: null } };
    return { data };
  } };
  const result = await dispatchOpenCodeV2Turn(server, input);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.messages, ['answer']);
  assert.deepEqual(calls, ['GET /api/session/ses_ABC123', 'POST /api/session/ses_ABC123/prompt', 'POST /api/experimental/session/ses_ABC123/wait', 'GET /api/session/ses_ABC123', 'GET /api/session/ses_ABC123/message?order=asc']);
});

test('OpenCode V2 refuses invalid schemas before dispatch and wrong receipts', async () => {
  let calls = 0;
  const server = { request: async (_method: 'GET' | 'POST', endpoint: string) => { calls++; return endpoint.endsWith('/prompt') ? { data: { id: 'msg_1', sessionID: 'ses_OTHER', type: 'user' } } : { data }; } };
  await assert.rejects(dispatchOpenCodeV2Turn(server, { ...input, outputSchema: { type: 'not-a-type' } }), /cannot validate/);
  assert.equal(calls, 0);
  await assert.rejects(dispatchOpenCodeV2Turn(server, input), /receipt session mismatch/);
  assert.equal(calls, 2);
});

test('OpenCode V2 accepts only JSON matching the entire locally validated schema', async () => {
  let text = '{"answer":"ok"}';
  const server = { request: async (_method: 'GET' | 'POST', endpoint: string) => {
    if (endpoint.endsWith('/prompt')) return { data: { id: 'msg_1', sessionID: data.id, type: 'user' } };
    if (endpoint.endsWith('/wait')) return undefined;
    if (endpoint.includes('/message?')) return { data: [{ id: 'msg_1', type: 'user' }, { id: 'msg_2', type: 'assistant', agent: 'build', model: data.model, finish: 'stop', content: [{ type: 'text', text }] }], cursor: { next: null } };
    return { data };
  } };
  const outputSchema = { type: 'object', properties: { answer: { type: 'string', minLength: 1 } }, required: ['answer'], additionalProperties: false };
  assert.equal((await dispatchOpenCodeV2Turn(server, { ...input, outputSchema })).status, 'completed');
  text = 'Explanation\n```json\n{"answer":"ok"}\n```';
  assert.deepEqual((await dispatchOpenCodeV2Turn(server, { ...input, outputSchema })).messages, ['{"answer":"ok"}']);
  for (const invalid of ['not json', '{}', '{"answer":""}', '{"answer":"ok","extra":true}', '```json\n{"answer":"ok"}\n```\n```json\n{"answer":"ok"}\n```', '```json\n{}\n```']) {
    text = invalid;
    const result = await dispatchOpenCodeV2Turn(server, { ...input, outputSchema });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.messages, []);
  }
});

test('OpenCode V2 reads every message page and refuses cursor loops', async () => {
  let loop = false;
  const server = { request: async (_method: 'GET' | 'POST', endpoint: string) => {
    if (endpoint.endsWith('/prompt')) return { data: { id: 'msg_1', sessionID: data.id, type: 'user' } };
    if (endpoint.endsWith('/wait')) return undefined;
    if (endpoint.includes('/message?order=')) return { data: [{ id: 'msg_1', type: 'user' }], cursor: { next: 'next page' } };
    if (endpoint.includes('/message?cursor=')) return { data: [{ id: 'msg_2', type: 'assistant', agent: 'build', model: data.model, finish: 'stop', content: [{ type: 'text', text: 'answer' }] }], cursor: { next: loop ? 'next page' : null } };
    return { data };
  } };
  assert.equal((await dispatchOpenCodeV2Turn(server, input)).status, 'completed');
  loop = true;
  await assert.rejects(dispatchOpenCodeV2Turn(server, input), /repeated a message cursor/);
});
