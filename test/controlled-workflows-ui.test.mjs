import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { TOOL_NAME, activateControlledWorkflows, createControlledPanelHost, publicStatus, renderControlledPanel } = require('../extensions/vscode-model-bridge/controlled-workflows.cjs');
const workflowId = 'NM-TEST-KNW-0001';

function app(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-controlled-ui-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { force: true, recursive: true }); });
  const calls = [], sent = [], commands = new Map(), tools = new Map(), subscriptions = [];
  let active = true, enabled = true;
  const workflow = { workflow_id: workflowId, title: '<img onerror=evil()>', status: 'queued', phase: 'intake', transport: 'vscode-lm',
    process_contract: 'software-tools/v2', token: 'PRIVATE', prompt: 'PRIVATE',
    active_invocations: [{ role: 'developer', state: 'running', requested_model: 'worker-alias', confirmed_model: 'registered-model', model_provider: 'custom-provider', token: 'PRIVATE', prompt: 'PRIVATE' }],
    events: [{ sequence: 1, type: 'dispatch', role: 'developer', at: '2026-10-25', summary: 'Backend-owned dispatch.', raw_payload: 'PRIVATE' }] };
  const runtime = {
    startControlledWorkflow: async (...args) => { calls.push(['submit', ...args]); return workflow; },
    controlledStatus: async (...args) => { calls.push(['status', ...args]); return [workflow]; },
    controlControlledWorkflow: async (...args) => { calls.push(['control', ...args]); return workflow; },
  };
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } },
    lm: { registerTool(name, value) { tools.set(name, value); return { dispose() {} }; } },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
  };
  const host = createControlledPanelHost({ runtime, root, post: async value => sent.push(value), alive: () => active, enabled: () => enabled });
  activateControlledWorkflows(vscode, { subscriptions }, async selected => { assert.equal(selected, root); return runtime; }, { enabled: selected => selected === root && enabled });
  const invoke = async input => JSON.parse((await tools.get(TOOL_NAME).invoke({ input })).content[0].value);
  return { root, workflow, runtime, vscode, calls, sent, host, invoke, tool: tools.get(TOOL_NAME), subscriptions,
    active: value => { active = value; }, enabled: value => { enabled = value; } };
}

test('panel submit uses its bound workspace, backend generates request identity, and snapshots exclude private fields', async t => {
  const a = app(t);
  await a.host.handle({ type: 'controlled-action', action: 'submit', requirement: 'Implement and verify a bounded change.',
    root: 'OTHER-PROJECT', workflow_id: undefined, invocation_id: 'FAKE', token: 'PRIVATE' });
  assert.equal(a.calls[0][0], 'submit'); assert.equal(a.calls[0][1], a.root);
  assert.equal(a.calls[0][2].requirement, 'Implement and verify a bounded change.');
  assert.match(a.calls[0][2].request_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(a.calls[0][2]).sort(), ['request_id', 'requirement']);
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
  assert.equal(response.workflows[0].workflow_id, workflowId);
  assert.equal(a.calls[0][1], a.root);
  assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
  for (const workspace_folder of [undefined, '', resolve(a.root, '..'), 'relative-folder']) {
    const result = await a.invoke({ action: 'submit', workspace_folder, requirement: 'Wrong project.' });
    assert.equal(result.error.code, 'PROJECT_REQUIRED');
  }
  assert.equal(a.calls.length, 1);
  a.vscode.workspace.isTrusted = false;
  const denied = await a.invoke({ action: 'status', workspace_folder: a.root });
  assert.equal(denied.error.code, 'WORKSPACE_UNTRUSTED'); assert.equal(a.calls.length, 1);
  const source = readFileSync(new URL('../extensions/vscode-model-bridge/controlled-workflows.cjs', import.meta.url), 'utf8');
  assert.equal(source.includes('invokeTool'), false); assert.equal(source.includes('runSubagent'), false);
});

test('chat lifecycle cannot cancel accepted work, but cancelled unaccepted calls do not submit', async t => {
  const a = app(t), token = { isCancellationRequested: true };
  const first = JSON.parse((await a.tool.invoke({ input: { action: 'submit', workspace_folder: a.root, requirement: 'Work.' } }, token)).content[0].value);
  assert.equal(first.error.code, 'REQUEST_CANCELLED'); assert.equal(a.calls.length, 0);
  token.isCancellationRequested = false;
  a.runtime.startControlledWorkflow = async (...args) => { a.calls.push(['submit', ...args]); token.isCancellationRequested = true; return a.workflow; };
  const accepted = JSON.parse((await a.tool.invoke({ input: { action: 'submit', workspace_folder: a.root, requirement: 'Work.' } }, token)).content[0].value);
  assert.equal(accepted.workflows[0].workflow_id, workflowId);
  assert.deepEqual(a.calls.map(value => value[0]), ['submit']);
  assert.equal('signal' in a.calls[0][2], false);
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

test('runtime/provider errors are not copied into chat or webview', async t => {
  const a = app(t);
  a.runtime.startControlledWorkflow = async () => { throw new Error('Bearer PRIVATE_PROVIDER_CREDENTIAL'); };
  const response = await a.invoke({ action: 'submit', workspace_folder: a.root, requirement: 'Work.' });
  assert.equal(response.error.code, 'CONTROLLED_OPERATION_FAILED');
  assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
});

test('controlled panel uses isolated CSP, safe rendering and packaged tool registration', () => {
  const html = renderControlledPanel({ cspSource: 'vscode-resource:', script: 'controlled.js', style: 'controlled.css', nonce: 'safe-nonce' });
  assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-safe-nonce'/); assert.match(html, /form-action 'none'/);
  const source = readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/controlled.js', import.meta.url), 'utf8');
  assert.equal(source.includes('innerHTML'), false);
  const manifest = JSON.parse(readFileSync(new URL('../extensions/vscode-model-bridge/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.languageModelTools.some(value => value.name === TOOL_NAME));
  assert.ok(manifest.contributes.commands.some(value => value.command === 'neomind.workflows.open'));
  for (const file of ['controlled-workflows.cjs', 'resources/monitor/controlled.js', 'resources/monitor/controlled.css']) assert.ok(manifest.files.includes(file));
});
