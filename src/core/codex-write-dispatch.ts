import { effectiveBinding } from './run-binding.js';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SystemdScope, type WorkerScope } from '../adapters/systemd-scope.js';
import { CodexWorkspaceWriteAdapter } from '../adapters/codex-workspace-write.js';
import { flowSchema, projectPolicySchema } from '../domain/schema.js';
import { hashJson } from '../domain/resolve.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { captureBaseline } from '../workspace/baseline.js';
import { admitIsolatedWorkspaceWrite } from '../workspace/write-admission.js';
import { replayRun } from './recovery.js';
import { validateMaterializedRun } from '../domain/materialize.js';

type Admission = Parameters<typeof admitIsolatedWorkspaceWrite>[0];
/** Caller must serialize operations and hold the same run and workspace owner leases. */
export class CodexWriteDispatch {
  constructor(private readonly journal: OwnedJournal, private readonly adapter: CodexWorkspaceWriteAdapter) {}
  usesJournal(journal: OwnedJournal): boolean { return this.journal === journal; }
  private async append(type: string, payload: unknown, requestId: string = randomUUID()) {
    const events = await this.journal.read();
    const event = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.journal.runId, requestId,
      type, timestamp: new Date().toISOString(), payload: z.json().parse(payload) };
    replayRun([...events, { ...event, sequence: events.length + 1 }]); await this.journal.append(event, events.length);
  }
  async dispatch(nodeId: string, threadId: string, prompt: string, effort: string, attemptId: string, requestId: string,
    input: Admission, scope: WorkerScope, authorized: boolean): Promise<string> {
    if (!authorized) throw new Error('Explicit run continuation required');
    if (input.lease.runId !== this.journal.runId) throw new Error('Workspace lease belongs to another run');
    if (!this.adapter.usesTransport(scope.transport) || !await scope.isActive()) throw new Error('Verified worker scope is required');
    const events = await this.journal.read(), report = replayRun(events);
    const created = z.object({ flow: flowSchema, policy: projectPolicySchema }).parse(events[0]?.payload);
    const node = created.flow.definition.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'agent_task' || !node.permissions.write) throw new Error('Node cannot write the workspace');
    if (input.continuation && !report.continuationBaselines.includes(input.continuation.baselineHash)) throw new Error('Continuation baseline has not been confirmed by the user');
    if (input.repair) {
      const round = report.repairRounds.at(-1), scope = created.flow.definition.nodes.find(item => item.id === round?.scopeId);
      if (!round || round.roundId !== input.repair.roundId || round.baselineHash !== input.repair.baselineHash || scope?.type !== 'repair_scope' || !scope.ownerNodeIds.includes(nodeId)) throw new Error('Write repair is not authorized by the current repair round');
    } else if (report.repairRounds.some(round => { const scope = created.flow.definition.nodes.find(item => item.id === round.scopeId); return scope?.type === 'repair_scope' && scope.ownerNodeIds.includes(nodeId); })) throw new Error('Repair write requires the current round baseline');
    if (hashJson(created.policy) !== hashJson(input.livePolicy)) throw new Error('Live project policy does not match run snapshot');
    const grant = await admitIsolatedWorkspaceWrite(input);
    const payload = z.object({ snapshot: z.json().optional() }).parse(events[0]?.payload);
    const binding = payload.snapshot ? effectiveBinding(validateMaterializedRun(payload.snapshot), report.bindingSelections, nodeId) : undefined;
    if (payload.snapshot && !binding) throw new Error('Missing writer run binding');
    if (binding) { if (binding.reasoning !== effort) throw new Error('Reasoning does not match run binding'); this.adapter.assertBound(threadId, binding, grant.workspace); }
    if (report.unresolvedAttemptIds.length) throw new Error('Reconcile unresolved attempts before dispatch');
    if (!report.approvals.some(item => hashJson(item.plan) === hashJson(input.plan) && hashJson(item.approval) === hashJson(input.approval))) {
      throw new Error('Workspace grant does not match a user approval recorded in this run');
    }
    await this.append('node_claimed', { nodeId, writeScopes: input.plan.scope });
    await this.append('dispatch_intent', { nodeId, sessionId: threadId, attemptId }, requestId);
    await this.append('workspace_dispatch_bound', { attemptId, workspace: input.lease.workspace, fence: input.lease.fence }, requestId);
    await this.append('worker_scope_bound', { attemptId, unit: scope.identity.unit, controlGroup: scope.identity.controlGroup }, requestId);
    let turnId: string;
    try { turnId = await this.adapter.startTurn(threadId, prompt, effort, input, binding?.model); }
    catch (error) { await this.append('dispatch_receipt', { attemptId, status: 'unknown' }, requestId); throw error; }
    await this.append('codex_turn_bound', { attemptId, turnId }, requestId);
    await this.append('dispatch_receipt', { attemptId, status: 'accepted' }, requestId);
    return turnId;
  }
  /** Stop the persisted worker scope after a crash; no prompt is resent. */
  async reconcileStopped(attemptId: string, input: Admission): Promise<void> {
    const report = replayRun(await this.journal.read()), attempt = report.attempts.find(item => item.attemptId === attemptId);
    const held = input.coordinator.getWriter(input.workspace);
    if (!attempt || attempt.status !== 'unresolved' || !attempt.workerUnit || !attempt.workerControlGroup || !held ||
      held.runId !== this.journal.runId || held.workspace !== attempt.workspace || held.fence !== attempt.workspaceFence ||
      input.lease.fence !== held.fence || input.lease.hostId !== held.hostId) throw new Error('Worker or workspace lease does not match');
    if (!await SystemdScope.stopExisting({ unit: attempt.workerUnit, controlGroup: attempt.workerControlGroup })) {
      if (!held.quarantined) input.coordinator.quarantine(input.lease);
      throw new Error('Worker stop remains unconfirmed; workspace quarantined');
    }
    await this.append('attempt_finished', { attemptId, status: 'stopped' });
    // Other unresolved workers may still use this same workspace and must remain fenced.
    const after = replayRun(await this.journal.read());
    if (held.quarantined && !after.unresolvedCheckIds.length && !after.attempts.some(item => item.status === 'unresolved' && item.workspace === held.workspace)) {
      input.coordinator.clearQuarantine(input.lease, true);
    }
  }
  /** Terminal status must come from the matched runtime event. */
  async recordTerminal(attemptId: string, threadId: string, turnId: string, status: 'completed' | 'stopped', input: Admission, scope: WorkerScope): Promise<void> {
    const report = replayRun(await this.journal.read()), attempt = report.attempts.find(item => item.attemptId === attemptId);
    if (!attempt || attempt.sessionId !== threadId || attempt.runnerTurnId !== turnId || attempt.status !== 'unresolved') throw new Error('Terminal event does not match a pending attempt');
    if (input.lease.runId !== this.journal.runId || !input.coordinator.isCurrent(input.lease) ||
      attempt.workspace !== input.lease.workspace || attempt.workspaceFence !== input.lease.fence ||
      await realpath(input.workspace) !== attempt.workspace) throw new Error('Workspace lease is stale or does not match dispatch');
    if (attempt.workerUnit !== scope.identity.unit || attempt.workerControlGroup !== scope.identity.controlGroup ||
      !this.adapter.usesTransport(scope.transport)) throw new Error('Worker scope does not match dispatch');
    if (!await scope.stop()) {
      // A terminal turn alone does not prove that spawned processes stopped.
      input.coordinator.quarantine(input.lease);
      throw new Error('Worker stop is unconfirmed; workspace quarantined pending reconciliation');
    }
    const baseline = status === 'completed' ? await captureBaseline(input.workspace) : undefined;
    await this.append('attempt_finished', { attemptId, status, ...(baseline ? { baselineHash: baseline.baselineHash } : {}) });
    if (status === 'completed') await this.append('node_completed', { nodeId: attempt.nodeId, outcome: 'completed' });
  }
}
