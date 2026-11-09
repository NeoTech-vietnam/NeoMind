import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, requestFolderForWorkflow } from '../dist/storage.js';
import { openNativeRequest, planNativeRequest, nextNativeAssignment, recordNativeResult,
  nativeRequestListForMonitor, runNativeChecks, finishNativeRequest } from '../dist/native-request.js';

function fixture(t, title) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-monitor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-MONITOR' });
  const opened = openNativeRequest(root, { requirement: title });
  const state = planNativeRequest(root, opened.request_ref, { summary: title, requirements: ['Write hello'],
    design: 'A bounded text product', outputs: ['product.txt'], checks: [{ title: 'Exact contents', level: 'acceptance',
      command: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('product.txt','utf8'),'hello')"] }] });
  const path = join(root, '.workforce', requestFolderForWorkflow(root, state.request_ref).directory, 'native/execution.json');
  return { root, state, path };
}
function pass(root, ref, job) {
  return recordNativeResult(root, { request_ref: ref, assignment_ref: job.assignment_ref,
    invocation: { host_call_id: randomUUID(), transport: 'vscode-native', tool: 'runSubagent',
      agentName: job.agentName, invoked: true, status: 'returned' },
    raw_result: JSON.stringify({ summary: 'Observed role result', verdict: 'pass', findings: [] }) });
}

test('native projection requires current owned calls, correlates the exact assignment and remains read-only', { timeout: 60000 }, t => {
  const { root, state, path } = fixture(t, 'A request');
  const job = nextNativeAssignment(root, state.request_ref), before = readFileSync(path);
  const project = ownership => nativeRequestListForMonitor(root, ownership)[0];
  const coding = value => value.stages.find(stage => stage.id === 'coding').state;
  assert.equal(coding(project()), 'uncertain', 'Issued on disk alone is not a live model call');
  const call = { request_ref: state.request_ref, assignment_ref: job.assignment_ref, host_call_id: randomUUID(),
    agentName: 'WF.FnD', requested_model: { selection: 'explicit', id: 'chosen', vendor: 'example' } };
  assert.equal(coding(project({ calls: [{ ...call, request_ref: 'another-request' }] })), 'uncertain');
  assert.equal(coding(project({ calls: [{ ...call, assignment_ref: 'another-assignment' }] })), 'uncertain');
  const queued = { request_ref: state.request_ref, assignment_ref: job.assignment_ref, agentName: job.agentName };
  assert.equal(coding(project({ queued_calls: [{ ...queued, request_ref: 'another-request' }] })), 'uncertain');
  const waiting = project({ queued_calls: [queued] });
  assert.equal(coding(waiting), 'queued');
  assert.equal(waiting.status, 'working');
  assert.match(waiting.current_action, /queued/);
  assert.deepEqual(waiting.active_agents, [], 'A queued assignment is not a running model');
  const active = project({ calls: [call] });
  assert.equal(coding(active), 'running');
  assert.equal(active.active_agents[0].requested_model.id, 'chosen');
  assert.equal(active.active_agents[0].observed_provider, 'unknown');
  assert.equal(active.stages.find(stage => stage.id === 'acceptance').state, 'pending');
  assert.equal(active.stages.find(stage => stage.id === 'unit').state, 'not-applicable');
  assert.deepEqual(readFileSync(path), before, 'Projection never writes execution state');
  assert.doesNotMatch(JSON.stringify(active), /assignment_ref|host_call_id|raw_text|prompt/);
});

test('verification levels follow actual checks and stale artifacts invalidate completed stages', { timeout: 60000 }, async t => {
  const { root, state } = fixture(t, 'A verified request');
  writeFileSync(join(root, 'product.txt'), 'hello');
  for (let index = 0; index < 3; index++) pass(root, state.request_ref, nextNativeAssignment(root, state.request_ref));
  let view = nativeRequestListForMonitor(root)[0];
  assert.equal(view.review.state, 'completed');
  assert.equal(view.stages.find(stage => stage.id === 'acceptance').state, 'pending', 'A Tester report alone is not an executed check');
  await runNativeChecks(root, state.request_ref);
  finishNativeRequest(root, state.request_ref);
  const fs = createRequire(import.meta.url)('node:fs'), originalRead = fs.readFileSync;
  let productReads = 0;
  fs.readFileSync = (path, ...args) => {
    if (typeof path === 'string' && path.replaceAll('\\', '/').toLowerCase() === join(root, 'product.txt').replaceAll('\\', '/').toLowerCase()) productReads++;
    return originalRead(path, ...args);
  };
  syncBuiltinESMExports();
  try { view = nativeRequestListForMonitor(root)[0]; }
  finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  assert.equal(productReads, 1, 'A synchronous UI snapshot hashes each product once, even when several stages reference it');
  assert.equal(view.accepted, true);
  assert.equal(view.stages.find(stage => stage.id === 'acceptance').state, 'completed');
  assert.equal(view.evidence[0].exit_code, 0);
  assert.equal(view.stages.find(stage => stage.id === 'system').state, 'not-applicable');
  writeFileSync(join(root, 'added-source.mjs'), 'export const added = true;\n');
  view = nativeRequestListForMonitor(root)[0];
  assert.equal(view.accepted, false);
  assert.equal(view.review.state, 'uncertain', 'New context membership invalidates the displayed independent inspection');
  assert.equal(view.stages.find(stage => stage.id === 'acceptance').state, 'uncertain');
  rmSync(join(root, 'added-source.mjs'));
  writeFileSync(join(root, 'product.txt'), 'changed');
  view = nativeRequestListForMonitor(root)[0];
  assert.equal(view.accepted, false);
  assert.equal(view.status, 'changed');
  assert.equal(view.review.state, 'uncertain');
  assert.equal(view.stages.find(stage => stage.id === 'acceptance').state, 'uncertain');
  assert.equal(view.evidence[0].passed, false);
});
