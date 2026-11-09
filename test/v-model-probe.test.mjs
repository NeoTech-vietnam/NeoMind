import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createVModelProofObserver, instrumentClientSource } = require('./vscode-client-driver/native-local/v-model-probe.cjs');
const ids = ['requirements', 'analysis', 'architecture', 'module-design', 'coding', 'unit', 'integration', 'system', 'acceptance'];
const clientSource = '(() => { const vscode = acquireVsCodeApi(); window.productApi = vscode; })();';
function fixture({ respond = true, valid = true, holdFrames = false, activeRepair = false, timeoutMs = 5000 } = {}) {
  let receiver, disposePanel, browserReceive, acquireCount = 0;
  const writes = [], commands = new Map(), frames = [];
  const hostApi = { postMessage(value) { receiver(value); } };
  const rect = () => ({ x: 10, y: 20, width: 100, height: 30 });
  const repairPath = { computed: { display: 'inline', animationName: 'stage-flow', animationDuration: '1.6s' }, getBoundingClientRect: rect };
  const repairGroup = { computed: { display: 'block', animationName: 'none', animationDuration: '0s' },
    getAttribute: () => 'repairing', querySelector: name => name === 'path' ? repairPath : null, getBoundingClientRect: rect };
  const document = { body: { className: activeRepair ? 'vscode-dark' : 'vscode-dark vscode-reduce-motion' }, activeElement: null,
    querySelector: selector => selector === '.v-rework' && activeRepair ? repairGroup : null, getElementById: () => null,
    querySelectorAll: () => (valid ? ids : ids.slice(1)).map(id => ({ getAttribute: name => name === 'data-stage' ? id : 'pending', querySelector: () => null })) };
  const window = { addEventListener(type, fn) { browserReceive = fn; } };
  const webview = { html: '', onDidReceiveMessage(fn) { receiver = fn; return { dispose() {} }; },
    postMessage(message) { if (message.type === 'snapshot' || respond && message.type === 'wf-vmodel-style-request') browserReceive({ data: message }); return Promise.resolve(true); } };
  const panel = { webview, onDidDispose(fn) { disposePanel = fn; } };
  const vscode = { window: { createWebviewPanel() { return panel; } }, commands: { registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; } } };
  const observer = createVModelProofObserver(vscode, { subscriptions: [] }, (file, data) => writes.push({ file, data }), { clientSource, timeoutMs });
  const owned = observer.vscode.window.createWebviewPanel('workforce.vModel');
  owned.webview.html = '<body><script nonce="abcdef1234" src="vscode-resource://v-model-panel.js"></script></body>';
  const script = /<script nonce="abcdef1234">([\s\S]*?)<\/script>/.exec(webview.html)?.[1];
  assert.ok(script, 'Exact original nonce protects instrumented native source');
  runInNewContext(script, { document, window, acquireVsCodeApi() { acquireCount++; if (acquireCount > 1) throw new Error('Already acquired'); return hostApi; },
    requestAnimationFrame(fn) { if (holdFrames) frames.push(fn); else fn(); }, matchMedia: () => ({ matches: false }), getComputedStyle: element => element.computed ?? {}, crypto: webcrypto, TextEncoder,
    innerWidth: 900, innerHeight: 700, devicePixelRatio: 1 });
  return { observer, owned, writes, window, hostApi, commands, acquireCount, repairPath, flush() { while (frames.length) frames.shift()(); }, close: () => disposePanel() };
}
test('native DOM observer shares the one real API acquisition with unchanged client source and correlates snapshot', async () => {
  const f = fixture();
  assert.equal(f.acquireCount, 1); assert.equal(f.window.productApi, f.hostApi);
  await f.owned.webview.postMessage({ type: 'snapshot', project: 'Owned', requests: [{ workflow_id: 'real' }] });
  const result = await f.commands.get('workforceM2.captureVModelStyles')('dark-native-reduced');
  assert.equal(result.observed, true); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data.snapshot.requests[0].workflow_id, 'real');
  assert.match(f.writes[0].data.snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.writes[0].data.computed.body_classes, 'vscode-dark vscode-reduce-motion');
  assert.equal(f.writes[0].data.computed.stages.length, 9);
  f.close();
});
test('missing and incomplete native DOM observations never become successful evidence', async () => {
  for (const options of [{ respond: false }, { valid: false }]) {
    const f = fixture({ ...options, timeoutMs: 25 }), result = await f.observer.capture();
    assert.equal(result.observed, false); assert.equal(f.writes.length, 0); f.close();
  }
  const f = fixture({ respond: false }), pending = f.observer.capture(); f.close();
  assert.equal((await pending).reason, 'native-panel-closed');
});
test('observer refuses an ambiguous client API binding instead of acquiring its own handle', () => {
  assert.throws(() => instrumentClientSource('', 'channel'), /Exact native client/);
  assert.throws(() => instrumentClientSource(`${clientSource}${clientSource}`, 'channel'), /Exact native client/);
});
test('a real client snapshot advancing before paint cannot be misattributed to the earlier host snapshot', async () => {
  const f = fixture({ holdFrames: true });
  await f.owned.webview.postMessage({ type: 'snapshot', requests: [{ workflow_id: 'same', revision: 1 }] });
  const pending = f.observer.capture('earlier-running');
  await f.owned.webview.postMessage({ type: 'snapshot', requests: [{ workflow_id: 'same', revision: 2 }] });
  f.flush(); const result = await pending;
  assert.equal(result.observed, false); assert.equal(result.reason, 'native-snapshot-advanced'); assert.equal(f.writes.length, 0); f.close();
});
test('native repair observations distinguish group visibility from the actual animated child path', async () => {
  const f = fixture({ activeRepair: true });
  assert.equal((await f.observer.capture()).observed, true);
  const first = f.writes[0].data.computed.repair;
  assert.equal(first.state, 'repairing'); assert.equal(first.style.display, 'block'); assert.equal(first.style.animation_name, 'none');
  assert.equal(first.path_style.animation_name, 'stage-flow'); assert.equal(first.path_style.animation_duration, '1.6s');
  f.repairPath.computed = { display: 'inline', animationName: 'none', animationDuration: '0s' };
  assert.equal((await f.observer.capture()).observed, true);
  assert.equal(f.writes[1].data.computed.repair.path_style.animation_name, 'none');
  assert.equal(f.writes[1].data.computed.repair.path_style.animation_duration, '0s'); f.close();
});
