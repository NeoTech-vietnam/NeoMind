import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { createNativeDispatchHost, activateNativeDispatch, TOOL_NAME } = require('../extensions/vscode-model-bridge/native-dispatch.cjs');
const manager = { id: `local-report-${'a'.repeat(40)}`, token: 'b'.repeat(64) };
const workflowId = 'NM-DISPATCH-KNW-0001', taskId = 'NM-DISPATCH-TASK-0001';
const fingerprint = 'c'.repeat(64), packetId = `local-report-${'d'.repeat(40)}`;
const profiles = [{ id: 'implementer', name: 'NeoMind Implementer Agent', roles: ['developer'] },
  { id: 'debugger', name: 'NeoMind Debugger Agent', roles: ['developer'] },
  { id: 'verifier', name: 'NeoMind Verifier Agent', roles: ['verifier', 'check-executor'] },
  { id: 'reviewer', name: 'NeoMind Reviewer Agent', roles: ['reviewer'] }];
const json = value => ({ content: [{ value: JSON.stringify(value) }] });
function packet(profileId = 'implementer', id = packetId) {
  const profile = profiles.find(profile => profile.id === profileId);
  const prompt = `PRIVATE-SAVED-HANDOFF-${id}: open the genuine packet before performing the bounded assignment.`;
  const native_call = { tool: 'runSubagent', arguments: { agentName: profile.name,
    description: `NeoMind ${profileId} assignment`, prompt } };
  return { schema_version: 1, id, workflow_id: workflowId, task_id: taskId, profile_id: profileId,
    role: profileId === 'verifier' ? 'check-executor' : profile.roles[0], state: 'prepared', assurance: 'unsigned-local-assignment',
    claim_token: 'e'.repeat(64), open_input: { claim_token: 'e'.repeat(64) }, handoff: { agent: profile.name, prompt, native_call } };
}
function prepared(value = packet(), stage = 'implementation') {
  return { status: 'prepared', stage, workflow_id: workflowId, packet_id: value.id, packet: value };
}
function cancellation() {
  const listeners = new Set();
  return { isCancellationRequested: false, onCancellationRequested(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    cancel() { this.isCancellationRequested = true; for (const fn of listeners) fn(); } };
}
function fixture(t, settings = {}) {
  const base = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'neomind-native-dispatch-')));
  const root = join(base, 'project'), runtimeRoot = join(base, 'runtime');
  mkdirSync(join(root, '.github/agents'), { recursive: true }); mkdirSync(runtimeRoot);
  writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'neomind', version: '0.1.0-alpha.9' }));
  for (const profile of profiles) writeFileSync(join(root, `.github/agents/neomind-${profile.id}.agent.md`), `---\nname: "${profile.name}"\n---\nPerform only this bounded assignment.\n`);
  const identity = { schema_version: 1, package_version: '0.1.0-alpha.9', project_root: root, runtime_root: runtimeRoot,
    build_fingerprint: fingerprint, server_instance_id: 'actual-fixture-server', started_at: new Date().toISOString() };
  const calls = [], state = settings.state ?? new Map(), registered = [], changes = new Set();
  const workspace = { isTrusted: settings.trusted !== false, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
    getConfiguration: () => ({ inspect: () => ({ globalValue: runtimeRoot }) }),
    onDidChangeWorkspaceFolders(fn) { changes.add(fn); return { dispose: () => changes.delete(fn) }; },
    onDidChangeConfiguration: () => ({ dispose() {} }), onDidGrantWorkspaceTrust: () => ({ dispose() {} }) };
  const runtime = { agentProfiles: profiles, getRuntimeBuildFingerprint: () => fingerprint,
    getRecord: () => ({ meta: { id: workflowId, data: { kind: 'manager-workflow', execution_mode: 'copilot-native', routing_required: false } } }) };
  let nextIndex = 0;
  const vscode = { workspace, LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    lm: { tools: [{ name: 'mcp_neomind_runtime_info' }, { name: 'mcp_neomind_workflow_next' },
      { name: 'mcp_neomind_assignment_bootstrap' }, { name: 'mcp_neomind_assignment_open' }, { name: 'mcp_neomind_manager_finish' },
      { name: 'runSubagent', inputSchema: { type: 'object', properties: { agentName: { type: 'string' }, description: { type: 'string' },
        prompt: { type: 'string' }, model: { type: 'string' } }, required: ['prompt', 'description'] } }],
      registerTool(name, tool) { registered.push({ name, tool }); return { dispose() {} }; },
      async invokeTool(name, options, token) {
        calls.push({ name, options, token });
        if (name === 'mcp_neomind_runtime_info') return json({ ...identity, ...settings.identity });
        if (name === 'mcp_neomind_assignment_bootstrap') return json({ schema_version: 1, id: manager.id,
          workflow_id: workflowId, profile_id: 'coordinator', role: 'manager',
          open_input: { packet: { id: manager.id, claim_token: 'e'.repeat(64) } } });
        if (name === 'mcp_neomind_assignment_open') return json({ schema_version: 1, handle: manager,
          context: { workflow_id: workflowId, profile_id: 'coordinator', role: 'manager', current_actor: true,
            assurance: 'unsigned-local-assignment', ...settings.managerContext } });
        if (name === 'mcp_neomind_manager_finish') return json({ phase: 'completed', final_report_id: 'NM-DISPATCH-KNW-0002' });
        if (name === 'mcp_neomind_workflow_next') {
          const response = settings.responses?.[nextIndex++] ?? (options.input.observation ? { status: 'ready_for_closure', workflow_id: workflowId } : prepared());
          return json(typeof response === 'function' ? await response({ calls, vscode, options }) : response);
        }
        if (name === 'runSubagent') return settings.native ? await settings.native({ calls, vscode, options, token }) : { content: [{ value: 'Actual delegate returned its saved report reference.' }] };
        throw new Error('Unexpected tool');
      } } };
  const context = { subscriptions: [], globalState: { get: (key, fallback) => state.get(key) ?? fallback,
    async update(key, value) { state.set(key, structuredClone(value)); } } };
  const loadRuntime = async selected => { assert.equal(selected, root); return runtime; };
  const host = createNativeDispatchHost({ vscode, context, loadRuntime });
  const opaque = Object.freeze({ opaque: 'the-real-host-token' }), token = cancellation();
  const input = { reported_assignment: manager };
  t.after(() => { host.dispose(); assert.equal(dirname(base), realpathSync.native(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  return { root, runtimeRoot, calls, state, registered, changes, workspace, runtime, vscode, context, host, opaque, token, input, loadRuntime };
}

test('host dispatches the exact server handoff without model reconstruction and reconciles one actual terminal callback', async t => {
  const nextPacket = packet('verifier', `local-report-${'f'.repeat(40)}`);
  const app = fixture(t, { responses: [prepared(), prepared(nextPacket, 'verification')] });
  const result = await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  const launch = app.calls.find(call => call.name === 'runSubagent');
  assert.deepEqual(launch.options.input, packet().handoff.native_call.arguments);
  assert.equal(Object.hasOwn(launch.options.input, 'model'), false);
  assert.equal(launch.options.toolInvocationToken, app.opaque); assert.equal(launch.token, app.token);
  const nextCalls = app.calls.filter(call => call.name === 'mcp_neomind_workflow_next');
  assert.deepEqual(nextCalls[0].options.input, app.input);
  assert.equal(nextCalls[1].options.input.observation.packet_id, packetId);
  assert.equal(nextCalls[1].options.input.observation.state, 'completed');
  assert.deepEqual(nextCalls[1].options.input.reported_assignment, manager);
  assert.equal(app.calls.filter(call => call.name === 'runSubagent').length, 1);
  assert.equal(result.status, 'next_delegate_ready'); assert.equal(result.stage, 'verification');
  const visible = JSON.stringify(result), persisted = JSON.stringify([...app.state.values()]);
  for (const privateValue of [manager.token, packet().claim_token, packet().handoff.prompt, launch.options.input.prompt]) {
    assert.equal(visible.includes(privateValue), false); assert.equal(persisted.includes(privateValue), false);
  }
});

test('workflow selector keeps Coordinator credentials inside the host for dispatch and final closure', async t => {
  const app = fixture(t, { responses: [prepared(), { status: 'ready_for_closure', workflow_id: workflowId }] });
  const input = { workflow_id: workflowId };
  const first = await app.host.invoke({ input, toolInvocationToken: app.opaque }, app.token);
  const finished = await app.host.invoke({ input: { ...input, operation: 'manager_finish', parameters: {} }, toolInvocationToken: app.opaque }, app.token);
  assert.equal(first.status, 'ready_for_closure');
  const bootstrap = app.calls.filter(x => x.name === 'mcp_neomind_assignment_bootstrap');
  assert.equal(bootstrap.length, 1);
  assert.equal(bootstrap[0].options.input.profile_id, 'coordinator');
  assert.equal(bootstrap[0].options.input.role, 'manager');
  assert.equal(bootstrap[0].options.input.workflow_id, workflowId);
  const opened = app.calls.find(x => x.name === 'mcp_neomind_assignment_open');
  assert.deepEqual(opened.options.input, { packet: { id: manager.id, claim_token: 'e'.repeat(64) } });
  const finish = app.calls.find(x => x.name === 'mcp_neomind_manager_finish');
  assert.deepEqual(finish.options.input, { workflow_id: workflowId, reported_assignment: manager });
  assert.equal(finished.result.phase, 'completed');
  assert.equal(JSON.stringify([first, finished, [...app.state.values()]]).includes(manager.token), false);
});

test('host-owned credentials never authorize a foreign, stale or specialist context', async t => {
  for (const managerContext of [{ workflow_id: 'NM-OTHER-KNW-0001' }, { current_actor: false }, { profile_id: 'implementer', role: 'developer' }]) {
    const app = fixture(t, { managerContext });
    await assert.rejects(app.host.invoke({ input: { workflow_id: workflowId }, toolInvocationToken: app.opaque }, app.token));
    assert.equal(app.calls.some(x => ['mcp_neomind_workflow_next', 'runSubagent'].includes(x.name)), false);
  }
});

test('workflow input rejects credential injection, unsupported operations and foreign ownership before calling MCP', async t => {
  for (const extra of [{ reported_assignment: manager }, { operation: 'assignment_claim' },
    { operation: 'record_get', parameters: { id: taskId, reported_assignment: manager } },
    { operation: 'manager_finish', parameters: { workflow_id: 'NM-OTHER-KNW-0001' } },
    { operation: 'advance', parameters: { unadvertised: true } }]) {
    const app = fixture(t);
    await assert.rejects(app.host.invoke({ input: { workflow_id: workflowId, ...extra }, toolInvocationToken: app.opaque }, app.token), error => error.code === 'INVALID_INPUT');
    assert.equal(app.calls.length, 0);
  }
});

test('completed workflow replay uses effective backend status without opening another Coordinator', async t => {
  const app = fixture(t);
  app.runtime.getRecord = () => ({ meta: { data: { kind: 'manager-workflow', execution_mode: 'copilot-native', final_report_id: 'NM-DISPATCH-KNW-0002' } } });
  app.runtime.workflowStatus = () => ({ phase: 'completed', final_report_id: 'NM-DISPATCH-KNW-0002' });
  const result = await app.host.invoke({ input: { workflow_id: workflowId }, toolInvocationToken: app.opaque }, app.token);
  assert.equal(result.status, 'completed');
  assert.deepEqual(app.calls.map(x => x.name), ['mcp_neomind_runtime_info']);
});

test('the next host invocation may launch the next prepared stage but never repeats its previous packet', async t => {
  const verifier = prepared(packet('verifier', `local-report-${'f'.repeat(40)}`), 'verification');
  const app = fixture(t, { responses: [prepared(), verifier, verifier, { status: 'ready_for_closure', workflow_id: workflowId }] });
  await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  const launches = app.calls.filter(call => call.name === 'runSubagent');
  assert.equal(launches.length, 2); assert.equal(launches[1].options.input.agentName, 'NeoMind Verifier Agent');
  assert.equal(JSON.stringify(launches[0].options.input) === JSON.stringify(launches[1].options.input), false);
});

test('overlapping calls share the in-flight dispatch and never launch a duplicate delegate', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const app = fixture(t, { native: async () => { started(); await wait; return { content: [{ value: 'Actual bounded report saved.' }] }; } });
  const first = app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  await began;
  const second = await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  assert.equal(second.status, 'dispatch_in_progress'); assert.equal(app.calls.filter(call => call.name === 'runSubagent').length, 1);
  release(); await first;
});

test('cancellation preserves uncertainty across host recreation without a false completed callback or retry', async t => {
  let started; const began = new Promise(resolve => { started = resolve; });
  const app = fixture(t, { responses: [prepared(), { status: 'needs_observation', stage: 'implementation', packet_id: packetId }],
    native: async () => { started(); return await new Promise(() => {}); } });
  const pending = app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  await began; app.token.cancel();
  const result = await pending;
  assert.equal(result.status, 'dispatch_unknown');
  assert.equal(app.calls.filter(call => call.name === 'mcp_neomind_workflow_next').length, 1);
  const replacement = createNativeDispatchHost({ vscode: app.vscode, context: app.context, loadRuntime: app.loadRuntime });
  t.after(() => replacement.dispose());
  const replay = await replacement.invoke({ input: app.input, toolInvocationToken: app.opaque }, cancellation());
  assert.equal(replay.status, 'dispatch_unknown'); assert.equal(app.calls.filter(call => call.name === 'runSubagent').length, 1);
});

test('changed workspace and host disposal cannot record a completed callback', async t => {
  for (const mode of ['workspace', 'dispose']) {
    let finish, started; const began = new Promise(resolve => { started = resolve; });
    const app = fixture(t, { native: async () => { started(); return await new Promise(resolve => { finish = resolve; }); } });
    const pending = app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
    await began;
    if (mode === 'dispose') app.host.dispose(); else for (const fn of app.changes) fn();
    finish({ content: [{ value: 'A late result after host context changed.' }] });
    const result = await pending; assert.equal(result.status, 'dispatch_unknown');
    assert.equal(app.calls.filter(call => call.name === 'mcp_neomind_workflow_next').length, 1);
  }
});

test('actual native error text is failed and empty native output is completed-without-output', async t => {
  for (const [value, expected] of [['Error invoking subagent: Requested agent was not found.', 'failed'],
    ['Agent error: provider request failed.', 'failed'], ['Agent completed with no output', 'completed-without-output']]) {
    const app = fixture(t, { native: async () => ({ content: [{ value }] }) });
    await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
    assert.equal(app.calls.filter(call => call.name === 'mcp_neomind_workflow_next')[1].options.input.observation.state, expected);
  }
});

test('a transport failure after dispatch remains unknown and does not leak the native error', async t => {
  const app = fixture(t, { native: async () => { throw new Error(`PRIVATE-ERROR-${manager.token}`); } });
  const result = await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  assert.equal(result.status, 'dispatch_unknown'); assert.equal(JSON.stringify(result).includes(manager.token), false);
  assert.equal(app.calls.filter(call => call.name === 'mcp_neomind_workflow_next').length, 1);
});

test('a returned delegate retries only its stable callback after reconciliation failure, without launching again', async t => {
  const app = fixture(t, { responses: [prepared(), () => { throw new Error('PRIVATE-MCP-TRANSPORT-ERROR'); },
    { status: 'needs_observation', stage: 'implementation', packet_id: packetId },
    { status: 'ready_for_closure', workflow_id: workflowId }] });
  const first = await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  assert.equal(first.status, 'delegate_returned_reconciliation_pending');
  const recovered = await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  assert.equal(recovered.status, 'ready_for_closure'); assert.equal(recovered.dispatched, false);
  assert.equal(app.calls.filter(call => call.name === 'runSubagent').length, 1);
  const callbacks = app.calls.filter(call => call.name === 'mcp_neomind_workflow_next' && call.options.input.observation);
  assert.equal(callbacks.length, 2); assert.deepEqual(callbacks[0].options.input.observation, callbacks[1].options.input.observation);
  assert.equal(JSON.stringify(recovered).includes('PRIVATE-MCP-TRANSPORT-ERROR'), false);
});

test('failed interruption-journal persistence prevents native launch and cannot claim dispatch', async t => {
  const app = fixture(t); app.context.globalState.update = async () => { throw new Error('PRIVATE-STORAGE-FAILURE'); };
  const result = await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  assert.equal(result.dispatched, false); assert.equal(app.calls.some(call => call.name === 'runSubagent'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE-STORAGE-FAILURE'), false);
});

test('malformed role, model, handoff or foreign workflow is refused before native invocation', async t => {
  for (const mutate of [
    value => { value.packet.handoff.native_call.arguments.agentName += ' {metadata: invalid}'; },
    value => { value.packet.handoff.native_call.arguments.model = 'wrong-model'; },
    value => { value.packet.role = 'manager'; },
    value => { value.packet.workflow_id = 'NM-FOREIGN-KNW-0001'; },
    value => { value.packet.handoff.prompt += ' altered'; },
    value => { value.packet.handoff.native_call.tool = 'run_in_terminal'; },
  ]) {
    const response = prepared(); mutate(response);
    const app = fixture(t, { responses: [response] });
    await assert.rejects(app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token), error => error.code === 'INVALID_HANDOFF');
    assert.equal(app.calls.some(call => call.name === 'runSubagent'), false);
  }
});

test('workspace trust, runtime identity, absent token and incompatible builtin catalog refuse before dispatch', async t => {
  for (const mode of ['trust', 'runtime', 'token', 'catalog', 'strict']) {
    const app = fixture(t, { trusted: mode !== 'trust', identity: mode === 'runtime' ? { build_fingerprint: '0'.repeat(64) } : {} });
    if (mode === 'catalog') app.vscode.lm.tools.find(tool => tool.name === 'runSubagent').inputSchema.required.push('model');
    if (mode === 'strict') app.runtime.getRecord = () => ({ meta: { data: { kind: 'manager-workflow', execution_mode: 'strict', routing_required: true } } });
    await assert.rejects(app.host.invoke({ input: app.input, toolInvocationToken: mode === 'token' ? undefined : app.opaque }, app.token));
    assert.equal(app.calls.some(call => call.name === 'runSubagent'), false);
  }
});

test('Coordinator-only actions return safe Cornell references without launching or echoing private envelope fields', async t => {
  const app = fixture(t, { responses: [{ status: 'ready_for_cornell', workflow_id: workflowId, task_id: taskId,
    cornell: { workflow_id: workflowId, task_id: taskId, requirement_ids: ['NM-DISPATCH-REQ-0001'], evidence_ids: ['NM-DISPATCH-EVD-0001'],
      compiler: 'cornell_research_compile', topic: 'The actual observed module', context: 'A bounded teaching example.',
      acceptance_criteria: ['Return exactly integer one.'], prompt: 'PRIVATE-FAKE-LAUNCH-PROMPT', token: manager.token },
    packet: packet(), private_extra: manager.token }] });
  const result = await app.host.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  assert.equal(result.status, 'ready_for_cornell'); assert.deepEqual(result.cornell.evidence_ids, ['NM-DISPATCH-EVD-0001']);
  assert.equal(result.cornell.compiler, 'cornell_research_compile'); assert.equal(app.calls.some(call => call.name === 'runSubagent'), false);
  const visible = JSON.stringify(result);
  for (const secret of [manager.token, packet().claim_token, packet().handoff.prompt, 'PRIVATE-FAKE-LAUNCH-PROMPT']) assert.equal(visible.includes(secret), false);
});

test('legacy dispatch remains sanitized when explicitly invoked but is not contributed to new chats', async t => {
  const app = fixture(t, { responses: [{ status: 'ready_for_closure', workflow_id: workflowId, token: manager.token }] });
  activateNativeDispatch(app.vscode, app.context, app.loadRuntime);
  assert.equal(app.registered[0].name, TOOL_NAME);
  const result = await app.registered[0].tool.invoke({ input: app.input, toolInvocationToken: app.opaque }, app.token);
  assert.equal(JSON.parse(result.content[0].value).status, 'ready_for_closure');
  assert.equal(JSON.stringify(result).includes(manager.token), false);
  const manifest = require('../extensions/vscode-model-bridge/package.json');
  const contribution = manifest.contributes.languageModelTools.find(tool => tool.name === TOOL_NAME);
  assert.equal(contribution, undefined, 'New Local chats have only the backend-owned WorkForce request tool.');
  assert.deepEqual(manifest.contributes.languageModelTools.map(tool => tool.name), ['workforce_request']);
  assert.equal(manifest.files.includes('native-dispatch.cjs'), true);
});
