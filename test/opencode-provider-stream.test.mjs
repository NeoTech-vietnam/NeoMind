import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenCodeProviderStream } from '../dist/opencode-provider-stream.js';

const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl_generic', object: 'chat.completion.chunk', created: 1,
  model: 'bound-model', choices: [{ index: 0, delta, finish_reason: null }] })}\r\n\r\n`;
const body = { model: 'bound-model', stream: true, messages: [{ role: 'user', content: 'Inspect the assigned generic file.' }] };
const until = async (predicate, message) => {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
};
async function provider(t, handle) {
  const requests = [], sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const bytes of request) chunks.push(bytes);
      const observed = { url: request.url, headers: request.headers, bytes: Buffer.concat(chunks), response };
      requests.push(observed); await handle(observed, response);
    } catch { response.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests, sockets };
}
async function stream(t, upstream, options = {}) {
  const progress = [];
  const relay = await createOpenCodeProviderStream({ model: 'bound-model', provider: 'configured-peer',
    baseURL: upstream.baseURL, apiKey: 'upstream-private-key' }, { onProgress: value => progress.push(value), ...options });
  t.after(() => relay.close());
  return { ...relay, progress };
}
const post = (relay, payload = JSON.stringify(body), { headers, ...options } = {}) => fetch(`${relay.endpoint.baseURL}/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${relay.endpoint.apiKey}`, ...headers },
  body: payload, ...options,
});
const rawPost = (relay, bytes, headers) => new Promise((resolve, reject) => {
  const request = httpRequest(`${relay.endpoint.baseURL}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${relay.endpoint.apiKey}`, 'content-length': String(bytes.length), ...headers,
  } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
    response.once('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }));
  });
  request.once('error', reject); request.end(bytes);
});

test('provider relay authenticates each local request and rejects unsupported route, method and model before upstream', async t => {
  const upstream = await provider(t, (_request, response) => response.end('unexpected'));
  const relay = await stream(t, upstream);
  assert.equal(relay.endpoint.provider, 'configured-peer'); assert.equal(relay.endpoint.model, 'bound-model');
  assert.notEqual(relay.endpoint.apiKey, 'upstream-private-key'); assert.ok(relay.endpoint.apiKey.length >= 32);
  for (const authorization of [undefined, 'Bearer wrong', 'Bearer upstream-private-key']) {
    const response = await fetch(`${relay.endpoint.baseURL}/chat/completions`, { method: 'POST', body: JSON.stringify(body),
      headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401); await response.arrayBuffer();
  }
  for (const path of ['/v1/models', '/v1/chat/completions?destination=http://127.0.0.1/', '/other']) {
    const response = await fetch(new URL(path, relay.endpoint.baseURL), { method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${relay.endpoint.apiKey}` } });
    assert.equal(response.status, 404); await response.arrayBuffer();
  }
  const wrongMethod = await fetch(`${relay.endpoint.baseURL}/chat/completions`, { headers: { authorization: `Bearer ${relay.endpoint.apiKey}` } });
  assert.equal(wrongMethod.status, 404); await wrongMethod.arrayBuffer();
  for (const invalid of [{ ...body, model: 'unbound-model' }, { ...body, stream: false }, { ...body, messages: {} }, null]) {
    const response = await post(relay, JSON.stringify(invalid)); assert.equal(response.status, 400); await response.arrayBuffer();
  }
  assert.equal(upstream.requests.length, 0); assert.deepEqual(relay.progress, []);
});

