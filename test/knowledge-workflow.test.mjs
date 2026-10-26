import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import {
  initialize, installProject, ensureRoutingPolicy, beginWorkflow, discussWorkflow,
  decideWorkflow, finishWorkflow, workflowStatus, createRecord, updateRecord, getRecord, loadRecords,
  reviewRecord, recordFingerprint, startTask, resumeTask, runCheck, archiveEvidence, submitTask,
  reviewTask, assignmentReport, createCornellNote, hash,
} from '../dist/index.js';
import { recordKnowledgeResearch, searchProjectKnowledge } from '../dist/knowledge-reuse.js';
import { prepareProjectKnowledge, publishProjectKnowledge } from '../dist/project-knowledge.js';
import { defaultAutomationPolicy, nativeAutomationPolicy, readAutomationPolicy } from '../dist/manager.js';
import { cornellFixture } from './cornell-fixture.mjs';

const repository = 'example/shared';
const classification = { platforms: [process.platform], frameworks: ['Node.js'] };
const query = 'documented integer named export';
const body = '# Objective\nDeliver a documented integer export with reproducible verification.\n\n# Inputs and Sources\nInspected the saved requirement, source module and interface documentation.\n\n# Decisions and Rationale\nUse one named export because the bounded numeric contract requires no external dependency.\n\n# Results\nThe module exports integer one and its documentation describes the observable interface.\n\n# Evidence\nExecuted the recorded import assertion and archived its log against the captured source baseline.\n\n# Limitations\nNative invocation identities are unsigned observations rather than provider attestations.\n\n# Lessons\nA focused executable assertion establishes a deterministic export contract without additional dependencies.\n';

