// Independent negative controls for lifecycle-equivalent guidance. These inspect
// real local receipts/check results without invoking any model or remote source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, safePath, hash, loadRecords, requestFolderForWorkflow } from '../dist/storage.js';
import { installWorkspaceSkillComponents, controlWorkspaceSkillComponent } from '../dist/workspace-skill-components.js';
import { resolveNativeSkills, nativeSkillReceiptDependencies } from '../dist/native-skill-context.js';
import * as requests from '../dist/native-request.js';
import * as roles from '../dist/native-role-job.js';
import { runCommand } from '../dist/command-runner.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-skill-raw-dependency-'));
  initialize(root, { project_id: 'WF-SKILL-RAW' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const approval = { approved: true, repository: 'https://github.com/example/reviewed-guidance', commit: 'a'.repeat(40),
    license_path: 'LICENSE', skills: [{ source_path: 'skills/checking', target_name: 'checking', files: ['skills/checking/SKILL.md'] }] };
  const files = new Map([['LICENSE', 'MIT License\n'], ['skills/checking/SKILL.md',
    '---\nname: checking\ndescription: Check the actual requested facts.\n---\nInspect concrete outcomes.\n']]);
  const install = () => installWorkspaceSkillComponents(root, approval, async input =>
    ({ ...input, kind: 'file', complete: true, content: files.get(input.path) }));
  return { root, install };
}
const professional = { summary: 'Independently inspected the bounded result.', verdict: 'pass', findings: [] };
function callback(root, state, job) {
  return requests.recordNativeResult(root, { request_ref: state.request_ref, assignment_ref: job.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true,
      agentName: job.agentName, status: 'returned' }, raw_result: JSON.stringify(professional) });
}
function retainedHistory(root, ref, stateName = 'execution.json') {
  const folder = requestFolderForWorkflow(root, ref), state = safePath(root, `.workforce/${folder.directory}/native/${stateName}`);
  const records = loadRecords(root).filter(item => item.meta.id === ref || item.meta.data.workflow_id === ref);
  const originals = new Map([state, ...records.map(item => safePath(root, item.path))].map(path => [path, readFileSync(path)]));
  return () => { for (const [path, bytes] of originals) assert.deepEqual(readFileSync(path), bytes); };
}

