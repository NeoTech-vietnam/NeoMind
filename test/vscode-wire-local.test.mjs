import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostRequest, serveHost, readHost, bridgeLimit } from '../dist/vscode-wire.js';

const pause = ms => new Promise(done => setTimeout(done, ms));
async function fixture(t, dispatch, options) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-wire-local-')), host = await serveHost(root, dispatch, options);
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, host, descriptor: readHost(root) };
}
const local = { prefer_local_dispatch: true };

test('only an explicit exact same-process capability uses local dispatch; default calls retain real HTTP', async t => {
  const calls = [], f = await fixture(t, async (operation, input) => { calls.push({ operation, input }); return { ok: true, value: input.value }; });
  const original = http.request; let sockets = 0;
  http.request = function(...args) { sockets++; return Reflect.apply(original, this, args); }; syncBuiltinESMExports();
  t.after(() => { http.request = original; syncBuiltinESMExports(); });
  const input = { value: { nested: 7 } };
  assert.deepEqual(await hostRequest(f.descriptor, 'result', input, undefined, local), { ok: true, value: input.value });
  assert.equal(sockets, 0); assert.notEqual(calls[0].input, input); assert.notEqual(calls[0].input.value, input.value);
  assert.deepEqual(await hostRequest(f.descriptor, 'result', input), { ok: true, value: input.value });
  assert.equal(sockets, 1, 'Opt-in is a trusted caller option, never inferred from same-process identity.');
  await hostRequest({ ...f.descriptor, pid: process.pid + 1 }, 'poll', input, undefined, local);
  assert.equal(sockets, 2, 'Other-process descriptors stay on HTTP.');
  await hostRequest({ ...f.descriptor, root: join(f.root, 'different-root') }, 'poll', input, undefined, local);
  assert.equal(sockets, 3, 'A different root cannot select the registered local capability.');
});

test('forged local tokens and instances do not bypass host authentication', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; return { ok: true }; });
  for (const descriptor of [{ ...f.descriptor, token: '0'.repeat(64) }, { ...f.descriptor, instance: '0'.repeat(64) }])
    await assert.rejects(hostRequest(descriptor, 'result', {}, undefined, local), /refused/);
  assert.equal(count, 0);
  assert.deepEqual(await hostRequest(f.descriptor, 'result', {}, undefined, local), { ok: true }); assert.equal(count, 1);
});

test('local delivery needs no TCP handshake after the shared event loop has been busy', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; return { accepted: count }; });
  const request = hostRequest(f.descriptor, 'result', {}, undefined, { ...local, connect_timeout_ms: 10,
    operation_timeouts_ms: { result: 1000 } });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  assert.deepEqual(await request, { accepted: 1 }); assert.equal(count, 1, 'The actual dispatch executes once; nothing was retried.');
});

test('local calls retain JSON size limits, server response budgets and cancellation without replay', async t => {
  let count = 0;
  const f = await fixture(t, async operation => {
    count++;
    if (operation === 'poll') await pause(100);
    if (operation === 'open') return { value: 'x'.repeat(bridgeLimit) };
    return { ok: true };
  }, { operation_timeouts_ms: { poll: 30 } });
  await assert.rejects(hostRequest(f.descriptor, 'result', { value: 'x'.repeat(bridgeLimit) }, undefined, local), /payload exceeds limit/);
  assert.equal(count, 0);
  await assert.rejects(hostRequest(f.descriptor, 'open', {}, undefined, local), /refused/); assert.equal(count, 1);
  await assert.rejects(hostRequest(f.descriptor, 'poll', { prefer_local_dispatch: true, operation_timeouts_ms: { poll: 60000 } }, undefined,
    { ...local, operation_timeouts_ms: { poll: 500 } }), error => error.code === 'BRIDGE_RESPONSE_TIMEOUT');
  assert.equal(count, 2, 'Untrusted input and a larger client ceiling cannot lengthen the actual server budget.');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(hostRequest(f.descriptor, 'result', {}, cancelled.signal, local), error => error.code === 'BRIDGE_CANCELLED');
  assert.equal(count, 2, 'Pre-cancelled requests never dispatch.');
  const active = new AbortController(), pending = hostRequest(f.descriptor, 'poll', {}, active.signal, local);
  await pause(5); active.abort();
  await assert.rejects(pending, error => error.code === 'BRIDGE_CANCELLED'); assert.equal(count, 3);
  await pause(120); assert.equal(count, 3, 'Cancellation preserves one uncertain original dispatch and never starts a replacement.');
});

test('closing the registered host invalidates the local capability', async t => {
  let count = 0;
  const f = await fixture(t, async () => ({ count: ++count }));
  assert.equal((await hostRequest(f.descriptor, 'poll', {}, undefined, local)).count, 1);
  await f.host.close();
  await assert.rejects(hostRequest(f.descriptor, 'poll', {}, undefined, local), /connection failed|descriptor is stale/);
  assert.equal(count, 1);
});

test('queued local admission rechecks closure and diagnostic callbacks cannot override authority or fail a request', async t => {
  let count = 0;
  const f = await fixture(t, async (_operation, input) => ({ count: ++count, value: input.value }));
  const observations = [], input = { value: 7 };
  const options = { ...local, on_dispatch(transport) { observations.push(transport); input.value = 999; throw new Error('Diagnostic failure is advisory.'); } };
  assert.deepEqual(await hostRequest(f.descriptor, 'result', input, undefined, options), { count: 1, value: 7 });
  await new Promise(done => setImmediate(done)); assert.deepEqual(observations, ['in-process']);
  await assert.rejects(hostRequest({ ...f.descriptor, token: '0'.repeat(64) }, 'result', input, undefined, options), /refused/);
  await new Promise(done => setImmediate(done)); assert.equal(observations.length, 1); assert.equal(count, 1);
  const queued = hostRequest(f.descriptor, 'result', {}, undefined, local), closing = f.host.close();
  await assert.rejects(queued, /refused/); await closing;
  assert.equal(count, 1, 'Closing before a queued local dispatch preserves the original lifecycle boundary.');
});

test('a real HTTP408 upload/response timeout is classified without parsing or exposing its body', async t => {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(408).end('SECRET_NON_JSON_TIMEOUT_BODY'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const descriptor = { protocol: 'neomind-vscode-lm-v1', root: process.cwd(), port: server.address().port,
    token: 'a'.repeat(64), instance: 'b'.repeat(64), pid: process.pid };
  await assert.rejects(hostRequest(descriptor, 'result', {}), error => {
    assert.equal(error.code, 'BRIDGE_RESPONSE_TIMEOUT'); assert.doesNotMatch(error.message, /SECRET_|Unexpected token/); return true;
  });
});

test('closing during an admitted asynchronous local operation never acknowledges a dead host', async t => {
  let release, entered;
  const ready = new Promise(done => { entered = done; }), pendingResult = new Promise(done => { release = done; });
  let count = 0;
  const f = await fixture(t, async () => { count++; entered(); await pendingResult; return { ok: true }; });
  const pending = hostRequest(f.descriptor, 'result', {}, undefined, local);
  await ready; await f.host.close(); release();
  await assert.rejects(pending, /refused/);
  assert.equal(count, 1, 'An admitted operation may retain effects; closing creates neither a successful acknowledgement nor a retry.');
});
