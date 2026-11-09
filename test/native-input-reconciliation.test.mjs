// Host-outcome/domain integration. These fixtures make no provider/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as domain from '../dist/native-request.js';
import { nativeLocalRequestSchema, nativeWorkerProfiles } from '../dist/native-local-contract.js';
import { initialize, loadRecords, getRecord } from '../dist/storage.js';
const { createLocalRequestRunner } = createRequire(import.meta.url)('../extensions/vscode-model-bridge/local-request.cjs');
const pass = { summary: 'Observed the exact assigned professional scope.', verdict: 'pass', findings: [] };
function project(t, repair_attempts = 1, beforeRemove = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-input-reconcile-'));
  initialize(root, { project_id: 'WF-INPUT-CHANGE', repair_attempts });
  t.after(async () => { await beforeRemove(); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function request(label, output) { return { requirement: `WF_REQUEST_${label}: create exact hello text.`, title: `Request ${label}`, context: [], plan: {
  summary: 'Write one verified text product.', requirements: ['The product equals hello.'], design: 'One isolated text file with a direct assertion.',
  outputs: [output], checks: [{ title: 'Exact product assertion', level: 'acceptance', command: [process.execPath, '-e',
    `require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(output)},'utf8'),'hello')`] }],
} }; }
function fakeHost(invoke) { return { CancellationTokenSource: class {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}, lm: { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['agentName', 'prompt', 'description'],
  properties: Object.fromEntries(['agentName', 'prompt', 'description'].map(key => [key, { type: 'string' }])) } }],
  invokeTool: async (_name, { input }) => { await invoke(input); return { content: [{ value: JSON.stringify(pass) }] }; },
} }; }
const runtime = () => ({ ...domain, nativeLocalRequestSchema, nativeWorkerProfiles });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function write(root, path, content) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
function callback(root, opened, job, raw_result = JSON.stringify(pass), status = 'returned') {
  return domain.recordNativeResult(root, { request_ref: opened.request_ref, assignment_ref: job.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent', invoked: true,
      agentName: job.agentName, status }, raw_result });
}
function stagedReview(root, options = {}) {
  write(root, 'source.txt', 'before');
  const input = request('A', 'alpha.txt'), { plan: _plan, ...requirement } = input;
  const opened = domain.openNativeRequest(root, requirement);
  const planned = domain.planNativeRequest(root, opened.request_ref, input.plan);
  write(root, 'alpha.txt', 'hello');
  callback(root, planned, domain.nextNativeAssignment(root, planned.request_ref));
  const job = domain.nextNativeAssignment(root, planned.request_ref);
  write(root, options.output ? 'alpha.txt' : 'later.txt', 'changed input');
  const saved = callback(root, planned, job, options.raw ?? JSON.stringify(pass), options.status ?? 'returned');
  return { planned, job, saved };
}

for (const nested of [false, true]) test(`two actual native-domain runner requests ${nested ? 'in separate nested directories' : 'sharing root inputs'} finish with current independent evidence`, { timeout: 180000 }, async t => {
  let runner;
  const reviewerStarted = deferred(), peerProduced = deferred(), calls = [];
  const root = project(t, 1, async () => { peerProduced.resolve(); await runner?.dispose(); });
  const aPath = nested ? 'alpha/product.txt' : 'alpha.txt', bPath = nested ? 'beta/product.txt' : 'beta.txt';
  let aReviewers = 0;
  runner = createLocalRequestRunner(fakeHost(async input => {
    const a = input.prompt.includes('WF_REQUEST_A'), role = input.agentName.replace(/ Worker$/, '');
    calls.push([a ? 'A' : 'B', role]);
    if (role === 'WF.FnD') { write(root, a ? aPath : bPath, 'hello'); if (!a) peerProduced.resolve(); }
    if (a && role === 'WF.Reviewer' && ++aReviewers === 1) { reviewerStarted.resolve(); await peerProduced.promise; }
  }), runtime(), root);
  const aRun = runner.run(request('A', aPath), {});
  await Promise.race([reviewerStarted.promise, aRun.then(() => assert.fail('A ended before the Reviewer synchronization gate'))]);
  const [a, b] = await Promise.all([aRun, runner.run(request('B', bPath), {})]);
  assert.equal(a.request.accepted, true); assert.equal(b.request.accepted, true);
  assert.equal(calls.filter(([label, role]) => label === 'A' && role === 'WF.FnD').length, 1, 'A source change must not cause another implementation write');
  assert.equal(calls.filter(([label, role]) => label === 'B' && role === 'WF.FnD').length, 1);
  assert.equal(aReviewers, nested ? 1 : 2, 'Only an actually stale shared-root inspection is repeated on the new input epoch');
  const own = loadRecords(root).find(record => record.meta.data.kind === 'workforce-request' && record.meta.title === 'Request A');
  const state = domain.getNativeRequest(root, own.meta.id);
  assert.equal(state.repair_attempts ?? 0, nested ? 0 : 1);
  assert.equal(state.checks[0].result.exit_code, 0);
  if (!nested) {
    assert.equal(state.assignments[1].state, 'uncertain');
    assert.equal(getRecord(root, state.assignments[1].report_record_id).meta.status, 'draft');
    assert.equal(state.assignments[2].agentName, 'WF.Reviewer');
    assert.equal(typeof state.assignments[2].baseline[bPath], 'string', 'Fresh review actually pins the newly present peer input');
  }
});

