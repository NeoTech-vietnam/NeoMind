import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { recordKnowledgeResearch, searchProjectKnowledge } from '../dist/knowledge-reuse.js';
import { cornellFixture } from './cornell-fixture.mjs';
import {
  initialize, installProject, managedRun, beginWorkflow, createRecord, updateRecord,
  getRecord, discussWorkflow, decideWorkflow, startTask, runCheck, archiveEvidence,
  submitTask, reviewTask, reviewRecord, finishWorkflow, safePath, ensureRoutingPolicy,
  nativeWorkflowRecord, verify, assignmentReport, loadRecords, createCornellNote,
  ensureArchivePolicy, prepareArchive, prepareRecipe,
} from '../dist/index.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'NATIVE' });
  ensureRoutingPolicy(root);
  return root;
}

test('Copilot installation defaults to full native mode with visible named subagents', async (t) => {
  const root = project(t);
  installProject(root);
  const policy = JSON.parse(readFileSync(safePath(root, '.neomind/automation.json'), 'utf8'));
  assert.equal(policy.execution_mode, 'copilot-native');
  assert.equal(policy.knowledge_research_required, true);
  assert.equal(policy.cornell_publication, 'project-branch');
  const agent = readFileSync(join(root, '.github/agents/neomind-manager.agent.md'), 'utf8');
  assert.match(agent, /"agent"/);
  assert.match(agent, /agents: .*NeoMind FnD Agent/);
  assert.match(agent, /unsigned-native-report/);
  const server = JSON.parse(readFileSync(join(root, '.vscode/mcp.json'), 'utf8'));
  assert.equal(server.servers.neomind.type, 'stdio');
  const result = await managedRun(root, { requirement: 'Export one with documentation.', request_id: 'visible' });
  assert.equal(result.handoff.agent, 'NeoMind Manager Agent');
  assert.equal(result.invocation, undefined);
  assert.equal(existsSync(safePath(root, '.neomind/native/receipts')), false);
});

test('native handoffs require named delegation, real reports and saved Cornell before answering', async (t) => {
  const root = project(t);
  installProject(root);
  for (const requirement of [
    'Implement a documented export with focused verification.',
    'Research the existing architecture and explain its tradeoffs without changing production code.',
  ]) {
    const result = await managedRun(root, { requirement, execution_mode: 'copilot-native' });
    assert.equal(result.handoff.agent, 'NeoMind Manager Agent');
    assert.equal(result.invocation, undefined);
    const prompt = result.handoff.prompt;
    assert.match(prompt, /Continue directly as NeoMind Manager Agent for the existing NeoMind increment/);
    assert.match(prompt, /do not call manager_run again or launch NeoMind Manager Agent \(yourself\)/);
    for (const name of ['NeoMind SWSD Agent', 'NeoMind P-RES Agent', 'NeoMind FnD Agent', 'NeoMind Reviewer Agent', 'NeoMind Tester Agent'])
      assert.ok(prompt.includes(name), name);
    assert.match(prompt, /standard VS Code agent tool by exact display name/);
    assert.match(prompt, /at least two separate specialist contributions/);
    assert.match(prompt, /Manager may coordinate, consolidate and research, but must never perform production implementation or independent self-review/);
    assert.match(prompt, /Wait for real delegate results.*actual invocation ID and seven-section assignment_report ID/);
    assert.match(prompt, /Inline role impersonation.*are not executed delegation/);
    assert.match(prompt, /result\/report is missing, report the blocker and next action/);
    assert.match(prompt, /Before manager_finish and before the substantive user answer, save an evidence-linked Cornell note with note\.workflow_id=/);
    assert.match(prompt, /Confirm its returned note ID and saved path/);
    assert.match(prompt, /Under local-only make zero remote discovery, publication or archive requests/);
    assert.match(prompt, /upstream not searched/);
    assert.match(prompt, /If saving fails, report the blocker without claiming Cornell delivery or closure/);
    assert.match(prompt, /Analysis\/research-only requests still require.*meaningful saved Cornell note/);
    assert.match(prompt, /do not invent production changes, builds, code reviews or SIL runs/);
    assert.match(prompt, /Full engineering gates remain unchanged/);
    assert.match(prompt, /independent acceptance review by a different owner and invocation/);
    assert.match(prompt, /not runtime attestations or signed receipts/);
    assert.match(prompt, /Use manager_status for progress/);
    assert.ok(prompt.includes(JSON.stringify(requirement)));
  }
});