for (const variant of ['explicit-argv', 'named-script', 'inline-directory-enumeration'])
test(`same-content skill reinstall cannot waive an actual checker dependency on mutable receipt history: ${variant}`, async t => {
  const { root, install } = project(t), installed = await install();
  const selected = resolveNativeSkills(root, ['checking'])[0];
  const originalBytes = readFileSync(safePath(root, selected.receipt_path));
  const expected = JSON.parse(originalBytes.toString('utf8')).history.length;
  const assertion = expression => `require('node:assert/strict').equal(${expression}.history.length,${expected},'RECEIPT_HISTORY_DEPENDENCY_CHANGED')`;
  let command;
  if (variant === 'explicit-argv') command = [process.execPath, '-e',
    assertion("JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'))"), selected.receipt_path];
  else if (variant === 'named-script') {
    writeFileSync(join(root, 'inspect-skill-receipt.cjs'), assertion(`JSON.parse(require('node:fs').readFileSync(${JSON.stringify(selected.receipt_path)},'utf8'))`));
    command = [process.execPath, 'inspect-skill-receipt.cjs'];
  } else command = [process.execPath, '-e',
    "const fs=require('node:fs'), base='.workforce/capabilities'; const name=fs.readdirSync(base).find(name=>name.endsWith('.json'));" +
    assertion("JSON.parse(fs.readFileSync(base+'/'+name,'utf8'))")];
  const opened = requests.openNativeRequest(root, { requirement: 'Preserve the exact observed receipt-history length and create product.txt.', context: [] });
  const planned = requests.planNativeRequest(root, opened.request_ref, { summary: 'Save one product and check the separately observed receipt history.',
    requirements: ['The receipt-history count equals its exact observed value.'], design: 'A Node assertion reads its explicit receipt argument.',
    outputs: ['product.txt'], role_skills: { 'WF.FnD': ['checking'] },
    checks: [{ title: 'Actual ordinary receipt dependency', level: 'acceptance', command }] });
  for (const role of ['WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
    const job = requests.nextNativeAssignment(root, opened.request_ref); assert.equal(job.agentName, role);
    if (role === 'WF.FnD') writeFileSync(join(root, 'product.txt'), 'A verified fixture product.\n');
    callback(root, planned, job);
  }
  assert.equal((await requests.runNativeChecks(root, opened.request_ref)).checks[0].result.exit_code, 0);
  const closed = requests.finishNativeRequest(root, opened.request_ref); assert.equal(closed.accepted, true);
  const assertHistory = retainedHistory(root, opened.request_ref);
  controlWorkspaceSkillComponent(root, installed.components[0].id, 'disable');
  await install();
  const currentBytes = readFileSync(safePath(root, selected.receipt_path));
  assert.notEqual(hash(currentBytes), hash(originalBytes), 'The actual mutable receipt changed; do not claim its old raw SHA is current');
  assert.equal(readFileSync(join(root, selected.skill_path), 'utf8').includes('Inspect concrete outcomes.'), true);
  const actual = await runCommand({ cwd: root, command });
  assert.notEqual(actual.exit_code, 0, 'The real original checker now observes different facts');
  assert.match(actual.stderr, /RECEIPT_HISTORY_DEPENDENCY_CHANGED/);
  const current = requests.getNativeRequest(root, opened.request_ref);
  assert.equal(current.accepted, false, 'Equivalent guidance cannot waive a separately checked ordinary raw dependency');
  assert.equal(current.historical_status, 'accepted');
  assertHistory();
});

test('same-content skill reinstall cannot keep an explicit receipt-history professional report current', async t => {
  const { root, install } = project(t), installed = await install();
  const selected = resolveNativeSkills(root, ['checking'])[0];
  const originalBytes = readFileSync(safePath(root, selected.receipt_path));
  const count = JSON.parse(originalBytes.toString('utf8')).history.length;
  const opened = roles.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Report the exact current selected receipt-history length.',
    context: [selected.receipt_path], skills: ['checking'], outputs: ['review.md'] });
  const input = { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true,
      agentName: 'WF.Reviewer', status: 'returned' }, raw_result: JSON.stringify({ ...professional,
        report_artifacts: [{ path: 'review.md', content: `# Receipt inspection\n\nThe observed history has ${count} entries.\n` }] }) };
  const closed = roles.recordNativeRoleResult(root, input); assert.equal(closed.completion, 'role-completed');
  const reportBytes = readFileSync(safePath(root, closed.report_path));
  const productBytes = readFileSync(join(root, 'review.md'));
  const assertHistory = retainedHistory(root, opened.request_ref, 'role-job.json');
  controlWorkspaceSkillComponent(root, installed.components[0].id, 'disable'); await install();
  assert.notEqual(hash(readFileSync(safePath(root, selected.receipt_path))), hash(originalBytes));
  assert.equal(roles.getNativeRoleJob(root, opened.request_ref).completion, 'incomplete', 'An explicitly inspected raw receipt is an ordinary dependency');
  assert.deepEqual(readFileSync(safePath(root, closed.report_path)), reportBytes);
  assert.deepEqual(readFileSync(join(root, 'review.md')), productBytes);
  assertHistory();
});

test('undecodable or NUL-containing committed scripts conservatively retain raw receipt dependency', async t => {
  const { root, install } = project(t); await install();
  const contexts = resolveNativeSkills(root, ['checking']), expected = [contexts[0].receipt_path];
  writeFileSync(join(root, 'utf16-receipt.ps1'), Buffer.concat([Buffer.from([0xff, 0xfe]),
    Buffer.from("Get-ChildItem '.workforce/capabilities'\n", 'utf16le')]));
  writeFileSync(join(root, 'invalid-utf8.ps1'), Buffer.from([0xff, 0x61, 0x62]));
  writeFileSync(join(root, 'nul-script.ps1'), Buffer.from('Write\0Output'));
  for (const script of ['utf16-receipt.ps1', 'invalid-utf8.ps1', 'nul-script.ps1'])
    assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], ['pwsh', '-File', script]), expected);
  writeFileSync(join(root, 'ordinary.ps1'), "Write-Output 'ordinary product check'\n");
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], ['pwsh', '-File', 'ordinary.ps1']), []);
  assert.deepEqual(nativeSkillReceiptDependencies(root, [], [], ['pwsh', '-File', 'utf16-receipt.ps1']), []);
});

test('a Linux-style current native Node image outside the workspace is not an unknown receipt-reading script', async t => {
  const { root, install } = project(t); await install();
  const contexts = resolveNativeSkills(root, ['checking']), expected = [contexts[0].receipt_path];
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'wf-linux-native-runtime-'));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const executable = join(runtimeRoot, 'node');
  const image = Buffer.alloc(64); image.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]); image.writeUInt16LE(2, 16);
  writeFileSync(executable, image);
  const actualRuntime = process.execPath;
  try {
    // The current executable is host state, never model input. This synchronous
    // fixture reproduces Linux's extensionless external process.execPath on Windows.
    process.execPath = executable;
    assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [executable, '-e', 'process.exit(0)']), []);
    assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [executable, '-e', 'process.exit(0)', contexts[0].receipt_path]), expected,
      'Separating the runtime must preserve explicit ordinary receipt arguments');
    writeFileSync(join(root, 'node'), `require('node:fs').readFileSync(${JSON.stringify(contexts[0].receipt_path)})`);
    assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [executable, 'node']), expected,
      'An extensionless workspace checker named node is still inspected');
    writeFileSync(executable, '#!/bin/sh\necho unknown wrapper\n');
    assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [executable, '-e', 'process.exit(0)']), expected,
      'An unrecognized wrapper cannot gain a native-runtime exemption from its pathname alone');
  } finally { process.execPath = actualRuntime; }
});

