import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { initialize } from '../../dist/storage.js';
import { createControlledMcpServer } from '../../dist/controlled-tools.js';
import { createOpenCodeGateway, openCodeConfiguration, openCodeStorage, startOpenCodeEngine } from '../../dist/opencode-engine.js';

// This protocol peer never calls an external provider. It leaves one real
// OpenCode inference unfinished after a tool name, matching the observed live
// boundary: the backend never received complete arguments or an MCP call.
async function stalledProvider() {
  const requests = [], responses = new Set(), intervals = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ model: body.model, stream: body.stream, started: Date.now() });
    responses.add(response);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const metadata = { id: `chatcmpl_stall_${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
    response.write(`data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
      id: `call_stall_${requests.length}`, type: 'function', function: { name: 'wf_project_read', arguments: '' } }] }, finish_reason: null }] })}\n\n`);
    const interval = setInterval(() => { if (!response.destroyed) response.write(': fixture heartbeat; no model output\n\n'); }, 250);
    intervals.add(interval);
    response.on('close', () => { clearInterval(interval); intervals.delete(interval); responses.delete(response); });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests,
    async close() { for (const interval of intervals) clearInterval(interval); for (const response of responses) response.destroy();
      server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}

async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(done => setTimeout(done, 25)); }
  throw new Error('Local protocol fixture did not reach its expected boundary.');
}
function safeError(error) {
  return { name: error?.name, message: ['fetch failed', 'terminated'].includes(error?.message) ? error.message : undefined,
    cause_name: error?.cause?.name, cause_code: error?.cause?.code };
}

test('actual OpenCode synchronous prompt exposes Node HTTP timeout while async acknowledgment is not inference completion',
  { timeout: 370000 }, async t => {
    const temporary = resolve('artifacts/test-temp'); mkdirSync(temporary, { recursive: true });
    const root = mkdtempSync(join(temporary, 'wf-http-lifecycle-'));
    initialize(root, { project_id: 'WF-HTTP', execution_engine: 'opencode' });
    mkdirSync(join(root, 'products')); writeFileSync(join(root, 'products/input.txt'), 'Actual unchanged input.\n');
    const storage = openCodeStorage(root).path, traces = [];
    let provider, gateway, engine;
    t.after(async () => { await engine?.close(); await gateway?.close(); await provider?.close();
      assert.equal(dirname(root), temporary); assert.equal(dirname(storage), join(temporary, '.workforce-private'));
      rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const binding = { workflow_id: 'WF-HTTP-REQUEST', invocation_id: randomUUID(), task_id: 'WF-HTTP-TASK', process_contract: 'workforce/v1',
      role: 'developer', stage: 'implementation', implementation_paths: ['products'], verification_paths: [], read_paths: ['products'],
      execution_steps: [], procedure_bound: false, cornell_bound: false };
    provider = await stalledProvider();
    gateway = await createOpenCodeGateway(() => createControlledMcpServer(root, binding,
      { assertActive() {}, trace: event => traces.push(event), saveReport() { throw new Error('A partial tool name cannot submit a professional result.'); } }), () => {});
    const config = openCodeConfiguration({ model: 'worker-models', provider: 'local-protocol-stall', baseURL: provider.baseURL,
      apiKey: 'fixture-only-no-provider-key' }, gateway, ['project_read', 'assignment_report']);
    // Isolate the Node client->engine HTTP timeout from the provider's own
    // independently configured header/chunk deadlines. This is fixture-only.
    Object.assign(config.provider['workforce-router'].options, { headerTimeout: 600000, chunkTimeout: 600000 });
    engine = await startOpenCodeEngine(root, randomUUID(), config);
    const listed = await engine.client.tool.ids({ directory: engine.directory });
    const tools = Object.fromEntries(listed.data.map(name => [name, name === 'wf_project_read']));
    const create = () => engine.client.session.create({ directory: engine.directory, agent: 'workforce', title: 'Offline partial provider stream' });
    const makeInput = sessionID => ({ sessionID, directory: engine.directory, agent: 'workforce',
      model: { providerID: 'workforce-router', modelID: 'worker-models' }, tools,
      parts: [{ type: 'text', text: 'Use only the supplied local loopback protocol peer. No external model or product acceptance is involved.' }] });
    const sync = await create(), started = Date.now();
    const syncResult = engine.client.session.prompt(makeInput(sync.data.id), { signal: AbortSignal.timeout(340000) })
      .then(response => ({ response }), error => ({ error }));
    await until(() => provider.requests.length === 1);
    const asyncSession = await create(), asyncStarted = Date.now();
    const acknowledgment = await engine.client.session.promptAsync(makeInput(asyncSession.data.id), { signal: AbortSignal.timeout(10000) });
    const acknowledgmentMs = Date.now() - asyncStarted;
    await until(() => provider.requests.length >= 2);
    assert.equal(acknowledgment.response.status, 204);
    assert.ok(acknowledgmentMs < 10000, 'Async admission must not wait for model completion.');
    const asyncMessages = await engine.client.session.messages({ sessionID: asyncSession.data.id, directory: engine.directory });
    assert.ok(asyncMessages.data.some(item => item.info.role === 'assistant' && !item.info.time.completed));
    assert.equal(gateway.calls.size, 0, 'Neither partial tool name is a delivered MCP request.');
    await engine.client.session.abort({ sessionID: asyncSession.data.id, directory: engine.directory });
    const result = await syncResult, elapsedMs = Date.now() - started;
    const stillReadable = await engine.client.session.get({ sessionID: sync.data.id, directory: engine.directory });
    const syncMessages = await engine.client.session.messages({ sessionID: sync.data.id, directory: engine.directory });
    const unfinished = syncMessages.data.filter(item => item.info.role === 'assistant' && !item.info.time.completed).length;
    t.diagnostic(JSON.stringify({ engine: 'OpenCode 1.19.4', provider: 'loopback scripted SSE; no external model provider configured',
      elapsed_ms: elapsedMs, async_acknowledgment_ms: acknowledgmentMs, async_status: acknowledgment.response.status,
      request_count: provider.requests.length, mcp_calls: gateway.calls.size, engine_session_readable: !!stillReadable.data?.id,
      unfinished_assistant_messages: unfinished, error: safeError(result.error), backend_tool_results: traces.filter(event => event.event === 'tool-result').length }));
    assert.ok(result.error, 'Synchronous HTTP must reproduce the retained fetch failure instead of silently completing.');
    assert.equal(result.error.name, 'TypeError');
    assert.equal(result.error.cause?.code, 'UND_ERR_HEADERS_TIMEOUT');
    assert.ok(elapsedMs >= 290000 && elapsedMs < 340000);
    assert.equal(stillReadable.data.id, sync.data.id, 'An HTTP client timeout does not itself stop the actual engine session.');
    assert.ok(unfinished >= 1);
    assert.equal(gateway.calls.size, 0);
    await engine.client.session.abort({ sessionID: sync.data.id, directory: engine.directory });
  });
