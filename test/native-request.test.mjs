import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  finishNativeRequest, getNativeRequest, interruptNativeRequest, nextNativeAssignment, openNativeRequest,
  planNativeRequest, recordNativeDispatchFailure, recordNativeResult, runNativeChecks,
  resumeNativeRequest,
} from '../dist/native-request.js';
import { createRecord, getRecord, initialize, loadRecords, requestFolderForWorkflow } from '../dist/storage.js';
import { findRequestExperiences } from '../dist/request-experience.js';

// These tests supply host outcomes at the domain seam. They are not desktop
// acceptance evidence. Planned checker commands execute actual local processes.
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-native-request-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-NATIVE' });
  return root;
}

test('editor absolute paths, local file URIs and workspace context are normalized before opening and planning', t => {
  const root = project(t);
  write(root, 'README.md', '# Context\n');
  const opened = openNativeRequest(root, { requirement: 'Create a module using the attached project context.',
    context: [root, join(root, 'README.md'), pathToFileURL(join(root, 'README.md')).href, 'README.md'] });
  assert.deepEqual(opened.context, ['.', 'README.md'], 'A workspace-root attachment retains its recursive source meaning');
  const planned = planNativeRequest(root, opened.request_ref, {
    summary: 'Create the requested module', requirements: ['Export add'], design: 'Pure function',
    outputs: [join(root, 'add.mjs'), pathToFileURL(join(root, 'add.test.mjs')).href, 'add.mjs'],
    checks: [{ title: 'Tests', command: ['node', '--test', 'add.test.mjs'], level: 'unit' },
      { title: 'Tests', command: ['node', '--test'], level: 'acceptance' }],
  });
  assert.deepEqual(planned.plan.outputs, ['add.mjs', 'add.test.mjs']);
  assert.equal(planned.checks.length, 2);
  assert.notEqual(planned.checks[0].record_id, planned.checks[1].record_id, 'Display labels are not check identities');
  assert.equal(planned.status, 'working');
});

test('normalization refuses outside-workspace paths and private output paths without creating a request', t => {
  const root = project(t), before = loadRecords(root).length;
  assert.throws(() => openNativeRequest(root, { requirement: 'Use context', context: [join(root, '..', 'outside.txt')] }), /inside this workspace/);
  assert.equal(loadRecords(root).length, before);
  const opened = openNativeRequest(root, { requirement: 'Create product' });
  const plan = output => ({ summary: 'A plan', requirements: ['Product'], design: 'Simple', outputs: [output],
    checks: [{ title: 'Check', command: ['node', '--version'], level: 'acceptance' }] });
  assert.throws(() => planNativeRequest(root, opened.request_ref, plan(join(root, '..', 'outside.txt'))), /inside this workspace/);
  assert.throws(() => planNativeRequest(root, opened.request_ref, plan(join(root, '.workforce', 'state.json'))), /outside managed/);
  assert.throws(() => planNativeRequest(root, opened.request_ref, plan(join(root, '.WORKFORCE', 'state.json'))), /outside managed/);
  assert.equal(getNativeRequest(root, opened.request_ref).status, 'planning');
});

function write(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function request(root, suffix = 'one', checkerBody, context = [], laterChecks = []) {
  const output = `product-${suffix}.txt`, checker = `verify-${suffix}.cjs`;
  write(root, checker, checkerBody ?? `const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
assert.equal(readFileSync(${JSON.stringify(output)}, 'utf8'), 'hello\\n');
console.log('NATIVE_REQUEST_ACTUAL_CHECK_PASSED');
`);
  const opened = openNativeRequest(root, { requirement: `Write a verified hello product (${suffix}).`, title: `Hello ${suffix}`, context });
  const plan = {
    summary: 'Write the scoped hello product and validate its exact contents.',
    requirements: ['The product contains hello followed by a newline.'],
    design: 'Use a UTF-8 text file and an existing Node assertion check.',
    outputs: [output],
    checks: [{ title: `Check hello ${suffix}`, command: [process.execPath, `./${checker}`], level: 'acceptance' }, ...laterChecks],
  };
  const planned = planNativeRequest(root, opened.request_ref, plan);
  return { ...planned, output, checker, plan };
}

const passingReport = { summary: 'Observed the assigned work against its requirements.', verdict: 'pass', findings: [] };
function callback(requestRef, assignment, options = {}) {
  return {
    request_ref: requestRef,
    assignment_ref: assignment.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: assignment.agentName,
      status: 'returned', native_context_id: null, ...options.invocation },
    raw_result: { content: [{ value: JSON.stringify(options.report ?? passingReport) }] },
  };
}