test('provider relay preserves original request and SSE bytes while reporting only metadata across split UTF-8 and frames', async t => {
  const text = 'Việt 🌱', reasoning = 'inspect identity', argument = '{"path":"products/đề.txt"}';
  const responseBytes = Buffer.from(': keepalive\r\n\r\n' + chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_generic',
    type: 'function', function: { name: 'wf_project_read', arguments: '' } }] }) + chunk({ content: text }) +
    chunk({ reasoning_content: reasoning }) + chunk({ tool_calls: [{ index: 0, function: { arguments: argument } }] }) + 'data: [DONE]\r\n\r\n');
  const upstream = await provider(t, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const unicode = responseBytes.indexOf(Buffer.from('🌱'));
    for (const bytes of [responseBytes.subarray(0, unicode + 1), responseBytes.subarray(unicode + 1, unicode + 3),
      responseBytes.subarray(unicode + 3, unicode + 5), responseBytes.subarray(unicode + 5)]) {
      response.write(bytes); await delay(5);
    }
    response.end();
  });
  const observations = [], relay = await stream(t, upstream, { onObservation: value => observations.push(value) });
  const original = Buffer.from(JSON.stringify(body, null, 3) + '\n');
  const response = await rawPost(relay, original, { 'user-agent': 'generic-pinned-sdk/1', 'x-request-context': 'generic-session',
    cookie: 'private-cookie-must-not-forward', connection: 'keep-alive, x-hop-context', 'x-hop-context': 'must-not-forward' });
  assert.equal(response.status, 200); assert.deepEqual(response.bytes, responseBytes);
  assert.equal(upstream.requests.length, 1); assert.deepEqual(upstream.requests[0].bytes, original);
  assert.equal(upstream.requests[0].url, '/v1/chat/completions');
  assert.equal(upstream.requests[0].headers.authorization, 'Bearer upstream-private-key');
  assert.equal(upstream.requests[0].headers['user-agent'], 'generic-pinned-sdk/1');
  assert.equal(upstream.requests[0].headers['x-request-context'], 'generic-session');
  assert.equal(upstream.requests[0].headers.cookie, undefined);
  assert.equal(upstream.requests[0].headers['x-hop-context'], undefined);
  assert.deepEqual(relay.progress.map(({ sequence, kind, bytes }) => ({ sequence, kind, bytes })), [
    { sequence: 1, kind: 'text', bytes: Buffer.byteLength(text) },
    { sequence: 2, kind: 'reasoning', bytes: Buffer.byteLength(reasoning) },
    { sequence: 3, kind: 'tool-arguments', bytes: Buffer.byteLength(argument) },
  ]);
  assert.equal(new Set(relay.progress.map(value => value.request_id)).size, 1);
  for (const value of relay.progress) assert.deepEqual(Object.keys(value).sort(), ['bytes', 'kind', 'request_id', 'sequence']);
  assert.ok(relay.progress[0].request_id.length > 0);
  assert.deepEqual(observations.map(value => value.event), ['provider-request-started', 'provider-response-started', 'provider-transport-ended']);
  const ended = observations.at(-1);
  assert.equal(ended.completed, true); assert.equal(ended.aborted, false); assert.equal(ended.request_bytes, original.length);
  assert.equal(observations[0].response_bytes, 0); assert.equal(ended.response_bytes, responseBytes.length);
  assert.equal(ended.semantic_events, 3); assert.equal(ended.semantic_bytes, relay.progress.reduce((sum, value) => sum + value.bytes, 0));
  assert.equal(ended.request_id, relay.progress[0].request_id);
  const allowed = new Set(['event', 'request_id', 'elapsed_ms', 'request_bytes', 'response_bytes', 'status_code', 'semantic_events',
    'semantic_bytes', 'last_semantic_ms', 'completed', 'aborted']);
  for (const value of observations) for (const key of Object.keys(value)) assert.ok(allowed.has(key), `unexpected telemetry field ${key}`);
});

test('heartbeats, malformed frames, names, empty and structurally invalid deltas never count as provider progress', async t => {
  const bytes = Buffer.from(': heartbeat\n\nevent: ping\ndata: {}\n\ndata: {broken\n\n' +
    chunk({ tool_calls: [{ index: 0, function: { name: 'wf_project_read', arguments: '' } }] }) + chunk({ content: '', reasoning: '' }) +
    'data: {"choices":[{"delta":{"content":"missing-index"}}]}\n\n' +
    chunk({ content: { text: 'not-a-string' }, tool_calls: [{ index: -1, function: { arguments: 'invalid-index' } }] }) +
    'data: [DONE]\n\n');
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(bytes); });
  const relay = await stream(t, upstream), response = await post(relay);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); assert.deepEqual(relay.progress, []);
});

test('tool arguments count only after that choice and call establish an id and name', async t => {
  const bytes = Buffer.from(
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'orphan' } }] }) +
    chunk({ tool_calls: [{ index: 0, id: 'call_split', type: 'function' }] }) +
    chunk({ tool_calls: [{ index: 1, function: { name: 'wrong_index', arguments: 'orphan' } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { name: 'wf_project_read', arguments: '{' } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }) +
    chunk({ tool_calls: [{ index: 2, id: 'call_full', type: 'function', function: { name: 'wf_project_read', arguments: '{}' } }] }) +
    'data: [DONE]\n\n');
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(bytes); });
  const relay = await stream(t, upstream), response = await post(relay);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(relay.progress.map(item => [item.kind, item.bytes]), [
    ['tool-arguments', 1], ['tool-arguments', 1], ['tool-arguments', 2],
  ]);
});

