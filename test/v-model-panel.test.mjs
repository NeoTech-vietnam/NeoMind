import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { documentFixture, Element, universe } from './helpers/workforce-ui.mjs';

const require = createRequire(import.meta.url);
const { activateVModelPanel } = require('../extensions/vscode-model-bridge/v-model-panel.cjs');
const clientSource = readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/v-model-panel.js', import.meta.url), 'utf8');

// Model SELECT/OPTION value and node semantics, not the operating system's popup.
class SelectElement extends Element {
  constructor(document) { super('select', document); this.valueWrites = []; }
  get options() { return this.children; }
  get selectedIndex() { return this.children.findIndex(option => option.selected); }
  set selectedIndex(index) { this.children.forEach((option, position) => { option.selected = position === index; }); }
  get value() { return this.options.find(option => option.selected)?.value ?? ''; }
  set value(value) {
    this.valueWrites?.push(value);
    this.selectedIndex = this.children.findIndex(option => option.value === value);
  }
  append(...children) {
    const selected = this.selectedIndex >= 0;
    super.append(...children);
    if (!selected && this.options.length) this.selectedIndex = 0;
  }
  blur() { this.ownerDocument.activeElement = null; this.dispatch('blur'); }
}

function panelDocument(ids) {
  const fixture = documentFixture(ids);
  fixture.elements.get('request').remove();
  const chooser = new SelectElement(fixture.document);
  chooser.id = 'request';
  fixture.elements.set('request', chooser);
  fixture.document.body.append(chooser);
  return fixture;
}

function panelClient(saved) {
  const ids = [...new Set([...clientSource.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]))];
  const { document, elements } = panelDocument(ids), messages = [];
  let receive;
  runInNewContext(clientSource, { document, window: { WorkForceUniverse: universe,
    addEventListener(_type, listener) { receive = data => listener({ data }); } },
  acquireVsCodeApi: () => ({ getState: () => saved, setState(value) { saved = value; }, postMessage(message) { messages.push(message); } }) });
  return { document, elements, chooser: elements.get('request'), messages,
    message: data => receive(data), snapshot: (requests, extra = {}) => receive({ type: 'snapshot', project: 'Fixture', requests, ...extra }),
    state: () => saved };
}

test('native V-model arms motion for actual running-stage styles without inventing stage activity', () => {
  const panel = panelClient();
  panel.snapshot([{ workflow_id: 'motion-proof', source: 'native-local', live: true, status: 'working', artifacts: [], evidence: [],
    stages: [{ id: 'coding', state: 'running' }] }]);
  const svg = panel.elements.get('v-model').children[0];
  assert.equal(svg.getAttribute('data-motion'), 'true', 'Native panel must activate the production motion selector; CSS still owns reduced-motion overrides');
  const groups = svg.children.filter(node => node.getAttribute('data-stage'));
  assert.equal(groups.filter(node => node.getAttribute('data-state') === 'running').length, 1);
  panel.snapshot([{ workflow_id: 'motion-proof', source: 'native-local', live: false, status: 'uncertain', artifacts: [], evidence: [],
    stages: [{ id: 'coding', state: 'uncertain' }] }]);
  assert.equal(groups.filter(node => node.getAttribute('data-state') === 'running').length, 0, 'Armed motion does not fabricate a running stage');
});

const selectorRequests = () => [
  { workflow_id: 'wf25', request_key: 'WF-R0025', title: 'Current request', source: 'native-local', live: true,
    status: 'running', revision: 1, artifacts: [], evidence: [] },
  { workflow_id: 'wf13', request_key: 'WF-R0013', title: 'Earlier request', source: 'native-local', live: false,
    status: 'completed', artifacts: [], evidence: [] },
];