function completeRoles(root, saved, options = {}) {
  const callbacks = [];
  for (const role of ['WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
    const assignment = nextNativeAssignment(root, saved.request_ref);
    assert.equal(assignment.agentName, role);
    if (role === 'WF.FnD') write(root, saved.output, options.product ?? 'hello\n');
    const input = callback(saved.request_ref, assignment);
    recordNativeResult(root, input);
    callbacks.push(input);
  }
  assert.equal(nextNativeAssignment(root, saved.request_ref), undefined);
  return callbacks;
}

function statePath(root, ref) {
  return join(root, '.workforce', requestFolderForWorkflow(root, ref).directory, 'native', 'execution.json');
}

test('the host owns preservation hashes and each handoff distinguishes its role verdict from later workflow work', async t => {
  const root = project(t);
  write(root, 'README.md', 'Original context\n');
  write(root, 'material/nested/existing.md', 'Existing nested context\n');
  const saved = request(root, 'preservation', undefined, ['material']);
  assert.equal(typeof saved.preservation_baseline['README.md'], 'string');
  assert.equal(typeof saved.preservation_baseline['material/nested/existing.md'], 'string');
  const job = nextNativeAssignment(root, saved.request_ref);
  assert.match(job.prompt, /later host-owned steps/);
  assert.match(job.prompt, /host captured SHA256/);
  write(root, saved.output, 'hello\n');
  recordNativeResult(root, callback(saved.request_ref, job));
  for (const role of ['WF.Reviewer', 'WF.Tester']) {
    const next = nextNativeAssignment(root, saved.request_ref);
    assert.equal(next.agentName, role);
    recordNativeResult(root, callback(saved.request_ref, next));
  }
  await runNativeChecks(root, saved.request_ref);
  write(root, 'material/nested/existing.md', 'Unrelated nested edit during execution\n');
  assert.throws(() => finishNativeRequest(root, saved.request_ref), /protected file changed/);
  assert.equal(getNativeRequest(root, saved.request_ref).accepted, false);
});

test('host continuation retains a failed role report and product while issuing a new valid scoped attempt', async t => {
  const root = project(t), saved = request(root, 'continuation');
  const first = nextNativeAssignment(root, saved.request_ref);
  write(root, saved.output, 'hello\n');
  const failed = recordNativeResult(root, callback(saved.request_ref, first, { report: {
    summary: 'Product exists; an earlier role contract incorrectly required final workflow acceptance.',
    verdict: 'findings', findings: ['Independent review has not run yet.'],
  } }));
  const prior = getRecord(root, failed.assignments[0].report_record_id);
  const priorBytes = readFileSync(join(root, prior.path));
  const resumed = resumeNativeRequest(root, saved.request_ref);
  assert.equal(resumed.request_key, saved.request_key);
  assert.equal(resumed.assignments.length, 1);
  completeRoles(root, saved);
  await runNativeChecks(root, saved.request_ref);
  const closed = finishNativeRequest(root, saved.request_ref);
  assert.equal(closed.accepted, true);
  assert.equal(closed.assignments.length, 4);
  assert.equal(closed.assignments[0].state, 'findings');
  assert.deepEqual(readFileSync(join(root, prior.path)), priorBytes);
});

test('native domain closes a real checked product only after separate owned review and Tester outcomes', async t => {
  const root = project(t);
  write(root, 'README.md', 'Original source context\n');
  const saved = request(root);
  assert.equal(saved.request_key, 'WF-R0001');
  assert.equal(saved.process_contract, 'vscode-native/v1');
  assert.equal(saved.accepted, false);
  assert.throws(() => finishNativeRequest(root, saved.request_ref), /owned implementation|independent/);
  completeRoles(root, saved);
  assert.throws(() => finishNativeRequest(root, saved.request_ref), /Actual passing checks/);

  const checked = await runNativeChecks(root, saved.request_ref);
  assert.equal(checked.checks[0].result.exit_code, 0);
  assert.match(checked.checks[0].result.stdout, /NATIVE_REQUEST_ACTUAL_CHECK_PASSED/);
  assert.equal(checked.checks[0].state, 'passed');
  assert.equal(getRecord(root, checked.checks[0].evidence_id).meta.type, 'evidence');
  assert.match(checked.checks[0].log_path, /^\.workforce\/requests\/WF-R0001--[^/]+\/native\/checks\//);
  assert.equal(checked.accepted, false, 'A successful process is evidence, not the closure decision');

  const accepted = finishNativeRequest(root, saved.request_ref);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.transport, 'vscode-native');
  assert.equal(accepted.assurance, 'observed-native-local');
  assert.equal(accepted.experience_index, 'saved');
  const history = findRequestExperiences(root, { request: 'verified hello product' });
  assert.equal(history.candidates.length, 1, 'Real acceptance automatically saves searchable experience');
  assert.equal(history.candidates[0].request_key, accepted.request_key);
  assert.deepEqual(history.candidates[0].artifact_paths, accepted.plan.outputs);
  assert.equal(history.candidates[0].usage.model_calls, 3, 'This count covers owned subagent calls, not unknown parent-model tokens');
  assert.equal(new Set(accepted.assignments.map(job => job.invocation.host_call_id)).size, 3);
  assert.ok(accepted.assignments.every(job => job.invocation.native_context_id === null));
  assert.equal(getRecord(root, accepted.task_id).meta.status, 'accepted');
  assert.equal(getRecord(root, accepted.checks[0].record_id).meta.status, 'verified');
  assert.equal(getRecord(root, accepted.checks[0].evidence_id).meta.status, 'verified');
  assert.ok(loadRecords(root).filter(record => record.meta.data.workflow_id === saved.request_ref)
    .every(record => record.path.includes('/requests/WF-R0001--')));
  const evidenceBefore = readFileSync(join(root, getRecord(root, accepted.checks[0].evidence_id).path));
  const repeated = await runNativeChecks(root, saved.request_ref);
  assert.equal(repeated.checks[0].execution_id, accepted.checks[0].execution_id);
  assert.deepEqual(readFileSync(join(root, getRecord(root, accepted.checks[0].evidence_id).path)), evidenceBefore);
  writeFileSync(join(root, '.workforce/cache/request-experience.sqlite'), 'Damaged optional search cache');
  const cacheUnavailable = finishNativeRequest(root, saved.request_ref);
  assert.equal(cacheUnavailable.accepted, true, 'A derived search-cache failure does not block verified delivery');
  assert.equal(cacheUnavailable.experience_index, 'unavailable');
  write(root, 'new-source.txt', 'New source added after independent inspection\n');
  assert.equal(getNativeRequest(root, saved.request_ref).accepted, false, 'Adding a new source file invalidates current directory evidence');
  rmSync(join(root, 'new-source.txt'));
  assert.equal(getNativeRequest(root, saved.request_ref).accepted, true);
  write(root, 'README.md', 'User changed source context after acceptance\n');
  assert.equal(getNativeRequest(root, saved.request_ref).accepted, false, 'Source-context changes invalidate current evidence as well as product/checker edits');
});

test('an external checker is pinned before independent inspection, and cannot be swapped before execution', { timeout: 60000 }, async t => {
  const root = project(t), checker = 'checks/verify.cjs';
  write(root, checker, "require('node:assert/strict').equal(require('node:fs').readFileSync('product.txt','utf8'),'hello');\n");
  const opened = openNativeRequest(root, { requirement: 'Write verified hello', context: [] });
  const planned = planNativeRequest(root, opened.request_ref, { summary: 'Write hello', requirements: ['Exact hello'], design: 'Text file', outputs: ['product.txt'],
    checks: [{ title: 'External assertion checker', level: 'acceptance', command: [process.execPath, checker] }] });
  write(root, 'product.txt', 'hello');
  recordNativeResult(root, callback(planned.request_ref, nextNativeAssignment(root, planned.request_ref)));
  for (let index = 0; index < 2; index++) {
    const job = nextNativeAssignment(root, planned.request_ref);
    const stored = getNativeRequest(root, planned.request_ref).assignments.at(-1);
    assert.equal(typeof stored.baseline[checker], 'string');
    recordNativeResult(root, callback(planned.request_ref, job));
  }
  write(root, checker, 'process.exit(0);\n');
  await assert.rejects(runNativeChecks(root, planned.request_ref), /Current independent Reviewer and Tester inspection/);
  assert.equal(getNativeRequest(root, planned.request_ref).checks[0].execution_id, undefined);
});

test('a persisted host interruption stops the next checker even without a cancellation signal', { timeout: 60000 }, async t => {
  const root = project(t), opened = openNativeRequest(root, { requirement: 'Check a scoped product' });
  const planned = planNativeRequest(root, opened.request_ref, { summary: 'Write hello', requirements: ['Exact hello'], design: 'Text file', outputs: ['product.txt'], checks: [
    { title: 'Pending first checker', level: 'unit', command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),1000)'] },
    { title: 'Must not execute after interruption', level: 'acceptance', command: [process.execPath, '-e', "require('node:fs').writeFileSync('must-not-run.txt','unexpected')"] },
  ] });
  write(root, 'product.txt', 'hello');
  for (let index = 0; index < 3; index++) recordNativeResult(root, callback(planned.request_ref, nextNativeAssignment(root, planned.request_ref)));
  const pending = runNativeChecks(root, planned.request_ref);
  interruptNativeRequest(root, planned.request_ref, { code: 'USER_CANCELLED', category: 'cancellation' });
  const stopped = await pending;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.checks[1].execution_id, undefined);
  assert.equal(existsSync(join(root, 'must-not-run.txt')), false);
  assert.equal(stopped.accepted, false);
});

