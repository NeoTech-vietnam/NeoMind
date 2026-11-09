// Real storage, lease, request/role domain and actual checker processes. Only
// VS Code's native model invocation is simulated; this is not desktop proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as api from '../dist/index.js';
import { installWorkspaceSkillComponents, controlWorkspaceSkillComponent } from '../dist/workspace-skill-components.js';
const require = createRequire(import.meta.url);
const { createNativeCapabilitySession } = require('../extensions/vscode-model-bridge/native-capability-session.cjs');
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const { createLocalDelegator } = require('../extensions/vscode-model-bridge/local-delegation.cjs');
const opaque = Object.freeze({ opaque: Symbol('actual host context') });
const report = extra => ({ summary: 'Inspected the bounded actual fixture.', verdict: 'pass', findings: [], ...extra });
const nativeSchema = { type: 'object', required: ['prompt', 'description'], properties:
  Object.fromEntries(['prompt', 'description', 'agentName', 'model'].map(key => [key, { type: 'string' }])) };
function cancellation() {
  const listeners = new Set();
  return { isCancellationRequested: false, onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    cancel() { this.isCancellationRequested = true; for (const listener of listeners) listener(); } };
}
function fixture(t, onInvoke = () => report(), options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-capability-session-')), calls = [], runners = [];
  api.initialize(root, { project_id: 'WF-CAPABILITY-SESSION' });
  t.after(async () => { await Promise.all(runners.map(runner => runner.dispose())); rmSync(root, { recursive: true, force: true }); });
  const connector = { id: options.connectorId ?? 'fixture', label: 'Approved fixture connector', roles: ['WF.FnD', 'WF.P-RES'],
    tools: [{ name: 'mcp_fixture_lookup', reference: 'fixture/lookup' }] };
  const vscode = { CancellationTokenSource: class { constructor() { this.token = cancellation(); }
    cancel() { this.token.cancel(); } dispose() {} }, lm: {
    tools: [{ name: 'runSubagent', inputSchema: nativeSchema }, { name: 'mcp_fixture_lookup', fullReferenceName: 'fixture/lookup',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
    async invokeTool(tool, payload, token) {
      assert.equal(tool, 'runSubagent'); assert.equal(payload.toolInvocationToken, opaque);
      assert.equal('assignment_ref' in payload.input, false); assert.equal('lease' in payload.input, false);
      calls.push(payload.input);
      return { content: [{ value: JSON.stringify(await onInvoke(payload.input, calls.length, token)) }] };
    },
  } };
  const session = createNativeCapabilitySession(vscode, api, root, { readApprovedConnectors: () => [connector] });
  const runner = createLocalRequestRunner(vscode, api, root, { capabilities: session }); runners.push(runner);
  return { root, calls, vscode, session, runner };
}
async function installGuide(root) {
  const files = new Map([['LICENSE', 'MIT License\n'], ['skills/guide/SKILL.md',
    '---\nname: guide\ndescription: Pinned checking guidance\n---\nRead references/check.md.\n'],
    ['skills/guide/references/check.md', '# Check\nInspect the actual product.\n']]);
  return installWorkspaceSkillComponents(root, { approved: true, repository: 'https://github.com/example/approved-guidance', commit: 'a'.repeat(40),
    license_path: 'LICENSE', skills: [{ source_path: 'skills/guide', target_name: 'guide',
      files: ['skills/guide/SKILL.md', 'skills/guide/references/check.md'] }] }, async input =>
    ({ ...input, kind: 'file', complete: true, content: files.get(input.path) }));
}
function requestInput(context = ['product.test.mjs']) {
  return { requirement: 'Create the hello text product and check its exact content.', title: 'Bound capability text product', context,
    plan: { summary: 'One checked UTF-8 text file', requirements: ['product.txt contains exactly hello plus a newline'],
      design: 'A text artifact checked by an existing independent Node assertion', outputs: ['product.txt'],
      role_skills: { 'WF.Reviewer': ['guide'] }, role_mcp: { 'WF.FnD': ['fixture'] },
      checks: [{ title: 'Exact product bytes', level: 'acceptance', command: [process.execPath, '--test', 'product.test.mjs'] }] } };
}
function seedChecker(root) {
  writeFileSync(join(root, 'product.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';test('exact product',()=>assert.equal(readFileSync('product.txt','utf8'),'hello\\n'));\n");
}
function stateForRequest(root, result) {
  const record = api.loadRecords(root).find(record => record.meta.data.kind === 'workforce-request' &&
    api.requestFolderForWorkflow(root, record.meta.id)?.display_id === result.request.request_key);
  assert.ok(record, 'The public result corresponds to a real persisted request');
  return api.getNativeRequest(root, record.meta.id);
}
function stateForRole(root, result) {
  const record = api.loadRecords(root).find(record => record.meta.data.kind === 'workforce-request' &&
    api.requestFolderForWorkflow(root, record.meta.id)?.display_id === result.job.request_key);
  assert.ok(record); return api.getNativeRoleJob(root, record.meta.id);
}

test('only a host-branded exact MCP variant can dispatch and its actual profile is retained by the real direct-role domain', async t => {
  const f = fixture(t), opened = api.openNativeRoleJob(f.root, { role: 'WF.P-RES', requirement: 'Inspect only the fixture source.', mcp: ['fixture'] });
  const prepared = f.session.prepare(opened, { assignment_ref: opened.assignment_ref, agentName: opened.role }, true);
  assert.match(prepared.prepared.profile.name, /^WF\.P-RES Worker MCP [a-f0-9]{16}$/);
  const delegator = createLocalDelegator(f.vscode, api.nativeWorkerProfiles, f.session);
  const handoff = { agentName: opened.role, prompt: opened.prompt, description: opened.description };
  const forged = await delegator.invoke(handoff, opaque, undefined, undefined, structuredClone(prepared.prepared));
  assert.equal(forged.status, 'rejected'); assert.equal(forged.error.code, 'NATIVE_MCP_BINDING_CHANGED');
  assert.equal(forged.metadata.invoked, false); assert.equal(f.calls.length, 0);
  const actual = await delegator.invoke(handoff, opaque, undefined, undefined, prepared.prepared);
  assert.equal(actual.status, 'returned'); assert.equal(f.calls.length, 1);
  const state = api.recordNativeRoleResult(f.root, { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref,
    invocation: { ...actual.metadata, status: actual.status }, raw_result: actual.raw_result });
  assert.equal(state.completion, 'role-completed'); assert.equal(state.accepted, false);
  assert.equal(state.invocation.native_agent_name, prepared.prepared.profile.name);
  assert.equal(f.calls[0].agentName, state.invocation.native_agent_name);
  assert.deepEqual(state.dispatch_capabilities.roles['WF.P-RES'].profile.tools, ['read', 'search', 'fixture/lookup']);
  f.session.settle(state, true);
  assert.equal(api.readNativeCapabilityControl(f.root, 'mcp:fixture').active_count, 0);
  assert.throws(() => f.session.prepare(state, { assignment_ref: state.assignment_ref, agentName: state.role }, true),
    error => error.code === 'NATIVE_CAPABILITY_LEASE_SETTLED', 'A settled lease cannot authorize another native call');
  assert.equal(f.calls.length, 1);
});

test('whole-request lease drains pending guidance only after actual acceptance and keeps accepted metadata current', async t => {
  let installed, pending;
  const f = fixture(t, input => {
    if (input.agentName.startsWith('WF.FnD Worker')) {
      writeFileSync(join(f.root, 'product.txt'), 'hello\n');
      pending = controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable');
      assert.equal(pending.control.state, 'deferred'); assert.equal(pending.control.active_count, 1);
    }
    assert.equal(existsSync(join(f.root, '.github/skills/guide/SKILL.md')), true, 'All three actual workers retain the live pinned guidance until acceptance');
    return report();
  });
  installed = await installGuide(f.root); seedChecker(f.root);
  const result = await f.runner.run(requestInput(), opaque);
  assert.equal(result.request?.accepted, true, JSON.stringify(result)); assert.equal(f.calls.length, 3);
  const state = stateForRequest(f.root, result), fnd = state.assignments.find(job => job.agentName === 'WF.FnD');
  assert.match(fnd.invocation.native_agent_name, /^WF\.FnD Worker MCP [a-f0-9]{16}$/);
  assert.equal(fnd.invocation.native_agent_name, f.calls[0].agentName);
  assert.equal(state.accepted, true); assert.equal(state.checks[0].state, 'passed'); assert.equal(state.checks[0].result.exit_code, 0);
  const control = api.readNativeCapabilityControl(f.root, `skill:${installed.components[0].id}`);
  assert.equal(control.active_count, 0); assert.equal(control.new_admissions, true);
  assert.equal(existsSync(join(f.root, '.github/skills/guide/SKILL.md')), false);
  assert.equal(api.getNativeRequest(f.root, state.request_ref).accepted, true, 'A legitimate settled guidance removal cannot undo a completed product');
});

test('returned direct-role report is saved before lease drain and remains current after authorized guidance removal', async t => {
  let installed;
  const f = fixture(t, () => {
    const pending = controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'remove');
    assert.equal(pending.control.state, 'deferred');
    return report({ report_artifacts: [{ path: 'reports/analysis.md', content: '# Analysis\nBounded actual fixture report.\n' }] });
  });
  installed = await installGuide(f.root);
  const result = await f.runner.role({ role: 'WF.P-RES', requirement: 'Report on the pinned guidance only.', skills: ['guide'], outputs: ['reports/analysis.md'] }, opaque);
  assert.equal(result.status, 'role-completed', JSON.stringify(result)); assert.equal(f.calls.length, 1);
  const state = stateForRole(f.root, result);
  assert.equal(state.completion, 'role-completed'); assert.equal(state.accepted, false); assert.ok(state.result_hash);
  assert.equal(readFileSync(join(f.root, 'reports/analysis.md'), 'utf8'), '# Analysis\nBounded actual fixture report.\n');
  assert.equal(existsSync(join(f.root, '.github/skills/guide/SKILL.md')), false);
  assert.equal(api.readNativeCapabilityControl(f.root, `skill:${installed.components[0].id}`).active_count, 0);
});

test('a selected guidance asset that is also explicit ordinary context never gets an archival acceptance waiver', async t => {
  const f = fixture(t, input => { if (input.agentName.startsWith('WF.FnD Worker')) writeFileSync(join(f.root, 'product.txt'), 'hello\n'); return report(); });
  const installed = await installGuide(f.root); seedChecker(f.root);
  const result = await f.runner.run(requestInput(['product.test.mjs', '.github/skills/guide/references/check.md']), opaque);
  assert.equal(result.request?.accepted, true, JSON.stringify(result));
  const before = stateForRequest(f.root, result);
  controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'remove');
  const current = api.getNativeRequest(f.root, before.request_ref);
  assert.equal(current.historical_status, 'accepted'); assert.equal(current.accepted, false);
  assert.equal(current.assignments.length, before.assignments.length, 'Invalidating ordinary evidence does not start extra workers');
});

test('exact guidance restoration before first dispatch refreshes the host pin without rewriting original provenance', async t => {
  const f = fixture(t); const installed = await installGuide(f.root);
  const opened = api.openNativeRoleJob(f.root, { role: 'WF.P-RES', requirement: 'Inspect the unchanged approved guidance.', skills: ['guide'] });
  const previous = structuredClone(opened.skill_contexts[0]);
  controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable'); await installGuide(f.root);
  assert.doesNotThrow(() => api.assertNativeRoleSkillsCurrent(f.root, opened.request_ref), 'The ordinary historical approval bridge is still valid');
  const prepared = f.session.prepare(opened, { assignment_ref: opened.assignment_ref, agentName: opened.role }, true);
  assert.deepEqual(prepared.state.skill_contexts[0].receipt_sha256, previous.receipt_sha256);
  const snapshot = api.readNativeCapabilityLeaseSkill(f.root, prepared.state.dispatch_capabilities.lease,
    prepared.state.dispatch_capabilities.owner, installed.components[0].id);
  assert.notEqual(snapshot.receipt_sha256, previous.receipt_sha256, 'The real host lease pins the current raw receipt, never a forged old SHA');
  const actual = await createLocalDelegator(f.vscode, api.nativeWorkerProfiles, f.session).invoke(
    { agentName: opened.role, prompt: opened.prompt, description: opened.description }, opaque, undefined, undefined, prepared.prepared);
  const state = api.recordNativeRoleResult(f.root, { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref,
    invocation: { ...actual.metadata, status: actual.status }, raw_result: actual.raw_result });
  assert.equal(state.completion, 'role-completed'); f.session.settle(state, true);
  const archive = join(f.root, '.workforce/capabilities/receipt-snapshots', installed.components[0].id, previous.receipt_sha256, 'receipt.json');
  const bytes = readFileSync(archive); writeFileSync(archive, '{}\n');
  assert.equal(api.getNativeRoleJob(f.root, opened.request_ref).completion, 'incomplete', 'A lease never substitutes for missing original provenance');
  writeFileSync(archive, bytes);
  assert.equal(api.getNativeRoleJob(f.root, opened.request_ref).completion, 'role-completed');
});

test('model-facing content schemas cannot set host lease, snapshot, profile or invocation identity', () => {
  const role = { role: 'WF.P-RES', requirement: 'Inspect bounded project content.' };
  const request = { requirement: 'Create the bounded product.', plan: { summary: 'Bounded', requirements: ['Observed result'],
    design: 'Existing checker', outputs: ['product.txt'], checks: [{ title: 'Check', command: [process.execPath, '--version'], level: 'acceptance' }] } };
  assert.equal(api.nativeRoleJobSchema.safeParse(role).success, true);
  assert.equal(api.nativeLocalRequestSchema.safeParse(request).success, true);
  for (const field of ['lease', 'owner', 'dispatch_capabilities', 'skill_contexts', 'snapshots', 'preparedProfile', 'native_agent_name', 'host_call_id']) {
    assert.equal(api.nativeRoleJobSchema.safeParse({ ...role, [field]: { id: 'forged' } }).success, false, field);
    assert.equal(api.nativeLocalRequestSchema.safeParse({ ...request, [field]: { id: 'forged' } }).success, false, field);
    assert.equal(api.nativeLocalRequestSchema.safeParse({ ...request, plan: { ...request.plan, [field]: { id: 'forged' } } }).success, false, field);
  }
  assert.equal(api.nativeRoleJobSchema.safeParse({ ...role, mcp: [{ name: 'mcp_fixture_lookup', reference: 'fixture/lookup' }] }).success, false);
  assert.equal(api.nativeRoleJobSchema.safeParse({ ...role, skills: [{ receipt_path: '.workforce/capabilities/forged.json' }] }).success, false);
});

test('an uncertain direct native outcome retains its holder and pending guidance despite a saved result hash', async t => {
  let installed;
  const f = fixture(t, () => {
    assert.equal(controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'remove').control.state, 'deferred');
    return report();
  });
  installed = await installGuide(f.root);
  const opened = api.openNativeRoleJob(f.root, { role: 'WF.P-RES', requirement: 'Inspect only the pinned guidance.', skills: ['guide'] });
  const prepared = f.session.prepare(opened, { assignment_ref: opened.assignment_ref, agentName: opened.role }, true);
  const actual = await createLocalDelegator(f.vscode, api.nativeWorkerProfiles, f.session).invoke(
    { agentName: opened.role, prompt: opened.prompt, description: opened.description }, opaque, undefined, undefined, prepared.prepared);
  // The simulated host retained partial text but lost its ended-state
  // acknowledgement. A content hash is not proof that the invocation settled.
  const state = api.recordNativeRoleResult(f.root, { request_ref: opened.request_ref, assignment_ref: opened.assignment_ref,
    invocation: { ...actual.metadata, status: 'uncertain' }, raw_result: actual.raw_result });
  assert.ok(state.result_hash); assert.equal(state.completion, 'incomplete');
  f.session.settle(state, true);
  const control = api.readNativeCapabilityControl(f.root, `skill:${installed.components[0].id}`);
  assert.equal(control.active_count, 1); assert.equal(control.new_admissions, false);
  assert.equal(existsSync(join(f.root, '.github/skills/guide/SKILL.md')), true);
});

test('a settled generic MCP binding sharing a built-in ID changes only its own binding', async t => {
  const f = fixture(t, () => {
    assert.equal(api.controlNativeMcpBinding(f.root, 'playwright', 'disable').control.state, 'deferred');
    return report();
  }, { connectorId: 'playwright' });
  api.setPluginEnabled(f.root, 'playwright', true);
  const before = api.readPluginControlStatus(f.root).plugins.find(plugin => plugin.id === 'playwright');
  assert.equal(before.enabled, true);
  const result = await f.runner.role({ role: 'WF.P-RES', requirement: 'Inspect a bounded connector fixture.', mcp: ['playwright'] }, opaque);
  assert.equal(result.status, 'role-completed', JSON.stringify(result)); assert.equal(f.calls.length, 1);
  assert.equal(api.readNativeMcpBindingControl(f.root, 'playwright').state, 'disabled');
  assert.equal(api.readNativeMcpBindingControl(f.root, 'playwright').active_count, 0);
  assert.equal(api.readPluginControlStatus(f.root).plugins.find(plugin => plugin.id === 'playwright').enabled, true,
    'Generic native binding ownership does not authorize built-in provider changes');
});

test('a direct professional report with findings completes its assigned scope in the monitor without software acceptance', async t => {
  const f = fixture(t, () => report({ verdict: 'findings', findings: ['The design lacks an explicit invalid-input requirement.'] }));
  const result = await f.runner.role({ role: 'WF.P-RES', requirement: 'Review design gaps only.' }, opaque);
  assert.equal(result.status, 'role-completed', JSON.stringify(result)); assert.equal(result.accepted, false);
  const state = stateForRole(f.root, result), view = api.nativeRoleListForMonitor(f.root).find(item => item.workflow_id === state.request_ref);
  assert.equal(state.status, 'findings'); assert.equal(view.status, 'role-completed'); assert.equal(view.live, false); assert.equal(view.accepted, false);
  assert.deepEqual(view.stages.filter(stage => stage.state !== 'not-applicable').map(stage => [stage.id, stage.state]),
    [['architecture', 'completed'], ['module-design', 'completed']]);
});