function project(t, publication = 'project-branch', policyOverrides = {
  network_policy: undefined, automatic_pr: true,
}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-knowledge-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'PRIVATE-KNOWLEDGE-WORKFLOW', profile: 'basic' });
  ensureRoutingPolicy(root);
  installProject(root);
  // Archive transport has its own integration suite; isolate this publication contract.
  const archivePath = join(root, '.neomind/archive.json');
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
  writeFileSync(archivePath, JSON.stringify({ ...archive, enabled: false }));
  const policyPath = join(root, '.neomind/automation.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  assert.equal(policy.knowledge_research_required, true);
  assert.equal(policy.cornell_publication, 'project-branch');
  assert.equal(policy.network_policy, 'local-only');
  assert.equal(policy.automatic_pr, false);
  writeFileSync(policyPath, JSON.stringify({ ...policy, upstream: repository, cornell_publication: publication, ...policyOverrides }));
  const workflow = beginWorkflow(root, { requirement: 'Export and document integer one.' });
  const requirement = updateRecord(root, workflow.meta.data.requirement_id, {
    data: { acceptance_criteria: ['The documented named export equals integer one.'] },
  });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nThe named export equals integer one.\n');
  const task = createRecord(root, {
    type: 'task', title: 'Deliver documented export', owner: 'developer',
    links: [{ type: 'satisfies', target: requirement.meta.id }],
    data: { workflow_id: workflow.meta.id, acceptance_criteria: ['Export and document one.'],
      allowed_paths: ['src', 'docs'], documentation_paths: ['docs/value.md'],
      outputs: ['src/value.mjs', 'docs/value.md'] },
  });
  const check = createRecord(root, {
    type: 'check', title: 'Assert named export', owner: 'verifier',
    links: [{ type: 'verifies', target: requirement.meta.id }],
    data: { workflow_id: workflow.meta.id, invocation_id: 'check-author',
      command: [process.execPath, '--input-type=module', '-e', 'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)'],
      baseline_paths: ['src'], method: 'unit' },
  });
  reviewRecord(root, check.meta.id, 'reviewer', 'pass', [], 'check-reviewer');
  for (const role of ['requirements', 'verifier'])
    discussWorkflow(root, workflow.meta.id, {
      role, invocation_id: `${role}-discussion`,
      summary: 'The documented export has a measurable numeric acceptance contract.',
      rationale: 'A focused import assertion covers the bounded invariant without external services.',
      source_ids: [requirement.meta.id],
    });
  const decision = { workflow_id: workflow.meta.id,
    summary: 'Use a named export and an executable import assertion.',
    rationale: 'The deterministic contract needs no runtime dependencies or remote services.',
    task_ids: [task.meta.id] };
  return { root, workflow, requirement, task, check, decision };
}
function researchInput() {
  return { ...classification, workspace_paths: ['src/value.mjs'], queries: [query], selected_sources: [],
    no_match_reason: 'The local knowledge cache contains no reusable sources for this inspected numeric module; its bounded export needs only an import assertion and interface documentation.',
    summary: 'Inspected the named export and searched local reusable knowledge before choosing a dependency-free implementation and focused verification procedure.' };
}
function research(work) {
  assert.match(readFileSync(join(work.root, 'src/value.mjs'), 'utf8'), /export const value = 1/);
  assert.deepEqual(searchProjectKnowledge(work.root, { ...classification, query }), []);
  return recordKnowledgeResearch(work.root, work.workflow.meta.id, researchInput());
}
async function clientFor(t, root) {
  const server = createMcpServer(root);
  const client = new Client({ name: 'knowledge-workflow', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return (name, args) => client.callTool({ name, arguments: args });
}
const value = (response) => JSON.parse(response.content[0].text);
function ok(response) {
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return value(response);
}
function denied(response, pattern) {
  assert.equal(response.isError, true, JSON.stringify(response));
  assert.match(response.content[0].text, pattern);
}
function candidate(work) {
  const note = createCornellNote(work.root, cornellFixture(work.workflow.meta.id, work.requirement.meta.id));
  return createRecord(work.root, {
    type: 'knowledge', title: 'Focused assertions for deterministic exports', owner: 'curator',
    links: [{ type: 'references', target: work.task.meta.id }],
    data: { kind: 'generalized-candidate', workflow_id: work.workflow.meta.id,
      invocation_id: 'curator-candidate', public_safe: true,
      generalization: 'A focused executable assertion establishes a deterministic module contract on an inspected source baseline.',
      applicability: ['Small deterministic module interfaces.'], provenance: ['https://nodejs.org/api/assert.html'],
      assumptions: ['The observable contract is a stable exported value.'], limitations: ['Does not assess production reliability.'],
      platforms: [process.platform], frameworks: ['Node.js'], pack_id: 'focused-exports', pack_version: '1.0.0',
      cornell_note_ids: [note.meta.id], cornell_note_fingerprints: { [note.meta.id]: recordFingerprint(note) },
      public_cornell: {
        cues: 'When can a focused executable assertion establish a deterministic module contract?',
        notes: 'Import the public value and compare it against a measurable requirement using an executable assertion. Capture the source baseline and preserve the verification output so independent review can distinguish a tested implementation from an unverified claim.',
        summary: 'A focused import assertion provides repeatable evidence for a bounded deterministic interface.',
        application: 'Use this approach for small module contracts while separately checking broader system behavior and runtime compatibility.',
      } },
    body: 'Private candidate details must not be used as the public Cornell narrative.',
  });
}
function complete(work) {
  research(work);
  decideWorkflow(work.root, work.workflow.meta.id, work.decision);
  startTask(work.root, work.task.meta.id, undefined, undefined, 'developer-work');
  archiveEvidence(work.root, runCheck(work.root, work.check.meta.id, work.task.meta.id).meta.id);
  submitTask(work.root, work.task.meta.id, 'Delivered and verified the documented integer export.', body);
  reviewTask(work.root, work.task.meta.id, 'reviewer', 'pass', [], 'task-reviewer');
  const lesson = candidate(work);
  reviewRecord(work.root, lesson.meta.id, 'reviewer', 'pass', [], 'candidate-reviewer', true, true);
  for (const record of loadRecords(work.root).filter((record) => record.meta.data.workflow_id === work.workflow.meta.id &&
    (record.meta.data.kind === 'manager-discussion' || record.meta.type === 'review')))
    assignmentReport(work.root, { target_ids: [work.workflow.meta.id], role: record.meta.owner,
      invocation_id: record.meta.data.invocation_id, body });
  return lesson;
}
// A missing publication seam must fail offline, never fall through to a real gh process.
function withoutExternalProcesses(action) {
  const original = childProcess.spawnSync;
  const attempts = [];
  childProcess.spawnSync = (...args) => {
    attempts.push(args[0]);
    throw new Error('External process forbidden in knowledge workflow integration test.');
  };
  syncBuiltinESMExports();
  try { return action(attempts); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
}

test('native policy defaults to local-only while legacy defaults and saved policies remain remote-compatible', (t) => {
  const legacy = defaultAutomationPolicy();
  assert.equal(legacy.network_policy, undefined);
  assert.equal(legacy.automatic_pr, true);
  const native = nativeAutomationPolicy();
  assert.equal(native.network_policy, 'local-only');
  assert.equal(native.automatic_pr, false);
  assert.equal(native.knowledge_research_required, true);
  const work = project(t);
  const path = join(work.root, '.neomind/automation.json');
  const saved = readAutomationPolicy(work.root);
  assert.equal(saved.network_policy, undefined);
  assert.equal(saved.automatic_pr, true);
  for (const network_policy of ['local-only', 'remote-enabled']) {
    writeFileSync(path, JSON.stringify({ ...saved, network_policy }));
    assert.equal(readAutomationPolicy(work.root).network_policy, network_policy);
  }
  for (const network_policy of [null, '', 'offline', true, 1, [], {}]) {
    writeFileSync(path, JSON.stringify({ ...saved, network_policy }));
    assert.throws(() => readAutomationPolicy(work.root), /Invalid manager automation policy/);
  }
});

test('native local research and planning need no external processes or GitHub authentication', (t) => {
  const work = project(t, 'project-branch', {});
  withoutExternalProcesses((attempts) => {
    assert.throws(() => decideWorkflow(work.root, work.workflow.meta.id, work.decision), /knowledge research is required/i);
    const recorded = research(work);
    assert.equal(recorded.meta.data.workspace_hashes['src/value.mjs'], hash(readFileSync(join(work.root, 'src/value.mjs'))));
    assert.deepEqual(recorded.meta.data.queries, [query]);
    assert.match(recorded.meta.data.no_match_reason, /local knowledge cache/);
    decideWorkflow(work.root, work.workflow.meta.id, work.decision);
    assert.equal(startTask(work.root, work.task.meta.id, undefined, undefined, 'offline-worker').meta.status, 'in-progress');
    assert.deepEqual(attempts, []);
  });
});

test('local-only native closure defers all remote publishers regardless of archive and automatic PR settings', (t) => {
  for (const enabled of [true, false]) for (const automatic_pr of [true, false])
    for (const publication of ['project-branch', 'draft-pr']) {
      const work = project(t, publication, { network_policy: 'local-only', automatic_pr, upstream: null });
      const archivePath = join(work.root, '.neomind/archive.json');
      const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
      writeFileSync(archivePath, JSON.stringify({ ...archive, enabled }));
      const lesson = complete(work);
      const calls = [];
      const forbidden = (...args) => { calls.push(args); throw new Error('Remote transport must not run during local closure.'); };
      withoutExternalProcesses((attempts) => {
        for (let retry = 0; retry < 2; retry++) {
          const closed = retry === 0
            ? finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] }, forbidden, forbidden, forbidden)
            : finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] });
          assert.equal(closed.phase, 'completed');
          assert.deepEqual(closed.publication_blockers, []);
          assert.equal(closed.publications[0].status, 'prepared-locally');
          assert.equal(closed.publications[0].commit, undefined);
          assert.match(closed.publications[0].reason, /local-only/i);
          assert.equal(closed.archive.status, 'deferred');
          assert.equal(closed.archive.commit, undefined);
          assert.equal(closed.archive.snapshot_id, undefined);
          assert.match(closed.archive.reason, /remote-enabled/);
          assert.match(closed.final_report, /defers remote knowledge and archive publication/);
          assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'accepted');
          assert.equal(getRecord(work.root, lesson.meta.id).meta.id, lesson.meta.id);
          assert.equal(getRecord(work.root, work.workflow.meta.id).meta.data.archive.status, 'deferred');
        }
        assert.deepEqual(attempts, []);
      });
      assert.deepEqual(calls, []);
      assert.equal(existsSync(join(work.root, `.neomind/archive-intents/${hash(work.workflow.meta.id)}.json`)), false);
    }
});

