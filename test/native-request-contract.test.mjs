import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, createRecord } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { createMcpServer } from '../dist/mcp.js';
import { assignmentTaskOptions } from '../dist/native-assignment.js';

test('native MCP accepts the actual Local Copilot blank-selector request while retaining scope and authentication refusals', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-optional-selector-'));
  initialize(root, { project_id: 'OPTIONAL-SELECTOR', platforms: ['copilot'] }); ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, { requirement: 'Inspect a bounded software change without inventing a task selector.', execution_mode: 'copilot-native' });
  const server = createMcpServer(root), client = new Client({ name: 'optional-selector-request', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const accepted = response => {
    assert.equal(Boolean(response.isError), false, 'The raw request must succeed without exposing its private response.');
    return JSON.parse(response.content[0].text);
  };
  const manager = accepted(await call('assignment_bootstrap', { workflow_id: workflow.meta.id,
    profile_id: 'coordinator', role: 'manager', assignment_id: 'current-manager',
    objective: 'Coordinate the current software request and preserve actual scoped specialist attribution.' }));
  const { handle } = accepted(await call('assignment_open', manager.open_input));
  const objective = 'Independently inspect the actual saved software contract and return a bounded review with supported findings.';
  const control = accepted(await call('assignment_delegate', { profile_id: 'reviewer', scope: 'workflow',
    objective, reported_assignment: handle }));
  for (const task_selector of ['', ' \t ', null]) {
    const prepared = accepted(await call('assignment_delegate', { profile_id: 'reviewer', scope: 'workflow',
      task_selector, objective, reported_assignment: handle }));
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.packet.task_id, undefined);
    assert.equal(prepared.packet_id, control.packet_id);
  }
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'One current scoped script bundle',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['scripts'] } });
  for (const task_selector of ['', ' \t ', null]) {
    const prepared = accepted(await call('assignment_delegate', { profile_id: 'implementer', scope: 'task', task_selector,
      objective, reported_assignment: handle }));
    assert.equal(prepared.packet.task_id, task.meta.id);
  }
  const selector = assignmentTaskOptions(root, workflow.meta.id)[0].selector;
  for (const args of [
    { profile_id: 'reviewer', scope: 'workflow', task_selector: selector, reported_assignment: handle },
    { profile_id: 'implementer', scope: 'task', task_selector: ` ${selector} `, reported_assignment: handle },
    { profile_id: 'reviewer', scope: 'workflow', task_selector: '', reported_assignment: { ...handle, token: '' } },
    { profile_id: 'reviewer', scope: 'workflow', task_selector: '', reported_assignment: {} },
    { profile_id: 'reviewer', scope: 'workflow', task_selector: '' },
  ]) assert.equal((await call('assignment_delegate', { ...args, objective })).isError, true);
  createRecord(root, { type: 'task', owner: 'developer', title: 'Second current scoped script bundle',
    data: { workflow_id: workflow.meta.id, allowed_paths: ['other-scripts'] } });
  for (const task_selector of ['', ' \t ', null]) {
    const unresolved = accepted(await call('assignment_delegate', { profile_id: 'implementer', scope: 'task', task_selector,
      objective, reported_assignment: handle }));
    assert.equal(unresolved.status, 'needs_task_selection'); assert.equal(unresolved.task_options.length, 2);
  }
  const other = beginWorkflow(root, { requirement: 'Retain the independent task scope of another current workflow.', execution_mode: 'copilot-native' });
  createRecord(root, { type: 'task', owner: 'developer', title: 'Foreign scoped script bundle', data: { workflow_id: other.meta.id, allowed_paths: ['foreign'] } });
  const foreign = assignmentTaskOptions(root, other.meta.id)[0].selector;
  assert.equal((await call('assignment_delegate', { profile_id: 'implementer', scope: 'task', task_selector: foreign,
    objective, reported_assignment: handle })).isError, true);
});

