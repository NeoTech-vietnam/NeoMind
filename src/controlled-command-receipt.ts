import type { ControlledSnapshot } from './controlled-workflow.js';

const limits = { invocations: 4, note_ids: 8, identifier: 256, model: 256, diagnostic: 768 } as const;
const states = new Set(['queued', 'running', 'waiting', 'paused', 'interrupted', 'uncertain', 'blocked', 'cancelled', 'completed']);

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limits.identifier &&
    !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const clean = value.replace(/[\x00-\x1f\x7f]/g, ' ');
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Identify only the owned runtime result; legacy manager handoffs retain their contract. */
export function isControlledCommandSnapshot(value: unknown): value is ControlledSnapshot {
  return value !== null && typeof value === 'object' &&
    'process_contract' in value && value.process_contract === 'software-tools/v2' &&
    'transport' in value && value.transport === 'vscode-lm';
}

/** Public command acknowledgement, not the internal journal or a completion claim. No I/O. */
export function controlledCommandReceipt(run: ControlledSnapshot) {
  const workflowId = identifier(run.workflow_id), epochId = identifier(run.epoch_id);
  if (!workflowId || !epochId || !states.has(run.status) || !Number.isSafeInteger(run.revision) || run.revision < 0)
    throw new Error('The saved controlled command receipt has an invalid identity or revision.');
  const supplied = Array.isArray(run.active_invocations) ? run.active_invocations : [];
  const active = supplied.slice(0, limits.invocations).map(item => ({
    id: identifier(item.id), role: text(item.role, 64), state: text(item.state, 64),
    requested_model: text(item.requested_model, limits.model) ?? null,
    confirmed_model: text(item.confirmed_model, limits.model) ?? null,
    provider: text(item.provider, limits.model) ?? null,
  }));
  const blocker = run.blocker && typeof run.blocker === 'object' ? {
    kind: text(run.blocker.kind, 32), message: text(run.blocker.message, limits.diagnostic),
    code: text(run.blocker.code, 96), trace_id: identifier(run.blocker.trace_id),
    owner: text(run.blocker.owner, 64), next_action: text(run.blocker.next_action, limits.diagnostic),
  } : undefined;
  const next = blocker?.next_action ?? (['blocked', 'uncertain'].includes(run.status)
    ? 'Inspect manager_status with this exact workflow_id before resuming the saved workflow.' : undefined);
  const notes = run.status === 'completed' && Array.isArray(run.cornell_note_ids)
    ? run.cornell_note_ids.filter((id): id is string => identifier(id) !== undefined) : [];
  const taskId = identifier((run as ControlledSnapshot & { task_id?: unknown }).task_id);
  return {
    schema_version: 1 as const, execution_mode: 'neomind-controlled' as const,
    workflow_id: workflowId, epoch_id: epochId, status: run.status, phase: text(run.phase, 64), revision: run.revision,
    ...(identifier(run.request_id) ? { request_id: run.request_id } : {}),
    ...(identifier(run.contract_hash) ? { contract_hash: run.contract_hash } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    active_invocations: active,
    ...(supplied.length > active.length ? { active_invocations_omitted: supplied.length - active.length } : {}),
    ...(blocker ? { blocker } : {}), ...(next ? { next_action: next } : {}),
    ...(run.status === 'completed' && identifier(run.final_report_id) ? { final_report_id: run.final_report_id } : {}),
    ...(notes.length ? { cornell_note_ids: notes.slice(0, limits.note_ids) } : {}),
    ...(notes.length > limits.note_ids ? { cornell_note_ids_omitted: notes.length - limits.note_ids } : {}),
  };
}