test('local-only completed workflow defers historical archive errors without changing the recovery intent', (t) => {
  const work = project(t, 'project-branch', {});
  const lesson = complete(work);
  const intentPath = join(work.root, `.neomind/archive-intents/${hash(work.workflow.meta.id)}.json`);
  const historicalError = 'Project archive: GitHub authentication was unavailable during earlier publication.';
  const intent = Buffer.from(JSON.stringify({ workflow_id: work.workflow.meta.id,
    error: historicalError, at: '2026-01-01T00:00:00.000Z' }, null, 2) + '\n');
  mkdirSync(join(work.root, '.neomind/archive-intents'), { recursive: true });
  writeFileSync(intentPath, intent);
  withoutExternalProcesses((attempts) => {
    const closed = finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] });
    for (const status of [closed, workflowStatus(work.root, work.workflow.meta.id)]) {
      assert.equal(status.phase, 'completed');
      assert.equal(status.persisted_phase, 'completed');
      assert.deepEqual(status.closure_blockers, []);
      assert.deepEqual(status.deferred_remote_publication, { historical_archive_error: historicalError });
      assert.match(status.next_action, /Deliver the saved final report/);
      assert.doesNotMatch(status.next_action, /retry|credentials|upstream/i);
      assert.equal(status.final_report_id, closed.final_report_id);
      assert.match(status.final_report, /defers remote knowledge and archive publication/);
    }
    assert.deepEqual(closed.publication_blockers, []);
    assert.equal(closed.archive.status, 'deferred');
    assert.equal(closed.tasks[0].accepted.ok, true);
    assert.deepEqual(readFileSync(intentPath), intent);
    const policyPath = join(work.root, '.neomind/automation.json');
    const policy = readAutomationPolicy(work.root);
    for (const network_policy of ['remote-enabled', undefined]) {
      writeFileSync(policyPath, JSON.stringify({ ...policy, network_policy }));
      const remote = workflowStatus(work.root, work.workflow.meta.id);
      assert.equal(remote.phase, 'completed-with-blockers');
      assert.deepEqual(remote.closure_blockers, [historicalError]);
      assert.equal(remote.deferred_remote_publication, undefined);
      assert.match(remote.next_action, /Retry the saved publication blocker/);
      assert.deepEqual(readFileSync(intentPath), intent);
    }
    assert.deepEqual(attempts, []);
  });
});

