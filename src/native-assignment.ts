import { existsSync, readFileSync, chmodSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicWrite, getRecord, hash, loadRecords, now, readConfig, safePath, withOperationLock, updateRecord } from './storage.js';
import { nativeWorkflowRecord, recordFingerprint, workRecordProblems } from './engineering.js';
import { legacyAgentProfiles as agentProfiles, type AgentProfileId } from './agent-profiles.js';
import { roleCapabilities } from './tools.js';

export interface ReportedAssignment {
  schema_version: 1; id: string; workflow_id: string; profile_id: AgentProfileId; role: string;
  assignment_id: string; objective: string; task_id?: string; created_at: string;
  assurance: 'unsigned-local-assignment'; state: 'prepared' | 'claimed'; claimed_at?: string;
  recovery?: { root_packet_id: string; previous_packet_id: string; record_ids: string[]; artifact_paths: string[] };
}
export interface ReportedAssignmentCredential { id: string; token: string }
const location = '.neomind/native/reported-assignments';
function nativeWorkflow(root: string, id: string, requireOpen = false) {
  const workflow = getRecord(root, id);
  if (workflow.meta.data.kind !== 'manager-workflow' || !nativeWorkflowRecord(root, workflow) || workflow.meta.data.routing_required === true)
    throw new Error('Local assignment identities are available only inside unsigned native full workflows; strict work keeps signed invocation binding.');
  if (requireOpen && (/^completed/.test(String(workflow.meta.data.phase)) || ['completed', 'cancelled', 'superseded'].includes(workflow.meta.status)))
    throw new Error('This workflow is closed; new assignment claims or mutations require a new increment.');
  return workflow;
}
function assignmentPath(root: string, id: string): string {
  if (!/^local-report-[a-f0-9]{40}$/.test(id)) throw new Error('Invalid local reported assignment identity.');
  return safePath(root, `${location}/${id}.json`);
}
function secret(root: string, create = false): Buffer {
  const path = safePath(root, `${location}/issuer.key`);
  if (!existsSync(path)) {
    if (!create) throw new Error('Local assignment issuer key is missing. Restore the existing private key; existing assignment identities cannot rotate it.');
    atomicWrite(path, randomBytes(32));
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
  const value = readFileSync(path);
  if (value.length !== 32) throw new Error('Local assignment issuer key is invalid.');
  return value;
}
function token(root: string, id: string, kind: 'claim' | 'access', create = false): string {
  return createHmac('sha256', secret(root, create)).update(`${kind}:${id}`).digest('hex');
}
function equalToken(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function readAssignment(root: string, id: string): ReportedAssignment {
  const value = JSON.parse(readFileSync(assignmentPath(root, id), 'utf8')) as ReportedAssignment;
  if (value.schema_version !== 1 || value.id !== id || value.assurance !== 'unsigned-local-assignment' ||
      !['prepared', 'claimed'].includes(value.state) || typeof value.workflow_id !== 'string' ||
      !agentProfiles.some(profile => profile.id === value.profile_id && (profile.roles as readonly string[]).includes(value.role)))
    throw new Error('Invalid local reported assignment record.');
  nativeWorkflow(root, value.workflow_id);
  return value;
}
export const readReportedAssignment = readAssignment;
export class AssignmentContextError extends Error {
  constructor(public code: string, message: string, public next_action: string) { super(message); this.name = 'AssignmentContextError'; }
}
export function authorizeNativeManager(root: string, handle: ReportedAssignmentCredential, operation = 'assignment_prepare') {
  const manager = resolveReportedAssignment(root, handle);
  if (manager.profile_id !== 'coordinator' || manager.role !== 'manager')
    throw new AssignmentContextError('SCOPE_DENIED', 'Only the actual Coordinator manager can delegate or recover specialist work.', 'Return the findings to the current Coordinator.');
  const workflow = nativeWorkflow(root, manager.workflow_id, true);
  if (workflow.meta.data.reported_manager_invocation_id !== manager.id)
    throw new AssignmentContextError('SCOPE_DENIED', 'This Coordinator is superseded.', 'Resume through the current claimed Coordinator.');
  authorizeReportedAssignment(root, manager, operation, { workflow_id: manager.workflow_id });
  return manager;
}
export function assignmentAllowedPaths(actor: ReportedAssignment, task: ReturnType<typeof getRecord>): string[] {
  const field = actor.role === 'developer' ? 'implementation_paths' : ['check-executor', 'verifier'].includes(actor.role) ? 'verification_paths' : 'allowed_paths';
  const value = task.meta.data[field] ?? (task.meta.data.native_software_plan_hash === undefined ? task.meta.data.allowed_paths : undefined);
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [];
}
export function assignmentTaskOptions(root: string, workflowId: string) {
  return loadRecords(root).filter(record => record.meta.type === 'task' && record.meta.data.workflow_id === workflowId &&
    !['accepted', 'superseded', 'completed', 'cancelled'].includes(record.meta.status)).map(record => ({
      selector: `task-${hash(JSON.stringify([workflowId, record.meta.id])).slice(0, 24)}`,
      title: record.meta.title, status: record.meta.status, record,
    }));
}
export interface NativeAssignmentInspection {
  status: 'continue_workflow' | 'report_saved' | 'awaiting_result'; workflow_id: string; packet_id: string;
  root_packet_id: string; packet_state: ReportedAssignment['state']; profile_id: AgentProfileId; role: string; task_id: string | null;
  report_id?: string; outcome?: 'completed' | 'blocked' | 'failed';
  partial_refs: { record_ids: string[]; artifact_paths: string[] }; next_action: string;
}
export function inspectNativeAssignment(root: string, handle: ReportedAssignmentCredential, packetId: string): NativeAssignmentInspection {
  const manager = authorizeNativeManager(root, handle), packet = readAssignment(root, packetId);
  if (packet.workflow_id !== manager.workflow_id) throw new AssignmentContextError('SCOPE_DENIED', 'Specialist packet belongs to another workflow.', 'Select a saved packet from the current workflow.');
  const records = loadRecords(root).filter(record => record.meta.data.workflow_id === packet.workflow_id &&
    [record.meta.data.invocation_id, record.meta.data.author_invocation_id].includes(packet.id));
  const reports = records.filter(record => record.meta.data.kind === 'work-record' && record.meta.owner === packet.role &&
    record.meta.data.invocation_id === packet.id && workRecordProblems(root, record.body).length === 0);
  const journalPath = safePath(root, `.neomind/native/assignment-runtime/${packet.id}.json`);
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : undefined;
  const output = journal?.schema_version === 1 ? journal.output : undefined;
  const report = output ? reports.find(record => record.meta.id === output.report_id) : reports.at(-1);
  if (output && (!report || output.assignment_id !== packet.assignment_id || !['completed', 'blocked', 'failed'].includes(output.outcome)))
    throw new AssignmentContextError('RESULT_INTEGRITY', 'Saved assignment result does not match its actual report and actor.', 'Inspect the saved result and report before continuing or replacing work.');
  if (output?.report_fingerprint !== undefined && output.report_fingerprint !== recordFingerprint(report!))
    throw new AssignmentContextError('RESULT_INTEGRITY', 'Saved assignment report changed after its typed result.', 'Inspect the changed report and obtain a fresh bounded result; do not reuse edited completion.');
  if (output) for (const artifact of output.artifacts ?? []) {
    if (typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string' || hash(readFileSync(safePath(root, artifact.path))) !== artifact.sha256)
      throw new AssignmentContextError('STALE_BASELINE', 'Saved assignment artifact changed after its result.', 'Inspect the changed baseline and obtain fresh verification.');
  }
  const artifactPaths = records.flatMap(record => [record.meta.data.artifact_path, ...(Array.isArray(record.meta.data.output_paths) ? record.meta.data.output_paths : [])])
    .filter((path): path is string => typeof path === 'string');
  const status = output?.outcome === 'completed' ? 'continue_workflow' : !output && report ? 'report_saved' : 'awaiting_result';
  return { status, workflow_id: packet.workflow_id, packet_id: packet.id, root_packet_id: packet.recovery?.root_packet_id ?? packet.id,
    packet_state: packet.state, profile_id: packet.profile_id, role: packet.role, task_id: packet.task_id ?? null,
    ...(report ? { report_id: report.meta.id } : {}), ...(output ? { outcome: output.outcome } : {}),
    partial_refs: { record_ids: [...new Set([...(packet.recovery?.record_ids ?? []), ...records.map(record => record.meta.id)])].slice(-64),
      artifact_paths: [...new Set([...(packet.recovery?.artifact_paths ?? []), ...artifactPaths])].slice(0, 64) },
    next_action: status === 'continue_workflow' ? 'Reuse the saved actual result and continue the remaining workflow gates.' :
      status === 'report_saved' ? 'Inspect this actual low-level report; its outcome is not typed completion.' : 'Observe the actual delegate callback before preparing bounded recovery.' };
}
export function delegateAssignment(root: string, handle: ReportedAssignmentCredential, input: {
  profile_id: AgentProfileId; objective: string; scope?: 'workflow' | 'task'; task_selector?: string | null;
}) {
  if (!input || Object.keys(input).some(key => !['profile_id', 'objective', 'scope', 'task_selector'].includes(key)))
    throw new AssignmentContextError('INVALID_INPUT', 'Unknown or protected delegation fields; task IDs and workflow IDs are derived.', 'Supply only profile_id, objective and an optional backend task selector.');
  const taskSelector = input.task_selector === null || (typeof input.task_selector === 'string' && !input.task_selector.trim())
    ? undefined : input.task_selector;
  const manager = authorizeNativeManager(root, handle);
  const profile = agentProfiles.find(profile => profile.id === input.profile_id);
  if (!profile || profile.id === 'coordinator') throw new AssignmentContextError('INVALID_INPUT', 'Select a specialist profile, not Coordinator.', 'Continue Coordinator work here and delegate a bounded specialist objective.');
  if (typeof input.objective !== 'string' || input.objective.trim().length < 20 || input.objective.length > 4000)
    throw new AssignmentContextError('INVALID_INPUT', 'Delegation needs a substantive bounded objective.', 'Describe the assigned work and expected result.');
  const scope = input.scope ?? (['implementer', 'debugger', 'reviewer', 'verifier'].includes(profile.id) ? 'task' : 'workflow');
  if (!['task', 'workflow'].includes(scope) || (['implementer', 'debugger'].includes(profile.id) && scope !== 'task'))
    throw new AssignmentContextError('INVALID_INPUT', 'Production implementation needs an assigned task.', 'Prepare the bounded task and select it through its backend selector.');
  const options = assignmentTaskOptions(root, manager.workflow_id);
  const visible = options.map(({ record: _record, ...option }) => option);
  const role = profile.id === 'verifier' && scope === 'task' ? 'check-executor' : profile.roles[0];
  const choices = options.filter(option => role !== 'developer' || option.record.meta.owner === role);
  let selected: typeof choices[number] | undefined;
  if (scope === 'task') {
    if (taskSelector !== undefined) {
      selected = choices.find(option => option.selector === taskSelector);
      if (!selected) throw new AssignmentContextError('INVALID_TASK_SELECTOR', 'Task selector is unknown, foreign or incompatible.', 'Read current assignment context and choose an issued task selector; never construct a task ID.');
    } else if (choices.length !== 1) return { status: choices.length ? 'needs_task_selection' as const : 'needs_task' as const,
      workflow_id: manager.workflow_id, task_options: visible, next_action: choices.length ? 'Choose an issued selector for the bounded task.' : 'Prepare a bounded same-workflow task before delegation.' };
    else selected = choices[0];
  } else if (taskSelector !== undefined) throw new AssignmentContextError('INVALID_INPUT', 'Workflow-scoped delegation does not accept a task selector.', 'Omit the selector or use task scope.');
  const assignment_id = `delegate-${profile.id}-${hash(JSON.stringify([manager.workflow_id, scope, selected?.record.meta.id ?? null, input.objective.trim()])).slice(0, 24)}`;
  const id = `local-report-${hash(JSON.stringify([manager.workflow_id, assignment_id])).slice(0, 40)}`;
  if (existsSync(assignmentPath(root, id)) && readAssignment(root, id).state === 'claimed') {
    const inspection = inspectNativeAssignment(root, handle, id);
    return { ...inspection, status: inspection.status === 'awaiting_result' ? 'wait_for_delegate' as const : inspection.status };
  }
  const packet = prepareReportedAssignment(root, { workflow_id: manager.workflow_id, profile_id: profile.id, role,
    assignment_id, objective: input.objective.trim(), ...(selected ? { task_id: selected.record.meta.id } : {}) }, { requirePrepared: true, requireExistingIssuer: true });
  return { status: 'prepared' as const, workflow_id: manager.workflow_id, packet_id: packet.id, packet,
    next_action: 'Launch the actual specialist with packet.handoff unchanged, then observe its actual callback and saved result.' };
}
function preparedAssignmentResult(root: string, value: ReportedAssignment, createIssuer = false) {
  const workflow = nativeWorkflow(root, value.workflow_id, true);
  const profile = agentProfiles.find(profile => profile.id === value.profile_id)!;
  const claim_token = token(root, value.id, 'claim', createIssuer);
  const open_input = { packet: { id: value.id, claim_token } };
  const codex = workflow.meta.data.execution_mode === 'codex-native';
  const agent = codex ? `neomind-${profile.id}` : profile.name;
  const prompt = [
    `Continue this existing bounded NeoMind assignment as ${profile.name}.`,
    `Workflow: ${value.workflow_id}. Profile: ${value.profile_id}. Core role: ${value.role}. Task: ${value.task_id ?? 'none assigned'}.`,
    `Objective: ${value.objective}`,
    ...(value.recovery ? [`Recovery of ${value.recovery.previous_packet_id}; original lineage ${value.recovery.root_packet_id}. Inspect actual saved records ${JSON.stringify(value.recovery.record_ids)} and artifacts ${JSON.stringify(value.recovery.artifact_paths)}. Preserve the original objective and task scope; report your own actual work under this fresh identity.`] : []),
    ...(value.recovery && value.role === 'developer' && value.task_id && getRecord(root, value.task_id).meta.status === 'submitted'
      ? ['The actual task is already submitted by its original producer. If no implementation change is needed, preserve that submission and save your own typed reuse/result with submit_task:false; do not start, resubmit or reattribute the prior producer work. Implementation changes require the dedicated task repair and fresh producer lifecycle.'] : []),
    `FIRST call assignment_open with exactly this JSON input: ${JSON.stringify(open_input)}`,
    'Do not supply reported_assignment or any outer credential on that first call. Parse its MCP JSON response and retain response.handle privately; only that returned handle belongs in reported_assignment on subsequent calls. Never use the correlation assignment_id as packet.id, or the claim_token as a session access token. Never print credentials in reports.',
    value.profile_id !== 'coordinator' || value.role === 'manager'
      ? 'Opening and saving your result automatically record advisory lifecycle observations. Use assignment_progress only for a meaningful actual state change, with your own returned handle, state and summary; no timer heartbeat is required. Keep the same handle for this already claimed assignment. Telemetry errors never block substantive work or its saved result.'
      : 'Return this composed specialist role\'s findings through assignment_result. The Coordinator activity key belongs to the actual manager; this specialist does not publish its own Coordinator activity. Keep the same private handle for this already claimed assignment.',
    value.profile_id === 'coordinator' && value.role === 'manager'
      ? 'Continue your own Coordinator work here. Do not spawn yourself or start another intake/workflow.'
      : 'Execute this bounded assignment directly. Do not call manager_run, start another intake/workflow, or redelegate it.',
    'Finish substantive work by saving assignment_result with your actual inputs, decisions, findings, evidence and limitations before optional notes or the final response. Return the saved report ID without credentials; never substitute a plan for the assigned implementation or verification.',
    codex
      ? 'Use the current local Codex session and its native tools; this packet does not launch an agent.'
      : 'This assignment runs in local Copilot inside VS Code. Any delegate launch is the Coordinator\'s local VS Code agent-tool action; no GitHub cloud job or CLI inference is required. This packet does not launch an agent.',
    'Stay within the saved workflow, core role and assigned task scope. Preserve its execution mode, network policy, model routing and existing engineering gates.',
  ].join('\n');
  const native_call = !codex && value.state === 'prepared' && !(value.profile_id === 'coordinator' && value.role === 'manager')
    ? { tool: 'runSubagent' as const, arguments: { agentName: agent, description: `NeoMind ${value.profile_id} assignment`, prompt } }
    : undefined;
  return { ...value, claim_token, open_input, handoff: { agent, prompt, ...(native_call ? { native_call } : {}) },
    boundary: 'Prepared local correlation only. Pass the private handoff to the actual delegate; Coordinator never claims or reports on its behalf. No launch, inference or platform identity is attested.' };
}
function assertRecoverableAssignment(root: string, value: ReportedAssignment) {
  const workflow = nativeWorkflow(root, value.workflow_id, true);
  if (value.state !== 'prepared') throw new Error('Only an existing unclaimed prepared assignment can be recovered or bootstrapped. Claimed sessions must use their existing private handle.');
  const history = workflow.meta.data.reported_manager_history;
  if (Array.isArray(history) && history.some(item => item && typeof item === 'object' &&
    (item as { invocation_id?: unknown }).invocation_id === value.id))
    throw new Error('A superseded Coordinator assignment cannot be recovered.');
  if (value.task_id) {
    const task = getRecord(root, value.task_id);
    if (task.meta.type !== 'task' || task.meta.data.workflow_id !== value.workflow_id || !nativeWorkflowRecord(root, task))
      throw new Error('Assignment recovery cannot cross its saved native task/workflow scope.');
    if (['accepted', 'superseded', 'completed', 'cancelled'].includes(task.meta.status) ||
      (Array.isArray(task.meta.data.prior_invocation_ids) && task.meta.data.prior_invocation_ids.includes(value.id)))
      throw new Error('A closed or superseded task assignment cannot be recovered.');
  }
}
export function prepareReportedAssignment(root: string, input: {
  workflow_id: string; profile_id: AgentProfileId; role: string; assignment_id: string; objective: string; task_id?: string;
}, options: { requirePrepared?: boolean; requireExistingIssuer?: boolean; recovery?: ReportedAssignment['recovery'] } = {}) {
  if (input && (input.task_id === null || (typeof input.task_id === 'string' && !input.task_id.trim()))) {
    const { task_id: _absent, ...packet } = input; input = packet;
  }
  readConfig(root); nativeWorkflow(root, input.workflow_id, true);
  if (!input || !agentProfiles.some(profile => profile.id === input.profile_id && (profile.roles as readonly string[]).includes(input.role)) ||
      typeof input.assignment_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(input.assignment_id) ||
      typeof input.objective !== 'string' || input.objective.trim().length < 20 || input.objective.length > 4000)
    throw new Error('Prepare a bounded assignment with a matching profile/core role, stable assignment ID and substantive objective.');
  if (input.task_id) {
    const task = getRecord(root, input.task_id);
    if (task.meta.type !== 'task') throw new AssignmentContextError('NOT_A_TASK', 'Assigned record is not a task.', 'Use context-bound delegation; requirement and workflow records are not task selections.');
    if (task.meta.data.workflow_id !== input.workflow_id) throw new AssignmentContextError('FOREIGN_WORKFLOW', 'Assigned task belongs to another workflow.', 'Select a task issued by the current workflow context.');
  }
  const id = `local-report-${hash(JSON.stringify([input.workflow_id, input.assignment_id])).slice(0, 40)}`;
  return withOperationLock(root, 'reported-assignments', () => {
    const path = assignmentPath(root, id);
    const existing = existsSync(path);
    const value: ReportedAssignment = existing ? readAssignment(root, id) : {
      schema_version: 1, id, ...input, objective: input.objective.trim(), created_at: now(),
      assurance: 'unsigned-local-assignment', state: 'prepared', ...(options.recovery ? { recovery: options.recovery } : {}),
    };
    if (['workflow_id', 'profile_id', 'role', 'assignment_id', 'task_id'].some(key =>
      value[key as keyof ReportedAssignment] !== input[key as keyof typeof input]) || value.objective !== input.objective.trim())
      throw new Error('Assignment identity already belongs to a different bounded packet; use a fresh assignment ID for a new delegation.');
    if (options.requirePrepared) assertRecoverableAssignment(root, value);
    const result = preparedAssignmentResult(root, value, !existing && !options.requireExistingIssuer);
    if (!existing) atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
    return result;
  });
}
/** Recover only an unopened packet's private handoff; never mint a new identity or issuer. */
export function recoverPreparedAssignment(root: string, input: { workflow_id: string; packet_id: string }) {
  readConfig(root);
  return withOperationLock(root, 'reported-assignments', () => {
    nativeWorkflow(root, input.workflow_id, true);
    const value = readAssignment(root, input.packet_id);
    if (value.workflow_id !== input.workflow_id) throw new Error('Assignment recovery must stay within the requested workflow.');
    assertRecoverableAssignment(root, value);
    if (!existsSync(safePath(root, `${location}/issuer.key`)))
      throw new Error('Assignment recovery requires the existing private issuer key. Restore it; recovery never creates or rotates issuer keys.');
    return preparedAssignmentResult(root, value);
  });
}
export function claimReportedAssignment(root: string, id: string, claim: string) {
  return withOperationLock(root, 'reported-assignments', () => {
    const value = readAssignment(root, id);
    if (!equalToken(claim, token(root, id, 'claim'))) throw new Error('Invalid assignment claim token.');
    if (value.state === 'prepared') {
      nativeWorkflow(root, value.workflow_id, true);
      value.state = 'claimed'; value.claimed_at = now();
      atomicWrite(assignmentPath(root, id), JSON.stringify(value, null, 2) + '\n');
    }
    if (value.profile_id === 'coordinator' && value.role === 'manager') {
      withOperationLock(root, `manager-${hash(value.workflow_id)}`, () => {
        const parent = nativeWorkflow(root, value.workflow_id);
        if (parent.meta.data.reported_manager_invocation_id === value.id) return;
        nativeWorkflow(root, value.workflow_id, true);
        const history = Array.isArray(parent.meta.data.reported_manager_history) ? [...parent.meta.data.reported_manager_history] : [];
        if (history.some(item => item && typeof item === 'object' &&
          (item as { invocation_id?: unknown }).invocation_id === value.id))
          throw new Error('This assignment is a superseded Coordinator; resume with the current claimed Coordinator instead of replaying its old claim.');
        history.push({ previous_invocation_id: parent.meta.data.reported_manager_invocation_id ?? parent.meta.data.invocation_id ?? null,
          invocation_id: value.id, at: now(), identity_assurance: value.assurance });
        updateRecord(root, parent.meta.id, { data: { reported_manager_invocation_id: value.id, reported_manager_history: history } }, undefined, current => {
          if (current.meta.revision !== parent.meta.revision) throw new Error('Workflow changed before reported manager attribution; retry the claim.');
        });
      });
    }
    return { ...value, invocation_id: value.id, token: token(root, id, 'access'),
      boundary: 'Unsigned client-reported participation. This local identity is not a platform invocation, signed receipt, model observation or proof of an independent process.' };
  });
}
export function resolveReportedAssignment(root: string, credential: ReportedAssignmentCredential): ReportedAssignment {
  const value = readAssignment(root, credential.id);
  if (value.state !== 'claimed' || !equalToken(credential.token, token(root, value.id, 'access')))
    throw new Error('Invalid or unclaimed local assignment session.');
  return value;
}
export function authorizeReportedAssignment(root: string, actor: ReportedAssignment, operation: string, input: Record<string, unknown>, readOnly = false): void {
  const parent = nativeWorkflow(root, actor.workflow_id, !readOnly && operation !== 'manager_finish');
  if (!readOnly && actor.role === 'manager' && parent.meta.data.reported_manager_invocation_id !== actor.id)
    throw new Error('This assignment is no longer the current Coordinator; resume with the current claimed Coordinator before mutating the workflow.');
  if (!readOnly && actor.task_id) {
    const task = getRecord(root, actor.task_id);
    if (task.meta.owner === actor.role && task.meta.data.invocation_id !== actor.id &&
      Array.isArray(task.meta.data.prior_invocation_ids) && task.meta.data.prior_invocation_ids.includes(actor.id))
      throw new Error('This assignment is a superseded task producer; use the current producer assignment instead of replaying a retired producer.');
  }
  if (!roleCapabilities(actor.role).operations.includes(operation)) throw new Error(`Reported ${actor.role} assignment cannot perform ${operation}.`);
  if (operation === 'agent_activity') {
    const expectedKey = actor.profile_id === 'coordinator' ? 'coordinator' : actor.assignment_id;
    if (input.profile_id !== actor.profile_id || input.assignment_id !== expectedKey ||
        (actor.profile_id === 'coordinator' && actor.role !== 'manager')) {
      const correction = actor.profile_id === 'coordinator' && actor.role !== 'manager'
        ? 'This composed specialist role saves its findings through assignment_result; leave Coordinator activity to the actual manager.'
        : 'Use assignment_progress with your own reported_assignment handle, state and summary; identity and any assigned task are derived. Delegate activity belongs to the actual delegate.';
      throw new Error(`Reported activity must use its assigned profile and assignment correlation key; Coordinator activity belongs to the actual manager. ${correction}`);
    }
  }
  if (['role', 'invocation_id'].some(key => !(operation === 'assignment_prepare' && key === 'role' && actor.role === 'manager') && input[key] !== undefined && input[key] !== (key === 'role' ? actor.role : actor.id)))
    throw new Error('A reported assignment cannot impersonate another role or invocation.');
  const recordIdOperations = new Set(['record_get', 'record_update', 'record_review', 'record_trace', 'verify', 'task_context',
    'task_start', 'task_resume', 'task_submit', 'task_repair', 'task_review', 'task_accept', 'check_run', 'check_inspect', 'evidence_archive',
    'knowledge_publish', 'recipe_run', 'recipe_revise', 'contribution_prepare', 'contribution_submit']);
  const ids = ['workflow_id', ...(recordIdOperations.has(operation) ? ['id'] : []), 'task', 'task_id', 'evidence_id', 'change_id', 'revision_id']
    .map(key => input[key]).filter((id): id is string => typeof id === 'string');
  for (const key of ['target_ids', 'requirement_ids', 'task_ids', 'source_ids', 'knowledge_ids'])
    if (Array.isArray(input[key])) ids.push(...input[key] as string[]);
  if (Array.isArray(input.links)) ids.push(...(input.links as { target: string }[]).map(link => link.target));
  const data = input.data as Record<string, unknown> | undefined;
  if (data && ['confirmed_model', 'requested_model', 'model_provider', 'native_thread_id', 'native_turn_id', 'confirmed_reasoning_effort']
    .some(key => data[key] !== undefined)) throw new Error('Local assignment records cannot attest native model or process observations.');
  if (typeof data?.workflow_id === 'string') ids.push(data.workflow_id);
  if (typeof data?.task_id === 'string') ids.push(data.task_id);
  const note = (input.note ?? (input.parameters as Record<string, unknown> | undefined)?.note) as Record<string, unknown> | undefined;
  if (note) {
    if (typeof note.workflow_id === 'string') ids.push(note.workflow_id);
    for (const key of ['requirement_ids', 'problem_ids']) if (Array.isArray(note[key])) ids.push(...note[key] as string[]);
    const demonstration = note.demonstration as { evidence_ids?: string[] } | undefined;
    ids.push(...(demonstration?.evidence_ids ?? []));
    if (Array.isArray(note.sources)) ids.push(...(note.sources as { record_id?: string }[]).flatMap(source => source.record_id ? [source.record_id] : []));
  }
  if (operation === 'cornell_research_compile') {
    const research = input.input as { requirement_id?: string; workflow_id?: string; task_id?: string; sources?: { record_id?: string }[]; worked_example?: { evidence_ids?: string[] } };
    ids.push(...[research.requirement_id, research.workflow_id, research.task_id].filter((id): id is string => !!id),
      ...(research.sources ?? []).flatMap(source => source.record_id ? [source.record_id] : []), ...(research.worked_example?.evidence_ids ?? []));
  }
  for (const id of ids) {
    const record = getRecord(root, id), workflowId = record.meta.data.kind === 'manager-workflow' ? record.meta.id : record.meta.data.workflow_id ?? record.meta.data.intake_workflow_id;
    if (workflowId !== actor.workflow_id || !nativeWorkflowRecord(root, record)) throw new Error('Reported assignment operation escapes its native workflow.');
    if (actor.task_id && record.meta.type === 'task' && record.meta.id !== actor.task_id)
      throw new Error('Reported assignment operation escapes its assigned task.');
    if (['task_start', 'task_resume', 'task_submit'].includes(operation) && record.meta.type === 'task' && record.meta.owner !== actor.role)
      throw new Error('Task execution and submission belong to the assigned producer role.');
    if (operation === 'task_submit' && record.meta.type === 'task' && record.meta.data.invocation_id !== actor.id)
      throw new Error('Task submission belongs to its active producer assignment.');
  }
}
