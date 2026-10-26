import { readFileSync } from 'node:fs';
import { controlledCommandReceipt } from './controlled-command-receipt.js';
import type { ControlledSnapshot } from './controlled-workflow.js';
import type { ProjectRecord } from './types.js';
import { getRecord, hash, safePath } from './storage.js';

const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
function short(value: unknown, bytes: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let result = '';
  for (const character of value.replace(/[\x00-\x1f\x7f]/g, ' ')) {
    if (Buffer.byteLength(result + character, 'utf8') > bytes) return `${result}…`;
    result += character;
  }
  return result;
}

/** Saved observations only: this read does not rerun acceptance, checks or execution. */
export function controlledStatusView(root: string, run: ControlledSnapshot) {
  const receipt = controlledCommandReceipt(run);
  let parentStatus: string | null = null, taskId: string | null = null, taskStatus: string | null = null,
    reportStatus: string | null = null;
  try {
    const parent = getRecord(root, run.workflow_id);
    if (parent.meta.data.kind === 'manager-workflow') parentStatus = parent.meta.status;
  } catch { /* Missing records remain unavailable, never inferred from the journal phase. */ }
  if (run.contract_hash && /^[a-f0-9-]{36}$/.test(run.epoch_id)) try {
    const bytes = readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`));
    const contract = JSON.parse(bytes.toString('utf8'));
    if (hash(bytes) === run.contract_hash && contract.schema_version === 2 && contract.workflow_id === run.workflow_id &&
        contract.epoch_id === run.epoch_id && typeof contract.task_id === 'string') {
      const task = getRecord(root, contract.task_id);
      if (task.meta.type === 'task' && task.meta.data.workflow_id === run.workflow_id && task.meta.data.epoch_id === run.epoch_id) {
        taskId = task.meta.id; taskStatus = task.meta.status;
      }
    }
  } catch { /* Preserve the checkpoint while an unavailable/mismatched contract is reconciled elsewhere. */ }
  if (receipt.final_report_id) try {
    const report = getRecord(root, receipt.final_report_id);
    if (report.meta.data.kind === 'controlled-final-report' && report.meta.data.workflow_id === run.workflow_id &&
        report.meta.data.epoch_id === run.epoch_id && report.meta.data.contract_hash === run.contract_hash) reportStatus = report.meta.status;
  } catch { /* The ID is a saved checkpoint reference; its record status remains unavailable. */ }
  const blocker = receipt.blocker ? { ...receipt.blocker,
    message: short(receipt.blocker.message, 256), next_action: short(receipt.blocker.next_action, 256) } : undefined;
  return {
    ...receipt, view: 'summary' as const, updated_at: short(run.updated_at, 64),
    active_invocations: receipt.active_invocations.map(item => ({ ...item,
      requested_model: short(item.requested_model, 96) ?? null,
      confirmed_model: short(item.confirmed_model, 96) ?? null, provider: short(item.provider, 96) ?? null })),
    ...(blocker ? { blocker } : {}), ...(receipt.next_action ? { next_action: short(receipt.next_action, 256) } : {}),
    parent_status: parentStatus, task_id: taskId, task_status: taskStatus, final_report_status: reportStatus,
    record_status_source: 'saved-records-not-revalidated' as const,
    counter_scope: 'saved-journal-history' as const,
    counters: { attempts: run.attempts.length, checks: run.checks.length, events: run.events.length,
      checks_passed: run.checks.filter(check => check.passed === true).length,
      checks_failed: run.checks.filter(check => check.passed === false).length },
    repair_budget: run.repair_budget?.schema_version === 1 ? { schema_version: 1, product: count(run.repair_budget.product),
      protocol: count(run.repair_budget.protocol), environment: count(run.repair_budget.environment) } : null,
  };
}

/** Discovery is bounded; select one exact ID for its compact record/status observations. */
export function controlledStatusList(runs: ControlledSnapshot[], requestId?: string) {
  const matches = requestId === undefined ? runs : runs.filter(run => run.request_id === requestId);
  return { controlled_workflows: matches.slice(0, 3).map(run => {
    const value = controlledCommandReceipt(run);
    return { workflow_id: value.workflow_id, request_id: value.request_id, status: value.status, phase: value.phase,
      revision: value.revision, updated_at: short(run.updated_at, 64), final_report_id: value.final_report_id };
  }), controlled_workflows_omitted: Math.max(0, matches.length - 3) };
}

export function controlledLegacyStatusList(records: ProjectRecord[], requestId?: string) {
  const matches = requestId === undefined ? records : records.filter(record => record.meta.data.request_id === requestId);
  return { legacy_workflows: matches.slice(0, 3).map(record => ({ workflow_id: record.meta.id,
    title: short(record.meta.title, 128),
    ...(typeof record.meta.data.request_id === 'string' && Buffer.byteLength(record.meta.data.request_id) <= 256
      ? { request_id: record.meta.data.request_id } : {}),
    execution_mode: short(record.meta.data.execution_mode, 64), phase: short(record.meta.data.phase, 64), validation: 'not-evaluated' as const })),
    legacy_workflows_omitted: Math.max(0, matches.length - 3) };
}