test('V-model keeps focused selector options and pending selection through live stage updates', () => {
  const panel = panelClient(), requests = selectorRequests();
  panel.snapshot(requests);
  assert.equal(panel.chooser.tagName, 'SELECT');
  assert.ok(panel.chooser.options.every(option => option.tagName === 'OPTION'));
  const options = [...panel.chooser.options], writes = panel.chooser.valueWrites.length;
  panel.chooser.focus();
  panel.chooser.selectedIndex = 1; // A transient choice; no committed change event yet.
  for (let revision = 2; revision <= 4; revision++) {
    panel.snapshot(requests.map(item => ({ ...item, revision, live: revision === 3 ? item.workflow_id === 'wf13' : item.live,
      stages: [{ id: 'coding', state: 'running' }] })));
    assert.ok(options.every((option, index) => panel.chooser.options[index] === option), 'Snapshots preserve the option nodes');
    assert.equal(panel.chooser.value, 'wf13', 'Snapshots preserve the transient choice');
    assert.equal(panel.chooser.valueWrites.length, writes, 'Snapshots do not write SELECT.value while focused');
    assert.match(panel.elements.get('title').textContent, /WF-R0025/, 'Live following waits while the chooser is in use');
    assert.match(panel.elements.get('action').textContent, new RegExp(`revision ${revision}`), 'Request details still refresh');
  }
  panel.chooser.dispatch('change');
  panel.snapshot(requests);
  assert.match(panel.elements.get('title').textContent, /WF-R0013/);
  panel.chooser.blur();
  const settledOptions = [...panel.chooser.options], settledWrites = panel.chooser.valueWrites.length;
  panel.snapshot(requests);
  assert.ok(settledOptions.every((option, index) => panel.chooser.options[index] === option), 'Unchanged options also stay stable after blur');
  assert.equal(panel.chooser.valueWrites.length, settledWrites, 'An unchanged committed selection is not reassigned');
  assert.equal(panel.chooser.value, 'wf13');
  assert.match(panel.elements.get('title').textContent, /WF-R0013/, 'Manual selection survives later native activity');
});

test('V-model follows live requests automatically until a manual choice and resumes after unpin', () => {
  const panel = panelClient(), requests = selectorRequests();
  panel.snapshot(requests.map(item => ({ ...item, live: false })));
  panel.snapshot(requests.map(item => ({ ...item, live: item.workflow_id === 'wf13' })));
  assert.equal(panel.chooser.value, 'wf13', 'An untouched view follows the live request');
  panel.chooser.value = 'wf25'; panel.chooser.dispatch('change');
  panel.snapshot(requests.map(item => ({ ...item, live: item.workflow_id === 'wf13' })));
  assert.equal(panel.chooser.value, 'wf25', 'A manual choice is not stolen by live following');
  panel.chooser.value = 'wf13'; panel.chooser.dispatch('change');
  panel.elements.get('pin').click();
  assert.equal(panel.messages.at(-1).workflow_id, 'wf13');
  panel.message({ type: 'pinned', workflow_id: 'wf13' });
  panel.snapshot(requests, { pinned: 'wf13' });
  assert.equal(panel.chooser.value, 'wf13');
  assert.equal(panel.elements.get('pin').getAttribute('aria-pressed'), 'true');
  panel.elements.get('pin').click();
  assert.equal(panel.messages.at(-1).workflow_id, null);
  const messagesAfterUnpin = panel.messages.length;
  panel.message({ type: 'pinned', workflow_id: undefined });
  assert.equal(panel.chooser.value, 'wf25', 'Unpin immediately follows the live request in the existing snapshot');
  assert.match(panel.elements.get('title').textContent, /WF-R0025/);
  assert.equal(panel.messages.length, messagesAfterUnpin, 'Following cached activity needs no extra backend read or model request');
  panel.snapshot(requests);
  assert.equal(panel.chooser.value, 'wf25', 'Explicit unpin restores live following');
});

test('V-model unpin preserves a focused pending choice and a later committed manual selection', () => {
  const panel = panelClient(), requests = selectorRequests();
  panel.snapshot(requests);
  panel.chooser.value = 'wf13'; panel.chooser.dispatch('change');
  panel.message({ type: 'pinned', workflow_id: 'wf13' });
  const options = [...panel.chooser.options], writes = panel.chooser.valueWrites.length;
  panel.chooser.focus(); panel.chooser.selectedIndex = 0;
  panel.message({ type: 'pinned', workflow_id: undefined });
  assert.equal(panel.chooser.value, 'wf25');
  assert.equal(panel.chooser.valueWrites.length, writes);
  assert.ok(options.every((option, index) => panel.chooser.options[index] === option));
  assert.match(panel.elements.get('title').textContent, /WF-R0013/, 'Following waits while the chooser is in use');
  panel.chooser.dispatch('change'); panel.chooser.blur();
  panel.snapshot(requests.map(item => ({ ...item, live: item.workflow_id === 'wf13' })));
  assert.equal(panel.chooser.value, 'wf25', 'The explicit committed choice wins over a different live request');
});

test('V-model unpin retains the current request when the existing snapshot has no live request', () => {
  const panel = panelClient();
  panel.snapshot(selectorRequests().map(item => ({ ...item, live: false })));
  panel.chooser.value = 'wf13'; panel.chooser.dispatch('change');
  panel.message({ type: 'pinned', workflow_id: 'wf13' });
  panel.message({ type: 'pinned', workflow_id: undefined });
  assert.equal(panel.chooser.value, 'wf13');
  assert.match(panel.elements.get('title').textContent, /WF-R0013/);
  assert.equal(panel.elements.get('pin').getAttribute('aria-pressed'), 'false');
});

