import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as runtime from '../dist/index.js';

const require = createRequire(import.meta.url);
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-role-'));
  runtime.initialize(root, { project_id: 'WF-ROLES' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function callback(state, report = { summary: 'Observed scoped work', verdict: 'pass', findings: [] }) {
  return { request_ref: state.request_ref, assignment_ref: state.assignment_ref,
    invocation: { host_call_id: randomUUID(), agentName: state.role, transport: 'vscode-native', tool: 'runSubagent', invoked: true, status: 'returned' },
    raw_result: JSON.stringify(report) };
}

test('a read-only role never completes when requested report files are missing, even if its model says pass', t => {
  const root = project(t);
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Write requirements.md', outputs: ['requirements.md'] });
  const result = runtime.recordNativeRoleResult(root, callback(opened));
  assert.equal(result.completion, 'incomplete');
  assert.equal(result.accepted, false);
  assert.equal(result.artifacts[0].exists, false);
  assert.ok(result.report.findings.length > 0, 'The missing requested report is explained to the caller');
});

test('the backend publishes distinct scoped report files for read-only roles while retaining independent findings', t => {
  const root = project(t);
  writeFileSync(join(root, 'source.txt'), 'Preserve this inspected input.');
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Save separate review and risk reports.',
    context: ['.'], outputs: ['review.md', 'risks.md'] });
  const report = { summary: 'Independent review complete with a concrete finding.', verdict: 'findings', findings: ['The timeout is unspecified.'],
    report_artifacts: [{ path: 'review.md', content: '# Review\n\nThe timeout is unspecified.\n' },
      { path: 'risks.md', content: '# Risks\n\nAn unlimited operation may hang.\n' }] };
  const input = callback(opened, report), result = runtime.recordNativeRoleResult(root, input);
  assert.equal(result.completion, 'role-completed');
  assert.equal(result.status, 'findings'); assert.equal(result.accepted, false);
  assert.equal(readFileSync(join(root, 'review.md'), 'utf8'), report.report_artifacts[0].content);
  assert.equal(readFileSync(join(root, 'risks.md'), 'utf8'), report.report_artifacts[1].content);
  assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'Preserve this inspected input.');
  assert.equal(runtime.getNativeRoleJob(root, opened.request_ref).completion, 'role-completed', 'Planned report files do not invalidate context membership');
  const reportBytes = readFileSync(join(root, result.report_path)), stamp = statSync(join(root, 'review.md')).mtimeMs;
  assert.equal(runtime.recordNativeRoleResult(root, input).completion, 'role-completed');
  assert.equal(statSync(join(root, 'review.md')).mtimeMs, stamp, 'An identical callback does not rewrite report products');
  assert.deepEqual(readFileSync(join(root, result.report_path)), reportBytes);
  assert.throws(() => runtime.recordNativeRoleResult(root, callback(opened, { ...report, summary: 'A different late result' })), /cannot be overwritten/);
});

test('report payload paths are exact and scope errors publish no files', t => {
  const root = project(t);
  for (const report_artifacts of [
    [{ path: 'unlisted.md', content: 'Outside the saved scope' }],
    [{ path: 'report.md', content: 'First' }, { path: 'report.md', content: 'Conflicting duplicate' }],
    [{ path: 'report.md', content: 'Allowed' }, { path: '../outside.md', content: 'Escape' }],
  ]) {
    const opened = runtime.openNativeRoleJob(root, { role: 'WF.P-RES', requirement: 'Write only report.md', outputs: ['report.md'] });
    const result = runtime.recordNativeRoleResult(root, callback(opened, { summary: 'Design report', verdict: 'pass', findings: [], report_artifacts }));
    assert.equal(result.completion, 'incomplete');
    assert.equal(existsSync(join(root, 'report.md')), false); assert.equal(existsSync(join(root, 'unlisted.md')), false);
  }
});