test('a source change just before check preflight triggers fresh review and checks instead of generic backend failure', async t => {
  let runner;
  const root = project(t, 1, () => runner?.dispose()), calls = [];
  let checkCalls = 0;
  runner = createLocalRequestRunner(fakeHost(async input => {
    const role = input.agentName.replace(/ Worker$/, ''); calls.push(role);
    if (role === 'WF.FnD') write(root, 'alpha.txt', 'hello');
  }), { ...runtime(), runNativeChecks(...args) {
    if (++checkCalls === 1) write(root, 'late.txt', 'A real new source input');
    return domain.runNativeChecks(...args);
  } }, root);
  const result = await runner.run(request('A', 'alpha.txt'), {});
  assert.equal(result.request.accepted, true);
  assert.equal(result.error, undefined);
  assert.equal(checkCalls, 2);
  assert.deepEqual(calls, ['WF.FnD', 'WF.Reviewer', 'WF.Tester', 'WF.Reviewer', 'WF.Tester']);
});

for (const phase of ['checks', 'finish']) test(`an unreconcilable protected input edit before ${phase} leaves durable uncertainty after the runner ends`, async t => {
  let runner;
  const root = project(t, 1, () => runner?.dispose()), calls = [], retained = [];
  write(root, 'source.txt', 'Protected original');
  const changeProtectedInput = () => {
    const owner = loadRecords(root).find(record => record.meta.data.kind === 'workforce-request');
    for (const job of domain.getNativeRequest(root, owner.meta.id).assignments) {
      const report = getRecord(root, job.report_record_id);
      retained.push({ path: report.path, bytes: readFileSync(join(root, report.path)) });
    }
    write(root, 'source.txt', 'Concurrent user revision');
  };
  runner = createLocalRequestRunner(fakeHost(async input => {
    const role = input.agentName.replace(/ Worker$/, ''); calls.push(role);
    if (role === 'WF.FnD') write(root, 'alpha.txt', 'hello');
  }), { ...runtime(),
    runNativeChecks(...args) { if (phase === 'checks') changeProtectedInput(); return domain.runNativeChecks(...args); },
    finishNativeRequest(...args) { if (phase === 'finish') changeProtectedInput(); return domain.finishNativeRequest(...args); },
  }, root);
  const input = request('A', 'alpha.txt'); input.context = ['source.txt'];
  const result = await runner.run(input, {});
  assert.equal(result.error?.code, 'NATIVE_INPUT_REVISION_CHANGED');
  assert.equal(result.error.category, 'concurrency');
  assert.equal(result.status, 'uncertain', 'A returned owner must not leave the public request working');
  assert.equal(result.request.status, 'uncertain');
  assert.equal(result.request.accepted, false);
  const owner = loadRecords(root).find(record => record.meta.data.kind === 'workforce-request');
  const state = domain.getNativeRequest(root, owner.meta.id);
  assert.equal(state.historical_status, 'uncertain', 'Uncertainty is persisted, not merely a monitor projection');
  assert.equal(state.interruption.code, 'NATIVE_INPUT_REVISION_CHANGED');
  assert.equal(state.interruption.category, 'concurrency');
  assert.equal(state.final_report_id, undefined);
  assert.equal(state.repair_attempts, undefined);
  assert.deepEqual(calls, ['WF.FnD', 'WF.Reviewer', 'WF.Tester']);
  assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'Concurrent user revision');
  assert.equal(readFileSync(join(root, 'alpha.txt'), 'utf8'), 'hello');
  if (phase === 'checks') assert.equal(state.checks[0].execution_id, undefined, 'Uninspected inputs never spawn the checker');
  else assert.equal(state.checks[0].result.exit_code, 0, 'Earlier actual checks remain retained without current acceptance');
  for (const report of retained) assert.deepEqual(readFileSync(join(root, report.path)), report.bytes);
});

test('changed-input reconciliation retains the exact callback and duplicate preparation does not consume another attempt', t => {
  const root = project(t), { planned, saved } = stagedReview(root);
  const before = readFileSync(join(root, getRecord(root, saved.assignments.at(-1).report_record_id).path));
  const first = domain.reconcileNativeInputChange(root, planned.request_ref);
  assert.equal(first.outcome, 'prepared'); assert.equal(first.state.resume_role, 'WF.Reviewer');
  assert.equal(first.state.repair_attempts, 1);
  const duplicate = domain.reconcileNativeInputChange(root, planned.request_ref);
  assert.equal(duplicate.outcome, 'prepared'); assert.equal(duplicate.state.repair_attempts, 1);
  assert.deepEqual(readFileSync(join(root, getRecord(root, saved.assignments.at(-1).report_record_id).path)), before);
});

