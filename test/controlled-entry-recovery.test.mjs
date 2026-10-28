// The real-runtime case retains its historical backend mode; extension-owned
// receipt journals use the current WorkForce namespace on both adapters.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { atomicWrite, safePath, withOperationLock, loadRecords } from '../dist/storage.js';
import { startControlledHost, startControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { shutdownNative } from '../dist/native.js';
const require = createRequire(import.meta.url);
const { createControlledEntryReceipts } = require('../extensions/vscode-model-bridge/controlled-entry.cjs');
const { createControlledPanelHost, activateControlledWorkflows, TOOL_NAME } = require('../extensions/vscode-model-bridge/controlled-workflows.cjs');

function fixture(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-entry-recovery-')));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const workflows = new Map(), attempts = [], artifacts = [];
  let loseResponse = false, reject = false;
  const runtime = {
    atomicWrite, safePath, withOperationLock,
    controlledStatus: async (_root, id) => id ? [...workflows.values()].find(value => value.workflow_id === id) : [...workflows.values()],
    startControlledWorkflow: async (_root, input) => {
      const journal = JSON.parse(readFileSync(join(root, '.workforce/controlled/entrypoints/panel.json'), 'utf8'));
      assert.ok(journal.entries.some(value => value.request_id === input.request_id && value.payload.requirement === input.requirement), 'identity must be durable before dispatch');
      attempts.push(input.request_id);
      if (reject) throw new Error('PRIVATE_TRANSPORT_DETAIL');
      if (!workflows.has(input.request_id)) {
        const workflow = { workflow_id: `NM-TEST-KNW-${String(workflows.size + 1).padStart(4, '0')}`, epoch_id: randomUUID(),
          request_id: input.request_id, requirement: input.requirement, status: 'queued', phase: 'planning' };
        workflows.set(input.request_id, workflow);
        const artifact = `effect-${workflows.size}.txt`; writeFileSync(join(root, artifact), input.requirement, { flag: 'wx' }); artifacts.push(artifact);
      }
      if (loseResponse) { loseResponse = false; throw new Error('PRIVATE_LOST_RESPONSE'); }
      return workflows.get(input.request_id);
    },
    controlControlledWorkflow: async (_root, { workflow_id }) => [...workflows.values()].find(value => value.workflow_id === workflow_id),
  };
  return { root, runtime, workflows, attempts, artifacts, lose: value => { loseResponse = value; }, reject: value => { reject = value; },
    store: () => createControlledEntryReceipts({ runtime, root, surface: 'panel' }) };
}

test('lost backend acceptance response reconciles the exact durable identity across facade restart and concurrent retry', async t => {
  const a = fixture(t); a.lose(true);
  const first = await a.store().submit({ requirement: 'Produce one bounded artifact.' });
  const again = await Promise.all([a.store().submit({ requirement: 'Produce one bounded artifact.' }), a.store().submit({ requirement: 'Produce one bounded artifact.' })]);
  assert.equal(a.attempts.length, 1); assert.equal(a.workflows.size, 1); assert.equal(a.artifacts.length, 1);
  for (const replay of again) { assert.equal(replay.workflow.workflow_id, first.workflow.workflow_id); assert.equal(replay.workflow.epoch_id, first.workflow.epoch_id); }
  assert.deepEqual(JSON.parse(readFileSync(join(a.root, '.workforce/controlled/entrypoints/panel.json'), 'utf8')).entries.map(entry => entry.request_id), a.attempts);
});

test('unknown unaccepted request retries its saved key and cannot substitute changed content', async t => {
  const a = fixture(t); a.reject(true);
  await assert.rejects(a.store().submit({ requirement: 'Saved original content.' }), { code: 'INTAKE_RESPONSE_UNKNOWN' });
  await assert.rejects(a.store().submit({ requirement: 'Changed replacement content.' }), { code: 'INTAKE_PENDING' });
  assert.equal(a.attempts.length, 1); a.reject(false);
  await a.store().submit({ requirement: 'Saved original content.' });
  assert.equal(a.attempts.length, 2); assert.equal(a.attempts[0], a.attempts[1]); assert.equal(a.workflows.size, 1);
});

test('unacknowledged panel delivery is replayed after close; duplicate new-intent and late ACK cannot create or clear later work', async t => {
  const a = fixture(t), sent = [];
  let alive = true, loseDelivery = true;
  const host = createControlledPanelHost({ runtime: a.runtime, root: a.root, enabled: () => true, alive: () => alive,
    post: async value => { if (value.type === 'controlled-receipt' && loseDelivery) { loseDelivery = false; alive = false; throw new Error('lost webview'); } sent.push(value); } });
  await host.handle({ type: 'controlled-action', action: 'submit', requirement: 'Identical intentional task.' });
  assert.equal(a.workflows.size, 1);
  const reopened = createControlledPanelHost({ runtime: a.runtime, root: a.root, enabled: () => true, post: async value => sent.push(value) });
  await reopened.handle({ type: 'controlled-action', action: 'status' });
  const receipt = sent.find(value => value.type === 'controlled-receipt'); assert.ok(receipt?.replay);
  const original = receipt.intake.generation, firstId = receipt.workflows[0].workflow_id;
  await reopened.handle({ type: 'controlled-receipt-ack', generation: original, workflow_id: firstId });
  await reopened.handle({ type: 'controlled-action', action: 'submit_new', generation: original, requirement: 'Identical intentional task.' });
  await reopened.handle({ type: 'controlled-action', action: 'submit_new', generation: original, requirement: 'Identical intentional task.' });
  assert.equal(a.workflows.size, 2); assert.equal(a.artifacts.length, 2);
  const second = await a.store().recover();
  assert.notEqual(second.intake.generation, original);
  assert.equal(a.store().acknowledge(original, firstId), false);
  assert.equal((await a.store().recover()).intake.state, 'accepted');
  assert.equal((await a.store().submit({ requirement: 'Identical intentional task.' }, { generation: original })).workflow.workflow_id, firstId);
  assert.equal((await a.store().recover()).intake.generation, second.intake.generation);
});

test('acknowledged identical LM submit replays; explicit fresh turn creates one new intake and late old token replays its own receipt', async t => {
  const a = fixture(t), commands = new Map(), tools = new Map();
  const runtime = { ...a.runtime, startControlledWorkflow: async (_root, input) => {
    a.attempts.push(input.request_id);
    if (!a.workflows.has(input.request_id)) a.workflows.set(input.request_id, { workflow_id: `NM-LM-KNW-${a.workflows.size + 1}`, epoch_id: randomUUID(),
      request_id: input.request_id, requirement: input.requirement, status: 'queued' });
    return a.workflows.get(input.request_id);
  } };
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: a.root } }], onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; } },
    lm: { registerTool: (name, value) => { tools.set(name, value); return { dispose() {} }; } },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } }, LanguageModelTextPart: class { constructor(value) { this.value = value; } } };
  activateControlledWorkflows(vscode, { subscriptions: [] }, async () => runtime, { enabled: () => true });
  const invoke = async (action, extra = {}, toolInvocationToken) => JSON.parse((await tools.get(TOOL_NAME).invoke({ input: { action, workspace_folder: a.root, ...extra }, toolInvocationToken })).content[0].value);
  const firstToken = {}, nextToken = {};
  const first = await invoke('submit', { requirement: 'Produce one result.' }, firstToken);
  await invoke('status', { workflow_id: first.workflows[0].workflow_id });
  const repeated = await invoke('submit', { requirement: 'Produce one result.' });
  assert.equal(repeated.workflows[0].workflow_id, first.workflows[0].workflow_id);
  const missingContext = await invoke('submit_new', { requirement: 'Produce one result.' });
  assert.equal(missingContext.error.code, 'INTAKE_NEW_CONTEXT_REQUIRED');
  const second = await invoke('submit_new', { requirement: 'Produce one result.' }, nextToken);
  await invoke('status', { workflow_id: second.workflows[0].workflow_id });
  const duplicate = await invoke('submit_new', { requirement: 'Produce one result.' }, nextToken);
  const late = await invoke('submit', { requirement: 'Produce one result.' }, firstToken);
  assert.equal(duplicate.workflows[0].workflow_id, second.workflows[0].workflow_id);
  assert.equal(late.workflows[0].workflow_id, first.workflows[0].workflow_id);
  assert.equal(a.workflows.size, 2); assert.equal(a.attempts.length, 2);
  const bytes = readFileSync(join(a.root, '.workforce/controlled/entrypoints/lm.json'), 'utf8');
  assert.doesNotMatch(bytes, /toolInvocationToken|PRIVATE/);
});

