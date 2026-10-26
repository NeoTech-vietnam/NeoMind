import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
const { createPluginHost, activatePluginPanel, renderPluginPanelHtml } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/plugin-panel.cjs');

function harness(overrides = {}) {
  const calls = [], sent = [], storage = new Map();
  let active = true, chosen;
  const runtime = {
    readPluginControlStatus: async () => ({ plugins: [{ id: 'rea', enabled: true, installed: true, version: '6.7.0', availability: 'ready', api_key: 'SECRET', last_probe: { ok: true, checked_at: '2026-10-24', tool_count: 4 } }] }),
    readPluginConnections: async (_root, targets) => { calls.push(['read-connections', targets]); return [{ plugin: 'rea', client: 'codex', status: 'connected', command: 'SECRET' }]; },
    setPluginEnabled: async (...args) => { calls.push(['enable', ...args]); },
    installPlugin: async (...args) => { calls.push(['install', ...args]); },
    probePlugin: async (...args) => { calls.push(['probe', ...args]); return { ok: true }; },
    setPluginConnection: async (...args) => { calls.push(['connection', ...args]); return { status: args[1].connected ? 'connected' : 'disconnected' }; },
    updateProject: async () => { calls.push(['update']); return { conflicts: [] }; },
    ...overrides,
  };
  const vscode = { Uri: { file: fsPath => ({ scheme: 'file', fsPath }) }, window: { showOpenDialog: async () => chosen } };
  const context = { workspaceState: { get: key => storage.get(key), update: async (key, value) => storage.set(key, value) } };
  const host = createPluginHost({ vscode, context, runtime, root: join(tmpdir(), 'project'), alive: () => active, post: async item => sent.push(item) });
  return { host, sent, calls, runtime, storage, vscode, setActive: value => { active = value; }, select: value => { chosen = value; },
    send: (action, fields = {}) => host.handle({ type: 'plugin-action', action, ...fields }) };
}

test('status exposes only catalog metadata and honest persisted connection status', async () => {
  const app = harness(); await app.send('refresh');
  const snapshot = app.sent.find(item => item.type === 'plugin-snapshot');
  assert.equal(snapshot.plugins.length, 4);
  assert.equal(snapshot.plugins[0].connections[0].status, 'connected');
  assert.equal(snapshot.plugins[0].last_probe.ok, true);
  assert.equal(JSON.stringify(app.sent).includes('SECRET'), false);
  assert.equal(snapshot.vscode_selected, false);
});

test('webview cannot select arbitrary paths, executables, catalog IDs or client targets', async () => {
  const app = harness();
  await app.send('connect', { plugin: 'rea', client: 'codex', targets: { codex: '/secret' }, executable: '/bad', root: '/bad' });
  const call = app.calls.find(item => item[0] === 'connection');
  assert.deepEqual(call[2], { plugin: 'rea', client: 'codex', connected: true });
  assert.notEqual(call[3].codex, '/secret');
  await app.send('install', { plugin: 'arbitrary-package' });
  await app.send('connect', { plugin: 'rea', client: 'arbitrary-client' });
  assert.equal(app.calls.filter(item => item[0] === 'connection').length, 1);
  assert.equal(app.calls.some(item => item[0] === 'install'), false);
});

test('VS Code connection requires explicit native profile-file selection', async () => {
  const app = harness();
  await app.send('connect', { plugin: 'rea', client: 'copilot-vscode', path: '/bad' });
  assert.equal(app.calls.some(item => item[0] === 'connection'), false);
  const selected = join(tmpdir(), 'profile', 'mcp.json');
  app.select([{ scheme: 'file', fsPath: selected }]); await app.send('select-vscode');
  await app.send('connect', { plugin: 'rea', client: 'copilot-vscode' });
  assert.equal(app.calls.find(item => item[0] === 'connection')[3].copilotVscode, selected);
});

test('native picker accepts a new profile target without writing until Connect', async () => {
  const app = harness();
  const selected = join(tmpdir(), 'new-profile', 'mcp.json');
  app.vscode.window.showSaveDialog = async options => {
    assert.equal(options.saveLabel, 'Use MCP settings file');
    return { scheme: 'file', fsPath: selected };
  };
  await app.send('select-vscode');
  assert.equal(app.calls.some(item => item[0] === 'connection'), false);
  await app.send('connect', { plugin: 'context7', client: 'copilot-vscode' });
  assert.equal(app.calls.find(item => item[0] === 'connection')[3].copilotVscode, selected);
});

