import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { atomicWrite, safePath, withOperationLock } from '../dist/storage.js';
const require = createRequire(import.meta.url);
const { TOOL_NAME, LOCAL_COORDINATOR_COMMAND, activateControlledWorkflows, createControlledPanelHost, publicStatus, renderControlledPanel } = require('../extensions/vscode-model-bridge/controlled-workflows.cjs');
const workflowId = 'NM-TEST-KNW-0001';

function app(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-controlled-ui-')));
  t.after(() => { assert.equal(dirname(resolve(root)), parent); rmSync(root, { force: true, recursive: true }); });
  const calls = [], sent = [], errors = [], commands = new Map(), tools = new Map(), subscriptions = [];
  let active = true, enabled = true;
  const workflow = { workflow_id: workflowId, title: '<img onerror=evil()>', status: 'queued', phase: 'intake', transport: 'vscode-lm',
    epoch_id: '11111111-1111-1111-1111-111111111111',
    process_contract: 'software-tools/v2', token: 'PRIVATE', prompt: 'PRIVATE',
    active_invocations: [{ role: 'developer', state: 'running', requested_model: 'worker-alias', confirmed_model: 'registered-model', model_provider: 'custom-provider', token: 'PRIVATE', prompt: 'PRIVATE' }],
    events: [{ sequence: 1, type: 'dispatch', role: 'developer', at: '2026-10-25', summary: 'Backend-owned dispatch.', raw_payload: 'PRIVATE' }] };
  const runtime = {
    atomicWrite, safePath, withOperationLock,
    startControlledWorkflow: async (...args) => { calls.push(['submit', ...args]); Object.assign(workflow, { request_id: args[1].request_id, requirement: args[1].requirement }); return workflow; },
    controlledStatus: async (...args) => { calls.push(['status', ...args]); return [workflow]; },
    controlControlledWorkflow: async (...args) => { calls.push(['control', ...args]); return workflow; },
  };
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } },
    window: { showErrorMessage: async message => errors.push(message) },
    lm: { registerTool(name, value) { tools.set(name, value); return { dispose() {} }; } },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
  };
  const host = createControlledPanelHost({ runtime, root, post: async value => sent.push(value), alive: () => active, enabled: () => enabled });
  activateControlledWorkflows(vscode, { subscriptions }, async selected => { assert.equal(selected, root); return runtime; }, { enabled: selected => selected === root && enabled });
  const invoke = async input => JSON.parse((await tools.get(TOOL_NAME).invoke({ input })).content[0].value);
  return { root, workflow, runtime, vscode, calls, sent, errors, commands, host, invoke, tool: tools.get(TOOL_NAME), subscriptions,
    active: value => { active = value; }, enabled: value => { enabled = value; } };
}

function localCoordinator(a) {
  mkdirSync(join(a.root, '.github/agents'), { recursive: true });
  writeFileSync(join(a.root, '.github/agents/neomind-coordinator.agent.md'), '---\nname: "NeoMind Coordinator Agent"\n---\nProject Coordinator.\n');
  a.vscode.commands.getCommands = async () => ['workbench.action.chat.openInSidebar', 'workbench.action.chat.newLocalChat', 'workbench.action.chat.open'];
  return () => a.commands.get(LOCAL_COORDINATOR_COMMAND)();
}

test('Local Coordinator focuses the sidebar before creating Local chat from either focused chat location', async t => {
  for (const initialFocus of ['editor', 'sidebar']) {
    const a = app(t), open = localCoordinator(a), executed = [];
    let focused = initialFocus, harness = 'copilot', profile = 'Ask', model = 'top-models';
    a.vscode.commands.executeCommand = async (command, options) => {
      executed.push([command, ...(options === undefined ? [] : [options])]);
      if (command === 'workbench.action.chat.openInSidebar') focused = 'sidebar';
      // Installed VS Code's editor-clear path can promote an empty Local session
      // to its remembered harness; the sidebar path explicitly creates Local.
      if (command === 'workbench.action.chat.newLocalChat') harness = focused === 'sidebar' ? 'local' : 'copilot';
      if (command === 'workbench.action.chat.open') {
        profile = options.mode;
        if (options.modelSelector !== undefined) model = 'changed';
      }
    };
    assert.equal((await open()).opened, true);
    assert.equal(harness, 'local'); assert.equal(profile, 'NeoMind Coordinator Agent'); assert.equal(model, 'top-models');
    assert.deepEqual(executed, [['workbench.action.chat.openInSidebar'], ['workbench.action.chat.newLocalChat'],
      ['workbench.action.chat.open', { mode: 'NeoMind Coordinator Agent' }]]);
    assert.deepEqual(a.calls, []);
  }
});