test('LM facade restart after a lost delivered result retains its intake; ambiguous identical history never selects an actor by guessing', async t => {
  const a = fixture(t);
  const runtime = { ...a.runtime, startControlledWorkflow: async (_root, input) => {
    a.attempts.push(input.request_id);
    if (!a.workflows.has(input.request_id)) a.workflows.set(input.request_id, { workflow_id: `NM-LM-KNW-${a.workflows.size + 1}`, epoch_id: randomUUID(), request_id: input.request_id,
      requirement: input.requirement, status: 'queued' });
    return a.workflows.get(input.request_id);
  } };
  let store = createControlledEntryReceipts({ runtime, root: a.root, surface: 'lm' });
  const owner = randomUUID();
  const first = await store.submit({ requirement: 'One saved request.' }, { context: `${owner}:${randomUUID()}:submit` });
  // The caller loses the result; only the private durable journal survives restart.
  store = createControlledEntryReceipts({ runtime, root: a.root, surface: 'lm' });
  const retry = await store.submit({ requirement: 'One saved request.' });
  assert.equal(retry.workflow.workflow_id, first.workflow.workflow_id); assert.equal(a.attempts.length, 1);
  store.acknowledgeWorkflow(first.workflow.workflow_id);
  await assert.rejects(store.submit({ requirement: 'One saved request.' }, { newTask: true, context: `${randomUUID()}:${randomUUID()}:submit_new` }), { code: 'INTAKE_NEW_CONTEXT_REQUIRED' });
  await store.submit({ requirement: 'One saved request.' }, { newTask: true, context: `${owner}:${randomUUID()}:submit_new` });
  await assert.rejects(createControlledEntryReceipts({ runtime, root: a.root, surface: 'lm' }).submit({ requirement: 'One saved request.' }), { code: 'INTAKE_CONTEXT_REQUIRED' });
  assert.equal(a.attempts.length, 2);
});

