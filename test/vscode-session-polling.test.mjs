// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, readConfig } from '../dist/storage.js';
import { canonicalJson, ensureRoutingPolicy, routingConfigurationHashes } from '../dist/routing.js';
import { VSCodeSession } from '../dist/vscode-session.js';
import { bridgeProtocol } from '../dist/vscode-wire.js';
import { roleCapabilities } from '../dist/tools.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise(done => setImmediate(done));
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await turn(); }
  assert.fail('Isolated loopback fixture did not reach its expected asynchronous boundary.');
}
async function fixture(t, callTool) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-polling-'));
  initialize(root, { project_id: 'POLLING' });
  const policy = { ...ensureRoutingPolicy(root), vscode_effort_policy: 'allow-unavailable' };
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  writeFileSync(join(root, '.neomind/tools.json'), JSON.stringify({ providers: [] }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem);
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true }); mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.neomind/native/keys/${keyId}.pem`), pem);
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  const id = randomUUID(), scope = roleCapabilities('developer').operations, receipt = { schema_version: 1, issuer: 'neomind-vscode-lm', id, role: 'developer', state: 'running', output: '',
    receipt_path: `.neomind/native/receipts/${id}.json`, project_id: readConfig(root).project_id, key_id: keyId,
    execution_mode: 'vscode-extension-host', identity_provenance: 'local-vscode-extension-host', host_instance: 'b'.repeat(64),
    protocol_sha256: hash('neomind-vscode-lm-v1'), runtime_integrity: '', native_sandbox: null, owner_pid: process.pid,
    native_thread_id: `vscode-host:conversation:${randomUUID()}`, native_turn_id: `vscode-host:turn:${randomUUID()}`,
    native_tool_scope: scope, gateway_policy_sha256: hash(canonicalJson(scope)), configuration_hashes: routingConfigurationHashes(root),
    client_version: '1.109.0', effort_support: 'unavailable', reasoning_effort: 'low', confirmed_reasoning_effort: null,
    requested_model: policy.worker_models[0], confirmed_model: policy.worker_models[0], model_provider: 'copilot',
    workflow_id: null, task_id: null, routing_sha256: hash(canonicalJson(policy)), inference_completed: false, reroutes: [] };
  writeFileSync(join(root, receipt.receipt_path), JSON.stringify({ ...receipt, signature: sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64') }));
  const queue = [], requests = [], delivered = [], completions = [];
  let output = '', beforePoll;
  const server = createServer(async (req, res) => {
    const operation = req.url.slice(1); req.resume(); requests.push({ operation, at: Date.now() });
    if (operation === 'poll' && beforePoll) { const action = beforePoll; beforePoll = undefined; action(); }
    const result = operation === 'poll' ? { state: 'running', output, events: queue.splice(0) }
      : operation === 'run' ? { state: 'running' } : { ok: true };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const session = new VSCodeSession(root, receipt, patch => Object.assign(receipt, patch), async (state, error) => { completions.push({ state, error }); });
  // Exercise actual polling/tool delivery over loopback, without model selection.
  session.host = { protocol: bridgeProtocol, root, port: server.address().port, token: 'a'.repeat(64), instance: 'b'.repeat(64), pid: process.pid };
  session.client = { close: async () => {}, callTool: async (...args) => {
    delivered.push(args[0]); return callTool ? callTool(...args) : { content: [{ type: 'text', text: '{"saved":true}' }] };
  } };
  t.after(async () => { t.mock.timers.reset(); await session.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }); });
  return { root, session, queue, requests, delivered, completions, setOutput: value => { output = value; },
    beforeNextPoll: action => { beforePoll = action; }, polls: () => requests.filter(request => request.operation === 'poll') };
}
async function idle(f) { await until(() => f.completions.length || f.session.stopped || typeof f.session.releaseDelay === 'function'); }
async function advance(t, f, ms) { t.mock.timers.tick(ms); await turn(); await idle(f); }
async function begin(t, f) { t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 }); await f.session.run(); await idle(f); }
async function reachCap(t, f) { await advance(t, f, 50); await advance(t, f, 100); await advance(t, f, 200); }

test('empty polling backs off to250ms while every poll still freshly reads the complete configuration', async t => {
  const f = await fixture(t), original = fs.readFileSync, tools = resolve(f.root, '.neomind/tools.json');
  let configReads = 0;
  fs.readFileSync = function (path, ...args) { if (typeof path === 'string' && resolve(path) === tools) configReads++; return original.call(this, path, ...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.readFileSync = original; syncBuiltinESMExports(); });
  await begin(t, f);
  for (let i = 0; i < 40; i++) await advance(t, f, 50);
  const times = f.polls().map(request => request.at - 100000);
  assert.deepEqual(times, [0, 50, 150, 350, 600, 850, 1100, 1350, 1600, 1850]);
  assert.equal(configReads, times.length, 'No configuration check was cached or skipped.');
  await f.session.close(); await f.session.polling;
});

test('events and output changes reset idle polling promptly without waiting for another250ms interval', async t => {
  const f = await fixture(t);
  await begin(t, f); await reachCap(t, f);
  f.queue.push({ call_id: 'activity', name: 'task_file_write', input: { path: 'value.txt', content: 'bounded fixture' } });
  await advance(t, f, 250);
  await until(() => f.requests.some(request => request.operation === 'result') && f.session.jobs.size === 0);
  assert.equal(f.delivered.length, 1);
  // Tool-result acknowledgement wakes the idle wait and resets the next delay.
  await turn(); await idle(f);
  const before = f.polls().length;
  await advance(t, f, 50);
  assert.ok(f.polls().length > before, 'Activity returns polling to its50ms response cadence.');
  await reachCap(t, f);
  f.setOutput('new model output');
  await advance(t, f, 250);
  assert.equal(f.session.receipt.output, 'new model output');
  const afterOutput = f.polls().length;
  await advance(t, f, 50);
  assert.ok(f.polls().length > afterOutput);
  await f.session.close(); await f.session.polling;
});

test('configuration revocation during maximum idle rejects a queued write before tool dispatch', async t => {
  let root;
  const f = await fixture(t, async () => { writeFileSync(join(root, 'forbidden.txt'), 'must never be written'); return { content: [] }; }); root = f.root;
  await begin(t, f); await reachCap(t, f);
  writeFileSync(join(root, '.neomind/tools.json'), JSON.stringify({ providers: ['changed-after-idle'] }));
  f.queue.push({ call_id: 'revoked-write', name: 'task_file_write', input: { path: 'forbidden.txt', content: 'must never be written' } });
  await advance(t, f, 250);
  assert.match(f.completions[0]?.error, /configuration changed/);
  assert.equal(f.completions[0]?.state, 'blocked');
  assert.equal(f.delivered.length, 0); assert.equal(existsSync(join(root, 'forbidden.txt')), false);
  assert.equal(f.polls().length, 4, 'Fresh validation occurs before retrieving or dispatching the queued mutation.');
  await f.session.close(); await f.session.polling;
});

test('revocation inside a poll response is revalidated before its queued write can run', async t => {
  let root;
  const f = await fixture(t, async () => { writeFileSync(join(root, 'forbidden.txt'), 'must never be written'); return { content: [] }; }); root = f.root;
  await begin(t, f); await reachCap(t, f);
  f.beforeNextPoll(() => writeFileSync(join(root, '.neomind/tools.json'), JSON.stringify({ providers: ['revoked-during-poll'] })));
  f.queue.push({ call_id: 'revoked-in-response', name: 'task_file_write', input: { path: 'forbidden.txt', content: 'must never be written' } });
  await advance(t, f, 250); await until(() => f.completions.length > 0);
  assert.equal(f.completions[0].state, 'blocked');
  assert.equal(f.delivered.length, 0);
  assert.equal(existsSync(join(root, 'forbidden.txt')), false, 'Queued events cannot inherit a pre-response authorization snapshot.');
  assert.equal(f.requests.filter(request => request.operation === 'result').length, 0);
  await f.session.close(); await f.session.polling;
});

test('a configuration change during tool work prevents committing its result to the host', async t => {
  let root;
  const f = await fixture(t, async () => {
    writeFileSync(join(root, '.neomind/tools.json'), JSON.stringify({ providers: ['revoked-during-tool'] }));
    return { content: [{ type: 'text', text: '{"saved":true}' }] };
  }); root = f.root;
  f.queue.push({ call_id: 'changed-before-result', name: 'task_file_write', input: { path: 'value.txt', content: 'fixture' } });
  await begin(t, f); await until(() => f.completions.length > 0);
  assert.equal(f.delivered.length, 1, 'The operation started while its configuration was still current.');
  assert.equal(f.completions[0].state, 'blocked');
  assert.equal(f.requests.filter(request => request.operation === 'result').length, 0, 'Result delivery must freshly revalidate the binding.');
  await f.session.close(); await f.session.polling;
});

test('close interrupts maximum idle immediately and never starts another poll', async t => {
  const f = await fixture(t);
  await begin(t, f); await reachCap(t, f);
  const at = Date.now(), polls = f.polls().length;
  await f.session.close(); await f.session.polling;
  assert.equal(Date.now(), at, 'Closing does not need a fake-clock tick or an idle timer expiry.');
  assert.equal(f.polls().length, polls);
  assert.equal(f.requests.filter(request => request.operation === 'cancel').length, 1);
  assert.equal(f.session.releaseDelay, undefined);
});

test('a long tool permits empty backoff while close cancels and still drains its in-flight delivery', async t => {
  const entered = deferred(), aborted = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, async (_input, _unused, options) => {
    entered.resolve(); await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => {
      aborted.resolve(); void release.promise.then(() => reject(new Error('Fixture tool cancelled and drained.')));
    }, { once: true }); });
  });
  f.queue.push({ call_id: 'long-check', name: 'task_file_write', input: { path: 'bounded.txt', content: 'fixture' } });
  await begin(t, f); await entered.promise;
  for (let i = 0; i < 20; i++) await advance(t, f, 50);
  assert.ok(f.polls().length <= 8, 'A nonempty job set alone cannot keep polling at50ms.');
  let closed = false; const closing = f.session.close().then(() => { closed = true; });
  await aborted.promise; await turn();
  assert.equal(closed, false, 'Closing retains the original in-flight drain obligation.');
  release.resolve(); await closing; await f.session.polling;
  assert.equal(closed, true);
});

test('completion of a long tool wakes maximum idle and restores50ms polling without a clock tick', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return { content: [{ type: 'text', text: '{"saved":true}' }] }; });
  f.queue.push({ call_id: 'finish-long-tool', name: 'task_file_write', input: { path: 'value.txt', content: 'fixture' } });
  await begin(t, f); await entered.promise;
  for (let i = 0; i < 20; i++) await advance(t, f, 50);
  const before = f.polls().length, at = Date.now();
  release.resolve(); await until(() => f.session.jobs.size === 0); await idle(f);
  assert.ok(f.polls().length > before, 'Completed tool delivery wakes metadata retrieval immediately.');
  assert.equal(Date.now(), at);
  const after = f.polls().length;
  await advance(t, f, 50); assert.ok(f.polls().length > after);
  await f.session.close(); await f.session.polling;
});
