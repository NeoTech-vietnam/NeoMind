'use strict';
const vscode = require('vscode');
const { join, resolve } = require('node:path');
const { createDriver } = require('./driver-lib.cjs');
function activate(context) {
  const configPath = process.env.WORKFORCE_ACCEPTANCE_CONFIG ?? resolve(__dirname, '../../artifacts/workforce-client-driver/config.json');
  const driver = createDriver({ vscode, context, configPath });
  context.subscriptions.push({ dispose: () => driver.close() },
    vscode.commands.registerCommand('workforce.acceptance.prepare', () => driver.inspect()),
    vscode.commands.registerCommand('workforce.acceptance.runOnce', () => driver.runOnce()),
    vscode.commands.registerCommand('workforce.acceptance.capture', () => driver.capture()));
  void driver.listen();
}
module.exports = { activate };
