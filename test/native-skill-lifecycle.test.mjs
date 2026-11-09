import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initialize, hash, requestFolderForWorkflow, loadRecords } from '../dist/storage.js';
import * as materializer from '../dist/workspace-skill-components.js';
import * as skillContext from '../dist/native-skill-context.js';
import * as requests from '../dist/native-request.js';
import * as roles from '../dist/native-role-job.js';
const { installWorkspaceSkillComponents, controlWorkspaceSkillComponent, readWorkspaceSkillReceiptSnapshot } = materializer;
const { resolveNativeSkills, assertNativeSkillsCurrent, nativeSkillInputsMatch, nativeSkillPins, nativeSkillReceiptDependencies } = skillContext;

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'wf-skill-lifecycle-test-')), root = join(base, 'project'); mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-LIFECYCLE' });
  const files = new Map([['LICENSE', 'MIT License\n'], ['skills/guide/SKILL.md',
    '---\nname: guide\ndescription: Scoped professional guidance\n---\nRead references/check.md.\n'],
    ['skills/guide/references/check.md', '# Check\nPreserve unrelated work.\n']]);
  const approval = { approved: true, repository: 'https://github.com/example/approved-guidance', commit: 'a'.repeat(40),
    license_path: 'LICENSE', skills: [{ source_path: 'skills/guide', target_name: 'guide',
      files: ['skills/guide/SKILL.md', 'skills/guide/references/check.md'] }] };
  const install = () => installWorkspaceSkillComponents(root, approval, async input =>
    ({ ...input, kind: 'file', complete: true, content: files.get(input.path) }));
  return { root, base, files, approval, install };
}
const pass = { summary: 'Observed scoped unit fixture work.', verdict: 'pass', findings: [] };
const changed = error => error.code === 'SELECTED_SKILL_CHANGED';
function raw(root, path) { return hash(readFileSync(join(root, path))); }
function snapshot(root, folders) {
  const files = {};
  function walk(path) { const info = lstatSync(path); if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    else if (info.isFile()) files[relative(root, path).replaceAll('\\', '/')] = hash(readFileSync(path)); }
  for (const folder of folders) walk(join(root, folder));
  return files;
}
function statePath(root, ref, name) { return join(root, '.workforce', requestFolderForWorkflow(root, ref).directory, 'native', name); }
async function closeProducts(f, legacy = false) {
  const installed = await f.install(), contexts = resolveNativeSkills(f.root, ['guide']);
  const software = requests.openNativeRequest(f.root, { requirement: 'Create checked text.' });
  const marker = join(f.base, 'checks-run.txt');
  requests.planNativeRequest(f.root, software.request_ref, { summary: 'A checked text product', requirements: ['hello'], design: 'Plain text',
    role_skills: { 'WF.Reviewer': ['guide'] }, outputs: ['product/product.txt'], checks: [{ title: 'Actual Node check', level: 'acceptance',
      command: [process.execPath, '-e', `const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('product/product.txt','utf8'),'hello');fs.appendFileSync(${JSON.stringify(marker)},'check\\n')`] }] });
  for (let index = 0; index < 3; index++) {
    const job = requests.nextNativeAssignment(f.root, software.request_ref);
    if (index === 0) { mkdirSync(join(f.root, 'product')); writeFileSync(join(f.root, 'product/product.txt'), 'hello'); }
    requests.recordNativeResult(f.root, { request_ref: software.request_ref, assignment_ref: job.assignment_ref,
      invocation: { host_call_id: randomUUID(), agentName: job.agentName, native_agent_name: `${job.agentName} Worker`,
        transport: 'vscode-native', tool: 'runSubagent', invoked: true, status: 'returned' }, raw_result: JSON.stringify(pass) });
  }
  await requests.runNativeChecks(f.root, software.request_ref); assert.equal(requests.finishNativeRequest(f.root, software.request_ref).accepted, true);
  const direct = roles.openNativeRoleJob(f.root, { role: 'WF.P-RES', requirement: 'Report on existing product.',
    context: ['product/product.txt'], skills: ['guide'], outputs: ['reports/map.md'] });
  roles.recordNativeRoleResult(f.root, { request_ref: direct.request_ref, assignment_ref: direct.assignment_ref,
    invocation: { host_call_id: randomUUID(), agentName: 'WF.P-RES', native_agent_name: 'WF.P-RES Worker',
      transport: 'vscode-native', tool: 'runSubagent', invoked: true, status: 'returned' },
    raw_result: JSON.stringify({ ...pass, report_artifacts: [{ path: 'reports/map.md', content: '# Map\nExisting product only.\n' }] }) });
  if (legacy) {
    // Explicit serialized v1 compatibility fixture: retain genuine original raw
    // receipt hashes, with no semantic approval field. No real history is edited.
    const path = statePath(f.root, software.request_ref, 'execution.json'), state = JSON.parse(readFileSync(path));
    for (const values of Object.values(state.skill_contexts)) for (const context of values) delete context.approval_sha256;
    state.preservation_baseline[contexts[0].receipt_path] = contexts[0].receipt_sha256;
    for (const job of state.assignments.filter(job => job.agentName !== 'WF.FnD')) job.baseline[contexts[0].receipt_path] = contexts[0].receipt_sha256;
    for (const check of state.checks) check.baseline[contexts[0].receipt_path] = contexts[0].receipt_sha256;
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
    const rolePath = statePath(f.root, direct.request_ref, 'role-job.json'), role = JSON.parse(readFileSync(rolePath));
    role.skill_contexts.forEach(context => delete context.approval_sha256);
    role.baseline[contexts[0].receipt_path] = contexts[0].receipt_sha256;
    writeFileSync(rolePath, JSON.stringify(role, null, 2) + '\n');
  }
  return { installed, contexts, software, direct, marker };
}

