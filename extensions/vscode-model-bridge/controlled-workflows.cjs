const { randomBytes, randomUUID } = require('node:crypto');
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

const TOOL_NAME = 'neomind_controlled_workflow';
const LOCAL_COORDINATOR_COMMAND = 'neomind.coordinator.openLocal';
const COORDINATOR_PROFILE = 'NeoMind Coordinator Agent';
const actions = ['submit', 'status', 'pause', 'resume', 'cancel'];
const apiNames = ['startControlledWorkflow', 'controlledStatus', 'controlControlledWorkflow'];
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
class ControlledUIError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new ControlledUIError(code, message); }
function text(value, maximum) { return typeof value === 'string' && value.trim() && value.length <= maximum; }
function openRoot(vscode, path) {
  if (!vscode.workspace.isTrusted) fail('WORKSPACE_UNTRUSTED', 'Open and trust the project before using NeoMind.');
  if (!text(path, 4096) || !isAbsolute(path) || /^[\\/]{2}/.test(path))
    fail('PROJECT_REQUIRED', 'Choose the exact absolute workspace folder for this request.');
  let root;
  try { root = realpathSync.native(path); } catch { fail('PROJECT_REQUIRED', 'The selected workspace folder is unavailable.'); }
  const exists = vscode.workspace.workspaceFolders?.some(folder => {
    if (folder.uri.scheme !== 'file') return false;
    try { return samePath(realpathSync.native(folder.uri.fsPath), root); } catch { return false; }
  });
  if (!exists) fail('PROJECT_REQUIRED', 'The selected project must be an exact open local workspace folder.');
  return root;
}
function requireApi(runtime) {
  if (apiNames.some(name => typeof runtime?.[name] !== 'function'))
    fail('RUNTIME_UPDATE_REQUIRED', 'Update the NeoMind runtime to use controlled workflows.');
}
function publicError(error) {
  if (error?.code === 'CONTINUATION_PILOT_UNSUPPORTED') return {
    code: 'CONTINUATION_PILOT_UNSUPPORTED',
    message: 'This saved contract needs an intended-use adapter for its original task family. Its acceptance conditions remain open; NeoMind will not replace them with LeetCode or C/C++ requirements.',
  };
  return error instanceof ControlledUIError ? { code: error.code, message: error.message }
    : { code: 'CONTROLLED_OPERATION_FAILED', message: 'NeoMind could not complete this operation. Inspect the workflow journal and Bridge status; the accepted workflow is preserved.' };
}
const fields = (value, keys) => Object.fromEntries(keys.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key]) || value?.[key] === null)
  .map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 16000) : value[key]]));
