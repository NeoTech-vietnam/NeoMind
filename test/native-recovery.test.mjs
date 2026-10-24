import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initialize, createRecord, getRecord, updateRecord } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment, assignmentResult } from '../dist/assignment-runtime.js';
import { followUpNativeAssignment, inspectNativeAssignment } from '../dist/native-recovery.js';
import { assignmentReport } from '../dist/engineering.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-native-recovery-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'RECOVERY-TEST' }); ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, { requirement: 'Recover missing specialist output while preserving real partial artifacts and ownership.', execution_mode: 'copilot-native' });
  const prepare = (profile_id, role, assignment_id) => prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id, role, assignment_id,
    objective: 'Inspect the current bounded source contract and finish an evidence-backed independent assignment report.' });
  const managerPacket = prepare('coordinator', 'manager', 'coordinator');
  const manager = openAssignment(root, managerPacket.open_input).handle;
  const packet = prepare('planner', 'requirements', 'planner');
  const worker = openAssignment(root, packet.open_input).handle;
  return { root, workflow, manager, packet, worker };
}
const result = outcome => ({ schema_version: 1, outcome,
  summary: 'Inspected the scoped source contracts and recorded the actual supported planning conclusions.',
  inputs: ['Read the saved objective and source evidence before deriving the bounded planning conclusions.'],
  decisions: [{ decision: 'Preserve historical exercises and propose separate parameterized automation.', basis: 'The authorized change concerns repeated mechanics and requires independent final checks.' }],
  evidence_refs: [], evidence_notes: ['This report captures source inspection rather than unexecuted compiler or production results.'],
  limitations: ['Local assignment identity does not establish native process independence or model observations.'],
  lessons: ['Use fresh inspected inputs and independently checked expectations for later execution.'] });

test('unknown and running native observations cannot create a replacement or infer stopped work', t => {
  const { root, manager, packet } = fixture(t);
  const path = join(root, '.neomind/native/reported-assignments', `${packet.id}.json`), before = readFileSync(path);
  assert.equal(followUpNativeAssignment(root, manager, { packet_id: packet.id, observation: 'unknown', observation_id: 'actual-call-unknown' }).status, 'needs_observation');
  assert.equal(followUpNativeAssignment(root, manager, { packet_id: packet.id, observation: 'running', observation_id: 'actual-call-running' }).status, 'wait_for_delegate');
  assert.deepEqual(readFileSync(path), before);
});

test('terminal recovery preserves partial work, deduplicates callbacks and caps the entire lineage at two', t => {
  const { root, workflow, manager, packet } = fixture(t);
  const partial = createRecord(root, { type: 'knowledge', owner: 'requirements', title: 'Actual persisted partial planning findings',
    body: 'The inspected existing validator can be reused; no implementation result is claimed.',
    data: { workflow_id: workflow.meta.id, invocation_id: packet.id, kind: 'requirements-plan' } });
  const keyPath = join(root, '.neomind/native/reported-assignments/issuer.key'), key = readFileSync(keyPath);
  const oldPath = join(root, '.neomind/native/reported-assignments', `${packet.id}.json`), old = readFileSync(oldPath);
  const input = { packet_id: packet.id, observation: 'completed-without-output', observation_id: 'native-call-1' };
  const first = followUpNativeAssignment(root, manager, input);
  assert.equal(first.status, 'followup_prepared'); assert.equal(first.attempts, 1);
  assert.equal(first.root_packet_id, packet.id);
  assert.equal(first.followup.recovery.record_ids.includes(partial.meta.id), true);
  assert.equal(first.followup.objective, packet.objective);
  assert.deepEqual(followUpNativeAssignment(root, manager, input).followup.open_input, first.followup.open_input);
  openAssignment(root, first.followup.open_input);
  const repeated = followUpNativeAssignment(root, manager, input);
  assert.equal(repeated.status, 'wait_for_delegate'); assert.equal(repeated.followup_packet_id, first.followup.id);
  assert.equal(repeated.followup, undefined);
  const second = followUpNativeAssignment(root, manager, { packet_id: first.followup.id, observation: 'failed', observation_id: 'native-call-2' });
  assert.equal(second.status, 'followup_prepared'); assert.equal(second.attempts, 2);
  assert.equal(second.root_packet_id, packet.id);
  openAssignment(root, second.followup.open_input);
  assert.equal(followUpNativeAssignment(root, manager, { packet_id: second.followup.id, observation: 'cancelled', observation_id: 'native-call-3' }).status, 'recovery_exhausted');
  assert.deepEqual(readFileSync(oldPath), old); assert.deepEqual(readFileSync(keyPath), key);
  assert.equal(getRecord(root, partial.meta.id).body.includes('no implementation result'), true);
  assert.throws(() => followUpNativeAssignment(root, manager, { ...input, observation: 'failed' }), /observation.*different|conflict/i);
});

