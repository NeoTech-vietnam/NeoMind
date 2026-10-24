import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, readConfig, getRecord, createRecord, updateRecord } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { assignmentReport, resumeTask } from '../dist/engineering.js';
import { createMcpServer } from '../dist/mcp.js';
import { adapterOutputs } from '../dist/adapters.js';
import { prepareReportedAssignment, claimReportedAssignment, resolveReportedAssignment, authorizeReportedAssignment } from '../dist/native-assignment.js';
import { captureEvidenceInputs, validateEvidenceInputs } from '../dist/evidence-inputs.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-reported-assignment-'));
  initialize(root, { project_id: 'REPORTED-ASSIGNMENT', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function clientFor(t, root) {
  const server = createMcpServer(root), client = new Client({ name: 'private-reported-assignment-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
function ok(result) { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
function denied(result, pattern) { assert.equal(result.isError, true, JSON.stringify(result)); assert.match(result.content[0].text, pattern); }
const body = '# Objective\nTrace the assigned integer export and report the current source contract.\n\n# Inputs and Sources\nRead src/value.mjs and the same-workflow requirement before choosing the bounded procedure.\n\n# Decisions and Rationale\nReuse the existing named export and a deterministic import assertion rather than adding dependencies.\n\n# Results\nThe inspected module exports integer one; a scoped verification procedure is proposed for the executor.\n\n# Evidence\nSource file inspection and hashed research input establish the reported source baseline; no runtime test is claimed.\n\n# Limitations\nIdentity is a server-issued local assignment claim, not an observed client invocation or model attestation.\n\n# Lessons\nPersist source findings through the validated research tool and keep observed facts distinct from proposed checks.\n';

for (const profile of [{ id: 'coordinator', role: 'manager', packet: 'coordinator-resume', activity: 'coordinator' },
  { id: 'researcher', role: 'researcher', packet: 'inspect-module', activity: 'inspect-module' }]) {
  test(`claimed ${profile.id} activity uses its canonical correlation key through real MCP without injected fields`, async t => {
    const root = fixture(t), workflow = beginWorkflow(root, { requirement: 'Observe actual scoped agent progress without inventing a platform UUID.', execution_mode: 'copilot-native' });
    const client = await clientFor(t, root);
    const packet = ok(await client.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
      profile_id: profile.id, role: profile.role, assignment_id: profile.packet, objective: 'Perform the bounded assigned inspection and report actual lifecycle observations.' } }));
    const actor = ok(await client.callTool({ name: 'assignment_claim', arguments: { assignment_id: packet.id, claim_token: packet.claim_token } }));
    const reported_assignment = { id: actor.id, token: actor.token };
    const event = ok(await client.callTool({ name: 'agent_activity', arguments: { reported_assignment, workflow_id: workflow.meta.id,
      profile_id: profile.id, assignment_id: profile.activity, state: 'running', summary: 'Inspecting the assigned source with actual local scope.' } }));
    assert.equal(event.assignment_id, profile.activity);
    assert.equal(event.invocation_id, actor.id);
    assert.equal(event.profile_id, profile.id);
    const explicit = ok(await client.callTool({ name: 'agent_activity', arguments: { reported_assignment, workflow_id: workflow.meta.id,
      profile_id: profile.id, assignment_id: profile.activity, role: profile.role, state: 'running', summary: 'Reporting the same actual assignment with an explicitly matching role.' } }));
    assert.equal(explicit.invocation_id, actor.id);
    denied(await client.callTool({ name: 'agent_activity', arguments: { reported_assignment, workflow_id: workflow.meta.id,
      profile_id: profile.id, assignment_id: profile.activity, role: 'reviewer', state: 'running', summary: 'Attempted role impersonation must be rejected before callback normalization.' } }), /cannot impersonate/);
    denied(await client.callTool({ name: 'agent_activity', arguments: { reported_assignment, workflow_id: workflow.meta.id,
      profile_id: profile.id, assignment_id: 'another-assignment', state: 'running', summary: 'Attempted unrelated activity correlation must be refused.' } }), /correlation key/);
  });
}
for (const role of ['curator', 'release']) {
  test(`claimed ${role} cannot overwrite Coordinator activity despite sharing its profile`, async t => {
    const root = fixture(t), workflow = beginWorkflow(root, { requirement: 'Keep specialist lifecycle reports distinct from the actual Coordinator.', execution_mode: 'copilot-native' });
    const client = await clientFor(t, root);
    const packet = ok(await client.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
      profile_id: 'coordinator', role, assignment_id: `${role}-assignment`, objective: 'Perform only the bounded specialist documentation or release duties without impersonating Coordinator progress.' } }));
    const actor = ok(await client.callTool({ name: 'assignment_claim', arguments: { assignment_id: packet.id, claim_token: packet.claim_token } }));
    denied(await client.callTool({ name: 'agent_activity', arguments: { reported_assignment: { id: actor.id, token: actor.token },
      workflow_id: workflow.meta.id, profile_id: 'coordinator', assignment_id: 'coordinator', state: 'running', summary: 'Attempt to replace actual Coordinator progress.' } }), /belongs to the actual manager/);
  });
}

