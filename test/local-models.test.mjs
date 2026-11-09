import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLocalModelPolicy } = require('../extensions/vscode-model-bridge/local-models.cjs');
const { nativeActivity, observeNativeCall, onNativeActivity } = require('../extensions/vscode-model-bridge/local-activity.cjs');
const { createLocalDelegator } = require('../extensions/vscode-model-bridge/local-delegation.cjs');

function fixture() {
  const saved = new Map(), picks = [], writes = [], inventory = [
    { id: 'a', vendor: 'endpoint', name: 'A' }, { id: 'b', vendor: 'other', name: 'B' },
    { id: 'no-tools', vendor: 'other', name: 'Text only', capabilities: { toolCalling: false } },
    { id: 'duplicate', vendor: 'other', name: 'Ambiguous 1' }, { id: 'duplicate', vendor: 'other', name: 'Ambiguous 2' },
  ];
  const context = { workspaceState: { get: (key, fallback) => saved.get(key) ?? fallback,
    async update(key, value) { writes.push(value); saved.set(key, value); } } };
  const vscode = { workspace: { isTrusted: true }, window: { async showQuickPick(items) {
    return picks.shift()?.(items);
  } }, lm: { selectChatModels: async () => inventory } };
  return { vscode, context, picks, writes, policy: createLocalModelPolicy(vscode, context, '/fixture') };
}

test('role preferences use native inventory, default to inheritance and are isolated per role and project', async () => {
  const f = fixture();
  assert.equal(f.policy.modelForRole('WF.FnD'), undefined);
  f.picks.push(items => items.find(item => item.label === 'WF.FnD'), items => {
    assert.deepEqual(items.map(item => item.label), ['Inherit native parent model', 'A', 'B']);
    return items.find(item => item.label === 'A');
  });
  assert.deepEqual(await f.policy.choose(), { role: 'WF.FnD', selection: 'explicit', applies: 'next-invocation' });
  assert.deepEqual(f.policy.modelForRole('WF.FnD'), { id: 'a', vendor: 'endpoint' });
  assert.equal(f.policy.modelForRole('WF.Tester'), undefined);
  assert.equal(f.policy.modelForRole('WF.PM'), undefined, 'Parent model belongs to the native picker');
  assert.equal(createLocalModelPolicy(f.vscode, f.context, '/another').modelForRole('WF.FnD'), undefined);
  f.picks.push(items => items.find(item => item.label === 'WF.FnD'), items => items[0]);
  await f.policy.choose();
  assert.equal(f.policy.modelForRole('WF.FnD'), undefined);
});

test('inventory failures and cancelling a picker preserve the last preference without model calls', async () => {
  const f = fixture();
  f.picks.push(items => items[2], items => items[1]);
  await f.policy.choose();
  const before = f.writes.length;
  f.picks.push(() => undefined);
  await f.policy.choose();
  f.picks.push(items => items[2]);
  f.vscode.lm.selectChatModels = async () => { throw new Error('Inventory unavailable'); };
  await assert.rejects(f.policy.choose(), /Inventory unavailable/);
  assert.equal(f.writes.length, before);
  assert.deepEqual(f.policy.modelForRole('WF.FnD'), { id: 'a', vendor: 'endpoint' });
});

test('actual native call observations end on completion; views cannot interrupt calls or cross projects', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let events = 0;
  const subscription = onNativeActivity('/owned', () => { events++; throw new Error('Broken view'); });
  const tool = { name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
    properties: Object.fromEntries(['prompt', 'description', 'agentName'].map(key => [key, { type: 'string' }])) } };
  const app = { lm: { tools: [tool], invokeTool() { return pending; } } };
  const result = createLocalDelegator(app).invoke({ agentName: 'WF.FnD', prompt: 'Implement bounded product', description: 'Work' }, {}, undefined,
    metadata => observeNativeCall('/owned', 'request', 'assignment', metadata));
  assert.equal(nativeActivity('/owned').calls.length, 1);
  assert.equal(nativeActivity('/another').calls.length, 0);
  const text = JSON.stringify(nativeActivity('/owned'));
  assert.doesNotMatch(text, /Implement bounded product|toolInvocationToken/);
  release({ content: [{ value: 'Actual role report' }] });
  assert.equal((await result).status, 'returned');
  assert.equal(nativeActivity('/owned').calls.length, 0);
  assert.equal(events, 2);
  subscription.dispose();
});
