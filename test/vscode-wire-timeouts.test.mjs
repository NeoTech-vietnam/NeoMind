import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hostRequest, serveHost, readHost, bridgeProtocol } from '../dist/vscode-wire.js';

const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function endpoint(t, dispatch) {
  const server = createServer(async (req, res) => {
    req.resume();
    const value = await dispatch(req);
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  return { protocol: bridgeProtocol, root: process.cwd(), port: server.address().port, token: 'a'.repeat(64), instance: 'b'.repeat(64), pid: process.pid };
}

test('actual loopback response timeout is bounded and does not misdiagnose a live host as stale', async t => {
  const host = await endpoint(t, async () => { await pause(200); return { ok: true }; });
  await assert.rejects(hostRequest(host, 'poll', {}, undefined, {
    connect_timeout_ms: 1000, operation_timeouts_ms: { poll: 40 },
  }), /request timed out during poll/);
});

test('selection and result delivery have explicit larger budgets than lightweight polling', async t => {
  const host = await endpoint(t, async () => { await pause(100); return { ok: true }; });
  const options = { connect_timeout_ms: 1000, operation_timeouts_ms: { open: 500, result: 500, poll: 30 } };
  assert.deepEqual(await hostRequest(host, 'open', {}, undefined, options), { ok: true });
  assert.deepEqual(await hostRequest(host, 'result', {}, undefined, options), { ok: true });
  await assert.rejects(hostRequest(host, 'poll', {}, undefined, options), /timed out during poll/);
});

test('controlled admission and mutation have explicit trusted budgets while control status remains a separate observation', async t => {
  const calls = [];
  const host = await endpoint(t, async req => { calls.push(req.url); await pause(80); return { ok: true }; });
  const options = { operation_timeouts_ms: { 'controlled-start': 300, 'controlled-control': 300, 'controlled-status': 30 } };
  assert.deepEqual(await hostRequest(host, 'controlled-start', { request_id: 'stable-intake' }, undefined, options), { ok: true });
  assert.deepEqual(await hostRequest(host, 'controlled-control', { workflow_id: 'saved', action: 'pause' }, undefined, options), { ok: true });
  await assert.rejects(hostRequest(host, 'controlled-status', {}, undefined, options), /timed out during controlled-status/);
  assert.deepEqual(calls, ['/controlled-start', '/controlled-control', '/controlled-status']);
});

test('control calls after synchronous local work use fresh connections without replaying mutations', async t => {
  const observed = [];
  const host = await endpoint(t, req => {
    observed.push({ port: req.socket.remotePort, connection: req.headers.connection, operation: req.url });
    return { accepted: observed.length };
  });
  assert.deepEqual(await hostRequest(host, 'controlled-start', { request_id: 'first-mutation' }), { accepted: 1 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  assert.deepEqual(await hostRequest(host, 'controlled-start', { request_id: 'second-mutation' }), { accepted: 2 });
  assert.equal(observed.length, 2, 'Each mutation is sent exactly once.');
  assert.ok(observed.every(item => item.connection === 'close'), 'Control IPC must not enter the global keep-alive pool.');
  assert.notEqual(observed[0].port, observed[1].port);
});

test('actual connection refusal remains a stale/connection blocker and cancellation stays distinct', async t => {
  const unavailable = createServer(); await new Promise(done => unavailable.listen(0, '127.0.0.1', done));
  const port = unavailable.address().port; await new Promise(done => unavailable.close(done));
  const host = { protocol: bridgeProtocol, root: process.cwd(), port, token: 'a'.repeat(64), instance: 'b'.repeat(64), pid: process.pid };
  await assert.rejects(hostRequest(host, 'poll', {}, undefined, { connect_timeout_ms: 500 }), /connection failed or descriptor is stale/);
  const live = await endpoint(t, async () => { await pause(200); return { ok: true }; });
  const controller = new AbortController();
  const pending = hostRequest(live, 'poll', {}, controller.signal, { operation_timeouts_ms: { poll: 1000 } });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /request cancelled/);
});

test('authenticated server budgets preserve refusal checks and do not cap asynchronous model work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-wire-deadline-'));
  const calls = [];
  const host = await serveHost(root, async operation => {
    calls.push(operation);
    if (operation === 'run') return { state: 'running' };
    if (operation === 'poll') { await pause(120); return { state: 'running' }; }
    await pause(70); return { selected: true };
  }, { operation_timeouts_ms: { open: 400, run: 100, poll: 40 } });
  t.after(async () => { await host.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const descriptor = readHost(root);
  await assert.rejects(hostRequest({ ...descriptor, token: '0'.repeat(64) }, 'open', {}), /refused/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await hostRequest(descriptor, 'open', {}), { selected: true });
  assert.deepEqual(await hostRequest(descriptor, 'run', {}), { state: 'running' });
  await assert.rejects(hostRequest(descriptor, 'poll', {
    // Untrusted RPC input cannot lengthen the host's configured dispatch budget.
    operation_timeouts_ms: { poll: 60000 },
  }, undefined, { operation_timeouts_ms: { poll: 500 } }), /timed out during poll/);
  assert.deepEqual(calls, ['open', 'run', 'poll']);
});
