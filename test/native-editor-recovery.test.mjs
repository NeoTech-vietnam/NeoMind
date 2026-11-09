import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import * as domain from '../dist/native-request.js';
import { nativeLocalRequestSchema, nativeRequestControlSchema, nativeWorkerProfiles } from '../dist/native-local-contract.js';
import { getRecord, hash, initialize, loadRecords, readConfig, requestFolderForWorkflow } from '../dist/storage.js';

const require = createRequire(import.meta.url);
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const { nativeActivity } = require('../extensions/vscode-model-bridge/local-activity.cjs');
const opaque = Object.freeze({ native: Symbol('owned current native tool context') });
const report = (verdict = 'pass') => ({ content: [{ value: JSON.stringify({ summary: 'Observed scoped product', verdict,
  findings: verdict === 'pass' ? [] : ['An implementation correction is needed.'] }) }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function host(invoke) {
  return { CancellationTokenSource: class {
    constructor() { const listeners = new Set(); this.token = { isCancellationRequested: false,
      onCancellationRequested: fn => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
      this.cancel = () => { this.token.isCancellationRequested = true; for (const fn of listeners) fn(); }; }
    dispose() {}
  }, lm: { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
    properties: Object.fromEntries(['agentName', 'prompt', 'description', 'model'].map(name => [name, { type: 'string' }])) } }],
    invokeTool(_name, { input }, token) { return invoke(input.agentName.replace(/ Worker$/, ''), input, token); } } };
}

function project(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-editor-recovery-')), runners = [];
  initialize(root, { project_id: 'WF-EDITOR-RECOVERY', repair_attempts: 1, ...config });
  writeFileSync(join(root, 'protected.txt'), 'original user bytes\n');
  writeFileSync(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('product.txt','utf8'),'complete\\n');\n");
  t.after(async () => {
    await Promise.all(runners.map(runner => runner.dispose()));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const runner = (invoke, options = {}) => { const result = createLocalRequestRunner(host(invoke), {
    ...domain, nativeLocalRequestSchema, nativeRequestControlSchema, nativeWorkerProfiles, readConfig,
  }, root, options); runners.push(result); return result; };
  const request = { title: 'Recover the same exact product', requirement: 'Create product.txt with complete plus newline; preserve existing files.',
    context: ['protected.txt', 'check.cjs'], plan: { summary: 'Bounded text product', requirements: ['Exact complete plus newline'],
      design: 'UTF-8 product, independent review and test, actual existing Node checker', outputs: ['product.txt'],
      checks: [{ title: 'Actual product assertion', command: [process.execPath, 'check.cjs'], level: 'acceptance' }] } };
  const saved = () => { const record = loadRecords(root).find(item => item.meta.data.kind === 'workforce-request');
    assert.ok(record); return domain.getNativeRequest(root, record.meta.id); };
  return { root, runner, request, saved };
}

function retainedCancelledRole(app, code = 'EDITOR_CLOSED') {
  const { plan, ...request } = app.request, opened = domain.openNativeRequest(app.root, request);
  domain.planNativeRequest(app.root, opened.request_ref, plan);
  const job = domain.nextNativeAssignment(app.root, opened.request_ref);
  writeFileSync(join(app.root, 'product.txt'), 'retained partial\n');
  const packet = { request_ref: opened.request_ref, assignment_ref: job.assignment_ref,
    invocation: { transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: job.agentName,
      native_agent_name: nativeWorkerProfiles[job.agentName], host_call_id: randomUUID(), status: 'cancelled' },
    adapter_error: { code: 'CANCELLED', category: 'cancellation' } };
  domain.recordNativeResult(app.root, packet);
  domain.interruptNativeRequest(app.root, opened.request_ref, { code, category: 'cancellation' });
  return { before: app.saved(), packet };
}

// Native model boundary only is controlled. Records, interruption state, files,
// acceptance and checker processes are real. This is not desktop acceptance.
test('editor reload after a drained FnD resumes its same request and partial product without resetting the repair budget', { timeout: 60000 }, async t => {
  const app = project(t), started = deferred(); let implementations = 0, liveWriters = 0;
  const first = app.runner(async (role, _input, token) => {
    assert.equal(role, 'WF.FnD');
    if (++implementations === 1) { writeFileSync(join(app.root, 'product.txt'), 'initial\n'); return report('findings'); }
    writeFileSync(join(app.root, 'product.txt'), 'retained partial\n'); liveWriters++;
    return new Promise((_resolve, reject) => { token.onCancellationRequested(() => { liveWriters--; reject(Object.assign(new Error('Owned native call ended'), { name: 'CancellationError' })); }); started.resolve(); });
  });
  const running = first.run(app.request, opaque); await started.promise; await first.dispose();
  const interruptedResult = await running, before = app.saved();
  assert.equal(interruptedResult.error.code, 'EDITOR_CLOSED'); assert.equal(liveWriters, 0);
  assert.equal(before.repair_attempts, 1);
  const retained = before.assignments.map(a => ({ ref: a.assignment_ref, outcome: a.result_hash, bytes: readFileSync(join(app.root, getRecord(app.root, a.report_record_id).path)) }));
  const calls = [];
  const second = app.runner(async (role) => { calls.push(role);
    if (role === 'WF.FnD') { assert.equal(readFileSync(join(app.root, 'product.txt'), 'utf8'), 'retained partial\n'); writeFileSync(join(app.root, 'product.txt'), 'complete\n'); }
    return report(); });
  const resumed = await second.control({ request_key: before.request_key, action: 'resume' }, opaque);
  assert.equal(resumed.status, 'accepted');
  const after = app.saved(); assert.equal(after.request_ref, before.request_ref);
  assert.equal(after.repair_attempts, 1, 'Editor recovery does not reset or consume implementation repair allowance');
  assert.deepEqual(calls, ['WF.FnD', 'WF.Reviewer', 'WF.Tester']);
  assert.equal(after.assignments.length, 5); assert.equal(after.checks[0].result.exit_code, 0);
  assert.equal(loadRecords(app.root).filter(r => r.meta.data.kind === 'workforce-request').length, 1);
  assert.equal(readFileSync(join(app.root, 'protected.txt'), 'utf8'), 'original user bytes\n');
  for (const old of retained) { const actual = after.assignments.find(a => a.assignment_ref === old.ref);
    assert.equal(actual.result_hash, old.outcome); assert.deepEqual(readFileSync(join(app.root, getRecord(app.root, actual.report_record_id).path)), old.bytes); }
  assert.notEqual(after.assignments[2].assignment_ref, before.assignments[1].assignment_ref);
});

test('a known drained editor-cancelled checker rechecks the same current inspections with zero model calls', { timeout: 60000 }, async t => {
  const app = project(t), marker = app.root + '-checker-starts';
  t.after(() => rmSync(marker, { force: true }));
  writeFileSync(join(app.root, 'check.cjs'), `const fs=require('node:fs'),assert=require('node:assert/strict');
fs.appendFileSync(${JSON.stringify(marker)},${JSON.stringify('start\n')});
const count=fs.readFileSync(${JSON.stringify(marker)},'utf8').trim().split(/\\n/).length;
if(count===1)setInterval(()=>{},1000);
else {assert.equal(fs.readFileSync('product.txt','utf8'),'complete\\n');console.log('FRESH_EDITOR_RECOVERY_CHECK');}
`);
  const first = app.runner(async role => { if (role === 'WF.FnD') writeFileSync(join(app.root, 'product.txt'), 'complete\n'); return report(); });
  const running = first.run(app.request, opaque);
  const deadline = Date.now() + 30000;
  while (!existsSync(marker) && Date.now() < deadline && !t.signal.aborted) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(marker), true);
  await first.dispose(); const cancelled = await running, before = app.saved();
  assert.equal(cancelled.error.code, 'EDITOR_CLOSED');
  assert.equal(before.checks[0].result.cancelled, true);
  const old = before.checks[0], priorLog = readFileSync(join(app.root, old.log_path)), priorEvidence = readFileSync(join(app.root, getRecord(app.root, old.evidence_id).path));
  const product = readFileSync(join(app.root, 'product.txt')), calls = [];
  const second = app.runner(async role => { calls.push(role); assert.fail('Current independent role reports must not be called again'); });
  const rechecked = await second.control({ request_key: before.request_key, action: 'recheck' }, opaque);
  assert.equal(rechecked.status, 'accepted', JSON.stringify(rechecked));
  const after = app.saved(); assert.equal(after.request_ref, before.request_ref);
  assert.deepEqual(calls, []); assert.equal(after.assignments.length, 3);
  assert.equal(after.repair_attempts, before.repair_attempts);
  assert.equal(after.check_history.length, 1); assert.equal(after.check_history[0].execution_id, old.execution_id);
  assert.notEqual(after.checks[0].execution_id, old.execution_id);
  assert.equal(after.checks[0].result.exit_code, 0); assert.match(after.checks[0].result.stdout, /FRESH_EDITOR_RECOVERY_CHECK/);
  assert.equal(readFileSync(marker, 'utf8'), 'start\nstart\n');
  assert.deepEqual(readFileSync(join(app.root, old.log_path)), priorLog);
  assert.deepEqual(readFileSync(join(app.root, getRecord(app.root, old.evidence_id).path)), priorEvidence);
  assert.deepEqual(readFileSync(join(app.root, 'product.txt')), product);
});

test('an editor lost with an unobserved invocation stays uncertain and returns a bounded effects-reconciliation reason without dispatch', { timeout: 30000 }, async t => {
  const app = project(t), { plan, ...request } = app.request, opened = domain.openNativeRequest(app.root, request);
  domain.planNativeRequest(app.root, opened.request_ref, app.request.plan);
  const issued = domain.nextNativeAssignment(app.root, opened.request_ref);
  domain.interruptNativeRequest(app.root, opened.request_ref, { code: 'EDITOR_CLOSED', category: 'cancellation' });
  const before = app.saved(), calls = [], runner = app.runner(async role => { calls.push(role); assert.fail('Unknown writer effects must not be replayed'); });
  const result = await runner.control({ request_key: before.request_key, action: 'resume' }, opaque);
  assert.equal(result.error.code, 'EDITOR_EFFECTS_UNCONFIRMED');
  assert.equal(result.status, 'uncertain'); assert.deepEqual(calls, []);
  const after = app.saved(); assert.deepEqual(after.interruption, before.interruption);
  assert.equal(after.assignments.length, 1); assert.equal(after.assignments[0].assignment_ref, issued.assignment_ref);
  assert.equal(after.assignments[0].state, 'issued'); assert.equal(after.assignments[0].result_hash, undefined);
  assert.equal(after.checks[0].execution_id, undefined); assert.equal(after.final_report_id, undefined);
  assert.match(result.error.message, /uncertain|reconcil/i); assert.doesNotMatch(result.error.message, /WF-EDITOR-RECOVERY|assignment_ref/);
});

test('a real failed current check cannot be treated as a cancelled-check recovery', { timeout: 60000 }, async t => {
  const app = project(t);
  writeFileSync(join(app.root, 'check.cjs'), "console.error('REAL_PRODUCT_FAILURE');process.exitCode=1;\n");
  const first = app.runner(async role => { if (role === 'WF.FnD') writeFileSync(join(app.root, 'product.txt'), 'complete\n'); return report(); }, { automaticRepair: false });
  assert.equal((await first.run(app.request, opaque)).status, 'findings');
  let before = app.saved(); assert.equal(before.checks[0].result.exit_code, 1);
  domain.interruptNativeRequest(app.root, before.request_ref, { code: 'EDITOR_CLOSED', category: 'cancellation' });
  before = app.saved(); const oldLog = readFileSync(join(app.root, before.checks[0].log_path)), calls = [];
  const second = app.runner(async role => { calls.push(role); assert.fail('Product failures need their original product repair path'); });
  const result = await second.control({ request_key: before.request_key, action: 'recheck' }, opaque);
  assert.equal(result.error.code, 'EDITOR_CHECK_RECONCILIATION_REQUIRED');
  assert.equal(result.status, 'uncertain'); assert.deepEqual(calls, []);
  const after = app.saved(); assert.equal(after.checks[0].execution_id, before.checks[0].execution_id);
  assert.equal(after.check_history, undefined); assert.equal(after.editor_generation, before.editor_generation);
  assert.deepEqual(readFileSync(join(app.root, before.checks[0].log_path)), oldLog);
});

test('manual product repair cannot bypass an already spent allowance or rewrite retained findings', { timeout: 60000 }, async t => {
  const app = project(t), priorCalls = [];
  const first = app.runner(async role => { priorCalls.push(role); writeFileSync(join(app.root, 'product.txt'), 'incomplete\n'); return report('findings'); });
  assert.equal((await first.run(app.request, opaque)).status, 'findings');
  const before = app.saved(); assert.equal(before.repair_attempts, 1); assert.equal(priorCalls.length, 2);
  const oldReports = before.assignments.map(a => ({ id: a.report_record_id, bytes: readFileSync(join(app.root, getRecord(app.root, a.report_record_id).path)) }));
  const calls = [], second = app.runner(async role => { calls.push(role); return report('findings'); });
  const result = await second.control({ request_key: before.request_key, action: 'resume' }, opaque);
  assert.equal(result.error?.code, 'NATIVE_REPAIR_ALLOWANCE_EXHAUSTED');
  assert.equal(result.status, 'findings'); assert.deepEqual(calls, []);
  const after = app.saved(); assert.equal(after.repair_attempts, 1); assert.equal(after.assignments.length, 2);
  assert.equal(readFileSync(join(app.root, 'product.txt'), 'utf8'), 'incomplete\n');
  for (const old of oldReports) assert.deepEqual(readFileSync(join(app.root, getRecord(app.root, old.id).path)), old.bytes);
});

test('post-editor user changes preserve their bytes and require reconciliation before any worker', { timeout: 30000 }, async t => {
  const app = project(t), { before } = retainedCancelledRole(app);
  writeFileSync(join(app.root, 'product.txt'), 'user changed the partial product\n');
  const calls = [], runner = app.runner(async role => { calls.push(role); assert.fail('Concurrent user work must not be overwritten'); });
  const result = await runner.control({ request_key: before.request_key, action: 'resume' }, opaque);
  assert.equal(result.error.code, 'EDITOR_INPUTS_CHANGED'); assert.equal(result.status, 'uncertain'); assert.deepEqual(calls, []);
  const after = app.saved(); assert.equal(after.editor_generation, undefined); assert.deepEqual(after.interruption, before.interruption);
  assert.equal(readFileSync(join(app.root, 'product.txt'), 'utf8'), 'user changed the partial product\n');
});

test('explicit user cancellation does not acquire editor recovery authority', { timeout: 30000 }, async t => {
  const app = project(t), { before } = retainedCancelledRole(app, 'CANCELLED'), calls = [];
  const runner = app.runner(async role => { calls.push(role); assert.fail('User cancellation is not editor recovery'); });
  const result = await runner.control({ request_key: before.request_key, action: 'resume' }, opaque);
  assert.equal(result.status, 'cancelled'); assert.deepEqual(calls, []);
  const after = app.saved(); assert.deepEqual(after.interruption, before.interruption);
  assert.equal(after.editor_generation, undefined); assert.equal(after.assignments.length, 1);
});

test('recovered editor generation fences old callbacks and duplicate recovery does not create a second assignment', { timeout: 30000 }, t => {
  const app = project(t), { before, packet } = retainedCancelledRole(app);
  const resumed = domain.resumeNativeRequest(app.root, before.request_ref);
  assert.equal(resumed.editor_generation, 1); assert.equal(resumed.resume_role, 'WF.FnD');
  assert.throws(() => domain.recheckNativeRequest(app.root, before.request_ref), { code: 'EDITOR_CHECK_RECONCILIATION_REQUIRED' });
  const repeated = domain.resumeNativeRequest(app.root, before.request_ref);
  assert.equal(repeated.editor_generation, 1); assert.equal(repeated.assignments.length, 1);
  const newJob = domain.nextNativeAssignment(app.root, before.request_ref);
  assert.notEqual(newJob.assignment_ref, packet.assignment_ref);
  const current = app.saved(), metadataPath = join(app.root, '.workforce', requestFolderForWorkflow(app.root, before.request_ref).directory, 'native/execution.json');
  const savedBytes = readFileSync(metadataPath), product = readFileSync(join(app.root, 'product.txt'));
  domain.recordNativeResult(app.root, packet);
  assert.deepEqual(readFileSync(metadataPath), savedBytes);
  assert.throws(() => domain.recordNativeResult(app.root, { ...packet, invocation: { ...packet.invocation, status: 'returned' }, raw_result: report() }), /retained outcome|earlier editor generation/);
  assert.deepEqual(readFileSync(metadataPath), savedBytes); assert.deepEqual(readFileSync(join(app.root, 'product.txt')), product);
  assert.equal(app.saved().assignments.length, current.assignments.length); assert.equal(app.saved().accepted, false);
});

test('a saved cancellation without an observed checker process close cannot authorize replay', { timeout: 30000 }, async t => {
  const app = project(t), { plan, ...request } = app.request, opened = domain.openNativeRequest(app.root, request);
  domain.planNativeRequest(app.root, opened.request_ref, plan);
  for (const role of ['WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
    const job = domain.nextNativeAssignment(app.root, opened.request_ref);
    if (role === 'WF.FnD') writeFileSync(join(app.root, 'product.txt'), 'complete\n');
    domain.recordNativeResult(app.root, { request_ref: opened.request_ref, assignment_ref: job.assignment_ref,
      invocation: { transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: role,
        native_agent_name: nativeWorkerProfiles[role], host_call_id: randomUUID(), status: 'returned' }, raw_result: report() });
  }
  // Durable force-finish/crash-result shape, deliberately not execution proof.
  const folder = requestFolderForWorkflow(app.root, opened.request_ref).directory, metadataPath = join(app.root, '.workforce', folder, 'native/execution.json');
  const saved = JSON.parse(readFileSync(metadataPath, 'utf8')), logPath = `.workforce/${folder}/native/checks/unconfirmed.log`;
  mkdirSync(join(app.root, '.workforce', folder, 'native/checks'), { recursive: true }); writeFileSync(join(app.root, logPath), 'Cancellation attempted; child close unobserved.\n');
  Object.assign(saved.checks[0], { state: 'uncertain', execution_id: randomUUID(), log_path: logPath, log_sha256: hash(readFileSync(join(app.root, logPath))),
    result: { exit_code: null, signal: null, stdout: '', stderr: '', cancelled: true, timed_out: false, output_limited: false, error: null, duration_ms: 2000 } });
  writeFileSync(metadataPath, JSON.stringify(saved, null, 2) + '\n');
  domain.interruptNativeRequest(app.root, opened.request_ref, { code: 'EDITOR_CLOSED', category: 'cancellation' });
  const calls = [], runner = app.runner(async role => { calls.push(role); assert.fail('Unconfirmed checker effects cannot spawn another worker'); });
  const result = await runner.control({ request_key: opened.request_key, action: 'recheck' }, opaque);
  assert.equal(result.error.code, 'EDITOR_EFFECTS_UNCONFIRMED'); assert.equal(result.status, 'uncertain'); assert.deepEqual(calls, []);
  assert.equal(app.saved().checks[0].execution_id, saved.checks[0].execution_id); assert.equal(app.saved().check_history, undefined);
});

test('a late old FnD outcome after lost ownership is retained without changing current baseline or context', t => {
  const app = project(t), { plan, ...request } = app.request, opened = domain.openNativeRequest(app.root, request);
  domain.planNativeRequest(app.root, opened.request_ref, plan);
  const job = domain.nextNativeAssignment(app.root, opened.request_ref);
  domain.interruptNativeRequest(app.root, opened.request_ref, { code: 'EDITOR_CLOSED', category: 'cancellation' });
  const before = app.saved(); writeFileSync(join(app.root, 'product.txt'), 'complete\n');
  domain.recordNativeResult(app.root, { request_ref: opened.request_ref, assignment_ref: job.assignment_ref,
    invocation: { transport: 'vscode-native', tool: 'runSubagent', invoked: true, agentName: job.agentName,
      native_agent_name: nativeWorkerProfiles[job.agentName], host_call_id: randomUUID(), status: 'returned' }, raw_result: report() });
  const after = app.saved(); assert.deepEqual(after.assignments[0].baseline, before.assignments[0].baseline);
  assert.deepEqual(after.context_membership, before.context_membership); assert.equal(after.status, 'uncertain');
  assert.equal(after.assignments[0].state, 'uncertain'); assert.equal(after.checks[0].execution_id, undefined);
  assert.ok(after.assignments[0].report_record_id); assert.equal(after.accepted, false);
  assert.equal(getRecord(app.root, after.assignments[0].report_record_id).meta.status, 'draft');
});

test('a queued recovered FnD cannot dispatch after its retained partial changes', { timeout: 60000 }, async t => {
  const app = project(t, { max_workers: 1 }), { before } = retainedCancelledRole(app), headStarted = deferred(), releaseHead = deferred(), recoveredCalls = [];
  const runner = app.runner(async (_role, input, token) => {
    if (input.prompt.includes('Queue head only')) { token.onCancellationRequested(() => releaseHead.resolve()); headStarted.resolve(); await releaseHead.promise; return report('findings'); }
    recoveredCalls.push(input); assert.fail('Changed queued recovery must not call a model');
  }, { automaticRepair: false });
  const head = runner.run({ ...app.request, title: 'Queue head', requirement: 'Queue head only', plan: { ...app.request.plan, outputs: ['queue-head.txt'] } }, opaque);
  await headStarted.promise;
  const recovered = runner.control({ request_key: before.request_key, action: 'resume' }, opaque);
  const deadline = Date.now() + 15000;
  while (!nativeActivity(app.root).queued_calls.some(x => x.request_ref === before.request_ref) && Date.now() < deadline && !t.signal.aborted)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(nativeActivity(app.root).queued_calls.some(x => x.request_ref === before.request_ref), true);
  writeFileSync(join(app.root, 'product.txt'), 'user changed while queued\n'); releaseHead.resolve();
  const result = await recovered; await head;
  assert.equal(result.error.code, 'EDITOR_INPUTS_CHANGED'); assert.equal(result.status, 'uncertain'); assert.deepEqual(recoveredCalls, []);
  assert.equal(readFileSync(join(app.root, 'product.txt'), 'utf8'), 'user changed while queued\n');
  const after = domain.getNativeRequest(app.root, before.request_ref); assert.equal(after.assignments.length, 2);
  assert.equal(after.assignments[1].invocation, undefined); assert.equal(after.accepted, false);
});