test('generated native researchers can persist required research before planning', t => {
  const root = fixture(t), outputs = adapterOutputs(root, readConfig(root));
  const researcher = outputs.find(output => output.path === '.github/agents/neomind-researcher.agent.md');
  assert.ok(researcher);
  assert.match(researcher.content, /neomind\/knowledge_research/, 'Required research persistence must be available to the profile instructed to perform it.');
});

test('a delegate without platform invocation identity can claim a scoped local assignment and persist research/report honestly', async t => {
  const root = fixture(t), workflow = beginWorkflow(root, { requirement: 'Inspect the integer export before implementing its bounded change.', execution_mode: 'copilot-native' });
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  const manager = await clientFor(t, root), worker = await clientFor(t, root);
  const tools = (await manager.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('assignment_prepare'), 'The manager needs an honest local identity fallback when its client omits worker invocation IDs.');
  const packet = ok(await manager.callTool({ name: 'assignment_prepare', arguments: {
    workflow_id: workflow.meta.id, profile_id: 'researcher', role: 'researcher', assignment_id: 'inspect-value',
    objective: 'Inspect src/value.mjs, save its validated research baseline and return a seven-section assignment report.',
  } }));
  const actor = ok(await worker.callTool({ name: 'assignment_claim', arguments: { assignment_id: packet.id, claim_token: packet.claim_token } }));
  assert.match(actor.invocation_id, /^local-report-/);
  assert.equal(actor.assurance, 'unsigned-local-assignment');
  const reported_assignment = { id: actor.id, token: actor.token };
  const research = ok(await worker.callTool({ name: 'knowledge_research', arguments: { reported_assignment,
    workflow_id: workflow.meta.id, platforms: [process.platform], frameworks: ['Node.js'], workspace_paths: ['src/value.mjs'],
    queries: ['integer named export'], selected_sources: [],
    no_match_reason: 'The verified local cache has no applicable source for this small inspected numeric export. Upstream was not searched under local-only policy.',
    summary: 'Inspected the named integer export and local knowledge cache; the bounded source contract needs an import assertion and no new dependency.',
  } }));
  assert.equal(research.meta.data.complete, true);
  assert.equal(research.meta.data.invocation_id, actor.invocation_id);
  assert.equal(research.meta.owner, 'researcher');
  const report = ok(await worker.callTool({ name: 'assignment_report', arguments: { reported_assignment, target_ids: [workflow.meta.id], body } }));
  assert.equal(report.meta.owner, 'researcher');
  assert.equal(report.meta.data.invocation_id, actor.invocation_id);
  assert.equal(getRecord(root, report.meta.id).meta.data.assurance, 'unsigned-native-report');
  assert.equal(getRecord(root, report.meta.id).meta.data.identity_assurance, 'unsigned-local-assignment');
  denied(await manager.callTool({ name: 'assignment_report', arguments: {
    invocation_id: actor.invocation_id, role: 'researcher', target_ids: [workflow.meta.id], body,
  } }), /require their reported_assignment credential/);
  denied(await worker.callTool({ name: 'assignment_report', arguments: { reported_assignment,
    invocation_id: 'made-up-platform-id', role: 'reviewer', target_ids: [workflow.meta.id], body,
  } }), /cannot impersonate/);
  denied(await worker.callTool({ name: 'manager_finish', arguments: { reported_assignment, workflow_id: workflow.meta.id,
    no_lesson_reason: 'Attempted worker impersonation of coordinator closure is forbidden even with a valid local assignment credential.',
  } }), /cannot perform manager_finish/);
  const other = beginWorkflow(root, { requirement: 'Keep a separate workflow isolated.', execution_mode: 'copilot-native' });
  denied(await worker.callTool({ name: 'assignment_report', arguments: { reported_assignment, target_ids: [other.meta.id], body } }), /escapes its native workflow/);
  denied(await worker.callTool({ name: 'project_read', arguments: { reported_assignment, path: '.neomind/native/reported-assignments/issuer.key' } }), /Private credentials/);
  denied(await worker.callTool({ name: 'assignment_report', arguments: { reported_assignment: { id: actor.id, token: '0'.repeat(64) }, target_ids: [workflow.meta.id], body } }), /Invalid or unclaimed/);
  denied(await worker.callTool({ name: 'assignment_report', arguments: { reported_assignment, target_ids: [workflow.meta.id], body: '# Results\nNot a complete report.' } }), /Objective|Inputs|sections/i);
  const own = ok(await worker.callTool({ name: 'record_create', arguments: { reported_assignment, type: 'knowledge', owner: 'researcher', title: 'Researcher source observations', body: '# Source observations\nThe actual module exports integer one.', data: { workflow_id: workflow.meta.id } } }));
  const ownUpdated = ok(await worker.callTool({ name: 'record_update', arguments: { reported_assignment, id: own.meta.id, body: '# Source observations\nThe inspected named export equals integer one; no execution is claimed.' } }));
  assert.equal(ownUpdated.meta.owner, 'researcher');
  const foreign = createRecord(root, { type: 'knowledge', owner: 'curator', title: 'Curator-owned document', data: { workflow_id: workflow.meta.id }, body: '# Curator document\nKeep the independent curator narrative unchanged.' });
  denied(await worker.callTool({ name: 'record_update', arguments: { reported_assignment, id: foreign.meta.id, body: '# Replaced narrative\nAttempt to rewrite another role document is forbidden.' } }), /only its own assigned/);
  assert.equal(getRecord(root, foreign.meta.id).body, foreign.body);
  const foreignTask = createRecord(root, { type: 'task', title: 'Other workflow task', owner: 'developer', data: { workflow_id: other.meta.id } });
  const reviewerPacket = ok(await manager.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
    profile_id: 'reviewer', role: 'reviewer', assignment_id: 'separate-reviewer', objective: 'Independently review the assigned workflow and its current source baseline.' } }));
  const reviewerActor = ok(await worker.callTool({ name: 'assignment_claim', arguments: { assignment_id: reviewerPacket.id, claim_token: reviewerPacket.claim_token } }));
  denied(await worker.callTool({ name: 'task_review', arguments: { reported_assignment: { id: reviewerActor.id, token: reviewerActor.token },
    id: foreignTask.meta.id, owner: 'reviewer', decision: 'pass', findings: [] } }), /escapes its native workflow/);
  const strict = beginWorkflow(root, { requirement: 'Retain strict signed invocation ownership.', execution_mode: 'strict' });
  denied(await manager.callTool({ name: 'assignment_prepare', arguments: { workflow_id: strict.meta.id,
    profile_id: 'researcher', role: 'researcher', assignment_id: 'strict-forbidden', objective: 'Attempt to bypass signed workflow ownership using local reporting.',
  } }), /strict work keeps signed invocation binding/);
  const coordinatorPacket = ok(await manager.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
    profile_id: 'coordinator', role: 'manager', assignment_id: 'resumed-coordinator', objective: 'Resume this saved workflow and coordinate actual research, implementation, checks and review.' } }));
  const coordinator = ok(await manager.callTool({ name: 'assignment_claim', arguments: { assignment_id: coordinatorPacket.id, claim_token: coordinatorPacket.claim_token } }));
  const resumed = getRecord(root, workflow.meta.id);
  assert.equal(resumed.meta.data.invocation_id, workflow.meta.data.invocation_id, 'Original intake identity remains immutable history.');
  assert.equal(resumed.meta.data.reported_manager_invocation_id, coordinator.id);
  assert.equal(resumed.meta.data.reported_manager_history[0].previous_invocation_id, workflow.meta.data.invocation_id);
  const planned = ok(await manager.callTool({ name: 'record_create', arguments: { reported_assignment: { id: coordinator.id, token: coordinator.token },
    type: 'task', owner: 'developer', title: 'Plan a bounded producer task', data: { workflow_id: workflow.meta.id } } }));
  assert.equal(planned.meta.data.invocation_id, undefined, 'Planning does not claim to be the active producer invocation.');
  assert.equal(planned.meta.data.author_invocation_id, coordinator.id);
  const pending = ok(await manager.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
    profile_id: 'researcher', role: 'researcher', assignment_id: 'unclaimed-before-close', objective: 'Inspect the current module after receiving this bounded assignment.' } }));
  // Fixture setup only: the full autonomous-cycle test reaches closure through manager_finish.
  const workflowPath = join(root, resumed.path), workflowBytes = readFileSync(workflowPath, 'utf8');
  assert.match(workflowBytes, /^  phase: /m);
  writeFileSync(workflowPath, workflowBytes.replace(/^  phase: .+$/m, '  phase: completed'));
  denied(await worker.callTool({ name: 'record_update', arguments: { reported_assignment, id: own.meta.id, body: 'Forbidden new mutation after closure.' } }), /workflow is closed/);
  denied(await worker.callTool({ name: 'assignment_claim', arguments: { assignment_id: pending.id, claim_token: pending.claim_token } }), /workflow is closed/);
  denied(await manager.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
    profile_id: 'researcher', role: 'researcher', assignment_id: 'after-close', objective: 'Attempt to prepare a fresh assignment after the workflow has completed.' } }), /workflow is closed/);
  assert.equal(ok(await worker.callTool({ name: 'record_get', arguments: { reported_assignment, id: own.meta.id } })).meta.id, own.meta.id);
});