test('native local-only closure without a reusable lesson defers the enabled archive without authentication', (t) => {
  const work = project(t, 'project-branch', {});
  complete(work);
  const archivePath = join(work.root, '.neomind/archive.json');
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
  writeFileSync(archivePath, JSON.stringify({ ...archive, enabled: true }));
  withoutExternalProcesses((attempts) => {
    const closed = finishWorkflow(work.root, work.workflow.meta.id, {
      no_lesson_reason: 'This reviewed numeric export repeats an established local contract and adds no distinct reusable insight beyond the existing focused assertion pattern.',
    });
    assert.equal(closed.phase, 'completed');
    assert.deepEqual(closed.publications, []);
    assert.deepEqual(closed.publication_blockers, []);
    assert.equal(closed.archive.status, 'deferred');
    assert.deepEqual(attempts, []);
  });
});

test('local-only closure still requires current research and independent candidate review', (t) => {
  const work = project(t, 'project-branch', { network_policy: 'local-only', automatic_pr: true });
  const lesson = complete(work);
  const latest = loadRecords(work.root).find((record) => record.meta.data.kind === 'knowledge-research');
  const forbidden = () => assert.fail('Blocked local closure must not invoke a remote publisher.');
  withoutExternalProcesses((attempts) => {
    updateRecord(work.root, latest.meta.id, { data: { complete: false } });
    assert.throws(() => finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] }, forbidden, forbidden, forbidden), /incomplete/);
    research(work);
    updateRecord(work.root, lesson.meta.id, { title: 'Unreviewed deterministic export lesson' });
    assert.throws(() => finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] }, forbidden, forbidden, forbidden), /review|fingerprint/i);
    assert.notEqual(getRecord(work.root, work.workflow.meta.id).meta.data.phase, 'completed');
    assert.deepEqual(attempts, []);
  });
});

