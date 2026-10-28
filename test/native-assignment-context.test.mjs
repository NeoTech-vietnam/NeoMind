// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRecord, getRecord } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import * as assignments from '../dist/native-assignment.js';
import { openAssignment, assignmentContext, assignmentResult } from '../dist/assignment-runtime.js';
import { readAgentActivity } from '../dist/agent-activity.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-context-delegate-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'CONTEXT-DELEGATE', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, { requirement: 'Create two scoped Node automation scripts while preserving existing exercises.', execution_mode: 'copilot-native' });
  const packet = assignments.prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager',
    assignment_id: 'current-manager', objective: 'Coordinate this existing workflow with actual specialists and preserve its assigned engineering gates.' });
  return { root, workflow, manager: openAssignment(root, { packet: { id: packet.id, claim_token: packet.claim_token } }).handle };
}
const objective = 'Inspect the existing local script contracts and report actual bounded reuse opportunities.';

test('context delegation derives workflow, role and correlation without caller task IDs and deduplicates claimed work', t => {
  const { root, workflow, manager } = fixture(t);
  const input = { profile_id: 'architect', objective };
  const prepared = assignments.delegateAssignment(root, manager, input);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.packet.workflow_id, workflow.meta.id);
  assert.equal(prepared.packet.role, 'architect');
  assert.equal(prepared.packet.task_id, undefined);
  assert.equal(prepared.packet.handoff.agent, 'NeoMind Architect Agent');
  assert.deepEqual(assignments.delegateAssignment(root, manager, input).packet.open_input, prepared.packet.open_input);
  openAssignment(root, prepared.packet.open_input);
  const repeated = assignments.delegateAssignment(root, manager, input);
  assert.equal(repeated.status, 'wait_for_delegate');
  assert.equal(repeated.packet_id, prepared.packet.id);
  assert.equal(repeated.packet, undefined, 'A claimed credential is never reissued.');
  assert.throws(() => assignments.delegateAssignment(root, manager, { ...input, task_id: '' }), /unknown|task.*ID|protected/i);
});

test('task selectors are issued by backend and retain same-workflow task and per-role path boundaries', t => {
  const { root, workflow, manager } = fixture(t);
  const makeTask = title => createRecord(root, { type: 'task', owner: 'developer', title,
    data: { workflow_id: workflow.meta.id, allowed_paths: ['scripts'], implementation_paths: ['scripts/generate.mjs'], verification_paths: ['scripts/check.mjs'] } });
  const first = makeTask('First bounded script bundle'); makeTask('Second bounded script bundle');
  const ambiguous = assignments.delegateAssignment(root, manager, { profile_id: 'implementer', objective });
  assert.equal(ambiguous.status, 'needs_task_selection');
  assert.equal(ambiguous.task_options.length, 2);
  assert.equal(ambiguous.task_options.some(option => option.selector === first.meta.id), false);
  const selected = assignments.delegateAssignment(root, manager, { profile_id: 'implementer', objective, task_selector: ambiguous.task_options[0].selector });
  const opened = openAssignment(root, selected.packet.open_input);
  assert.equal(selected.packet.role, 'developer');
  assert.deepEqual(opened.context.allowed_paths, ['scripts/generate.mjs']);
  assert.deepEqual(opened.context.task_context.allowed_paths, ['scripts/generate.mjs']);
  const check = assignments.delegateAssignment(root, manager, { profile_id: 'verifier', objective, scope: 'task', task_selector: ambiguous.task_options[0].selector });
  assert.equal(check.packet.role, 'check-executor');
  const checker = openAssignment(root, check.packet.open_input);
  assert.deepEqual(checker.context.allowed_paths, ['scripts/check.mjs']);
  assert.deepEqual(checker.context.task_context.allowed_paths, ['scripts/check.mjs']);
  assert.throws(() => assignments.delegateAssignment(root, manager, { profile_id: 'implementer', objective, task_selector: first.meta.id }), /selector|selection/i);
});

