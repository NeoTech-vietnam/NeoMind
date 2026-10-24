import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { assignmentReport, contextPacket, recordFingerprint, strings, submitTask, workRecordProblems } from './engineering.js';
import { readAgentActivity, reportAgentActivity, type AgentActivityState } from './agent-activity.js';
import {
  assignmentAllowedPaths, assignmentTaskOptions, authorizeReportedAssignment, claimReportedAssignment, resolveReportedAssignment,
  type ReportedAssignment, type ReportedAssignmentCredential,
} from './native-assignment.js';
import { atomicWrite, getRecord, hash, safePath, withOperationLock } from './storage.js';
import { roleCapabilities } from './tools.js';
import type { ProjectRecord } from './types.js';

export type AssignmentRuntimeCode = 'INVALID_INPUT' | 'AUTH_REQUIRED' | 'CONTEXT_MISMATCH' |
  'SCOPE_DENIED' | 'STALE_BASELINE' | 'IDEMPOTENCY_CONFLICT' | 'CHECK_FAILED' | 'INTERNAL_ERROR';
export class AssignmentRuntimeError extends Error {
  constructor(public readonly code: AssignmentRuntimeCode, public readonly phase: string,
    message: string, public readonly next_action: string, public readonly retryable = false) {
    super(message); this.name = 'AssignmentRuntimeError';
  }
  toJSON() { return { code: this.code, phase: this.phase, message: this.message,
    retryable: this.retryable, next_action: this.next_action }; }
}
/** Agent-readable contract, shared by context and host adapters without synthetic report text. */
export const assignmentResultJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'outcome', 'summary', 'inputs', 'decisions', 'evidence_refs',
    'evidence_notes', 'limitations', 'lessons'],
  properties: {
    schema_version: { const: 1 }, outcome: { enum: ['completed', 'blocked', 'failed'] },
    summary: { type: 'string', minLength: 24, maxLength: 8000 },
    inputs: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' } },
    decisions: { type: 'array', minItems: 1, maxItems: 64, items: {
      type: 'object', additionalProperties: false, required: ['decision', 'basis'],
      properties: { decision: { type: 'string' }, basis: { type: 'string' } },
    } },
    evidence_refs: { type: 'array', maxItems: 64, items: { type: 'string' },
      description: 'Actual same-workflow evidence record IDs; do not invent a passing result.' },
    evidence_notes: { type: 'array', maxItems: 64, items: { type: 'string' },
      description: 'Actual observations and method limitations; required if no evidence record supplies substantive content.' },
    limitations: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' } },
    lessons: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' } },
    changes: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false,
      required: ['path', 'description'], properties: { path: { type: 'string' }, description: { type: 'string' } } } },
    submit_task: { type: 'boolean', default: false },
  },
} as const;
function fail(message: string): never {
  throw new AssignmentRuntimeError('INVALID_INPUT', 'validate', message,
    'Correct the typed input once; do not retry the unchanged request.');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a typed assignment object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) fail('Unknown or protected assignment fields are not permitted.');
  return result;
}
function text(value: unknown, label: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    fail(`${label} must contain bounded substantive text.`);
  return value.trim();
}
function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 64) fail(`${label} must be a bounded text array.`);
  return value.map(item => text(item, label));
}
function guarded<T>(phase: string, operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof AssignmentRuntimeError) throw error;
    const message = error instanceof Error ? error.message : 'Assignment operation failed.';
    const code: AssignmentRuntimeCode = /superseded|no longer the current|changed before|stale/i.test(message) ? 'STALE_BASELINE' :
      /Invalid.*assignment|unclaimed|claim token|ENOENT.*reported-assignments/i.test(message) ? 'AUTH_REQUIRED' :
      /escapes|cannot perform|cannot impersonate|another workflow|only inside unsigned/i.test(message) ? 'SCOPE_DENIED' :
      /task|workflow is closed|in-progress|submission/i.test(message) ? 'CONTEXT_MISMATCH' :
      /Work record|section|Evidence|artifact/i.test(message) ? 'CHECK_FAILED' : 'INTERNAL_ERROR';
    throw new AssignmentRuntimeError(code, phase, message,
      code === 'AUTH_REQUIRED' ? 'Use the actual prepared packet to open this delegate assignment; omit absent optional credentials.' :
      code === 'STALE_BASELINE' ? 'Inspect current assignment context and resume through the current actor; do not replay an old claim.' :
      'Inspect assignment context, correct the reported prerequisite, then resume the same assignment.');
  }
}
function credential(value: unknown): ReportedAssignmentCredential {
  const parsed = object(value, ['id', 'token']);
  if (typeof parsed.id !== 'string' || !/^local-report-[a-f0-9]{40}$/.test(parsed.id) ||
    typeof parsed.token !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.token))
    throw new AssignmentRuntimeError('AUTH_REQUIRED', 'open', 'A complete server-issued assignment credential is required.',
      'Claim the actual packet.id and packet.claim_token. Never construct blank or partial credentials.');
  return { id: parsed.id, token: parsed.token };
}
function actorFor(root: string, value: ReportedAssignmentCredential): ReportedAssignment {
  return resolveReportedAssignment(root, credential(value));
}