test('saved report-output baselines preserve concurrent user creates and non-output edits', t => {
  const root = project(t);
  writeFileSync(join(root, 'source.txt'), 'Original source');
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Create report.md', context: ['source.txt'], outputs: ['report.md'] });
  const payload = { summary: 'Requirements report', verdict: 'pass', findings: [], report_artifacts: [{ path: 'report.md', content: 'Desired report\n' }] };
  writeFileSync(join(root, 'report.md'), 'Desired report\n');
  assert.equal(runtime.recordNativeRoleResult(root, callback(opened, payload)).completion, 'incomplete', 'Matching bytes created by the user are not a retained backend operation');
  assert.equal(readFileSync(join(root, 'report.md'), 'utf8'), 'Desired report\n');
  rmSync(join(root, 'report.md'));
  const another = runtime.openNativeRoleJob(root, { role: 'WF.P-RES', requirement: 'Create report.md', context: ['source.txt'], outputs: ['report.md'] });
  writeFileSync(join(root, 'source.txt'), 'User edited the inspected source');
  assert.equal(runtime.recordNativeRoleResult(root, callback(another, payload)).completion, 'incomplete');
  assert.equal(existsSync(join(root, 'report.md')), false);
  assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'User edited the inspected source');
});

test('cancellation retains report content without publishing requested file side effects', t => {
  const root = project(t);
  for (const role of ['WF.SWSD', 'WF.Reviewer', 'WF.Tester']) {
    const output = `${role}.md`;
    const opened = runtime.openNativeRoleJob(root, { role, requirement: `Save ${output}`, outputs: [output] });
    const input = callback(opened, { summary: 'Scoped review', verdict: 'pass', findings: [],
      report_artifacts: [{ path: output, content: '# Verification\n' }] });
    input.invocation.status = 'cancelled';
    const result = runtime.recordNativeRoleResult(root, input);
    assert.equal(result.status, 'cancelled'); assert.equal(result.completion, 'incomplete');
    assert.equal(existsSync(join(root, output)), false);
    const bytes = readFileSync(join(root, result.report_path));
    const projection = runtime.nativeRoleListForMonitor(root).find(item => item.workflow_id === result.request_ref);
    assert.equal(projection.status, 'cancelled'); assert.equal(projection.accepted, false);
    assert.match(projection.current_action, /cancelled/); assert.match(projection.current_action, /incomplete/);
    assert.equal(projection.live, false); assert.deepEqual(projection.active_agents, []);
    if (role === 'WF.SWSD') assert.equal(projection.stages.find(stage => stage.id === 'requirements').state, 'interrupted');
    if (role === 'WF.Reviewer') assert.equal(projection.review.state, 'interrupted');
    assert.deepEqual(readFileSync(join(root, result.report_path)), bytes, 'Projection keeps the actual cancelled report unchanged');
  }
});

test('a report replacement archives its exact original bytes and keeps other inspected files unchanged', t => {
  const root = project(t), original = '# Earlier requirements\n\nPreserve this prior revision.\n';
  writeFileSync(join(root, 'requirements.md'), original);
  writeFileSync(join(root, 'source.txt'), 'Inspected source');
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Update requirements.md', context: ['.'], outputs: ['requirements.md'] });
  const desired = '# Updated requirements\n\nExplicit acceptance criteria.\n';
  const result = runtime.recordNativeRoleResult(root, callback(opened, { summary: 'Updated requirements report', verdict: 'pass', findings: [],
    report_artifacts: [{ path: 'requirements.md', content: desired }] }));
  assert.equal(result.completion, 'role-completed');
  const folder = runtime.requestFolderForWorkflow(root, opened.request_ref).directory;
  const archive = join(root, '.workforce', folder, 'native/report-output-previous', `${runtime.hash('requirements.md')}.utf8`);
  assert.equal(readFileSync(archive, 'utf8'), original);
  assert.equal(readFileSync(join(root, 'requirements.md'), 'utf8'), desired);
  assert.equal(readFileSync(join(root, 'source.txt'), 'utf8'), 'Inspected source');
});

