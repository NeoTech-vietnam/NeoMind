import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../extensions/vscode-model-bridge/managed-gateway-host.cjs', import.meta.url), 'utf8');

test('native-core release defers gateway settings and activation while retaining the reviewed future implementation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['workforce.gateway.tokenSaving'], undefined);
  assert.equal(manifest.files.includes('managed-gateway-host.cjs'), false);
  assert.match(source, /configureTokenSaving/);
});

function fixture(t, { globalMode, workspaceMode = 'upstream-rtk', configure, runtimeGate, acquireHook } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-gateway-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), runtime = join(root, 'runtime'); mkdirSync(project); mkdirSync(join(runtime, 'resources/managed-gateway'), { recursive: true });
  writeFileSync(join(runtime, 'resources/managed-gateway/9router-0.5.116.tgz'), 'Owned host fixture; installer is stubbed.');
  const state = { globalMode, calls: [], clients: [], commands: new Map(), closed: 0 }, module = { exports: {} };
  let providerOptions;
  class EventEmitter { event() { return { dispose() {} }; } fire() {} dispose() {} }
  const vscode = { EventEmitter, workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: project } }],
    getConfiguration() { return { inspect(key) { return key === 'tokenSaving' ? { globalValue: state.globalMode, workspaceValue: workspaceMode } :
      key === 'nodePath' ? { globalValue: process.execPath } : {}; } }; } },
    lm: { registerLanguageModelChatProvider(id) { state.calls.push(['register', id]); return { dispose() {} }; } },
    commands: { registerCommand(id, callback) { state.commands.set(id, callback); return { dispose() {} }; } } };
  const service = {
    async configureTokenSaving(mode) { state.calls.push(['configure', mode]); return configure ? configure(mode) :
      { requested: mode, effective: mode, deferred: false, reason: 'unchanged', fingerprint: 'a'.repeat(64) }; },
    async acquire(signal) { state.calls.push(['acquire']); await acquireHook?.(); return { baseUrl: 'http://127.0.0.1:19191', generation: 'owned', signal,
      release() { state.calls.push(['release']); } }; },
    getApiKey() { return 'owned-fixture-key'; }, getAdminCookie() { return 'owned-fixture-cookie'; },
    async dispose() { state.closed++; },
  };
  const api = { async installManagedGateway() { state.calls.push(['install']); }, createManagedGatewayService() { return service; },
    createManagedGatewayClient(endpoint, options) { state.clients.push({ endpoint, options }); return { async status() { return {}; } }; } };
  runInNewContext(source, { module, process, require(name) {
    if (name === './managed-gateway-provider.cjs') return { createGatewayChatProvider(_vscode, options) { providerOptions = options; return {}; } };
    return require(name);
  } });
  const owner = module.exports.activateManagedGateway(vscode, { subscriptions: [], globalStorageUri: { fsPath: join(root, 'private') },
    globalState: { get() { return true; } }, secrets: {} }, async () => { await runtimeGate; return api; }, () => runtime);
  t.after(() => owner.dispose());
  return { state, service, owner, options: providerOptions };
}

test('gateway host reads only User RTK policy; a workspace cannot enable it and default stays off', async t => {
  const { state, options } = fixture(t);
  const lease = await options.service.acquire(); options.client(lease);
  assert.equal(lease.tokenSaving, 'off'); assert.equal(state.clients[0].options.tokenSaving, 'off');
  assert.deepEqual(state.calls.slice(-2), [['configure', 'off'], ['acquire']]); lease.release();
  assert.equal(state.calls.filter(([kind]) => kind === 'install').length, 1);
});

test('effective token policy is frozen per invocation while a changed User setting applies to the next call', async t => {
  const { state, options } = fixture(t, { globalMode: 'upstream-rtk' });
  const first = await options.service.acquire(); state.globalMode = 'off'; options.client(first);
  const second = await options.service.acquire(); options.client(second);
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.tokenSavingPolicy), true);
  assert.equal(first.tokenSaving, 'upstream-rtk'); assert.equal(second.tokenSaving, 'off');
  assert.deepEqual(state.clients.map(row => row.options.tokenSaving), ['upstream-rtk', 'off']);
  assert.deepEqual(state.calls.filter(([kind]) => kind === 'configure'), [['configure', 'upstream-rtk'], ['configure', 'off']]);
  first.release(); second.release();
});

test('optional RTK defer or administration failure keeps the model lease available with explicit off and sanitized metadata', async t => {
  for (const configure of [async () => ({ effective: 'off', deferred: true, reason: 'active-calls', fingerprint: 'a'.repeat(64), secret: 'SECRET' }),
    async () => { throw Error('SECRET upstream response'); }]) {
    const { state, options } = fixture(t, { globalMode: 'upstream-rtk', configure });
    const lease = await options.service.acquire(); options.client(lease);
    assert.equal(lease.tokenSaving, 'off'); assert.equal(lease.tokenSavingPolicy.deferred, true);
    assert.equal(state.clients[0].options.tokenSaving, 'off'); assert.equal(JSON.stringify(lease.tokenSavingPolicy).includes('SECRET'), false);
    assert.equal(state.calls.filter(([kind]) => kind === 'acquire').length, 1); lease.release();
  }
});

test('User policy is captured before asynchronous preparation and cancelled admission does not configure or acquire', async t => {
  let resolve; const runtimeGate = new Promise(done => { resolve = done; });
  const { state, options } = fixture(t, { globalMode: 'upstream-rtk', runtimeGate });
  const pending = options.service.acquire(); state.globalMode = 'off'; resolve();
  const lease = await pending; assert.equal(lease.tokenSaving, 'upstream-rtk'); lease.release();
  const count = state.calls.length, controller = new AbortController(); controller.abort();
  await assert.rejects(options.service.acquire(controller.signal), error => error.code === 'GATEWAY_CANCELLED');
  assert.equal(state.calls.length, count);
});

test('invalid optional User token policy safely remains off without enabling an upstream saver', async t => {
  const { state, options } = fixture(t, { globalMode: 'invalid-secret-policy' });
  const lease = await options.service.acquire(); options.client(lease);
  assert.equal(lease.tokenSaving, 'off'); assert.equal(lease.tokenSavingPolicy.reason, 'invalid-user-policy');
  assert.equal(state.calls.some(([kind]) => kind === 'configure'), false); lease.release();
});

test('closing during optional configuration drains admission and cannot restart or acquire the disposed service', async t => {
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const { state, owner, options } = fixture(t, { globalMode: 'upstream-rtk', configure: async () => { started(); await gate;
    return { effective: 'upstream-rtk', deferred: false, reason: 'configured' }; } });
  const pending = options.service.acquire(); const failure = assert.rejects(pending, error => error.name === 'CancellationError');
  await entered; const closing = owner.dispose(); assert.equal(state.closed, 0);
  finish(); await Promise.all([closing, failure]);
  assert.equal(state.closed, 1); assert.equal(state.calls.some(([kind]) => kind === 'acquire'), false);
  await assert.rejects(options.service.acquire(), error => error.code === 'GATEWAY_CANCELLED');
});

test('a lease arriving after close is released before the owned service stops', async t => {
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const { state, owner, options } = fixture(t, { acquireHook: async () => { started(); await gate; } });
  const pending = options.service.acquire(); const failure = assert.rejects(pending, error => error.name === 'CancellationError');
  await entered; const closing = owner.dispose(); assert.equal(state.closed, 0); finish();
  await Promise.all([closing, failure]);
  assert.equal(state.calls.filter(([kind]) => kind === 'release').length, 1); assert.equal(state.closed, 1);
});
