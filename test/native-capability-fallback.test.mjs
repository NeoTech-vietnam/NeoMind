// Actual domain/storage transitions and native host fallback. Native invocation
// is simulated; these checks do not claim a live VS Code or provider outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import * as api from '../dist/index.js';
const require = createRequire(import.meta.url);
const { createNativeCapabilitySession } = require('../extensions/vscode-model-bridge/native-capability-session.cjs');
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const opaque = Object.freeze({ nativeContext: Symbol('host-only context') });
const professional = JSON.stringify({ summary: 'Completed the assigned bounded inspection.', verdict: 'pass', findings: [] });
function token() {
  return { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } };
}
function fixture(t) {
  const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'wf-native-fallback-')), calls = [];
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); rmSync(root, { recursive: true, force: true }); });
  api.initialize(root, { project_id: 'WF-FALLBACK' });
  const connector = { id: 'fixture', label: 'Approved lookup fixture', roles: ['WF.P-RES', 'WF.FnD'],
    tools: [{ name: 'mcp_fixture_lookup', reference: 'fixture/lookup' }] };
  const vscode = { CancellationTokenSource: class { constructor() { this.token = token(); } cancel() { this.token.isCancellationRequested = true; } dispose() {} }, lm: {
    tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
      properties: Object.fromEntries(['prompt', 'description', 'agentName', 'model'].map(key => [key, { type: 'string' }])) } },
    { name: 'mcp_fixture_lookup', fullReferenceName: 'fixture/lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
    async invokeTool(name, invocation) { assert.equal(name, 'runSubagent'); assert.equal(invocation.toolInvocationToken, opaque);
      calls.push(invocation.input); return { content: [{ value: professional }] }; },
  } };
  const session = createNativeCapabilitySession(vscode, api, root, { readApprovedConnectors: () => [connector] });
  return { root, calls, vscode, session };
}
function openDirect(f) {
  const state = api.openNativeRoleJob(f.root, { role: 'WF.P-RES', requirement: 'Inspect only the bounded approved connector.', mcp: ['fixture'] });
  const job = { assignment_ref: state.assignment_ref, agentName: state.role };
  return f.session.prepare(state, job, true).state;
}
function openRequest(f) {
  let state = api.openNativeRequest(f.root, { requirement: 'Create a bounded text file with independent checks.' });
  state = api.planNativeRequest(f.root, state.request_ref, { summary: 'One text product', requirements: ['product.txt contains the required greeting'],
    design: 'Existing project tools create and check the greeting', outputs: ['product.txt'], role_mcp: { 'WF.FnD': ['fixture'] },
    checks: [{ title: 'Runtime prerequisite', level: 'acceptance', command: [process.execPath, '--version'] }] });
  const job = api.nextNativeAssignment(f.root, state.request_ref);
  assert.ok(job); return { state: f.session.prepare(state, job).state, job };
}
test('direct fallback binds the actual ordinary profile, rejects another assignment and becomes immutable after an ended outcome', t => {
  const f = fixture(t), state = openDirect(f), profile = state.dispatch_capabilities.roles[state.role].profile.name;
  assert.throws(() => api.bindNativeRoleDispatchProfile(f.root, state.request_ref, 'another-assignment', false), /current unstarted role/);
  let current = api.bindNativeRoleDispatchProfile(f.root, state.request_ref, state.assignment_ref, false);
  assert.equal(current.native_profile, api.nativeWorkerProfiles[state.role]); assert.equal(current.capability_fallback, 'ordinary-work');
  const invocation = { transport: 'vscode-native', tool: 'runSubagent', agentName: state.role, invoked: true,
    host_call_id: 'actual-call-0001', status: 'returned', native_agent_name: current.native_profile };
  current = api.recordNativeRoleResult(f.root, { request_ref: state.request_ref, assignment_ref: state.assignment_ref, invocation, raw_result: professional });
  assert.equal(current.completion, 'role-completed'); assert.notEqual(current.invocation.native_agent_name, profile);
  assert.throws(() => api.bindNativeRoleDispatchProfile(f.root, state.request_ref, state.assignment_ref, true), /current unstarted role/);
  f.session.settle(current, true);
});
test('rebinding an unstarted direct or whole-request worker to restored MCP clears its current ordinary-fallback label', async t => {
  for (const direct of [true, false]) await t.test(direct ? 'direct role' : 'whole request', t => {
    const f = fixture(t), opened = direct ? { state: openDirect(f) } : openRequest(f), state = opened.state;
    const assignmentRef = direct ? state.assignment_ref : opened.job.assignment_ref;
    const bind = use => direct ? api.bindNativeRoleDispatchProfile(f.root, state.request_ref, assignmentRef, use)
      : api.bindNativeRequestDispatchProfile(f.root, state.request_ref, assignmentRef, use);
    const get = result => direct ? result : result.assignments.find(job => job.assignment_ref === assignmentRef);
    assert.equal(get(bind(false)).capability_fallback, 'ordinary-work');
    const restored = get(bind(true)), role = direct ? state.role : opened.job.agentName;
    assert.equal(restored.native_profile, state.dispatch_capabilities.roles[role].profile.name);
    assert.equal(restored.capability_fallback, undefined, 'Current fallback metadata must match the actual frozen profile selected for the next call.');
  });
});
test('MCP disappearing after preparation starts exactly one ordinary native worker and saves its actual profile', async t => {
  const f = fixture(t), capabilities = { ...f.session,
    prepare(...args) {
      const prepared = f.session.prepare(...args);
      f.vscode.lm.tools = f.vscode.lm.tools.filter(tool => tool.name === 'runSubagent');
      return prepared;
    } };
  const runner = createLocalRequestRunner(f.vscode, api, f.root, { capabilities });
  t.after(() => runner.dispose());
  const result = await runner.role({ role: 'WF.P-RES', requirement: 'Inspect the bounded project with ordinary tools if optional lookup disappears.', mcp: ['fixture'] }, opaque);
  assert.equal(result.status, 'role-completed', JSON.stringify(result)); assert.equal(f.calls.length, 1, 'The rejected optional-profile preflight is never an actual model call.');
  assert.equal(f.calls[0].agentName, api.nativeWorkerProfiles['WF.P-RES']);
  const record = api.loadRecords(f.root).find(record => record.meta.data.kind === 'workforce-request' && record.meta.data.delivery_scope === 'role-only');
  const state = api.getNativeRoleJob(f.root, record.meta.id);
  assert.equal(state.native_profile, api.nativeWorkerProfiles['WF.P-RES']); assert.equal(state.invocation.native_agent_name, state.native_profile);
  assert.equal(state.capability_fallback, 'ordinary-work'); assert.equal(state.accepted, false);
  assert.equal(api.readNativeCapabilityControl(f.root, 'mcp:fixture').active_count, 0);
});
