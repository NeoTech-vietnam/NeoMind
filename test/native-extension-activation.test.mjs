import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../extensions/vscode-model-bridge/extension.cjs', import.meta.url), 'utf8');

test('native activation registers native surfaces without importing or connecting the historical engine', async () => {
  const calls = [], commands = new Map(); let closed = 0;
  const vscode = { workspace: { isTrusted: true }, commands: {
    registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; },
    executeCommand(id) { calls.push(id); },
  } };
  const module = { exports: {} }, context = { subscriptions: [] };
  runInNewContext(source, { module, require(name) {
    if (name === 'vscode') return vscode;
    if (name.startsWith('node:')) return { realpathSync: {}, readFileSync() {}, isAbsolute() {}, join() {}, pathToFileURL() {} };
    if (name === './native-entry.cjs') return { activateNativeEntry() { calls.push('native'); return { async dispose() { closed++; } }; } };
    if (name === './v-model-panel.cjs') return { activateVModelPanel() { calls.push('v-model'); } };
    if (name === './plugin-panel.cjs') return { activatePluginPanel() { calls.push('plugins'); } };
    if (name === './automation-panel.cjs') return { activateAutomationPanel() { calls.push('reuse'); } };
    if (name === './native-focus.cjs') return { activateNativeFocus() { calls.push('focus'); } };
    if (name === './native-local-chat.cjs') return { registerNativeLocalChat() { calls.push('local'); return { dispose() {} }; } };
    throw Error(`Unexpected activation dependency: ${name}`);
  } });
  module.exports.activate(context);
  assert.deepEqual(calls, ['native', 'v-model', 'plugins', 'reuse', 'focus', 'local']);
  commands.get('workforce.monitor.open')(); assert.equal(calls.at(-1), 'workforce.vModel.open');
  await Promise.all([module.exports.deactivate(), module.exports.deactivate()]); assert.equal(closed, 1);
});
test('native entry contains no engine/controller/session restore or required alias/catalog bootstrap', () => {
  assert.doesNotMatch(source, /activateControlled|enableWorkForceHost|startControlledHost|probeWorkForce|showOpenDialog|top-models|worker-models|OpenCode/);
  assert.doesNotMatch(source, /native-rea-provider|managed-gateway|activateNativeReaProvider/);
  assert.match(source, /activateNativeEntry/);
});
