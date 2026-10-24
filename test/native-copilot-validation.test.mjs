import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { stageNativeValidationRequest, createNativeValidationHost } = require('../extensions/vscode-model-bridge/native-validation.cjs');
const extensionId = 'neomind.neomind-model-bridge';
const workflowId = 'NM-VALIDATE-KNW-0001';
const fingerprint = '1'.repeat(64);

function fixture(t, options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'neomind-native-validation-'));
  const root = join(base, 'project'), runtimeRoot = join(base, 'runtime'), storageRoot = join(base, 'private-storage');
  mkdirSync(join(root, '.github/agents'), { recursive: true });
  mkdirSync(runtimeRoot); mkdirSync(storageRoot);
  writeFileSync(join(root, '.github/agents/neomind-coordinator.agent.md'), '---\nname: "NeoMind Coordinator Agent"\n---\nPreserve the existing workflow and actual role gates.\n');
  writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'neomind', version: '0.1.0-alpha.9' }));
  const calls = [], observed = [], infos = [], errors = [];
  const identity = { schema_version: 1, package_version: '0.1.0-alpha.9', runtime_root: runtimeRoot, project_root: root,
    server_instance_id: 'fixture-instance', started_at: new Date().toISOString(), build_fingerprint: fingerprint };
  const vscode = {
    env: { uriScheme: 'vscode' },
    workspace: { isTrusted: options.trusted !== false,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ inspect: () => ({ globalValue: runtimeRoot }) }) },
    commands: { async executeCommand(name, ...args) {
      calls.push({ name, args });
      if (name === 'workbench.action.chat.open') {
        options.afterChatRequested?.(workflow);
        return options.chatResult ?? { metadata: { maxToolCallsExceeded: true,
          toolCallRounds: [{ toolCalls: [{}] }], toolCallResults: { private: { token: 'PRIVATE-TOOL-RESULT' } } } };
      }
    } },
    lm: { tools: [{ name: 'mcp_neomind_runtime_info', inputSchema: { type: 'object' } }],
      async invokeTool(name, input) { observed.push({ name, input });
        options.beforeIdentityReturn?.(vscode);
        return { content: [{ value: JSON.stringify({ ...identity, ...options.identity }) }] };
      } },
    window: { showInformationMessage: text => infos.push(text), showErrorMessage: text => errors.push(text) },
  };
  const workflow = { meta: { id: workflowId, status: 'active', data: { kind: 'manager-workflow',
    execution_mode: 'copilot-native', phase: 'intake', routing_required: false } } };
  const runtime = { getRuntimeBuildFingerprint: () => fingerprint, getRecord: () => workflow,
    nativeWorkflowRecord: () => true, workflowStatus: () => options.workflowStatus ?? { phase: 'intake', tasks: [], open_questions: [] } };
  const context = { globalStorageUri: Object.hasOwn(options, 'storageUri')
    ? typeof options.storageUri === 'function' ? options.storageUri(storageRoot) : options.storageUri
    : { scheme: 'file', fsPath: storageRoot },
    extension: { id: extensionId, packageJSON: { version: '0.9.2' } }, subscriptions: [] };
  const stage = (input = {}) => stageNativeValidationRequest(storageRoot, { project_root: root, runtime_root: runtimeRoot,
    workflow_id: workflowId, expected_build_fingerprint: fingerprint,
    prompt: 'Resume the existing bounded workflow and finish its authorized implementation and actual independent checks.',
    native_idle_observed_at: new Date().toISOString(), ...input });
  const host = createNativeValidationHost({ vscode, context, loadRuntime: async selected => {
    assert.equal(selected, root); return runtime;
  } });
  t.after(() => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    rmSync(base, { recursive: true, force: true });
  });
  return { root, runtimeRoot, storageRoot, calls, observed, infos, errors, stage, host, identity, workflow, runtime };
}

test('actual-shaped trusted vscode-userdata storage uses its absolute local fsPath', async t => {
  const app = fixture(t, { storageUri: fsPath => ({ scheme: 'vscode-userdata', authority: '',
    path: fsPath.replaceAll('\\', '/'), fsPath, query: '', fragment: '' }) });
  const staged = app.stage(), result = await app.host.run();
  assert.equal(result.status, 'chat-returned-workflow-open');
  assert.equal(result.extension_version, '0.9.2');
  assert.equal(app.observed.length, 1);
  assert.equal(app.calls.filter(call => call.name === 'workbench.action.chat.open').length, 1);
  assert.equal(existsSync(staged.request_path), false);
  assert.ok(existsSync(staged.result_path));
});