test('V-model defers changed selector options while focused and reconciles the latest list on blur', () => {
  const panel = panelClient(), requests = selectorRequests();
  panel.snapshot(requests);
  const options = [...panel.chooser.options];
  panel.chooser.focus();
  panel.chooser.selectedIndex = 1;
  const changed = requests.map(item => ({ ...item, title: `${item.title} updated` }));
  changed.push({ ...requests[1], workflow_id: 'wf26', request_key: 'WF-R0026' });
  panel.snapshot(changed);
  assert.equal(panel.chooser.options.length, 2);
  assert.ok(options.every((option, index) => panel.chooser.options[index] === option));
  assert.equal(panel.chooser.value, 'wf13');
  panel.chooser.dispatch('change');
  panel.chooser.blur();
  assert.equal(panel.chooser.options.length, 3);
  assert.match(panel.chooser.options[1].textContent, /Earlier request updated/);
  assert.equal(panel.chooser.value, 'wf13');
});

test('V-model recovers when a manually selected request disappears, including during selector interaction', () => {
  const panel = panelClient(), requests = selectorRequests();
  panel.snapshot(requests);
  panel.chooser.value = 'wf13'; panel.chooser.dispatch('change');
  panel.chooser.focus();
  panel.snapshot([requests[0]]);
  assert.equal(panel.chooser.value, 'wf13', 'The focused selector still contains the removed choice until blur');
  assert.match(panel.elements.get('title').textContent, /WF-R0025/, 'The request view already uses the current fallback');
  panel.chooser.dispatch('change'); // The deferred menu can still contain the removed request.
  panel.chooser.blur();
  assert.equal(panel.chooser.value, 'wf25');
  assert.match(panel.elements.get('title').textContent, /WF-R0025/);
  panel.snapshot([]);
  assert.equal(panel.chooser.value, '');
  assert.equal(panel.chooser.disabled, true);
  assert.equal(panel.elements.get('details').hidden, true);
  panel.snapshot(requests.map(item => ({ ...item, live: item.workflow_id === 'wf13' })));
  assert.equal(panel.chooser.value, 'wf13', 'Fallback restores automatic following');
});

