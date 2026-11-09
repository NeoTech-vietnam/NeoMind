import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeRoleContentSchema } from '../dist/native-role-job.js';
import { nativeWorkerProfiles } from '../dist/native-local-contract.js';

const require = createRequire(import.meta.url);
const { activateNativeEntry, nativeToolNames, nativeRoleToolNames } = require('../extensions/vscode-model-bridge/native-entry.cjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-entry-'));
  const other = join(root, 'other'); mkdirSync(other);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = new Map(), calls = [], runners = [], loads = [], folderListeners = new Set();
  let runtime = { nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles,
    prepareNativeWork: (_root, input) => ({ input, execution: 'not-executed' }) };
  const context = { subscriptions: [], workspaceState: { get() {}, async update() {} } };
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
    onDidChangeWorkspaceFolders(listener) { folderListeners.add(listener); return { dispose() { folderListeners.delete(listener); } }; } },
    lm: { registerTool(name, tool) { tools.set(name, tool); return { dispose() {} }; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
  };
  const entry = activateNativeEntry(vscode, context, async path => { loads.push(path); return runtime; }, {
    createRunner(_vscode, api, path) {
      const runner = Object.fromEntries(['run', 'role', 'control'].map(method => [method, async (...args) => {
        calls.push({ method, path, api, args }); return { status: 'observed-native-result' };
      }]));
      runner.dispose = async () => { runner.disposed = true; };
      runners.push(runner); return runner;
    },
  });
  t.after(() => entry.dispose());
  const invoke = async (name, input = {}, token = {}, cancellation = {}) => JSON.parse((await tools.get(nativeToolNames[name]).invoke({ input, toolInvocationToken: token }, cancellation)).content[0].value);
  const invokeRole = async (role, input, token = {}) => JSON.parse((await tools.get(nativeRoleToolNames[role]).invoke({ input, toolInvocationToken: token }, {})).content[0].value);
  return { root, other, vscode, tools, calls, runners, loads, entry, invoke, invokeRole,
    foldersChanged() { for (const listener of folderListeners) listener(); }, setRuntime(value) { runtime = value; } };
}

test('native activation stays idle and binds native submission, scoped roles, reuse and retained controls', async t => {
  const app = fixture(t), opaque = Object.freeze({ opaque: Symbol('host context') });
  assert.equal(app.tools.size, Object.keys(nativeToolNames).length + Object.keys(nativeRoleToolNames).length);
  assert.equal(app.loads.length, 0);
  const result = await app.invoke('request', { requirement: 'An ordinary request' }, opaque);
  assert.equal(result.status, 'observed-native-result');
  assert.equal(app.calls[0].method, 'run');
  assert.equal(app.calls[0].args[1], opaque);
  assert.deepEqual(app.calls[0].args[0], { requirement: 'An ordinary request' });
  await app.invoke('role', { workspace_folder: app.root, role: 'WF.SWSD', requirement: 'Define scope' });
  await app.invoke('control', { request_key: 'WF-R0001', action: 'status' });
  assert.deepEqual(app.calls.map(call => call.method), ['run', 'role', 'control']);
  assert.equal('workspace_folder' in app.calls[1].args[0], false);
  assert.equal(app.runners.length, 1);
  assert.equal((await app.invoke('prepare', { requirement: 'Find existing tooling' })).execution, 'not-executed');
  assert.equal(app.calls.length, 3, 'retrieval never calls a worker');
});

test('optional capability management uses User sources, ordinary content and cancellable public transport without dispatch', async t => {
  const app = fixture(t), calls = [];
  const sources = [{ name: 'reviewed-source' }];
  app.vscode.workspace.getConfiguration = section => {
    assert.equal(section, 'workforce');
    return { inspect(key) {
      assert.equal(key, 'capabilities.sources');
      return { globalValue: sources, workspaceValue: [{ name: 'untrusted-project-override' }],
        workspaceFolderValue: [{ name: 'untrusted-folder-override' }] };
    } };
  };
  let cancel, disposed = false;
  app.setRuntime({ nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles,
    DEFAULT_NATIVE_CAPABILITY_SOURCES: [{ name: 'bundled' }],
    async manageNativeCapabilities(root, input, options) {
      calls.push({ root, input, options });
      assert.equal(options.signal.aborted, false);
      cancel();
      assert.equal(options.signal.aborted, true);
      return { state: 'unavailable', fallback: 'ordinary-work', reason: 'cancelled' };
    } });
  const result = await app.invoke('capabilities', { action: 'search', query: 'Java documentation', workspace_folder: app.root }, {},
    { onCancellationRequested(listener) { cancel = listener; return { dispose() { disposed = true; } }; } });
  assert.equal(result.reason, 'cancelled');
  assert.equal(calls[0].root, app.root);
  assert.deepEqual(calls[0].input, { action: 'search', query: 'Java documentation' });
  assert.deepEqual(calls[0].options.sources, sources);
  assert.equal(typeof calls[0].options.fetch, 'function');
  assert.equal(disposed, true);
  assert.equal(app.calls.length, 0, 'Managing optional guidance never starts workers');
});