test('skill lifecycle metadata changes preserve approval while raw provenance stays truthful and ordinary inputs stay exact', async t => {
  const f = fixture(t), installed = await f.install(), selected = resolveNativeSkills(f.root, ['guide']);
  assert.match(selected[0].approval_sha256, /^[a-f0-9]{64}$/);
  assert.equal(selected[0].receipt_path in nativeSkillPins(selected), false, 'Ownership metadata is not a product file');
  controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable');
  assert.throws(() => assertNativeSkillsCurrent(f.root, selected), changed);
  await f.install();
  const restored = resolveNativeSkills(f.root, ['guide']);
  assert.notEqual(restored[0].receipt_sha256, selected[0].receipt_sha256);
  assert.equal(restored[0].approval_sha256, selected[0].approval_sha256);
  assert.doesNotThrow(() => assertNativeSkillsCurrent(f.root, selected));
  const actual = { [selected[0].receipt_path]: restored[0].receipt_sha256 }, expected = { [selected[0].receipt_path]: selected[0].receipt_sha256 };
  assert.equal(nativeSkillInputsMatch(f.root, selected, actual, expected), true);
  assert.equal(nativeSkillInputsMatch(f.root, selected, actual, expected, [selected[0].receipt_path]), false);
  assert.equal(actual[selected[0].receipt_path], raw(f.root, selected[0].receipt_path));
  assert.equal(nativeSkillInputsMatch(f.root, selected, actual, { [selected[0].receipt_path]: 'f'.repeat(64) }), false);
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy raw-bound' : 'semantic-bound'} closed software and direct role recover identical skill approval without new checks, models or history writes`, async t => {
  const f = fixture(t), closed = await closeProducts(f, legacy);
  const folders = [`.workforce/${requestFolderForWorkflow(f.root, closed.software.request_ref).directory}`,
    `.workforce/${requestFolderForWorkflow(f.root, closed.direct.request_ref).directory}`, 'product', 'reports'];
  const before = snapshot(f.root, folders), marker = readFileSync(closed.marker, 'utf8');
  assert.equal(requests.getNativeRequest(f.root, closed.software.request_ref).accepted, true);
  assert.equal(roles.getNativeRoleJob(f.root, closed.direct.request_ref).completion, 'role-completed');
  controlWorkspaceSkillComponent(f.root, closed.installed.components[0].id, 'disable');
  assert.equal(requests.getNativeRequest(f.root, closed.software.request_ref).accepted, false);
  assert.equal(roles.getNativeRoleJob(f.root, closed.direct.request_ref).completion, 'incomplete');
  await f.install();
  const current = requests.getNativeRequest(f.root, closed.software.request_ref), direct = roles.getNativeRoleJob(f.root, closed.direct.request_ref);
  assert.equal(current.accepted, true); assert.equal(current.historical_status, 'accepted');
  assert.equal(direct.completion, 'role-completed');
  assert.deepEqual(snapshot(f.root, folders), before, 'Restoration neither rewrites closed state/records nor edits products');
  assert.equal(readFileSync(closed.marker, 'utf8'), marker, 'No checker was rerun');
  assert.equal(current.assignments.length, 3, 'No additional role was dispatched');
  assert.notEqual(raw(f.root, closed.contexts[0].receipt_path), closed.contexts[0].receipt_sha256);
  if (legacy) {
    assert.equal(current.checks[0].baseline[closed.contexts[0].receipt_path], closed.contexts[0].receipt_sha256,
      'The original real raw SHA remains in old evidence, without replacement by current bytes');
    assert.equal(direct.baseline[closed.contexts[0].receipt_path], closed.contexts[0].receipt_sha256);
  }
});