test('native increment keeps engineering gates, immutable evidence and independent acceptance', async (t) => {
  const root = project(t);
  installProject(root);
  // Exercise installed research defaults without performing remote archive publication.
  const archivePath = join(root, '.neomind/archive.json');
  const archivePolicy = JSON.parse(readFileSync(archivePath, 'utf8'));
  writeFileSync(archivePath, JSON.stringify({ ...archivePolicy, enabled: false }));
  const requirements = ['Export integer one.', 'Document the integer export.'];
  const result = await managedRun(root, {
    requirements, request_id: 'native-full', execution_mode: 'copilot-native',
  });
  const parent = beginWorkflow(root, {
    requirements, request_id: 'native-full', execution_mode: 'copilot-native',
  });
  assert.equal(result.invocation, undefined);
  const workflow_id = parent.meta.id;
  const requirement = updateRecord(root, parent.meta.data.requirement_id, {
    data: { acceptance_criteria: ['Named export equals one.'] },
  });
  assert.equal(requirement.meta.data.routing_required, false);
  const requirementIds = parent.meta.data.requirement_ids;
  for (const id of requirementIds)
    updateRecord(root, id, { data: { acceptance_criteria: ['Export and document integer one.'] } });
  for (const role of ['requirements', 'verifier'])
    discussWorkflow(root, workflow_id, {
      role, invocation_id: `${role}-reported`, summary: 'A focused module assertion establishes the measurable contract.',
      rationale: 'No runtime dependency is needed for this deterministic export.', source_ids: [requirement.meta.id],
    });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nExports integer one.\n');
  const task = createRecord(root, {
    type: 'task', title: 'Deliver documented export', owner: 'developer',
    links: requirementIds.map((target) => ({ type: 'satisfies', target })),
    data: { workflow_id, acceptance_criteria: ['Export and document one.'], allowed_paths: ['src', 'docs'], documentation_paths: ['docs/value.md'], outputs: ['src/value.mjs', 'docs/value.md'] },
  });
  const check = createRecord(root, {
    type: 'check', title: 'Assert module export', owner: 'verifier',
    links: requirementIds.map((target) => ({ type: 'verifies', target })),
    data: { workflow_id, invocation_id: 'check-author', command: [process.execPath, '--input-type=module', '-e', 'import {value} from "./src/value.mjs"; if(value!==1) process.exit(1)'], baseline_paths: ['src'], method: 'unit' },
  });
  assert.equal(nativeWorkflowRecord(root, task), true);
  assert.throws(() => reviewRecord(root, check.meta.id, 'verifier', 'pass', [], 'check-author'), /different owner/);
  assert.equal(verify(root, task.meta.id, 'design-ready').ok, false);
  reviewRecord(root, check.meta.id, 'reviewer', 'pass', [], 'check-reviewer');
  assert.equal(parent.meta.data.knowledge_research_required, true);
  const classification = { platforms: [process.platform], frameworks: ['Node.js'] };
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.deepEqual(searchProjectKnowledge(root, { ...classification, query: 'documented integer named export' }), []);
  recordKnowledgeResearch(root, workflow_id, {
    ...classification, workspace_paths: ['src/value.mjs'], queries: ['documented integer named export'],
    selected_sources: [],
    no_match_reason: 'The local knowledge cache has no prior sources for this bounded integer export; the inspected module needs only a direct assertion and interface documentation.',
    summary: 'Inspected the existing named export and searched local reusable knowledge before selecting a dependency-free implementation and focused verification procedure.',
  });
  decideWorkflow(root, workflow_id, { summary: 'Use one named export and executable assertion.', rationale: 'The bounded invariant needs no external dependency.', task_ids: [task.meta.id] });
  startTask(root, task.meta.id, undefined, undefined, 'developer-reported');
  const evidence = runCheck(root, check.meta.id, task.meta.id);
  assert.equal(evidence.meta.data.routing_required, false);
  archiveEvidence(root, evidence.meta.id);
  const body = '# Objective\nDeliver documented integer one.\n\n# Inputs and Sources\nInspected requirement, value source and documentation.\n\n# Decisions and Rationale\nUse one named export because this deterministic invariant needs no runtime dependency.\n\n# Results\nSource exports integer one and documentation explains its interface.\n\n# Evidence\nExecuted the recorded import assertion and archived its output on the captured source baseline.\n\n# Limitations\nReported native model identities are unsigned observations, not provider attestations.\n\n# Lessons\nA focused import assertion gives repeatable evidence for a deterministic export without external tooling.\n';
  submitTask(root, task.meta.id, 'Delivered and checked the documented module.', body);
  const finish = () => finishWorkflow(root, workflow_id, { no_lesson_reason: 'This small fixture repeats an established export verification pattern without new reusable insight.' });
  assert.throws(finish, /review/i);
  assert.throws(() => reviewTask(root, task.meta.id, 'reviewer', 'pass', [], 'developer-reported'), /different owner/);
  reviewTask(root, task.meta.id, 'reviewer', 'pass', [], 'reviewer-reported');
  assert.throws(finish, /seven-section assignment report/);
  for (const assignment of loadRecords(root).filter((record) => record.meta.data.workflow_id === workflow_id &&
    ['manager-discussion', 'review'].includes(String(record.meta.data.kind ?? record.meta.type)))) {
    const input = { target_ids: [workflow_id], role: assignment.meta.owner,
      invocation_id: assignment.meta.data.invocation_id, body };
    const report = assignmentReport(root, input);
    assert.equal(assignmentReport(root, input).meta.id, report.meta.id);
    if (assignment.meta.owner === 'requirements') {
      writeFileSync(join(root, 'assignment.md'), body);
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
        'assignment', 'report', '--project', root, '--data', JSON.stringify(input), '--body', 'assignment.md'],
        { cwd: root, encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr || cli.stdout);
      assert.equal(JSON.parse(cli.stdout).meta.id, report.meta.id);
    }
  }
  assert.throws(finish, /Cornell note/);
  const note = createCornellNote(root, cornellFixture(workflow_id, requirementIds[1]));
  const delivered = finish();
  assert.equal(delivered.cornell_notes[0].id, note.meta.id);
  assert.equal(delivered.test_reports[0].id, evidence.meta.id);
  assert.equal(delivered.test_reports[0].exit_code, 0);
  assert.match(delivered.final_report, /# Cornell Findings/);
  assert.match(delivered.final_report, /## Cue Column/);
  assert.match(delivered.final_report, /Pending human review/);
  assert.equal(delivered.native_manager_attempt_id, null);
  assert.equal(getRecord(root, task.meta.id).meta.status, 'accepted');
  const closed = getRecord(root, workflow_id);
  assert.equal(closed.meta.data.assurance, 'unsigned-native-report');
  await assert.rejects(managedRun(root, { workflow_id, message: 'Change closed scope.' }), /Completed workflows/);
  assert.equal(getRecord(root, workflow_id).meta.revision, closed.meta.revision);
  assert.match(getRecord(root, closed.meta.data.final_report_id).body, /unsigned native report/);
  writeFileSync(archivePath, JSON.stringify(archivePolicy));
  ensureArchivePolicy(root);
  const snapshot = prepareArchive(root, workflow_id);
  assert.equal(snapshot.manifest.assurance, 'unsigned-native-report');
  const restored = `${root}-restore`;
  t.after(() => rmSync(restored, { recursive: true, force: true }));
  const server = createMcpServer(root);
  const client = new Client({ name: 'native-archive', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const response = await client.callTool({ name: 'archive_restore', arguments: { snapshot_id: snapshot.manifest.snapshot_id, destination: restored } });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.equal(existsSync(join(restored, '.neomind/config.json')), true);
    assert.equal(getRecord(restored, workflow_id).meta.data.assurance, 'unsigned-native-report');
  } finally { await client.close(); await server.close(); }
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2;\n');
  assert.equal(verify(root, task.meta.id, 'accepted').ok, false);
});

test('strict workflows cannot become native through policy changes or unrelated links', async (t) => {
  const root = project(t);
  const strict = beginWorkflow(root, { requirement: 'Strict original intent.', execution_mode: 'strict' });
  const native = beginWorkflow(root, { requirement: 'Separate native intent.', execution_mode: 'copilot-native' });
  const linked = updateRecord(root, strict.meta.data.requirement_id, { links: [{ type: 'references', target: native.meta.id }] });
  assert.equal(nativeWorkflowRecord(root, linked), false);
  assert.throws(() => updateRecord(root, strict.meta.id, { data: { execution_mode: 'copilot-native' } }), /immutable/);
  await assert.rejects(managedRun(root, { workflow_id: strict.meta.id, execution_mode: 'copilot-native' }), /cannot be changed/);
  await assert.rejects(managedRun(root, { workflow_id: native.meta.id, requirement: 'Different intent.' }), /differ/);
  await managedRun(root, { workflow_id: native.meta.id, message: 'Keep the original invariant.' });
  assert.deepEqual(getRecord(root, native.meta.id).meta.data.continuations, ['Keep the original invariant.']);
  const before = getRecord(root, native.meta.id).meta.revision;
  await assert.rejects(managedRun(root, { workflow_id: native.meta.id, requirement: 'Changed intent.', message: 'Must not persist.' }), /differ/);
  assert.equal(getRecord(root, native.meta.id).meta.revision, before);
  const tainted = createRecord(root, { type: 'knowledge', title: 'Mixed ancestry', owner: 'curator',
    data: { workflow_id: native.meta.id }, links: [{ type: 'references', target: strict.meta.id }] });
  assert.equal(nativeWorkflowRecord(root, tainted), false);
});

test('native MCP permits owned lifecycle work but protects strict state, receipts and private paths', async (t) => {
  const root = project(t);
  installProject(root);
  const native = beginWorkflow(root, { requirement: 'Native MCP contract.', execution_mode: 'copilot-native' });
  const strict = beginWorkflow(root, { requirement: 'Strict MCP contract.', execution_mode: 'strict' });
  const server = createMcpServer(root);
  const client = new Client({ name: 'native-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const value = (response) => JSON.parse(response.content[0].text);
  const created = await call('record_create', { type: 'knowledge', title: 'Owned note', owner: 'curator',
    data: { workflow_id: native.meta.id }, links: [{ type: 'references', target: native.meta.id }] });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const id = value(created).meta.id;
  assert.equal((await call('record_update', { id, body: 'Updated native note.' })).isError, undefined);
  const noteInput = cornellFixture(native.meta.id, native.meta.data.requirement_id);
  delete noteInput.workflow_id;
  const noteResult = await call('note_create', { note: noteInput });
  assert.equal(noteResult.isError, undefined, JSON.stringify(noteResult));
  const note = value(noteResult);
  assert.equal(note.meta.data.workflow_id, native.meta.id);
  assert.equal(note.meta.data.routing_required, false);
  const revision = await call('note_create', { note: { ...noteInput, summary: 'Revised native findings retain their original workflow ownership and evidence links.' },
    revision_id: note.meta.id, expected_revision: note.meta.revision, revision_reason: 'Clarify summary while preserving original native workflow ownership.' });
  assert.equal(revision.isError, undefined, JSON.stringify(revision));
  for (const blocked of [
    { ...noteInput, workflow_id: strict.meta.id },
    { ...noteInput, requirement_ids: [strict.meta.data.requirement_id] },
  ]) assert.equal((await call('note_create', { note: blocked })).isError, true);
  for (const args of [
    { id: strict.meta.id, data: { open_questions: ['Bypass'] } },
    { id: native.meta.id, data: { phase: 'completed' } },
    { id, data: { workflow_id: strict.meta.id } },
    { id, links: [{ type: 'references', target: strict.meta.id }] },
  ]) assert.equal((await call('record_update', args)).isError, true);
  const task = value(await call('record_create', { type: 'task', title: 'Bounded native task', owner: 'developer', data: { workflow_id: native.meta.id } }));
  assert.ok(task.meta?.id, JSON.stringify(task));
  for (const field of ['invocation_id', 'requested_model', 'confirmed_model', 'submission', 'submission_revision',
    'work_record_id', 'documentation_snapshot', 'attempts', 'accepted_at', 'status', 'escalation_invocation_id']) {
    assert.equal((await call('record_update', { id: task.meta.id, data: { [field]: 'forged' } })).isError, true, field);
    assert.equal((await call('record_create', { type: 'task', title: 'Forged native task', owner: 'developer',
      data: { workflow_id: native.meta.id, [field]: 'forged' } })).isError, true, field);
  }
  assert.equal((await call('record_update', { id: task.meta.id, data: { acceptance_criteria: ['Native planning remains editable.'] } })).isError, undefined);
  const other = beginWorkflow(root, { requirement: 'Deliver a separate native increment with isolated ownership.', execution_mode: 'copilot-native' });
  assert.equal((await call('record_create', { type: 'design', title: 'Mixed increments', owner: 'architect',
    data: { workflow_id: native.meta.id }, links: [{ type: 'documents', target: other.meta.id }] })).isError, true);
  assert.equal((await call('manager_finish', { workflow_id: native.meta.id,
    retired_candidates: [{ knowledge_id: strict.meta.id, rationale: 'Cross-mode retirement must be rejected.' }] })).isError, true);
  for (const data of [{ intake_workflow_id: strict.meta.id }, { assurance: 'signed-native-routing' }, { routing_required: false }])
    assert.equal((await call('record_create', { type: 'knowledge', title: 'Forged assurance', owner: 'curator',
      data: { workflow_id: native.meta.id, ...data } })).isError, true);
  assert.equal((await call('record_create', { type: 'evidence', title: 'Fake evidence', owner: 'check-executor', data: { workflow_id: native.meta.id } })).isError, true);
  assert.equal((await call('record_create', { type: 'knowledge', title: 'Mixed note', owner: 'curator', data: { workflow_id: native.meta.id }, links: [{ type: 'references', target: strict.meta.id }] })).isError, true);
  for (const path of ['.neomind/cache/private.txt', '.neomind/tools/private.txt', '.neomind/evidence/inputs/blobs/private.txt']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'Private fixture bytes.');
    for (const alias of [path, path.replace('.neomind/', '.neomind/')])
      assert.equal((await call('project_read', { path: alias })).isError, true, alias);
  }
  const report = await call('assignment_report', { target_ids: [id], invocation_id: 'reported-curator', role: 'curator',
    body: '# Objective\nInspect native record boundaries carefully.\n\n# Inputs and Sources\nRead native and strict workflow records through their saved identifiers.\n\n# Decisions and Rationale\nKeep signed state separate because unsigned identity cannot attest execution.\n\n# Results\nOwned records remain editable while protected lifecycle and strict state reject mutation.\n\n# Evidence\nExecuted direct MCP calls and inspected their returned error flags.\n\n# Limitations\nFixture observations do not establish live provider inference or UI delegation.\n\n# Lessons\nTest both physical and historical logical aliases when migrating protected storage.\n' });
  assert.equal(report.isError, undefined, JSON.stringify(report));
  assert.equal(value(report).meta.data.assurance, 'unsigned-native-report');
  installProject(root);
  assert.equal(getRecord(root, native.meta.id).meta.data.routing_required, false);
  assert.equal(getRecord(root, id).meta.data.routing_required, false);
});

async function cornellTransport(t, root) {
  const server = createMcpServer(root);
  const client = new Client({ name: 'cornell-ownership', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return (name, args) => client.callTool({ name, arguments: args });
}

function localCornell(root, workflow_id) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  const note = cornellFixture(workflow_id, 'unused');
  delete note.requirement_ids;
  if (!workflow_id) delete note.workflow_id;
  note.sources = [{ id: 'S1', title: 'Local value module', uri: 'src/value.mjs',
    retrieved_at: '2026-10-11T00:00:00Z', locator: 'named export' }];
  note.main_notes = '[source-reported] The local module exports integer one [S1]. [expected] An import assertion would check its value; no execution is claimed.';
  return note;
}

function fileSnapshot(root, directory = '') {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? [[path, 'directory'], ...fileSnapshot(root, path)]
        : [[path, readFileSync(join(root, path)).toString('base64')]];
    });
}

test('native MCP persists source-only Cornell with explicit ownership and no execution claims', async (t) => {
  const root = project(t);
  const workflow = beginWorkflow(root, { requirement: 'Explain the local value module without running it.', execution_mode: 'copilot-native' });
  // A newer unrelated workflow must never be selected in place of the explicit owner.
  beginWorkflow(root, { requirement: 'Keep a separate local explanation isolated.', execution_mode: 'copilot-native' });
  const call = await cornellTransport(t, root);
  const input = localCornell(root, workflow.meta.id);
  const response = await call('note_create', { note: input });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const note = JSON.parse(response.content[0].text);
  assert.equal(note.meta.data.workflow_id, workflow.meta.id);
  assert.equal(note.meta.data.routing_required, false);
  assert.equal(nativeWorkflowRecord(root, getRecord(root, note.meta.id)), true);
  assert.equal(note.meta.data.sources[0].uri, 'src/value.mjs');
  assert.match(note.meta.data.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(note.meta.data.demonstration.observed, undefined);
  assert.deepEqual(note.meta.data.demonstration.evidence_ids ?? [], []);
  for (const path of [input.path, input.practice.exercise_path, input.practice.answer_path])
    assert.equal(existsSync(join(root, path)), true, path);
  assert.match(readFileSync(join(root, input.path), 'utf8'), /has not been executed; no observed result is claimed/);
  assert.equal(loadRecords(root).some((record) => record.meta.type === 'evidence'), false);
  const revised = { ...input, summary: 'The local module defines the expected value; execution and acceptance remain unclaimed.' };
  delete revised.workflow_id;
  const revision = await call('note_create', { note: revised, revision_id: note.meta.id,
    expected_revision: note.meta.revision, revision_reason: 'Clarify expected results without adding execution claims or changing workflow ownership.' });
  assert.equal(revision.isError, undefined, JSON.stringify(revision));
  assert.equal(JSON.parse(revision.content[0].text).meta.data.workflow_id, workflow.meta.id);
});

for (const ownership of ['requirement', 'nested', 'outer', 'task'])
  test(`native MCP Cornell recipe normalizes ${ownership} ownership before gateway and freezing`, async (t) => {
    const root = project(t);
    const workflow = beginWorkflow(root, { requirement: 'Prepare source-backed Cornell practice without executing it.', execution_mode: 'copilot-native' });
    const note = localCornell(root, ownership === 'nested' ? workflow.meta.id : undefined);
    const requirement = workflow.meta.data.requirement_id;
    const task = ownership === 'task' ? createRecord(root, {
      type: 'task', title: 'Prepare native Cornell practice', owner: 'developer',
      data: { workflow_id: workflow.meta.id, allowed_paths: ['docs'] },
    }) : undefined;
    const call = await cornellTransport(t, root);
    const response = await call('recipe_prepare', {
      recipe_id: 'cornell-evidence-note', parameters: { note }, requirement_ids: [requirement],
      ...(ownership === 'outer' ? { workflow_id: workflow.meta.id } : {}),
      ...(task ? { task_id: task.meta.id } : {}),
    });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const instance = JSON.parse(response.content[0].text);
    assert.equal(instance.meta.data.parameters.note.workflow_id, workflow.meta.id);
    assert.equal(instance.meta.data.workflow_id, workflow.meta.id);
    for (const id of [instance.meta.id, instance.meta.data.task_id, instance.meta.data.design_id, instance.meta.data.check_id]) {
      const record = getRecord(root, id);
      assert.equal(record.meta.data.workflow_id, workflow.meta.id, id);
      assert.equal(record.meta.data.routing_required, false, id);
      assert.equal(nativeWorkflowRecord(root, record), true, id);
    }
    const frozen = JSON.parse(readFileSync(join(root, `.neomind/recipes/${instance.meta.id}/parameters.json`), 'utf8'));
    assert.equal(frozen.note.workflow_id, workflow.meta.id);
    assert.equal(loadRecords(root).some((record) => record.meta.type === 'evidence'), false);
    assert.equal(existsSync(join(root, note.path)), false, 'Preparation must not claim delivery or execute the recipe.');
  });

test('Cornell core preparation also infers native ownership from linked requirements', (t) => {
  const root = project(t);
  const workflow = beginWorkflow(root, { requirement: 'Retain native ownership in directly prepared Cornell recipes.', execution_mode: 'copilot-native' });
  const note = localCornell(root);
  const input = { recipe_id: 'cornell-evidence-note', parameters: { note }, requirement_ids: [workflow.meta.data.requirement_id] };
  const instance = prepareRecipe(root, input);
  assert.equal(instance.meta.data.workflow_id, workflow.meta.id);
  assert.equal(instance.meta.data.parameters.note.workflow_id, workflow.meta.id);
  assert.equal(nativeWorkflowRecord(root, getRecord(root, instance.meta.data.task_id)), true);
  assert.equal(input.parameters.note.workflow_id, undefined, 'Normalization must not mutate caller inputs.');
  assert.equal(prepareRecipe(root, input).meta.id, instance.meta.id);
});

test('Cornell MCP rejects missing, strict, cross-workflow and malformed ownership without writes', async (t) => {
  const root = project(t);
  const native = beginWorkflow(root, { requirement: 'Document only this native increment.', execution_mode: 'copilot-native' });
  const other = beginWorkflow(root, { requirement: 'Keep another native increment isolated.', execution_mode: 'copilot-native' });
  const strict = beginWorkflow(root, { requirement: 'Keep strict documentation invocation-bound.', execution_mode: 'strict' });
  const task = createRecord(root, { type: 'task', title: 'Isolated native documentation task', owner: 'developer',
    data: { workflow_id: other.meta.id, allowed_paths: ['docs'] } });
  const tainted = createRecord(root, { type: 'knowledge', title: 'Strict-linked source', owner: 'curator',
    data: { workflow_id: native.meta.id }, links: [{ type: 'references', target: strict.meta.id }] });
  const call = await cornellTransport(t, root);
  const note = localCornell(root, native.meta.id);
  const unowned = { ...note }; delete unowned.workflow_id;
  const recipe = (parameters, extra = {}) => ({ recipe_id: 'cornell-evidence-note', parameters,
    requirement_ids: [native.meta.data.requirement_id], ...extra });
  const cases = [
    ['note_create', { note: unowned }, /ownership is missing.*note.workflow_id/i],
    ['note_create', { note: { ...note, workflow_id: strict.meta.id } }, /strict\/non-native.*invocation-bound/i],
    ['note_create', { note: { ...note, requirement_ids: [other.meta.data.requirement_id] } }, /ownership mismatch/i],
    ['note_create', { note: { ...note, sources: [{ ...note.sources[0], record_id: strict.meta.data.requirement_id }] } }, /ownership mismatch/i],
    ['note_create', { note: { ...note, sources: [{ ...note.sources[0], record_id: tainted.meta.id }] } }, /strict\/non-native/i],
    ['recipe_prepare', recipe({ note }, { workflow_id: other.meta.id }), /ownership mismatch/i],
    ['recipe_prepare', recipe({ note }, { task_id: task.meta.id }), /ownership mismatch/i],
    ['recipe_prepare', recipe({ note: { ...note, workflow_id: other.meta.id } }), /ownership mismatch/i],
    ['recipe_prepare', recipe({ note: unowned }, { requirement_ids: [native.meta.data.requirement_id, other.meta.data.requirement_id] }), /ownership mismatch/i],
    ['recipe_prepare', recipe({ note: { ...note, workflow_id: strict.meta.id } }, { requirement_ids: [strict.meta.data.requirement_id] }), /strict\/non-native/i],
    ['recipe_prepare', recipe({ note: unowned }, { requirement_ids: [] }), /ownership is missing/i],
    ['recipe_prepare', recipe({}), /note object/i],
    ['recipe_prepare', recipe({ note: null }), /note object/i],
    ['recipe_prepare', recipe({ note: [] }), /note object/i],
    ['recipe_prepare', recipe({ note: { ...note, requirement_ids: 'not-an-array' } }), /array of record IDs/i],
    ['recipe_prepare', recipe({ note: { ...note, demonstration: null } }), /demonstration must be an object/i],
    ['recipe_prepare', recipe({ note: { ...note, demonstration: { evidence_ids: 7 } } }), /array of record IDs/i],
    ['recipe_prepare', recipe({ note: { ...note, sources: [{ record_id: 7 }] } }), /non-empty record ID/i],
    ['recipe_prepare', recipe({ note: { ...note, sources: [null] } }), /source objects/i],
    ['recipe_prepare', recipe({ note: { ...note, sources: { record_id: native.meta.id } } }), /sources must be an array/i],
    ['note_create', { note: { ...note, demonstration: { ...note.demonstration, observed: 'The assertion passed.' } } }, /requires evidence record IDs/i],
  ];
  for (const [name, args, diagnosis] of cases) {
    const before = fileSnapshot(root);
    const response = await call(name, args);
    assert.equal(response.isError, true, JSON.stringify({ name, response }));
    assert.match(JSON.parse(response.content[0].text).error, diagnosis);
    assert.deepEqual(fileSnapshot(root), before, `${name} denial must not write files or records.`);
  }
  const before = fileSnapshot(root);
  const denied = await call('task_file_write', { task_id: task.meta.id,
    workflow_id: other.meta.id, path: 'src/forged.mjs',
    content: 'export const forged = true;\n', expected_hash: null });
  assert.equal(denied.isError, true, JSON.stringify(denied));
  assert.match(JSON.parse(denied.content[0].text).error, /invocation-bound MCP session/);
  assert.deepEqual(fileSnapshot(root), before);
  // A malformed arbitrary recipe payload must not poison the transport for the next call.
  const valid = await call('note_create', { note });
  assert.equal(valid.isError, undefined, JSON.stringify(valid));
});