test('captured evidence binds a claimed local assignment to native task scope without capturing issuer secrets or inventing signed receipts', t => {
  const root = fixture(t), workflow = beginWorkflow(root, { requirement: 'Capture the actual local executor source attribution.', execution_mode: 'copilot-native' });
  const task = createRecord(root, { type: 'task', title: 'Bounded native implementation', owner: 'developer', data: { workflow_id: workflow.meta.id } });
  const packet = prepareReportedAssignment(root, { workflow_id: workflow.meta.id, profile_id: 'verifier', role: 'check-executor',
    assignment_id: 'actual-executor', objective: 'Execute the independently reviewed check and preserve its captured input baseline.', task_id: task.meta.id });
  assert.throws(() => captureEvidenceInputs(root, { files: {}, records: [task], invocation_id: packet.id }), /claimed.*captured native task scope/);
  const actor = claimReportedAssignment(root, packet.id, packet.claim_token);
  const snapshot = captureEvidenceInputs(root, { files: {}, records: [task], invocation_id: actor.id });
  const manifest = validateEvidenceInputs(root, snapshot);
  assert.equal(manifest.reported_identity.invocation_id, actor.id);
  assert.equal(manifest.reported_identity.assurance, 'unsigned-local-assignment');
  assert.ok(Object.keys(manifest.context_files).includes(`.neomind/native/reported-assignments/${actor.id}.json`));
  assert.equal(Object.keys(manifest.context_files).some(path => path.endsWith('issuer.key') || path.includes('/native/receipts/')), false);
  const other = beginWorkflow(root, { requirement: 'Keep another executor scope separate.', execution_mode: 'copilot-native' });
  const otherTask = createRecord(root, { type: 'task', title: 'Other native task', owner: 'developer', data: { workflow_id: other.meta.id } });
  assert.throws(() => captureEvidenceInputs(root, { files: {}, records: [otherTask], invocation_id: actor.id }), /captured native task scope/);
  assert.throws(() => captureEvidenceInputs(root, { files: {}, records: [task], invocation_id: actor.id,
    additional_files: ['.neomind/native/reported-assignments/issuer.key'] }), /excludes private runtime/);
  assert.throws(() => captureEvidenceInputs(root, { files: {}, records: [task], invocation_id: actor.id,
    additional_files: ['.neomind/native/reported-assignments/ISSUER.KEY'] }), /excludes private runtime/);
  assert.throws(() => captureEvidenceInputs(root, { files: {}, records: [task], invocation_id: actor.id,
    additional_files: ['.taskforces/native/reported-assignments/issuer.key'] }), /excludes private runtime/);
});

