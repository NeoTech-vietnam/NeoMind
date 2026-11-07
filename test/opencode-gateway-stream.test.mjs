import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { initialize } from '../dist/storage.js';
import { createOpenCodeGateway, openCodeConfiguration, openCodeStorage, startOpenCodeEngine } from '../dist/opencode-engine.js';
import { localOpenAIProvider } from './helpers/local-openai-provider.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const bounded = (promise, ms, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
};
async function connect(gateway, transportFetch) {
  const client = new Client({ name: 'wf-long-check-transport', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), {
    requestInit: { headers: { Authorization: gateway.authorization } }, ...(transportFetch ? { fetch: transportFetch } : {}),
  }));
  return client;
}

test('gateway sends actual MCP headers before a pending check finishes and preserves its one exact result', { timeout: 10000 }, async t => {
  let release, entered, headers, calls = 0, completed = false;
  const waiting = new Promise(done => { release = done; });
  const started = new Promise(done => { entered = done; });
  const received = new Promise(done => { headers = done; });
  const expected = { content: [{ type: 'text', text: '{"passed":true,"diagnostic":"Việt Nam \\n exact"}' }] };
  const gateway = await createOpenCodeGateway(() => {
    const server = new McpServer({ name: 'pending-owned-check', version: '1' });
    server.registerTool('check_run', { inputSchema: { title: z.string() } }, async ({ title }) => {
      assert.equal(title, 'frozen check'); calls++; entered(); await waiting; completed = true; return expected;
    });
    return server;
  }, () => {});
  let client;
  t.after(async () => { release(); await client?.close(); await gateway.close(); });
  client = await connect(gateway, async (input, init) => {
    const isCheck = typeof init?.body === 'string' && init.body.includes('"method":"tools/call"');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    try {
      const response = await fetch(input, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
      if (isCheck) { assert.match(response.headers.get('content-type'), /^text\/event-stream/); headers(); }
      return response;
    } finally { clearTimeout(timer); }
  });
  const pending = client.callTool({ name: 'check_run', arguments: { title: 'frozen check' } }, undefined, { timeout: 5000 });
  // Observe rejection immediately too, so the deliberately failing old JSON
  // mode never creates an unhandled transport rejection during RED.
  pending.catch(() => {});
  await bounded(started, 1500, 'The check was not dispatched.');
  await bounded(Promise.race([received, pending.then(() => { throw new Error('Result arrived before pending headers.'); })]),
    1800, 'Pending check sent no HTTP response headers before the client deadline.');
  assert.equal(completed, false); assert.equal(calls, 1);
  release(); assert.deepEqual(await pending, expected); assert.equal(completed, true); assert.equal(calls, 1);
});

test('closing an owned gateway cancels its pending callback without publishing a fabricated check result', { timeout: 10000 }, async t => {
  let entered, cancelled, writes = 0;
  const started = new Promise(done => { entered = done; });
  const stopped = new Promise(done => { cancelled = done; });
  const gateway = await createOpenCodeGateway(() => {
    const server = new McpServer({ name: 'cancel-owned-check', version: '1' });
    server.registerTool('check_run', { inputSchema: {} }, async (_input, extra) => {
      entered();
      await new Promise(done => { extra.signal.addEventListener('abort', done, { once: true }); if (extra.signal.aborted) done(); });
      cancelled();
      if (!extra.signal.aborted) writes++;
      return { content: [{ type: 'text', text: '{"cancelled":true}' }] };
    });
    return server;
  }, () => {});
  const client = await connect(gateway);
  t.after(async () => { await client.close(); await gateway.close(); });
  const pending = client.callTool({ name: 'check_run', arguments: {} }, undefined, { timeout: 5000 }); pending.catch(() => {});
  await bounded(started, 2000, 'The cancellable check was not dispatched.');
  await gateway.close();
  await bounded(stopped, 2000, 'Closing the owned transport did not cancel its pending callback.');
  await assert.rejects(pending); assert.equal(writes, 0);
});

// Real pinned OpenCode, real HTTP MCP, scripted loopback model protocol only:
// no user files, provider credentials, external inference or model quota.
test('actual pinned OpenCode receives SSE keepalive while waiting for one slow check and sees durable evidence before continuing',
  { timeout: 150000 }, async t => {
    const temporary = resolve('artifacts/test-temp'); mkdirSync(temporary, { recursive: true });
    const root = mkdtempSync(join(temporary, 'wf-slow-check-gateway-'));
    initialize(root, { project_id: 'WF-SLOW-CHECK', execution_engine: 'opencode' });
    const storage = openCodeStorage(root).path, evidence = join(root, 'actual-evidence.json');
    let provider, gateway, engine, proxy, calls = 0, completed = false, headerDelay, keepalives = 0, dispatchAt;
    const upstreams = new Set();
    t.after(async () => {
      await engine?.close(); for (const request of upstreams) request.destroy();
      if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
      await gateway?.close(); await provider?.close();
      assert.equal(dirname(root), temporary); assert.equal(dirname(storage), join(temporary, '.workforce-private'));
      rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const exact = { passed: true, title: 'owned slow check', marker: 'durable before model continuation' };
    provider = await localOpenAIProvider((index, body) => {
      if (index === 0) return { toolCalls: [{ name: 'wf_check_run', arguments: { title: exact.title } }] };
      assert.equal(index, 1); assert.equal(completed, true);
      assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), exact);
      const result = body.messages.findLast(message => message.role === 'tool');
      assert.deepEqual(JSON.parse(result.content), exact);
      return { text: 'The actual slow check completed with durable evidence.' };
    }, 2);
    gateway = await createOpenCodeGateway(() => {
      const server = new McpServer({ name: 'actual-owned-slow-check', version: '1' });
      server.registerTool('check_run', { inputSchema: { title: z.string() } }, async ({ title }) => {
        assert.equal(title, exact.title); calls++; dispatchAt = Date.now();
        await delay(21000); writeFileSync(evidence, JSON.stringify(exact)); completed = true;
        return { content: [{ type: 'text', text: JSON.stringify(exact) }] };
      });
      return server;
    }, () => {});
    // Transparent loopback transport observer; neither changes tool bytes nor
    // executes work. It distinguishes a real SSE heartbeat from model output.
    proxy = createServer((request, response) => {
      const started = Date.now();
      const upstream = httpRequest(gateway.url, { method: request.method, headers: request.headers }, received => {
        if (dispatchAt && !completed && received.headers['content-type']?.startsWith('text/event-stream')) headerDelay = Date.now() - started;
        response.writeHead(received.statusCode, received.headers); response.flushHeaders();
        received.on('data', chunk => { if (chunk.toString('utf8').includes(': keepalive')) keepalives++; });
        received.pipe(response);
      });
      upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream));
      // A shorter HTTP idle deadline than the real callback isolates the
      // transport defect in seconds. Only actual network bytes reset it.
      upstream.setTimeout(20000, () => upstream.destroy(new Error('Offline MCP transport idle deadline.')));
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream); response.once('close', () => upstream.destroy());
    });
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    const observedGateway = { ...gateway, url: `http://127.0.0.1:${proxy.address().port}/mcp` };
    engine = await startOpenCodeEngine(root, randomUUID(), openCodeConfiguration({ model: 'worker-models', provider: 'local-protocol-fixture',
      baseURL: provider.baseURL, apiKey: 'fixture-only-no-provider-key' }, observedGateway, ['check_run']));
    const session = await engine.client.session.create({ directory: engine.directory, agent: 'workforce', title: 'Offline slow MCP check' });
    const listed = await engine.client.tool.ids({ directory: engine.directory });
    const tools = Object.fromEntries(listed.data.map(name => [name, name === 'wf_check_run']));
    const result = await engine.client.session.prompt({ sessionID: session.data.id, directory: engine.directory, agent: 'workforce',
      model: { providerID: 'workforce-router', modelID: 'worker-models' }, tools,
      parts: [{ type: 'text', text: 'Run the supplied frozen check once, then report its actual result. This is a loopback protocol fixture.' }] },
    { signal: AbortSignal.timeout(60000) });
    assert.equal(result.data.info.error, undefined); assert.deepEqual(provider.failures, []);
    assert.equal(provider.requests.length, 2); assert.equal(calls, 1);
    assert.ok(headerDelay !== undefined && headerDelay < 1000, 'Actual engine check receives SSE headers before its long callback completes.');
    assert.ok(keepalives >= 1, 'The real transport sent a keepalive before the actual check completed.');
    assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), exact);
    t.diagnostic(JSON.stringify({ engine: 'OpenCode 1.19.4', provider: 'loopback scripted protocol only', calls,
      header_delay_ms: headerDelay, observed_sse_keepalives: keepalives, durable_before_model_continuation: true }));
  });
