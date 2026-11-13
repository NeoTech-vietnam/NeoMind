import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeServer } from '../src/adapters/opencode-server.js';
import type { ProcessLaunch, ProcessScope } from '../src/adapters/worker-scope.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-opencode-server.js');

class FakeScope implements ProcessScope {
  identity = { unit: 'fake', controlGroup: 'fake' };
  launch?: ProcessLaunch;
  child?: ChildProcessWithoutNullStreams;
  stops = 0;
  constructor(private readonly confirmed = true) {}
  async start(launch: ProcessLaunch) {
    this.launch = launch;
    return this.child = spawn(process.execPath, [fake], { cwd: launch.cwd, env: launch.env, stdio: 'pipe' });
  }
  async isActive() { return !!this.child && this.child.exitCode === null; }
  async stop() { this.stops++; this.child?.kill(); return this.confirmed; }
}
const options = (scope: FakeScope, env: NodeJS.ProcessEnv = {}) => ({ scope, command: process.execPath, workspace: process.cwd(), configHome: 'config', dataHome: 'data', cacheHome: 'cache', config: { mcp: {} }, env, timeoutMs: 3000 });

test('OpenCode transport launches only in its scope, authenticates and closes', async () => {
  const scope = new FakeScope();
  const server = await OpenCodeServer.start(options(scope, { ...process.env, OPENCODE_SERVER_PASSWORD: 'inherited', OPENCODE_CONFIG: 'unsafe', PROVIDER_KEY: 'fixture' }));
  try {
    assert.deepEqual(scope.launch?.args, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0']);
    assert.equal(scope.launch?.cwd, process.cwd());
    assert.equal(scope.launch?.env.OPENCODE_CONFIG, undefined);
    assert.notEqual(scope.launch?.env.OPENCODE_SERVER_PASSWORD, 'inherited');
    assert.equal(scope.launch?.env.PROVIDER_KEY, 'fixture');
    assert.equal(scope.launch?.env.XDG_CONFIG_HOME, 'config');
    assert.equal(scope.launch?.env.XDG_DATA_HOME, 'data');
    assert.equal(scope.launch?.env.XDG_CACHE_HOME, 'cache');
    assert.deepEqual(await server.request('POST', '/test', { value: 1 }), { method: 'POST', body: { value: 1 } });
    await assert.rejects(server.request('GET', '//example.invalid/'), /path|origin/i);
    await assert.rejects(server.request('GET', '/redirect'));
    await assert.rejects(server.request('GET', '/error'), /HTTP 500/);
    assert.deepEqual(await server.request('GET', '/delayed', undefined, 1000), { ok: true });
    await assert.rejects(server.request('GET', '/delayed', undefined, 30), /abort/i);
  } finally { assert.equal(await server.close(), true); }
  assert.equal(scope.stops, 1);
});

test('OpenCode transport stops the scope on startup failure and reports unconfirmed stop', async () => {
  const scope = new FakeScope();
  await assert.rejects(OpenCodeServer.start(options(scope, { ...process.env, FAKE_MODE: 'exit' })), /exited/i);
  assert.equal(scope.stops, 1);
  const unconfirmed = new FakeScope(false);
  await assert.rejects(OpenCodeServer.start({ ...options(unconfirmed, { ...process.env, FAKE_MODE: 'hang' }), timeoutMs: 100 }), /stop unconfirmed/i);
  assert.equal(unconfirmed.stops, 1);
  await assert.rejects(OpenCodeServer.start({ ...options(new FakeScope()), command: 'opencode' }), /absolute/i);
});

test('OpenCode reports an unsupported pure flag without exposing stderr', async () => {
  const scope = new FakeScope();
  await assert.rejects(OpenCodeServer.start(options(scope, { ...process.env, FAKE_MODE: 'unsupported' })), error => {
    assert.match((error as Error).message, /rejected --pure.*not supported/);
    assert.doesNotMatch((error as Error).message, /private-token-value/);
    return true;
  });
  assert.equal(scope.stops, 1);
});

test('OpenCode V2 transport starts without --pure and rejects other server versions', async () => {
  const scope = new FakeScope();
  const server = await OpenCodeServer.start({ ...options(scope, { ...process.env, FAKE_MODE: 'v2' }), protocol: 'v2' });
  try {
    assert.deepEqual(scope.launch?.args, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
    assert.equal(await server.request('GET', '/empty'), undefined);
  } finally { assert.equal(await server.close(), true); }
  const other = new FakeScope();
  await assert.rejects(OpenCodeServer.start({ ...options(other, { ...process.env, FAKE_MODE: 'v2', FAKE_VERSION: '2.2.8' }), protocol: 'v2' }), /Unsupported OpenCode V2/);
  assert.equal(other.stops, 1);
});
