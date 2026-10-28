import test from 'node:test';
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { installProject, getRecord, loadRecords } from '../dist/index.js';
import { cornellFixture } from './cornell-fixture.mjs';

function workRecord(role, result) {
  return `# Objective\nComplete the bounded ${role} assignment for the documented integer export.\n\n# Inputs and Sources\nInspect the same-workflow requirement, docs/contract.md and applicable design, task or check records.\n\n# Decisions and Rationale\nReuse a named Node.js export and its prescribed assertion to avoid unnecessary packages or network requests.\n\n# Results\n${result}\n\n# Evidence\nThe integration fixture exercises actual core MCP lifecycle gates. The check executor launches the recorded Node.js assertion and captures its output.\n\n# Limitations\nNative editor actions and independent actor participation are simulated by this isolated test. Local assignment credentials are unsigned correlation identities, not model or process attestations.\n\n# Lessons\nServer-issued local claims let clients that omit platform invocation IDs retain role separation, scoped records and evidence-backed closure.\n`;
}

test('native MCP completes a researched, reviewed and checked local-only cycle without platform invocation IDs', async t => {
  const parent = realpathSync(tmpdir()), root = realpathSync(mkdtempSync(join(parent, 'neomind-autonomous-cycle-'))), connections = [];
  t.after(async () => {
    for (const { client, server } of connections.reverse()) { await client.close(); await server.close(); }
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'AUTONOMOUS-CYCLE', profile: 'software', platforms: ['copilot'], copilot_integration: 'local' });
  installProject(root);
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'docs'));
  // These writes represent the native editor, not an inference or signed capability call.
  writeFileSync(join(root, 'docs/contract.md'), '# Integer export contract\nExport a named value equal to integer one and document how to import it.\n');
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 0;\n');
  const policy = JSON.parse(readFileSync(join(root, '.neomind/automation.json'), 'utf8'));
  assert.equal(policy.execution_mode, 'copilot-native');
  assert.equal(policy.network_policy, 'local-only');
  assert.equal(policy.knowledge_research_required, true);

  async function session(name) {
    const server = createMcpServer(root), client = new Client({ name: `fixture-${name}`, version: '1' });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote); await client.connect(local); connections.push({ client, server }); return client;
  }
  async function call(client, name, args = {}, credential) {
    const response = await client.callTool({ name, arguments: { ...args, ...(credential ? { reported_assignment: credential } : {}) } });
    let data;
    try { data = JSON.parse(response.content[0].text); }
    catch { assert.fail(`${name}: ${response.content[0].text.slice(0, 500)}`); }
    assert.equal(response.isError, undefined, `${name}: ${data.error ?? 'unexpected MCP refusal'}`);
    return data;
  }
  const intake = await session('intake');
  const dispatched = await call(intake, 'manager_run', { requirement: 'Export named integer one and document its import, with a deterministic executable acceptance check.', execution_mode: 'copilot-native', request_id: 'local-cycle' });
  assert.equal(dispatched.invocation, undefined);
  assert.equal(dispatched.handoff.agent, 'NeoMind Coordinator Agent');
  const workflow = await call(intake, 'manager_begin', { requirement: 'Export named integer one and document its import, with a deterministic executable acceptance check.', execution_mode: 'copilot-native', request_id: 'local-cycle' });
  const workflowId = workflow.meta.id, requirementId = workflow.meta.data.requirement_id;
  async function actor(profile, role, manager, taskId) {
    const client = await session(`${profile}-${role}`);
    const packet = await call(manager?.client ?? intake, 'assignment_prepare', { workflow_id: workflowId, profile_id: profile, role,
      assignment_id: `${profile}-${role}`, objective: `Perform the bounded ${role} duties for the documented integer export and return a substantive seven-section report.`, ...(taskId ? { task_id: taskId } : {}) }, manager?.credential);
    const claimed = await call(client, 'assignment_claim', { assignment_id: packet.id, claim_token: packet.claim_token });
    assert.equal(claimed.assurance, 'unsigned-local-assignment'); assert.match(claimed.id, /^local-report-/);
    const credential = { id: claimed.id, token: claimed.token };
    return { client, credential, role, id: claimed.id, call: (name, args) => call(client, name, args, credential),
      report: result => call(client, 'assignment_report', { target_ids: [workflowId], body: workRecord(role, result) }, credential) };
  }
  const manager = await actor('coordinator', 'manager');
  const researcher = await actor('researcher', 'researcher', manager);
  const planner = await actor('planner', 'requirements', manager);
  const architect = await actor('architect', 'architect', manager);
  const verifier = await actor('verifier', 'verifier', manager);
  const reviewer = await actor('reviewer', 'reviewer', manager);
  const curator = await actor('coordinator', 'curator', manager);
  const actors = [manager, researcher, planner, architect, verifier, reviewer, curator];
  assert.equal(new Set(actors.map(item => item.id)).size, actors.length);

  await planner.call('record_update', { id: requirementId, data: { acceptance_criteria: ['src/value.mjs exports a named value exactly equal to integer one.', 'docs/value.md documents the public import and expected value.'] } });
  const research = await researcher.call('knowledge_research', { workflow_id: workflowId, platforms: [process.platform], frameworks: ['Node.js'], workspace_paths: ['docs/contract.md'],
    queries: ['documented integer export'], selected_sources: [],
    no_match_reason: 'The inspected local cache has no applicable prior note for this deterministic export; upstream was not searched under local-only policy.',
    summary: 'Inspected docs/contract.md and searched local reusable knowledge before selecting the dependency-free named export and executable assertion.' });
  assert.equal(research.meta.data.complete, true); assert.equal(research.meta.data.invocation_id, researcher.id);
  const design = await architect.call('record_create', { type: 'design', title: 'One named module export', owner: 'architect',
    body: '# Interface\nExport value = 1 from src/value.mjs. Document its named import in docs/value.md.\n',
    data: { workflow_id: workflowId }, links: [{ type: 'satisfies', target: requirementId }] });
  const check = await verifier.call('record_create', { type: 'check', title: 'Assert named integer export and documentation', owner: 'verifier',
    data: { workflow_id: workflowId, method: 'unit', baseline_paths: ['src/value.mjs', 'docs/value.md'],
      command: [process.execPath, '--input-type=module', '-e', 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; import {value} from "./src/value.mjs"; assert.equal(value,1); assert.match(readFileSync("docs/value.md","utf8"),/import.*value/); console.log("documented export equals one");'] },
    links: [{ type: 'verifies', target: requirementId }, { type: 'verifies', target: design.meta.id }] });
  const task = await manager.call('record_create', { type: 'task', title: 'Deliver documented integer one', owner: 'developer',
    data: { workflow_id: workflowId, acceptance_criteria: ['The named export and documented import satisfy both acceptance clauses.'],
      allowed_paths: ['src/value.mjs', 'docs/value.md'], outputs: ['src/value.mjs', 'docs/value.md'], documentation_paths: ['docs/value.md'] },
    links: [{ type: 'satisfies', target: requirementId }, { type: 'implements', target: design.meta.id }] });
  await reviewer.call('record_review', { id: design.meta.id, owner: 'reviewer', decision: 'pass', findings: [] });
  await reviewer.call('record_review', { id: check.meta.id, owner: 'reviewer', decision: 'pass', findings: [] });
  for (const specialist of [planner, verifier]) await specialist.call('manager_discuss', { workflow_id: workflowId, role: specialist.role,
    summary: 'One focused import assertion and a checked usage document establish the measurable export contract.',
    rationale: 'A single named constant needs no dependency or network operation; independent review protects the bounded check plan.', source_ids: [requirementId] });
  await manager.call('manager_decide', { workflow_id: workflowId, summary: 'Implement one documented constant and execute the independently reviewed assertion.',
    rationale: 'The small deterministic interface is fully covered by the current requirement, reviewed design and executable check.', task_ids: [task.meta.id] });
  const decision = loadRecords(root).find(record => record.meta.data.kind === 'manager-decision');
  assert.equal(decision.meta.data.invocation_id, manager.id);
  assert.equal(decision.meta.data.identity_assurance, 'unsigned-local-assignment');
  assert.equal(getRecord(root, workflowId).meta.data.invocation_id, workflow.meta.data.invocation_id,
    'Current Coordinator attribution must preserve the saved intake identity.');
  const developer = await actor('implementer', 'developer', manager, task.meta.id);
  const executor = await actor('verifier', 'check-executor', manager, task.meta.id);
  actors.push(developer, executor);
  await developer.call('task_start', { id: task.meta.id });
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs/value.md'), '# Value\nUse `import { value } from "./src/value.mjs"`; the named export is integer one.\n');
  const evidence = await executor.call('check_run', { id: check.meta.id, task: task.meta.id });
  assert.equal(evidence.meta.data.exit_code, 0);
  assert.equal(evidence.meta.data.execution_invocation_id, executor.id);
  await executor.call('evidence_archive', { id: evidence.meta.id });
  await developer.call('task_submit', { id: task.meta.id, summary: 'Implemented the named constant and documented its import; the prescribed Node assertion passed.', work_record: workRecord('developer', 'The native-editor fixture now exports integer one and the prescribed check completed with exit code zero.') });
  await reviewer.call('task_review', { id: task.meta.id, owner: 'reviewer', decision: 'pass', findings: [] });
  const reports = [];
  for (const item of actors) {
    const report = await item.report(`Completed the ${item.role} duties using its own scoped local assignment; required records and actual check evidence are saved.`);
    assert.equal(report.meta.owner, item.role); assert.equal(report.meta.data.invocation_id, item.id);
    reports.push(report);
  }
  const noteInput = cornellFixture(workflowId, requirementId);
  noteInput.demonstration.observed = 'The recorded Node.js import and documentation assertions completed with exit code zero on the captured implementation baseline.';
  noteInput.demonstration.evidence_ids = [evidence.meta.id];
  const note = await curator.call('note_create', { note: noteInput });
  assert.equal(note.meta.owner, 'curator');
  assert.equal(note.meta.data.reported_assignment_id, curator.id);
  const closureInput = { workflow_id: workflowId,
    no_lesson_reason: 'This isolated integration fixture repeats the established named-export recipe and identity protocol; it contributes no new reusable product insight requiring remote publication.' };
  const closed = await manager.call('manager_finish', closureInput);
  assert.equal(getRecord(root, task.meta.id).meta.status, 'accepted');
  assert.equal(getRecord(root, workflowId).meta.data.phase, 'completed');
  assert.equal(getRecord(root, workflowId).meta.data.assurance, 'unsigned-native-report');
  assert.equal(closed.cornell_notes[0].id, note.meta.id);
  assert.equal(closed.test_reports[0].exit_code, 0);
  assert.equal(closed.publication_blockers.length, 0);
  assert.match(closed.final_report, /Local-only policy defers remote knowledge and archive publication/);
  assert.equal(existsSync(join(root, '.neomind/native/receipts')), false, 'No signed receipt or platform invocation is fabricated');
  const records = loadRecords(root);
  const finalReport = records.find(record => record.meta.title === 'Manager final report');
  assert.equal(finalReport.meta.data.invocation_id, manager.id);
  assert.equal(finalReport.meta.data.identity_assurance, 'unsigned-local-assignment');
  assert.equal(records.filter(record => record.meta.data.kind === 'manager-discussion').length, 2);
  assert.equal(records.filter(record => typeof record.meta.data.assignment_report_hash === 'string').length, reports.length);
  assert.equal(records.find(record => record.meta.id === research.meta.id).meta.data.complete, true);
  const repeated = await manager.call('manager_finish', closureInput);
  assert.equal(repeated.final_report, closed.final_report);
  assert.equal(loadRecords(root).length, records.length, 'The current Coordinator can recover completed closure idempotently.');
});