test('two requests retain separate assignments and reject a callback addressed to the other request', t => {
  const root = project(t), first = request(root, 'first'), second = request(root, 'second');
  const firstJob = nextNativeAssignment(root, first.request_ref);
  const secondJob = nextNativeAssignment(root, second.request_ref);
  assert.equal(second.request_key, 'WF-R0002');
  assert.notEqual(firstJob.assignment_ref, secondJob.assignment_ref);
  const firstBefore = readFileSync(statePath(root, first.request_ref));
  const secondBefore = readFileSync(statePath(root, second.request_ref));
  const mismatched = callback(second.request_ref, firstJob);
  assert.throws(() => recordNativeResult(root, mismatched), /does not belong to this request/);
  assert.deepEqual(readFileSync(statePath(root, first.request_ref)), firstBefore);
  assert.deepEqual(readFileSync(statePath(root, second.request_ref)), secondBefore);
  assert.equal(getNativeRequest(root, first.request_ref).assignments[0].state, 'issued');
  assert.equal(getNativeRequest(root, second.request_ref).assignments[0].state, 'issued');
});

test('full request callbacks validate the actual hidden profile without changing professional role identity', t => {
  const root = project(t), saved = request(root), job = nextNativeAssignment(root, saved.request_ref);
  write(root, saved.output, 'hello\n');
  const before = readFileSync(statePath(root, saved.request_ref));
  assert.throws(() => recordNativeResult(root, callback(saved.request_ref, job,
    { invocation: { native_agent_name: 'WF.Reviewer Worker' } })), /worker profile does not match/);
  assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), before);
  const current = recordNativeResult(root, callback(saved.request_ref, job,
    { invocation: { native_agent_name: 'WF.FnD Worker' } }));
  assert.equal(current.assignments[0].agentName, 'WF.FnD');
  assert.equal(current.assignments[0].invocation.native_agent_name, 'WF.FnD Worker');
});