/** Explicit per-delegate handle. Never binds a global actor to a shared MCP connection. */
export function openAssignment(root: string, input: {
  packet?: { id: string; claim_token: string }; credential?: ReportedAssignmentCredential;
}) {
  return guarded('open', () => {
    object(input, ['packet', 'credential']);
    if ((input.packet === undefined) === (input.credential === undefined)) fail('Supply exactly one prepared packet or existing credential.');
    let handle: ReportedAssignmentCredential;
    if (input.packet !== undefined) {
      const packet = object(input.packet, ['id', 'claim_token']);
      const valid = credential({ id: packet.id, token: packet.claim_token });
      const claimed = claimReportedAssignment(root, valid.id, valid.token);
      handle = { id: claimed.id, token: claimed.token };
    } else handle = credential(input.credential);
    return { schema_version: 1 as const, handle, context: assignmentContext(root, handle) };
  });
}

export function assignmentContext(root: string, handle: ReportedAssignmentCredential) {
  return guarded('context', () => {
    const actor = actorFor(root, handle), workflow = getRecord(root, actor.workflow_id);
    authorizeReportedAssignment(root, actor, 'record_get', { id: actor.workflow_id }, true);
    const task = actor.task_id ? getRecord(root, actor.task_id) : undefined;
    if (task) authorizeReportedAssignment(root, actor, 'task_context', { id: task.meta.id }, true);
    const taskContext = task ? contextPacket(root, task.meta.id, 18000, actor.role) : null;
    if (taskContext !== null && (typeof taskContext !== 'object' || Array.isArray(taskContext)))
      fail('Task context must be a structured object.');
    const capabilities = roleCapabilities(actor.role);
    const retiredProducer = task?.meta.owner === actor.role && task.meta.data.invocation_id !== actor.id &&
      strings(task.meta.data.prior_invocation_ids).includes(actor.id);
    const current = (actor.role !== 'manager' || workflow.meta.data.reported_manager_invocation_id === actor.id) && !retiredProducer;
    const closed = /^completed/.test(String(workflow.meta.data.phase)) ||
      ['completed', 'cancelled', 'superseded'].includes(workflow.meta.status);
    const lifecycle_warning = current && !closed ? observeOpenedAssignment(root, actor) : undefined;
    return {
      schema_version: 1 as const, assignment_id: actor.assignment_id, invocation_id: actor.id,
      profile_id: actor.profile_id, role: actor.role, objective: actor.objective,
      workflow_id: actor.workflow_id, task_id: actor.task_id ?? null, assurance: actor.assurance,
      current_actor: current, can_mutate: current && !closed, workflow_phase: workflow.meta.data.phase ?? null,
      allowed_paths: task ? assignmentAllowedPaths(actor, task) : [],
      ...(actor.recovery ? { recovery: actor.recovery } : {}),
      ...(actor.role === 'manager' ? { task_options: assignmentTaskOptions(root, actor.workflow_id).map(({ record: _record, ...option }) => option) } : {}),
      ...(lifecycle_warning ? { lifecycle_warning } : {}),
      baseline: { workflow_fingerprint: recordFingerprint(workflow),
        task_fingerprint: task ? recordFingerprint(task) : null },
      task_context: task && taskContext ? { ...taskContext, allowed_paths: assignmentAllowedPaths(actor, task) } : null,
      permitted_operations: capabilities.operations,
      progress_contract: actor.profile_id !== 'coordinator' || actor.role === 'manager'
        ? { tool: 'assignment_progress', required: ['reported_assignment', 'state', 'summary'],
          derived: ['workflow_id', 'profile_id', 'assignment_id', 'invocation_id', 'task_id'] }
        : null,
      result_contract: { schema_version: 1, required: ['outcome', 'summary', 'inputs', 'decisions',
        'evidence_refs', 'evidence_notes', 'limitations', 'lessons'],
      optional: ['changes', 'submit_task'],
      json_schema: assignmentResultJsonSchema,
      obligations: ['Use substantive assignment content; missing reasoning cannot be synthesized by the runtime.',
        'Reported completion does not establish independent verification or engineering acceptance.'] },
      boundary: 'Unsigned local attribution. This handle does not attest launch, independent process, model identity or signed execution.',
    };
  });
}