test('Local Coordinator waits for the Chat view and Local chat before selecting the profile and preserves model choice', async t => {
  const a = app(t), open = localCoordinator(a), executed = [];
  let sidebarReady, localCreated;
  const sidebar = new Promise(resolve => { sidebarReady = resolve; });
  const local = new Promise(resolve => { localCreated = resolve; });
  a.vscode.commands.executeCommand = async (...args) => {
    executed.push(args);
    if (args[0] === 'workbench.action.chat.openInSidebar') await sidebar;
    if (args[0] === 'workbench.action.chat.newLocalChat') await local;
  };
  const pending = open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(executed, [['workbench.action.chat.openInSidebar']]);
  sidebarReady();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(executed, [['workbench.action.chat.openInSidebar'], ['workbench.action.chat.newLocalChat']]);
  localCreated();
  assert.deepEqual(await pending, { opened: true, target: 'local', profile: 'NeoMind Coordinator Agent', model_selection: 'user-picker' });
  assert.deepEqual(executed, [
    ['workbench.action.chat.openInSidebar'],
    ['workbench.action.chat.newLocalChat'],
    ['workbench.action.chat.open', { mode: 'NeoMind Coordinator Agent' }],
  ]);
  assert.deepEqual(a.calls, [], 'Opening chat must not submit a workflow or change routing.');
  assert.deepEqual(a.errors, []);
});

test('missing or failing Chat view or Local chat command stops before profile launch without a generic fallback', async t => {
  const a = app(t), open = localCoordinator(a), executed = [];
  a.vscode.commands.executeCommand = async (...args) => { executed.push(args); throw new Error('PRIVATE_PROVIDER_ERROR'); };
  a.vscode.commands.getCommands = async () => ['workbench.action.chat.open'];
  assert.equal((await open()).error.code, 'LOCAL_CHAT_UNAVAILABLE');
  assert.deepEqual(executed, []);
  const required = ['workbench.action.chat.openInSidebar', 'workbench.action.chat.newLocalChat', 'workbench.action.chat.open'];
  for (const missing of required) {
    a.vscode.commands.getCommands = async () => required.filter(command => command !== missing);
    assert.equal((await open()).error.code, 'LOCAL_CHAT_UNAVAILABLE');
    assert.deepEqual(executed, []);
  }
  a.vscode.commands.getCommands = async () => required;
  assert.equal((await open()).error.code, 'LOCAL_CHAT_UNAVAILABLE');
  assert.deepEqual(executed, [['workbench.action.chat.openInSidebar']]);
  executed.length = 0;
  a.vscode.commands.executeCommand = async (...args) => {
    executed.push(args);
    if (args[0] === 'workbench.action.chat.newLocalChat') throw new Error('PRIVATE_LOCAL_FAILURE');
  };
  assert.equal((await open()).error.code, 'LOCAL_CHAT_UNAVAILABLE');
  assert.deepEqual(executed, [['workbench.action.chat.openInSidebar'], ['workbench.action.chat.newLocalChat']]);
  assert.equal(JSON.stringify(a.errors).includes('PRIVATE'), false);
});

test('Local Coordinator requires a trusted project and the installed named profile before opening chat', async t => {
  const a = app(t), executed = [];
  a.vscode.commands.executeCommand = async (...args) => executed.push(args);
  const open = () => a.commands.get(LOCAL_COORDINATOR_COMMAND)();
  assert.equal((await open()).error.code, 'COORDINATOR_PROFILE_REQUIRED');
  a.vscode.workspace.isTrusted = false;
  assert.equal((await open()).error.code, 'WORKSPACE_UNTRUSTED');
  assert.deepEqual(executed, []);
});