test('V-model reads saved requests beside chat, keeps the selected request isolated and opens only its listed files', async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'workforce-vmodel-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['output.md', 'check.md']) writeFileSync(join(root, file), file);
  const requests = [
    { workflow_id: 'first', title: 'First request', status: 'running', stages: [{ id: 'coding', state: 'running' }],
      artifacts: [{ path: 'output.md' }] },
    { workflow_id: 'second', title: 'Second request', status: 'paused', stages: [{ id: 'coding', state: 'repairing' }, { id: 'system', state: 'not-applicable' }],
      evidence: [{ path: 'check.md', label: 'Observed check', passed: false, exit_code: 1 }, { path: '../outside.md' }] },
  ];
  const opened = [], state = new Map(), stateWrites = [], commands = new Map(), watchers = [];
  let receive, disposePanel, html, client, reads = 0, unavailable = false;
  const uri = fsPath => ({ scheme: 'file', fsPath, toString: () => 'vscode-webview://fixture' });
  const vscode = {
    ViewColumn: { Beside: -2 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    Uri: { file: uri, joinPath: (base, filename) => uri(join(base.fsPath, filename)) },
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; },
      async executeCommand(name, target) { assert.equal(name, 'vscode.open'); opened.push(target.fsPath); },
    },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(root) }], onDidChangeWorkspaceFolders() { return { dispose() {} }; },
      createFileSystemWatcher(pattern) {
        assert.equal(pattern.base, root);
        const watcher = { callbacks: [], disposed: false,
          onDidCreate(callback) { this.callbacks.push(callback); return { dispose() {} }; },
          onDidChange(callback) { this.callbacks.push(callback); return { dispose() {} }; },
          onDidDelete(callback) { this.callbacks.push(callback); return { dispose() {} }; },
          dispose() { this.disposed = true; } };
        watchers.push(watcher); return watcher;
      } },
    window: {
      createWebviewPanel(_id, title, column) {
        assert.equal(column, vscode.ViewColumn.Beside);
        assert.equal(title, 'WorkForce V-model');
        return {
          webview: {
            cspSource: 'vscode-webview://fixture', asWebviewUri: value => value,
            set html(value) { html = value; },
            onDidReceiveMessage(callback) { receive = callback; return { dispose() {} }; },
            async postMessage(message) { client(message); },
          },
          onDidDispose(callback) { disposePanel = callback; },
        };
      },
      showErrorMessage(message) { assert.fail(message); },
      showWarningMessage(message) { assert.fail(message); },
    },
  };
  const runtime = {
    requestListForMonitor(project) {
      assert.equal(project, root);
      reads++;
      if (unavailable) throw new Error('Test snapshot temporarily unavailable');
      return { requests };
    },
    safePath: join,
  };
  const context = { subscriptions: [], workspaceState: {
    get: key => state.get(key),
    async update(key, value) { stateWrites.push(value); state.set(key, value); },
  } };
  activateVModelPanel(vscode, context, async () => runtime);

  async function openPanel(saved) {
    await commands.get('workforce.vModel.open')();
    assert.match(html, /Saved WorkForce request state/);
    assert.match(html, /Native Local activity appears only for calls owned by this editor/);
    const { document, elements } = panelDocument([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    let pending;
    runInNewContext(clientSource, { document, window: { WorkForceUniverse: universe,
      addEventListener(_event, listener) { client = data => listener({ data }); } },
    acquireVsCodeApi: () => ({ getState: () => saved, setState(value) { saved = value; }, postMessage(message) { pending = receive(message); } }) });
    await pending;
    return { elements, wait: () => pending, state: () => saved };
  }

  let panel = await openPanel();
  assert.equal(reads, 1);
  assert.deepEqual(stateWrites, []);
  assert.match(panel.elements.get('title').textContent, /First request/);
  panel.elements.get('artifacts').querySelector('button').click();
  await panel.wait();
  assert.deepEqual(opened, [join(root, 'output.md')]);

  panel.elements.get('request').value = 'second';
  panel.elements.get('request').dispatch('change');
  assert.equal(reads, 1, 'Selection renders the snapshot already read');
  assert.match(panel.elements.get('title').textContent, /Second request/);
  assert.match(panel.elements.get('artifacts').textContent, /No saved artifacts/);
  const nodes = panel.elements.get('v-model').querySelectorAll('.v-node');
  const coding = nodes.find(node => node.dataset.stage === 'coding');
  assert.equal(coding.dataset.state, 'repairing');
  assert.equal(nodes.find(node => node.dataset.stage === 'system').dataset.state, 'not-applicable');
  coding.dispatch('keydown', { key: 'Enter' });
  assert.match(panel.elements.get('stage-detail').textContent, /Coding.*WF\.FnD.*repairing/);
  panel.elements.get('evidence').querySelector('button').click();
  await panel.wait();
  await receive({ type: 'open-file', workflow_id: 'second', path: 'output.md' });
  await receive({ type: 'open-file', workflow_id: 'second', path: '../outside.md' });
  assert.deepEqual(opened, [join(root, 'output.md'), join(root, 'check.md')]);

  panel.elements.get('pin').click();
  await panel.wait();
  assert.deepEqual(stateWrites, ['second']);
  requests[0].source = 'native-local'; requests[0].live = true;
  requests[0].active_agents = [{ role: 'WF.FnD', requested_model: { selection: 'explicit', id: 'chosen', vendor: 'endpoint' },
    observed_model: 'unknown', observed_provider: 'unknown' }];
  watchers[0].callbacks[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(panel.elements.get('title').textContent, /Second request/, 'Pinned request is not hijacked by another native call');
  const readsBeforeUnpin = reads;
  panel.elements.get('pin').click();
  await panel.wait();
  assert.match(panel.elements.get('title').textContent, /First request/, 'The pin acknowledgement immediately applies already observed live activity');
  assert.equal(reads, readsBeforeUnpin, 'Unpin does not request another backend snapshot');
  watchers[0].callbacks[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(panel.elements.get('title').textContent, /First request/, 'Unpinned view follows a correlated owned native request');
  assert.match(panel.elements.get('activity').textContent, /WF\.FnD running.*chosen.*observed model: unknown/);
  panel.elements.get('request').value = 'second'; panel.elements.get('request').dispatch('change');
  panel.elements.get('pin').click(); await panel.wait();
  disposePanel();
  assert.equal(watchers[0].disposed, true);
  panel = await openPanel();
  assert.match(panel.elements.get('title').textContent, /Second request/);
  assert.equal(panel.elements.get('pin').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(stateWrites, ['second', undefined, 'second']);
  unavailable = true;
  panel.elements.get('refresh').click();
  await panel.wait();
  assert.match(panel.elements.get('notice').textContent, /stale/);
  assert.match(panel.elements.get('title').textContent, /Second request/);
  disposePanel();
});
