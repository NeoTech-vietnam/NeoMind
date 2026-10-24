const { createHash, randomBytes } = require('node:crypto');
const { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, unlinkSync, writeFileSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

const ACTION = 'validate-native-copilot-workflow';
const URI_PATH = '/native-copilot-validation';
const COMMAND = 'neomind.validation.copilot';
const SERVER_ID = 'mcp.config.usrlocal.neomind';
const PROFILE = 'NeoMind Coordinator Agent';
const REQUEST = 'native-copilot-validation.json';
const PROMPT = 'native-copilot-prompt.txt';
const RESULT = 'native-copilot-validation-result.json';
const RUNNING = 'native-copilot-validation-running.json';
const SHA256 = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

class NativeValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new NativeValidationError(code, message); }
function regularBytes(path, maximum) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    fail('INVALID_AUTHORIZATION', 'Native validation requires bounded regular authorization, prompt and profile files.');
  return readFileSync(path);
}
function storagePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\x00-\x1f]/.test(path) ||
      (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path)))
    fail('INVALID_STORAGE', 'Native validation requires private local extension storage.');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync.native(path);
}
function contextStoragePath(uri) {
  // Stable desktop VS Code exposes local globalStorageUri with vscode-userdata.
  // Accept only this context-owned local URI, never remote authorities/providers.
  if (!uri || !['file', 'vscode-userdata'].includes(uri.scheme) ||
      ![undefined, ''].includes(uri.authority) || ![undefined, ''].includes(uri.query) ||
      ![undefined, ''].includes(uri.fragment))
    fail('INVALID_STORAGE', 'Native validation requires private local extension storage.');
  return storagePath(uri.fsPath);
}
function writeResult(root, value) {
  const path = join(root, RESULT);
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    fail('INVALID_STORAGE', 'Native validation result storage must not be a symbolic link.');
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function validateRequest(value, time = Date.now()) {
  const keys = ['schema_version', 'action', 'nonce', 'created_at', 'expires_at', 'native_idle_observed_at',
    'project_root', 'runtime_root', 'workflow_id', 'expected_build_fingerprint', 'prompt_sha256', 'profile_sha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) ||
      value.schema_version !== 1 || value.action !== ACTION || !SHA256.test(value.nonce) ||
      !SHA256.test(value.expected_build_fingerprint) || !SHA256.test(value.prompt_sha256) || !SHA256.test(value.profile_sha256) ||
      typeof value.project_root !== 'string' || !isAbsolute(value.project_root) ||
      typeof value.runtime_root !== 'string' || !isAbsolute(value.runtime_root) ||
      typeof value.workflow_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{1,119}-KNW-\d{4,}$/.test(value.workflow_id))
    fail('INVALID_AUTHORIZATION', 'Native validation needs its exact scoped one-time authorization schema.');
  const created = Date.parse(value.created_at), expiry = Date.parse(value.expires_at), idle = Date.parse(value.native_idle_observed_at);
  if (![created, expiry, idle].every(Number.isFinite) || created > time + 30_000 || expiry <= time ||
      expiry <= created || expiry - created > 15 * 60_000)
    fail('EXPIRED_AUTHORIZATION', 'Native Copilot validation authorization is expired or invalid.');
  if (idle > time + 30_000 || time - idle > 2 * 60_000)
    fail('IDLE_OBSERVATION_REQUIRED', 'A recent explicit idle observation is required before native validation can restart MCP or launch another actor.');
  return value;
}

/** Local administration only. The URL never carries this authorization or an arbitrary prompt. */
function stageNativeValidationRequest(storageRoot, input) {
  const root = storagePath(storageRoot), requestPath = join(root, REQUEST), promptPath = join(root, PROMPT);
  if (existsSync(requestPath) || existsSync(join(root, RUNNING)))
    fail('ALREADY_ARMED', 'A native validation request is already armed or running; inspect it before staging another.');
  if (!input || typeof input.prompt !== 'string' || input.prompt.trim().length < 24 || input.prompt.length > 32_000 ||
      /"(?:token|claim_token)"\s*:\s*"[a-f0-9]{64}"/i.test(input.prompt))
    fail('INVALID_PROMPT', 'Stage a bounded reviewed native validation prompt without assignment credentials.');
  const project = realpathSync.native(input.project_root), runtime = realpathSync.native(input.runtime_root);
  const profilePath = join(project, '.github/agents/neomind-coordinator.agent.md');
  const profile = regularBytes(profilePath, 128_000), prompt = input.prompt.trim();
  if (!/^name:\s*["']?NeoMind Coordinator Agent["']?\s*$/m.test(profile.toString('utf8')))
    fail('INVALID_PROFILE', 'Native validation requires the actual named NeoMind Coordinator profile.');
  const created = new Date(), value = validateRequest({ schema_version: 1, action: ACTION,
    nonce: randomBytes(32).toString('hex'), created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + 15 * 60_000).toISOString(),
    native_idle_observed_at: input.native_idle_observed_at, project_root: project, runtime_root: runtime,
    workflow_id: input.workflow_id, expected_build_fingerprint: input.expected_build_fingerprint,
    prompt_sha256: hash(prompt), profile_sha256: hash(profile) });
  if (existsSync(promptPath) && lstatSync(promptPath).isSymbolicLink())
    fail('INVALID_STORAGE', 'Native validation prompt storage must not be a symbolic link.');
  writeFileSync(promptPath, prompt, { mode: 0o600 });
  writeFileSync(requestPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { run_id: hash(value.nonce).slice(0, 20), request_path: requestPath, prompt_path: promptPath,
    result_path: join(root, RESULT), expires_at: value.expires_at };
}
function parseIdentity(result) {
  for (const item of result?.content ?? []) {
    if (typeof item?.value !== 'string') continue;
    try { const value = JSON.parse(item.value); if (value?.schema_version === 1) return value; } catch {}
  }
  fail('INVALID_RUNTIME_IDENTITY', 'The actual MCP server did not return a valid runtime identity.');
}
function summarizeChatResult(value) {
  const metadata = value?.metadata, rounds = metadata?.toolCallRounds;
  return {
    pending_confirmation: value?.type === 'confirmation',
    confirmation_kind: value?.type === 'confirmation' && ['toolInvocation', 'toolPostApproval', 'confirmation', 'questionCarousel', 'elicitation'].includes(value.kind)
      ? value.kind : null,
    reported_error: !!value?.errorDetails,
    max_tool_calls_exceeded: metadata?.maxToolCallsExceeded === true,
    model_rounds: Array.isArray(rounds) ? rounds.length : null,
    tool_calls: Array.isArray(rounds) ? rounds.reduce((count, round) => count + (Array.isArray(round?.toolCalls) ? round.toolCalls.length : 0), 0) : null,
  };
}
function workflowSnapshot(runtime, root, id) {
  const current = runtime.getRecord(root, id), status = runtime.workflowStatus(root, id);
  return { phase: typeof status?.phase === 'string' ? status.phase : null,
    persisted_phase: typeof current.meta.data.phase === 'string' ? current.meta.data.phase : null,
    status: current.meta.status, task_count: Array.isArray(status?.tasks) ? status.tasks.length : null,
    open_question_count: Array.isArray(status?.open_questions) ? status.open_questions.length : null,
    final_report_id: typeof status?.final_report_id === 'string' ? status.final_report_id : null };
}

function createNativeValidationHost({ vscode, context, loadRuntime }) {
  let busy = false;
  async function run() {
    if (busy) fail('ALREADY_RUNNING', 'This native Copilot validation is already running.');
    if (!vscode.workspace.isTrusted) fail('WORKSPACE_TRUST_REQUIRED', 'Workspace Trust is required for native Copilot validation.');
    const root = contextStoragePath(context.globalStorageUri);
    const requestPath = join(root, REQUEST), runningPath = join(root, RUNNING);
    if (!existsSync(requestPath)) fail('NOT_ARMED', 'No armed native Copilot validation request exists. Stage an explicitly authorized request first.');
    let request;
    try { request = validateRequest(JSON.parse(regularBytes(requestPath, 16_000).toString('utf8'))); }
    catch (error) { if (error instanceof NativeValidationError) throw error; fail('INVALID_AUTHORIZATION', 'Native validation authorization could not be read.'); }
    const project = realpathSync.native(request.project_root), runtimeRoot = realpathSync.native(request.runtime_root);
    const assertHostScope = () => {
      if (!vscode.workspace.isTrusted) fail('WORKSPACE_TRUST_REQUIRED', 'Workspace Trust is required for native Copilot validation.');
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      if (!folders.some(folder => samePath(realpathSync.native(folder.uri.fsPath), project)))
        fail('WORKSPACE_MISMATCH', 'Native validation must run in its exact authorized open project.');
      const setting = vscode.workspace.getConfiguration('neomind.bridge').inspect('runtimePath')?.globalValue;
      if (typeof setting !== 'string' || !isAbsolute(setting) || !samePath(realpathSync.native(setting), runtimeRoot) ||
          JSON.parse(regularBytes(join(runtimeRoot, 'package.json'), 64_000).toString('utf8')).name !== 'neomind')
        fail('RUNTIME_MISMATCH', 'Native validation requires the exact trusted NeoMind runtime from User settings.');
    };
    assertHostScope();
    const prompt = regularBytes(join(root, PROMPT), 32_000).toString('utf8');
    const profile = regularBytes(join(project, '.github/agents/neomind-coordinator.agent.md'), 128_000);
    if (hash(prompt) !== request.prompt_sha256 || hash(profile) !== request.profile_sha256)
      fail('INPUT_CHANGED', 'The authorized prompt or Coordinator profile changed; stage a newly reviewed validation request.');
    const runtime = await loadRuntime(project);
    const workflow = runtime.getRecord(project, request.workflow_id);
    if (workflow.meta.data.kind !== 'manager-workflow' || workflow.meta.data.execution_mode !== 'copilot-native' ||
        !runtime.nativeWorkflowRecord(project, workflow) || workflow.meta.data.routing_required === true ||
        /^completed/.test(String(workflow.meta.data.phase)) || ['completed', 'cancelled', 'superseded'].includes(workflow.meta.status))
      fail('WORKFLOW_MISMATCH', 'Native validation requires an existing open copilot-native workflow and preserves its assurance.');
    if (typeof runtime.getRuntimeBuildFingerprint !== 'function' || runtime.getRuntimeBuildFingerprint(runtimeRoot) !== request.expected_build_fingerprint)
      fail('RUNTIME_MISMATCH', 'The trusted runtime bytes changed after validation authorization.');
    if (!vscode.lm || typeof vscode.lm.invokeTool !== 'function')
      fail('API_UNAVAILABLE', 'This VS Code host cannot invoke the actual configured NeoMind MCP tools.');
    busy = true;
    const runId = hash(request.nonce).slice(0, 20), consumedPath = join(root, `native-copilot-validation-${hash(request.nonce)}.used`);
    let running = false, snapshot;
    try {
      try { closeSync(openSync(runningPath, 'wx', 0o600)); running = true; }
      catch { fail('ALREADY_RUNNING', 'Another native Copilot validation is already running in this extension storage.'); }
      try { closeSync(openSync(consumedPath, 'wx', 0o600)); }
      catch { fail('ALREADY_CONSUMED', 'This one-time native validation authorization was already consumed.'); }
      unlinkSync(requestPath);
      snapshot = { schema_version: 1, action: ACTION, run_id: runId, workflow_id: request.workflow_id,
        project_root: project, runtime_root: runtimeRoot, extension_version: context.extension?.packageJSON?.version ?? null,
        started_at: new Date().toISOString(), status: 'restarting-neomind-mcp' };
      writeResult(root, snapshot);
      // The installed VS Code command is deliberately restricted to the known User-profile NeoMind definition.
      // Trust/approval prompts remain under VS Code control; no autoTrustChanges or wildcard server is supplied.
      await vscode.commands.executeCommand('workbench.mcp.restartServer', SERVER_ID);
      await vscode.commands.executeCommand('workbench.mcp.startServer', SERVER_ID, { waitForLiveTools: true });
      const tools = (vscode.lm.tools ?? []).filter(tool => tool.name === 'mcp_neomind_runtime_info');
      if (tools.length !== 1) fail('RUNTIME_TOOL_UNAVAILABLE', 'The actual NeoMind runtime_info tool is unavailable after MCP restart.');
      const identity = parseIdentity(await vscode.lm.invokeTool(tools[0].name, { input: {}, toolInvocationToken: undefined }));
      if (!samePath(identity.project_root, project) || !samePath(identity.runtime_root, runtimeRoot) ||
          identity.build_fingerprint !== request.expected_build_fingerprint || typeof identity.server_instance_id !== 'string' ||
          !identity.server_instance_id || typeof identity.started_at !== 'string' || typeof identity.package_version !== 'string')
        fail('STALE_SERVING_RUNTIME', 'The serving runtime does not match the authorized project and trusted installed build.');
      snapshot.runtime = { package_version: identity.package_version, server_instance_id: identity.server_instance_id,
        started_at: identity.started_at, build_fingerprint: identity.build_fingerprint };
      snapshot.status = 'runtime-verified'; writeResult(root, snapshot);
      // A trust dialog, server start or tool invocation can outlive the original idle observation.
      // Recheck all mutable local authorization inputs before requesting native inference.
      validateRequest(request); assertHostScope();
      if (hash(regularBytes(join(root, PROMPT), 32_000)) !== request.prompt_sha256 ||
          hash(regularBytes(join(project, '.github/agents/neomind-coordinator.agent.md'), 128_000)) !== request.profile_sha256 ||
          runtime.getRuntimeBuildFingerprint(runtimeRoot) !== request.expected_build_fingerprint)
        fail('INPUT_CHANGED', 'The authorized prompt, Coordinator profile or trusted runtime changed before native launch.');
      // Generic newChat follows the remembered session provider and can select
      // Agent Host/SDK. This validation specifically requires Local Copilot Chat.
      await vscode.commands.executeCommand('workbench.action.chat.newLocalChat');
      snapshot.status = 'native-chat-requested'; snapshot.launched_at = new Date().toISOString(); writeResult(root, snapshot);
      const bootstrap = { workflow_id: request.workflow_id, profile_id: 'coordinator', role: 'manager',
        assignment_id: `native-validation-${runId}`,
        objective: 'Resume the existing authorized workflow through actual delegated work, independent checks and evidence-backed closure.' };
      const result = await vscode.commands.executeCommand('workbench.action.chat.open', {
        mode: PROFILE, query: `[NeoMind native validation ${runId}]\nExisting workflow: ${request.workflow_id}.\n` +
          `You are already assigned as this workflow's Coordinator. FIRST call assignment_bootstrap with exactly this JSON input: ${JSON.stringify(bootstrap)}\n` +
          'Then call assignment_open with the returned open_input unchanged. Omit outer reported_assignment on bootstrap/open; retain only the actual returned handle privately for later scoped calls. Bootstrap once in this invocation; do not reuse an earlier claimed Coordinator label or start manager_run.\n' + prompt,
        blockOnResponse: true, preserveInput: true,
      });
      snapshot.chat = summarizeChatResult(result);
      snapshot.workflow = workflowSnapshot(runtime, project, request.workflow_id);
      snapshot.status = snapshot.chat.pending_confirmation ? 'confirmation-required' : snapshot.chat.reported_error ? 'native-chat-error' :
        snapshot.workflow.phase === 'completed' && snapshot.workflow.final_report_id ? 'workflow-completed' : 'chat-returned-workflow-open';
      snapshot.completed_at = new Date().toISOString(); writeResult(root, snapshot);
      return snapshot;
    } catch (error) {
      const known = error instanceof NativeValidationError ? error : new NativeValidationError('HOST_OPERATION_FAILED',
        'Native Copilot validation could not finish its host operation. Inspect the actual VS Code and MCP state; no completion is claimed.');
      if (snapshot) writeResult(root, { ...snapshot, status: 'blocked', error_code: known.code, completed_at: new Date().toISOString() });
      throw known;
    } finally {
      busy = false;
      if (running && existsSync(runningPath)) unlinkSync(runningPath);
    }
  }
  async function handleUri(uri) {
    if (uri?.scheme !== vscode.env?.uriScheme || uri.authority !== context.extension?.id || uri.path !== URI_PATH || uri.query || uri.fragment)
      fail('INVALID_URI', 'Only the fixed native Copilot validation action is accepted; URLs never accept prompts, commands or credentials.');
    return run();
  }
  return { run, handleUri };
}

function activateNativeValidation(vscode, context, loadRuntime) {
  const host = createNativeValidationHost({ vscode, context, loadRuntime });
  const invoke = async action => {
    try {
      const result = await action();
      vscode.window.showInformationMessage(result.status === 'workflow-completed'
        ? 'NeoMind native Copilot validation observed saved workflow completion. Review its actual checks and report.'
        : 'NeoMind native Copilot validation returned. Inspect the saved validation result for remaining work or app confirmation.');
      return result;
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof NativeValidationError ? error.message : 'NeoMind native validation could not start.');
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND, () => invoke(host.run)));
  if (typeof vscode.window.registerUriHandler === 'function')
    context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: uri => invoke(() => host.handleUri(uri)) }));
}

module.exports = { activateNativeValidation, createNativeValidationHost, stageNativeValidationRequest, summarizeChatResult };