test('disable revokes the provider before client cleanup even when an authored entry conflicts', async () => {
  const app = harness({ setPluginConnection: async (_root, input) => { app.calls.push(['disconnect', input.client]); if (input.client === 'codex') throw new Error('SECRET authored settings'); return { status: 'disconnected' }; } });
  await app.send('disable', { plugin: 'rea' });
  assert.deepEqual(app.calls.filter(item => item[0] === 'disconnect').map(item => item[1]), ['codex', 'copilot-vscode', 'copilot-cli']);
  assert.equal(app.calls.find(item => item[0] === 'enable')[3], false);
  assert.ok(app.calls.findIndex(item => item[0] === 'enable') < app.calls.findIndex(item => item[0] === 'disconnect'));
  assert.ok(app.sent.some(item => item.type === 'plugin-notice' && item.message.includes('could not be removed')));
  assert.equal(JSON.stringify(app.sent).includes('SECRET'), false);
});

test('refused provider revocation does not disconnect any client', async () => {
  const app = harness({ setPluginEnabled: async () => { throw new Error('Plug-in configuration cannot change while an invocation is active. Interrupt or reconcile it first.'); } });
  await app.send('disable', { plugin: 'rea' });
  assert.equal(app.calls.some(item => item[0] === 'connection'), false);
  assert.equal(app.calls.some(item => item[0] === 'update'), false);
  assert.ok(app.sent.some(item => item.error && item.message.includes('active NeoMind work')));
});

test('disable adopts only exact existing unmanaged connections before revocation', async () => {
  const app = harness({ readPluginConnections: async () => [
    { plugin: 'rea', client: 'codex', status: 'connected', managed: false },
    { plugin: 'rea', client: 'copilot-vscode', status: 'conflict', managed: false },
    { plugin: 'rea', client: 'copilot-cli', status: 'blocked', managed: false },
  ] });
  await app.send('disable', { plugin: 'rea' });
  const connectionCalls = app.calls.filter(item => item[0] === 'connection');
  assert.deepEqual(connectionCalls.map(item => item[2]), [
    { plugin: 'rea', client: 'codex', connected: true },
    { plugin: 'rea', client: 'codex', connected: false },
    { plugin: 'rea', client: 'copilot-vscode', connected: false },
    { plugin: 'rea', client: 'copilot-cli', connected: false },
  ]);
  const revokeIndex = app.calls.findIndex(item => item[0] === 'enable');
  assert.ok(app.calls.findIndex(item => item[0] === 'connection' && item[2].connected) < revokeIndex);
  assert.ok(app.calls.findIndex(item => item[0] === 'connection' && !item[2].connected) > revokeIndex);
});

test('a blocked connection snapshot cannot prevent provider revocation and does not adopt entries', async () => {
  const app = harness({ readPluginConnections: async () => { throw new Error('SECRET malformed client settings'); } });
  await app.send('disable', { plugin: 'rea' });
  assert.equal(app.calls.find(item => item[0] === 'enable')[3], false);
  assert.equal(app.calls.filter(item => item[0] === 'connection' && item[2].connected).length, 0);
  assert.equal(app.calls.filter(item => item[0] === 'connection' && !item[2].connected).length, 3);
  assert.ok(app.sent.some(item => item.type === 'plugin-notice' && item.message.includes('NeoMind provider disabled') && item.message.includes('Status refresh is unavailable')));
  assert.equal(JSON.stringify(app.sent).includes('SECRET'), false);
});

test('overlapping operations are rejected and trust revocation stops follow-up mutations', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = harness({ installPlugin: async () => { app.calls.push(['install']); await pending; } });
  const action = app.send('install', { plugin: 'rea' });
  await new Promise(resolve => setImmediate(resolve));
  await app.send('enable', { plugin: 'rea' });
  app.setActive(false); finish(); await action;
  assert.equal(app.calls.some(item => item[0] === 'enable' || item[0] === 'update'), false);
  assert.equal(app.sent.some(item => item.type === 'plugin-snapshot'), false);
  await app.send('probe', { plugin: 'rea' });
  assert.equal(app.calls.some(item => item[0] === 'probe'), false);
});

