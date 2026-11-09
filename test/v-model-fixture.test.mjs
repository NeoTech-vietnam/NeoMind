import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openVModelAndObserve } = require('./vscode-client-driver/native-local/v-model-fixture.cjs');

function fixture(open) {
  const listeners = new Set();
  const subscribe = listener => {
    const subscription = { listener };
    listeners.add(subscription);
    return { dispose: () => listeners.delete(subscription) };
  };
  const tabs = { all: [], onDidChangeTabs: subscribe, onDidChangeTabGroups: subscribe };
  const vscode = { window: { tabGroups: tabs }, commands: { async executeCommand(command) {
    assert.equal(command, 'workforce.vModel.open');
    await open(() => {
      tabs.all = [{ tabs: [{ label: 'WorkForce V-model' }] }];
      for (const { listener } of listeners) listener();
    });
  } } };
  return { vscode, listeners };
}

test('V-model proof waits for the tab event after command completion', async () => {
  let registerTab;
  const { vscode, listeners } = fixture(register => { registerTab = register; });
  const result = openVModelAndObserve(vscode, 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(vscode.window.tabGroups.all, [], 'Command completion does not prove the editor tab is registered');
  assert.equal(listeners.size, 2);
  registerTab();
  assert.equal(await result, true);
  assert.equal(listeners.size, 0);
});

test('V-model proof reports an unobserved tab without waiting indefinitely', async () => {
  const { vscode, listeners } = fixture(() => {});
  assert.equal(await openVModelAndObserve(vscode, 5), false);
  assert.equal(listeners.size, 0);
});

test('V-model proof cleans up tab observers when opening fails', async () => {
  const { vscode, listeners } = fixture(() => { throw new Error('Panel unavailable'); });
  await assert.rejects(openVModelAndObserve(vscode), /Panel unavailable/);
  assert.equal(listeners.size, 0);
});