test('a resumed Coordinator supersedes stale mutation credentials while preserving read-only inspection', async t => {
  const root = fixture(t), workflow = beginWorkflow(root, { requirement: 'Resume one saved workflow without misattributing stale Coordinator actions.', execution_mode: 'copilot-native' });
  const client = await clientFor(t, root);
  async function coordinator(assignment_id) {
    const packet = ok(await client.callTool({ name: 'assignment_prepare', arguments: { workflow_id: workflow.meta.id,
      profile_id: 'coordinator', role: 'manager', assignment_id,
      objective: 'Coordinate this saved workflow with actual independent delegates and preserve its original intake history.' } }));
    const actor = ok(await client.callTool({ name: 'assignment_claim', arguments: { assignment_id: packet.id, claim_token: packet.claim_token } }));
    return { id: actor.id, token: actor.token };
  }
  const original = await coordinator('original-coordinator'), current = await coordinator('resumed-coordinator');
  assert.throws(() => assignmentReport(root, { target_ids: [workflow.meta.id], body,
    invocation_id: original.id, role: 'manager', assurance: 'unsigned-local-assignment' }), /superseded|current Coordinator/i);
  const staleMutation = { reported_assignment: original, workflow_id: workflow.meta.id };
  denied(await client.callTool({ name: 'manager_decide', arguments: { ...staleMutation, summary: 'Stale coordination decision must be refused before attribution.',
    rationale: 'A newer Coordinator now owns mutable coordination of the saved workflow.', task_ids: [] } }), /no longer the current Coordinator/);
  denied(await client.callTool({ name: 'manager_finish', arguments: { ...staleMutation,
    no_lesson_reason: 'A stale Coordinator must not create a final report attributed to the newer Coordinator.' } }), /no longer the current Coordinator/);
  denied(await client.callTool({ name: 'record_create', arguments: { reported_assignment: original, type: 'knowledge', owner: 'manager',
    title: 'Stale Coordinator narrative', body: 'A superseded Coordinator cannot mutate the saved workflow.' } }), /no longer the current Coordinator/);
  const status = ok(await client.callTool({ name: 'manager_status', arguments: staleMutation }));
  assert.equal(status.reported_manager_invocation_id, current.id);
  const created = ok(await client.callTool({ name: 'record_create', arguments: { reported_assignment: current, type: 'knowledge', owner: 'manager',
    title: 'Current Coordinator narrative', body: 'The current claimed Coordinator can save its own bounded coordination notes.' } }));
  assert.equal(created.meta.data.invocation_id, current.id);
  const saved = getRecord(root, workflow.meta.id);
  assert.equal(saved.meta.data.invocation_id, workflow.meta.data.invocation_id);
  assert.equal(saved.meta.data.reported_manager_history.length, 2);
  assert.equal(saved.meta.data.reported_manager_history[1].previous_invocation_id, original.id);
});

