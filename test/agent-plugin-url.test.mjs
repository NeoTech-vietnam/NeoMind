import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initialize } from '../dist/storage.js';
import { createPluginServer } from '../scripts/agent-plugin/server.mjs';

const protocolTest = (name, fn) => test(name, { timeout: 7000 }, fn);
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const intakeNames = ['request_control', 'request_status', 'request_submit'];
const jsonResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const body = result => result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
const canonical = path => realpathSync.native(path);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'workforce URL plugin '));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, closers,
    project(name, initialized = true) {
      const project = join(directory, name); mkdirSync(project);
      if (initialized) initialize(project, { platforms: ['copilot'] });
      return project;
    },
  };
}

async function connection(f, roots, options = {}) {
  const holder = { roots: roots.map(path => ({ uri: pathToFileURL(path).href })) };
  const plugin = await createPluginServer({
    discoverRuntime: () => ({ state: 'ready', runtime }),
    rootsTimeoutMs: 1000,
    ...options,
  });
  const client = new Client({ name: 'workforce-url-plugin-test', version: '1' }, {
    capabilities: options.noRoots ? {} : { roots: { listChanged: true } },
  });
  if (!options.noRoots) client.setRequestHandler(ListRootsRequestSchema, () => options.listRoots ? options.listRoots(holder) : ({ roots: holder.roots }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  f.closers.push(async () => { await client.close(); await plugin.close(); });
  await Promise.all([plugin.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client, holder, plugin,
    async changeRoots(paths) {
      holder.roots = paths.map(path => ({ uri: pathToFileURL(path).href }));
      await client.notification({ method: 'notifications/roots/list_changed' });
    },
    async status(arguments_ = {}) {
      return body(await client.callTool({ name: 'workforce_connection', arguments: arguments_ }));
    },
  };
}

function backendFactory() {
  const calls = [], launches = [], closes = [];
  return {
    calls, launches, closes,
    connectBackend: async ({ runtime: selectedRuntime, root }) => {
      launches.push({ runtime: selectedRuntime, root });
      return {
        async listTools() {
          return { tools: intakeNames.map(name => ({ name, description: name, inputSchema: { type: 'object' } })) };
        },
        async callTool(request) {
          calls.push({ root, request });
          return jsonResult({ root, received: request });
        },
        async close() { closes.push(root); },
      };
    },
  };
}

protocolTest('URL plugin initializes without a configured runtime and explains setup through a tool', async t => {
  const f = fixture(t), project = f.project('initialized workspace');
  const missing = await connection(f, [project], {
    discoverRuntime: () => ({ state: 'missing', code: 'RUNTIME_NOT_CONFIGURED', summary: 'Set the installed WorkForce runtime in User settings.' }),
  });
  assert.deepEqual((await missing.client.listTools()).tools.map(tool => tool.name), ['workforce_connection']);
  const status = await missing.status();
  assert.equal(status.code, 'RUNTIME_NOT_CONFIGURED');
  assert.deepEqual(readdirSync(f.directory), ['initialized workspace'], 'Setup status must not download or install anything.');
});

protocolTest('MCP Roots supplies authority; no-folder and unsupported clients never fall back to the plugin cwd', async t => {
  const f = fixture(t), backend = backendFactory();
  const empty = await connection(f, [], backend);
  assert.equal((await empty.status()).code, 'OPEN_WORKSPACE');
  const unsupported = await connection(f, [], { ...backend, noRoots: true });
  assert.equal((await unsupported.status()).code, 'ROOTS_UNSUPPORTED');
  assert.equal(backend.launches.length, 0);
});

protocolTest('an uninitialized exposed folder remains unchanged and requests initialization', async t => {
  const f = fixture(t), project = f.project('ordinary workspace', false), backend = backendFactory();
  const session = await connection(f, [project], backend);
  assert.equal((await session.status()).code, 'INITIALIZE_WORKSPACE');
  assert.equal(backend.launches.length, 0);
  assert.deepEqual(readdirSync(project), []);
});

protocolTest('a linked WorkForce configuration directory cannot import another project state', async t => {
  const f = fixture(t), project = f.project('project', false), outside = f.project('other project'), backend = backendFactory();
  try { symlinkSync(join(outside, '.workforce'), join(project, '.workforce'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Creating links is unavailable on this host.'); return; } throw error; }
  const session = await connection(f, [project], backend);
  assert.equal((await session.status()).code, 'INITIALIZE_WORKSPACE');
  assert.equal(backend.launches.length, 0);
});

protocolTest('one project with spaces binds automatically and forwards only the original intake request unchanged', async t => {
  const f = fixture(t), project = f.project('project with spaces'), backend = backendFactory();
  const session = await connection(f, [project], backend);
  assert.equal((await session.status()).state, 'ready');
  const names = (await session.client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [...intakeNames, 'workforce_connection'].sort());
  const input = { requirement: 'Read this ordinary requirement verbatim.', new_request: true, context: [{ path: '.', kind: 'directory' }] };
  const result = body(await session.client.callTool({ name: 'request_submit', arguments: input }));
  assert.equal(canonical(result.root), canonical(project));
  assert.deepEqual(result.received, { name: 'request_submit', arguments: input });
  assert.equal(backend.calls.length, 1, 'Forward once, without creating request IDs or retrying.');
  assert.equal(backend.launches.length, 1, 'Status/list/call reuse the same bound backend.');
  let rejected = false;
  try { rejected = (await session.client.callTool({ name: 'assignment_claim', arguments: { claim_token: 'invented' } })).isError === true; }
  catch { rejected = true; }
  assert.equal(rejected, true);
  assert.equal(backend.calls.length, 1, 'Legacy or unknown methods are not forwarded.');
});

protocolTest('two plugin clients in different workspaces cannot mix roots or backend instances', async t => {
  const f = fixture(t), a = f.project('A'), b = f.project('B'), backend = backendFactory();
  const [sessionA, sessionB] = await Promise.all([connection(f, [a], backend), connection(f, [b], backend)]);
  const [resultA, resultB] = await Promise.all([
    sessionA.client.callTool({ name: 'request_status', arguments: {} }),
    sessionB.client.callTool({ name: 'request_status', arguments: {} }),
  ]);
  assert.equal(canonical(body(resultA).root), canonical(a));
  assert.equal(canonical(body(resultB).root), canonical(b));
  assert.equal(backend.launches.length, 2);
});

protocolTest('multi-root selection accepts only roots actually exposed by this client', async t => {
  const f = fixture(t), a = f.project('A'), b = f.project('B'), outsider = f.project('unexposed'), backend = backendFactory();
  const session = await connection(f, [a, b], backend);
  assert.equal((await session.status()).code, 'SELECT_WORKSPACE');
  assert.equal(backend.launches.length, 0);
  assert.equal((await session.status({ workspace_uri: pathToFileURL(outsider).href })).code, 'WORKSPACE_NOT_EXPOSED');
  assert.equal(backend.launches.length, 0);
  assert.equal((await session.status({ workspace_uri: pathToFileURL(b).href })).state, 'ready');
  const result = body(await session.client.callTool({ name: 'request_status', arguments: {} }));
  assert.equal(canonical(result.root), canonical(b));
});

protocolTest('roots changes discard the old child before another operation is forwarded', async t => {
  const f = fixture(t), a = f.project('A'), b = f.project('B'), backend = backendFactory();
  const session = await connection(f, [a], backend);
  await session.client.callTool({ name: 'request_status', arguments: {} });
  await session.changeRoots([b]);
  const result = body(await session.client.callTool({ name: 'request_status', arguments: {} }));
  assert.equal(canonical(result.root), canonical(b));
  assert.deepEqual(backend.closes.map(canonical), [canonical(a)]);
  await session.changeRoots([]);
  assert.equal((await session.status()).code, 'OPEN_WORKSPACE');
  assert.equal(backend.launches.length, 2);
});

protocolTest('simultaneous first operations share one backend connection', async t => {
  const f = fixture(t), project = f.project('project'), backend = backendFactory();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let connecting;
  const started = new Promise(resolve => { connecting = resolve; });
  const session = await connection(f, [project], {
    connectBackend: async input => { connecting(); await wait; return backend.connectBackend(input); },
  });
  const first = session.client.callTool({ name: 'request_status', arguments: {} });
  const second = session.client.callTool({ name: 'request_status', arguments: {} });
  await started;
  release();
  await Promise.all([first, second]);
  assert.equal(backend.launches.length, 1);
  assert.equal(backend.calls.length, 2);
});

protocolTest('workspace removal during backend startup cannot redirect or dispatch an old submission', async t => {
  const f = fixture(t), a = f.project('A'), b = f.project('B'), backend = backendFactory();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let connecting;
  const started = new Promise(resolve => { connecting = resolve; });
  let delay = true;
  const session = await connection(f, [a], {
    connectBackend: async input => { if (delay) { connecting(); await wait; } return backend.connectBackend(input); },
  });
  const submission = session.client.callTool({ name: 'request_submit', arguments: { requirement: 'belongs to A', new_request: true } });
  await started;
  await session.changeRoots([b]);
  // Request a fresh roots snapshot before allowing the old child to finish.
  const newState = session.status();
  delay = false;
  release();
  const outcome = await submission;
  await newState;
  assert.equal(outcome.isError, true, 'The stale submission must end before any backend mutation.');
  assert.equal(backend.calls.length, 0);
  const status = body(await session.client.callTool({ name: 'request_status', arguments: {} }));
  assert.equal(canonical(status.root), canonical(b));
});

protocolTest('a roots response arriving after a workspace-change notification cannot dispatch stale work', async t => {
  const f = fixture(t), a = f.project('A'), b = f.project('B'), backend = backendFactory();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let delay = true;
  const session = await connection(f, [a], {
    ...backend,
    listRoots: async holder => {
      const snapshot = { roots: holder.roots };
      if (delay) { began(); await gate; }
      return snapshot;
    },
  });
  const submission = session.client.callTool({ name: 'request_submit', arguments: { requirement: 'belongs to A', new_request: true } });
  await started;
  await session.changeRoots([b]);
  delay = false;
  release();
  const result = await submission;
  assert.equal(result.isError, true);
  assert.equal(body(result).code, 'WORKSPACE_CHANGED');
  assert.equal(backend.launches.length, 0);
  assert.equal(backend.calls.length, 0);
  assert.equal((await session.status()).state, 'ready');
  assert.equal(canonical(backend.launches[0].root), canonical(b));
});

protocolTest('runtime discovery cannot give old roots the new workspace generation', async t => {
  const f = fixture(t), a = f.project('A'), b = f.project('B'), backend = backendFactory();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let delay = true;
  const session = await connection(f, [a], {
    ...backend,
    discoverRuntime: async () => { if (delay) { began(); await gate; } return { state: 'ready', runtime }; },
  });
  const submission = session.client.callTool({ name: 'request_submit', arguments: { requirement: 'belongs to A', new_request: true } });
  await started;
  await session.changeRoots([b]);
  delay = false;
  release();
  const result = await submission;
  assert.equal(result.isError, true);
  assert.equal(body(result).code, 'WORKSPACE_CHANGED');
  assert.equal(backend.launches.length, 0);
  assert.equal(backend.calls.length, 0);
  assert.equal((await session.status()).state, 'ready');
  assert.equal(canonical(backend.launches[0].root), canonical(b));
});

protocolTest('an explicit connection recheck can recover a failed setup without replaying a product operation', async t => {
  const f = fixture(t), project = f.project('project'), backend = backendFactory();
  let connections = 0;
  const session = await connection(f, [project], {
    connectBackend: async input => { if (++connections === 1) throw new Error('SECRET_SETUP_DIAGNOSTIC'); return backend.connectBackend(input); },
  });
  const failed = await session.status();
  assert.equal(failed.code, 'RUNTIME_CONNECTION_FAILED');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_SETUP_DIAGNOSTIC/);
  assert.equal((await session.status()).state, 'ready');
  assert.equal(connections, 2);
  assert.equal(backend.calls.length, 0);
});

protocolTest('backend transport failures are not replayed and do not expose provider error contents', async t => {
  const f = fixture(t), project = f.project('project'), calls = [];
  const session = await connection(f, [project], {
    connectBackend: async () => ({
      listTools: async () => ({ tools: intakeNames.map(name => ({ name, inputSchema: { type: 'object' } })) }),
      callTool: async request => { calls.push(request); throw new Error('SECRET_PROVIDER_HEADER_VALUE'); },
      close: async () => {},
    }),
  });
  const result = await session.client.callTool({ name: 'request_submit', arguments: { requirement: 'ordinary request', new_request: true } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PROVIDER_HEADER_VALUE/);
  assert.equal(calls.length, 1, 'A lost response must not create a second submission.');
});

test('URL proxy reaches the real existing runtime MCP through stdio without any model call', { timeout: 35_000 }, async t => {
  const f = fixture(t), project = f.project('real runtime project');
  const session = await connection(f, [project], { backendTimeoutMs: 20_000 });
  const names = (await session.client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [...intakeNames, 'workforce_connection'].sort());
  const result = await session.client.callTool({ name: 'request_status', arguments: {} }, undefined, { timeout: 25_000 });
  assert.notEqual(result.isError, true);
  assert.deepEqual(body(result), { requests: [] });
});
