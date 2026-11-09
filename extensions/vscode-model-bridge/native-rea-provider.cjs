'use strict';
const { createHash } = require('node:crypto');
const { existsSync, realpathSync } = require('node:fs');
const { join } = require('node:path');

function activateNativeReaProvider(vscode, context, loadRuntime, installedRuntime) {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') return;
  const changed = new vscode.EventEmitter();
  context.subscriptions.push(changed);
  const registration = vscode.lm.registerMcpServerDefinitionProvider('workforce-rea', {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      if (!vscode.workspace.isTrusted) return [];
      const definitions = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') continue;
        const root = realpathSync.native(folder.uri.fsPath), api = await loadRuntime(root);
        const status = api.reaStatus(root);
        if (status.status !== 'ready') continue;
        const entry = join(installedRuntime(), 'dist/rea-native-mcp.js');
        if (!existsSync(entry)) continue;
        const version = createHash('sha256').update(JSON.stringify({ root, pin: status.pin, configuration: api.readReaConfiguration(root) })).digest('hex');
        definitions.push(new vscode.McpStdioServerDefinition(`WorkForce REA (${folder.name})`, status.server.command,
          [entry, '--project', root], status.server.env, version));
      }
      return definitions;
    },
  });
  context.subscriptions.push(registration);
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.workforce,.neomind}/rea.json');
  context.subscriptions.push(watcher, watcher.onDidChange(() => changed.fire()), watcher.onDidCreate(() => changed.fire()), watcher.onDidDelete(() => changed.fire()));
  return registration;
}
module.exports = { activateNativeReaProvider };