test('a valid completed typed result survives an empty callback while failed results do not establish completion', t => {
  const { root, manager, packet, worker } = fixture(t);
  const saved = assignmentResult(root, worker, result('completed'));
  assert.equal(inspectNativeAssignment(root, manager, packet.id).status, 'continue_workflow');
  const resumed = followUpNativeAssignment(root, manager, { packet_id: packet.id, observation: 'completed-without-output', observation_id: 'native-empty-after-save' });
  assert.equal(resumed.status, 'continue_workflow'); assert.equal(resumed.report_id, saved.report_id);
  const second = prepareReportedAssignment(root, { workflow_id: packet.workflow_id, profile_id: 'planner', role: 'requirements', assignment_id: 'blocked-planner', objective: packet.objective });
  const opened = openAssignment(root, second.open_input);
  assignmentResult(root, opened.handle, result('blocked'));
  assert.equal(inspectNativeAssignment(root, manager, second.id).status, 'awaiting_result');
  assert.equal(followUpNativeAssignment(root, manager, { packet_id: second.id, observation: 'unknown', observation_id: 'unobserved-blocked' }).status, 'needs_observation');
});

test('an actual terminal callback recovers a low-level-only report without discarding or treating it as completed', t => {
  const { root, workflow, manager, packet, worker } = fixture(t);
  const body = '# Objective\nInspect the bounded planning contract and preserve historical exercises.\n\n' +
    '# Inputs and Sources\nRead the current user objective and the saved workflow requirement.\n\n' +
    '# Decisions and Rationale\nKeep existing exercises unchanged because this increment concerns reusable mechanics.\n\n' +
    '# Results\nThe source review identifies an existing validator suitable for reuse; implementation remains pending.\n\n' +
    '# Evidence\nThis source inspection does not establish successful execution or acceptance.\n\n' +
    '# Limitations\nNo typed completion result or native model/process attestation was saved.\n\n' +
    '# Lessons\nReuse inspected tooling only after matching its inputs and independent checks.\n';
  const report = assignmentReport(root, { target_ids: [workflow.meta.id], role: packet.role,
    invocation_id: worker.id, assurance: packet.assurance, body });
  const before = getRecord(root, report.meta.id);
  assert.equal(inspectNativeAssignment(root, manager, packet.id).status, 'report_saved');
  const waiting = followUpNativeAssignment(root, manager, { packet_id: packet.id, observation: 'running', observation_id: 'legacy-running' });
  assert.equal(waiting.report_id, report.meta.id);
  const recovered = followUpNativeAssignment(root, manager, { packet_id: packet.id, observation: 'completed', observation_id: 'legacy-completed' });
  assert.equal(recovered.status, 'followup_prepared');
  assert.ok(recovered.followup.recovery.record_ids.includes(report.meta.id));
  assert.deepEqual(getRecord(root, report.meta.id), before);
  assert.equal(recovered.outcome, undefined);
});

test('typed completion readback rejects a changed substantive saved report', t => {
  const { root, manager, packet, worker } = fixture(t);
  const saved = assignmentResult(root, worker, result('completed'));
  const report = getRecord(root, saved.report_id);
  updateRecord(root, saved.report_id, {}, report.body.replace('recorded the actual supported planning conclusions', 'recorded different unsupported planning conclusions'));
  assert.throws(() => inspectNativeAssignment(root, manager, packet.id), /integrity|changed|baseline/i);
});
