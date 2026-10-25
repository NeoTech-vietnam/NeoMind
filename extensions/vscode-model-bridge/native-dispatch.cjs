const { createHash, randomUUID } = require('node:crypto');
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const { isAbsolute, join, relative, resolve } = require('node:path');

const TOOL_NAME = 'neomind_advance_workflow';
const LEDGER = 'neomind.nativeDispatch.v1';
const PACKET = /^local-report-[a-f0-9]{40}$/;
const RECORD = /^[A-Za-z0-9][A-Za-z0-9-]{1,119}-(?:KNW|TASK|REQ|CHK|EVD|REV)-\d{4,}$/;
const SHA = /^[a-f0-9]{64}$/;
const states = ['completed', 'completed-without-output', 'failed', 'cancelled', 'running', 'unknown'];
const coordinatorOperations = ['workflow_plan', 'record_get', 'record_create', 'record_update', 'cornell_research_compile', 'note_create', 'note_validate', 'procedure_register', 'manager_finish'];
const hash = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
class NativeDispatchError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeDispatchError'; this.code = code; }
}
function fail(code, message) { throw new NativeDispatchError(code, message); }
function observationValue(item) {
  if (item === undefined || item === null) return undefined;
  if (!only(item, ['packet_id', 'state', 'observation_id']) || !states.includes(item.state) ||
      typeof item.observation_id !== 'string' || !item.observation_id.trim() || item.observation_id.length > 160)
    fail('INVALID_INPUT', 'An optional callback must describe an actual native observation with its stable observation_id.');
  const packet = item.packet_id === null || (typeof item.packet_id === 'string' && !item.packet_id.trim()) ? undefined : item.packet_id;
  if (packet !== undefined && !PACKET.test(packet)) fail('INVALID_INPUT', 'Use an issued packet identifier or omit it for the current saved stage.');
  return { ...(packet ? { packet_id: packet } : {}), state: item.state, observation_id: item.observation_id };
}
function inputValue(value) {
  if (object(value) && Object.hasOwn(value, 'workflow_id')) {
    if (!only(value, ['workflow_id', 'operation', 'parameters', 'observation']) || !RECORD.test(value.workflow_id) ||
        (value.operation !== undefined && !['advance', ...coordinatorOperations].includes(value.operation)) ||
        (value.parameters !== undefined && (!object(value.parameters) || Object.hasOwn(value.parameters, 'reported_assignment') ||
          (value.parameters.workflow_id !== undefined && value.parameters.workflow_id !== value.workflow_id))) ||
        ((value.operation ?? 'advance') === 'advance' && value.parameters !== undefined && Object.keys(value.parameters).length > 0) ||
        ((value.operation ?? 'advance') !== 'advance' && value.observation !== undefined))
      fail('INVALID_INPUT', 'Select the saved workflow and a supported Coordinator operation. The host supplies its own backend-issued credential.');
    const callback = observationValue(value.observation);
    return { workflow_id: value.workflow_id, operation: value.operation ?? 'advance', parameters: value.parameters ?? {},
      ...(callback ? { observation: callback } : {}) };
  }
  if (!only(value, ['reported_assignment', 'observation']) || !only(value.reported_assignment, ['id', 'token']) ||
      !PACKET.test(value.reported_assignment.id) || !SHA.test(value.reported_assignment.token))
    fail('INVALID_INPUT', 'Use only the actual Coordinator handle returned by assignment_open; never construct an identity or claim token.');
  const input = { reported_assignment: { id: value.reported_assignment.id, token: value.reported_assignment.token } };
  const callback = observationValue(value.observation);
  if (callback) input.observation = callback;
  return input;
}
function parseJson(result) {
  if (result?.isError || result?.toolResultError) fail('BACKEND_REJECTED', 'The underlying tool refused the operation; inspect its authenticated workflow state.');
  const values = [];
  for (const part of result?.content ?? []) if (typeof part?.value === 'string' && part.value.length <= 2_000_000) {
    try { const value = JSON.parse(part.value); if (object(value)) values.push(value); } catch {}
  }
  if (values.length === 1 && values[0].code === 'AUTH_REQUIRED')
    fail('AUTH_REQUIRED', 'Use the actual Coordinator handle returned by assignment_open. A packet claim_token is not an access token; bootstrap/open omit outer reported_assignment.');
  if (values.length !== 1 || values[0].error) fail('BACKEND_REJECTED', 'NeoMind did not return one successful structured response. Preserve the saved workflow and correct its actual authentication or state.');
  return values[0];
}
function localPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f]/.test(value))
    fail('INVALID_HOST_SCOPE', 'Native dispatch requires a trusted local project and User-configured NeoMind runtime.');
  try { return realpathSync.native(value); } catch { fail('INVALID_HOST_SCOPE', 'The trusted local project or runtime is unavailable.'); }
}
function regular(path, limit) {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error();
    return readFileSync(path, 'utf8'); } catch { fail('INVALID_HOST_SCOPE', 'Native dispatch requires bounded regular runtime and agent profile files.'); }
}
function catalog(vscode, name) {
  const tools = (vscode.lm?.tools ?? []).filter(tool => tool.name === name);
  if (tools.length !== 1 || typeof vscode.lm?.invokeTool !== 'function')
    fail('TOOL_UNAVAILABLE', 'The exact NeoMind MCP tools and built-in runSubagent tool must be available in this Local chat.');
  return tools[0];
}
function validateHandoff(value, runtime, root) {
  const packet = value.packet;
  const profile = runtime.agentProfiles?.find(profile => profile.id === packet?.profile_id);
  const call = packet?.handoff?.native_call, args = call?.arguments;
  const allowed = value.stage === 'implementation' ? ['implementer', 'debugger'] : value.stage === 'verification' ? ['verifier'] : value.stage === 'review' ? ['reviewer'] : [];
  const role = value.stage === 'implementation' ? 'developer' : value.stage === 'verification' ? 'check-executor' : 'reviewer';
  if (!profile || !allowed.includes(profile.id) || !profile.roles.includes(packet.role) ||
      packet.role !== role ||
      packet.schema_version !== 1 || !PACKET.test(packet.id) || packet.id !== value.packet_id ||
      packet.workflow_id !== value.workflow_id || packet.assurance !== 'unsigned-local-assignment' || packet.state !== 'prepared' ||
      typeof packet.task_id !== 'string' || !RECORD.test(packet.task_id) ||
      !only(call, ['tool', 'arguments']) || call.tool !== 'runSubagent' ||
      !only(args, ['agentName', 'description', 'prompt']) || Object.keys(args).length !== 3 ||
      args.agentName !== profile.name || args.agentName !== packet.handoff.agent ||
      args.description !== `NeoMind ${profile.id} assignment` || typeof args.prompt !== 'string' ||
      args.prompt.length < 24 || args.prompt.length > 128_000 || args.prompt !== packet.handoff.prompt)
    fail('INVALID_HANDOFF', 'The saved backend handoff does not match its issued role, task and exact native call. No delegate was launched.');
  const file = join(root, `.github/agents/neomind-${profile.id}.agent.md`);
  const physical = localPath(file), inside = relative(root, physical);
  if (inside.startsWith('..') || isAbsolute(inside)) fail('INVALID_HANDOFF', 'The selected agent profile escapes the actual open project.');
  const text = regular(file, 128_000), name = /^name:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(text)?.[1];
  if (name !== profile.name) fail('INVALID_HANDOFF', 'The installed named specialist profile differs from the backend catalog. Refresh its managed profile before dispatch.');
  return { packet, args };
}
function terminalState(result) {
  if (result?.isError || result?.toolResultError) return 'failed';
  const text = (result?.content ?? []).filter(part => typeof part?.value === 'string').map(part => part.value).join('\n').trim();
  if (/^(?:Error invoking subagent:|Agent error:|Error: No default agent available|Tool execution denied:|The user chose to skip the tool call|Autopilot skipped this tool call)/i.test(text)) return 'failed';
  return !text || text === 'Agent completed with no output' ? 'completed-without-output' : 'completed';
}
function safeResult(value, privateValues, dispatched = false, observation) {
  if (!object(value) || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.status) || !RECORD.test(value.workflow_id))
    fail('INVALID_BACKEND_RESULT', 'The backend returned an invalid workflow action; no inferred completion is accepted.');
  const sanitize = (input, depth = 0) => {
    if (depth > 14) return null;
    if (typeof input === 'string') { let text = input.slice(0, 32_000); for (const secret of privateValues) if (secret) text = text.split(secret).join('[private]'); return text; }
    if (input === null || ['number', 'boolean'].includes(typeof input)) return input;
    if (Array.isArray(input)) return input.slice(0, 512).map(item => sanitize(item, depth + 1));
    if (object(input)) return Object.fromEntries(Object.entries(input).filter(([key]) =>
      !/^(?:__proto__|constructor|prototype|token|claim_token|reported_assignment|handle|open_input|prompt|handoff|packet|native_call)$/i.test(key))
      .slice(0, 128).map(([key, item]) => [key, sanitize(item, depth + 1)]));
    return null;
  };
  const result = { status: dispatched && ['prepared', 'followup_prepared'].includes(value.status) ? 'next_delegate_ready' : value.status,
    backend_status: value.status, workflow_id: value.workflow_id, dispatched };
  for (const key of ['stage', 'task_id', 'check_ids', 'final_report_id', 'phase', 'persisted_phase'])
    if (value[key] !== undefined) result[key] = sanitize(value[key]);
  if (value.status === 'operation_completed') { result.operation = value.operation; result.result = sanitize(value.result); }
  if (observation) result.observation = observation;
  if (['ready_for_cornell', 'ready_for_closure'].includes(value.status) && object(value.cornell)) {
    const allowed = ['workflow_id', 'requirement_ids', 'task_ids', 'report_ids', 'evidence_ids', 'note_ids', 'prior_evidence_ids',
      'worker_notes_required', 'compiler', 'topic', 'schema_version', 'requirement_id', 'expected_requirement_revision', 'task_id',
      'date', 'output_dir', 'context', 'constraints', 'acceptance_criteria', 'applicability_disposition', 'sources', 'worked_example', 'required_authored_sections'];
    result.cornell = sanitize(Object.fromEntries(allowed.filter(key => value.cornell[key] !== undefined).map(key => [key, value.cornell[key]])));
  }
  result.next_action = result.status === 'operation_completed' ? 'Use the returned semantic result and continue through the same workflow selector. This operation result alone does not establish workflow completion.' :
    result.status === 'next_delegate_ready' ? 'Call neomind_advance_workflow again for this same workflow to launch the next saved stage. No second delegate was launched by this invocation.' :
    value.status === 'ready_for_cornell' ? 'Author the one final readable Cornell note using the returned actual references and compiler, then advance the same workflow.' :
    value.status === 'ready_for_closure' ? 'Validate the current final Cornell note and call manager_finish with the same actual Coordinator handle. Publication authorization remains separate.' :
    value.status === 'completed' ? 'Reuse the saved final report. No new delegate was launched.' :
    'Continue from the saved backend state. Wait for an actual active delegate; never fabricate completion, credentials, task IDs or a replacement launch.';
  return result;
}

