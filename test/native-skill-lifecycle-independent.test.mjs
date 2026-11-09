// Independent negative controls for lifecycle-equivalent guidance. These inspect
// real local receipts/check results without invoking any model or remote source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
