import { effectiveBinding } from './run-binding.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizePlan, plannerOutputSchema } from '../domain/approval.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import type { AgentRunner, RunnerScope, VerifiedRunnerSession } from '../runners/agent-runner.js';
import { assertSessionBound, verifiedSession } from '../runners/registry.js';
import { flowSchema, projectPolicySchema } from '../domain/schema.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { replayRun } from './recovery.js';
import { validateMaterializedRun } from '../domain/materialize.js';
import type { ReviewWorkspace } from './codex-review-dispatch.js';
import { captureBaseline } from '../workspace/baseline.js';

/**
 * Caller must hold the run owner lease and serialize all run operations around this service. The runner and its verified
 * session are needed only to dispatch; any runner works (the journal keeps its Codex-era event names).
 */
export class CodexReadOnlyDispatch {
  constructor(private readonly journal: OwnedJournal, private readonly runner?: AgentRunner, private readonly session?: VerifiedRunnerSession) {}
  usesJournal(journal: OwnedJournal): boolean { return this.journal === journal; }
  private async append(type: string, payload: unknown, requestId: string = randomUUID()) {
    const events = await this.journal.read();
    const event = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.journal.runId, requestId,
      type, timestamp: new Date().toISOString(), payload: z.json().parse(payload) };
    replayRun([...events, { ...event, sequence: events.length + 1 }]);
    await this.journal.append(event, events.length);
  }
  /** Explicit caller authorization is required after any recovery, before calling dispatch. */
  async dispatch(nodeId: string, threadId: string, prompt: string, effort: string,
    attemptId: string, requestId: string, authorized: boolean, scope?: RunnerScope, context?: ReviewWorkspace): Promise<string> {
    if (!authorized) throw new Error('Explicit run continuation required');
    const events = await this.journal.read(), report = replayRun(events);
    const created = z.object({ flow: flowSchema, policy: projectPolicySchema }).parse(events[0]?.payload);
    const node = created.flow.definition.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'agent_task' || node.permissions.write || node.permissions.gitCommit) throw new Error('Only read-only agent tasks are supported');
    const payload = z.object({ snapshot: z.json().optional() }).parse(events[0]?.payload);
    const binding = payload.snapshot ? effectiveBinding(validateMaterializedRun(payload.snapshot), report.bindingSelections, nodeId) : undefined;
    if (payload.snapshot && !binding) throw new Error('Missing run binding');
    const { runner, session } = verifiedSession(this.runner, this.session, threadId);
    if (binding) { if (binding.reasoning !== effort) throw new Error('Reasoning does not match run binding'); assertSessionBound(session, binding); }
    if (report.unresolvedAttemptIds.length) throw new Error('Reconcile unresolved attempts before dispatch');
    if (scope && (scope !== runner.scope || !await scope.isActive())) throw new Error('Verified worker scope is required');
    const baseline = context ? await captureBaseline(context.workspace) : undefined;
    if (context && (context.lease.runId !== this.journal.runId || context.lease.workspace !== baseline?.root || !context.coordinator.isCurrent(context.lease))) throw new Error('Read-only workspace lease mismatch');
    if (binding && context) assertSessionBound(session, binding, context.workspace);
    await runner.verifyNoDelegation(session);
    await this.append('node_claimed', { nodeId });
    await this.append('dispatch_intent', { nodeId, sessionId: threadId, attemptId }, requestId);
    if (context && baseline) {
      await this.append('workspace_dispatch_bound', { attemptId, workspace: context.lease.workspace, fence: context.lease.fence }, requestId);
      await this.append('readonly_baseline_bound', { attemptId, baselineHash: baseline.baselineHash }, requestId);
    }
    if (scope) await this.append('worker_scope_bound', { attemptId, unit: scope.identity.unit, controlGroup: scope.identity.controlGroup }, requestId);
    let turnId: string;
    try { const output = node.outputContract === 'plan' ? z.toJSONSchema(plannerOutputSchema) : undefined;
      turnId = await runner.startTurn(session, { prompt, effort, ...(output === undefined ? {} : { outputSchema: output }) }); }
    catch (error) {
      await this.append('dispatch_receipt', { attemptId, status: 'unknown' }, requestId);
      throw error;
    }
    await this.append('codex_turn_bound', { attemptId, turnId }, requestId);
    await this.append('dispatch_receipt', { attemptId, status: 'accepted' }, requestId);
    return turnId;
  }
  async recordResult(attemptId: string, result: TurnResult, context: ReviewWorkspace): Promise<void> {
    const report = replayRun(await this.journal.read()), attempt = report.attempts.find(item => item.attemptId === attemptId);
    if (!attempt || attempt.status !== 'unresolved' || attempt.sessionId !== result.threadId || attempt.runnerTurnId !== result.turnId || result.status !== 'completed' || !result.messages.length || attempt.workspace !== context.lease.workspace || attempt.workspaceFence !== context.lease.fence || !context.coordinator.isCurrent(context.lease)) throw new Error('Read-only result does not match a pending owned attempt');
    const baseline = await captureBaseline(context.workspace);
    if (baseline.baselineHash !== attempt.readonlyBaselineHash) throw new Error('Read-only baseline changed');
    const text = result.messages.join('\n'); if (text.length > 100000) throw new Error('Read-only result exceeds artifact limit');
    await this.append('runtime_artifact', { nodeId: attempt.nodeId, kind: 'agent', text, attemptId, baselineHash: baseline.baselineHash });
    await this.append('attempt_finished', { attemptId, status: 'completed', baselineHash: baseline.baselineHash });
    await this.append('node_completed', { nodeId: attempt.nodeId, outcome: 'completed' });
  }
  /** Accept a structured plan only from the matching successful terminal event. */
  async recordPlan(attemptId: string, result: TurnResult): Promise<void> {
    const report = replayRun(await this.journal.read()), attempt = report.attempts.find(item => item.attemptId === attemptId);
    if (!attempt || attempt.sessionId !== result.threadId || attempt.runnerTurnId !== result.turnId ||
      attempt.status !== 'unresolved' || result.status !== 'completed' || result.messages.length === 0) throw new Error('Plan result does not match a successful pending attempt');
    const plan = normalizePlan(JSON.parse(result.messages[result.messages.length - 1]!) as unknown);
    await this.append('plan_proposed', { nodeId: attempt.nodeId, attemptId, plan });
    await this.append('node_completed', { nodeId: attempt.nodeId, outcome: 'completed' });
  }
  /** Only the adapter's verified terminal event may be passed here. */
  async recordTerminal(attemptId: string, threadId: string, turnId: string, status: 'completed' | 'stopped'): Promise<void> {
    const report = replayRun(await this.journal.read()), attempt = report.attempts.find(item => item.attemptId === attemptId);
    if (!attempt || attempt.sessionId !== threadId || attempt.runnerTurnId !== turnId || attempt.status !== 'unresolved') {
      throw new Error('Terminal event does not match a pending Codex attempt');
    }
    if (status === 'completed') {
      const events = await this.journal.read();
      const created = z.object({ flow: flowSchema, policy: projectPolicySchema }).parse(events[0]?.payload);
      const node = created.flow.definition.nodes.find(item => item.id === attempt.nodeId);
      if (node?.type === 'agent_task' && node.outputContract === 'plan') throw new Error('Planning output must be recorded before completion');
    }
    await this.append('attempt_finished', { attemptId, status });
    if (status === 'completed') await this.append('node_completed', { nodeId: attempt.nodeId, outcome: 'completed' });
  }
}