/** Public projections intentionally omit credentials, prompts and raw provider/tool payloads. */
function publicWorkflow(value) {
  const result = fields(value, ['workflow_id', 'title', 'status', 'phase', 'process_contract', 'transport', 'created_at', 'updated_at', 'final_report_id']);
  if (value?.process_contract && typeof value.process_contract === 'object')
    result.process_contract = fields(value.process_contract, ['name', 'version', 'process', 'schema_version']);
  result.active_invocations = (Array.isArray(value?.active_invocations) ? value.active_invocations : []).slice(0, 100)
    .map(item => fields(item, ['id', 'invocation_id', 'role', 'stage', 'state', 'status', 'requested_model', 'confirmed_model', 'model_provider', 'provider', 'started_at', 'updated_at']));
  result.events = (Array.isArray(value?.events) ? value.events : []).slice(-100)
    .map(item => fields(item, ['id', 'sequence', 'at', 'timestamp', 'type', 'kind', 'stage', 'role', 'state', 'status', 'summary', 'message', 'code', 'owner']));
  result.blocker = value?.blocker && typeof value.blocker === 'object'
    ? fields(value.blocker, ['code', 'kind', 'trace_id', 'phase', 'owner', 'message', 'retryable', 'next_action']) : typeof value?.blocker === 'string' ? value.blocker.slice(0, 4000) : null;
  return result;
}
function publicStatus(value) {
  const values = Array.isArray(value) ? value : Array.isArray(value?.workflows) ? value.workflows : value?.workflow_id ? [value] : [];
  return { workflows: values.slice(0, 200).map(publicWorkflow) };
}
function inputValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['action', 'workspace_folder', 'requirement', 'workflow_id', 'title'].includes(key)) || !actions.includes(value.action))
    fail('INVALID_REQUEST', 'Choose submit, status, pause, resume or cancel.');
  if (value.workflow_id !== undefined && !text(value.workflow_id, 256)) fail('INVALID_REQUEST', 'Use a workflow ID returned by NeoMind.');
  if (value.title !== undefined && !text(value.title, 256)) fail('INVALID_REQUEST', 'Use a title of at most 256 characters.');
  if (value.action === 'submit') {
    if (!text(value.requirement, 20000) || value.workflow_id !== undefined)
      fail('INVALID_REQUEST', 'Submit a new requirement, or resume an existing workflow by its saved ID.');
  } else if (value.requirement !== undefined || value.title !== undefined ||
      (value.action !== 'status' && !value.workflow_id)) fail('INVALID_REQUEST', 'Select the existing workflow for this control action.');
  return value;
}
async function perform({ runtime, root, enabled, input }) {
  requireApi(runtime);
  if (input.action === 'status') return publicStatus(await runtime.controlledStatus(root, input.workflow_id));
  if (!enabled()) fail('BRIDGE_DISABLED', 'Enable the NeoMind Model Bridge for this workspace before submitting or controlling work.');
  const result = input.action === 'submit'
    ? await runtime.startControlledWorkflow(root, { requirement: input.requirement.trim(), request_id: randomUUID(), ...(input.title ? { title: input.title.trim() } : {}) })
    : await runtime.controlControlledWorkflow(root, { workflow_id: input.workflow_id, action: input.action });
  return publicStatus(result);
}
function createControlledPanelHost({ runtime, root, post, alive = () => true, enabled = () => false }) {
  let busy = false;
  async function snapshot() {
    if (!alive()) return;
    const state = publicStatus(await runtime.controlledStatus(root));
    if (alive()) await post({ type: 'controlled-snapshot', workspace_folder: root, enabled: enabled(), ...state });
  }
  async function handle(message) {
    if (!alive() || busy || message?.type !== 'controlled-action') return;
    busy = true;
    try {
      const input = inputValue({ action: message.action, ...(message.requirement !== undefined ? { requirement: message.requirement } : {}),
        ...(message.workflow_id !== undefined ? { workflow_id: message.workflow_id } : {}) });
      if (input.action === 'status') await snapshot();
      else {
        await post({ type: 'controlled-busy', busy: true });
        const receipt = await perform({ runtime, root, enabled, input });
        if (alive()) await post({ type: 'controlled-receipt', action: input.action, ...receipt });
        await snapshot();
      }
    } catch (error) { if (alive()) await post({ type: 'controlled-error', ...publicError(error) }); }
    finally { busy = false; if (alive()) await post({ type: 'controlled-busy', busy: false }); }
  }
  return { handle, snapshot };
}
function renderControlledPanel({ cspSource, script, style, nonce }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${style}"><title>NeoMind Workflows</title></head><body>
<header><p class="eyebrow">NEOMIND · CONTROLLED EXECUTION</p><h1>Mission control</h1><p id="workspace">Connecting to the selected project…</p><div class="toolbar"><span id="owner" role="status">Reading Bridge state</span><button id="enable">Enable Model Bridge</button><button id="local-coordinator">Open Local Coordinator</button><button id="refresh">Refresh</button><button id="universe">Open Universe</button></div><p class="hint">In Local Copilot chat, choose your 9router custom-endpoint model in the model picker. NeoMind workers use their configured Bridge role models.</p></header>
<p id="notice" role="status" aria-live="polite"></p>
<section class="compose"><h2>Give NeoMind a task</h2><label for="requirement">Describe the outcome and constraints</label><textarea id="requirement" rows="4" maxlength="20000" placeholder="What should NeoMind implement and verify?"></textarea><button id="submit" disabled>Start workflow</button><p class="hint">NeoMind owns the agents and their tool context. Accepted work continues when this panel or chat is closed, while VS Code stays open.</p></section>
<main><section><h2>Saved workflows</h2><div id="workflows"><p>No saved controlled workflows.</p></div></section><section class="details"><h2 id="selection-title">Select a workflow</h2><p id="selection-state"></p><div id="controls"></div><h3>Owned agents</h3><div id="agents"></div><h3>Runtime journal</h3><ol id="events"></ol></section></main>
<footer>Closing VS Code stops model requests and owned checks. Reopening reconciles the last durable checkpoint. A completed agent turn alone does not establish accepted work.</footer>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}
function activateControlledWorkflows(vscode, context, loadRuntime, { enabled = () => false } = {}) {
  let panel, timer, opening = false, generation = 0;
  function stop() { generation++; clearInterval(timer); timer = undefined; const old = panel; panel = undefined; old?.dispose(); }
  async function openLocalCoordinator() {
    try {
      if (!vscode.workspace.isTrusted) fail('WORKSPACE_UNTRUSTED', 'Trust the workspace before opening the Local Coordinator.');
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder) fail('PROJECT_REQUIRED', 'Open and select the project folder before opening the Local Coordinator.');
      const root = openRoot(vscode, folder.uri.fsPath);
      try {
        const profile = join(root, '.github', 'agents', 'neomind-coordinator.agent.md'), info = lstatSync(profile);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128000 || !samePath(realpathSync.native(profile), profile) ||
            !/^name:\s*["']?NeoMind Coordinator Agent["']?\s*$/m.test(readFileSync(profile, 'utf8')))
          throw new Error('Invalid profile.');
      } catch { fail('COORDINATOR_PROFILE_REQUIRED', 'Run neomind update --local for this project and review the NeoMind Coordinator profile before opening it.'); }
      const commands = typeof vscode.commands.getCommands === 'function' ? await vscode.commands.getCommands(true) : [];
      if (!commands.includes('workbench.action.chat.newLocalChat') || !commands.includes('workbench.action.chat.open'))
        fail('LOCAL_CHAT_UNAVAILABLE', 'This VS Code installation does not expose Local Copilot Chat. Enable or update Copilot Chat; NeoMind will not open another session type.');
      openRoot(vscode, root);
      try { await vscode.commands.executeCommand('workbench.action.chat.newLocalChat'); }
      catch { fail('LOCAL_CHAT_UNAVAILABLE', 'VS Code could not create Local Copilot Chat. No alternative session was opened by NeoMind.'); }
      openRoot(vscode, root);
      // A generic new-chat command can follow a remembered SDK/cloud provider.
      // Select Local first; leave model/provider selection to the user's picker.
      try { await vscode.commands.executeCommand('workbench.action.chat.open', { mode: COORDINATOR_PROFILE }); }
      catch { fail('LOCAL_COORDINATOR_UNAVAILABLE', 'Local chat was created, but VS Code could not select the NeoMind Coordinator profile. No request was submitted.'); }
      return { opened: true, target: 'local', profile: COORDINATOR_PROFILE, model_selection: 'user-picker' };
    } catch (error) {
      const result = publicError(error);
      await vscode.window.showErrorMessage(result.message);
      return { opened: false, error: result };
    }
  }
  async function open() {
    if (opening) return; opening = true; const token = generation;
    try {
      if (panel) { panel.reveal(); return; }
      if (!vscode.workspace.isTrusted) fail('WORKSPACE_UNTRUSTED', 'Trust the workspace before opening NeoMind Workflows.');
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder || token !== generation) return;
      const root = openRoot(vscode, folder.uri.fsPath), runtime = await loadRuntime(root); requireApi(runtime);
      if (token !== generation) return;
      const resources = vscode.Uri.file(join(__dirname, 'resources', 'monitor'));
      const current = vscode.window.createWebviewPanel('neomind.controlledWorkflows', 'NeoMind Workflows', vscode.ViewColumn?.One ?? 1,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
      panel = current;
      const asset = name => current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, name)));
      current.webview.html = renderControlledPanel({ cspSource: current.webview.cspSource, script: asset('controlled.js'), style: asset('controlled.css'), nonce: randomBytes(24).toString('hex') });
      const alive = () => panel === current && token === generation && vscode.workspace.isTrusted;
      const host = createControlledPanelHost({ runtime, root, post: message => current.webview.postMessage(message), alive, enabled: () => enabled(root) });
      const messages = current.webview.onDidReceiveMessage(async message => {
        if (!alive()) return;
        if (message?.type === 'controlled-enable') { await vscode.commands.executeCommand('neomind.bridge.enable', root); await host.handle({ type: 'controlled-action', action: 'status' }); }
        else if (message?.type === 'controlled-local-coordinator') await vscode.commands.executeCommand(LOCAL_COORDINATOR_COMMAND);
        else if (message?.type === 'controlled-universe') await vscode.commands.executeCommand('neomind.monitor.open');
        else await host.handle(message);
      });
      current.onDidDispose(() => { messages.dispose(); clearInterval(timer); timer = undefined; if (panel === current) panel = undefined; });
      await host.handle({ type: 'controlled-action', action: 'status' });
      if (!alive()) return;
      timer = setInterval(() => { void host.handle({ type: 'controlled-action', action: 'status' }); }, 2000); timer.unref?.();
    } catch (error) { if (token === generation) await vscode.window.showErrorMessage(publicError(error).message); }
    finally { opening = false; }
  }
  const command = vscode.commands.registerCommand('neomind.workflows.open', open);
  const localCoordinator = vscode.commands.registerCommand(LOCAL_COORDINATOR_COMMAND, openLocalCoordinator);
  const disposable = { dispose: stop };
  context.subscriptions.push(command, localCoordinator, vscode.workspace.onDidChangeWorkspaceFolders(stop), disposable);
  if (typeof vscode.lm?.registerTool === 'function') context.subscriptions.push(vscode.lm.registerTool(TOOL_NAME, {
    prepareInvocation(options) {
      return { invocationMessage: `NeoMind: ${options?.input?.action ?? 'workflow'} in the selected project` };
    },
    async invoke(options, token) {
      let response;
      try {
        if (token?.isCancellationRequested) fail('REQUEST_CANCELLED', 'The request was cancelled before NeoMind accepted it.');
        const input = inputValue(options?.input), root = openRoot(vscode, input.workspace_folder), runtime = await loadRuntime(root);
        if (token?.isCancellationRequested) fail('REQUEST_CANCELLED', 'The request was cancelled before NeoMind accepted it.');
        response = await perform({ runtime, root, enabled: () => enabled(root), input });
      } catch (error) { response = { error: publicError(error) }; }
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(response))]);
    },
  }));
  return disposable;
}
module.exports = { TOOL_NAME, LOCAL_COORDINATOR_COMMAND, activateControlledWorkflows, createControlledPanelHost, renderControlledPanel, publicStatus, inputValue, openRoot };