test('actual runtime intake accepts through the facade once when the client loses its response', async t => {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-real-entry-')));
  // This fixture historically ran with initialize's default of one repair.
  initialize(root, { name: 'Actual intake recovery', platforms: ['copilot'], repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, vscode_effort_policy: 'allow-unavailable' }));
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    lm: { selectChatModels: async () => [] } };
  const bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  let lose = true, calls = 0;
  const runtime = { atomicWrite, safePath, withOperationLock, controlledStatus,
    startControlledWorkflow: async (...args) => { calls++; const receipt = await startControlledWorkflow(...args); if (lose) { lose = false; throw new Error('lost client response after actual durable acceptance'); } return receipt; } };
  const first = await createControlledEntryReceipts({ runtime, root, surface: 'panel' }).submit({ requirement: 'Hold this bounded intake for transport validation; no model inference is available in this fixture.' });
  const replay = await createControlledEntryReceipts({ runtime, root, surface: 'panel' }).submit({ requirement: 'Hold this bounded intake for transport validation; no model inference is available in this fixture.' });
  assert.equal(first.workflow.workflow_id, replay.workflow.workflow_id); assert.equal(first.workflow.epoch_id, replay.workflow.epoch_id); assert.equal(calls, 1);
  assert.equal(loadRecords(root).filter(record => record.meta.data.kind === 'manager-workflow').length, 1);
});

test('read-only facade recovery does not create an intake or overwrite an invalid journal', async t => {
  const a = fixture(t);
  assert.equal((await a.store().recover()).intake, null);
  const path = safePath(a.root, '.workforce/controlled/entrypoints/panel.json');
  atomicWrite(path, '{invalid');
  await assert.rejects(a.store().recover(), { code: 'INTAKE_STORE_INVALID' });
  assert.equal(readFileSync(path, 'utf8'), '{invalid'); assert.equal(a.attempts.length, 0);
});

test('panel persists pending input and ACKs only the matching rendered receipt; stale delivery preserves a new draft', () => {
  const elements = new Map(), listeners = new Map(), posted = []; let saved = { draft: 'Original request.' };
  class Element {
    constructor() { this.children = []; this.value = ''; this.events = new Map(); }
    addEventListener(type, fn) { this.events.set(type, fn); }
    append(...children) { this.children.push(...children); } replaceChildren() { this.children = []; }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = { acquireVsCodeApi: () => ({ getState: () => saved, setState: value => { saved = structuredClone(value); }, postMessage: value => posted.push(value) }),
    document: { getElementById: get, createElement: () => new Element() }, window: { addEventListener: (type, fn) => listeners.set(type, fn) } };
  vm.runInNewContext(readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/controlled.js', import.meta.url), 'utf8'), context);
  const deliver = value => listeners.get('message')({ data: value });
  const generation = randomUUID(), next = randomUUID();
  deliver({ type: 'controlled-snapshot', enabled: true, workflows: [], intake: null });
  get('submit').events.get('click')(); assert.equal(saved.pending.requirement, 'Original request.');
  deliver({ type: 'controlled-receipt', action: 'submit', workflows: [{ workflow_id: 'NM-ONE' }], intake: { generation, state: 'accepted' } });
  assert.equal(get('requirement').value, '');
  assert.ok(posted.some(value => value.type === 'controlled-receipt-ack' && value.generation === generation));
  get('requirement').value = 'Draft typed while ACK is in transit.'; get('requirement').events.get('input')();
  deliver({ type: 'controlled-receipt', action: 'submit', workflows: [{ workflow_id: 'NM-ONE' }], intake: { generation, state: 'accepted' }, replay: true });
  assert.equal(get('requirement').value, 'Draft typed while ACK is in transit.');
  deliver({ type: 'controlled-snapshot', enabled: true, workflows: [], intake: { generation, state: 'acknowledged' } });
  get('requirement').value = 'A deliberately new task.'; get('submit').events.get('click')();
  assert.equal(posted.at(-1).action, 'submit_new'); assert.equal(posted.at(-1).generation, generation);
  deliver({ type: 'controlled-receipt', source_generation: generation, action: 'submit_new', workflows: [{ workflow_id: 'NM-TWO' }], intake: { generation: next, state: 'accepted' } });
  get('requirement').value = 'Keep my unsent draft.'; get('requirement').events.get('input')();
  deliver({ type: 'controlled-receipt', action: 'submit', workflows: [{ workflow_id: 'NM-ONE' }], intake: { generation, state: 'accepted' } });
  assert.equal(get('requirement').value, 'Keep my unsent draft.'); assert.equal(saved.intake.generation, next);
});