test('an identical callback replays without writes and a conflicting late callback preserves the original result', t => {
  const root = project(t), saved = request(root), job = nextNativeAssignment(root, saved.request_ref);
  write(root, saved.output, 'hello\n');
  const input = callback(saved.request_ref, job);
  const first = recordNativeResult(root, input);
  const before = readFileSync(statePath(root, saved.request_ref));
  const count = loadRecords(root).length;
  assert.deepEqual(recordNativeResult(root, input), first);
  assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), before);
  assert.equal(loadRecords(root).length, count);
  assert.throws(() => recordNativeResult(root, { ...input, raw_result: JSON.stringify({ ...passingReport, summary: 'Conflicting late report' }) }), /different retained outcome/);
  assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), before);
});

test('independence requires actual separate owned call references rather than role claims in model text', t => {
  const root = project(t), saved = request(root), implementer = nextNativeAssignment(root, saved.request_ref);
  write(root, saved.output, 'hello\n');
  const implementation = callback(saved.request_ref, implementer, { report: { ...passingReport, role: 'WF.Tester', accepted: true } });
  recordNativeResult(root, implementation);
  assert.equal(getNativeRequest(root, saved.request_ref).assignments[0].agentName, 'WF.FnD');
  assert.equal(getNativeRequest(root, saved.request_ref).accepted, false);
  const reviewer = nextNativeAssignment(root, saved.request_ref);
  const before = readFileSync(statePath(root, saved.request_ref));
  assert.throws(() => recordNativeResult(root, callback(saved.request_ref, reviewer, {
    invocation: { host_call_id: implementation.invocation.host_call_id },
  })), /separate actual owned native invocations/);
  assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), before);
  assert.throws(() => recordNativeResult(root, callback(saved.request_ref, reviewer, { invocation: { invoked: false } })), /actual host-owned native invocation/);
  assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), before);
});

