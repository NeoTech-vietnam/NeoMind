'use strict';
const vscode = require('vscode');
const { realpathSync, readFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { activateNativeEntry } = require('./native-entry.cjs');
const { activateVModelPanel } = require('./v-model-panel.cjs');
const { activatePluginPanel } = require('./plugin-panel.cjs');
const { activateAutomationPanel } = require('./automation-panel.cjs');
const { registerNativeLocalChat } = require('./native-local-chat.cjs');
const { activateNativeReaProvider } = require('./native-rea-provider.cjs');
const { activateNativeFocus } = require('./native-focus.cjs');
let nativeEntry, gateway, closing;

function activate(context) {
  closing = undefined;
  const installed = () => {
    const runtime = vscode.workspace.getConfiguration('workforce.bridge').inspect('runtimePath')?.globalValue;
    if (typeof runtime !== 'string' || !isAbsolute(runtime)) throw Error('Set User setting workforce.bridge.runtimePath to the installed WorkForce runtime directory.');
    const root = realpathSync.native(runtime);
    if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== 'workforce') throw Error('The selected directory is not a WorkForce runtime.');
    return root;
  };
  const loadRuntime = async root => {
    if (!vscode.workspace.isTrusted || !(vscode.workspace.workspaceFolders ?? []).some(folder =>
      folder.uri.scheme === 'file' && realpathSync.native(folder.uri.fsPath) === realpathSync.native(root)))
      throw Error('WorkForce requires the exact open trusted local project.');
    return import(pathToFileURL(join(installed(), 'dist/index.js')).href);
  };
  nativeEntry = activateNativeEntry(vscode, context, loadRuntime);
  activateVModelPanel(vscode, context, loadRuntime);
  activatePluginPanel(vscode, context, loadRuntime);
  activateAutomationPanel(vscode, context, loadRuntime);
  activateNativeFocus(vscode, context, loadRuntime);
  const local = registerNativeLocalChat(vscode, context);
  activateNativeReaProvider(vscode, context, loadRuntime, installed);
  // Registering the optional provider starts no service or inference.
  gateway = require('./managed-gateway-host.cjs').activateManagedGateway(vscode, context, loadRuntime, installed);
  context.subscriptions.push(local, { dispose: deactivate },
    ...['workforce.monitor.open', 'workforce.monitor.legacy', 'neomind.monitor.open', 'workforce.workflows.open', 'neomind.workflows.open']
      .map(id => vscode.commands.registerCommand(id, () => vscode.commands.executeCommand('workforce.vModel.open'))),
    vscode.commands.registerCommand('workforce.bridge.disable', () => nativeEntry.dispose()));
}
function deactivate() { return closing ??= Promise.all([nativeEntry?.dispose(), gateway?.dispose()]).then(() => {}); }
module.exports = { activate, deactivate };
