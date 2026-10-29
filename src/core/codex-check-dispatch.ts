import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SystemdScope, type WorkerScope } from '../adapters/systemd-scope.js';
import { CodexCheckExecutor, type CheckSpec } from '../adapters/codex-check.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { captureBaseline } from '../workspace/baseline.js';
import type { ReviewWorkspace } from './codex-review-dispatch.js';
import { replayRun } from './recovery.js';

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
    if (!await SystemdScope.stopExisting({ unit: check.workerUnit, controlGroup: check.workerControlGroup })) {
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
    if (context.lease.runId !== this.journal.runId || (await captureBaseline(context.workspace)).baselineHash !== baselineHash) throw new Error('Check baseline changed');
    if (report.unresolvedCheckIds.length) throw new Error('Reconcile uncertain check before proceeding');
    if (!this.executor.usesTransport(scope.transport) || !await scope.isActive()) throw new Error('Verified check scope is required');
    await this.append('check_intent', { checkId: spec.id, command, baselineHash, workspace: context.lease.workspace, workspaceFence: context.lease.fence }, requestId);
    await this.append('check_scope_bound', { checkId: spec.id, unit: scope.identity.unit, controlGroup: scope.identity.controlGroup }, requestId);
    const result = await this.executor.run(spec, context.workspace, context.lease, context.coordinator, scope);
    if ((await captureBaseline(context.workspace)).baselineHash !== baselineHash) throw new Error('Check changed the reviewed baseline; outcome requires reconciliation');
    await this.append('check_finished', { checkId: spec.id, exitCode: result.exitCode, outputHash: result.outputHash }, requestId);
    return result;
  }
}