test('legacy approval bridge requires the exact original archive and rejects corrupted or missing original evidence', async t => {
  const f = fixture(t), installed = await f.install(), selected = resolveNativeSkills(f.root, ['guide']);
  delete selected[0].approval_sha256;
  controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable'); await f.install();
  assert.doesNotThrow(() => assertNativeSkillsCurrent(f.root, selected));
  const archived = join(f.root, '.workforce/capabilities/receipt-snapshots', installed.components[0].id, selected[0].receipt_sha256, 'receipt.json');
  const original = readFileSync(archived); writeFileSync(archived, '{}\n');
  assert.throws(() => assertNativeSkillsCurrent(f.root, selected), changed);
  writeFileSync(archived, original); rmSync(archived);
  assert.equal(readWorkspaceSkillReceiptSnapshot(f.root, installed.components[0].id, selected[0].receipt_sha256), undefined);
  assert.throws(() => assertNativeSkillsCurrent(f.root, selected), changed);
});

test('semantic approval rejects changed license, forged descriptors and asset edits even when provenance is available', async t => {
  const f = fixture(t), installed = await f.install(), selected = resolveNativeSkills(f.root, ['guide']);
  controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable'); await f.install();
  const receiptPath = join(f.root, selected[0].receipt_path), bytes = readFileSync(receiptPath), receipt = JSON.parse(bytes);
  receipt.license.text = 'Changed license approval\n'; receipt.license.bytes = Buffer.byteLength(receipt.license.text); receipt.license.sha256 = hash(receipt.license.text);
  const { integrity: ignored, ...body } = receipt; receipt.integrity = hash(JSON.stringify(body));
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  assert.throws(() => assertNativeSkillsCurrent(f.root, selected), changed);
  writeFileSync(receiptPath, bytes);
  for (const mutation of [copy => { copy[0].files[0].sha256 = 'f'.repeat(64); }, copy => { copy[0].files = []; },
    copy => { copy[0].source.commit = 'b'.repeat(40); }, copy => { copy[0].receipt_path += '.other'; },
    copy => { copy[0].receipt_sha256 = 'f'.repeat(64); }]) {
    const forged = structuredClone(selected); mutation(forged);
    assert.throws(() => assertNativeSkillsCurrent(f.root, forged), changed);
  }
  writeFileSync(join(f.root, selected[0].files[0].path), 'User changed this selected asset.\n');
  assert.throws(() => assertNativeSkillsCurrent(f.root, selected), changed);
});