test('manager_decide and task_start require substantive owned research; only planning freezes the inspected baseline', async (t) => {
  const work = project(t);
  const call = await clientFor(t, work.root);
  const beforeWorkflow = getRecord(work.root, work.workflow.meta.id).meta.revision;
  const beforeTask = getRecord(work.root, work.task.meta.id).meta.revision;
  denied(await call('manager_decide', work.decision), /knowledge research is required/i);
  denied(await call('task_start', { id: work.task.meta.id, invocation_id: 'blocked-worker' }), /knowledge research is required/i);
  assert.equal(getRecord(work.root, work.workflow.meta.id).meta.revision, beforeWorkflow);
  assert.equal(getRecord(work.root, work.task.meta.id).meta.revision, beforeTask);
  denied(await call('knowledge_research', { workflow_id: work.workflow.meta.id, ...researchInput(), no_match_reason: 'No matches.' }), /No-match reason/);
  const read = ok(await call('project_read', { path: 'src/value.mjs' }));
  assert.match(read.text, /export const value = 1/);
  assert.deepEqual(ok(await call('knowledge_search', { ...classification, query })), []);
  const recorded = ok(await call('knowledge_research', { workflow_id: work.workflow.meta.id, ...researchInput() }));
  assert.equal(recorded.meta.data.workspace_hashes['src/value.mjs'], read.sha256);
  assert.equal(recorded.meta.data.workflow_id, work.workflow.meta.id);
  assert.deepEqual(recorded.meta.data.provenance_refs, []);
  writeFileSync(join(work.root, 'src/value.mjs'), 'export const value = 1; // inspected again\n');
  denied(await call('manager_decide', work.decision), /baseline changed before planning/);
  research(work);
  ok(await call('manager_decide', work.decision));
  const latest = research(work);
  updateRecord(work.root, latest.meta.id, { data: { complete: false } });
  denied(await call('task_start', { id: work.task.meta.id, invocation_id: 'incomplete-worker' }), /incomplete/);
  research(work);
  writeFileSync(join(work.root, 'src/value.mjs'), 'export const value = 1; // implementation may change after planning\n');
  const started = ok(await call('task_start', { id: work.task.meta.id, invocation_id: 'developer-work' }));
  assert.equal(started.meta.status, 'in-progress');
  assert.equal(started.meta.data.invocation_id, 'developer-work');
});

