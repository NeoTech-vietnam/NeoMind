import { existsSync, readFileSync } from 'node:fs';
import { AssignmentContextError, authorizeNativeManager, inspectNativeAssignment, prepareReportedAssignment,
  readReportedAssignment, recoverPreparedAssignment, type NativeAssignmentInspection, type ReportedAssignmentCredential } from './native-assignment.js';
import { assignmentProgress } from './assignment-runtime.js';
import { verify } from './engineering.js';
import { nativeSoftwareTaskContract } from './native-software.js';
import { atomicWrite, getRecord, hash, now, safePath, withOperationLock } from './storage.js';

export { inspectNativeAssignment } from './native-assignment.js';
export const nativeRecoveryLimit = 2;
export type NativeDelegateObservation = 'running' | 'unknown' | 'completed' | 'completed-without-output' | 'failed' | 'cancelled';
export interface NativeFollowupInput { packet_id: string; observation: NativeDelegateObservation; observation_id: string }
/** Trusted software-controller requirement; never accepted from the public callback payload. */
export interface NativeFollowupOptions { required_gate: 'verified' | 'accepted' }
interface Attempt { packet_id: string; followup_packet_id: string; observation: NativeDelegateObservation; observation_id: string; at: string;
  recovery: NonNullable<ReturnType<typeof readReportedAssignment>['recovery']> }
interface Journal { schema_version: 1; workflow_id: string; root_packet_id: string; attempts: Attempt[] }
function validate(input: NativeFollowupInput) {
  if (!input || Object.keys(input).some(key => !['packet_id', 'observation', 'observation_id'].includes(key)) ||
    !/^local-report-[a-f0-9]{40}$/.test(input.packet_id) || typeof input.observation_id !== 'string' ||
    !input.observation_id.trim() || input.observation_id.length > 160 ||
    !['running', 'unknown', 'completed', 'completed-without-output', 'failed', 'cancelled'].includes(input.observation))
    throw new AssignmentContextError('INVALID_INPUT', 'Recovery needs an actual packet, explicit native callback observation and stable observation_id.', 'Use the actual native call correlation; elapsed time and claimed status are not terminal observations.');
}
function readJournal(root: string, rootId: string, workflowId: string): Journal {
  const path = safePath(root, `.neomind/native/assignment-recovery/${rootId}.json`);
  if (!existsSync(path)) return { schema_version: 1, workflow_id: workflowId, root_packet_id: rootId, attempts: [] };
  const value = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  if (value.schema_version !== 1 || value.root_packet_id !== rootId || value.workflow_id !== workflowId ||
    !Array.isArray(value.attempts) || value.attempts.length > nativeRecoveryLimit || value.attempts.some((attempt, index) =>
      attempt.packet_id !== (index ? value.attempts[index - 1]!.followup_packet_id : rootId) ||
      !/^local-report-[a-f0-9]{40}$/.test(attempt.followup_packet_id) || typeof attempt.observation_id !== 'string' ||
      !['completed', 'completed-without-output', 'failed', 'cancelled'].includes(attempt.observation)))
    throw new AssignmentContextError('RECOVERY_INTEGRITY', 'Saved recovery lineage is invalid.', 'Inspect the existing recovery journal; do not reset its bounded attempts.');
  return value;
}
export type NativeFollowupResult = Omit<NativeAssignmentInspection, 'status'> & {
  status: 'continue_workflow' | 'report_saved' | 'awaiting_result' | 'wait_for_delegate' | 'needs_observation' | 'followup_prepared' | 'recovery_exhausted';
  attempts: number; max_attempts: number; followup_packet_id?: string;
  followup?: ReturnType<typeof prepareReportedAssignment>; telemetry_warning?: string;
};

