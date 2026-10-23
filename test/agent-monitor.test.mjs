import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { activateMonitor, _test } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/monitor.cjs');

function setup(t, overrides = {}, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-monitor-'));
  const commands = new Map(), calls = [], context = { subscriptions: [] };
  let workspaceChanged, received, disposed, current, readCount = 0, panelCount = 0;
  const control = { roles: [{ role: 'developer', models: ['configured-model'], provider: 'test', reasoning_effort: 'low', strong: false }], active_invocations: [], router: null };
  const runtime = { readAgentMap: () => { readCount++; return { schema_version: 1, project: { id: 'MAP', name: 'Empty map' }, nodes: [], edges: [], diagnostics: {} }; },
    modelControlStatus: () => control,
    setRoleModel: (_root, input) => { calls.push(input); return { applies_to: 'next-invocation' }; },
    updateProject: () => { calls.push('generated agents refreshed'); return { conflicts: [] }; },
    routerModels: async () => [{ id: 'router-model' }], ...overrides };
  const uri = path => ({ scheme: 'file', fsPath: path, toString: () => path });
  const vscode = {
    Uri: { file: uri }, ViewColumn: { One: 1 },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(root) }],
      onDidChangeWorkspaceFolders: callback => { workspaceChanged = callback; return { dispose() {} }; } },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose: () => commands.delete(name) }; } },
    window: { showQuickPick: async items => items[0], showInputBox: async () => 'entered-model',
      showInformationMessage: async message => calls.push(message), showWarningMessage: async message => calls.push(message),
      showErrorMessage: message => calls.push(message),
      createWebviewPanel: () => {
        panelCount++;
        current = { visible: true, disposed: false, messages: [], reveal() {},
          webview: { cspSource: 'vscode-webview:', asWebviewUri: path => path.fsPath,
            onDidReceiveMessage: callback => { received = callback; },
            postMessage: async message => { current.messages.push(message); } },
          onDidChangeViewState() {}, onDidDispose: callback => { disposed = callback; },
          dispose() { if (!this.disposed) { this.disposed = true; disposed?.(); } },
        };
        return current;
      } },
  };
  const monitor = activateMonitor(vscode, context, async selected => {
    assert.equal(selected.toLowerCase(), root.toLowerCase());
    await options.beforeLoad?.();
    return runtime;
  });
  t.after(() => { monitor.dispose(); for (const item of context.subscriptions) item.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { vscode, runtime, control, calls, open: () => commands.get('neomind.monitor.open')(),
    changeFolders: () => workspaceChanged(), message: value => received(value),
    get panel() { return current; }, get reads() { return readCount; }, get panelCount() { return panelCount; } };
}

test('overlapping opens while runtime loading create exactly one panel', async t => {
  let resolveLoad;
  const loaded = new Promise(resolve => { resolveLoad = resolve; });
  const env = setup(t, {}, { beforeLoad: () => loaded });
  const first = env.open(), second = env.open();
  assert.equal(env.panelCount, 0);
  resolveLoad();
  await Promise.all([first, second]);
  assert.equal(env.panelCount, 1);
});

test('workspace stop while runtime loading prevents panel creation and clears the opening guard', async t => {
  let resolveLoad;
  const loaded = new Promise(resolve => { resolveLoad = resolve; });
  const env = setup(t, {}, { beforeLoad: () => loaded });
  const pending = env.open();
  env.changeFolders();
  resolveLoad();
  await pending;
  assert.equal(env.panelCount, 0);
  await env.open();
  assert.equal(env.panelCount, 1);
});

test('monitor exposes configured role controls in an honest empty state and disposes on folder change', async t => {
  const env = setup(t);
  await env.open();
  assert.equal(env.panel.messages[0].type, 'snapshot');
  assert.equal(env.panel.messages[0].map.nodes.length, 0);
  assert.equal(env.panel.messages[0].roles[0].role, 'developer');
  assert.match(env.panel.webview.html, /default-src 'none'/);
  assert.match(env.panel.webview.html, /script-src 'nonce-/);
  env.changeFolders();
  assert.equal(env.panel.disposed, true);
  const reads = env.reads;
  await env.message({ type: 'refresh' });
  assert.equal(env.reads, reads);
});

test('model selection uses the policy helper and does not enable inference', async t => {
  const env = setup(t);
  env.control.router = { endpoint: 'SECRET ENDPOINT', api_key: 'SECRET KEY', catalog_provider: '9Router' };
  env.vscode.window.showQuickPick = async items => items.find(item => item.model === 'router-model');
  await env.open();
  assert.equal(JSON.stringify(env.panel.messages).includes('SECRET'), false);
  await env.message({ type: 'select-model', role: 'developer' });
  assert.ok(env.calls.some(call => typeof call === 'object' && call.role === 'developer' && call.model === 'router-model' && call.provider === '9Router'));
  assert.ok(env.calls.some(call => typeof call === 'string' && call.includes('next-invocation')));
  assert.ok(env.calls.includes('generated agents refreshed'));
});

test('saved policy and generated-agent conflicts are reported as separate outcomes', async t => {
  const env = setup(t, { updateProject: () => ({ conflicts: [{ path: '.github/agents/Manager.agent.md', candidate: '.neomind/updates/Manager.agent.md' }] }) });
  await env.open();
  await env.message({ type: 'select-model', role: 'developer' });
  assert.ok(env.calls.some(call => typeof call === 'object' && call.model === 'configured-model'));
  assert.ok(env.calls.some(call => typeof call === 'string' && call.includes('policy saved') && call.includes('update candidates')));
  assert.equal(env.calls.some(call => typeof call === 'string' && call.includes('not accepted')), false);
});

test('same model IDs remain scoped to the explicitly selected registered provider', async t => {
  const env = setup(t);
  env.vscode.lm = { selectChatModels: async selector => {
    assert.deepEqual(selector, {});
    return [{ id: 'configured-model', vendor: 'second-provider' }];
  } };
  env.vscode.window.showQuickPick = async items => {
    const scoped = items.filter(item => item.model === 'configured-model');
    assert.equal(scoped.length, 2);
    return scoped.find(item => item.provider === 'second-provider');
  };
  await env.open();
  await env.message({ type: 'select-model', role: 'developer' });
  assert.ok(env.calls.some(call => typeof call === 'object' && call.model === 'configured-model' && call.provider === 'second-provider'));
});

test('core policy refusal prevents generated-agent refresh', async t => {
  const env = setup(t, { setRoleModel: () => { throw new Error('Current policy refused.'); } });
  await env.open();
  await env.message({ type: 'select-model', role: 'developer' });
  assert.equal(env.calls.includes('generated agents refreshed'), false);
  assert.ok(env.calls.some(call => typeof call === 'string' && call.includes('refused')));
});

test('missing custom-provider catalog gives an actionable routing setting without accepting a model change', async t => {
  const env = setup(t, { setRoleModel: () => {
    throw new Error('Custom model selection requires a configured VS Code language model catalog.');
  } });
  await env.open();
  await env.message({ type: 'select-model', role: 'developer' });
  const notification = env.calls.filter(call => typeof call === 'string').join('\n');
  assert.match(notification, /language_models_file/);
  assert.match(notification, /\.neomind\/routing\.json/);
  assert.match(notification, /chatLanguageModels\.json/);
  assert.equal(env.calls.includes('generated agents refreshed'), false);
  assert.doesNotMatch(notification, /policy (?:was )?saved/);
});

test('missing or ambiguous catalog identity explains provider scoping and duplicate-entry remediation', async t => {
  const env = setup(t, { setRoleModel: () => {
    throw new Error('Selected model must resolve to exactly one catalog vendor and ID.');
  } });
  await env.open();
  await env.message({ type: 'select-model', role: 'developer' });
  const notification = env.calls.filter(call => typeof call === 'string').join('\n');
  assert.match(notification, /missing|ambiguous/i);
  assert.match(notification, /duplicate/i);
  assert.match(notification, /provider|vendor/i);
  assert.match(notification, /model ID/i);
  assert.equal(env.calls.includes('generated agents refreshed'), false);
});

test('unknown errors and known-error text carrying provider secrets stay generic and redacted', async t => {
  for (const failure of [
    new Error('Provider refused Bearer SECRET_TOKEN at https://private.invalid?api_key=SECRET_KEY'),
    new Error('Custom model selection requires a configured VS Code language model catalog. SECRET_TOKEN'),
    new Error('Selected model must resolve to exactly one catalog vendor and ID. SECRET_KEY'),
    { message: 'Custom model selection requires a configured VS Code language model catalog.', token: 'SECRET_TOKEN' },
  ]) {
    const env = setup(t, { setRoleModel: () => { throw failure; } });
    await env.open();
    await env.message({ type: 'select-model', role: 'developer' });
    const notification = env.calls.filter(call => typeof call === 'string').join('\n');
    assert.match(notification, /refused the model change/);
    assert.doesNotMatch(notification, /SECRET_|private\.invalid|Bearer|api_key|language_models_file|duplicate/i);
    assert.equal(env.calls.includes('generated agents refreshed'), false);
  }
});

test('invalid policy or receipt control state cannot hide the read-only map diagnostics', async t => {
  const env = setup(t, { modelControlStatus: () => { throw new Error('Invalid signed receipt.'); } });
  await env.open();
  const value = env.panel.messages[0];
  assert.equal(value.type, 'snapshot');
  assert.equal(value.control_unavailable, true);
  assert.equal(value.active_count, null);
  assert.deepEqual(value.roles, []);
});

test('active invocations and loss of trust prevent model mutation', async t => {
  let changes = 0;
  const env = setup(t, { setRoleModel: () => { changes++; } });
  env.control.active_invocations.push({ id: 'active', role: 'developer', state: 'running' });
  await env.open();
  await env.message({ type: 'select-model', role: 'developer' });
  assert.equal(changes, 0);
  assert.ok(env.calls.some(call => typeof call === 'string' && call.includes('active')));
  env.control.active_invocations.length = 0;
  env.vscode.workspace.isTrusted = false;
  await env.message({ type: 'select-model', role: 'developer' });
  assert.equal(changes, 0);
});

test('closing monitor while a model picker is pending cannot mutate routing', async t => {
  let choose, changes = 0;
  const env = setup(t, { setRoleModel: () => { changes++; } });
  env.vscode.window.showQuickPick = () => new Promise(resolve => { choose = resolve; });
  await env.open();
  const pending = env.message({ type: 'select-model', role: 'developer' });
  await new Promise(resolve => setImmediate(resolve));
  env.panel.dispose();
  choose({ model: 'configured-model' });
  await pending;
  assert.equal(changes, 0);
});

test('pure renderer keeps inline state out of the webview and exposes previewable assets', () => {
  const html = _test.renderMonitorHtml({ cspSource: 'https://example.test', script: 'monitor.js', style: 'monitor.css', nonce: 'testnonce' });
  assert.match(html, /src="monitor.js"/);
  assert.match(html, /href="monitor.css"/);
  assert.match(html, /nonce="testnonce"/);
  assert.match(html, /replay of recorded/);
  assert.equal(html.includes('unsafe-inline'), false);
});
