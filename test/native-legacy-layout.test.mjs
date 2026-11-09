import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runtime from '../dist/index.js';

const aliases = ['.neomind', '.verythinker', '.taskforces'];
function project(t, alias) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-legacy-'));
  runtime.initialize(root, { project_id: 'WF-LEGACY', execution_engine: 'vscode-lm' });
  renameSync(join(root, '.workforce'), join(root, alias));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = runtime.createRecord(root, { type: 'knowledge', title: 'Historical flat report',
    body: '# Historical report\n\nRetain these exact bytes and identity.\n',
    data: { kind: 'manager-workflow', execution_mode: 'native-copilot', routing_required: false } });
  const historyPath = join(root, alias, 'records', `${history.meta.id}.md`);
  assert.equal(existsSync(historyPath), true, 'Ordinary historical workflows retain the flat physical layout');
  mkdirSync(join(root, alias, 'native'), { recursive: true });
  const receiptPath = join(root, alias, 'native', 'historical-signed-receipt.json');
  writeFileSync(receiptPath, '{"historical":"retain without migration","signature":"opaque retained bytes"}\n');
  const pinned = new Map([historyPath, receiptPath].map(path => [path, readFileSync(path)]));
  return { root, history, assertHistory() {
    for (const [path, bytes] of pinned) assert.deepEqual(readFileSync(path), bytes);
    assert.equal(runtime.getRecord(root, history.meta.id).meta.id, history.meta.id);
    assert.equal(existsSync(join(root, '.workforce')), false, 'No second storage root is created');
    assert.deepEqual(aliases.filter(name => existsSync(join(root, name))), [alias]);
  } };
}
function callback(root, state, job) {
  return runtime.recordNativeResult(root, { request_ref: state.request_ref, assignment_ref: job.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true,
      agentName: job.agentName, status: 'returned' },
    raw_result: JSON.stringify({ summary: `Independent ${job.agentName} scope completed.`, verdict: 'pass', findings: [] }) });
}

for (const alias of aliases) {
  test(`native full request on ${alias} groups only new owned records and reaches actual checked acceptance`, async t => {
    const fixture = project(t, alias), { root } = fixture;
    const opened = runtime.openNativeRequest(root, { requirement: 'Create hello.txt with hello and verify its actual bytes.', context: [] });
    assert.equal(opened.request_key, 'WF-R0001');
    const planned = runtime.planNativeRequest(root, opened.request_ref, {
      summary: 'Create and verify one UTF-8 product.', requirements: ['hello.txt contains exactly hello followed by a newline.'],
      design: 'One text product and an independent Node assertion.', outputs: ['hello.txt'],
      checks: [{ title: 'Assert actual product bytes', level: 'acceptance', command: [process.execPath, '-e',
        "require('node:assert/strict').equal(require('node:fs').readFileSync('hello.txt','utf8'),'hello\\n')"] }] });
    const actors = [];
    for (const role of ['WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
      const job = runtime.nextNativeAssignment(root, opened.request_ref);
      assert.equal(job.agentName, role); actors.push(job.assignment_ref);
      if (role === 'WF.FnD') writeFileSync(join(root, 'hello.txt'), 'hello\n');
      callback(root, planned, job);
    }
    assert.equal(new Set(actors).size, 3, 'Producer, Reviewer and Tester have independent owned assignments');
    const checked = await runtime.runNativeChecks(root, opened.request_ref);
    assert.equal(checked.checks[0].result.exit_code, 0);
    const finished = runtime.finishNativeRequest(root, opened.request_ref);
    assert.equal(finished.accepted, true); assert.equal(finished.status, 'accepted');
    const folder = runtime.requestFolderForWorkflow(root, opened.request_ref);
    assert.equal(folder.display_id, opened.request_key);
    assert.equal(existsSync(join(root, alias, folder.directory, 'native', 'execution.json')), true);
    for (const record of runtime.loadRecords(root).filter(item => item.meta.id === opened.request_ref || item.meta.data.workflow_id === opened.request_ref))
      assert.ok(record.path.includes(`/requests/${folder.display_id}--`), `New owned ${record.meta.type} is grouped: ${record.path}`);
    fixture.assertHistory();
  });

  test(`native direct report on ${alias} publishes its scoped output without moving flat history`, t => {
    const fixture = project(t, alias), { root } = fixture;
    const opened = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Save professional requirements.md.', outputs: ['requirements.md'] });
    const input = { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref,
      invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true,
        agentName: 'WF.SWSD', status: 'returned' }, raw_result: JSON.stringify({ summary: 'Explicit requirements recorded.',
        verdict: 'pass', findings: [], report_artifacts: [{ path: 'requirements.md', content: '# Requirements\n\nThe product shall say hello.\n' }] }) };
    const finished = runtime.recordNativeRoleResult(root, input);
    assert.equal(finished.completion, 'role-completed'); assert.equal(finished.accepted, false, 'Direct role completion does not approve a full workflow');
    assert.equal(readFileSync(join(root, 'requirements.md'), 'utf8'), '# Requirements\n\nThe product shall say hello.\n');
    const reportBytes = readFileSync(runtime.safePath(root, finished.report_path));
    assert.equal(runtime.recordNativeRoleResult(root, input).completion, 'role-completed');
    assert.deepEqual(readFileSync(runtime.safePath(root, finished.report_path)), reportBytes);
    assert.equal(runtime.requestFolderForWorkflow(root, opened.request_ref).display_id, opened.request_key);
    fixture.assertHistory();
  });

  test(`legacy ${alias} ordinary and mismatched native-looking records remain flat`, t => {
    const fixture = project(t, alias), { root } = fixture;
    for (const data of [{ kind: 'workforce-request', process_contract: 'historical/v1', transport: 'vscode-native' },
      { kind: 'workforce-request', process_contract: 'vscode-native/v1', transport: 'opencode' },
      { kind: 'ordinary-note' }, { workflow_id: fixture.history.meta.id }]) {
      const saved = runtime.createRecord(root, { type: 'knowledge', title: 'Keep historical layout', data });
      assert.equal(existsSync(join(root, alias, 'records', `${saved.meta.id}.md`)), true);
      assert.equal(runtime.requestFolderForWorkflow(root, saved.meta.id), undefined);
    }
    fixture.assertHistory();
  });
}