test('native MCP derives delegate identity and normalizes absent legacy task IDs before authorization', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-request-contract-'));
  initialize(root, { project_id: 'DERIVED-REQUESTS', platforms: ['copilot'] });
  ensureRoutingPolicy(root);
  const workflow = beginWorkflow(root, { requirement: 'Implement a bounded reusable tool with independent verification and without internal ID guessing.', execution_mode: 'copilot-native' });
  const server = createMcpServer(root), client = new Client({ name: 'request-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const accepted = response => {
    const value = JSON.parse(response.content[0].text);
    assert.equal(Boolean(response.isError), false, `MCP must succeed: ${response.isError ? String(value.error).replace(/[a-f0-9]{64}/g, '<redacted>') : 'accepted'}`);
    return value;
  };
  const manager = accepted(await call('assignment_bootstrap', {
    workflow_id: workflow.meta.id, profile_id: 'coordinator', role: 'manager', assignment_id: 'current-manager',
    objective: 'Coordinate the scoped software request and derive all specialist requests from its saved context.',
  }));
  const { handle } = accepted(await call('assignment_open', manager.open_input));
  const tools = (await client.listTools()).tools;
  for (const name of ['assignment_delegate', 'workflow_plan', 'workflow_next']) {
    const schema = tools.find(tool => tool.name === name)?.inputSchema;
    assert.ok(schema, `${name} must be discoverable.`);
    for (const field of ['workflow_id', 'task_id', 'role', 'invocation_id', 'assignment_id'])
      assert.equal(Object.hasOwn(schema.properties, field), false, `${name} must derive ${field}.`);
    assert.equal(schema.additionalProperties, false);
  }
  for (const [index, task_id] of ['', '  ', null].entries()) {
    const packet = accepted(await call('assignment_prepare', {
      reported_assignment: handle, workflow_id: workflow.meta.id, profile_id: 'architect', role: 'architect',
      assignment_id: `legacy-blank-${index}`, task_id,
      objective: 'Inspect the real bounded software contract without assigning a nonexistent task record.',
    }));
    assert.equal(Object.hasOwn(packet, 'task_id'), false);
  }
  const delegated = accepted(await call('assignment_delegate', {
    reported_assignment: handle, profile_id: 'explorer',
    objective: 'Inspect the current source interfaces and return actual findings for this workflow.',
  }));
  assert.equal(delegated.status, 'prepared');
  assert.equal(delegated.packet.workflow_id, workflow.meta.id);
  assert.equal(delegated.packet.role, 'codebase-analyst');
  assert.equal(Object.hasOwn(delegated.packet, 'task_id'), false);
  const guessed = await call('assignment_delegate', {
    reported_assignment: handle, profile_id: 'explorer', workflow_id: workflow.meta.id,
    objective: 'Inspect the current source interfaces and return actual findings for this workflow.',
  });
  assert.equal(guessed.isError, true, 'Protected raw IDs must be rejected rather than silently adopted.');

  const plan = accepted(await call('workflow_plan', { reported_assignment: handle,
    process: 'software-tools', title: 'Derived request implementation',
    rationale: 'This is a bounded Node software tool with no changes to embedded interfaces or hardware behavior.',
    objective: 'Implement one source export and independently verify its actual runtime behavior with a separate checker.',
    acceptance_criteria: ['The exported value is exactly forty two and the independent executable assertion passes.'],
    allowed_paths: ['value.mjs', 'README.md'], verification_paths: ['verify.mjs'],
    outputs: ['value.mjs', 'README.md'], documentation_paths: ['README.md'],
    checks: [{ title: 'Independent value contract assertion', command: [process.execPath, 'verify.mjs'],
      baseline_paths: ['value.mjs', 'README.md', 'verify.mjs'] }],
  }));
  const result = (summary, extra = {}) => ({ schema_version: 1, outcome: 'completed', summary,
    inputs: ['Inspected the current bounded task contract and accepted measurable software criteria.'],
    decisions: [{ decision: 'Keep the implementation dependency free and verify it in a separate actual task assignment.',
      basis: 'A standard library assertion directly exercises the specified source export and its exact result.' }],
    evidence_refs: [], evidence_notes: ['The supplied report references only files and checks actually produced in this fixture.'],
    limitations: ['This automated MCP fixture verifies request contracts; actual Copilot execution needs a separate live validation.'],
    lessons: ['Derive task and actor references on the backend rather than reconstructing identifiers in a model prompt.'], ...extra });
  const implementation = accepted(await call('workflow_next', { reported_assignment: handle }));
  const developer = accepted(await call('assignment_open', implementation.packet.open_input)).handle;
  const started = accepted(await call('assignment_start', { reported_assignment: developer }));
  assert.equal(started.meta.id, plan.task_id);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 42;\n');
  writeFileSync(join(root, 'README.md'), '# Value contract\nThe source exports the integer forty two and the independent assertion checks it.\n');
  accepted(await call('assignment_result', { reported_assignment: developer, result: result(
    'Implemented the specified integer source and usable documentation within the assigned software paths.',
    { submit_task: true, changes: [{ path: 'value.mjs', description: 'Actual named integer export.' },
      { path: 'README.md', description: 'Usage and observable contract documentation.' }] }) }));
  const verification = accepted(await call('workflow_next', { reported_assignment: handle,
    observation: { packet_id: implementation.packet_id, state: 'completed', observation_id: 'actual-fixture-producer-return' } }));
  const verifier = accepted(await call('assignment_open', verification.packet.open_input)).handle;
  writeFileSync(join(root, 'verify.mjs'), "import assert from 'node:assert/strict'; import { value } from './value.mjs'; assert.equal(value, 42);\n");
  const checks = accepted(await call('assignment_check', { reported_assignment: verifier }));
  assert.equal(checks.verification.ok, true);
  assert.equal(checks.evidence.length, 1);
  const evidenceRefs = checks.evidence.map(record => record.meta.id);
  accepted(await call('assignment_result', { reported_assignment: verifier, result: result(
    'Authored and executed the independent checker against the final source and documentation with an actual zero exit.',
    { evidence_refs: evidenceRefs, changes: [{ path: 'verify.mjs', description: 'Independent executable expected value assertion.' }] }) }));
  const review = accepted(await call('workflow_next', { reported_assignment: handle,
    observation: { packet_id: verification.packet_id, state: 'completed', observation_id: 'actual-fixture-verifier-return' } }));
  const reviewer = accepted(await call('assignment_open', review.packet.open_input)).handle;
  const wrongActor = await call('assignment_review', { reported_assignment: verifier, decision: 'pass', findings: [] });
  assert.equal(wrongActor.isError, true);
  accepted(await call('assignment_review', { reported_assignment: reviewer, decision: 'pass', findings: [] }));
  accepted(await call('assignment_result', { reported_assignment: reviewer, result: result(
    'Independently reviewed the exact submitted source, documentation, checker and actual passing evidence without unresolved findings.',
    { evidence_refs: evidenceRefs }) }));
  const closure = accepted(await call('workflow_next', { reported_assignment: handle,
    observation: { packet_id: review.packet_id, state: 'completed', observation_id: 'actual-fixture-reviewer-return' } }));
  assert.equal(closure.status, 'ready_for_cornell');
});
