'use strict';
const vscode = require('vscode');
const { resolve } = require('node:path');
const { readFileSync, realpathSync } = require('node:fs');
const { createDriver } = require('./driver-lib.cjs');
async function activate(context) {
  const configPath = process.env.WORKFORCE_ACCEPTANCE_CONFIG ?? resolve(__dirname, '../../artifacts/workforce-client-driver/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
  const canonical = path => process.platform === 'win32' ? realpathSync.native(path).toLowerCase() : realpathSync.native(path);
  if (folders.length !== 1 || canonical(folders[0].uri.fsPath) !== canonical(config.workspace_root)) return;
  const driver = createDriver({ vscode, context, configPath });
  context.subscriptions.push({ dispose: () => driver.close() },
    vscode.commands.registerCommand('workforce.acceptance.prepare', () => driver.inspect()),
    vscode.commands.registerCommand('workforce.acceptance.runOnce', () => driver.runOnce()),
    vscode.commands.registerCommand('workforce.acceptance.capture', () => driver.capture()));
  void driver.listen();
}
module.exports = { activate };