/** Explicit manager-observed native callbacks drive bounded recovery, never timers or advisory activity. */
export function followUpNativeAssignment(root: string, handle: ReportedAssignmentCredential, input: NativeFollowupInput, options?: NativeFollowupOptions) {
  validate(input);
  const manager = authorizeNativeManager(root, handle, 'assignment_followup');
  const packet = readReportedAssignment(root, input.packet_id);
  if (packet.workflow_id !== manager.workflow_id) throw new AssignmentContextError('SCOPE_DENIED', 'Recovery packet belongs to another workflow.', 'Select the actual specialist packet from this Coordinator workflow.');
  if (packet.profile_id === 'coordinator' && packet.role === 'manager') throw new AssignmentContextError('SCOPE_DENIED', 'Specialist recovery cannot replace the Coordinator.', 'Continue or resume the current Coordinator directly.');
  const requiredGate = options?.required_gate;
  if (options && (Object.keys(options).some(key => key !== 'required_gate') || !packet.task_id ||
      !nativeSoftwareTaskContract(root, getRecord(root, packet.task_id)) ||
      !((requiredGate === 'verified' && packet.role === 'check-executor') || (requiredGate === 'accepted' && packet.role === 'reviewer'))))
    throw new AssignmentContextError('SCOPE_DENIED', 'Gate-aware recovery requires its actual software-task verification or reviewer assignment.', 'Retain the actual specialist role, software contract and assigned task.');
  const rootId = packet.recovery?.root_packet_id ?? packet.id;
  const original = readReportedAssignment(root, rootId);
  if (original.workflow_id !== packet.workflow_id || original.profile_id !== packet.profile_id || original.role !== packet.role ||
    original.task_id !== packet.task_id || original.objective !== packet.objective)
    throw new AssignmentContextError('RECOVERY_INTEGRITY', 'Recovery packet changed its original bounded scope.', 'Inspect lineage and retain the original task, profile, role and objective.');
  return withOperationLock(root, `native-recovery-${hash(rootId)}`, () => {
    const journal = readJournal(root, rootId, packet.workflow_id);
    const duplicate = journal.attempts.find(attempt => attempt.observation_id === input.observation_id);
    if (duplicate && (duplicate.packet_id !== packet.id || duplicate.observation !== input.observation))
      throw new AssignmentContextError('IDEMPOTENCY_CONFLICT', 'Native observation ID already belongs to a different callback.', 'Preserve the original observation or use the actual new native call correlation.');
    const inspection = inspectNativeAssignment(root, handle, packet.id);
    const base = { ...inspection, attempts: journal.attempts.length, max_attempts: nativeRecoveryLimit };
    const gateSatisfied = !requiredGate || verify(root, packet.task_id!, requiredGate).ok;
    if (inspection.status === 'continue_workflow' && gateSatisfied) return base;
    if (input.observation === 'running') return { ...base, status: 'wait_for_delegate' as const,
      next_action: 'Wait through the native client for the actual current delegate; do not start a replacement.' };
    if (input.observation === 'unknown') return { ...base, status: 'needs_observation' as const,
      next_action: 'Inspect the actual native callback or bounded wait result; do not infer termination from elapsed time or activity expiry.' };
    const head = journal.attempts.at(-1)?.followup_packet_id ?? rootId;
    let nextId = duplicate?.followup_packet_id;
    if (!nextId && head !== packet.id) nextId = head;
    if (nextId) {
      if (!existsSync(safePath(root, `.neomind/native/reported-assignments/${nextId}.json`))) {
        const intent = journal.attempts.find(attempt => attempt.followup_packet_id === nextId)!;
        const prior = readReportedAssignment(root, intent.packet_id);
        const position = journal.attempts.indexOf(intent) + 1;
        const followup = prepareReportedAssignment(root, { workflow_id: prior.workflow_id, profile_id: prior.profile_id, role: prior.role,
          assignment_id: `recovery-${hash(rootId).slice(0, 24)}-${position}`, objective: prior.objective,
          ...(prior.task_id ? { task_id: prior.task_id } : {}) }, { requirePrepared: true, requireExistingIssuer: true, recovery: intent.recovery });
        return { ...base, status: 'followup_prepared' as const, followup_packet_id: nextId, followup,
          next_action: 'Launch the recovered prepared follow-up; the interrupted intent did not create another attempt.' };
      }
      const next = inspectNativeAssignment(root, handle, nextId);
      if (next.status === 'continue_workflow' && gateSatisfied) return { ...next, attempts: journal.attempts.length, max_attempts: nativeRecoveryLimit };
      if (next.packet_state === 'claimed') return { ...next, attempts: journal.attempts.length, max_attempts: nativeRecoveryLimit, status: 'wait_for_delegate' as const, followup_packet_id: nextId,
        next_action: 'The actual follow-up already opened its private session. Observe that native call; no claimed credentials are reissued.' };
      return { ...base, status: 'followup_prepared' as const, followup_packet_id: nextId,
        followup: recoverPreparedAssignment(root, { workflow_id: packet.workflow_id, packet_id: nextId }),
        next_action: 'Launch the already prepared follow-up with its unchanged private handoff; this retry creates no new attempt.' };
    }
    if (journal.attempts.length >= nativeRecoveryLimit) return { ...base, status: 'recovery_exhausted' as const,
      next_action: 'Two bounded follow-ups were used. Preserve partial work and report the actual remaining client/tool blocker; do not reset lineage or forge completion.' };
    const assignment_id = `recovery-${hash(rootId).slice(0, 24)}-${journal.attempts.length + 1}`;
    const followup_packet_id = `local-report-${hash(JSON.stringify([packet.workflow_id, assignment_id])).slice(0, 40)}`;
    const recovery = { root_packet_id: rootId, previous_packet_id: packet.id,
      record_ids: inspection.partial_refs.record_ids, artifact_paths: inspection.partial_refs.artifact_paths };
    // Persist only correlation/observation metadata before preparation. No packet tokens enter journals.
    journal.attempts.push({ packet_id: packet.id, followup_packet_id, observation: input.observation,
      observation_id: input.observation_id, at: now(), recovery });
    atomicWrite(safePath(root, `.neomind/native/assignment-recovery/${rootId}.json`), JSON.stringify(journal, null, 2) + '\n');
    const followup = prepareReportedAssignment(root, { workflow_id: packet.workflow_id, profile_id: packet.profile_id,
      role: packet.role, assignment_id, objective: packet.objective, ...(packet.task_id ? { task_id: packet.task_id } : {}) }, { requirePrepared: true, requireExistingIssuer: true, recovery });
    let telemetry_warning: string | undefined;
    try { assignmentProgress(root, handle, { state: 'running', summary: `Observed ${packet.profile_id} callback ${input.observation}; prepared bounded follow-up ${journal.attempts.length}/${nativeRecoveryLimit}.` }); }
    catch { telemetry_warning = 'Advisory Coordinator telemetry is unavailable; saved recovery state is preserved.'; }
    return { ...base, status: 'followup_prepared' as const, attempts: journal.attempts.length, followup_packet_id, followup,
      ...(telemetry_warning ? { telemetry_warning } : {}),
      next_action: 'Launch the actual specialist with followup.handoff unchanged. It opens its own fresh session and reports its own work; prior reports and engineering gates remain intact.' };
  });
}