const compiler = process.platform === 'win32' ? 'C:/msys64/mingw64/bin/gcc.exe' : '/usr/bin/gcc';
test('a real compiled product keeps its input epoch stable after a lost reconciliation acknowledgement', { skip: !existsSync(compiler), timeout: 90000 }, async t => {
  const root = project(t), executable = process.platform === 'win32' ? 'app.exe' : 'app';
  const opened = domain.openNativeRequest(root, { requirement: 'Create a real C program that compiles and exits zero.' });
  const planned = domain.planNativeRequest(root, opened.request_ref, { summary: 'Compile and execute a small C program.',
    requirements: ['The program compiles as C11 and exits zero.'], design: 'A single main function with direct compiler and binary checks.', outputs: ['main.c'],
    checks: [{ title: 'Actual GCC compilation', level: 'integration', command: [compiler, '-std=c11', 'main.c', '-o', executable] },
      { title: 'Actual compiled program', level: 'acceptance', command: [join(root, executable)] }] });
  write(root, 'main.c', 'int main(void) { return 0; }\n');
  for (let index = 0; index < 3; index++) callback(root, planned, domain.nextNativeAssignment(root, planned.request_ref));
  const checked = await domain.runNativeChecks(root, planned.request_ref);
  assert.ok(checked.checks.every(check => check.state === 'passed'));
  assert.equal(typeof checked.generated_hashes[executable], 'string');
  const producedBytes = readFileSync(join(root, executable));
  write(root, 'later.txt', 'A new source input before final acceptance');
  const first = domain.reconcileNativeInputChange(root, planned.request_ref), count = loadRecords(root).length;
  assert.equal(first.outcome, 'prepared');
  const replay = domain.reconcileNativeInputChange(root, planned.request_ref);
  assert.equal(replay.outcome, 'prepared', 'A lost acknowledgement must replay the retained preparation, not exhaust unchanged input');
  assert.equal(replay.state.input_reconciliation.epoch, first.state.input_reconciliation.epoch);
  assert.equal(replay.state.repair_attempts, 1);
  assert.equal(loadRecords(root).length, count);
  assert.deepEqual(readFileSync(join(root, executable)), producedBytes);
  assert.equal(replay.state.check_history.length, 2);
  for (const role of ['WF.Reviewer', 'WF.Tester']) {
    const job = domain.nextNativeAssignment(root, planned.request_ref);
    assert.equal(job.agentName, role); callback(root, planned, job);
  }
  const fresh = await domain.runNativeChecks(root, planned.request_ref);
  assert.ok(fresh.checks.every(check => check.state === 'passed'));
  assert.equal(domain.finishNativeRequest(root, planned.request_ref).accepted, true);
});

test('configured input-reconciliation exhaustion gives an explicit bounded reason without another assignment', t => {
  const root = project(t, 1), { planned } = stagedReview(root);
  assert.equal(domain.reconcileNativeInputChange(root, planned.request_ref).outcome, 'prepared');
  const fresh = domain.nextNativeAssignment(root, planned.request_ref);
  write(root, 'later.txt', 'A second distinct input epoch');
  callback(root, planned, fresh);
  const result = domain.reconcileNativeInputChange(root, planned.request_ref);
  assert.equal(result.outcome, 'exhausted'); assert.equal(result.code, 'INPUT_RECONCILIATION_BUDGET');
  assert.equal(result.state.repair_attempts, 1);
  assert.equal(result.state.assignments.length, 3);
  assert.equal(domain.nextNativeAssignment(root, planned.request_ref), undefined);
});

test('a revisited input epoch is stopped even when repair allowance remains', t => {
  const root = project(t, 3), { planned } = stagedReview(root);
  assert.equal(domain.reconcileNativeInputChange(root, planned.request_ref).outcome, 'prepared');
  let job = domain.nextNativeAssignment(root, planned.request_ref);
  write(root, 'later.txt', 'second epoch'); callback(root, planned, job);
  assert.equal(domain.reconcileNativeInputChange(root, planned.request_ref).outcome, 'prepared');
  job = domain.nextNativeAssignment(root, planned.request_ref);
  write(root, 'later.txt', 'changed input'); callback(root, planned, job);
  const stopped = domain.reconcileNativeInputChange(root, planned.request_ref);
  assert.equal(stopped.outcome, 'exhausted'); assert.equal(stopped.code, 'INPUT_EPOCH_ALREADY_RECONCILED');
  assert.equal(stopped.state.repair_attempts, 2);
});

for (const options of [{ raw: 'Malformed model report' }, { status: 'rejected' }, { status: 'cancelled' }, { output: true }])
  test(`input reconciliation never retries malformed/provider/cancelled outcomes or changed own outputs: ${JSON.stringify(options)}`, t => {
    const root = project(t), { planned } = stagedReview(root, options);
    const result = domain.reconcileNativeInputChange(root, planned.request_ref);
    assert.equal(result.outcome, 'unchanged');
    assert.equal(result.state.repair_attempts, undefined);
    assert.equal(result.state.assignments.length, 2);
  });
