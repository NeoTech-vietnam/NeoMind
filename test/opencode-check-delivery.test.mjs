import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createOpenCodeGateway } from '../dist/opencode-engine.js';

test('idle TCP pressure cannot reset an authenticated frozen check before MCP dispatch', { timeout: 15000 }, async t => {
  let checks = 0;
  const sockets = [];
  const gateway = await createOpenCodeGateway(() => {
    const server = new McpServer({ name: 'check-delivery-pressure', version: '1' });
    server.registerTool('check_run', { inputSchema: z.object({ title: z.string() }) }, async ({ title }) => {
      assert.equal(title, 'Fresh builds, assertions and independent oracle'); checks++;
      return { content: [{ type: 'text', text: JSON.stringify({ passed: true }) }] };
    });
    return server;
  }, () => {});
  t.after(async () => { for (const socket of sockets) socket.destroy(); await gateway.close(); });
  const url = new URL(gateway.url);
  // Retained idle connections are not active MCP calls and must not consume
  // an unrelated future tool's admission or be mistaken for a bad payload.
  await Promise.all(Array.from({ length: 32 }, () => new Promise((done, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) }); sockets.push(socket);
    socket.once('connect', done); socket.once('error', reject);
  })));
  const response = await fetch(gateway.url, { method: 'POST', signal: AbortSignal.timeout(3000), headers: {
    authorization: gateway.authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
    name: 'check_run', arguments: { title: 'Fresh builds, assertions and independent oracle' },
  } }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const messages = (await response.text()).split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice(5).trimStart()));
  assert.equal(messages.length, 1);
  const result = messages[0];
  assert.equal(result.result.isError, undefined);
  assert.equal(checks, 1);
  const denied = await fetch(gateway.url, { method: 'POST', headers: { authorization: 'Bearer foreign-worker' }, body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal(checks, 1, 'Idle pressure never relaxes invocation authentication.');
});

test('active MCP pressure returns HTTP backpressure rather than dropping TCP or dispatching extra work', { timeout: 15000 }, async t => {
  let checks = 0, release, ready;
  const pending = new Promise(done => { release = done; });
  const admitted = new Promise(done => { ready = done; });
  const gateway = await createOpenCodeGateway(() => {
    const server = new McpServer({ name: 'check-delivery-active-pressure', version: '1' });
    server.registerTool('check_run', { inputSchema: z.object({ title: z.string() }) }, async () => {
      checks++; if (checks === 32) ready(); await pending;
      return { content: [{ type: 'text', text: '{"passed":true}' }] };
    });
    return server;
  }, () => {});
  const request = id => fetch(gateway.url, { method: 'POST', signal: AbortSignal.timeout(8000), headers: {
    authorization: gateway.authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'check_run', arguments: { title: 'frozen check' } } }) });
  const running = Array.from({ length: 32 }, (_, index) => request(index));
  t.after(async () => { release(); await Promise.allSettled(running); await gateway.close(); });
  await Promise.race([admitted, new Promise((_, reject) => setTimeout(() => reject(new Error('32 active requests were not admitted.')), 5000).unref())]);
  const overflow = await request(33);
  assert.equal(overflow.status, 503);
  assert.equal(checks, 32, 'The extra request cannot execute beyond the bound invocation budget.');
  release();
  for (const response of await Promise.all(running)) { assert.equal(response.status, 200); await response.arrayBuffer(); }
});

test('concurrent ownership validation cannot admit more than 32 active MCP calls', { timeout: 15000 }, async t => {
  let validated = 0, dispatched = 0, rejected = 0, validate, finish, allValidated, allRejected;
  const validation = new Promise(done => { validate = done; });
  const handlers = new Promise(done => { finish = done; });
  const barrier = new Promise(done => { allValidated = done; });
  const overflow = new Promise(done => { allRejected = done; });
  const gateway = await createOpenCodeGateway(() => {
    const server = new McpServer({ name: 'concurrent-admission-pressure', version: '1' });
    server.registerTool('check_run', { inputSchema: z.object({ title: z.string() }) }, async () => {
      dispatched++; await handlers;
      return { content: [{ type: 'text', text: '{"passed":true}' }] };
    });
    return server;
  }, async () => { if (++validated === 40) allValidated(); await validation; });
  const running = Array.from({ length: 40 }, (_, id) => fetch(gateway.url, {
    method: 'POST', signal: AbortSignal.timeout(10000), headers: {
      authorization: gateway.authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'check_run', arguments: { title: 'frozen check' } } }),
  }).then(response => { if (response.status === 503 && ++rejected === 8) allRejected(); return response; }));
  t.after(async () => { validate(); finish(); await Promise.allSettled(running); await gateway.close(); });
  await Promise.race([barrier, new Promise((_, reject) => setTimeout(() => reject(new Error('Ownership validation barrier was not reached.')), 5000).unref())]);
  validate();
  // The 32 admitted handlers stay active while the other eight receive 503.
  await Promise.race([overflow, new Promise((_, reject) => setTimeout(() => reject(new Error('Concurrent admission did not return eight overflow responses.')), 5000).unref())]);
  assert.equal(dispatched, 32);
  finish();
  const responses = await Promise.all(running);
  assert.equal(responses.filter(response => response.status === 200).length, 32);
  assert.equal(responses.filter(response => response.status === 503).length, 8);
  for (const response of responses) await response.arrayBuffer();
});
