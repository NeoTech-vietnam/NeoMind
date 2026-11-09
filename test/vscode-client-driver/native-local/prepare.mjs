// A native Local proof fixture. Preparation does not invoke a model or change User settings.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const run = join(repository, 'artifacts/workforce-native-local-proof', randomUUID().slice(0, 8));
const workspace = join(run, 'workspace');
const extension = join(run, 'extension');
const evidence = join(run, 'evidence');
for (const path of [workspace, extension, evidence]) mkdirSync(path, { recursive: true });

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: 'wx' });
};
const writeJson = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const fixtures = {
  coordinator: 'WF.PM Native Proof',
  worker: 'WF.Tester Native Proof',
  marker: 'WORKFORCE_M2_NATIVE_CHECK_PASSED',
};
writeJson(join(extension, 'fixture.json'), {
  workspace, evidence, repository, showVModel: process.argv.includes('--show-v-model'), ...fixtures,
});
writeJson(join(extension, 'package.json'), {
  name: 'workforce-native-local-proof',
  publisher: 'workforce-test',
  version: '0.0.1',
  engines: { vscode: '^1.143.0' },
  main: './extension.cjs',
  activationEvents: ['onStartupFinished'],
  contributes: {
    commands: [
      { command: 'workforceM2.inspect', title: 'WorkForce M2: Inspect Local Capabilities' },
      { command: 'workforceM2.run', title: 'WorkForce M2: Run One Native Local Proof' },
      { command: 'workforceM2.capture', title: 'WorkForce M2: Capture Local Evidence' },
      { command: 'workforceM2.previewVModel', title: 'WorkForce M1: Preview V-model Fixture' },
    ],
  },
});
copyFileSync(join(here, 'extension.cjs'), join(extension, 'extension.cjs'));
copyFileSync(join(here, 'v-model-fixture.cjs'), join(extension, 'v-model-fixture.cjs'));
copyFileSync(join(here, 'hook.cjs'), join(workspace, 'm2-hook.cjs'));

writeJson(join(workspace, '.vscode', 'settings.json'), { 'chat.useHooks': true });
const hookPath = join(workspace, 'm2-hook.cjs');
const nodePath = process.execPath;
const quoteShell = path => "'" + path.replaceAll("'", "'\\''") + "'";
const quotePowerShell = path => "'" + path.replaceAll("'", "''") + "'";
const hook = {
  type: 'command',
  command: `${quoteShell(nodePath)} ${quoteShell(hookPath)}`,
  powershell: `& ${quotePowerShell(nodePath)} ${quotePowerShell(hookPath)}`,
  windows: `& ${quotePowerShell(nodePath)} ${quotePowerShell(hookPath)}`,
  timeout: 5,
};
writeJson(join(workspace, '.github', 'hooks', 'native-proof.json'), {
  hooks: Object.fromEntries(['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']
    .map(event => [event, [hook]])),
});
write(join(workspace, '.github', 'agents', 'm2-pm.agent.md'), `---
name: ${fixtures.coordinator}
description: Coordinate a single bounded native Local delegation test.
tools: ['agent']
agents: ['${fixtures.worker}']
---
Delegate the request once to ${fixtures.worker} using the native subagent tool. Report its observed result. Do not run the test yourself or invent a result.
`);
write(join(workspace, '.github', 'agents', 'm2-tester.agent.md'), `---
name: ${fixtures.worker}
description: Read and run the isolated WorkForce M2 fixture check.
tools: ['read', 'execute']
agents: []
user-invocable: true
---
Read m2-fixture.test.cjs and run node --test m2-fixture.test.cjs in the workspace root. Report the exact marker and result. Make no file changes.
`);
write(join(workspace, 'm2-fixture.test.cjs'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('${fixtures.marker}', () => assert.equal([2, 3, 5].reduce((sum, value) => sum + value, 0), 10));
`);
write(join(workspace, 'README.md'), '# WorkForce native Local proof fixture\n\nUse the WorkForce M2 commands in the VS Code Command Palette.\n');
const git = spawnSync('git', ['init', '--quiet', workspace], { windowsHide: true });
if (git.status !== 0) throw new Error('Could not initialize the isolated Git workspace.');

const launch = ['--new-window', `--extensionDevelopmentPath=${extension}`, workspace];
console.log(JSON.stringify({ workspace, extension, evidence, launch, dispatched: false }, null, 2));
if (process.argv.includes('--launch')) {
  const windows = process.platform === 'win32';
  // Keep one shell and quote the generated local paths for the Windows code.cmd wrapper.
  const result = windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `& code ${launch.map(quotePowerShell).join(' ')}`], { windowsHide: true })
    : spawnSync('code', launch);
  if (result.status !== 0) throw new Error('Could not open the VS Code fixture window.');
}