test('in-progress resumeTask rejects missing required research without returning or handing off the task', (t) => {
  const work = project(t);
  const recorded = research(work);
  decideWorkflow(work.root, work.workflow.meta.id, work.decision);
  startTask(work.root, work.task.meta.id, undefined, undefined, 'developer-work');
  const before = getRecord(work.root, work.task.meta.id);
  assert.equal(before.meta.status, 'in-progress');
  assert.equal(getRecord(work.root, work.workflow.meta.id).meta.data.knowledge_research_required, true);
  rmSync(join(work.root, recorded.path));
  for (const invocation of [undefined, 'developer-work', 'replacement-worker']) {
    assert.throws(() => resumeTask(work.root, work.task.meta.id, undefined, undefined, invocation), /knowledge research is required/i);
    assert.deepEqual(getRecord(work.root, work.task.meta.id), before, 'Denied resume must preserve the task and invocation history');
  }
});

test('in-progress resumeTask rejects stale required research even for a new invocation', (t) => {
  const work = project(t);
  const recorded = research(work);
  decideWorkflow(work.root, work.workflow.meta.id, work.decision);
  startTask(work.root, work.task.meta.id, undefined, undefined, 'developer-work');
  const before = getRecord(work.root, work.task.meta.id);
  assert.equal(before.meta.status, 'in-progress');
  updateRecord(work.root, recorded.meta.id, {
    data: { source_fingerprints: { 'stale-source': hash('outdated source baseline') } },
  });
  for (const invocation of [undefined, 'developer-work', 'replacement-worker']) {
    assert.throws(() => resumeTask(work.root, work.task.meta.id, undefined, undefined, invocation), /stale source references or fingerprints/i);
    assert.deepEqual(getRecord(work.root, work.task.meta.id), before, 'Stale research must not permit an invocation handoff');
  }
});

test('native MCP research remains reserved and cannot be rewritten or mixed across native or strict workflows', async (t) => {
  const work = project(t);
  const other = beginWorkflow(work.root, { requirement: 'Keep a separate native increment isolated.' });
  const strict = beginWorkflow(work.root, { requirement: 'Preserve signed workflow ownership.', execution_mode: 'strict' });
  const call = await clientFor(t, work.root);
  const own = ok(await call('knowledge_research', { workflow_id: work.workflow.meta.id, ...researchInput() }));
  const otherResearch = ok(await call('knowledge_research', { workflow_id: other.meta.id, ...researchInput() }));
  const count = loadRecords(work.root).filter((record) => record.meta.data.kind === 'knowledge-research').length;
  denied(await call('knowledge_research', { workflow_id: strict.meta.id, ...researchInput() }), /invocation-bound/);
  for (const target of [other, strict]) {
    denied(await call('record_update', { id: own.meta.id, data: { workflow_id: target.meta.id } }), /reserved|ownership/i);
    denied(await call('record_update', { id: own.meta.id, links: [{ type: 'documents', target: target.meta.id }] }), /invocation-bound|reserved|ownership/i);
    denied(await call('record_create', { type: 'knowledge', title: 'Forged research', owner: 'manager',
      data: { ...researchInput(), kind: 'knowledge-research', complete: true, workflow_id: work.workflow.meta.id },
      links: [{ type: 'documents', target: target.meta.id }] }), /invocation-bound|reserved/i);
  }
  denied(await call('manager_discuss', { workflow_id: work.workflow.meta.id, role: 'researcher',
    invocation_id: 'cross-increment-researcher', summary: 'Attempt to reuse a different increment research record.',
    rationale: 'The report must retain ownership instead of silently adopting another workflow baseline.',
    source_ids: [otherResearch.meta.id] }), /invocation-bound|workflow/i);
  assert.equal(getRecord(work.root, own.meta.id).meta.revision, own.meta.revision);
  assert.equal(getRecord(work.root, own.meta.id).meta.data.workflow_id, work.workflow.meta.id);
  assert.equal(loadRecords(work.root).filter((record) => record.meta.data.kind === 'knowledge-research').length, count);
});

