const vscode = require('vscode');
const { realpathSync, readFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');
let bridge;
let generation = 0;
async function disable() {
  generation++;
  const current = bridge; bridge = undefined;
  await current?.close();
}
function activate(context) {
  let enabling = false;
  context.subscriptions.push(
    vscode.commands.registerCommand('taskforces.bridge.enable', async () => {
      if (enabling) return;
      const token = generation;
      enabling = true;
      try {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust required.');
        if (bridge) throw new Error('Bridge already enabled. Disable before changing workspace or runtime.');
        const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
        const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
        if (token !== generation || !folder || folder.uri.scheme !== 'file') return;
        const setting = vscode.workspace.getConfiguration('taskforces.bridge').inspect('runtimePath');
        const runtime = setting?.globalValue;
        if (typeof runtime !== 'string' || !isAbsolute(runtime))
          throw new Error('Set User setting taskforces.bridge.runtimePath to trusted installed TaskForces package directory. Workspace overrides are ignored.');
        const packageRoot = realpathSync.native(runtime);
        if (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name !== 'taskforces')
          throw new Error('Selected runtime is not a TaskForces package. Reinstall the renamed runtime and re-enable the Bridge.');
        const root = realpathSync.native(folder.uri.fsPath);
        const consent = await vscode.window.showWarningMessage(
          `Enable automated TaskForces model requests and role-scoped engineering mutations for ${root}? Execute trusted runtime code from ${packageRoot}. No builtin shell/filesystem tools are exposed. Prescribed MCP operations may execute reviewed commands.`,
          { modal: true }, 'Enable');
        if (token !== generation || consent !== 'Enable') return;
        const { enableVSCodeHost } = await import(pathToFileURL(join(packageRoot, 'dist/vscode-host.js')).href);
        if (token !== generation) return;
        const host = await enableVSCodeHost(vscode, root);
        if (token !== generation) { await host.close(); return; }
        bridge = host;
        vscode.window.showInformationMessage('TaskForces Model Bridge enabled for selected workspace until disabled or window reload.');
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : 'TaskForces bridge could not start.');
      } finally { enabling = false; }
    }),
    vscode.commands.registerCommand('taskforces.bridge.disable', disable),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void disable(); }),
    { dispose: () => { void disable(); } },
  );
}
module.exports = { activate, deactivate: disable };