test('host-declared Linux Node, GCC and Python native images stay separate from workspace scripts and receipt inputs', async t => {
  const { root, install } = project(t); await install();
  const contexts = resolveNativeSkills(root, ['checking']), expected = [contexts[0].receipt_path];
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'wf-linux-declared-programs-'));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const image = Buffer.alloc(64); image.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]); image.writeUInt16LE(2, 16);
  const executables = ['node', 'gcc', 'python'].map(name => join(runtimeRoot, name));
  for (const path of executables) writeFileSync(path, image);
  writeFileSync(join(root, 'verify.py'), "print('ordinary checker')\n");
  const arguments_ = [executables[0], '-e', 'process.exit(0)', executables[1], '-std=c11', 'hello.c', executables[2], 'verify.py'];
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], arguments_, executables), []);
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [...arguments_, contexts[0].receipt_path], executables), expected);
  writeFileSync(join(root, 'node'), image);
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [executables[0], join(root, 'node')], [...executables, join(root, 'node')]), expected,
    'Even an ELF-looking workspace checker cannot be excluded as host infrastructure');
  writeFileSync(executables[2], '#!/usr/bin/env python\nprint(1)\n');
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], arguments_, executables), expected,
    'An unknown outside wrapper is still conservative even when it is a declared program');
});

test('valid extensionless checker filenames retain ordinary receipt dependencies without an alphabet whitelist', async t => {
  const { root, install } = project(t); await install();
  const contexts = resolveNativeSkills(root, ['checking']), expected = [contexts[0].receipt_path];
  for (const name of ['history~check', 'history@check', 'history[check]', 'history(check)', 'history+check', '-history-check']) {
    writeFileSync(join(root, name), `readFileSync(${JSON.stringify(contexts[0].receipt_path)});`);
    for (const path of [name, join(root, name)])
      assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [process.execPath, ...(path.startsWith('-') ? ['--', path] : [path])]), expected, path);
  }
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [process.execPath, '-e', '1 + 1']), []);
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [], [process.execPath, '-e', 'const ok = true;\nif (ok) {}']), [],
    'A missing inline-expression pathname is not an unknown committed script.');
});

test('real short-root aliases never exempt a canonical workspace binary while allowing an outside native runtime', async t => {
  if (process.platform !== 'win32') return t.skip('Requires the native Windows short-path API.');
  const { root, install } = project(t); await install();
  const canonical = realpathSync.native(root);
  const script = String.raw`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class WFDependencyShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetShortPathName(string path, StringBuilder value, uint length); }'; $value=New-Object System.Text.StringBuilder 32768; $length=[WFDependencyShortPath]::GetShortPathName($env:WF_DEPENDENCY_SHORT_ROOT,$value,32768); if($length -eq 0 -or $length -ge 32768){exit 7}; $value.ToString()`;
  const queried = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, WF_DEPENDENCY_SHORT_ROOT: canonical } });
  const alias = queried.stdout?.trim();
  if (queried.status !== 0 || !alias?.includes('~') || alias.toLowerCase() === canonical.toLowerCase())
    return t.skip('No distinct NTFS 8.3 spelling is available; volume settings were not changed.');
  assert.equal(realpathSync.native(alias), canonical);
  t.diagnostic(JSON.stringify({ short_root: alias, canonical_root: canonical, volume_settings_changed: false }));
  const contexts = resolveNativeSkills(alias, ['checking']), expected = [contexts[0].receipt_path];
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'wf-dependency-outside-runtime-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const image = Buffer.alloc(64); image.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]); image.writeUInt16LE(2, 16);
  const runtime = join(outside, 'node'), workspaceImage = join(canonical, 'workspace-node');
  writeFileSync(runtime, image); writeFileSync(workspaceImage, image);
  assert.deepEqual(nativeSkillReceiptDependencies(alias, contexts, [], [runtime, '-e', 'process.exit(0)'], [runtime]), []);
  assert.deepEqual(nativeSkillReceiptDependencies(alias, contexts, [], [runtime, workspaceImage], [runtime, workspaceImage]), expected,
    'Canonical spelling inside the same physical workspace cannot gain an external-native-image exemption.');
});