test('record_review public_safe is an explicit boolean passed through MCP to the publication gate', async (t) => {
  const work = project(t);
  const lesson = candidate(work);
  const call = await clientFor(t, work.root);
  const input = { id: lesson.meta.id, owner: 'reviewer', decision: 'pass', findings: [], generalization_review: true };
  const omitted = ok(await call('record_review', { ...input, invocation_id: 'review-unspecified' }));
  assert.notEqual(omitted.meta.data.public_safe, true);
  assert.throws(() => prepareProjectKnowledge(work.root, lesson.meta.id), /public_safe/);
  const refused = ok(await call('record_review', { ...input, invocation_id: 'review-private', public_safe: false }));
  assert.notEqual(refused.meta.data.public_safe, true);
  assert.throws(() => prepareProjectKnowledge(work.root, lesson.meta.id), /public_safe/);
  const reviews = loadRecords(work.root).filter((record) => record.meta.type === 'review').length;
  const invalid = { ...input, invocation_id: 'review-string', public_safe: 'true' };
  // SDK versions either return a tool validation error or reject the RPC itself.
  let response;
  try { response = await call('record_review', invalid); }
  catch (error) { assert.match(String(error), /boolean|invalid|validation/i); }
  if (response) assert.equal(response.isError, true, JSON.stringify(response));
  assert.equal(loadRecords(work.root).filter((record) => record.meta.type === 'review').length, reviews);
  const approved = ok(await call('record_review', { ...input, invocation_id: 'review-public', public_safe: true }));
  assert.equal(approved.meta.data.public_safe, true);
  assert.equal(approved.meta.data.target_fingerprint, recordFingerprint(lesson));
  assert.equal(prepareProjectKnowledge(work.root, lesson.meta.id).entry.title, lesson.meta.title);
});

test('manager_finish publishes a reviewed Cornell candidate through the sixth branch-publisher seam, never the draft PR path', (t) => {
  const work = project(t);
  const lesson = complete(work);
  const prepared = prepareProjectKnowledge(work.root, lesson.meta.id);
  const calls = [];
  const requests = [];
  let published = false;
  const request = (method, endpoint, input) => {
    requests.push({ method, endpoint, input });
    assert.ok(!endpoint.includes('/pulls'), 'Project branch publication never opens a pull request');
    if (method === 'GET' && endpoint === `repos/${repository}`) return { default_branch: 'main' };
    if (method === 'GET' && endpoint.includes('/git/ref/heads/')) {
      const branch = decodeURIComponent(endpoint.split('/git/ref/heads/')[1]);
      if (branch === 'main') return { object: { sha: 'base' } };
      assert.equal(branch, prepared.branch);
      if (published) return { object: { sha: 'a'.repeat(40) } };
      throw Object.assign(new Error('HTTP 404: branch absent'), { status: 404 });
    }
    if (method === 'GET' && endpoint.endsWith('/git/commits/base')) return { sha: 'base', tree: { sha: 'base-tree' } };
    if (method === 'GET' && endpoint.includes('/contents/'))
      throw Object.assign(new Error('HTTP 404: catalog absent'), { status: 404 });
    if (method === 'POST' && endpoint.endsWith('/git/trees')) {
      assert.equal(input.base_tree, 'base-tree');
      assert.deepEqual(input.tree.map((file) => file.path).sort(), prepared.files.map((file) => file.path).sort());
      for (const file of input.tree) {
        assert.equal(file.type, 'blob');
        assert.equal(file.mode, '100644');
        assert.equal(file.content, prepared.files.find((expected) => expected.path === file.path).content);
      }
      return { sha: 'new-tree' };
    }
    if (method === 'POST' && endpoint.endsWith('/git/commits')) {
      assert.deepEqual(input.parents, ['base']);
      assert.equal(input.tree, 'new-tree');
      return { sha: 'a'.repeat(40) };
    }
    if (method === 'POST' && endpoint.endsWith('/git/refs')) {
      assert.equal(input.ref, `refs/heads/${prepared.branch}`);
      assert.equal(input.sha, 'a'.repeat(40));
      published = true;
      return {};
    }
    assert.fail(`Unexpected publication request: ${method} ${endpoint}`);
  };
  const branchPublisher = (root, id, upstream) => {
    calls.push({ root, id, upstream });
    assert.equal(getRecord(root, work.task.meta.id).meta.status, 'accepted');
    return publishProjectKnowledge(root, id, upstream, request);
  };
  const unexpected = () => assert.fail('Branch publication must not call the draft PR or archive publisher.');
  const result = withoutExternalProcesses((attempts) => {
    const closed = finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] }, unexpected, unexpected, branchPublisher);
    assert.deepEqual(attempts, []);
    return closed;
  });
  assert.deepEqual(calls, [{ root: work.root, id: lesson.meta.id, upstream: repository }]);
  assert.equal(published, true);
  assert.equal(requests.filter((request) => request.method === 'POST' && request.endpoint.endsWith('/git/refs')).length, 1);
  assert.equal(result.phase, 'completed');
  assert.deepEqual(result.publication_blockers, []);
  assert.equal(result.publications[0].status, 'branch-published');
  assert.equal(result.publications[0].commit, 'a'.repeat(40));
  assert.equal(result.publications[0].branch, `neomind/knowledge/${hash('PRIVATE-KNOWLEDGE-WORKFLOW').slice(0, 16)}`);
  assert.equal(result.publications[0].knowledge_id, lesson.meta.id);
  assert.equal(getRecord(work.root, work.workflow.meta.id).meta.data.publications[0].commit, 'a'.repeat(40));
  assert.match(result.final_report, /branch-published/);
});

