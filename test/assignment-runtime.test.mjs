import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, getRecord, createRecord, loadRecords, updateRecord } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { readAgentActivity } from '../dist/agent-activity.js';
import { openAssignment, assignmentContext, assignmentProgress, assignmentResult, AssignmentRuntimeError } from '../dist/assignment-runtime.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-assignment-runtime-'));
  initialize(root, { project_id: 'ASSIGNMENT-RUNTIME', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const workflow = beginWorkflow(root, { requirement: 'Inspect the actual export and preserve its bounded assignment observations.', execution_mode: 'copilot-native' });
  return { root, workflow };
}
function packet(root, workflow, override = {}) {
  return prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id: 'researcher', role: 'researcher',
    assignment_id: 'inspect-value', objective: 'Inspect the assigned integer source and distinguish source observations from runtime execution evidence.', ...override });
}
function open(root, prepared) { return openAssignment(root, { packet: { id: prepared.id, claim_token: prepared.claim_token } }); }
function content(override = {}) {
  return { schema_version: 1, outcome: 'completed', summary: 'Inspected the actual source export and documented the bounded observed interface.',
    inputs: ['Read the assigned source file and current saved workflow requirements before selecting the procedure.'],
    decisions: [{ decision: 'Retain the existing integer export without adding an external library.', basis: 'The inspected source has a direct named integer export and no additional dependency.' }],
    evidence_refs: [], evidence_notes: ['Source inspection established the reported export contract; no executable verification result is claimed.'],
    limitations: ['This unsigned local assignment does not attest a native model, process identity or independent execution.'],
    lessons: ['Reuse this inspection procedure for bounded exports when the same source and dependency assumptions hold.'], ...override };
}

test('opening a real packet solves the KNW-0061 bootstrap without accepting labels, blank credentials or partial sessions', t => {
  const { root, workflow } = fixture(t), prepared = packet(root, workflow);
  assert.throws(() => openAssignment(root, { packet: { id: prepared.assignment_id, claim_token: '' } }),
    error => error instanceof AssignmentRuntimeError && error.code === 'AUTH_REQUIRED');
  assert.throws(() => openAssignment(root, { credential: { id: '', token: '' } }), /complete server-issued/);
  assert.throws(() => openAssignment(root, { credential: { id: prepared.id } }), /complete server-issued/);
  assert.throws(() => openAssignment(root, { packet: { id: prepared.id, claim_token: prepared.claim_token }, credential: { id: '', token: '' } }), /exactly one/);
  const session = open(root, prepared);
  assert.match(session.handle.id, /^local-report-/);
  assert.equal(session.context.assignment_id, 'inspect-value');
  assert.equal(session.context.assurance, 'unsigned-local-assignment');
  assert.deepEqual(Object.keys(session.handle).sort(), ['id', 'token']);
  assert.equal(JSON.stringify(session.context).includes(session.handle.token), false);
  assert.equal(openAssignment(root, { credential: session.handle }).context.invocation_id, session.handle.id);
});

test('explicit private handles keep concurrent actors separate and derive activity task/workflow scope', t => {
  const { root, workflow } = fixture(t);
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Bounded implementation output',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['src'] } });
  const first = open(root, packet(root, workflow));
  const second = open(root, packet(root, workflow, { assignment_id: 'inspect-task', task_id: task.meta.id }));
  assignmentProgress(root, first.handle, { state: 'running', summary: 'Inspecting the current workflow source contracts.' });
  const event = assignmentProgress(root, second.handle, { state: 'running', summary: 'Inspecting the actual bounded task source contracts.' });
  assert.equal(event.workflow_id, workflow.meta.id); assert.equal(event.task_id, task.meta.id);
  assert.equal(event.assignment_id, 'inspect-task'); assert.equal(event.invocation_id, second.handle.id);
  assert.equal(assignmentContext(root, first.handle).task_id, null);
  assert.equal(assignmentContext(root, second.handle).task_id, task.meta.id);
  assert.equal(readAgentActivity(root).latest.length, 2);
  assert.throws(() => assignmentProgress(root, first.handle,
    { state: 'running', summary: 'Attempt to spoof a task binding.', task_id: task.meta.id }), /protected assignment fields/);
});