test('a failed process retains its actual output and prevents acceptance even when all roles said pass', async t => {
  const root = project(t), saved = request(root, 'failure', "console.error('ACTUAL_CHECK_REJECTED'); process.exit(7);\n", [], [
    { title: 'Dependent command must not run after a failed build', level: 'acceptance',
      command: [process.execPath, '-e', "require('node:fs').writeFileSync('must-not-run.txt','stale binary executed')"] },
  ]);
  completeRoles(root, saved);
  const checked = await runNativeChecks(root, saved.request_ref);
  assert.equal(checked.status, 'findings');
  assert.equal(checked.checks[0].result.exit_code, 7);
  assert.match(checked.checks[0].result.stderr, /ACTUAL_CHECK_REJECTED/);
  assert.equal(checked.checks[0].state, 'failed');
  assert.equal(checked.accepted, false);
  assert.equal(checked.checks[1].state, 'pending');
  assert.equal(checked.checks[1].execution_id, undefined);
  assert.equal(existsSync(join(root, 'must-not-run.txt')), false);
  assert.throws(() => finishNativeRequest(root, saved.request_ref), /Actual passing checks/);
  assert.equal(readFileSync(join(root, saved.output), 'utf8'), 'hello\n');
});

test('cancellation terminates an actual pending check and retains an unaccepted result', async t => {
  const root = project(t), saved = request(root, 'cancel', "setTimeout(() => console.log('SHOULD_NOT_FINISH'), 30000);\n");
  completeRoles(root, saved);
  const controller = new AbortController();
  const pending = runNativeChecks(root, saved.request_ref, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  const checked = await pending.finally(() => clearTimeout(timer));
  assert.equal(checked.status, 'cancelled');
  assert.equal(checked.checks[0].result.cancelled, true);
  assert.equal(checked.checks[0].state, 'uncertain');
  assert.equal(checked.accepted, false);
  assert.throws(() => finishNativeRequest(root, saved.request_ref), /Actual passing checks/);
  assert.ok(existsSync(join(root, checked.checks[0].log_path)));
});

test('changing an external ./checker after a passing run invalidates pending acceptance', async t => {
  const root = project(t), saved = request(root);
  completeRoles(root, saved);
  const checked = await runNativeChecks(root, saved.request_ref);
  assert.ok(checked.checks[0].baseline[saved.checker], 'Actual checker argv file is part of the verification baseline');
  assert.equal(saved.plan.outputs.includes(saved.checker), false);
  write(root, saved.checker, "throw new Error('checker changed after the passing evidence');\n");
  const before = readFileSync(statePath(root, saved.request_ref));
  assert.throws(() => finishNativeRequest(root, saved.request_ref), /protected file changed/);
  assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), before);
  assert.equal(getNativeRequest(root, saved.request_ref).accepted, false);
});

