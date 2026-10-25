const vscode = require('vscode');
const { realpathSync, readFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { activateMonitor } = require('./monitor.cjs');
const { activatePluginPanel } = require('./plugin-panel.cjs');
const { activateAutomationPanel } = require('./automation-panel.cjs');
const { activateNativeValidation } = require('./native-validation.cjs');
const { activateNativeDispatch } = require('./native-dispatch.cjs');
const { activateControlledWorkflows } = require('./controlled-workflows.cjs');
let bridge;
let bridgeRoot;
let controlledEnabled = false;
let generation = 0;
let closing = Promise.resolve();
function disable() {
  generation++;
  const current = bridge; bridge = undefined;
  bridgeRoot = undefined; controlledEnabled = false;
  if (current) {
    closing = closing.then(() => current.close());
    // Disposal can be fire-and-forget. Observe failure without replacing the
    // shared promise: deactivation and a later enable must still await it.
    void closing.catch(() => {});
  }
  return closing;
}
function activate(context) {
  let enabling = false;
  const loadRuntime = async (root) => {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust required.');
    const open = vscode.workspace.workspaceFolders?.some(folder =>
      folder.uri.scheme === 'file' && realpathSync.native(folder.uri.fsPath) === root);
    if (!open) throw new Error('Monitor requires an exact open workspace folder.');
    const runtime = vscode.workspace.getConfiguration('neomind.bridge').inspect('runtimePath')?.globalValue;
    if (typeof runtime !== 'string' || !isAbsolute(runtime))
      throw new Error('Set User setting neomind.bridge.runtimePath to the trusted installed NeoMind package directory. Workspace overrides are ignored.');
    const packageRoot = realpathSync.native(runtime);
    if (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name !== 'neomind')
      throw new Error('Selected runtime is not a NeoMind package.');
    return await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  };
  activateMonitor(vscode, context, loadRuntime);
  activatePluginPanel(vscode, context, loadRuntime);
  activateAutomationPanel(vscode, context, loadRuntime);
  activateNativeValidation(vscode, context, loadRuntime);
  activateNativeDispatch(vscode, context, loadRuntime);
  activateControlledWorkflows(vscode, context, loadRuntime, { enabled: root => controlledEnabled && bridgeRoot === root });
  context.subscriptions.push(
    vscode.commands.registerCommand('neomind.bridge.enable', async preferredRoot => {
      if (enabling) return;
      const token = generation;
      enabling = true;
      try {
        await closing;
        if (token !== generation) return;
        if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust required.');
        if (bridge) throw new Error('Bridge already enabled. Disable before changing workspace or runtime.');
        const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
        const folder = typeof preferredRoot === 'string'
          ? folders.find(item => realpathSync.native(item.uri.fsPath) === realpathSync.native(preferredRoot))
          : folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
        if (typeof preferredRoot === 'string' && !folder) throw new Error('Selected NeoMind project must be an exact open workspace folder.');
        if (token !== generation || !folder || folder.uri.scheme !== 'file') return;
        const setting = vscode.workspace.getConfiguration('neomind.bridge').inspect('runtimePath');
        const runtime = setting?.globalValue;
        if (typeof runtime !== 'string' || !isAbsolute(runtime))
          throw new Error('Set User setting neomind.bridge.runtimePath to trusted installed NeoMind package directory. Workspace overrides are ignored.');
        const packageRoot = realpathSync.native(runtime);
        if (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name !== 'neomind')
          throw new Error('Selected runtime is not a NeoMind package. Reinstall the renamed runtime and re-enable the Bridge.');
        const root = realpathSync.native(folder.uri.fsPath);
        const consent = await vscode.window.showWarningMessage(
          `Enable automated NeoMind model requests and role-scoped engineering mutations for ${root}? Execute trusted runtime code from ${packageRoot}. No builtin shell/filesystem tools are exposed. Prescribed MCP operations may execute reviewed commands.`,
          { modal: true }, 'Enable');
        if (token !== generation || consent !== 'Enable') return;
        const { enableVSCodeHost } = await import(pathToFileURL(join(packageRoot, 'dist/vscode-host.js')).href);
        if (token !== generation) return;
        const host = await enableVSCodeHost(vscode, root);
        if (token !== generation) { await host.close(); return; }
        let controlled;
        try {
          const runtimeApi = await loadRuntime(root);
          if (typeof runtimeApi.startControlledHost === 'function') controlled = await runtimeApi.startControlledHost(root);
        } catch (error) { await host.close(); throw error; }
        const combined = { close: async () => { try { await controlled?.close(); } finally { await host.close(); } } };
        if (token !== generation) { await combined.close(); return; }
        bridge = combined; bridgeRoot = root; controlledEnabled = Boolean(controlled);
        vscode.window.showInformationMessage(`NeoMind Model Bridge enabled for selected workspace until disabled or window reload.${controlled ? ' Controlled workflows are ready.' : ' Update the runtime to enable controlled workflows.'}`);
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : 'NeoMind bridge could not start.');
      } finally { enabling = false; }
    }),
    vscode.commands.registerCommand('neomind.bridge.disable', disable),
    vscode.workspace.onDidChangeWorkspaceFolders(disable),
    { dispose: disable },
  );
}
module.exports = { activate, deactivate: disable };
