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
  return Object.assign(relay, { progress });
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

test('an endlessly growing read argument is stopped at its per-call byte bound without resetting progress forever', async t => {
  const frames = [chunk({ tool_calls: [{ index: 0, id: 'call_runaway', type: 'function', function: { name: 'wf_project_read', arguments: '{"path":"' } }] }),
    ...Array.from({ length: 32 }, () => chunk({ tool_calls: [{ index: 0, function: { arguments: 'private-argument-sentinel'.repeat(45) } }] })),
    'data: [DONE]\r\n\r\n'];
  const upstream = await provider(t, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) { if (response.destroyed) break; response.write(frame); await delay(1); }
    if (!response.destroyed) response.end();
  });
  const failures = [], observations = [], relay = await stream(t, upstream, {
    onFailure: value => failures.push(value), onObservation: value => observations.push(value),
  });
  const response = await post(relay), received = [];
  let transportStopped = false;
  try { for await (const part of response.body) received.push(Buffer.from(part)); }
  catch { transportStopped = true; }
  assert.equal(failures.length, 1, 'Runaway semantic arguments must produce one owned failure.');
  assert.equal(transportStopped, true);
  assert.equal(failures[0].code, 'OPENCODE_PROVIDER_ARGUMENT_LIMIT');
  assert.equal(failures[0].limit_bytes, 8192);
  assert.ok(failures[0].argument_bytes > failures[0].limit_bytes);
  assert.deepEqual(relay.failure, failures[0]);
  const forwarded = Buffer.concat(received), original = Buffer.from(frames.join(''));
  assert.deepEqual(forwarded, original.subarray(0, forwarded.length), 'Bytes before owned cancellation must remain exact.');
  assert.ok(forwarded.length < original.length);
  assert.ok(relay.progress.filter(value => value.kind === 'tool-arguments').reduce((sum, value) => sum + value.bytes, 0) <= 8192);
  assert.doesNotMatch(JSON.stringify(failures), /private-argument-sentinel|upstream-private-key|wf_project_read|configured-peer/);
  await until(() => observations.some(value => value.event === 'provider-transport-ended'), 'The refused upstream must finish its observation.');
  assert.equal(observations.at(-1).completed, false); assert.equal(observations.at(-1).aborted, true);
  await until(() => upstream.sockets.size === 0, 'Oversized arguments must close the upstream socket.');
  const retry = await post(relay);
  assert.equal(retry.status, 422);
  assert.equal((await retry.json()).error.code, 'OPENCODE_PROVIDER_ARGUMENT_LIMIT');
  assert.equal(upstream.requests.length, 1, 'Engine automatic retries must not restart the same runaway stream.');
});

test('large write and plan calls retain their exact bytes under their separate larger argument bound', async t => {
  const write = JSON.stringify({ path: 'products/generic.txt', edits: Array.from({ length: 2 }, () => ({
    old_text: 'a'.repeat(128 * 1024), new_text: 'b'.repeat(128 * 1024),
  })) });
  const plan = JSON.stringify({ tasks: Array.from({ length: 32 }, () => ({ title: 'step',
    objective: 'x'.repeat(8000), rationale: 'y'.repeat(8000), acceptance_criteria: ['done'] })) });
  assert.ok(Buffer.byteLength(write) > 512 * 1024); assert.ok(Buffer.byteLength(plan) > 500 * 1024);
  const bytes = Buffer.from(chunk({ tool_calls: [{ index: 0, id: 'call_write', type: 'function',
    function: { name: 'wf_task_file_write', arguments: write } }] }) +
    chunk({ tool_calls: [{ index: 1, id: 'call_plan', type: 'function', function: { name: 'wf_workflow_plan', arguments: plan } }] }) + 'data: [DONE]\n\n');
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(bytes); });
  const relay = await stream(t, upstream), response = await post(relay);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(relay.failure, undefined);
  assert.deepEqual(relay.progress.map(value => value.bytes), [Buffer.byteLength(write), Buffer.byteLength(plan)]);
});

test('argument bounds are independent per choice and call, and reset after a healthy provider response', async t => {
  const argument = JSON.stringify({ path: 'p'.repeat(6000) });
  const frames = [0, 1].map(choiceIndex => `data: ${JSON.stringify({ choices: [{ index: choiceIndex, delta: {
    tool_calls: [{ index: 0, id: `call_choice_${choiceIndex}`, function: { name: 'wf_project_read', arguments: argument } }],
  } }] })}\n\n`);
  frames.push(chunk({ tool_calls: [{ index: 1, id: 'call_second', function: { name: 'wf_project_read', arguments: argument } }] }));
  const bytes = Buffer.from(frames.join('') + 'data: [DONE]\n\n');
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(bytes); });
  const relay = await stream(t, upstream);
  for (let index = 0; index < 2; index++) {
    const response = await post(relay);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(relay.failure, undefined);
  }
  assert.equal(relay.progress.length, 6);
});