const telemetryWarning = 'Advisory lifecycle telemetry is unavailable; the saved result and required engineering gates remain authoritative.';
function observeOpenedAssignment(root: string, actor: ReportedAssignment): string | undefined {
  if (actor.profile_id === 'coordinator' && actor.role !== 'manager') return;
  try {
    const journalPath = safePath(root, `.neomind/native/assignment-runtime/${actor.id}.json`);
    if (existsSync(journalPath) && JSON.parse(readFileSync(journalPath, 'utf8')).output) return;
    const latest = readAgentActivity(root).latest.find(event => event.invocation_id === actor.id);
    if (latest) return;
    const value = { workflow_id: actor.workflow_id, assignment_id: actor.profile_id === 'coordinator' ? 'coordinator' : actor.assignment_id,
      profile_id: actor.profile_id, invocation_id: actor.id, ...(actor.task_id ? { task_id: actor.task_id } : {}),
      state: 'running' as const, summary: `Opened bounded ${actor.profile_id} assignment context.` };
    authorizeReportedAssignment(root, actor, 'agent_activity', value);
    reportAgentActivity(root, value);
  } catch { return telemetryWarning; }
}

export function assignmentProgress(root: string, handle: ReportedAssignmentCredential,
  input: { state: AgentActivityState; summary: string }) {
  return guarded('progress', () => {
    object(input, ['state', 'summary']);
    if (!['dispatched', 'running', 'waiting', 'completed', 'blocked', 'failed'].includes(input.state))
      fail('Progress state must identify a supported assignment observation.');
    const actor = actorFor(root, handle);
    const value = { workflow_id: actor.workflow_id,
      assignment_id: actor.profile_id === 'coordinator' ? 'coordinator' : actor.assignment_id,
      profile_id: actor.profile_id, invocation_id: actor.id,
      ...(actor.task_id ? { task_id: actor.task_id } : {}), state: input.state,
      summary: text(input.summary, 'Progress summary', 240).replace(/\s+/g, ' ') };
    authorizeReportedAssignment(root, actor, 'agent_activity', value);
    return reportAgentActivity(root, value);
  });
}

