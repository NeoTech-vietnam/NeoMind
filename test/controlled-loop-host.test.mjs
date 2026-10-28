// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRecord } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { ControlledToolError } from '../dist/controlled-tools.js';
import { startNative, waitNative, shutdownNative } from '../dist/native.js';
import { writeFileSync } from 'node:fs';

class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }
const plan = title => ({ title, objective: 'Generate only the requested artifact.', rationale: 'Bounded fixture semantics.',
  acceptance_criteria: ['Output is correct.'], allowed_paths: ['src/value.mjs'], verification_paths: ['checks'],
  outputs: ['src/value.mjs'], checks: [{ title: 'Independent check', command: ['node', 'checks/verify.mjs'], baseline_paths: ['src/value.mjs'],
    negative_controls: [{ title: 'Reject invalid fixture', command: ['node', 'checks/verify.mjs', 'checks/bad.txt'], baseline_paths: ['checks/verify.mjs', 'checks/bad.txt'], expected_exit_code: 1 }] }], risk: 'low' });
async function fixture(t, corrected, legacy = false, schemaFailure = false) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-loop-host-')));
  initialize(root, { project_id: 'LOOP-HOST' });
  const policy = ensureRoutingPolicy(root);
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify({ ...policy, strong_provider: 'fixture-vendor', vscode_effort_policy: 'allow-unavailable' }));
  const workflow = createRecord(root, { type: 'knowledge', title: 'Controlled tool-loop fixture workflow', owner: 'manager', data: { kind: 'manager-workflow', phase: 'planning' } });
  let requests = 0, plans = 0, reports = 0;
  const events = [], request = randomUUID();
  const binding = { workflow_id: workflow.meta.id, role: 'manager', stage: 'planning', implementation_paths: [], verification_paths: [], read_paths: ['.'] };
  const unregister = legacy ? () => {} : registerControlledContext(root, request, { epoch_id: randomUUID(), binding, bindInvocation() {}, callbacks: {
    assertActive() {}, saveReport() { reports++; return { saved: true }; },
    submitPlan(value) { plans++; if (value.title === 'invalid') throw new ControlledToolError('PLAN_INVALID', 'The requested checker must be disjoint from implementation.'); return { saved: true }; },
    trace(value) { events.push(value); },
  } });
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async () => {
      const count = ++requests;
      const action = legacy ? count <= 3 ? new Call(`call-${count}`, 'project_read', { path: '.neomind/cache/native/private-key.pem' }) : new Text('Legacy fixture finished.')
        : corrected ? count <= 2 ? new Call(`call-${count}`, 'workflow_plan', plan('invalid'))
          : count === 3 ? new Call(`call-${count}`, 'workflow_plan', plan('corrected'))
          : count === 4 ? new Call(`call-${count}`, 'assignment_report', { outcome: 'completed', summary: 'Corrected semantic plan was saved.' }) : new Text('Corrected fixture finished.')
        : new Call(`call-${count}`, 'workflow_plan', schemaFailure ? { title: 'malformed schema', api_key: 'SECRET_SCHEMA_INPUT' } : plan('invalid'));
      return { stream: (async function* () { yield action; })() };
    } }] } };
  const host = await enableVSCodeHost(api, root);
  t.after(async () => { await shutdownNative(root); await host.close(); unregister(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const first = await startNative(root, { role: 'manager', prompt: 'Exercise only the deterministic tool error seam.',
    ...(legacy ? {} : { workflow_id: workflow.meta.id, request_id: request }) });
  const deadline = Date.now() + 60000; let done = first;
  while (['starting', 'running'].includes(done.state) && Date.now() < deadline) done = await waitNative(root, first.id, 250);
  assert.ok(!['starting', 'running'].includes(done.state), 'Fixture host must finish within its bound.');
  return { root, done, events, requests, plans, reports };
}

test('owned host stops before a third identical rejected semantic dispatch and preserves its actual rule', async t => {
  const result = await fixture(t, false);
  assert.equal(result.done.state, 'blocked'); assert.match(result.done.error, /CONTROLLED_TOOL_LOOP/);
  assert.equal(result.requests, 3); assert.equal(result.plans, 2); assert.equal(result.reports, 0);
  const failure = result.events.find(event => event.event === 'tool-result' && event.code === 'PLAN_INVALID');
  assert.match(failure.validation.rule, /disjoint/); assert.equal(failure.validation.owner, 'agent-content');
  const request = result.events.find(event => event.event === 'model-tool-request' && event.tool === 'workflow_plan');
  assert.equal(request.model_input.semantic.title, 'invalid'); assert.equal(request.backend_binding.workflow_id, result.done.workflow_id);
  assert.ok(result.events.some(event => event.event === 'tool-loop-stopped'));
  assert.match(readInvocation(result.root, result.done.id).error, /CONTROLLED_TOOL_LOOP/);
});

test('owned host permits corrected third input and completes actual semantic report persistence', async t => {
  const result = await fixture(t, true);
  assert.equal(result.done.state, 'completed'); assert.equal(result.done.inference_completed, true);
  assert.equal(result.plans, 3); assert.equal(result.reports, 1);
  assert.equal(result.events.some(event => event.event === 'tool-loop-stopped'), false);
  assert.equal(readFileSync(join(result.root, result.done.receipt_path), 'utf8').includes('CONTROLLED_TOOL_LOOP'), false);
});

test('legacy host retains its original tool-error behavior without the controlled loop policy', async t => {
  const result = await fixture(t, false, true);
  assert.equal(result.done.state, 'completed'); assert.equal(result.requests, 4);
  assert.equal(result.events.length, 0);
});

test('owned host traces malformed schema input before SDK validation without leaking credentials', async t => {
  const result = await fixture(t, false, false, true);
  assert.equal(result.done.state, 'blocked'); assert.match(result.done.error, /CONTROLLED_TOOL_LOOP/);
  assert.equal(result.plans, 0); assert.equal(result.requests, 3);
  const failure = result.events.find(event => event.event === 'model-tool-result' && event.code === 'SCHEMA_INVALID');
  assert.ok(failure); assert.match(failure.validation.rule, /invalid_type|schema/);
  const request = result.events.find(event => event.event === 'model-tool-request');
  assert.equal(request.model_input.semantic.title, 'malformed schema');
  assert.doesNotMatch(JSON.stringify(result.events), /SECRET_SCHEMA_INPUT/);
  assert.doesNotMatch(readFileSync(join(result.root, result.done.receipt_path), 'utf8'), /SECRET_SCHEMA_INPUT/);
});