test('typed substantive results render seven sections, persist honestly, and return the same result on retry', t => {
  const { root, workflow } = fixture(t), session = open(root, packet(root, workflow));
  const before = loadRecords(root).length;
  assert.throws(() => assignmentResult(root, session.handle, content({ inputs: [] })), /Inputs and Sources.*substantive/);
  const result = assignmentResult(root, session.handle, content());
  const report = getRecord(root, result.report_id);
  assert.equal(report.meta.owner, 'researcher'); assert.equal(report.meta.data.invocation_id, session.handle.id);
  assert.equal(report.meta.data.identity_assurance, 'unsigned-local-assignment');
  for (const section of ['Objective', 'Inputs and Sources', 'Decisions and Rationale', 'Results', 'Evidence', 'Limitations', 'Lessons'])
    assert.ok(report.body.includes(`# ${section}\n`));
  assert.equal(result.submitted_task_id, null); assert.equal(result.outcome, 'completed');
  assert.equal(getRecord(root, workflow.meta.id).meta.data.phase, 'intake');
  assert.deepEqual(assignmentResult(root, session.handle, content()), result);
  assert.equal(loadRecords(root).length, before + 1);
  assert.throws(() => assignmentResult(root, session.handle, content({ summary: 'A different result must use a new bounded assignment for fresh attribution.' })),
    error => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('result rejects protected fields, fabricated evidence, cross-workflow evidence and task submission impersonation', t => {
  const { root, workflow } = fixture(t), session = open(root, packet(root, workflow));
  const before = loadRecords(root).length;
  assert.throws(() => assignmentResult(root, session.handle, content({ owner: 'manager' })), /protected assignment fields/);
  assert.throws(() => assignmentResult(root, session.handle, content({ evidence_refs: [workflow.meta.id] })), /actual stored evidence/);
  const other = beginWorkflow(root, { requirement: 'Keep evidence from another workflow separate and correctly attributed.', execution_mode: 'copilot-native' });
  const foreign = createRecord(root, { type: 'evidence', title: 'Unrelated source observation', owner: 'check-executor', data: { workflow_id: other.meta.id, result: 'pass' } });
  assert.throws(() => assignmentResult(root, session.handle, content({ evidence_refs: [foreign.meta.id] })), /escapes its native workflow/);
  assert.throws(() => assignmentResult(root, session.handle, content({ submit_task: true })), /assigned producer task/);
  assert.equal(loadRecords(root).filter(record => record.meta.data.kind === 'work-record').length, 0);
  assert.ok(loadRecords(root).length > before, 'Only explicit unrelated fixture records were added.');
});

test('artifact checks enforce real files and assigned paths, then submit through the existing producer lifecycle', t => {
  const { root, workflow } = fixture(t);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Implement the bounded integer export',
    status: 'in-progress', data: { workflow_id: workflow.meta.id, allowed_paths: ['src'], documentation_required: true } });
  const session = open(root, packet(root, workflow, { profile_id: 'implementer', role: 'developer',
    assignment_id: 'implement-value', task_id: task.meta.id }));
  // Fixture setup binds the real claimed producer. Task readiness is exercised by engineering-cycle tests.
  updateRecord(root, task.meta.id, { data: { invocation_id: session.handle.id } });
  assert.throws(() => assignmentResult(root, session.handle, content({ changes: [{ path: 'package.json', description: 'An unrelated path must be denied.' }] })), /outside the assigned task/);
  assert.throws(() => assignmentResult(root, session.handle, content({ changes: [{ path: 'src/../secret.txt', description: 'An escaping artifact must be denied.' }] })), /canonical project-relative/);
  const result = assignmentResult(root, session.handle, content({ submit_task: true,
    changes: [{ path: 'src/value.mjs', description: 'Implemented the bounded named integer export in the assigned module.' }] }));
  assert.match(result.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.submitted_task_id, task.meta.id);
  assert.equal(getRecord(root, task.meta.id).meta.status, 'submitted');
  const retryInput = content({ submit_task: true,
    changes: [{ path: 'src/value.mjs', description: 'Implemented the bounded named integer export in the assigned module.' }] });
  assert.deepEqual(assignmentResult(root, session.handle, retryInput), result);
  // Simulate a crash after task submission but before the final output receipt is committed.
  const journalPath = join(root, `.neomind/native/assignment-runtime/${session.handle.id}.json`);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')); delete journal.output;
  writeFileSync(journalPath, JSON.stringify(journal));
  const recordCount = loadRecords(root).length;
  const recovered = assignmentResult(root, session.handle, retryInput);
  assert.equal(recovered.report_id, result.report_id);
  assert.equal(loadRecords(root).length, recordCount, 'Recovery must not duplicate the report or producer work record.');
  const recoveredJournal = JSON.parse(readFileSync(journalPath, 'utf8')); delete recoveredJournal.output;
  writeFileSync(journalPath, JSON.stringify(recoveredJournal));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2;\n');
  assert.throws(() => assignmentResult(root, session.handle, retryInput), error => error.code === 'STALE_BASELINE');
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
});

test('blocked and failed producer reports ignore a contradictory submission flag without losing findings or submitting work', t => {
  for (const outcome of ['blocked', 'failed']) {
    const { root, workflow } = fixture(t);
    const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Preserve incomplete producer findings',
      status: 'in-progress', data: { workflow_id: workflow.meta.id, allowed_paths: ['src'] } });
    const session = open(root, packet(root, workflow, { profile_id: 'implementer', role: 'developer',
      assignment_id: `incomplete-${outcome}`, task_id: task.meta.id }));
    updateRecord(root, task.meta.id, { data: { invocation_id: session.handle.id } });
    const saved = assignmentResult(root, session.handle, content({ outcome, submit_task: true }));
    assert.equal(saved.outcome, outcome);
    assert.equal(saved.submitted_task_id, null);
    assert.equal(getRecord(root, task.meta.id).meta.status, 'in-progress');
    assert.equal(getRecord(root, saved.report_id).meta.data.kind, 'work-record');
    assert.deepEqual(assignmentResult(root, session.handle, content({ outcome, submit_task: false })), saved);
  }
});