test('profile selection failure preserves the Local-only path and does not submit a request', async t => {
  const a = app(t), open = localCoordinator(a), executed = [];
  a.vscode.commands.executeCommand = async (...args) => {
    executed.push(args);
    if (args[0] === 'workbench.action.chat.open') throw new Error('PRIVATE_CHAT_FAILURE');
  };
  const result = await open();
  assert.equal(result.opened, false); assert.equal(result.error.code, 'LOCAL_COORDINATOR_UNAVAILABLE');
  assert.deepEqual(executed, [['workbench.action.chat.openInSidebar'], ['workbench.action.chat.newLocalChat'], ['workbench.action.chat.open', { mode: 'NeoMind Coordinator Agent' }]]);
  assert.deepEqual(a.calls, []); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('panel submit uses its bound workspace, backend generates request identity, and snapshots exclude private fields', async t => {
  const a = app(t);
  await a.host.handle({ type: 'controlled-action', action: 'submit', requirement: 'Implement and verify a bounded change.',
    root: 'OTHER-PROJECT', workflow_id: undefined, invocation_id: 'FAKE', token: 'PRIVATE' });
  const submits = a.calls.filter(call => call[0] === 'submit');
  assert.equal(submits.length, 1); assert.equal(submits[0][1], a.root);
  assert.equal(submits[0][2].requirement, 'Implement and verify a bounded change.');
  assert.match(submits[0][2].request_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(submits[0][2]).sort(), ['request_id', 'requirement']);
  const receipt = a.sent.find(value => value.type === 'controlled-receipt');
  assert.equal(receipt.workflows[0].workflow_id, workflowId);
  assert.equal(receipt.workflows[0].active_invocations[0].confirmed_model, 'registered-model');
  assert.equal(JSON.stringify(a.sent).includes('PRIVATE'), false);
});

test('panel mutations require enabled owner, while journal reads remain available', async t => {
  const a = app(t); a.enabled(false);
  await a.host.handle({ type: 'controlled-action', action: 'submit', requirement: 'A bounded task.' });
  assert.equal(a.calls.length, 0);
  assert.equal(a.sent.find(value => value.type === 'controlled-error').code, 'BRIDGE_DISABLED');
  await a.host.handle({ type: 'controlled-action', action: 'status' });
  assert.equal(a.calls[0][0], 'status');
  assert.equal(a.sent.find(value => value.type === 'controlled-snapshot').enabled, false);
  a.active(false); await a.host.handle({ type: 'controlled-action', action: 'cancel', workflow_id: workflowId });
  assert.equal(a.calls.length, 1);
});

test('chat tool binds the exact open workspace and never invokes a native subagent', async t => {
  const a = app(t);
  const response = await a.invoke({ action: 'submit', workspace_folder: a.root, requirement: 'Implement a task.' });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.workflows[0].workflow_id, workflowId);
  assert.equal(a.calls[0][1], a.root);
  assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
  for (const workspace_folder of [undefined, '', resolve(a.root, '..'), 'relative-folder']) {
    const result = await a.invoke({ action: 'submit', workspace_folder, requirement: 'Wrong project.' });
    assert.equal(result.error.code, 'PROJECT_REQUIRED');
  }
  assert.equal(a.calls.filter(call => call[0] === 'submit').length, 1);
  a.vscode.workspace.isTrusted = false;
  const denied = await a.invoke({ action: 'status', workspace_folder: a.root });
  assert.equal(denied.error.code, 'WORKSPACE_UNTRUSTED'); assert.equal(a.calls.filter(call => call[0] === 'submit').length, 1);
  const source = readFileSync(new URL('../extensions/vscode-model-bridge/controlled-workflows.cjs', import.meta.url), 'utf8');
  assert.equal(source.includes('invokeTool'), false); assert.equal(source.includes('runSubagent'), false);
});

test('chat accepts an actual Windows short-path workspace alias and binds the physical root', { skip: process.platform !== 'win32' }, async t => {
  const a = app(t);
  const short = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$folder = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:NEOMIND_TEST_SHORT_PATH); [Console]::Write($folder.ShortPath)'],
  { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, NEOMIND_TEST_SHORT_PATH: a.root } });
  assert.equal(short.status, 0, short.error?.message ?? short.stderr);
  const alias = short.stdout.trim();
  if (resolve(alias).toLowerCase() === resolve(a.root).toLowerCase()) {
    t.skip('This Windows volume does not provide an 8.3 alias for the fixture.'); return;
  }
  assert.equal(realpathSync.native(alias), a.root);
  a.vscode.workspace.workspaceFolders[0].uri.fsPath = alias;
  const response = await a.invoke({ action: 'submit', workspace_folder: alias, requirement: 'Implement a task through its workspace alias.' });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.workflows[0].workflow_id, workflowId);
  assert.equal(a.calls[0][1], a.root);
});

test('chat lifecycle cannot cancel accepted work, but cancelled unaccepted calls do not submit', async t => {
  const a = app(t), token = { isCancellationRequested: true };
  const first = JSON.parse((await a.tool.invoke({ input: { action: 'submit', workspace_folder: a.root, requirement: 'Work.' } }, token)).content[0].value);
  assert.equal(first.error.code, 'REQUEST_CANCELLED'); assert.equal(a.calls.length, 0);
  token.isCancellationRequested = false;
  const status = a.runtime.controlledStatus;
  a.runtime.controlledStatus = async () => { token.isCancellationRequested = true; return []; };
  const cancelledDuringRecovery = JSON.parse((await a.tool.invoke({ input: { action: 'submit', workspace_folder: a.root, requirement: 'Work.' } }, token)).content[0].value);
  assert.equal(cancelledDuringRecovery.error.code, 'REQUEST_CANCELLED');
  assert.equal(a.calls.filter(call => call[0] === 'submit').length, 0);
  a.runtime.controlledStatus = status; token.isCancellationRequested = false;
  a.runtime.startControlledWorkflow = async (...args) => { a.calls.push(['submit', ...args]); token.isCancellationRequested = true;
    Object.assign(a.workflow, { request_id: args[1].request_id, requirement: args[1].requirement }); return a.workflow; };
  const accepted = JSON.parse((await a.tool.invoke({ input: { action: 'submit', workspace_folder: a.root, requirement: 'Work.' } }, token)).content[0].value);
  assert.equal(accepted.workflows[0].workflow_id, workflowId);
  const submits = a.calls.filter(call => call[0] === 'submit');
  assert.equal(submits.length, 1);
  assert.equal('signal' in submits[0][2], false);
});