test('editing a product, external checker or retained check log invalidates current acceptance without rewriting history', async t => {
  const root = project(t);
  for (const pathKind of ['product', 'checker', 'log']) {
    const saved = request(root, pathKind);
    completeRoles(root, saved);
    await runNativeChecks(root, saved.request_ref);
    const accepted = finishNativeRequest(root, saved.request_ref);
    const stateBefore = readFileSync(statePath(root, saved.request_ref));
    const requestBefore = readFileSync(join(root, getRecord(root, saved.request_ref).path));
    write(root, pathKind === 'product' ? saved.output : pathKind === 'checker' ? saved.checker : accepted.checks[0].log_path, 'Changed after acceptance\n');
    const current = getNativeRequest(root, saved.request_ref);
    assert.equal(current.status, 'changed');
    assert.equal(current.historical_status, 'accepted');
    assert.equal(current.accepted, false);
    assert.equal(finishNativeRequest(root, saved.request_ref).accepted, false);
    assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), stateBefore);
    assert.deepEqual(readFileSync(join(root, getRecord(root, saved.request_ref).path)), requestBefore);
    assert.equal(getRecord(root, accepted.task_id).meta.status, 'accepted', 'Historical acceptance is retained');
  }
});

test('a pass report cannot replace a missing implementation product', t => {
  const root = project(t), saved = request(root), job = nextNativeAssignment(root, saved.request_ref);
  const result = recordNativeResult(root, callback(saved.request_ref, job));
  assert.equal(result.status, 'findings');
  assert.equal(result.assignments[0].state, 'findings');
  assert.match(result.assignments[0].report.findings.join('\n'), /Planned product files are missing/);
  assert.equal(nextNativeAssignment(root, saved.request_ref), undefined);
  assert.equal(result.accepted, false);
});

test('an incomplete professional report is retained without submitting the task or dispatching another role', t => {
  const root = project(t), saved = request(root), job = nextNativeAssignment(root, saved.request_ref);
  write(root, saved.output, 'hello\n');
  const input = callback(saved.request_ref, job);
  input.raw_result = 'I stopped before providing a professional verdict.';
  const result = recordNativeResult(root, input);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.assignments[0].raw_text, input.raw_result);
  assert.equal(getRecord(root, result.assignments[0].report_record_id).meta.status, 'draft');
  assert.equal(getRecord(root, result.task_id).meta.status, 'draft');
  assert.equal(nextNativeAssignment(root, saved.request_ref), undefined);
  assert.equal(result.accepted, false);
});

test('a rejected dispatch preflight preserves its assignment without manufacturing native invocation evidence', t => {
  const root = project(t), saved = request(root), job = nextNativeAssignment(root, saved.request_ref);
  const result = recordNativeDispatchFailure(root, { request_ref: saved.request_ref, assignment_ref: job.assignment_ref,
    code: 'MODEL_UNAVAILABLE', category: 'configuration' });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.assignments[0].invocation, undefined);
  assert.equal(result.assignments[0].agentName, 'WF.FnD');
  assert.equal(getRecord(root, result.assignments[0].report_record_id).meta.data.invoked, false);
  const before = readFileSync(statePath(root, saved.request_ref));
  recordNativeDispatchFailure(root, { request_ref: saved.request_ref, assignment_ref: job.assignment_ref,
    code: 'MODEL_UNAVAILABLE', category: 'configuration' });
  assert.deepEqual(readFileSync(statePath(root, saved.request_ref)), before);
  assert.equal(nextNativeAssignment(root, saved.request_ref), undefined);
});

test('host interruption between roles retains actual results and a late callback cannot close the request', t => {
  const root = project(t), saved = request(root), implementation = nextNativeAssignment(root, saved.request_ref);
  write(root, saved.output, 'hello\n');
  recordNativeResult(root, callback(saved.request_ref, implementation));
  const review = nextNativeAssignment(root, saved.request_ref);
  const interrupted = interruptNativeRequest(root, saved.request_ref, { code: 'EDITOR_CLOSED', category: 'cancellation' });
  assert.equal(interrupted.status, 'cancelled');
  assert.equal(interrupted.assignments[0].state, 'completed');
  const late = recordNativeResult(root, callback(saved.request_ref, review));
  assert.equal(late.status, 'cancelled');
  assert.equal(late.assignments[1].state, 'completed', 'The actual late outcome is retained as history');
  assert.equal(late.accepted, false);
  assert.equal(nextNativeAssignment(root, saved.request_ref), undefined);
  assert.throws(() => finishNativeRequest(root, saved.request_ref), /interrupted|current product|independent/i);
});