test('capability policy omission uses reviewed defaults, explicit User opt-out stays empty and old runtimes fall back', async t => {
  const app = fixture(t), sourcesSeen = [];
  let globalValue;
  app.vscode.workspace.getConfiguration = () => ({ inspect: () => ({ globalValue, workspaceValue: [{ name: 'ignored' }] }) });
  const runtime = { nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles,
    DEFAULT_NATIVE_CAPABILITY_SOURCES: [{ name: 'bundled-reviewed' }],
    manageNativeCapabilities(_root, _input, options) { sourcesSeen.push(options.sources); return { state: 'available' }; } };
  app.setRuntime(runtime);
  await app.invoke('capabilities', { action: 'status' });
  globalValue = [];
  await app.invoke('capabilities', { action: 'status' });
  assert.deepEqual(sourcesSeen, [[{ name: 'bundled-reviewed' }], []]);
  app.setRuntime({ nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles });
  const result = await app.invoke('capabilities', { action: 'search', query: 'anything' });
  assert.equal(result.fallback, 'ordinary-work');
  assert.equal(result.reason, 'matching-runtime-required');
  assert.equal(app.calls.length, 0);
});

test('capability calls drain on editor disposal and User source changes invalidate their snapshot', async t => {
  const app = fixture(t);
  let changed, sources = [{ name: 'reviewed' }], entered;
  const started = new Promise(resolve => { entered = resolve; });
  app.vscode.workspace.getConfiguration = () => ({ inspect: () => ({ globalValue: sources }) });
  app.vscode.workspace.onDidChangeConfiguration = listener => { changed = listener; return { dispose() {} }; };
  app.setRuntime({ nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles,
    async manageNativeCapabilities(_root, _input, options) {
      assert.equal(options.isCurrent(), true);
      sources = [];
      assert.equal(options.isCurrent(), false);
      entered();
      return await new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ state: 'unavailable', reason: 'cancelled' }), { once: true }));
    } });
  const call = app.invoke('capabilities', { action: 'install', source: 'reviewed', package: 'docs', skill: 'docs' });
  await started;
  changed({ affectsConfiguration: key => key === 'workforce.capabilities.sources' });
  await app.entry.dispose();
  assert.equal((await call).reason, 'cancelled');
  assert.equal(app.calls.length, 0);
});

test('an optional capability exception keeps ordinary work available instead of blaming runtime installation', async t => {
  const app = fixture(t);
  app.setRuntime({ nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles,
    manageNativeCapabilities() { throw new Error('PRIVATE internal detail'); } });
  const result = await app.invoke('capabilities', { action: 'search', query: 'docs' });
  assert.deepEqual(result, { state: 'unavailable', fallback: 'ordinary-work', reason: 'capability-operation-failed' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|NATIVE_RUNTIME_UNAVAILABLE/);
  assert.equal(app.calls.length, 0);
});

test('pending capability publication observes trust and workspace removal without a settings event', async t => {
  const app = fixture(t);
  let entered, isCurrent, listenerDisposals = 0;
  const started = new Promise(resolve => { entered = resolve; });
  app.vscode.workspace.onDidChangeConfiguration = () => ({ dispose() { listenerDisposals++; } });
  app.setRuntime({ nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles,
    manageNativeCapabilities(_root, _input, options) {
      isCurrent = options.isCurrent; entered();
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ state: 'cancelled' }), { once: true }));
    } });
  const call = app.invoke('capabilities', { action: 'install', package: 'docs', skill: 'docs' }, {},
    { onCancellationRequested() { return { dispose() { listenerDisposals++; } }; } });
  await started;
  assert.equal(isCurrent(), true);
  app.vscode.workspace.isTrusted = false;
  assert.equal(isCurrent(), false, 'Publication guard reads actual trust without waiting for an event');
  app.vscode.workspace.isTrusted = true;
  assert.equal(isCurrent(), true);
  app.vscode.workspace.workspaceFolders = [];
  assert.equal(isCurrent(), false);
  app.foldersChanged();
  assert.equal((await call).state, 'cancelled');
  assert.equal(listenerDisposals, 2);
  assert.equal(app.calls.length, 0);
});