/** A Local chat LM tool adapter. All workflow/auth mutations still cross actual MCP tools. */
function createNativeDispatchHost({ vscode, context, loadRuntime }) {
  let disposed = false, generation = 0, storageQueue = Promise.resolve();
  const busy = new Set(), aborters = new Set(), disposables = [], managers = new Map();
  const hostId = randomUUID();
  const stored = context.globalState?.get(LEDGER, {});
  if (!object(stored) || !context.globalState?.update) fail('INVALID_STORAGE', 'Native dispatch requires its extension-owned interruption journal.');
  const journal = new Map(Object.entries(stored));
  const invalidate = () => { generation++; managers.clear(); for (const abort of aborters) abort(); };
  if (vscode.workspace.onDidChangeWorkspaceFolders) disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(invalidate));
  if (vscode.workspace.onDidChangeConfiguration) disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration?.('neomind.bridge.runtimePath')) invalidate();
  }));
  const persist = async (key, record) => {
    if (!journal.has(key) && journal.size >= 2048) fail('DISPATCH_HISTORY_FULL', 'Preserve the existing dispatch journal and review its retained uncertain operations before starting more.');
    journal.set(key, record);
    const snapshot = Object.fromEntries(journal);
    storageQueue = storageQueue.catch(() => {}).then(() => context.globalState.update(LEDGER, snapshot));
    try { await storageQueue; } catch { fail('INVALID_STORAGE', 'Native dispatch could not preserve its interruption journal. No automatic retry is safe.'); }
  };
  async function invoke(options, cancellation) {
    let input = inputValue(options?.input);
    const selectedWorkflow = input.workflow_id, operation = input.operation, parameters = input.parameters;
    const privateValues = input.reported_assignment ? [input.reported_assignment.token] : [];
    if (!options?.toolInvocationToken) fail('CHAT_CONTEXT_REQUIRED', 'Invoke this tool inside the active Local Copilot Coordinator conversation. A command or standalone MCP process cannot manufacture its chat token.');
    if (!vscode.workspace.isTrusted) fail('WORKSPACE_TRUST_REQUIRED', 'Workspace Trust is required for native dispatch.');
    const lock = selectedWorkflow ?? input.reported_assignment.id;
    if (busy.has(lock)) return { status: 'dispatch_in_progress', dispatched: false, next_action: 'Wait for the existing host invocation; do not launch a duplicate delegate.' };
    busy.add(lock);
    const initialGeneration = generation;
    let launchKey, launched, scope, nativeInvoked = false;
    const active = () => {
      if (disposed || generation !== initialGeneration || cancellation?.isCancellationRequested)
        fail('HOST_CONTEXT_CHANGED', 'The native dispatch context was interrupted. Preserve actual state; completion is not inferred.');
      if (!vscode.workspace.isTrusted) fail('WORKSPACE_TRUST_REQUIRED', 'Workspace Trust is required for native dispatch.');
    };
    const guarded = async operation => {
      active(); let abort, listener;
      const interrupted = new Promise((_, reject) => { abort = () => reject(new NativeDispatchError('HOST_CONTEXT_CHANGED', 'The actual host operation was interrupted.')); aborters.add(abort);
        listener = cancellation?.onCancellationRequested?.(abort); });
      try { const result = await Promise.race([Promise.resolve().then(operation), interrupted]); active(); return result; }
      finally { aborters.delete(abort); listener?.dispose(); }
    };
    const call = async (name, value) => { catalog(vscode, name); return parseJson(await guarded(() => vscode.lm.invokeTool(name,
      { input: value, toolInvocationToken: options.toolInvocationToken }, cancellation))); };
    const assertScope = () => {
      active();
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.length || folders.some(folder => folder.uri.scheme !== 'file') ||
          folders.map(folder => localPath(folder.uri.fsPath)).sort().join('\0') !== scope.folders)
        fail('INVALID_HOST_SCOPE', 'The open local workspace changed during native dispatch.');
      const configured = vscode.workspace.getConfiguration('neomind.bridge').inspect('runtimePath')?.globalValue;
      if (!samePath(localPath(configured), scope.runtimeRoot) || scope.runtime.getRuntimeBuildFingerprint(scope.runtimeRoot) !== scope.identity.build_fingerprint)
        fail('RUNTIME_MISMATCH', 'The trusted User-configured runtime changed during native dispatch.');
    };
    const checkIdentity = async () => {
      const identity = await call('mcp_neomind_runtime_info', {});
      if (identity.schema_version !== 1 || !SHA.test(identity.build_fingerprint) ||
          typeof identity.server_instance_id !== 'string' || !identity.server_instance_id ||
          typeof identity.started_at !== 'string' || typeof identity.package_version !== 'string')
        fail('RUNTIME_MISMATCH', 'The actual NeoMind MCP runtime did not provide a valid serving identity.');
      const project = localPath(identity.project_root), runtimeRoot = localPath(identity.runtime_root);
      if (scope) {
        assertScope();
        if (!samePath(project, scope.project) || !samePath(runtimeRoot, scope.runtimeRoot) ||
            identity.server_instance_id !== scope.identity.server_instance_id || identity.build_fingerprint !== scope.identity.build_fingerprint)
          fail('RUNTIME_MISMATCH', 'The serving MCP runtime changed during the native operation. Preserve its uncertain dispatch state.');
      } else {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (!folders.length || folders.some(folder => folder.uri.scheme !== 'file') ||
            !folders.some(folder => samePath(localPath(folder.uri.fsPath), project)))
          fail('INVALID_HOST_SCOPE', 'The actual MCP project must be an exact open local workspace folder.');
        const configured = vscode.workspace.getConfiguration('neomind.bridge').inspect('runtimePath')?.globalValue;
        if (!samePath(localPath(configured), runtimeRoot)) fail('RUNTIME_MISMATCH', 'The serving MCP runtime differs from the trusted User setting.');
        let manifest;
        try { manifest = JSON.parse(regular(join(runtimeRoot, 'package.json'), 64_000)); } catch { fail('RUNTIME_MISMATCH', 'The trusted runtime package cannot be validated.'); }
        const runtime = await guarded(() => loadRuntime(project));
        if (manifest.name !== 'neomind' || manifest.version !== identity.package_version || typeof runtime.getRuntimeBuildFingerprint !== 'function' ||
            runtime.getRuntimeBuildFingerprint(runtimeRoot) !== identity.build_fingerprint)
          fail('RUNTIME_MISMATCH', 'The serving MCP runtime bytes differ from the trusted installed NeoMind build.');
        scope = { project, runtimeRoot, runtime, identity, folders: folders.map(folder => localPath(folder.uri.fsPath)).sort().join('\0') };
        assertScope();
      }
    };
    const validateWorkflow = value => {
      if (!RECORD.test(value?.workflow_id)) fail('INVALID_BACKEND_RESULT', 'The backend did not identify a valid saved workflow.');
      if (selectedWorkflow && value.workflow_id !== selectedWorkflow)
        fail('WORKFLOW_MISMATCH', 'The backend response must belong to the selected saved workflow.');
      const workflow = scope.runtime.getRecord(scope.project, value.workflow_id);
      if (workflow.meta.data.kind !== 'manager-workflow' || workflow.meta.data.execution_mode !== 'copilot-native' || workflow.meta.data.routing_required === true)
        fail('WORKFLOW_MISMATCH', 'This host dispatcher is only for the existing unsigned Local Copilot software workflow. Strict and other clients retain their execution paths.');
      if (launched && value.workflow_id !== launched.workflow_id) fail('INVALID_BACKEND_RESULT', 'The backend action changed workflow during native dispatch.');
      return workflow;
    };
    const pendingState = value => {
      if (!['needs_observation', 'wait_for_delegate'].includes(value?.status) || !PACKET.test(value.packet_id) ||
          !['implementation', 'verification', 'review'].includes(value.stage)) return undefined;
      const key = hash(`${scope.project}\0${value.packet_id}`), record = journal.get(key);
      if (record && (record.packet_id !== value.packet_id || !RECORD.test(record.workflow_id) || record.stage !== value.stage ||
          !['started', 'unknown', 'returned', 'reconciled'].includes(record.state) ||
          (value.workflow_id !== undefined && value.workflow_id !== record.workflow_id)))
        fail('INVALID_STORAGE', 'The saved dispatch journal differs from the backend current stage.');
      return { key, record, value: record && value.workflow_id === undefined ? { ...value, workflow_id: record.workflow_id } : value };
    };
    const waitResult = value => ({ status: value.status, backend_status: value.status, stage: value.stage,
      packet_id: value.packet_id, ...(value.workflow_id ? { workflow_id: value.workflow_id } : {}), dispatched: false,
      next_action: 'The backend has an already claimed native delegate. Observe its actual native state before supplying a callback; do not reconstruct its private handoff or launch a duplicate.' });
    const reconcile = async (record, alreadyDispatched) => {
      await checkIdentity(); assertScope();
      const observation = { packet_id: record.packet_id, state: record.terminal_state, observation_id: record.observation_id };
      const response = await call('mcp_neomind_workflow_next', { reported_assignment: input.reported_assignment, observation });
      const pending = pendingState(response), value = pending?.value ?? response;
      if (value.workflow_id !== undefined || !pending) validateWorkflow(value);
      assertScope();
      await persist(launchKey, { ...record, state: 'reconciled' });
      if (pending && value.workflow_id === undefined) return { ...waitResult(value), dispatched: alreadyDispatched, observation };
      return safeResult(value, privateValues, alreadyDispatched, observation);
    };
    try {
      await checkIdentity(); assertScope();
      if (selectedWorkflow) {
        const workflow = validateWorkflow({ workflow_id: selectedWorkflow });
        if (typeof workflow.meta.data.final_report_id === 'string') {
          const saved = scope.runtime.workflowStatus(scope.project, selectedWorkflow);
          if (saved.phase === 'completed' && RECORD.test(saved.final_report_id))
            return safeResult({ status: 'completed', workflow_id: selectedWorkflow, phase: saved.phase, final_report_id: saved.final_report_id }, privateValues);
        }
        const managerKey = `${scope.project}\0${scope.identity.server_instance_id}\0${selectedWorkflow}`;
        let handle = managers.get(managerKey);
        if (!handle) {
          const packet = await call('mcp_neomind_assignment_bootstrap', { workflow_id: selectedWorkflow,
            profile_id: 'coordinator', role: 'manager', assignment_id: `native-host-${hostId}-${hash(managerKey).slice(0, 20)}`,
            objective: 'Coordinate the existing saved software workflow through bounded implementation, independent verification, final documentation and closure.' });
          if (packet.workflow_id !== selectedWorkflow || packet.profile_id !== 'coordinator' || packet.role !== 'manager' ||
              !PACKET.test(packet.id) || !only(packet.open_input, ['packet']) ||
              !only(packet.open_input.packet, ['id', 'claim_token']) || packet.open_input.packet.id !== packet.id || !SHA.test(packet.open_input.packet.claim_token))
            fail('INVALID_BACKEND_RESULT', 'The backend must issue the exact Coordinator packet for this workflow.');
          privateValues.push(packet.open_input.packet.claim_token);
          const opened = await call('mcp_neomind_assignment_open', packet.open_input);
          const actor = opened.context;
          if (!only(opened.handle, ['id', 'token']) || opened.handle.id !== packet.id || !SHA.test(opened.handle.token) ||
              actor?.workflow_id !== selectedWorkflow || actor.profile_id !== 'coordinator' || actor.role !== 'manager' ||
              actor.current_actor !== true || actor.assurance !== 'unsigned-local-assignment')
            fail('AUTH_REQUIRED', 'The backend must authenticate the current Coordinator for this selected workflow.');
          handle = opened.handle;
          managers.set(managerKey, handle);
        }
        privateValues.push(handle.token);
        input = { reported_assignment: handle, ...(input.observation ? { observation: input.observation } : {}) };
        if (operation !== 'advance') {
          const result = await call(`mcp_neomind_${operation}`, { ...parameters,
            ...(operation === 'manager_finish' ? { workflow_id: selectedWorkflow } : {}), reported_assignment: handle });
          assertScope();
          return safeResult({ status: 'operation_completed', workflow_id: selectedWorkflow, operation, result }, privateValues);
        }
      }
      const response = await call('mcp_neomind_workflow_next', input), pending = pendingState(response), value = pending?.value ?? response;
      if (value.workflow_id !== undefined || !pending) validateWorkflow(value);
      assertScope();
      if (pending) {
        const prior = pending.record;
        if (prior && ['returned', 'reconciled'].includes(prior.state) && ['completed', 'completed-without-output', 'failed'].includes(prior.terminal_state)) {
          launchKey = pending.key; launched = prior; return await reconcile(prior, false);
        }
        return prior ? { ...waitResult(value), status: 'dispatch_unknown',
          next_action: 'The prior native launch is running or uncertain. Inspect its actual native state; no terminal callback or duplicate launch is inferred.' } : waitResult(value);
      }
      if (!['prepared', 'followup_prepared'].includes(value.status)) return safeResult(value, privateValues);
      const native = catalog(vscode, 'runSubagent'), schema = native.inputSchema;
      if (schema?.type !== 'object' || !['prompt', 'description', 'agentName'].every(key => schema.properties?.[key]) ||
          !['prompt', 'description'].every(key => schema.required?.includes(key)) || schema.required.some(key => !['prompt', 'description', 'agentName'].includes(key)))
        fail('TOOL_UNAVAILABLE', 'The installed runSubagent input contract is incompatible; no model override or guessed native call is allowed.');
      const { packet, args } = validateHandoff(value, scope.runtime, scope.project);
      privateValues.push(packet.claim_token, args.prompt);
      launchKey = hash(`${scope.project}\0${packet.id}`);
      const prior = journal.get(launchKey);
      if (prior) {
        if (prior.packet_id !== packet.id || prior.workflow_id !== packet.workflow_id || !['started', 'unknown', 'returned', 'reconciled'].includes(prior.state))
          fail('INVALID_STORAGE', 'The saved dispatch journal cannot be reconciled safely.');
        if (['returned', 'reconciled'].includes(prior.state) && ['completed', 'completed-without-output', 'failed'].includes(prior.terminal_state)) {
          launched = prior; return await reconcile(prior, false);
        }
        return { status: 'dispatch_unknown', workflow_id: packet.workflow_id, stage: value.stage, dispatched: false,
          next_action: 'A prior launch is still running or uncertain. Inspect its actual native state; never relaunch this packet or invent a terminal callback.' };
      }
      launched = { packet_id: packet.id, workflow_id: packet.workflow_id, stage: value.stage, state: 'started',
        observation_id: `native-host-${hash(`${scope.project}\0${packet.id}`).slice(0, 40)}` };
      await persist(launchKey, launched); assertScope();
      let nativeResult;
      try { nativeResult = await guarded(() => { nativeInvoked = true;
        return vscode.lm.invokeTool('runSubagent', { input: args, toolInvocationToken: options.toolInvocationToken }, cancellation); }); }
      catch { await persist(launchKey, { ...launched, state: 'unknown' }); return { status: 'dispatch_unknown', workflow_id: packet.workflow_id,
        stage: value.stage, dispatched: nativeInvoked, next_action: 'Native dispatch was interrupted or its transport failed. Inspect actual native state before supplying a terminal observation; no completion or retry is inferred.' }; }
      assertScope();
      launched = { ...launched, state: 'returned', terminal_state: terminalState(nativeResult) };
      await persist(launchKey, launched); assertScope();
      return await reconcile(launched, true);
    } catch (error) {
      if (launchKey && launched) {
        if (error?.code === 'HOST_CONTEXT_CHANGED' || !vscode.workspace.isTrusted || generation !== initialGeneration || disposed)
          await persist(launchKey, { ...launched, state: 'unknown' });
        return { status: launched.state === 'returned' ? 'delegate_returned_reconciliation_pending' : 'dispatch_unknown',
          workflow_id: launched.workflow_id, dispatched: nativeInvoked,
          next_action: 'The actual native operation could not be fully reconciled. Preserve its dispatch journal and recheck the same workflow; never launch a duplicate or infer engineering completion.' };
      }
      if (error instanceof NativeDispatchError) throw error;
      fail('HOST_OPERATION_FAILED', 'The actual host/MCP operation could not be validated. Preserve the saved workflow; no delegate completion is claimed.');
    } finally { busy.delete(lock); }
  }
  return { invoke, dispose() { if (disposed) return; disposed = true; invalidate(); for (const item of disposables) item.dispose(); } };
}
function activateNativeDispatch(vscode, context, loadRuntime) {
  if (!vscode.lm?.registerTool) return;
  const host = createNativeDispatchHost({ vscode, context, loadRuntime });
  context.subscriptions.push(host, vscode.lm.registerTool(TOOL_NAME, {
    async invoke(options, cancellation) {
      let value;
      try { value = await host.invoke(options, cancellation); }
      catch (error) { value = { status: 'blocked', code: error instanceof NativeDispatchError ? error.code : 'HOST_OPERATION_FAILED',
        next_action: error instanceof NativeDispatchError ? error.message : 'The native host operation failed safely; preserve actual saved state.' }; }
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value))]);
    },
    prepareInvocation() { return { invocationMessage: 'Advance the saved NeoMind workflow and run at most one assigned native specialist.' }; },
  }));
}
module.exports = { TOOL_NAME, activateNativeDispatch, createNativeDispatchHost };
