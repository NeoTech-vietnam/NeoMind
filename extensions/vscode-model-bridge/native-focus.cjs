'use strict';
const { randomBytes } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { join } = require('node:path');
const { renderFocusSpace } = require('./focus-space.cjs');
const { createFocusHost } = require('./focus-host.cjs');
function activateNativeFocus(vscode, context, loadRuntime) {
  let current;
  context.subscriptions.push(vscode.commands.registerCommand('workforce.focus.open', async () => {
    if (current) { current.reveal(); return; }
    try {
      if (!vscode.workspace.isTrusted) throw Error('Trust the project first.');
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder) return;
      const runtime = await loadRuntime(realpathSync.native(folder.uri.fsPath));
      const resources = vscode.Uri.file(join(__dirname, 'resources/monitor'));
      const panel = vscode.window.createWebviewPanel('workforce.focus', 'WorkForce Focus Space', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
      current = panel;
      const nonce = randomBytes(24).toString('base64'), uri = file => panel.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, file)));
      const alive = () => current === panel && vscode.workspace.isTrusted;
      const host = createFocusHost({ vscode, context, runtime, alive, post: message => panel.webview.postMessage(message) });
      panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:*; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${uri('focus-space.css')}"><title>WorkForce Focus Space</title></head><body data-view="focus">${renderFocusSpace().replace('Back to Universe', 'Back to V-model')}<script nonce="${nonce}" src="${uri('focus-space.js')}"></script><script nonce="${nonce}" src="${uri('native-focus.js')}"></script></body></html>`;
      panel.webview.onDidReceiveMessage(message => {
        if (!alive()) return;
        if (message?.type === 'open-v-model') void vscode.commands.executeCommand('workforce.vModel.open');
        else void host.handle(message);
      });
      panel.onDidDispose(() => { host.dispose(); if (current === panel) current = undefined; });
    } catch { await vscode.window.showErrorMessage('Focus Space could not open for the selected local project.'); }
  }), vscode.workspace.onDidChangeWorkspaceFolders(() => { current?.dispose(); }));
}
module.exports = { activateNativeFocus };