test('replaying a superseded Coordinator claim cannot take ownership back', t => {
  const root = fixture(t), workflow = beginWorkflow(root, {
    requirement: 'Fence a superseded Coordinator when its old claim packet is replayed.', execution_mode: 'copilot-native',
  });
  const prepare = assignment_id => prepareReportedAssignment(root, {
    workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager', assignment_id,
    objective: 'Coordinate this existing workflow while preserving original attribution and current ownership.',
  });
  const original = prepare('original-coordinator');
  claimReportedAssignment(root, original.id, original.claim_token);
  const replacement = prepare('replacement-coordinator');
  claimReportedAssignment(root, replacement.id, replacement.claim_token);
  assert.throws(() => claimReportedAssignment(root, original.id, original.claim_token), /superseded|no longer the current Coordinator/i);
  assert.equal(getRecord(root, workflow.meta.id).meta.data.reported_manager_invocation_id, replacement.id);
});

test('high-level MCP bootstrap derives separate concurrent handles and persists typed results without protocol reconstruction', async t => {
  const root = fixture(t), workflow = beginWorkflow(root, {
    requirement: 'Run two actual scoped MCP callers without sharing one current assignment context.', execution_mode: 'copilot-native',
  });
  const client = await clientFor(t, root);
  const prepare = async (profile_id, role, assignment_id) => ok(await client.callTool({ name: 'assignment_prepare', arguments: {
    workflow_id: workflow.meta.id, profile_id, role, assignment_id,
    objective: 'Inspect the assigned source and report actual bounded observations without inventing execution or native identity.',
  } }));
  const [researchPacket, explorerPacket] = await Promise.all([
    prepare('researcher', 'researcher', 'research-current-source'),
    prepare('explorer', 'codebase-analyst', 'explore-current-source'),
  ]);
  denied(await client.callTool({ name: 'assignment_open', arguments: {
    packet: { id: researchPacket.id, claim_token: researchPacket.claim_token }, reported_assignment: { id: '', token: '' },
  } }), /local-report|credential|Too small|format|pattern|Invalid/i);
  denied(await client.callTool({ name: 'assignment_open', arguments: {
    packet: { id: researchPacket.assignment_id, claim_token: researchPacket.claim_token },
  } }), /credential|server-issued|local-report|Invalid|pattern/i);
  const open = async packet => ok(await client.callTool({ name: 'assignment_open', arguments: {
    packet: { id: packet.id, claim_token: packet.claim_token },
  } }));
  const [researcher, explorer] = await Promise.all([open(researchPacket), open(explorerPacket)]);
  const [researchContext, explorerContext] = await Promise.all([
    client.callTool({ name: 'assignment_context', arguments: { reported_assignment: researcher.handle } }).then(ok),
    client.callTool({ name: 'assignment_context', arguments: { reported_assignment: explorer.handle } }).then(ok),
  ]);
  assert.equal(researchContext.role, 'researcher'); assert.equal(explorerContext.role, 'codebase-analyst');
  assert.notEqual(researchContext.invocation_id, explorerContext.invocation_id);
  assert.equal(researchContext.result_contract.json_schema.additionalProperties, false);
  const [first, second] = await Promise.all([
    client.callTool({ name: 'assignment_progress', arguments: { reported_assignment: researcher.handle,
      state: 'running', summary: 'Inspecting primary source constraints for this bounded task.' } }).then(ok),
    client.callTool({ name: 'assignment_progress', arguments: { reported_assignment: explorer.handle,
      state: 'running', summary: 'Tracing repository source entry points for this bounded task.' } }).then(ok),
  ]);
  assert.equal(first.invocation_id, researcher.handle.id); assert.equal(first.assignment_id, researchPacket.assignment_id);
  assert.equal(second.invocation_id, explorer.handle.id); assert.equal(second.assignment_id, explorerPacket.assignment_id);
  const result = {
    schema_version: 1, outcome: 'completed', summary: 'Inspected the current source contract and reported the bounded observed behavior.',
    inputs: ['Read the assigned source paths and saved workflow objective before selecting the bounded investigation.'],
    decisions: [{ decision: 'Use the existing source contract without adding unrelated dependencies.',
      basis: 'The assigned investigation concerns current observable behavior and requires no implementation changes.' }],
    evidence_refs: [], evidence_notes: ['Source inspection supports this report; no executable test result or native model observation is claimed.'],
    limitations: ['This unsigned report attributes a local MCP claim and does not attest an independent process or model.'],
    lessons: ['Reuse the scoped investigation only when the source baseline and requested observations remain applicable.'],
  };
  const saved = ok(await client.callTool({ name: 'assignment_result', arguments: { reported_assignment: researcher.handle, result } }));
  assert.equal(getRecord(root, saved.report_id).meta.data.invocation_id, researcher.handle.id);
  assert.equal(getRecord(root, saved.report_id).meta.owner, 'researcher');
  assert.deepEqual(ok(await client.callTool({ name: 'assignment_result', arguments: { reported_assignment: researcher.handle, result } })), saved);
  denied(await client.callTool({ name: 'assignment_result', arguments: {
    reported_assignment: explorer.handle, result: { ...result, workflow_id: workflow.meta.id },
  } }), /protected assignment fields|Unrecognized key.*workflow_id/);
});