test('an actually invoked provider rejection retains its owned call and bounded error without implying a missing product input', t => {
  const root = project(t), saved = request(root), job = nextNativeAssignment(root, saved.request_ref);
  const input = callback(saved.request_ref, job, { invocation: { status: 'rejected' } });
  input.raw_result = undefined;
  input.adapter_error = { code: 'PROVIDER_QUOTA', category: 'provider-quota', message: 'PRIVATE_RAW_PROVIDER_EXCEPTION' };
  const result = recordNativeResult(root, input);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.assignments[0].invocation.host_call_id, input.invocation.host_call_id);
  assert.equal(result.assignments[0].invocation.invoked, true);
  assert.deepEqual(result.assignments[0].adapter_error, { code: 'PROVIDER_QUOTA', category: 'provider-quota' });
  const report = getRecord(root, result.assignments[0].report_record_id);
  assert.deepEqual(report.meta.data.adapter_error, { code: 'PROVIDER_QUOTA', category: 'provider-quota' });
  assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_PROVIDER_EXCEPTION'), false);
  assert.equal(readFileSync(join(root, report.path), 'utf8').includes('PRIVATE_RAW_PROVIDER_EXCEPTION'), false);
  assert.equal(result.accepted, false);
});

test('native request records keep existing IDs, request folders and routing assurance isolated from historical records', t => {
  const root = project(t);
  write(root, '.workforce/routing.json', '{}\n');
  const historical = createRecord(root, { type: 'knowledge', title: 'Historical record' });
  const historicalBytes = readFileSync(join(root, historical.path));
  assert.equal(historical.meta.data.routing_required, true);
  const saved = request(root);
  const nativeRecord = getRecord(root, saved.request_ref);
  assert.equal(nativeRecord.meta.data.routing_required, false);
  assert.equal(nativeRecord.meta.data.assurance, 'observed-native-local');
  assert.equal(Number(saved.request_ref.split('-').at(-1)), Number(historical.meta.id.split('-').at(-1)) + 1);
  for (const id of saved.record_ids) {
    const record = getRecord(root, id);
    assert.equal(record.meta.data.routing_required, false);
    assert.equal(record.meta.data.assurance, 'observed-native-local');
    assert.equal(record.meta.data.workflow_id, saved.request_ref);
    assert.ok(record.path.includes('/requests/WF-R0001--'));
  }
  assert.deepEqual(readFileSync(join(root, historical.path)), historicalBytes);
});

test('reconciling a lost execution-state write reuses the same plan records and refuses changed professional content', t => {
  const root = project(t);
  const opened = openNativeRequest(root, { requirement: 'Create a hello product after a lost state-write response.', title: 'Durable plan' });
  const path = statePath(root, opened.request_ref);
  const unplanned = readFileSync(path);
  const plan = {
    summary: 'Create the bounded product.', requirements: ['Print hello followed by a newline.'],
    design: 'One product file and an existing Node check.', outputs: ['hello.txt'],
    checks: [{ title: 'Check hello', command: [process.execPath, '-e', 'process.exit(0)'], level: 'acceptance' }],
  };
  const planned = planNativeRequest(root, opened.request_ref, plan);
  const recordsBefore = loadRecords(root);
  const recordBytes = new Map(recordsBefore.map(record => [record.path, readFileSync(join(root, record.path))]));
  // Simulate records being durably committed before the caller loses the final
  // execution-state write. The next call crosses the public operation seam.
  writeFileSync(path, unplanned);
  const recovered = planNativeRequest(root, opened.request_ref, plan);
  assert.deepEqual(recovered.record_ids, planned.record_ids);
  assert.equal(loadRecords(root).length, recordsBefore.length);

  writeFileSync(path, unplanned);
  const changed = { ...plan, requirements: ['A changed requirement must not borrow the old requirement record.'] };
  assert.throws(() => planNativeRequest(root, opened.request_ref, changed), /different|changed|content|reconcil/i);
  assert.deepEqual(readFileSync(path), unplanned);
  assert.equal(loadRecords(root).length, recordsBefore.length);
  for (const [recordPath, bytes] of recordBytes) assert.deepEqual(readFileSync(join(root, recordPath)), bytes);
});
