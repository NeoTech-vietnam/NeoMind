import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { stageNativeValidationRequest, createNativeValidationHost } = require('../extensions/vscode-model-bridge/native-validation.cjs');
const extensionId = 'neomind.neomind-model-bridge';
const workflowId = 'NM-VALIDATE-KNW-0001';
const fingerprint = '1'.repeat(64);
const localSessionId = '6989eb72-9d16-4a15-add7-c7b9f785d79c';

function fixture(t, options = {}) {
  const created = mkdtempSync(join(tmpdir(), 'neomind-native-validation-'));
  const inputBase = options.aliasedTemp ? `${created}-alias` : created;
  if (options.aliasedTemp) symlinkSync(created, inputBase, process.platform === 'win32' ? 'junction' : 'dir');
  const base = realpathSync.native(inputBase);
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
    const cleanupBase = realpathSync.native(base), cleanupParent = realpathSync.native(tmpdir());
    assert.equal(dirname(cleanupBase), cleanupParent);
    if (options.aliasedTemp) {
      assert.equal(realpathSync.native(inputBase), cleanupBase);
      assert.equal(realpathSync.native(dirname(inputBase)), cleanupParent);
      rmSync(inputBase, { recursive: true, force: true });
    }
    rmSync(cleanupBase, { recursive: true, force: true });
  });
  return { root, runtimeRoot, storageRoot, inputBase, calls, observed, infos, errors, stage, host, identity, workflow, runtime };
}

test('aliased temporary fixture paths retain exact canonical runtime and project identity', async t => {
  // Directory junctions need no Windows symlink privilege and reproduce the
  // lexical/physical mismatch of runneradmin's RUNNER~1 temporary directory.
  const app = fixture(t, { aliasedTemp: true });
  assert.notEqual(app.inputBase, realpathSync.native(app.inputBase));
  const staged = app.stage({ project_root: join(app.inputBase, 'project'), runtime_root: join(app.inputBase, 'runtime') });
  const authorization = JSON.parse(readFileSync(staged.request_path, 'utf8'));
  assert.equal(authorization.project_root, realpathSync.native(app.root));
  assert.equal(authorization.runtime_root, realpathSync.native(app.runtimeRoot));
  const result = await app.host.run();
  assert.equal(result.status, 'chat-returned-workflow-open');
  assert.equal(result.project_root, app.root);
  assert.equal(result.runtime_root, app.runtimeRoot);
  assert.equal(app.observed.length, 1);
  assert.equal(app.calls.filter(call => call.name === 'workbench.action.chat.open').length, 1);
});

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

test('explicit visible Local chat reuse skips newLocalChat and records only a declared expected session', async t => {
  const app = fixture(t), staged = app.stage({ reuse_current_local_chat: true, expected_local_session_id: localSessionId });
  const authorization = JSON.parse(readFileSync(staged.request_path, 'utf8'));
  assert.equal(authorization.reuse_current_local_chat, true); assert.equal(authorization.expected_local_session_id, localSessionId);
  const result = await app.host.run();
  assert.deepEqual(result.chat_target, { mode: 'reuse-current-local-chat', expected_session_id: localSessionId, host_selected_exact_session: false });
  assert.equal(app.calls.some(call => call.name === 'workbench.action.chat.newLocalChat'), false);
  const launch = app.calls.find(call => call.name === 'workbench.action.chat.open');
  assert.deepEqual(Object.keys(launch.args[0]).sort(), ['blockOnResponse', 'mode', 'preserveInput', 'query']);
  assert.equal(launch.args[0].mode, 'NeoMind Coordinator Agent'); assert.equal(launch.args[0].blockOnResponse, true);
  assert.equal(launch.args[0].preserveInput, true);
  assert.equal(Object.hasOwn(launch.args[0], 'sessionResource'), false); assert.equal(Object.hasOwn(launch.args[0], 'modelSelector'), false);
  assert.deepEqual(app.calls.slice(0, 2).map(call => call.name), ['workbench.mcp.restartServer', 'workbench.mcp.startServer']);
});

test('reuse authorization rejects partial, invalid or extra selectors before app actions', async t => {
  for (const input of [
    { reuse_current_local_chat: true }, { expected_local_session_id: localSessionId },
    { reuse_current_local_chat: false, expected_local_session_id: localSessionId },
    { reuse_current_local_chat: 'true', expected_local_session_id: localSessionId },
    { reuse_current_local_chat: true, expected_local_session_id: 'not-a-session' },
    { reuse_current_local_chat: true, expected_local_session_id: localSessionId, sessionResource: 'unsupported-selector' },
  ]) {
    const app = fixture(t);
    assert.throws(() => app.stage(input), error => error.code === 'INVALID_AUTHORIZATION');
    assert.equal(app.calls.length, 0); assert.equal(app.observed.length, 0);
    assert.equal(existsSync(join(app.storageRoot, 'native-copilot-validation.json')), false);
  }
  for (const patch of [{ reuse_current_local_chat: true }, { expected_local_session_id: localSessionId },
    { reuse_current_local_chat: true, expected_local_session_id: localSessionId, sessionResource: 'unsupported-selector' }]) {
    const app = fixture(t), staged = app.stage();
    const authorization = JSON.parse(readFileSync(staged.request_path, 'utf8'));
    writeFileSync(staged.request_path, JSON.stringify({ ...authorization, ...patch }));
    await assert.rejects(app.host.run(), error => error.code === 'INVALID_AUTHORIZATION');
    assert.equal(app.calls.length, 0); assert.equal(app.observed.length, 0);
  }
});

test('reusing a visible Local chat retains idle, expiry and workspace Trust checks', async t => {
  const reuse = { reuse_current_local_chat: true, expected_local_session_id: localSessionId };
  const idle = fixture(t);
  assert.throws(() => idle.stage({ ...reuse, native_idle_observed_at: new Date(Date.now() - 5 * 60_000).toISOString() }),
    error => error.code === 'IDLE_OBSERVATION_REQUIRED');
  const expired = fixture(t), staged = expired.stage(reuse);
  const authorization = JSON.parse(readFileSync(staged.request_path, 'utf8')); authorization.expires_at = new Date(Date.now() - 1000).toISOString();
  writeFileSync(staged.request_path, JSON.stringify(authorization));
  await assert.rejects(expired.host.run(), error => error.code === 'EXPIRED_AUTHORIZATION');
  assert.equal(expired.calls.length, 0);
  const untrusted = fixture(t, { trusted: false }); untrusted.stage(reuse);
  await assert.rejects(untrusted.host.run(), error => error.code === 'WORKSPACE_TRUST_REQUIRED');
  assert.equal(untrusted.calls.length, 0);
  const changed = fixture(t, { beforeIdentityReturn: vscode => { vscode.workspace.isTrusted = false; } }); changed.stage(reuse);
  await assert.rejects(changed.host.run(), error => error.code === 'WORKSPACE_TRUST_REQUIRED');
  assert.equal(changed.calls.some(call => call.name === 'workbench.action.chat.open'), false);
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
  assert.deepEqual(result.chat_target, { mode: 'new-local-chat', expected_session_id: null, host_selected_exact_session: false });
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