export interface AssignmentResultInput {
  schema_version: 1;
  outcome: 'completed' | 'blocked' | 'failed';
  summary: string;
  inputs: string[];
  decisions: { decision: string; basis: string }[];
  evidence_refs: string[];
  evidence_notes: string[];
  limitations: string[];
  lessons: string[];
  changes?: { path: string; description: string }[];
  submit_task?: boolean;
}
interface Artifact { path: string; description: string; sha256: string }
interface ResultOutput {
  schema_version: 1; assignment_id: string; outcome: AssignmentResultInput['outcome'];
  report_id: string; report_fingerprint?: string; submitted_task_id: string | null; artifacts: Artifact[];
  remaining_gates: string[]; activity_event_id: string | null;
  telemetry_warning?: string;
}
interface Journal { schema_version: 1; input_hash: string; baseline_hash?: string; output?: ResultOutput }
function validateResult(value: AssignmentResultInput): AssignmentResultInput {
  const parsed = object(value, ['schema_version', 'outcome', 'summary', 'inputs', 'decisions',
    'evidence_refs', 'evidence_notes', 'limitations', 'lessons', 'changes', 'submit_task']);
  if (parsed.schema_version !== 1 || !['completed', 'blocked', 'failed'].includes(String(parsed.outcome)))
    fail('Result requires schema_version 1 and a supported outcome.');
  if (!Array.isArray(parsed.decisions) || !parsed.decisions.length || parsed.decisions.length > 64)
    fail('Decisions must describe the actual choices and their basis.');
  const decisions = parsed.decisions.map(item => {
    const decision = object(item, ['decision', 'basis']);
    return { decision: text(decision.decision, 'Decision'), basis: text(decision.basis, 'Decision basis') };
  });
  const changes = parsed.changes === undefined ? [] : parsed.changes;
  if (!Array.isArray(changes) || changes.length > 128) fail('Changes must be a bounded artifact array.');
  if (parsed.submit_task !== undefined && typeof parsed.submit_task !== 'boolean') fail('submit_task must be boolean.');
  if (parsed.submit_task === true && parsed.outcome !== 'completed') fail('Only a completed producer result can request task submission.');
  return { schema_version: 1, outcome: parsed.outcome as AssignmentResultInput['outcome'],
    summary: text(parsed.summary, 'Summary'), inputs: list(parsed.inputs, 'Inputs'), decisions,
    evidence_refs: list(parsed.evidence_refs, 'Evidence references'), evidence_notes: list(parsed.evidence_notes, 'Evidence notes'),
    limitations: list(parsed.limitations, 'Limitations'), lessons: list(parsed.lessons, 'Lessons'),
    changes: changes.map(item => { const change = object(item, ['path', 'description']);
      return { path: text(change.path, 'Artifact path', 1024), description: text(change.description, 'Artifact description') }; }),
    submit_task: parsed.submit_task === true };
}
function artifact(root: string, actor: ReportedAssignment, change: { path: string; description: string }): Artifact {
  const path = change.path.replaceAll('\\', '/'), normalized = posix.normalize(path);
  if (path !== normalized || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path === '..' || path.startsWith('../') ||
    /^(?:\.git|\.neomind|\.taskforces|\.verythinker)(?:\/|$)/i.test(path))
    fail('Changed artifacts require canonical project-relative public output paths.');
  const task = actor.task_id ? getRecord(root, actor.task_id) : undefined;
  const allowed = task ? assignmentAllowedPaths(actor, task).map(value => posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '')) : [];
  if (!task || !allowed.some(prefix => prefix === '.' || path === prefix || path.startsWith(`${prefix}/`)))
    throw new AssignmentRuntimeError('SCOPE_DENIED', 'result', 'Changed artifact is outside the assigned task allowed_paths.',
      'Request an explicitly scoped task before reporting this artifact.');
  const location = safePath(root, path), stat = lstatSync(location);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Changed artifact must be an existing regular file.');
  return { ...change, path, sha256: hash(readFileSync(location)) };
}
function bullets(values: string[]): string { return values.map(value => `- ${value}`).join('\n'); }

