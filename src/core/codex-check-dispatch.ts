import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { stopExistingWorkerScope, type WorkerScope } from '../adapters/worker-scope.js';
import { CodexCheckExecutor, type CheckSpec } from '../adapters/codex-check.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { captureBaseline, type DirtyEntry, type WorkspaceBaseline } from '../workspace/baseline.js';
import type { ReviewWorkspace } from './codex-review-dispatch.js';
import { replayRun } from './recovery.js';

const listedChangeLimit = 20;

function sameEntry(left: DirtyEntry, right: DirtyEntry) {
  return left.status === right.status && left.kind === right.kind && left.contentHash === right.contentHash && left.mode === right.mode;
}
/** Names what a check wrote so the user can fix the repo (often generated files such as __pycache__) instead of guessing. */
export function describeCheckBaselineChange(before: WorkspaceBaseline, after: WorkspaceBaseline): string {
  const previous = new Map(before.entries.map(entry => [entry.path, entry])), current = new Map(after.entries.map(entry => [entry.path, entry]));
  const changes: string[] = [];
  // Baseline entries are dirty paths only, so a path can appear or disappear because the check touched a clean tracked file.
  for (const entry of after.entries) {
    const old = previous.get(entry.path);
    if (old && sameEntry(old, entry)) continue;
    const removed = entry.kind === 'missing' || entry.status.includes('D'), added = !old && !removed && (entry.status === '??' || entry.status.includes('A'));
    changes.push(`${removed ? 'removed' : added ? 'added' : 'modified'} ${entry.path}`);
  }
  for (const entry of before.entries) {
    if (current.has(entry.path)) continue;
    changes.push(`${entry.status === '??' || entry.status.includes('A') ? 'removed' : 'modified'} ${entry.path}`);
  }
  changes.sort((left, right) => left.slice(left.indexOf(' ') + 1).localeCompare(right.slice(right.indexOf(' ') + 1)));
  const listed = changes.slice(0, listedChangeLimit).join('; '), rest = changes.length - listedChangeLimit;
  const head = before.head !== after.head ? ` HEAD moved from ${before.head} to ${after.head}.` : '';
  const paths = changes.length ? ` Changed paths: ${listed}${rest > 0 ? `; and ${rest} more` : ''}.` : head ? '' : ' Git index or status changed without a listed path.';
  return `Check changed the reviewed baseline; outcome requires reconciliation.${head}${paths} If the check generated these files, ignore them in the repository (for example in .gitignore) or remove them and make the check stop writing into the worktree, then reconcile.`;
}

/** Checks must be approved and tied to the exact baseline; unknown effects are never retried automatically. */
export class CodexCheckDispatch {
  constructor(private readonly journal: OwnedJournal, private readonly executor: CodexCheckExecutor) {}
  usesJournal(journal: OwnedJournal) { return this.journal === journal; }
  private async append(type: string, payload: unknown, requestId: string) {
    const events = await this.journal.read(), event = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.journal.runId,
      requestId, type, timestamp: new Date().toISOString(), payload: z.json().parse(payload) };
    replayRun([...events, { ...event, sequence: events.length + 1 }]); await this.journal.append(event, events.length);
  }
  /** Stop a persisted check scope and mark its unknown outcome abandoned; never rerun it here. */
  async reconcileStopped(checkId: string, context: ReviewWorkspace): Promise<void> {
    const report = replayRun(await this.journal.read()), check = report.checks.find(item => item.checkId === checkId);
    const held = context.coordinator.getWriter(context.workspace);
    if (!check || check.status !== 'unresolved' || !check.workerUnit || !check.workerControlGroup || !held ||
      held.runId !== this.journal.runId || check.workspace !== held.workspace || check.workspaceFence !== held.fence ||
      context.lease.fence !== held.fence || context.lease.hostId !== held.hostId) throw new Error('Check or workspace lease does not match');
    if (!await stopExistingWorkerScope({ unit: check.workerUnit, controlGroup: check.workerControlGroup })) {
      if (!held.quarantined) context.coordinator.quarantine(context.lease);
      throw new Error('Check worker stop remains unconfirmed; workspace quarantined');
    }
    await this.append('check_abandoned', { checkId }, check.requestId);
    const after = replayRun(await this.journal.read());
    if (held.quarantined && !after.checks.some(item => item.status === 'unresolved' && item.workspace === held.workspace) &&
      !after.attempts.some(item => item.status === 'unresolved' && item.workspace === held.workspace)) context.coordinator.clearQuarantine(context.lease, true);
  }
  async run(spec: CheckSpec, baselineHash: string, context: ReviewWorkspace, requestId: string, scope: WorkerScope, authorized: boolean) {
    if (!authorized) throw new Error('Explicit user continuation required');
    if (spec.command.some(argument => /\s/.test(argument))) throw new Error('Check arguments with whitespace require an explicit structured approval');
    const report = replayRun(await this.journal.read()), command = spec.command.join(' ');
    if (!report.approvals.some(item => item.plan.checks.includes(command))) throw new Error('Check is not in the approved plan');
    const before = context.lease.runId === this.journal.runId ? await captureBaseline(context.workspace) : undefined;
    if (!before || before.baselineHash !== baselineHash) throw new Error('Check baseline changed');
    if (report.unresolvedCheckIds.length) throw new Error('Reconcile uncertain check before proceeding');
    if (!this.executor.usesTransport(scope.transport) || !await scope.isActive()) throw new Error('Verified check scope is required');
    await this.append('check_intent', { checkId: spec.id, command, baselineHash, workspace: context.lease.workspace, workspaceFence: context.lease.fence }, requestId);
    await this.append('check_scope_bound', { checkId: spec.id, unit: scope.identity.unit, controlGroup: scope.identity.controlGroup }, requestId);
    const result = await this.executor.run(spec, context.workspace, context.lease, context.coordinator, scope);
    const after = await captureBaseline(context.workspace);
    if (after.baselineHash !== baselineHash) throw new Error(describeCheckBaselineChange(before, after));
    await this.append('check_finished', { checkId: spec.id, exitCode: result.exitCode, outputHash: result.outputHash }, requestId);
    return result;
  }
}