test('a disabled selected component cannot issue a queued assignment; identical restoration needs no new plan or invented identity', async t => {
  const f = fixture(t), installed = await f.install();
  const opened = requests.openNativeRequest(f.root, { requirement: 'Create a scoped product.' });
  requests.planNativeRequest(f.root, opened.request_ref, { summary: 'Text', requirements: ['hello'], design: 'Text',
    role_skills: { 'WF.FnD': ['guide'] }, outputs: ['product.txt'], checks: [{ title: 'Check', level: 'acceptance', command: [process.execPath, '--version'] }] });
  const records = loadRecords(f.root).length;
  controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable');
  assert.throws(() => requests.nextNativeAssignment(f.root, opened.request_ref), changed);
  assert.equal(requests.getNativeRequest(f.root, opened.request_ref).assignments.length, 0);
  assert.equal(loadRecords(f.root).length, records, 'Failure does not create another request or report');
  await f.install();
  assert.equal(requests.nextNativeAssignment(f.root, opened.request_ref).agentName, 'WF.FnD');
  assert.equal(loadRecords(f.root).length, records, 'The same pending request and plan are retained');
});

test('bounded text dependency detection preserves raw receipt semantics for extensionless, encoded and oversized checkers', async t => {
  const f = fixture(t); await f.install();
  const selected = resolveNativeSkills(f.root, ['guide']), receipt = selected[0].receipt_path;
  mkdirSync(join(f.root, 'checks'));
  writeFileSync(join(f.root, 'checks/history'), `readFileSync(${JSON.stringify(receipt)});`);
  assert.deepEqual(nativeSkillReceiptDependencies(f.root, selected, [], [process.execPath, 'checks/history']), [receipt]);
  writeFileSync(join(f.root, 'checks/kiểm-tra'), `readFileSync(${JSON.stringify(receipt)});`);
  assert.deepEqual(nativeSkillReceiptDependencies(f.root, selected, [], [process.execPath, 'checks/kiểm-tra']), [receipt]);
  assert.deepEqual(nativeSkillReceiptDependencies(f.root, selected, [], [process.execPath, join(f.root, 'checks/kiểm-tra')]), [receipt]);
  writeFileSync(join(f.root, 'checks/encoded.ps1'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Get-Content .workforce/capabilities/*.json', 'utf16le')]));
  assert.deepEqual(nativeSkillReceiptDependencies(f.root, selected, [], ['pwsh', '-File', 'checks/encoded.ps1']), [receipt]);
  writeFileSync(join(f.root, 'checks/large.mjs'), '// ' + 'x'.repeat(1024 * 1024));
  assert.deepEqual(nativeSkillReceiptDependencies(f.root, selected, [], [process.execPath, 'checks/large.mjs']), [receipt]);
  assert.deepEqual(nativeSkillReceiptDependencies(f.root, selected, [], [process.execPath, 'checks/' + 'x'.repeat(1030) + '.mjs']), [receipt]);
  assert.deepEqual(nativeSkillReceiptDependencies(f.root, [], [], [process.execPath, 'checks/missing.mjs']), [],
    'No selected guidance means no optional dependency inspection');
});

test('a returned implementation report is retained without scoped completion when its selected skill was disabled during the call', async t => {
  const f = fixture(t), installed = await f.install();
  const opened = requests.openNativeRequest(f.root, { requirement: 'Create a scoped product.' });
  requests.planNativeRequest(f.root, opened.request_ref, { summary: 'Text', requirements: ['hello'], design: 'Text',
    role_skills: { 'WF.FnD': ['guide'] }, outputs: ['product.txt'], checks: [{ title: 'Check', level: 'acceptance', command: [process.execPath, '--version'] }] });
  const assignment = requests.nextNativeAssignment(f.root, opened.request_ref);
  writeFileSync(join(f.root, 'product.txt'), 'hello');
  controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable');
  const returned = requests.recordNativeResult(f.root, { request_ref: opened.request_ref, assignment_ref: assignment.assignment_ref,
    invocation: { host_call_id: randomUUID(), agentName: assignment.agentName, native_agent_name: 'WF.FnD Worker',
      transport: 'vscode-native', tool: 'runSubagent', invoked: true, status: 'returned' }, raw_result: JSON.stringify(pass) });
  assert.equal(returned.assignments[0].state, 'uncertain');
  assert.equal(returned.assignments[0].report.summary, pass.summary);
  assert.equal(returned.assignments[0].invocation.status, 'returned');
  assert.equal(returned.accepted, false);
  assert.equal(returned.checks[0].state, 'pending');
  assert.equal(readFileSync(join(f.root, 'product.txt'), 'utf8'), 'hello');
});