test('controls require explicit saved workflow identity and never accept credentials or backend lifecycle patches', async t => {
  const a = app(t);
  for (const action of ['pause', 'resume', 'cancel']) {
    const rejected = await a.invoke({ action, workspace_folder: a.root });
    assert.equal(rejected.error.code, 'INVALID_REQUEST');
    const response = await a.invoke({ action, workspace_folder: a.root, workflow_id: workflowId });
    assert.equal(response.workflows[0].workflow_id, workflowId);
  }
  assert.deepEqual(a.calls.map(value => value[2]), ['pause', 'resume', 'cancel'].map(action => ({ workflow_id: workflowId, action })));
  const rejected = await a.invoke({ action: 'submit', workspace_folder: a.root, requirement: 'Work.', invocation_id: 'FAKE' });
  assert.equal(rejected.error.code, 'INVALID_REQUEST'); assert.equal(a.calls.length, 3);
});

test('queued, waiting, interrupted and uncertain state are preserved without inferred completion', () => {
  const values = ['queued', 'waiting', 'interrupted', 'uncertain'].map((status, index) => ({ workflow_id: `workflow-${index}`, status, events: [] }));
  assert.deepEqual(publicStatus({ workflows: values }).workflows.map(value => value.status), values.map(value => value.status));
});

test('public status preserves observed provider and safe blocker diagnostics without raw payloads', () => {
  const result = publicStatus({ workflow_id: workflowId, status: 'blocked',
    active_invocations: [{ role: 'developer', provider: '9router', confirmed_model: 'worker-alias', token: 'PRIVATE' }],
    blocker: { kind: 'environment', code: 'MODEL_ACCESS', trace_id: 'trace-001', owner: 'provider',
      message: 'Model access is unavailable.', next_action: 'Check provider access.', raw_payload: 'PRIVATE' },
  }).workflows[0];
  assert.equal(result.active_invocations[0].provider, '9router');
  assert.equal(result.blocker.kind, 'environment'); assert.equal(result.blocker.trace_id, 'trace-001');
  assert.equal(result.blocker.owner, 'provider');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('runtime/provider errors are not copied into chat or webview', async t => {
  const a = app(t);
  a.runtime.startControlledWorkflow = async () => { throw new Error('Bearer PRIVATE_PROVIDER_CREDENTIAL'); };
  const response = await a.invoke({ action: 'submit', workspace_folder: a.root, requirement: 'Work.' });
  assert.equal(response.error.code, 'INTAKE_RESPONSE_UNKNOWN');
  assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
  const b = app(t);
  b.runtime.startControlledWorkflow = async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), { code: 'CONTINUATION_PILOT_UNSUPPORTED' }); };
  const unsupported = await b.invoke({ action: 'submit', workspace_folder: b.root, requirement: 'Continue bounded work.' });
  assert.equal(unsupported.error.code, 'CONTINUATION_PILOT_UNSUPPORTED');
  assert.match(unsupported.error.message, /original task family/);
  assert.equal(JSON.stringify(unsupported).includes('PRIVATE'), false);
});

test('controlled panel uses isolated CSP, safe rendering and packaged tool registration', () => {
  const html = renderControlledPanel({ cspSource: 'vscode-resource:', script: 'controlled.js', style: 'controlled.css', nonce: 'safe-nonce' });
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-safe-nonce'/); assert.match(html, /form-action 'none'/);
  const source = readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/controlled.js', import.meta.url), 'utf8');
  assert.equal(source.includes('innerHTML'), false);
  const manifest = JSON.parse(readFileSync(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.languageModelTools.some(value => value.name === TOOL_NAME));
  assert.ok(manifest.contributes.commands.some(value => value.command === 'neomind.workflows.open'));
  assert.ok(manifest.contributes.commands.some(value => value.command === LOCAL_COORDINATOR_COMMAND && value.title === 'NeoMind: Open Local Coordinator'));
  assert.match(html, /id="local-coordinator"/);
  assert.match(html, /model picker/);
  for (const file of ['controlled-workflows.cjs', 'controlled-entry.cjs', 'resources/monitor/controlled.js', 'resources/monitor/controlled.css']) assert.ok(manifest.files.includes(file));
});