test('manager_finish retains branch publisher failures as blockers instead of claiming draft PR or publication success', (t) => {
  for (const failure of ['request-failed', 'unconfirmed-identity']) {
    const work = project(t);
    const lesson = complete(work);
    let calls = 0;
    const branchPublisher = () => {
      calls++;
      if (failure === 'request-failed') throw new Error('Injected publication request failed before branch confirmation.');
      return { status: 'branch-published', branch: 'neomind/knowledge/unconfirmed' };
    };
    const unexpected = () => assert.fail('No fallback to draft PR or archive publication.');
    const closed = withoutExternalProcesses((attempts) => {
      const result = finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] }, unexpected, unexpected, branchPublisher);
      assert.deepEqual(attempts, []);
      return result;
    });
    assert.equal(calls, 1);
    assert.equal(closed.phase, 'completed-with-blockers');
    assert.equal(closed.publications[0].status, 'blocked');
    assert.match(closed.publication_blockers.join('\n'), failure === 'request-failed' ? /Injected publication request failed/ : /publication identity/);
    assert.equal(getRecord(work.root, work.task.meta.id).meta.status, 'accepted');
  }
});

test('saved draft-pr policy continues using the existing fourth publisher argument', (t) => {
  const work = project(t, 'draft-pr');
  const lesson = complete(work);
  const calls = [];
  const draftPublisher = (root, id, upstream) => {
    calls.push({ root, id, upstream });
    return { status: 'draft-pr-created', upstream_pr: `https://github.com/${upstream}/pull/17` };
  };
  const unexpected = () => assert.fail('Saved draft-pr policy must not use the branch or archive publisher.');
  const closed = withoutExternalProcesses((attempts) => {
    const result = finishWorkflow(work.root, work.workflow.meta.id, { knowledge_ids: [lesson.meta.id] }, draftPublisher, unexpected, unexpected);
    assert.deepEqual(attempts, []);
    return result;
  });
  assert.deepEqual(calls, [{ root: work.root, id: lesson.meta.id, upstream: repository }]);
  assert.equal(closed.phase, 'completed');
  assert.equal(closed.publications[0].status, 'draft-pr-created');
  assert.equal(closed.publications[0].upstream_pr, `https://github.com/${repository}/pull/17`);
});