test('identity encoding remains observable while non-SSE and failed HTTP bodies never create semantic progress', async t => {
  const upstream = await provider(t, (_request, response) => {
    if (upstream.requests.length === 1) response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'identity' });
    else if (upstream.requests.length === 2) response.writeHead(200, { 'content-type': 'application/json' });
    else response.writeHead(500, { 'content-type': 'text/event-stream' });
    response.end(chunk({ content: 'one semantic delta' }));
  });
  const relay = await stream(t, upstream);
  for (let i = 0; i < 3; i++) { const response = await post(relay); await response.arrayBuffer(); }
  assert.equal(relay.progress.length, 1); assert.equal(relay.progress[0].kind, 'text');
});

test('provider retry timing survives the relay unchanged without exposing response credentials', async t => {
  const upstream = await provider(t, (_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2', 'retry-after-ms': '1',
      authorization: 'Bearer private-response', 'set-cookie': 'private-response' });
    response.end('{"error":{"message":"Provider temporarily unavailable"}}');
  });
  const relay = await stream(t, upstream), response = await post(relay);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(response.headers.get('retry-after-ms'), '1');
  assert.equal(response.headers.get('authorization'), null); assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(JSON.parse(await response.text()), { error: { message: 'Provider temporarily unavailable' } });
  assert.equal(upstream.requests.length, 1); assert.deepEqual(relay.progress, []);
});

test('upstream redirect and credential headers cannot create a caller-selected destination or leak credentials', async t => {
  const other = await provider(t, (_request, response) => response.end('must not follow'));
  const upstream = await provider(t, (_request, response) => {
    response.writeHead(302, { location: `${other.baseURL}/chat/completions`, authorization: 'Bearer response-secret',
      'set-cookie': 'session=response-secret', 'content-type': 'text/plain' }); response.end('redirect refusal');
  });
  const relay = await stream(t, upstream), response = await post(relay, JSON.stringify(body), { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(await response.text(), 'redirect refusal');
  for (const header of ['location', 'authorization', 'set-cookie']) assert.equal(response.headers.get(header), null);
  assert.equal(other.requests.length, 0); assert.deepEqual(relay.progress, []);
});

for (const cause of ['owner-abort', 'close', 'client-cancel']) test(`provider relay ${cause} closes the actual upstream stream without leaving an active socket`, async t => {
  let upstreamClosed = false;
  const upstream = await provider(t, (_request, response) => {
    response.once('close', () => { upstreamClosed = true; });
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': connected\n\n');
  });
  const owner = new AbortController(), relay = await stream(t, upstream, { signal: owner.signal });
  const response = await post(relay), reader = response.body.getReader(); await reader.read();
  if (cause === 'owner-abort') owner.abort();
  else if (cause === 'close') await relay.close();
  else await reader.cancel();
  await until(() => upstreamClosed, 'the upstream streaming response must be canceled');
  await until(() => upstream.sockets.size === 0, 'the upstream socket must be released');
  if (cause !== 'client-cancel') await assert.rejects(post(relay));
  await relay.close(); await relay.close();
  assert.deepEqual(relay.progress, []);
});

test('concurrent provider streams keep separate request identity and sequence, and an advisory callback cannot change response bytes', async t => {
  const bytes = Buffer.from(chunk({ content: 'generic' }) + chunk({ reasoning: 'check' }) + 'data: [DONE]\n\n');
  const upstream = await provider(t, async (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(bytes.subarray(0, 30)); await delay(5); response.end(bytes.subarray(30)); });
  const observed = [], relay = await stream(t, upstream, { onProgress(value) { observed.push(value); throw new Error('advisory observer failure'); } });
  const responses = await Promise.all([post(relay), post(relay)]);
  for (const response of responses) assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const ids = [...new Set(observed.map(value => value.request_id))]; assert.equal(ids.length, 2);
  for (const id of ids) assert.deepEqual(observed.filter(value => value.request_id === id).map(value => value.sequence), [1, 2]);
});