test('absent optional selectors work for workflow and task delegation without weakening meaningful selections or credentials', t => {
  const { root, workflow, manager } = fixture(t);
  const control = assignments.delegateAssignment(root, manager, { profile_id: 'reviewer', scope: 'workflow', objective });
  assert.equal(control.status, 'prepared');
  for (const task_selector of ['', ' \t ', null]) {
    const prepared = assignments.delegateAssignment(root, manager, { profile_id: 'reviewer', scope: 'workflow', objective, task_selector });
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.packet_id, control.packet_id);
    assert.equal(prepared.packet.task_id, undefined);
  }
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Single actual bounded automation task',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['scripts'] } });
  for (const task_selector of ['', ' \t ', null]) {
    const prepared = assignments.delegateAssignment(root, manager, { profile_id: 'implementer', scope: 'task', objective, task_selector });
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.packet.task_id, task.meta.id);
  }
  const selector = assignments.assignmentTaskOptions(root, workflow.meta.id)[0].selector;
  assert.throws(() => assignments.delegateAssignment(root, manager, { profile_id: 'reviewer', scope: 'workflow', objective, task_selector: selector }), /workflow.*selector/i);
  assert.throws(() => assignments.delegateAssignment(root, manager, { profile_id: 'implementer', scope: 'task', objective, task_selector: ` ${selector} ` }), /selector.*unknown|foreign|incompatible/i);
  assert.throws(() => assignments.delegateAssignment(root, { ...manager, token: '' }, { profile_id: 'reviewer', scope: 'workflow', objective, task_selector: '' }), /invalid|unclaimed/i);
  createRecord(root, { type: 'task', owner: 'developer', title: 'Another actual bounded automation task',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['other-scripts'] } });
  for (const task_selector of ['', ' \t ', null]) {
    const unresolved = assignments.delegateAssignment(root, manager, { profile_id: 'implementer', scope: 'task', objective, task_selector });
    assert.equal(unresolved.status, 'needs_task_selection'); assert.equal(unresolved.task_options.length, 2);
  }
  const other = beginWorkflow(root, { requirement: 'Keep a separate task isolated from the current workflow delegation.', execution_mode: 'copilot-native' });
  createRecord(root, { type: 'task', owner: 'developer', title: 'Foreign workflow task', data: { workflow_id: other.meta.id, allowed_paths: ['foreign'] } });
  const foreign = assignments.assignmentTaskOptions(root, other.meta.id)[0].selector;
  assert.throws(() => assignments.delegateAssignment(root, manager, { profile_id: 'implementer', scope: 'task', objective, task_selector: foreign }), /selector.*unknown|foreign|incompatible/i);
});

test('opening/context lifecycle records one meaningful observation rather than repeated context heartbeats', t => {
  const { root, manager } = fixture(t);
  const prepared = assignments.prepareReportedAssignment(root, { workflow_id: assignments.resolveReportedAssignment(root, manager).workflow_id,
    profile_id: 'explorer', role: 'codebase-analyst', assignment_id: 'observe-context', objective });
  const session = openAssignment(root, { packet: { id: prepared.id, claim_token: prepared.claim_token } });
  const observations = () => readAgentActivity(root).events.filter(event => event.invocation_id === session.handle.id);
  assert.equal(observations().length, 1);
  assignmentContext(root, session.handle); assignmentContext(root, session.handle);
  assert.equal(observations().length, 1);
  const event = observations()[0];
  writeFileSync(join(root, '.neomind/runs/agent-activity', `${event.id}.json`),
    JSON.stringify({ ...event, observed_at: new Date(Date.now() - 600_000).toISOString() }) + '\n');
  assert.equal(readAgentActivity(root).latest.find(item => item.invocation_id === session.handle.id).state, 'unknown');
  assignmentContext(root, session.handle);
  assert.equal(observations().length, 1, 'Reading an expired context must not manufacture a fresh running observation.');
  assert.equal(readAgentActivity(root).latest.find(item => item.invocation_id === session.handle.id).state, 'unknown');
});

test('failed advisory telemetry never prevents durable substantive result and identical readback', t => {
  const { root, manager } = fixture(t);
  const prepared = assignments.prepareReportedAssignment(root, { workflow_id: assignments.resolveReportedAssignment(root, manager).workflow_id,
    profile_id: 'explorer', role: 'codebase-analyst', assignment_id: 'telemetry-result', objective });
  const session = openAssignment(root, { packet: { id: prepared.id, claim_token: prepared.claim_token } });
  const activity = join(root, '.neomind/runs/agent-activity');
  rmSync(activity, { recursive: true, force: true });
  mkdirSync(dirname(activity), { recursive: true }); writeFileSync(activity, 'Block only advisory telemetry storage.');
  const content = { schema_version: 1, outcome: 'completed', summary: 'Inspected the bounded local contract and reported actual source findings without executable claims.',
    inputs: ['Inspected the saved assignment objective and the current local script boundary.'],
    decisions: [{ decision: 'Preserve existing exercise content and use separate scoped automation files.', basis: 'The authorized requirement limits changes to repeatable mechanics and independent checks.' }],
    evidence_refs: [], evidence_notes: ['This source-inspection report records bounded findings; no compiler or production execution is claimed.'],
    limitations: ['Native process independence and model identity are not established by this local report.'],
    lessons: ['Scope and source applicability must be checked again before later execution.'] };
  const saved = assignmentResult(root, session.handle, content);
  assert.equal(getRecord(root, saved.report_id).meta.data.invocation_id, session.handle.id);
  assert.equal(saved.activity_event_id, null);
  assert.ok(saved.telemetry_warning);
  assert.deepEqual(assignmentResult(root, session.handle, content), saved);
  assert.equal(readFileSync(activity, 'utf8'), 'Block only advisory telemetry storage.');
});