test('read argument limits count UTF-8 bytes rather than JavaScript character length', async t => {
  const argument = JSON.stringify({ path: 'ế'.repeat(3000) });
  assert.ok(argument.length < 8192); assert.ok(Buffer.byteLength(argument) > 8192);
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chunk({ tool_calls: [{ index: 0, id: 'call_utf8', function: { name: 'wf_project_read', arguments: argument } }] })); });
  const failures = [], relay = await stream(t, upstream, { onFailure: value => failures.push(value) });
  await assert.rejects(async () => { const response = await post(relay); await response.arrayBuffer(); });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].argument_bytes, Buffer.byteLength(argument));
  assert.equal(failures[0].limit_bytes, 8192);
  assert.deepEqual(relay.progress, []);
});

test('arguments received before identity still count when a fragmented read name establishes the narrow bound', async t => {
  const bytes = Buffer.from(chunk({ tool_calls: [{ index: 0, function: { arguments: 'x'.repeat(9000) } }] }) +
    chunk({ tool_calls: [{ index: 0, id: 'call_late', function: { name: 'wf_project_' } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '' } }] }));
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(bytes); });
  const relay = await stream(t, upstream);
  await assert.rejects(async () => { const response = await post(relay); await response.arrayBuffer(); });
  assert.equal(relay.failure?.code, 'OPENCODE_PROVIDER_ARGUMENT_LIMIT');
  assert.equal(relay.failure?.argument_bytes, 9000); assert.equal(relay.failure?.limit_bytes, 8192);
  assert.deepEqual(relay.progress, []);
});

for (const name of ['assignment_read', 'wf_assignment_read', 'check_evidence_more', 'wf_check_evidence_more']) test(`bounded read ${name} cannot stream unbounded arguments`, async t => {
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chunk({ tool_calls: [{ index: 0, id: 'call_empty_read', function: { name, arguments: 'x'.repeat(8193) } }] })); });
  const relay = await stream(t, upstream);
  await assert.rejects(async () => { const response = await post(relay); await response.arrayBuffer(); });
  assert.equal(relay.failure?.code, 'OPENCODE_PROVIDER_ARGUMENT_LIMIT');
  assert.equal(relay.failure?.argument_bytes, 8193); assert.equal(relay.failure?.limit_bytes, 8192);
});

for (const [tool, input, limit] of [
  ['project_read_more', { cursor: '00000000-0000-4000-8000-000000000001' }, 8 * 1024],
  ['check_evidence_more', { cursor: '00000000-0000-4000-8000-000000000001' }, 8 * 1024],
  ['project_list', { path: '\u0001'.repeat(1024), limit: 1000 }, 8 * 1024],
  ['check_evidence', { title: '\u0001'.repeat(256), path: '\u0001'.repeat(1024), kind: 'workflow', start_char: 2097152, max_chars: 64000 }, 8 * 1024],
  ['project_search', { query: '\u0001'.repeat(1000), path: '\u0001'.repeat(1024), max_matches: 100 }, 16 * 1024],
  ['runtime_context', { executables: { python: '\u0001'.repeat(2048), c11: '\u0001'.repeat(2048), cpp17: '\u0001'.repeat(2048) } }, 64 * 1024],
]) for (const name of [tool, `wf_${tool}`]) test(`${name} allows its maximum escaped schema-shaped selectors and refuses overflow`, async t => {
  const healthy = JSON.stringify(input);
  assert.ok(Buffer.byteLength(healthy) < limit);
  const frames = [healthy, 'x'.repeat(limit + 1)].map(argumentsText => Buffer.from(chunk({ tool_calls: [{ index: 0,
    id: 'call_read_selector', function: { name, arguments: argumentsText } }] })));
  const upstream = await provider(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames[upstream.requests.length - 1]); });
  const relay = await stream(t, upstream);
  const response = await post(relay);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), frames[0]);
  assert.equal(relay.failure, undefined);
  await assert.rejects(async () => { const response = await post(relay); await response.arrayBuffer(); });
  assert.equal(relay.failure?.code, 'OPENCODE_PROVIDER_ARGUMENT_LIMIT');
  assert.equal(relay.failure?.argument_bytes, limit + 1); assert.equal(relay.failure?.limit_bytes, limit);
});

test('other tool calls have a finite larger bound and advisory failure callbacks cannot alter or suppress refusal', async t => {
  const fragment = 'private-oversize-sentinel'.repeat(30000);
  const upstream = await provider(t, async (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(chunk({ tool_calls: [{ index: 0, id: 'call_large', function: { name: 'wf_task_file_write', arguments: fragment } }] }));
    for (let index = 1; index < 6; index++) { await delay(2); if (response.destroyed) break;
      response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: fragment } }] })); }
    if (!response.destroyed) response.end(); });
  const relay = await stream(t, upstream, { onFailure(value) { value.message = 'mutated callback value'; throw new Error('private-observer-error'); } });
  await assert.rejects(async () => { const response = await post(relay); await response.arrayBuffer(); });
  assert.equal(relay.failure?.code, 'OPENCODE_PROVIDER_ARGUMENT_LIMIT');
  assert.equal(relay.failure?.limit_bytes, 4 * 1024 * 1024);
  assert.equal(relay.failure?.argument_bytes, Buffer.byteLength(fragment) * 6);
  assert.match(relay.failure?.message ?? '', /^A streamed tool call exceeded/);
  assert.doesNotMatch(JSON.stringify(relay.failure), /mutated|private-oversize-sentinel|private-observer-error|wf_task_file_write/);
});