test('durable report-output intent reconciles a lost final state write without duplicating or overwriting effects', t => {
  const fs = require('node:fs'), originalRename = fs.renameSync;
  for (const edited of [false, true]) {
    const root = project(t), desired = '# Report\n\nRetained professional content.\n';
    const opened = runtime.openNativeRoleJob(root, { role: 'WF.P-RES', requirement: 'Save design.md', outputs: ['design.md'] });
    const folder = runtime.requestFolderForWorkflow(root, opened.request_ref).directory;
    const statePath = join(root, '.workforce', folder, 'native/role-job.json');
    const outcomePath = join(root, '.workforce', folder, 'native/report-output-complete.json');
    const input = callback(opened, { summary: 'Design report', verdict: 'pass', findings: [], report_artifacts: [{ path: 'design.md', content: desired }] });
    let injected = 0;
    fs.renameSync = function(source, target, ...args) {
      if (target === statePath && existsSync(outcomePath)) { injected++; throw Object.assign(new Error('Injected lost final report state'), { code: 'EIO' }); }
      return originalRename(source, target, ...args);
    };
    syncBuiltinESMExports();
    try { assert.throws(() => runtime.recordNativeRoleResult(root, input), /Injected lost final report state/); }
    finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
    assert.ok(injected > 0);
    const pending = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(pending.result_hash, undefined);
    assert.equal(pending.report_write.completed, false, 'Prepared intent, not an invented final completion, survived');
    assert.equal(readFileSync(join(root, 'design.md'), 'utf8'), desired);
    const recordCount = runtime.loadRecords(root).length, stamp = statSync(join(root, 'design.md')).mtimeMs;
    assert.throws(() => runtime.recordNativeRoleResult(root, callback(opened)), /retained role report operation/);
    if (edited) writeFileSync(join(root, 'design.md'), 'User changed the published report');
    const saved = runtime.recordNativeRoleResult(root, input);
    assert.equal(saved.completion, edited ? 'incomplete' : 'role-completed');
    assert.equal(readFileSync(join(root, 'design.md'), 'utf8'), edited ? 'User changed the published report' : desired);
    assert.equal(runtime.loadRecords(root).length, recordCount, 'A lost final state write does not duplicate the actual role report');
    if (!edited) assert.equal(statSync(join(root, 'design.md')).mtimeMs, stamp);
  }
});

test('an interrupted multi-file report resumes the same retained operation and detects altered publication proof', t => {
  const root = project(t), fs = require('node:fs'), originalRename = fs.renameSync;
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Write separate review and risk reports.',
    outputs: ['review.md', 'risks.md'] });
  const input = callback(opened, { summary: 'Independent inspection', verdict: 'findings', findings: ['One timing risk remains.'],
    report_artifacts: [{ path: 'review.md', content: '# Review\n\nInspection findings.\n' },
      { path: 'risks.md', content: '# Risks\n\nA distinct timing risk.\n' }] });
  const second = join(root, 'risks.md');
  fs.renameSync = function(source, target, ...args) {
    if (target === second) throw Object.assign(new Error('Injected interrupted second report publication'), { code: 'EIO' });
    return originalRename(source, target, ...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => runtime.recordNativeRoleResult(root, input), /Injected interrupted second report publication/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(root, 'review.md'), 'utf8'), '# Review\n\nInspection findings.\n');
  assert.equal(existsSync(second), false);
  assert.equal(runtime.getNativeRoleJob(root, opened.request_ref).completion, 'incomplete');
  const stamp = statSync(join(root, 'review.md')).mtimeMs;
  const completed = runtime.recordNativeRoleResult(root, input);
  assert.equal(completed.completion, 'role-completed');
  assert.equal(statSync(join(root, 'review.md')).mtimeMs, stamp, 'Already published bytes are reconciled without rewriting');
  assert.equal(readFileSync(second, 'utf8'), '# Risks\n\nA distinct timing risk.\n');
  const folder = runtime.requestFolderForWorkflow(root, opened.request_ref).directory;
  writeFileSync(join(root, '.workforce', folder, 'native/report-output-complete.json'), '{"invented":true}\n');
  const altered = runtime.getNativeRoleJob(root, opened.request_ref);
  assert.equal(altered.completion, 'incomplete');
  assert.equal(altered.status, 'uncertain', 'A changed private proof cannot preserve a completed claim');
});