test('selector role tools bind roles on the host and reject caller-supplied identity without dispatch', async t => {
  const app = fixture(t), opaque = Object.freeze({ opaque: Symbol('native caller') });
  for (const role of Object.keys(nativeRoleToolNames)) {
    const input = { requirement: `Complete only ${role}`, outputs: [] };
    assert.equal((await app.invokeRole(role, input, opaque)).status, 'observed-native-result');
    const call = app.calls.at(-1);
    assert.equal(call.method, 'role'); assert.equal(call.args[1], opaque);
    assert.deepEqual(call.args[0], { ...input, context: [], role });
  }
  const count = app.calls.length;
  for (const extra of [{ role: 'WF.FnD' }, { assignment_ref: 'invented' }, { claim_token: 'invented' }])
    assert.equal((await app.invokeRole('WF.SWSD', { requirement: 'Inspect', ...extra })).error.code, 'INVALID_ROLE_REQUEST');
  assert.equal(app.calls.length, count, 'Rejected role/identity payloads never open another assignment');
  app.setRuntime({ nativeLocalContractVersion: 'vscode-native/v1' });
  assert.equal((await app.invokeRole('WF.SWSD', { requirement: 'Inspect' })).error.code, 'NATIVE_RUNTIME_REQUIRED');
});

test('workspace selection and trust are checked before runtime access; no connection or engine is started', async t => {
  const app = fixture(t);
  app.vscode.workspace.workspaceFolders.push({ uri: { scheme: 'file', fsPath: app.other } });
  assert.equal((await app.invoke('request', { requirement: 'Ambiguous project' })).error.code, 'PROJECT_REQUIRED');
  assert.equal(app.loads.length, 0);
  await app.invoke('role', { workspace_folder: app.other, role: 'WF.SWSD', requirement: 'Scope' });
  assert.equal(app.calls[0].path, app.other);
  app.vscode.workspace.isTrusted = false;
  assert.equal((await app.invoke('request', { workspace_folder: app.root })).error.code, 'WORKSPACE_UNTRUSTED');
  assert.equal(app.loads.length, 1);
});

test('runtime replacement and disposal drain the previous runner without creating hidden work', async t => {
  const app = fixture(t);
  await app.invoke('request');
  app.setRuntime({ nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema, nativeWorkerProfiles });
  await app.invoke('request');
  assert.equal(app.runners.length, 2); assert.equal(app.runners[0].disposed, true);
  await app.entry.dispose();
  assert.equal(app.runners[1].disposed, true);
  assert.equal((await app.invoke('request')).error.code, 'NATIVE_ENTRY_DISPOSED');
  assert.equal(app.calls.length, 2);
});

test('every new entry rejects older or incoherent v1 runtime profiles before creating a runner', async t => {
  const app = fixture(t);
  for (const runtime of [
    { nativeLocalContractVersion: 'vscode-native/v1' },
    { nativeLocalContractVersion: 'vscode-native/v1', nativeRoleContentSchema,
      nativeWorkerProfiles: { ...nativeWorkerProfiles, 'WF.FnD': 'WF.PM' } },
  ]) {
    app.setRuntime(runtime);
    for (const kind of Object.keys(nativeToolNames))
      assert.equal((await app.invoke(kind, { requirement: 'Keep the selected contract coherent' })).error.code, 'NATIVE_RUNTIME_REQUIRED');
    assert.equal((await app.invokeRole('WF.SWSD', { requirement: 'Inspect only' })).error.code, 'NATIVE_RUNTIME_REQUIRED');
  }
  assert.equal(app.runners.length, 0);
  assert.equal(app.calls.length, 0);
});