test('missing, remote and ambiguous storage URIs refuse before consuming authorization or calling the app', async t => {
  for (const storageUri of [
    undefined,
    { scheme: 'file' },
    fsPath => ({ scheme: 'vscode-remote', fsPath }),
    fsPath => ({ scheme: 'https', fsPath }),
    fsPath => ({ scheme: 'vscode-userdata', authority: 'ssh-remote+example', fsPath }),
    fsPath => ({ scheme: 'file', authority: 'server', fsPath }),
    { scheme: 'vscode-userdata', fsPath: 'relative/storage' },
    { scheme: 'vscode-userdata', fsPath: '\\\\server\\share\\private-storage' },
    fsPath => ({ scheme: 'vscode-userdata', fsPath, query: 'unexpected' }),
  ]) {
    const app = fixture(t, { storageUri }), staged = app.stage();
    await assert.rejects(app.host.run(), error => error.code === 'INVALID_STORAGE');
    assert.equal(app.calls.length, 0);
    assert.equal(app.observed.length, 0);
    assert.equal(existsSync(staged.request_path), true);
    assert.equal(existsSync(staged.result_path), false);
  }
});

test('clean completion requires the exact effective phase and a saved report, preserving confirmation and error priority', async t => {
  for (const [phase, finalReport, chatResult, expected] of [
    ['completed', 'fixture-report', {}, 'workflow-completed'],
    ['completed-with-blockers', 'fixture-report', {}, 'chat-returned-workflow-open'],
    ['reassessment-required', 'fixture-report', {}, 'chat-returned-workflow-open'],
    ['awaiting-native-completion', 'fixture-report', {}, 'chat-returned-workflow-open'],
    ['completed', null, {}, 'chat-returned-workflow-open'],
    ['completed', 'fixture-report', { type: 'confirmation', kind: 'toolInvocation' }, 'confirmation-required'],
    ['completed', 'fixture-report', { errorDetails: { message: 'PRIVATE-PROVIDER-ERROR' } }, 'native-chat-error'],
  ]) {
    const app = fixture(t, { afterChatRequested: workflow => { workflow.meta.data.phase = 'completed'; },
      workflowStatus: { phase, final_report_id: finalReport, tasks: [], open_questions: [] }, chatResult });
    const staged = app.stage(), result = await app.host.run();
    assert.equal(result.workflow.phase, phase);
    assert.equal(result.workflow.persisted_phase, 'completed');
    assert.equal(result.status, expected, phase);
    assert.equal(readFileSync(staged.result_path, 'utf8').includes('PRIVATE-PROVIDER-ERROR'), false);
  }
});

