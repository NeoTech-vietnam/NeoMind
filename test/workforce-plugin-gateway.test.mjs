import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createWorkForcePluginGateway } from '../dist/workforce-plugin-gateway.js';

// Isolated host dependency fixtures, not evidence of real plug-in/provider access.
// Production uses readInvocation/assertRouting and pinned ready registration.
const temporary = resolve('artifacts/test-temp');
function fixture(t, role = 'developer') {
  mkdirSync(temporary, { recursive: true }); const root = mkdtempSync(join(temporary, 'wf-plugin-gateway-'));
  writeFileSync(join(root, 'public.ts'), 'export const publicValue = 42;');
  t.after(() => { assert.equal(dirname(resolve(root)), temporary); rmSync(root, { recursive: true, force: true }); });
  const binding = { workflow_id: 'WF-WORKFLOW', invocation_id: 'owned-invocation', task_id: 'WF-TASK', process_contract: 'workforce/v1',
    role, stage: role === 'verifier' ? 'verification' : role === 'manager' ? 'planning' : 'implementation',
    implementation_paths: ['products'], verification_paths: ['checks'], read_paths: ['.'], plugin_capabilities: true };
  const receipt = { id: binding.invocation_id, workflow_id: binding.workflow_id, task_id: binding.task_id, role, state: 'running',
    controlled_execution: { process_contract: 'workforce/v1', stage: binding.stage }, native_tool_scope: ['capability_invoke'] };
  const state = { status: 'ready', network: 'remote-enabled', connected: 0, closed: 0, calls: [], routes: [],
    tools: [
      { name: 'query-docs', description: 'Query docs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
      { name: 'codegraph_explore', inputSchema: { type: 'object', properties: { projectPath: { type: 'string' }, query: { type: 'string' }, file_path: { type: 'string' }, nested: { type: 'object' } }, required: ['projectPath'], additionalProperties: false } },
      { name: 'binary_session', inputSchema: { type: 'object', additionalProperties: false } },
      { name: 'browser_navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
      { name: 'browser_take_screenshot', inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'], additionalProperties: false } },
      { name: 'unreviewed_admin_tool', inputSchema: { type: 'object' } },
    ] };
  const dependencies = {
    invocation(_root, id) { assert.equal(id, binding.invocation_id); return receipt; },
    routing(_root, expectedRole, id, scope) { state.routes.push({ expectedRole, id, scope }); },
    registration(_root, id) { return { status: state.status, server: { command: process.execPath,
      args: id === 'codegraph' ? ['fixture-server.mjs', 'serve', '--mcp', '--path', root] : [], env: { API_KEY: 'DO-NOT-EXPOSE' } }, tools: [] }; },
    automation() { return { network_policy: state.network }; },
    record(_root, id) { assert.equal(id, binding.task_id); return { meta: { data: { allowed_urls: ['http://localhost:3000', 'https://example.invalid'] } } }; },
    async connect(connectionRoot, _id, registration) { state.connected++; state.connectionRoot = connectionRoot; state.registration = registration;
      return { tools: state.tools, async call(name, args) { state.calls.push({ name, args }); return { content: [{ type: 'text', text: 'real fixture result' }] }; }, async close() { state.closed++; } }; },
  };
  const gateway = createWorkForcePluginGateway(dependencies); t.after(() => gateway.close());
  return { root, binding, receipt, state, gateway, dependencies };
}
const denied = error => error.code === 'PLUGIN_SCOPE_DENIED';

test('disabled or unready plug-ins never connect/install and do not become execution prerequisites', async t => {
  const { root, binding, state, gateway } = fixture(t);
  for (const status of ['disabled', 'missing', 'blocked']) {
    state.status = status;
    const result = await gateway.invoke(root, binding, { provider: 'context7' });
    assert.equal(result.available, false); assert.equal(result.status, status); assert.equal(state.connected, 0);
  }
});

test('observed provider schemas are available without exposing launch secrets and reject guessed arguments', async t => {
  const { root, binding, state, gateway } = fixture(t);
  const catalog = await gateway.invoke(root, binding, { provider: 'context7' });
  assert.equal(catalog.available, true); assert.equal(catalog.execution_authorized, false);
  assert.deepEqual(catalog.tools.map(tool => tool.name), ['query-docs']);
  assert.equal(JSON.stringify(catalog).includes('DO-NOT-EXPOSE'), false);
  await assert.rejects(() => gateway.invoke(root, binding, { provider: 'context7', tool: 'query-docs', arguments: { invented: true } }), error => error.code === 'PLUGIN_ARGUMENTS_INVALID');
  await assert.rejects(() => gateway.invoke(root, binding, { provider: 'context7', tool: 'unreviewed_admin_tool', arguments: {} }), denied);
  const result = await gateway.invoke(root, binding, { provider: 'context7', tool: 'query-docs', arguments: { query: 'How do retries work?' } });
  assert.equal(result.content[0].text, 'real fixture result'); assert.equal(state.calls.length, 1);
  assert.equal(state.routes.at(-1).id, binding.invocation_id);
  assert.equal(state.routes.at(-1).scope.workflow_id, binding.workflow_id);
});

test('new role/provider policy permits static REA but does not grant browser actions to WF.PM', async t => {
  const { root, binding, state, gateway } = fixture(t, 'manager');
  assert.equal((await gateway.invoke(root, binding, { provider: 'rea' })).tools[0].name, 'binary_session');
  await assert.rejects(() => gateway.invoke(root, binding, { provider: 'playwright', tool: 'browser_navigate', arguments: { url: 'http://localhost:3000' } }), denied);
  assert.equal(state.calls.length, 0);
});

test('CodeGraph arguments are bound to public files in the actual project, including nested paths', async t => {
  const { root, binding, state, gateway } = fixture(t);
  const invoke = args => gateway.invoke(root, binding, { provider: 'codegraph', tool: 'codegraph_explore', arguments: args });
  const catalog = await gateway.invoke(root, binding, { provider: 'codegraph', arguments: {} });
  assert.equal(catalog.tools[0].input_schema.properties.projectPath, undefined);
  assert.deepEqual(catalog.tools[0].backend_fields, ['projectPath']);
  await assert.rejects(() => invoke({ projectPath: resolve(root, '..') }), denied);
  await assert.rejects(() => invoke({ file_path: '.workforce/config.json' }), denied);
  await assert.rejects(() => invoke({ nested: { file_path: '../private.txt' } }), denied);
  await assert.rejects(() => invoke({ nested: { projectPath: resolve(root, '..') } }), denied);
  await invoke({ query: 'Find callers' });
  assert.notEqual(state.calls[0].args.projectPath, root);
  assert.equal(state.calls[0].args.projectPath, state.connectionRoot);
  assert.equal(state.registration.server.args.at(-1), state.connectionRoot);
  assert.equal(readFileSync(join(state.connectionRoot, 'public.ts'), 'utf8'), 'export const publicValue = 42;');
  assert.equal(existsSync(join(state.connectionRoot, '.workforce')), false);
  await invoke({ file_path: join(root, 'public.ts'), nested: { projectPath: root } });
  assert.equal(state.calls.at(-1).args.file_path, join(state.connectionRoot, 'public.ts'));
  assert.equal(state.calls.at(-1).args.nested.projectPath, state.connectionRoot);
});

test('CodeGraph connector sees only current read-scope projection and refreshes its cached session after source changes', { timeout: 30000 }, async t => {
  const { root, binding, state, gateway, dependencies } = fixture(t);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/one.ts'), 'export const one = 1;');
  mkdirSync(join(root, '.workforce')); writeFileSync(join(root, '.workforce/private.ts'), 'PRIVATE-RUNTIME');
  binding.read_paths = ['src'];
  const invoke = () => gateway.invoke(root, binding, { provider: 'codegraph', tool: 'codegraph_explore', arguments: { query: 'one' } });
  const first = await invoke(), previousRoot = state.connectionRoot;
  assert.deepEqual(first.source_projection.files.map(file => file.path), ['src/one.ts']);
  assert.equal(existsSync(join(previousRoot, 'public.ts')), false);
  assert.equal(existsSync(join(previousRoot, '.workforce')), false);
  await invoke(); assert.equal(state.connected, 1, 'Unchanged source reuses only the same scoped index.');
  writeFileSync(join(root, 'src/one.ts'), 'export const one = 2;');
  const changed = await invoke();
  assert.equal(state.connected, 2); assert.equal(state.closed, 1); assert.notEqual(state.connectionRoot, previousRoot);
  assert.equal(existsSync(previousRoot), false); assert.notEqual(changed.source_projection.baseline, first.source_projection.baseline);
  assert.equal(readFileSync(join(state.connectionRoot, 'src/one.ts'), 'utf8'), 'export const one = 2;');
  dependencies.registration = () => ({ status: 'ready', tools: [], server: { command: process.execPath, args: ['unknown-layout'] } });
  assert.equal((await invoke()).status, 'unsupported-scoped-launch');
  assert.equal(state.connected, 2, 'An unsupported server never falls back to the original project root.');
});

test('CodeGraph result becomes advisory when authoritative source changes during provider execution', { timeout: 30000 }, async t => {
  const { root, binding, gateway, dependencies } = fixture(t);
  const original = dependencies.connect;
  dependencies.connect = async (...args) => {
    const connection = await original(...args), call = connection.call;
    connection.call = async (...input) => { const result = await call(...input); writeFileSync(join(root, 'public.ts'), 'export const publicValue = 99;'); return result; };
    return connection;
  };
  const result = await gateway.invoke(root, binding, { provider: 'codegraph', tool: 'codegraph_explore', arguments: { query: 'publicValue' } });
  assert.equal(result.available, false); assert.equal(result.status, 'source-changed'); assert.match(result.next_action, /not current evidence/);
});

test('network permission, exact browser URLs and fresh role-owned screenshot paths remain enforced', async t => {
  const { root, binding, state, gateway } = fixture(t);
  state.network = 'local-only';
  assert.equal((await gateway.invoke(root, binding, { provider: 'context7' })).status, 'network-denied');
  const navigate = url => gateway.invoke(root, binding, { provider: 'playwright', tool: 'browser_navigate', arguments: { url } });
  await assert.rejects(() => navigate('https://example.invalid'), denied);
  await assert.rejects(() => navigate('http://localhost:3001'), denied);
  await navigate('http://localhost:3000');
  const screenshot = filename => gateway.invoke(root, binding, { provider: 'playwright', tool: 'browser_take_screenshot', arguments: { filename } });
  await assert.rejects(() => screenshot('checks/reviewer.png'), denied);
  mkdirSync(join(root, 'products')); writeFileSync(join(root, 'products/owned.png'), 'Existing user data.');
  await assert.rejects(() => screenshot('products/owned.png'), denied);
  await screenshot('products/new.png'); assert.equal(state.calls.length, 2);
});

test('stale/cross-task/legacy bindings fail closed and session closure prevents late calls', async t => {
  const { root, binding, receipt, state, gateway } = fixture(t);
  await assert.rejects(() => gateway.invoke(root, { ...binding, process_contract: 'software-tools/v2' }, { provider: 'context7' }), denied);
  receipt.task_id = 'OTHER-TASK'; await assert.rejects(() => gateway.invoke(root, binding, { provider: 'context7' }), denied);
  receipt.task_id = binding.task_id; await gateway.invoke(root, binding, { provider: 'context7' });
  await gateway.close(root, binding.invocation_id); assert.equal(state.closed, 1);
  await assert.rejects(() => gateway.invoke(root, binding, { provider: 'context7', tool: 'query-docs', arguments: { query: 'late' } }), denied);
  assert.equal(state.calls.length, 0);
});

test('a connection completing after cancellation is closed before it can publish or execute', async t => {
  const { root, binding, state, gateway, dependencies } = fixture(t);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const connect = dependencies.connect; dependencies.connect = async () => { await pending; return connect(); };
  const result = gateway.invoke(root, binding, { provider: 'context7' });
  await gateway.close(root, binding.invocation_id); release();
  await assert.rejects(() => result, denied);
  assert.equal(state.closed, 1); assert.equal(state.calls.length, 0);
});
