import { existsSync, readFileSync, chmodSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicWrite, getRecord, hash, now, readConfig, safePath, withOperationLock, updateRecord } from './storage.js';
import { nativeWorkflowRecord } from './engineering.js';
import { agentProfiles, type AgentProfileId } from './agent-profiles.js';
import { roleCapabilities } from './tools.js';

export interface ReportedAssignment {
  schema_version: 1; id: string; workflow_id: string; profile_id: AgentProfileId; role: string;
  assignment_id: string; objective: string; task_id?: string; created_at: string;
  assurance: 'unsigned-local-assignment'; state: 'prepared' | 'claimed'; claimed_at?: string;
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
  if (!existsSync(path) && create) {
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
export function prepareReportedAssignment(root: string, input: {
  workflow_id: string; profile_id: AgentProfileId; role: string; assignment_id: string; objective: string; task_id?: string;
}) {
  readConfig(root); nativeWorkflow(root, input.workflow_id, true);
  if (!input || !agentProfiles.some(profile => profile.id === input.profile_id && (profile.roles as readonly string[]).includes(input.role)) ||
      typeof input.assignment_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(input.assignment_id) ||
      typeof input.objective !== 'string' || input.objective.trim().length < 20 || input.objective.length > 4000)
    throw new Error('Prepare a bounded assignment with a matching profile/core role, stable assignment ID and substantive objective.');
  if (input.task_id) {
    const task = getRecord(root, input.task_id);
    if (task.meta.type !== 'task' || task.meta.data.workflow_id !== input.workflow_id) throw new Error('Assigned task belongs to another workflow.');
  }
  const id = `local-report-${hash(JSON.stringify([input.workflow_id, input.assignment_id])).slice(0, 40)}`;
  return withOperationLock(root, 'reported-assignments', () => {
    const path = assignmentPath(root, id);
    const value: ReportedAssignment = existsSync(path) ? readAssignment(root, id) : {
      schema_version: 1, id, ...input, objective: input.objective.trim(), created_at: now(),
      assurance: 'unsigned-local-assignment', state: 'prepared',
    };
    if (['workflow_id', 'profile_id', 'role', 'assignment_id', 'task_id'].some(key =>
      value[key as keyof ReportedAssignment] !== input[key as keyof typeof input]) || value.objective !== input.objective.trim())
      throw new Error('Assignment identity already belongs to a different bounded packet; use a fresh assignment ID for a new delegation.');
    if (!existsSync(path)) atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
    return { ...value, claim_token: token(root, id, 'claim', true),
      boundary: 'Prepared local correlation only. Pass claim_token to the actual delegate; Coordinator never claims or reports on its behalf. No launch, inference or platform identity is attested.' };
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
        (actor.profile_id === 'coordinator' && actor.role !== 'manager'))
      throw new Error('Reported activity must use its assigned profile and assignment correlation key; Coordinator activity belongs to the actual manager.');
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