test('a retired producer cannot resume or report through low-level authorization after its task handoff', t => {
  const root = fixture(t), workflow = beginWorkflow(root, {
    requirement: 'Fence a retired producer while preserving a fresh replacement assignment and historical inspection.', execution_mode: 'copilot-native',
  });
  const task = createRecord(root, { type: 'task', title: 'Preserve the active producer handoff', owner: 'developer',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['src'] } });
  const prepare = assignment_id => prepareReportedAssignment(root, {
    workflow_id: workflow.meta.id, task_id: task.meta.id, profile_id: 'implementer', role: 'developer', assignment_id,
    objective: 'Implement the bounded task while preserving historical attribution and the current producer ownership.',
  });
  const originalPacket = prepare('original-producer'), replacementPacket = prepare('replacement-producer');
  const original = claimReportedAssignment(root, originalPacket.id, originalPacket.claim_token);
  const replacement = claimReportedAssignment(root, replacementPacket.id, replacementPacket.claim_token);
  // The engineering resume lifecycle records this exact active/prior identity relationship.
  updateRecord(root, task.meta.id, { data: { invocation_id: replacement.id, prior_invocation_ids: [original.id] } });
  const oldActor = resolveReportedAssignment(root, { id: original.id, token: original.token });
  assert.throws(() => authorizeReportedAssignment(root, oldActor, 'task_resume', { id: task.meta.id }), /superseded|retired producer/);
  assert.throws(() => authorizeReportedAssignment(root, oldActor, 'assignment_report', { target_ids: [workflow.meta.id, task.meta.id] }), /superseded|retired producer/);
  assert.throws(() => assignmentReport(root, { target_ids: [workflow.meta.id, task.meta.id], body,
    invocation_id: original.id, role: 'developer', assurance: 'unsigned-local-assignment' }), /superseded|retired producer/);
  assert.throws(() => resumeTask(root, task.meta.id, undefined, undefined, original.id), /superseded|retired producer/);
  assert.doesNotThrow(() => authorizeReportedAssignment(root, oldActor, 'record_get', { id: task.meta.id }, true));
  const nextActor = resolveReportedAssignment(root, { id: replacement.id, token: replacement.token });
  assert.doesNotThrow(() => authorizeReportedAssignment(root, nextActor, 'assignment_report', { target_ids: [workflow.meta.id, task.meta.id] }));
});
