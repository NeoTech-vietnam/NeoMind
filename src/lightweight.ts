import { coordinatorAgentName, nativeActivityInstructions } from './agent-profiles.js';
import { randomUUID } from 'node:crypto';
import { createRecord, getRecord, loadRecords, resolveManagedRoot, updateRecord, withOperationLock } from './storage.js';
import type { ProjectRecord } from './types.js';
import type { WorkflowInput } from './manager.js';

const kind = 'lightweight-workflow';
export interface LightweightReview {
  disposition: 'not-needed' | 'pending' | 'completed';
  reason: string;
  invocation_id?: string;
  result?: 'pass' | 'fail';
}
export interface LightweightCheckpoint {
  workflow_id: string;
  expected_revision: number;
  phase: 'execution' | 'blocked' | 'completed';
  risk: 'low' | 'elevated' | 'strict-required';
  plan: string[];
  changed_files: string[];
  checks: { command: string; result: 'passed' | 'failed' | 'not-run'; output: string }[];
  limitations: string[];
  review: LightweightReview;
  summary: string;
  next_action?: string;
}
export interface LightweightStatus extends Record<string, unknown> {
  workflow_id: string;
  revision: number;
}
function text(value: unknown, name: string, maximum = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  return value.trim();
}
function texts(value: unknown, name: string, maximum = 32): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${name} must be an array with at most ${maximum} entries.`);
  return value.map(item => text(item, name));
}
export function lightweightStatus(record: ProjectRecord): LightweightStatus {
  if (record.meta.type !== 'knowledge' || record.meta.data.kind !== kind)
    throw new Error('Provide a lightweight workflow ID; strict workflows cannot be converted.');
  return { ...record.meta.data, workflow_id: record.meta.id, revision: record.meta.revision };
}
export function lightweightRun(root: string, input: WorkflowInput & { workflow_id?: string; message?: string }): {
  workflow: LightweightStatus;
  handoff?: { agent: string; prompt: string };
} {
  return withOperationLock(root, 'lightweight-intake', () => {
    let record: ProjectRecord | undefined;
    if (input.workflow_id) {
      record = getRecord(root, input.workflow_id);
      lightweightStatus(record);
    }
    const provided = input.requirements ?? (input.requirement === undefined ? undefined : [input.requirement]);
    if (input.requirement !== undefined && input.requirements !== undefined)
      throw new Error('Provide requirement or requirements, rather than both.');
    const requirements = provided === undefined ? undefined : texts(provided, 'Requirements');
    if (requirements && !requirements.length) throw new Error('Provide at least one requirement.');
    if (record && requirements && JSON.stringify(requirements) !== JSON.stringify(record.meta.data.original_requirements))
      throw new Error('Resumption requirements differ from the saved increment.');
    const message = input.message === undefined ? undefined : text(input.message, 'Continuation');
    const requestId = text(input.request_id ?? randomUUID(), 'Request ID', 256);
    if (!record) {
      if (!requirements) throw new Error('Provide requirement or requirements.');
      record = loadRecords(root).find(item => item.meta.data.request_id === requestId);
      if (record) {
        lightweightStatus(record);
        if (JSON.stringify(requirements) !== JSON.stringify(record.meta.data.original_requirements))
          throw new Error('Request ID already belongs to a different requirement.');
      }
    }
    if (!record) {
      // Requirements are validated above before creating a new record.
      record = createRecord(root, {
        type: 'knowledge', owner: 'manager', status: 'in-progress',
        title: `Lightweight: ${text(input.title ?? requirements![0]!.slice(0, 100), 'Title', 256)}`,
        data: {
          kind, execution_mode: 'lightweight', backend: 'copilot-native',
          assurance: 'unsigned-native-report', request_id: requestId,
          original_requirements: requirements, continuations: message ? [message] : [], phase: 'execution',
          plan: [], changed_files: [], checks: [], limitations: [], risk: 'unassessed',
          review: { disposition: 'not-assessed', reason: 'Assess risk before editing.' },
          summary: '', next_action: 'Read relevant scope and save a short plan before editing.',
        },
        body: '# Lightweight native increment\nNative client permissions apply. This record is not signed task acceptance.\n',
      });
    }
    const continuations = (record.meta.data.continuations ?? []) as string[];
    if (message && continuations.at(-1) !== message) {
      if (record.meta.data.phase === 'completed')
        throw new Error('Completed lightweight increments are immutable; create a new requirement.');
      continuations.push(message);
      record = updateRecord(root, record.meta.id, { data: { continuations } });
    }
    if (record.meta.data.phase === 'completed') return { workflow: lightweightStatus(record) };
    return {
      workflow: lightweightStatus(record),
      handoff: {
        agent: coordinatorAgentName,
        prompt: `Continue lightweight workflow ${record.meta.id}. Read ${resolveManagedRoot(root)}/guides/lightweight.md and the saved record. Execute within the original user authorization and saved continuations; continuations clarify or narrow scope, not expand it. Checkpoint plan, actual checks, changed paths and limitations. Do not call manager_run recursively or resume unrelated strict workflows.\n${nativeActivityInstructions}\nOriginal requirement batch:\n${JSON.stringify(record.meta.data.original_requirements, null, 2)}\nUser clarifications or continuations (in order):\n${JSON.stringify(continuations, null, 2)}`,
      },
    };
  });
}
export function checkpointLightweight(root: string, input: LightweightCheckpoint): LightweightStatus {
  const record = getRecord(root, text(input.workflow_id, 'Workflow ID', 256));
  const saved = lightweightStatus(record);
  if (!Number.isInteger(input.expected_revision) || input.expected_revision !== saved.revision)
    throw new Error('Lightweight revision changed; reread saved state before checkpointing.');
  if (saved.phase === 'completed')
    throw new Error('Completed lightweight increments are immutable; create a new requirement.');
  if (!['execution', 'blocked', 'completed'].includes(input.phase)) throw new Error('Invalid lightweight phase.');
  const plan = texts(input.plan, 'Plan', 5);
  const changed = texts(input.changed_files, 'Changed files', 256);
  for (const path of changed)
    if (path.includes('\\') || path.startsWith('/') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Changed files must be canonical project-relative paths.');
  const limitations = texts(input.limitations, 'Limitations');
  if (!Array.isArray(input.checks) || input.checks.length > 32)
    throw new Error('Checks must be an array with at most 32 entries.');
  const checks = input.checks.map(check => {
    if (!check || !['passed', 'failed', 'not-run'].includes(check.result)) throw new Error('Invalid check result.');
    return { command: text(check.command, 'Check command', 4000), result: check.result, output: text(check.output, 'Check observation') };
  });
  if (!['low', 'elevated', 'strict-required'].includes(input.risk))
    throw new Error('Record risk as low, elevated or strict-required.');
  const review = input.review;
  if (!review || !['not-needed', 'pending', 'completed'].includes(review.disposition))
    throw new Error('Record a risk-based review disposition.');
  const normalizedReview: LightweightReview = { disposition: review.disposition, reason: text(review.reason, 'Review rationale') };
  if (review.disposition === 'completed') {
    normalizedReview.invocation_id = text(review.invocation_id, 'Actual separate reviewer invocation ID', 256);
    if (!['pass', 'fail'].includes(review.result!)) throw new Error('Review result must be pass or fail.');
    normalizedReview.result = review.result;
  }
  const summary = text(input.summary, 'Summary');
  const nextAction = input.phase === 'completed' ? '' : text(input.next_action, 'Next action');
  if (input.phase === 'completed' && (!plan.length || !checks.length || checks.some(check => check.result !== 'passed') || review.disposition === 'pending' || normalizedReview.result === 'fail' || input.risk === 'strict-required' || (input.risk === 'elevated' && review.disposition !== 'completed')))
    throw new Error('Completion needs a plan, passing relevant checks, resolved passing review for elevated risk, and no strict-required scope.');
  const updated = updateRecord(root, record.meta.id, {
    status: input.phase === 'completed' ? 'submitted' : input.phase === 'blocked' ? 'blocked' : 'in-progress',
    data: { phase: input.phase, plan, changed_files: changed, checks, limitations, risk: input.risk, review: normalizedReview, summary, next_action: nextAction },
  }, undefined, current => {
    if (current.meta.revision !== saved.revision)
      throw new Error('Lightweight revision changed; reread saved state before checkpointing.');
  });
  return lightweightStatus(updated);
}
