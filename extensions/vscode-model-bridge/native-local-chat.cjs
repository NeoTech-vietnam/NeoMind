'use strict';
const { existsSync, realpathSync, lstatSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function registerNativeLocalChat(vscode, context) {
  let generation = 0;
  const changed = vscode.workspace.onDidChangeWorkspaceFolders(() => { generation++; });
  async function open() {
    const current = generation;
    try {
      if (!vscode.workspace.isTrusted) throw Error('Trust the project before opening WorkForce Local.');
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder) return { opened: false, reason: 'project-not-selected' };
      const root = realpathSync.native(folder.uri.fsPath);
      const guard = () => {
        if (generation !== current || !vscode.workspace.isTrusted || !(vscode.workspace.workspaceFolders ?? []).some(item =>
          item.uri.scheme === 'file' && realpathSync.native(item.uri.fsPath) === root)) throw Error('The selected project changed; no request was submitted.');
      };
      guard();
      // Native Agent Plugin selectors are discovered by the host, without reading its private cache.
      const profile = join(root, '.github/agents/workforce-pm.agent.md');
      if (existsSync(profile)) {
        const info = lstatSync(profile);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128000 ||
            !/^Execution contract: vscode-native\/v1\./m.test(readFileSync(profile, 'utf8')))
          throw Error('Update the WorkForce Local profiles; edited profiles remain preserved.');
      }
      const commands = await vscode.commands.getCommands(true); guard();
      for (const command of ['workbench.action.chat.openInSidebar', 'workbench.action.chat.newLocalChat', 'workbench.action.chat.open'])
        if (!commands.includes(command)) throw Error('The installed VS Code Local chat interface is unavailable. Enable the native Local chat extension.');
      await vscode.commands.executeCommand('workbench.action.chat.openInSidebar'); guard();
      await vscode.commands.executeCommand('workbench.action.chat.newLocalChat'); guard();
      await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'WF.PM' }); guard();
      return { opened: true, target: 'local', profile: 'WF.PM', model_selection: 'native-picker' };
    } catch (error) { await vscode.window.showErrorMessage(error.message); return { opened: false, reason: 'native-chat-unavailable' }; }
  }
  context.subscriptions.push(changed, ...['workforce.pm.openLocal', 'workforce.coordinator.openLocal', 'workforce.bridge.enable']
    .map(id => vscode.commands.registerCommand(id, open)));
  return { open, dispose() { generation++; } };
}
module.exports = { registerNativeLocalChat };