test('authorized native validation restarts only NeoMind, verifies actual serving identity and records limits without private metadata', async t => {
  const app = fixture(t), staged = app.stage();
  const result = await app.host.run();
  assert.equal(app.calls[0].name, 'workbench.mcp.restartServer');
  assert.deepEqual(app.calls[0].args, ['mcp.config.usrlocal.neomind']);
  assert.equal(app.observed.length, 1);
  assert.deepEqual(app.observed[0].input, { input: {}, toolInvocationToken: undefined });
  const launch = app.calls.find(call => call.name === 'workbench.action.chat.open');
  assert.equal(app.calls.filter(call => call.name === 'workbench.action.chat.newLocalChat').length, 1);
  assert.ok(app.calls.findIndex(call => call.name === 'workbench.action.chat.newLocalChat') < app.calls.indexOf(launch));
  assert.equal(app.calls.some(call => call.name === 'workbench.action.chat.newChat'), false, 'generic newChat can select the remembered Agent Host instead of Local');
  assert.equal(launch.args[0].mode, 'NeoMind Coordinator Agent');
  assert.equal(launch.args[0].blockOnResponse, true);
  assert.equal(Object.hasOwn(launch.args[0], 'modelSelector'), false);
  assert.ok(launch.args[0].query.includes(workflowId));
  const bootstrap = JSON.parse(launch.args[0].query.match(/assignment_bootstrap with exactly this JSON input: (\{[^\n]+\})/)?.[1] ?? 'null');
  assert.equal(bootstrap.workflow_id, workflowId);
  assert.equal(bootstrap.profile_id, 'coordinator');
  assert.equal(bootstrap.role, 'manager');
  assert.equal(bootstrap.assignment_id, `native-validation-${staged.run_id}`);
  assert.equal(Object.hasOwn(bootstrap, 'reported_assignment'), false);
  assert.equal(Object.hasOwn(bootstrap, 'task_id'), false);
  assert.equal(result.status, 'chat-returned-workflow-open');
  assert.equal(result.chat.max_tool_calls_exceeded, true);
  assert.equal(result.chat.model_rounds, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE-TOOL-RESULT'), false);
  assert.equal(readFileSync(staged.result_path, 'utf8').includes('PRIVATE-TOOL-RESULT'), false);
  await assert.rejects(app.host.run(), /No armed native Copilot validation request/);
  assert.equal(app.calls.filter(call => call.name === 'workbench.action.chat.open').length, 1);
});

test('stale runtime identity is refused before any native chat launches', async t => {
  const app = fixture(t, { identity: { build_fingerprint: '2'.repeat(64) } });
  const staged = app.stage();
  await assert.rejects(app.host.run(), /serving runtime does not match/);
  assert.equal(app.calls.some(call => call.name === 'workbench.action.chat.open'), false);
  const result = JSON.parse(readFileSync(staged.result_path, 'utf8'));
  assert.equal(result.status, 'blocked');
  assert.equal(Object.hasOwn(result, 'prompt'), false);
});

test('wrong live project scope and strict saved workflows cannot start validation', async t => {
  const wrong = fixture(t, { identity: { project_root: 'different-project' } });
  wrong.stage();
  await assert.rejects(wrong.host.run(), /serving runtime does not match/);
  assert.equal(wrong.calls.some(call => call.name === 'workbench.action.chat.open'), false);
  const strict = fixture(t); strict.stage(); strict.workflow.meta.data.execution_mode = 'strict';
  await assert.rejects(strict.host.run(), /existing open copilot-native workflow/);
  assert.equal(strict.calls.length, 0);
});

test('tampered prompt/profile and expired idle observations are refused before MCP restart', async t => {
  const prompt = fixture(t), staged = prompt.stage();
  writeFileSync(staged.prompt_path, 'A different prompt must not inherit authorization.');
  await assert.rejects(prompt.host.run(), /prompt or Coordinator profile changed/);
  assert.equal(prompt.calls.length, 0);
  const profile = fixture(t); profile.stage();
  writeFileSync(join(profile.root, '.github/agents/neomind-coordinator.agent.md'), 'A different profile must not inherit authorization.');
  await assert.rejects(profile.host.run(), /prompt or Coordinator profile changed/);
  assert.equal(profile.calls.length, 0);
  const idle = fixture(t);
  assert.throws(() => idle.stage({ native_idle_observed_at: new Date(Date.now() - 5 * 60_000).toISOString() }), /recent explicit idle observation/);
});

test('fixed URI action rejects arbitrary payloads and has no effect without a one-time private authorization', async t => {
  const app = fixture(t);
  for (const bad of [
    { scheme: 'vscode', authority: extensionId, path: '/execute', query: '', fragment: '' },
    { scheme: 'vscode', authority: extensionId, path: '/native-copilot-validation', query: 'command=anything', fragment: '' },
    { scheme: 'vscode', authority: 'other.extension', path: '/native-copilot-validation', query: '', fragment: '' },
  ]) await assert.rejects(app.host.handleUri(bad), /fixed native Copilot validation action/);
  await assert.rejects(app.host.handleUri({ scheme: 'vscode', authority: extensionId,
    path: '/native-copilot-validation', query: '', fragment: '' }), /No armed native Copilot validation request/);
  assert.equal(app.calls.length, 0);
});

test('pending app confirmation is recorded as pending and never reported as workflow completion', async t => {
  const app = fixture(t, { chatResult: { type: 'confirmation', kind: 'toolInvocation', toolId: 'private-tool-id',
    metadata: { token: 'PRIVATE-METADATA' } } });
  const staged = app.stage(), result = await app.host.run();
  assert.equal(result.status, 'confirmation-required');
  assert.equal(result.chat.pending_confirmation, true);
  assert.equal(readFileSync(staged.result_path, 'utf8').includes('PRIVATE-METADATA'), false);
  assert.equal(existsSync(staged.request_path), false);
});

test('workspace trust revoked during actual MCP handshake prevents native launch', async t => {
  const app = fixture(t, { beforeIdentityReturn: vscode => { vscode.workspace.isTrusted = false; } });
  app.stage();
  await assert.rejects(app.host.run(), /Workspace Trust is required/);
  assert.equal(app.calls.some(call => call.name === 'workbench.action.chat.newLocalChat'), false);
  assert.equal(app.calls.some(call => call.name === 'workbench.action.chat.newChat'), false);
  assert.equal(app.calls.some(call => call.name === 'workbench.action.chat.open'), false);
});

test('a copied consumed nonce cannot restart MCP or launch another actor', async t => {
  const app = fixture(t), staged = app.stage(), original = readFileSync(staged.request_path);
  await app.host.run();
  const count = app.calls.length;
  writeFileSync(staged.request_path, original);
  await assert.rejects(app.host.run(), /already consumed/);
  assert.equal(app.calls.length, count);
});
