// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite, safePath, getRecord, hash, loadRecords, createRecord, updateRecord, saveWorkflowClosure } from '../dist/storage.js';
import { beginWorkflow, discussWorkflow, finishWorkflow, nativeAutomationPolicy } from '../dist/manager.js';
import { delegateAssignment, prepareReportedAssignment } from '../dist/native-assignment.js';
import { openAssignment, assignmentContext, assignmentResult } from '../dist/assignment-runtime.js';
import { assignmentDocumentationProblems, verify, startTask, runCheck, reviewTask } from '../dist/engineering.js';
import { planNativeSoftware, nextNativeSoftware, readNativeSoftwareContract } from '../dist/native-software.js';
import { createCornellNote } from '../dist/notes.js';
import { cornellFixture } from './cornell-fixture.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = realpathSync(mkdtempSync(join(parent, 'neomind-software-')));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'SOFTWARE', profile: 'embedded', platforms: ['copilot'] });
  atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify(nativeAutomationPolicy()));
  const workflow = beginWorkflow(root, { requirement: 'Implement a documented named value equal to one using a dependency-free Node module, then verify its value independently.', execution_mode: 'copilot-native' });
  const manager = openAssignment(root, prepareInput(root, workflow.meta.id, 'coordinator', 'manager')).handle;
  const input = { process: 'software-tools', rationale: 'This increment changes only Node software and documentation; it has no device, circuit, timing or hardware interface changes.',
    title: 'Deliver documented integer one', objective: 'Export integer one from the module and document its public named import.',
    acceptance_criteria: ['src/value.mjs exports value equal to integer one.', 'docs/value.md explains the named import.'],
    allowed_paths: ['src/value.mjs', 'docs/value.md'], verification_paths: ['test/value.test.mjs'],
    outputs: ['src/value.mjs', 'docs/value.md'], documentation_paths: ['docs/value.md'],
    checks: [{ title: 'Independent named value and documentation assertion', command: [process.execPath, 'test/value.test.mjs'],
      baseline_paths: ['src/value.mjs', 'docs/value.md', 'test/value.test.mjs'] }] };
  return { root, workflow, manager, input };
}
function prepareInput(root, workflowId, profile, role, taskId) {
  const packet = prepareReportedAssignment(root, { workflow_id: workflowId, profile_id: profile, role,
    assignment_id: `fixture-${profile}-${role}`, objective: `Complete the bounded ${role} duties and persist a substantive own result with actual evidence.`, ...(taskId ? { task_id: taskId } : {}) });
  return packet.open_input;
}
function result(summary, extra = {}) {
  return { schema_version: 1, outcome: 'completed', summary,
    inputs: ['The original user requirement and bounded task acceptance clauses.'],
    decisions: [{ decision: 'Use the prescribed dependency-free module and independent assertion.', basis: 'A deterministic export contract needs no external package or network operation.' }],
    evidence_refs: [], evidence_notes: ['Actual files and actor actions are exercised by this local fixture; no native process or model identity is attested.'],
    limitations: ['The fixture represents actual local editor actions with isolated file writes; it does not invoke Copilot inference.'],
    lessons: ['Keep implementation ownership separate from independent verification and review.'], ...extra };
}
test('software-only plan derives backend records in embedded projects, preserves intent and is immutable/idempotent', t => {
  const { root, workflow, manager, input } = fixture(t), original = getRecord(root, workflow.meta.data.requirement_id).body;
  const inherited = ['Keep the Node export dependency-free and usable with a named import.'];
  updateRecord(root, workflow.meta.data.requirement_id, { data: { acceptance_criteria: inherited } });
  const planned = planNativeSoftware(root, manager, input), count = loadRecords(root).length;
  assert.equal(planned.process, 'software-tools'); assert.equal(planned.workflow_id, workflow.meta.id);
  assert.match(planned.task_id, /-TASK-/); assert.equal(planned.check_ids.length, 1);
  assert.equal(getRecord(root, workflow.meta.data.requirement_id).body, original);
  assert.deepEqual(getRecord(root, workflow.meta.data.requirement_id).meta.data.acceptance_criteria, inherited);
  assert.ok(getRecord(root, planned.task_id).meta.data.acceptance_criteria.includes(inherited[0]));
  assert.equal(getRecord(root, planned.check_ids[0]).meta.data.author_invocation_id, manager.id);
  assert.equal(verify(root, planned.task_id, 'design-ready').ok, true);
  assert.deepEqual(planNativeSoftware(root, manager, input), planned); assert.equal(loadRecords(root).length, count);
  assert.throws(() => planNativeSoftware(root, manager, { ...input, objective: 'A different substantive software objective that requires a new increment.' }), /immutable|different/i);
  assert.equal(loadRecords(root).some(r => ['design', 'manager-discussion'].includes(r.meta.type) || r.meta.data.kind === 'manager-discussion'), false);
  assert.equal(readNativeSoftwareContract(root, workflow.meta.id).task_id, planned.task_id);
  const journalPath = safePath(root, `.neomind/native/software-workflows/${hash(workflow.meta.id)}.plan.json`);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')); delete journal.output;
  atomicWrite(journalPath, JSON.stringify(journal));
  assert.deepEqual(planNativeSoftware(root, manager, input), planned, 'Interrupted output write reconciles the existing decision.');
  assert.equal(loadRecords(root).length, count);
  delete journal.output; atomicWrite(journalPath, JSON.stringify(journal));
  updateRecord(root, workflow.meta.id, { data: { phase: 'intake', decision_id: null } });
  assert.deepEqual(planNativeSoftware(root, manager, input), planned, 'Interrupted parent update reuses its exact actual decision.');
  assert.equal(loadRecords(root).length, count);
});
test('only sidecar-bound semantic records receive scoped exceptions; legacy tasks and strict history retain gates', t => {
  const { root, workflow, manager, input } = fixture(t), plan = planNativeSoftware(root, manager, input);
  const other = createRecord(root, { type: 'task', title: 'Unbound historical task', owner: 'developer',
    data: { workflow_id: workflow.meta.id, acceptance_criteria: input.acceptance_criteria, allowed_paths: ['legacy.mjs'] },
    links: [{ type: 'satisfies', target: workflow.meta.data.requirement_id }] });
  assert.ok(verify(root, other.meta.id, 'design-ready').findings.some(f => f.code === 'missing-hsi'));
  const strictWorkflow = beginWorkflow(root, { requirement: 'Retain signed engineering discipline for the existing strict device implementation.', execution_mode: 'strict' });
  updateRecord(root, strictWorkflow.meta.id, { data: { routing_required: true } });
  const strict = createRecord(root, { type: 'task', title: 'Strict history cannot inherit a native flag', owner: 'developer',
    data: { workflow_id: strictWorkflow.meta.id, routing_required: true, native_software_plan_hash: readNativeSoftwareContract(root, workflow.meta.id).plan_hash,
      acceptance_criteria: input.acceptance_criteria, allowed_paths: ['strict.mjs'] },
    links: [{ type: 'satisfies', target: strictWorkflow.meta.data.requirement_id }] });
  const strictFindings = verify(root, strict.meta.id, 'design-ready').findings;
  assert.ok(strictFindings.some(f => f.code === 'missing-hsi'));
  assert.ok(strictFindings.some(f => f.code === 'native-routing-missing'));
  updateRecord(root, plan.check_ids[0], { data: { command: [process.execPath, '-e', 'process.exit(0)'] } });
  assert.ok(verify(root, plan.task_id, 'design-ready').findings.some(f => f.code === 'software-contract-integrity'));
  assert.throws(() => nextNativeSoftware(root, manager, {}), /contract|baseline|changed/i);
});
test('software plan validates public disjoint scope and refuses protected inputs before record creation', t => {
  const { root, manager, input } = fixture(t), count = loadRecords(root).length;
  for (const invalid of [{ ...input, workflow_id: 'made-up' }, { ...input, allowed_paths: ['.neomind'] },
    { ...input, verification_paths: ['src/value.mjs'] }, { ...input, outputs: ['../escape.mjs'] },
    { ...input, checks: [{ ...input.checks[0], command: [process.execPath, '-e', 'process.exit(0)'] }] }]) {
    assert.throws(() => planNativeSoftware(root, manager, invalid));
    assert.equal(loadRecords(root).length, count);
  }
});
test('software controller selects its bound task while preserving public ambiguity for older same-workflow drafts', t => {
  const { root, workflow, manager, input } = fixture(t);
  const oldTask = createRecord(root, { type: 'task', title: 'Earlier same-workflow draft awaiting its own decision', owner: 'developer',
    links: [{ type: 'satisfies', target: workflow.meta.data.requirement_id }],
    data: { workflow_id: workflow.meta.id, acceptance_criteria: ['Preserve this earlier draft until its own applicable process is selected.'], allowed_paths: ['legacy.mjs'] } });
  const original = JSON.stringify(getRecord(root, oldTask.meta.id));
  const plan = planNativeSoftware(root, manager, input);
  const ambiguous = delegateAssignment(root, manager, { profile_id: 'implementer', scope: 'task',
    objective: 'Implement a bounded task only after the caller selects its actual backend-issued task option.' });
  assert.equal(ambiguous.status, 'needs_task_selection'); assert.equal(ambiguous.task_options.length, 2);
  const next = nextNativeSoftware(root, manager, {});
  assert.equal(next.status, 'prepared'); assert.equal(next.stage, 'implementation');
  assert.equal(next.packet.task_id, plan.task_id); assert.notEqual(next.packet.task_id, oldTask.meta.id);
  assert.equal(nextNativeSoftware(root, manager, {}).packet.id, next.packet.id);
  assert.equal(JSON.stringify(getRecord(root, oldTask.meta.id)), original);
});
test('software adoption retains unfinished old planning without imposing its report on the replacement process', t => {
  const { root, workflow, manager, input } = fixture(t);
  const planner = openAssignment(root, prepareInput(root, workflow.meta.id, 'planner', 'requirements')).handle;
  const old = discussWorkflow(root, workflow.meta.id, { role: 'requirements', invocation_id: planner.id,
    summary: 'Recorded an earlier planning assessment before the replacement software process was authorized.',
    rationale: 'This actor exhausted its native tool budget before saving its final report; that missing result must not be invented.', source_ids: [workflow.meta.data.requirement_id] });
  const oldNote = createCornellNote(root, cornellFixture(workflow.meta.id, workflow.meta.data.requirement_id));
  assert.equal(assignmentDocumentationProblems(root, workflow.meta.id).length, 1);
  const original = JSON.stringify(getRecord(root, old.meta.id));
  planNativeSoftware(root, manager, input);
  assert.deepEqual(assignmentDocumentationProblems(root, workflow.meta.id), []);
  assert.equal(JSON.stringify(getRecord(root, old.meta.id)), original);
  const contract = readNativeSoftwareContract(root, workflow.meta.id);
  assert.ok(contract.historical_planning.administrative_records.some(item => item.id === old.meta.id));
  assert.ok(contract.historical_planning.cornell_notes.some(item => item.id === oldNote.meta.id));
  assert.throws(() => finishWorkflow(root, workflow.meta.id, {}), /Software closure needs.*controller/i);
  const architect = openAssignment(root, prepareInput(root, workflow.meta.id, 'architect', 'architect')).handle;
  discussWorkflow(root, workflow.meta.id, { role: 'architect', invocation_id: architect.id,
    summary: 'A new post-contract discussion is not covered by the saved historical administration snapshot.',
    rationale: 'Current actors still owe their own actual reports; superseding old planning must not waive new obligations.', source_ids: [workflow.meta.data.requirement_id] });
  assert.equal(assignmentDocumentationProblems(root, workflow.meta.id).length, 1);
});
test('software verification ignores malformed historical planning and recovers a sealed partial plan without duplicate records', t => {
  const { root, workflow, manager, input } = fixture(t);
  const oldNote = createRecord(root, { type: 'knowledge', title: 'Malformed old Cornell planning metadata', owner: 'curator',
    links: [{ type: 'satisfies', target: workflow.meta.data.requirement_id }], data: { workflow_id: workflow.meta.id,
      format: 'cornell-v1', artifact_path: 'docs/not-created.md', demonstration: { evidence_ids: [] } } });
  const oldDesign = createRecord(root, { type: 'design', title: 'Earlier draft hardware-oriented design', owner: 'architect',
    links: [{ type: 'satisfies', target: workflow.meta.data.requirement_id }], data: { workflow_id: workflow.meta.id } });
  const oldCheck = createRecord(root, { type: 'check', title: 'Earlier unreviewed check plan', owner: 'verifier',
    links: [{ type: 'verifies', target: oldDesign.meta.id }], data: { workflow_id: workflow.meta.id,
      command: [process.execPath, '-e', 'process.exit(1)'], baseline_paths: ['never-created.mjs'] } });
  const originals = [oldNote, oldDesign, oldCheck].map(record => JSON.stringify(getRecord(root, record.meta.id)));
  const planned = planNativeSoftware(root, manager, input);
  assert.equal(verify(root, planned.task_id, 'design-ready').ok, true);
  const journalPath = safePath(root, `.neomind/native/software-workflows/${hash(workflow.meta.id)}.plan.json`);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')); delete journal.output; atomicWrite(journalPath, JSON.stringify(journal));
  updateRecord(root, workflow.meta.id, { data: { phase: 'intake', decision_id: null } });
  const count = loadRecords(root).length;
  const next = nextNativeSoftware(root, manager, {});
  assert.equal(next.stage, 'implementation'); assert.equal(next.status, 'prepared');
  assert.equal(getRecord(root, workflow.meta.id).meta.data.phase, 'execution');
  assert.equal(getRecord(root, workflow.meta.id).meta.data.decision_id, planned.decision_id);
  assert.equal(loadRecords(root).length, count);
  assert.deepEqual([oldNote, oldDesign, oldCheck].map(record => JSON.stringify(getRecord(root, record.meta.id))), originals);
  const full = createRecord(root, { type: 'task', title: 'Unbound full engineering task', owner: 'developer',
    links: [{ type: 'satisfies', target: workflow.meta.data.requirement_id }],
    data: { workflow_id: workflow.meta.id, acceptance_criteria: input.acceptance_criteria, allowed_paths: ['legacy.mjs'] } });
  assert.ok(verify(root, full.meta.id, 'design-ready').findings.some(finding => finding.code === 'invalid-link-type'));
  updateRecord(root, planned.task_id, { links: [...getRecord(root, planned.task_id).meta.links, { type: 'implements', target: oldDesign.meta.id }] });
  assert.ok(verify(root, planned.task_id, 'design-ready').findings.some(finding => finding.code === 'software-contract-integrity'));
});
test('software controller derives current stage and ignores same-workflow preflight callbacks without producer completion', t => {
  const { root, workflow, manager, input } = fixture(t); planNativeSoftware(root, manager, input);
  const preflight = prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id: 'reviewer', role: 'reviewer',
    assignment_id: 'preflight-reviewer', objective: 'Inspect the earlier administrative plan without claiming software implementation or acceptance.' });
  const first = nextNativeSoftware(root, manager, { observation: { packet_id: preflight.id, state: 'completed', observation_id: 'preflight-finished' } });
  assert.equal(first.status, 'prepared'); assert.equal(first.stage, 'implementation');
  const controllerPath = safePath(root, `.neomind/native/software-workflows/${hash(workflow.meta.id)}.controller.json`);
  const controller = JSON.parse(readFileSync(controllerPath, 'utf8'));
  assert.equal(controller.stages.implementation.terminal, undefined); assert.equal(controller.stages.review, undefined);
  assert.equal(nextNativeSoftware(root, manager, { observation: { state: 'completed', observation_id: 'preflight-finished' } }).packet.id, first.packet.id);
  assert.equal(JSON.parse(readFileSync(controllerPath, 'utf8')).stages.implementation.terminal, undefined);
  assert.equal(nextNativeSoftware(root, manager, { observation: null }).packet.id, first.packet.id);
  assert.equal(nextNativeSoftware(root, manager, { observation: { packet_id: '', state: 'running', observation_id: 'producer-running' } }).status, 'wait_for_delegate');
  const other = beginWorkflow(root, { requirement: 'Implement a different documented module under an independently bounded software increment.', execution_mode: 'copilot-native' });
  const foreign = prepareReportedAssignment(root, { workflow_id: other.meta.id, profile_id: 'reviewer', role: 'reviewer',
    assignment_id: 'foreign-reviewer', objective: 'Inspect a different workflow and never change the current controller stage or callback identity.' });
  assert.throws(() => nextNativeSoftware(root, manager, { observation: { packet_id: foreign.id, state: 'completed', observation_id: 'foreign-callback' } }), /another|foreign|same.workflow/i);
  assert.throws(() => nextNativeSoftware(root, manager, { observation: { packet_id: 'not-a-packet', state: 'completed', observation_id: 'invalid-packet' } }));
});
test('closed software workflows never report clean completion with persisted or effective blockers', t => {
  const { root, workflow, manager, input } = fixture(t); planNativeSoftware(root, manager, input);
  const report = createRecord(root, { type: 'knowledge', title: 'Incomplete observed closure fixture', owner: 'manager',
    data: { workflow_id: workflow.meta.id }, body: 'This fixture deliberately preserves an unresolved closure and never claims actual accepted engineering work.\n' });
  saveWorkflowClosure(root, workflow.meta.id, { data: { phase: 'completed-with-blockers', final_report_id: report.meta.id } }, () => {});
  const count = loadRecords(root).length;
  const blocked = nextNativeSoftware(root, manager, {});
  assert.equal(blocked.status, 'workflow_closed_with_blockers'); assert.equal(blocked.persisted_phase, 'completed-with-blockers');
  assert.notEqual(blocked.phase, 'completed');
  saveWorkflowClosure(root, workflow.meta.id, { data: { phase: 'completed' } }, () => {});
  const inconsistent = nextNativeSoftware(root, manager, {});
  assert.equal(inconsistent.status, 'workflow_closed_with_blockers'); assert.equal(inconsistent.persisted_phase, 'completed');
  assert.equal(inconsistent.phase, 'execution'); assert.ok(inconsistent.task_findings.length > 0);
  assert.equal(loadRecords(root).length, count);
});
test('explicit local applicability preserves original criteria and gives long plans compact role-correct handoffs', async t => {
  const { applyNativeSoftwareApplicability, effectiveNativeSoftwareCriteria } = await import('../dist/native-software.js');
  assert.equal(typeof applyNativeSoftwareApplicability, 'function');
  const { root, workflow, manager, input } = fixture(t);
  const ceremony = 'Execute independent checks and negative controls; have a separate reviewer approve the exact checker bytes before the first prescribed check, then independently review the captured final evidence.';
  input.acceptance_criteria.push(ceremony, ...Array.from({ length: 22 }, (_, index) => `Behavior ${index + 1}: ${'Preserve documented inputs, boundary cases, deterministic outputs and measured actual checks. '.repeat(5)}`));
  input.objective = 'Deliver the saved documented export and its bounded acceptance behavior. '.repeat(95);
  createRecord(root, { type: 'design', title: 'Earlier verbose planning record', owner: 'architect',
    body: 'Historical unrelated design commentary. '.repeat(2000), links: [{ type: 'satisfies', target: workflow.meta.data.requirement_id }], data: { workflow_id: workflow.meta.id } });
  const planned = planNativeSoftware(root, manager, input), beforeRequirement = JSON.stringify(getRecord(root, workflow.meta.data.requirement_id));
  const contractPath = safePath(root, `.neomind/native/software-workflows/${hash(workflow.meta.id)}.contract.json`), beforeContract = readFileSync(contractPath, 'utf8');
  const replacement = 'Execute the actual independent checks and semantic negative controls against the frozen checker and captured implementation bytes, then obtain independent final review of those actual results; no separate pre-execution approval ceremony is required.';
  const policyInput = { authorization_reference: 'Latest explicit human instruction to reduce administrative gates for this supporting software increment.',
    rationale: 'Replace only the exact historical administrative approval clause while preserving behavioral acceptance, independent verification, semantic negative controls and final independent review.',
    criteria: [{ original_text: ceremony, original_sha256: hash(ceremony), replacement_text: replacement,
      retained_obligations: ['behavioral-acceptance', 'independent-verification', 'negative-controls', 'independent-final-review'] }] };
  assert.throws(() => applyNativeSoftwareApplicability(root, { workflow_id: workflow.meta.id, authority: 'local-administration' }, {
    ...policyInput, criteria: [{ ...policyInput.criteria[0], original_sha256: '0'.repeat(64) }] }));
  const policy = applyNativeSoftwareApplicability(root, { workflow_id: workflow.meta.id, authority: 'local-administration' }, policyInput);
  assert.equal(policy.declared_by.kind, 'local-administration'); assert.equal(policy.declared_by.actor_id, undefined);
  assert.deepEqual(applyNativeSoftwareApplicability(root, { workflow_id: workflow.meta.id, authority: 'local-administration' }, policyInput), policy);
  assert.equal(readFileSync(contractPath, 'utf8'), beforeContract); assert.equal(JSON.stringify(getRecord(root, workflow.meta.data.requirement_id)), beforeRequirement);
  const contract = readNativeSoftwareContract(root, workflow.meta.id), effective = effectiveNativeSoftwareCriteria(root, contract);
  assert.ok(effective.acceptance_criteria.includes(replacement)); assert.ok(!effective.acceptance_criteria.includes(ceremony));
  assert.equal(effective.acceptance_criteria.length, contract.plan.acceptance_criteria.length);
  const implementation = nextNativeSoftware(root, manager, {});
  assert.ok(implementation.packet.objective.length < 4000);
  const developer = openAssignment(root, implementation.packet.open_input);
  assert.equal(developer.context.task_context.role_path, '.neomind/roles/developer.md');
  assert.ok(developer.context.task_context.acceptance_criteria.includes(replacement));
  assert.equal(developer.context.task_context.inputs.some(record => record.type === 'design'), false);
  startTask(root, planned.task_id, undefined, undefined, developer.handle.id);
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nThe documented named import returns integer one.\n');
  assignmentResult(root, developer.handle, result('Implemented the documented named integer one module under the complete saved long contract; independent acceptance execution remains pending.', {
    changes: [{ path: 'src/value.mjs', description: 'Actual named value module.' }, { path: 'docs/value.md', description: 'Actual import documentation.' }], submit_task: true }));
  const verification = nextNativeSoftware(root, manager, { observation: { state: 'completed', observation_id: 'long-producer-completed' } });
  assert.equal(verification.stage, 'verification'); assert.ok(verification.packet.objective.length < 4000);
  const executor = openAssignment(root, verification.packet.open_input);
  assert.equal(executor.context.task_context.role_path, '.neomind/roles/check-executor.md');
  assert.deepEqual(executor.context.task_context.allowed_paths, input.verification_paths);
  assert.deepEqual(executor.context.task_context.verification_procedures.map(check => check.id), planned.check_ids);
  assert.ok(JSON.stringify(executor.context.task_context).length < 30000);
});
test('software controller requires real delegate completion, checked evidence and independent review before one Cornell handoff', t => {
  const { root, workflow, manager, input } = fixture(t);
  const oldTask = createRecord(root, { type: 'task', title: 'Earlier same-workflow software draft remains separate', owner: 'developer',
    links: [{ type: 'satisfies', target: workflow.meta.data.requirement_id }],
    data: { workflow_id: workflow.meta.id, acceptance_criteria: ['Keep this unfinished draft separate from the current implementation and repair.'], allowed_paths: ['legacy.mjs'] } });
  const oldTaskBefore = JSON.stringify(getRecord(root, oldTask.meta.id));
  const oldPlanningInput = cornellFixture(workflow.meta.id, workflow.meta.data.requirement_id);
  oldPlanningInput.path = 'docs/planning/value.md'; oldPlanningInput.practice.exercise_path = 'docs/planning/exercises.md';
  oldPlanningInput.practice.answer_path = 'docs/planning/answers.md';
  const oldPlanningNote = createCornellNote(root, oldPlanningInput);
  const plan = planNativeSoftware(root, manager, input);
  const implementation = nextNativeSoftware(root, manager, {});
  assert.equal(implementation.stage, 'implementation'); assert.equal(implementation.status, 'prepared');
  assert.equal(implementation.packet.task_id, plan.task_id);
  assert.equal(implementation.packet.state, 'prepared');
  assert.equal(nextNativeSoftware(root, manager, {}).packet.id, implementation.packet.id);
  assert.equal(nextNativeSoftware(root, manager, { observation: { packet_id: implementation.packet.id, state: 'running', observation_id: 'running-1' } }).status, 'wait_for_delegate');
  const developer = openAssignment(root, implementation.packet.open_input).handle;
  startTask(root, plan.task_id, undefined, undefined, developer.id);
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'docs'), { recursive: true }); mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 0;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nUse import { value } from the named module to obtain integer one.\n');
  assignmentResult(root, developer, result('Implemented the named export module and documented its public import; independent acceptance execution is still pending.', {
    changes: [{ path: 'src/value.mjs', description: 'Initial named export implementation pending independent checks.' }, { path: 'docs/value.md', description: 'Public import documentation.' }], submit_task: true }));
  assert.equal(nextNativeSoftware(root, manager, {}).status, 'needs_observation');
  const verification = nextNativeSoftware(root, manager, { observation: { packet_id: implementation.packet.id, state: 'completed', observation_id: 'finished-1' } });
  assert.equal(verification.stage, 'verification'); assert.equal(verification.packet.role, 'check-executor');
  assert.equal(verification.packet.task_id, plan.task_id);
  assert.equal(nextNativeSoftware(root, manager, { observation: { state: 'completed', observation_id: 'finished-1' } }).packet.id, verification.packet.id);
  assert.equal(JSON.parse(readFileSync(safePath(root, `.neomind/native/software-workflows/${hash(workflow.meta.id)}.controller.json`), 'utf8')).stages.verification.terminal, undefined);
  const verifier = openAssignment(root, verification.packet.open_input).handle;
  assert.throws(() => runCheck(root, plan.check_ids[0], plan.task_id, developer.id), /independent|executor/i);
  writeFileSync(join(root, 'test/value.test.mjs'), 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; import {value} from "../src/value.mjs"; assert.equal(value,1); assert.match(readFileSync("docs/value.md","utf8"),/import/); console.log("independent assertion passed");\n');
  const failedEvidence = runCheck(root, plan.check_ids[0], plan.task_id, verifier.id);
  assert.notEqual(failedEvidence.meta.data.exit_code, 0);
  assignmentResult(root, verifier, result('The independent assertion actually failed: the delivered value is zero while the requirement specifies integer one.', {
    outcome: 'failed', evidence_refs: [failedEvidence.meta.id], changes: [{ path: 'test/value.test.mjs', description: 'Independent acceptance assertion exposing the actual implementation defect.' }] }));
  const repair = nextNativeSoftware(root, manager, { observation: { packet_id: verification.packet.id, state: 'completed', observation_id: 'failed-verification' } });
  assert.equal(repair.status, 'prepared'); assert.equal(repair.stage, 'implementation');
  assert.equal(repair.packet.profile_id, 'debugger'); assert.equal(repair.repair_attempt, 1);
  assert.equal(repair.packet.task_id, plan.task_id);
  assert.equal(JSON.stringify(getRecord(root, oldTask.meta.id)), oldTaskBefore);
  assert.equal(getRecord(root, plan.task_id).meta.status, 'ready');
  assert.equal(loadRecords(root).find(record => record.meta.id === failedEvidence.meta.id).meta.data.result, 'fail');
  const debuggerHandle = openAssignment(root, repair.packet.open_input).handle;
  startTask(root, plan.task_id, undefined, undefined, debuggerHandle.id);
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  assignmentResult(root, debuggerHandle, result('Repaired the observed off-by-one export defect by returning exactly integer one, preserving the original public import.', {
    changes: [{ path: 'src/value.mjs', description: 'Corrected named export after actual independent assertion failure.' }], submit_task: true }));
  const repeatedVerification = nextNativeSoftware(root, manager, { observation: { packet_id: repair.packet.id, state: 'completed', observation_id: 'finished-debugger' } });
  assert.equal(repeatedVerification.stage, 'verification'); assert.notEqual(repeatedVerification.packet.id, verification.packet.id);
  const omittedVerifier = openAssignment(root, repeatedVerification.packet.open_input).handle;
  assignmentResult(root, omittedVerifier, result('Inspected the preserved verification script but omitted its actual command execution; the acceptance run has not yet been collected.'));
  const verifierFollowup = nextNativeSoftware(root, manager, { observation: { packet_id: repeatedVerification.packet.id, state: 'completed', observation_id: 'verification-omitted' } });
  assert.equal(verifierFollowup.status, 'followup_prepared'); assert.equal(verifierFollowup.stage, 'verification');
  assert.notEqual(verifierFollowup.packet.id, repeatedVerification.packet.id);
  const currentVerifier = openAssignment(root, verifierFollowup.packet.open_input).handle;
  const evidence = runCheck(root, plan.check_ids[0], plan.task_id, currentVerifier.id);
  assert.equal(evidence.meta.data.exit_code, 0);
  assignmentResult(root, currentVerifier, result('Rechecked the preserved independent assertion against the repaired implementation and documentation; the actual command now exited zero.', {
    evidence_refs: [evidence.meta.id], changes: [{ path: 'test/value.test.mjs', description: 'Independent executable acceptance assertion.' }] }));
  const review = nextNativeSoftware(root, manager, { observation: { packet_id: verifierFollowup.packet.id, state: 'completed', observation_id: 'finished-2' } });
  assert.equal(review.stage, 'review'); const omittedReviewer = openAssignment(root, review.packet.open_input).handle;
  assignmentResult(root, omittedReviewer, result('Inspected the delivered implementation and passing evidence but omitted the actual task acceptance review operation.', { evidence_refs: [evidence.meta.id] }));
  const reviewerFollowup = nextNativeSoftware(root, manager, { observation: { packet_id: review.packet.id, state: 'completed', observation_id: 'review-omitted' } });
  assert.equal(reviewerFollowup.status, 'followup_prepared'); assert.equal(reviewerFollowup.stage, 'review');
  const reviewer = openAssignment(root, reviewerFollowup.packet.open_input).handle;
  assert.throws(() => reviewTask(root, plan.task_id, 'reviewer', 'pass', [], currentVerifier.id), /independent|verification|executor/i);
  reviewTask(root, plan.task_id, 'reviewer', 'pass', [], reviewer.id);
  const report = assignmentResult(root, reviewer, result('Independently reviewed the submitted code, documentation, verification script and actual passing evidence with no remaining findings.', { evidence_refs: [evidence.meta.id] }));
  const cornell = nextNativeSoftware(root, manager, { observation: { packet_id: reviewerFollowup.packet.id, state: 'completed', observation_id: 'finished-3' } });
  assert.equal(cornell.status, 'ready_for_cornell'); assert.equal(cornell.cornell.workflow_id, workflow.meta.id);
  assert.deepEqual(cornell.cornell.note_ids, []);
  assert.ok(cornell.cornell.requirement_ids.includes(workflow.meta.data.requirement_id));
  assert.ok(cornell.cornell.report_ids.includes(report.report_id)); assert.ok(cornell.cornell.evidence_ids.includes(evidence.meta.id));
  assert.ok(!cornell.cornell.evidence_ids.includes(failedEvidence.meta.id));
  assert.ok(cornell.cornell.prior_evidence_ids.includes(failedEvidence.meta.id));
  assert.equal(cornell.cornell.previous_cycles.length, 1);
  assert.equal(cornell.cornell.worker_notes_required, false);
  assert.equal(verify(root, plan.task_id, 'accepted').ok, true);
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  const close = { no_lesson_reason: 'This isolated fixture repeats the existing named-export method and does not establish a new public reusable engineering lesson.' };
  assert.throws(() => finishWorkflow(root, workflow.meta.id, close), /Cornell/i);
  const noteInput = cornellFixture(workflow.meta.id, workflow.meta.data.requirement_id);
  noteInput.demonstration.observed = 'The actual independent Node check exited zero against the captured module, documentation and assertion script.';
  noteInput.demonstration.evidence_ids = [evidence.meta.id];
  const note = createCornellNote(root, noteInput);
  assert.equal(nextNativeSoftware(root, manager, {}).status, 'ready_for_closure');
  const closed = finishWorkflow(root, workflow.meta.id, close);
  assert.equal(closed.cornell_notes[0].id, note.meta.id);
  assert.equal(closed.cornell_notes.length, 1);
  assert.match(closed.final_report, /missing old actor reports are not retrospectively completed/i);
  assert.ok(closed.final_report.includes(oldPlanningNote.meta.id));
  assert.equal(nextNativeSoftware(root, manager, {}).status, 'completed');
  assert.equal(loadRecords(root).filter(record => record.meta.data.format === 'cornell-v1').length, 2);
});