/** Persist substantive content through existing guards; completion is never automatic acceptance. */
export function assignmentResult(root: string, handle: ReportedAssignmentCredential, value: AssignmentResultInput): ResultOutput {
  return guarded('result', () => {
    const actor = actorFor(root, handle), input = validateResult(value);
    const targets = [actor.workflow_id, ...(actor.task_id ? [actor.task_id] : [])];
    authorizeReportedAssignment(root, actor, 'assignment_report', { target_ids: targets });
    return withOperationLock(root, `assignment-runtime-${hash(actor.id)}`, () => {
      const journalPath = safePath(root, `.neomind/native/assignment-runtime/${actor.id}.json`);
      const digest = hash(JSON.stringify(input));
      const journal: Journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) :
        { schema_version: 1, input_hash: digest };
      if (journal.schema_version !== 1 || journal.input_hash !== digest)
        throw new AssignmentRuntimeError('IDEMPOTENCY_CONFLICT', 'result', 'This assignment already has a different result intent.',
          'Inspect the existing result and prepare a fresh assignment for changed substantive output.');
      if (journal.output) return journal.output;
      const artifacts = (input.changes ?? []).map(change => artifact(root, actor, change));
      const evidence = input.evidence_refs.map(id => {
        authorizeReportedAssignment(root, actor, 'record_get', { id }, true);
        const record = getRecord(root, id);
        if (record.meta.type !== 'evidence') fail('Evidence references must identify actual stored evidence records.');
        return record;
      });
      const body = `# Objective\n${actor.objective}\n\n# Inputs and Sources\n${bullets(input.inputs)}\n\n` +
        `# Decisions and Rationale\n${bullets(input.decisions.map(item => `${item.decision} Basis: ${item.basis}`))}\n\n` +
        `# Results\n${input.summary}\n${bullets(artifacts.map(item => `${item.path}: ${item.description} (SHA-256 ${item.sha256})`))}\n\n` +
        `# Evidence\n${bullets([...input.evidence_notes, ...evidence.map(record =>
          `${record.meta.id}: ${record.meta.title}; recorded result ${String(record.meta.data.result ?? record.meta.status)}.`)])}\n\n` +
        `# Limitations\n${bullets(input.limitations)}\n\n# Lessons\n${bullets(input.lessons)}\n`;
      const reportProblems = workRecordProblems(root, body);
      if (reportProblems.length) throw new AssignmentRuntimeError('INVALID_INPUT', 'result', reportProblems.join('\n'),
        'Supply the missing substantive content and retry; no result intent has been saved.');
      const baseline = hash(JSON.stringify({ body, artifacts, evidence: evidence.map(record => recordFingerprint(record)) }));
      if (journal.baseline_hash !== undefined && journal.baseline_hash !== baseline)
        throw new AssignmentRuntimeError('STALE_BASELINE', 'result', 'Artifact or evidence bytes changed after this result intent was saved.',
          'Inspect the interrupted result and prepare a fresh bounded assignment for the changed baseline.');
      journal.baseline_hash = baseline;
      let task: ProjectRecord | undefined;
      if (input.submit_task) {
        if (!actor.task_id) fail('Task submission requires an assigned producer task.');
        authorizeReportedAssignment(root, actor, 'task_submit', { id: actor.task_id });
        task = getRecord(root, actor.task_id);
        if (!['in-progress', 'submitted'].includes(task.meta.status)) fail('Task must be in progress before producer submission.');
        if (task.meta.status === 'submitted') {
          const submission = task.meta.data.submission as { summary?: string; work_record_id?: string } | undefined;
          if (submission?.summary !== input.summary || !submission.work_record_id || getRecord(root, submission.work_record_id).body !== body)
            fail('Existing task submission differs from this assignment result; inspect and use the repair lifecycle.');
        }
      }
      // An intent precedes engineering writes, so interrupted clients reconcile the same result.
      atomicWrite(journalPath, JSON.stringify(journal) + '\n');
      const report = assignmentReport(root, { target_ids: targets, body, invocation_id: actor.id,
        role: actor.role, assurance: actor.assurance });
      if (task && task.meta.status !== 'submitted') submitTask(root, task.meta.id, input.summary, body);
      // Some composed specialist roles use the Coordinator profile but cannot own its activity key.
      const canProgress = actor.profile_id !== 'coordinator' || actor.role === 'manager';
      let event: ReturnType<typeof assignmentProgress> | undefined;
      let telemetry_warning: string | undefined;
      if (canProgress) try {
        event = assignmentProgress(root, handle, { state: input.outcome, summary: input.summary.slice(0, 240).replace(/\s+/g, ' ') });
      } catch { telemetry_warning = telemetryWarning; }
      const output: ResultOutput = { schema_version: 1, assignment_id: actor.assignment_id, outcome: input.outcome,
        report_id: report.meta.id, report_fingerprint: recordFingerprint(report), submitted_task_id: input.submit_task ? actor.task_id! : null,
        artifacts, activity_event_id: event?.id ?? null,
        ...(telemetry_warning ? { telemetry_warning } : {}),
        remaining_gates: input.outcome === 'completed' ? ['Run or inspect required checks.',
          'Obtain independent review and Coordinator acceptance where required.'] :
          ['Resolve the reported limitation and prepare a fresh bounded follow-up assignment.'] };
      atomicWrite(journalPath, JSON.stringify({ ...journal, output }) + '\n');
      return output;
    });
  });
}