test('pending native picker never saves a target after the panel closes', async () => {
  const app = harness(); let finish;
  app.select(undefined);
  // Replace the native picker through an independent host so closure occurs across its await.
  const storage = new Map();
  const host = createPluginHost({ root: tmpdir(), runtime: app.runtime, alive: () => !storage.has('closed'), post: async () => {},
    vscode: { Uri: { file: value => value }, window: { showOpenDialog: () => new Promise(resolve => { finish = resolve; }) } },
    context: { workspaceState: { get() {}, update: async (key, value) => storage.set(key, value) } } });
  const action = host.handle({ type: 'plugin-action', action: 'select-vscode' });
  await new Promise(resolve => setImmediate(resolve)); storage.set('closed', true);
  finish([{ scheme: 'file', fsPath: join(tmpdir(), 'mcp.json') }]); await action;
  assert.equal(storage.size, 1);
});

test('installation errors show fixed actionable text without provider secrets or automatic policy changes', async () => {
  const app = harness({ installPlugin: async () => { throw new Error('SECRET local-only /private/token'); } });
  await app.send('install', { plugin: 'context7' });
  assert.ok(app.sent.some(item => item.error && item.message.includes('network policy')));
  assert.equal(JSON.stringify(app.sent).includes('SECRET'), false);
  assert.equal(app.calls.some(item => item[0] === 'enable' || item[0] === 'update'), false);
});

test('panel entry registers and disposes while runtime loading cannot create a stale panel', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-panel-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let open, changed, finish; let panels = 0;
  const loaded = new Promise(resolve => { finish = resolve; });
  const context = { subscriptions: [] };
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], onDidChangeWorkspaceFolders: fn => { changed = fn; return { dispose() {} }; } },
    commands: { registerCommand: (id, fn) => { assert.equal(id, 'neomind.plugins.open'); open = fn; return { dispose() {} }; } }, window: { createWebviewPanel() { panels++; }, showErrorMessage() {} } };
  const panel = activatePluginPanel(vscode, context, async () => loaded);
  const operation = open(); await open(); changed(); finish({}); await operation;
  assert.equal(panels, 0); panel.dispose();
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attrs = {}; this.disabled = false; }
  append(...values) { this.children.push(...values); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
test('real webview controller renders four plug-ins, dispatches toggles and blocks duplicate actions', () => {
  const elements = new Map(['refresh', 'select-vscode', 'plugins', 'notice', 'vscode-target'].map(id => [id, new Element('div')]));
  let receive; const sent = [];
  runInNewContext(readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/plugins.js', import.meta.url), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: value => sent.push(JSON.parse(JSON.stringify(value))) }),
    document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) },
    window: { addEventListener: (_type, callback) => { receive = value => callback({ data: value }); } },
  });
  assert.equal(elements.get('plugins').children.length, 4);
  assert.deepEqual(sent.shift(), { type: 'plugin-action', action: 'refresh' });
  receive({ type: 'plugin-snapshot', vscode_selected: true, plugins: [{ id: 'rea', enabled: true, installed: true, version: '6.7.0', availability: 'ready', last_probe: null, connections: [{ client: 'codex', status: 'connected' }] }] });
  receive({ type: 'plugin-busy', busy: false });
  const rea = elements.get('plugins').children[0];
  const actions = rea.children[4]; actions.children[0].click();
  assert.deepEqual(sent.at(-1), { type: 'plugin-action', action: 'disable', plugin: 'rea' });
  const connections = rea.children[5]; connections.children[0].children[2].click();
  assert.deepEqual(sent.at(-1), { type: 'plugin-action', action: 'disconnect', plugin: 'rea', client: 'codex' });
  receive({ type: 'plugin-snapshot', vscode_selected: true, plugins: [{ id: 'rea', enabled: true, installed: true, version: '6.7.0', availability: 'installed', last_probe: null, connections: [{ client: 'codex', status: 'connected' }, { client: 'copilot-cli', status: 'disconnected' }] }] });
  assert.equal(connections.children[0].children[2].disabled, false, 'Existing connection can be disconnected before a fresh probe');
  assert.equal(connections.children[2].children[2].disabled, true, 'An unverified installation cannot be newly connected');
  receive({ type: 'plugin-busy', busy: true }); actions.children[0].click(); assert.equal(sent.length, 2);
  receive({ type: 'plugin-notice', message: '<img src=x onerror=bad()>' });
  assert.equal(elements.get('notice').textContent, '<img src=x onerror=bad()>');
  const html = renderPluginPanelHtml({ cspSource: 'webview:', script: 'plugins.js', style: 'plugins.css', nonce: 'fixed' });
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-fixed'/); assert.doesNotMatch(html, /unsafe-inline/);
});
