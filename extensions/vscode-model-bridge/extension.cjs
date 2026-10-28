const vscode = require('vscode');
const { realpathSync, readFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { activateMonitor } = require('./monitor.cjs');
const { activatePluginPanel } = require('./plugin-panel.cjs');
const { activateAutomationPanel } = require('./automation-panel.cjs');
const { activateControlledWorkflows } = require('./controlled-workflows.cjs');
let bridge, bridgeRoot, connecting, generation = 0, closing = Promise.resolve();
function disable() {
  generation++;
  connecting?.abort(); connecting = undefined;
  const current = bridge; bridge = undefined; bridgeRoot = undefined;
  if (current) {
    closing = closing.then(() => current.close());
    void closing.catch(() => {});
  }
  return closing;
}
function activate(context) {
  let enabling = false, approvalWrites = Promise.resolve();
  function saveConnection(value) {
    const operation = approvalWrites.then(() => context.workspaceState.update('workforce.connection', value));
    approvalWrites = operation.catch(() => {});
    return operation;
  }
  function installed() {
    const runtime = vscode.workspace.getConfiguration('workforce.bridge').inspect('runtimePath')?.globalValue;
    if (typeof runtime !== 'string' || !isAbsolute(runtime))
      throw new Error('Set User setting workforce.bridge.runtimePath to the trusted installed WorkForce package directory. Workspace overrides are ignored.');
    const path = realpathSync.native(runtime);
    if (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name !== 'workforce')
      throw new Error('The selected runtime is not a WorkForce package.');
    return path;
  }
  function selectedRoot(preferredRoot) {
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
    return preferredRoot ? folders.find(folder => realpathSync.native(folder.uri.fsPath) === realpathSync.native(preferredRoot)) : folders.length === 1 ? folders[0] : undefined;
  }
  const loadRuntime = async root => {
    if (!vscode.workspace.isTrusted || !selectedRoot(root)) throw new Error('WorkForce requires the exact open trusted workspace.');
    return import(pathToFileURL(join(installed(), 'dist/index.js')).href);
  };
  const connection = { enabled: root => Boolean(bridge) && bridgeRoot === root };
  activateMonitor(vscode, context, loadRuntime, connection);
  activatePluginPanel(vscode, context, loadRuntime);
  activateAutomationPanel(vscode, context, loadRuntime);
  activateControlledWorkflows(vscode, context, loadRuntime, connection);

  async function connect(preferredRoot, restoring = false) {
    if (enabling) return;
    const token = generation; enabling = true;
    const abort = new AbortController(); connecting = abort;
    try {
      await closing;
      if (token !== generation) return;
      if (!vscode.workspace.isTrusted) throw new Error('WorkForce requires Workspace Trust.');
      let folder = selectedRoot(preferredRoot);
      if (preferredRoot && !folder) throw new Error('The selected WorkForce project must be an exact open workspace folder.');
      if (!folder && !preferredRoot && !restoring) folder = await vscode.window.showWorkspaceFolderPick();
      if (!folder || token !== generation) return;
      const root = realpathSync.native(folder.uri.fsPath);
      if (bridge) {
        if (bridgeRoot === root) return;
        throw new Error('Disconnect WorkForce before changing the workspace owner.');
      }
      const runtimePath = installed(), api = await loadRuntime(root);
      const current = () => token === generation && vscode.workspace.isTrusted && selectedRoot(root) && installed() === runtimePath;
      if (!current()) return;
      const fingerprint = api.createRuntimeInfo(root).build_fingerprint;
      const saved = context.workspaceState.get('workforce.connection');
      const approved = saved?.root === root && saved.runtime === runtimePath && saved.fingerprint === fingerprint;
      if (restoring && !approved) return;
      if (!approved) {
        const choice = await vscode.window.showWarningMessage(
          `Connect WorkForce for ${root}? Trusted runtime ${runtimePath} will run OpenCode agents through your configured endpoint and execute scoped engineering tools while this VS Code window remains open.`,
          { modal: true }, 'Connect');
        if (choice !== 'Connect' || !current()) return;
      }
      if (!api.readRoutingPolicy(root)?.language_models_file) {
        const discovered = api.discoverWorkForceModelCatalog(root);
        let path = discovered.path;
        if (!path && !restoring) {
          const selected = await vscode.window.showOpenDialog({ title: 'WorkForce: choose your VS Code model catalog', openLabel: 'Use model catalog',
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Model catalog JSON': ['json'] } });
          if (!current()) return;
          if (selected?.length !== 1 || selected[0].scheme !== 'file') return;
          path = selected[0].fsPath;
        }
        if (!path) return;
        api.configureWorkForceModelCatalog(root, { path });
      }
      if (!current()) return;
      const { enableWorkForceHost } = await import(pathToFileURL(join(runtimePath, 'dist/workforce-host.js')).href);
      if (!current()) return;
      const owner = await enableWorkForceHost(vscode, root);
      if (!current()) { await owner.close(); return; }
      let controller;
      try {
        if (typeof api.probeWorkForceConnection !== 'function') throw new Error('Update the WorkForce runtime to check model tool capability.');
        const proof = await api.probeWorkForceConnection(root, abort.signal);
        if (!proof.valid) throw new Error('WorkForce model tool capability check did not pass.');
        if (!current()) { await owner.close(); return; }
        controller = await api.startControlledHost(root);
      }
      catch (error) { await owner.close(); throw error; }
      const combined = { close: async () => { try { await controller.close(); } finally { await owner.close(); } } };
      if (!current()) { await combined.close(); return; }
      bridge = combined; bridgeRoot = root;
      await saveConnection({ root, runtime: runtimePath, fingerprint });
      if (!current()) return;
      if (!restoring) vscode.window.showInformationMessage('WorkForce connected. OpenCode owns worker sessions; your configured model aliases apply to new invocations.');
    } catch (error) {
      if (!restoring && !abort.signal.aborted && token === generation) vscode.window.showErrorMessage(error instanceof Error ? error.message : 'WorkForce could not connect.');
    } finally { if (connecting === abort) connecting = undefined; enabling = false; }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('workforce.bridge.enable', root => connect(root)),
    vscode.commands.registerCommand('workforce.bridge.disable', async () => {
      const stopped = disable();
      await saveConnection(undefined); await stopped;
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(disable),
    { dispose: disable },
  );
  const saved = context.workspaceState.get('workforce.connection');
  if (saved?.root) void connect(saved.root, true);
}
module.exports = { activate, deactivate: disable };