test('report-file CAS detects an external create between staging and commit', t => {
  const root = project(t), fs = require('node:fs'), originalWrite = fs.writeFileSync;
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Write report.md', outputs: ['report.md'] });
  const target = join(root, 'report.md');
  let injected = false, ownedTemporary;
  fs.writeFileSync = function(path, ...args) {
    const result = originalWrite(path, ...args);
    if (!injected && typeof path === 'string' && path.startsWith(target + '.') && path.endsWith('.tmp')) {
      injected = true; ownedTemporary = path; originalWrite(target, 'Concurrent user report');
    }
    return result;
  };
  syncBuiltinESMExports();
  let result;
  try { result = runtime.recordNativeRoleResult(root, callback(opened, { summary: 'Report', verdict: 'pass', findings: [],
    report_artifacts: [{ path: 'report.md', content: 'Backend report' }] })); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(result.completion, 'incomplete');
  assert.equal(result.report_artifact_issue, 'REPORT_OUTPUT_CHANGED');
  assert.equal(readFileSync(target, 'utf8'), 'Concurrent user report');
  assert.equal(existsSync(ownedTemporary), false, 'The exact owned staging file is removed after failed CAS');
});

test('excluding the exact owned staging path never hides unrelated files added during report publication', t => {
  const root = project(t), fs = require('node:fs'), originalWrite = fs.writeFileSync;
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Write report.md', context: ['.'], outputs: ['report.md'] });
  const target = join(root, 'report.md');
  let injected = false, ownedTemporary;
  fs.writeFileSync = function(path, ...args) {
    const result = originalWrite(path, ...args);
    if (!injected && typeof path === 'string' && path.startsWith(target + '.') && path.endsWith('.tmp')) {
      injected = true; ownedTemporary = path; originalWrite(join(root, 'user-added.tmp'), 'An unrelated concurrent source');
    }
    return result;
  };
  syncBuiltinESMExports();
  let result;
  try { result = runtime.recordNativeRoleResult(root, callback(opened, { summary: 'Report', verdict: 'pass', findings: [],
    report_artifacts: [{ path: 'report.md', content: 'Backend report' }] })); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(result.completion, 'incomplete');
  assert.equal(result.report_artifact_issue, 'REPORT_CONTEXT_CHANGED');
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(join(root, 'user-added.tmp'), 'utf8'), 'An unrelated concurrent source');
  assert.equal(existsSync(ownedTemporary), false, 'The exact owned staging file is removed after failed authorization');
});

test('report artifacts are opt-in content and conflicting or malformed payloads never select a file body', () => {
  const first = { summary: 'Review', verdict: 'pass', findings: [], report_artifacts: [{ path: 'report.md', content: '# First\n' }] };
  const second = { ...first, report_artifacts: [{ path: 'report.md', content: '# Different\n' }] };
  const raw = JSON.stringify(first);
  assert.equal(runtime.parseNativeProfessionalReport(raw).report_artifacts, undefined, 'Default full-workflow parsing stays unchanged');
  assert.deepEqual(runtime.parseNativeProfessionalReport(raw, { report_artifacts: true }).report_artifacts, first.report_artifacts);
  assert.equal(runtime.parseNativeProfessionalReport(raw + '\n' + JSON.stringify(second), { report_artifacts: true }).report, undefined);
  assert.equal(runtime.parseNativeProfessionalReport(JSON.stringify({ ...first,
    report_artifacts: [{ path: 'report.md', content: 'Report', role: 'manager' }] }), { report_artifacts: true }).report, undefined);
});

test('each direct role saves only its scoped professional completion and never accepts the whole product', { timeout: 60000 }, t => {
  const root = project(t);
  writeFileSync(join(root, 'source.txt'), 'Original source');
  for (const role of runtime.nativeSpecialists) {
    const opened = runtime.openNativeRoleJob(root, { role, requirement: 'Inspect the supplied material in your assigned role.', context: ['source.txt'] });
    const saved = runtime.recordNativeRoleResult(root, callback(opened));
    assert.equal(saved.completion, 'role-completed');
    assert.equal(saved.accepted, false);
    assert.equal(runtime.getRecord(root, saved.request_ref).meta.status, 'draft');
    assert.match(saved.report_path, /WF-R\d{4}/);
    const view = runtime.nativeRoleListForMonitor(root).find(item => item.workflow_id === saved.request_ref);
    assert.equal(view.status, 'role-completed'); assert.equal(view.accepted, false);
    assert.equal(view.stages.find(stage => stage.id === 'acceptance').state, 'not-applicable');
    assert.equal(runtime.nativeRequestListForMonitor(root).length, 0, 'Direct jobs are not mixed into full request execution states');
  }
});

test('a live direct role describes running work while lost ownership remains an incomplete saved job', t => {
  const root = project(t);
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.P-RES', requirement: 'Inspect the current interfaces only.' });
  const ownership = { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref, agentName: opened.role };
  const projection = observed => runtime.nativeRoleListForMonitor(root, observed)[0];
  const saved = projection();
  assert.equal(saved.live, false); assert.equal(saved.accepted, false);
  assert.doesNotMatch(saved.current_action, /running in native Local chat/);
  const running = projection({ calls: [{ ...ownership, host_call_id: randomUUID() }] });
  assert.equal(running.status, 'working'); assert.equal(running.live, true);
  assert.equal(running.stages.find(stage => stage.id === 'architecture').state, 'running');
  assert.match(running.current_action, /WF\.P-RES running in native Local chat/);
  assert.doesNotMatch(running.current_action, /incomplete|uncertain|role-completed/);
  assert.equal(running.accepted, false);
  const queued = projection({ queued_calls: [ownership] });
  assert.match(queued.current_action, /queued/); assert.equal(queued.active_agents.length, 0);
  const lost = projection({ calls: [{ ...ownership, request_ref: 'another-request', host_call_id: randomUUID() }] });
  assert.deepEqual(lost, saved, 'An unrelated live call cannot provide ownership or running wording');
});

test('role callbacks remain idempotent after a lost state write and refuse other-job or changed outcomes', { timeout: 60000 }, t => {
  const root = project(t);
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Define acceptance criteria' });
  const folder = runtime.requestFolderForWorkflow(root, opened.request_ref);
  const path = join(root, '.workforce', folder.directory, 'native/role-job.json'), before = readFileSync(path);
  const outcome = callback(opened);
  const saved = runtime.recordNativeRoleResult(root, outcome), count = runtime.loadRecords(root).length;
  writeFileSync(path, before); // Simulate a lost final state write at the host seam.
  assert.equal(runtime.recordNativeRoleResult(root, outcome).report_path, saved.report_path);
  assert.equal(runtime.loadRecords(root).length, count);
  assert.throws(() => runtime.recordNativeRoleResult(root, { ...outcome, assignment_ref: 'another-job' }), /another job/);
  assert.throws(() => runtime.recordNativeRoleResult(root, { ...outcome, raw_result: 'changed result' }), /cannot be overwritten/);
  assert.equal(runtime.nativeRoleJobSchema.safeParse({ role: 'WF.SWSD', requirement: 'Review', assignment_ref: 'invented' }).success, false);
});

test('a completed independent review can deliver findings without pretending that the product passed', { timeout: 60000 }, t => {
  const root = project(t);
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review the current code only' });
  const saved = runtime.recordNativeRoleResult(root, callback(opened, { summary: 'Static review completed', verdict: 'findings', findings: ['A concrete correctness defect'] }));
  assert.equal(saved.completion, 'role-completed');
  assert.equal(saved.status, 'findings');
  assert.equal(saved.accepted, false);
  assert.equal(saved.report.verdict, 'findings');
  assert.deepEqual(saved.report.findings, ['A concrete correctness defect']);
  assert.match(readFileSync(join(root, saved.report_path), 'utf8'), /A concrete correctness defect/);
  const observation = runtime.nativeRoleListForMonitor(root)[0];
  assert.equal(observation.review.state, 'completed', 'The independent review finished; findings remain a professional result.');
  assert.equal(observation.accepted, false, 'Role completion does not accept the defective product.');
  assert.equal(observation.status, 'role-completed');
});

test('context edits during a read-only role and later report tampering invalidate scoped completion', { timeout: 60000 }, t => {
  const root = project(t), source = join(root, 'source.txt');
  writeFileSync(source, 'Original');
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review source', context: ['source.txt'] });
  writeFileSync(source, 'User edited concurrently');
  assert.equal(runtime.recordNativeRoleResult(root, callback(opened)).status, 'uncertain');
  const fresh = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review current source', context: ['source.txt'] });
  const saved = runtime.recordNativeRoleResult(root, callback(fresh));
  writeFileSync(join(root, saved.report_path), readFileSync(join(root, saved.report_path), 'utf8') + '\nChanged report content.\n');
  assert.equal(runtime.getNativeRoleJob(root, fresh.request_ref).completion, 'incomplete');
});

test('root context protects nested source and additions during or after a direct inspection', { timeout: 60000 }, t => {
  const root = project(t);
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review the workspace root', context: [root] });
  assert.deepEqual(opened.context, ['.']);
  const nested = join(root, 'nested');
  // This new file was absent when the reviewer received its scope.
  runtime.atomicWrite(join(nested, 'new.mjs'), 'export const newValue = 1;\n');
  assert.equal(runtime.recordNativeRoleResult(root, callback(opened)).completion, 'incomplete');
  const fresh = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Review the current workspace root', context: ['.'] });
  assert.equal(runtime.recordNativeRoleResult(root, callback(fresh)).completion, 'role-completed');
  runtime.atomicWrite(join(nested, 'another.mjs'), 'export const anotherValue = 2;\n');
  assert.equal(runtime.getNativeRoleJob(root, fresh.request_ref).completion, 'incomplete');
});

test('the direct-role adapter invokes the actual named role once and returns no invented full acceptance', { timeout: 60000 }, async t => {
  const root = project(t), calls = [], opaque = {};
  const vscode = { CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }, lm: { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
    properties: Object.fromEntries(['agentName', 'prompt', 'description'].map(key => [key, { type: 'string' }])) } }],
    async invokeTool(name, options) {
      assert.equal(name, 'runSubagent'); assert.equal(options.toolInvocationToken, opaque); calls.push(options.input);
      return { content: [{ value: JSON.stringify({ summary: 'Acceptance criteria from source', verdict: 'pass', findings: [] }) }] };
    } } };
  const runner = createLocalRequestRunner(vscode, runtime, root);
  t.after(() => runner.dispose());
  const result = await runner.role({ role: 'WF.SWSD', requirement: 'Analyze the requirement only' }, opaque);
  assert.equal(result.status, 'role-completed'); assert.equal(result.accepted, false);
  assert.equal(calls.length, 1); assert.equal(calls[0].agentName, 'WF.SWSD Worker');
  assert.equal(result.delivery_scope, 'role-only');
  assert.doesNotMatch(JSON.stringify(result), /assignment_ref|host_call_id|raw_result|request_ref/);
  let release, started, stopped = false;
  const pending = new Promise(resolve => { release = resolve; }), invoked = new Promise(resolve => { started = resolve; });
  vscode.lm.invokeTool = async () => { started(); return pending; }; // Simulate a late native response after cancellation.
  const running = runner.role({ role: 'WF.Tester', requirement: 'Inspect only' }, opaque);
  await invoked;
  const shutdown = runner.dispose().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'Shutdown waits for the actual native response to drain');
  release({ content: [{ value: JSON.stringify({ summary: 'Late report', verdict: 'pass', findings: [] }) }] });
  const interrupted = await running;
  assert.equal(interrupted.status, 'cancelled');
  assert.equal(interrupted.job.status, 'cancelled');
  assert.equal(interrupted.job.completion, 'incomplete');
  await shutdown;
});

test('role receipts retain actual hidden profiles, reject wrong role mappings and leave old receipts unchanged', t => {
  const root = project(t);
  const opened = runtime.openNativeRoleJob(root, { role: 'WF.Reviewer', requirement: 'Inspect only' });
  const outcome = callback(opened);
  assert.throws(() => runtime.recordNativeRoleResult(root, { ...outcome,
    invocation: { ...outcome.invocation, native_agent_name: 'WF.FnD Worker' } }), /actual owned role invocation/);
  outcome.invocation.native_agent_name = 'WF.Reviewer Worker';
  const current = runtime.recordNativeRoleResult(root, outcome);
  assert.equal(current.invocation.native_agent_name, 'WF.Reviewer Worker');
  const old = runtime.openNativeRoleJob(root, { role: 'WF.SWSD', requirement: 'Preserve the historical visible-profile provenance' });
  const saved = runtime.recordNativeRoleResult(root, callback(old));
  const bytes = readFileSync(join(root, saved.report_path));
  assert.equal(runtime.getNativeRoleJob(root, old.request_ref).invocation.native_agent_name, undefined);
  assert.deepEqual(readFileSync(join(root, saved.report_path)), bytes);
});
