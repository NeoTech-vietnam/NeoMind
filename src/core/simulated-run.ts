import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FakeAdapter } from '../adapters/fake.js';
import { recordApproval, type Plan } from '../domain/approval.js';
import { flowSchema, projectPolicySchema, type Flow, type ProjectPolicy } from '../domain/schema.js';
import { SingleOwnerJournal, type NewRunEvent, type RunEvent } from '../storage/journal.js';
import { replayRun, type RecoveryReport } from './recovery.js';
import type { Outcome } from './graph-scheduler.js';
import type { ReviewAssessment, ReviewerResult } from './review.js';

/**
 * A fixture-only application service connecting a fake adapter and a journal.
 * It cannot invoke real runtimes, write project files or execute Git. External
 * coordination is mandatory before using the underlying journal in production.
 */
export class SimulatedRun {
  private authorized: boolean;
  private constructor(readonly flow: Flow, readonly policy: ProjectPolicy, readonly journal: SingleOwnerJournal,
    readonly adapter: FakeAdapter, authorized: boolean) { this.authorized = authorized; }

  static async create(flowInput: unknown, policyInput: unknown, journal: SingleOwnerJournal, adapter: FakeAdapter): Promise<SimulatedRun> {
    if ((await journal.read()).length !== 0) throw new Error('Run journal already exists');
    const flow = flowSchema.parse(flowInput), policy = projectPolicySchema.parse(policyInput);
    const instance = new SimulatedRun(flow, policy, journal, adapter, true);
    await instance.append('run_created', { flow, policy });
    return instance;
  }

  static async recover(journal: SingleOwnerJournal, adapter: FakeAdapter): Promise<SimulatedRun> {
    const events = await journal.read();
    replayRun(events);
    const created = z.strictObject({ flow: flowSchema, policy: projectPolicySchema }).parse(events[0]?.payload);
    return new SimulatedRun(created.flow, created.policy, journal, adapter, false);
  }

  async report(): Promise<RecoveryReport> { return replayRun(await this.journal.read()); }

  /** Resume is an explicit simulated user action after runtime reconciliation. */
  async continueAfterRecovery(): Promise<void> {
    const report = await this.report();
    if (report.unresolvedAttemptIds.length || report.unresolvedCommitNodeIds.length) throw new Error('Unresolved attempts or commits require reconciliation');
    this.authorized = true;
  }

  private requireContinue(): void { if (!this.authorized) throw new Error('User must explicitly continue the recovered run'); }

  private async append(type: string, payload: unknown, requestId: string = randomUUID()): Promise<RunEvent> {
    const events = await this.journal.read();
    const json = z.json().parse(JSON.parse(JSON.stringify(payload)) as unknown);
    const input: NewRunEvent = { schemaVersion: 1, eventId: randomUUID(), runId: this.journal.runId,
      requestId, type, timestamp: new Date().toISOString(), payload: json };
    // Validate the prospective transition before it becomes durable.
    replayRun([...events, { ...input, sequence: events.length + 1 }]);
    return this.journal.append(input, events.length);
  }

  async completeControl(nodeId: string): Promise<void> {
    this.requireContinue();
    const node = this.flow.definition.nodes.find(item => item.id === nodeId);
    if (!node || !['start', 'fork', 'join', 'repair_scope', 'finish'].includes(node.type)) {
      throw new Error('This simulated control step is unsupported');
    }
    await this.append('node_claimed', { nodeId });
    await this.append('node_completed', { nodeId, outcome: 'completed' });
  }

  async approve(nodeId: string, plan: Plan, actor: string): Promise<void> {
    this.requireContinue();
    const node = this.flow.definition.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'approval') throw new Error('Not an approval node');
    if ((await this.report()).graph.nodes[nodeId]?.status === 'ready') await this.append('node_claimed', { nodeId });
    const approval = recordApproval(plan, this.policy, { approvalId: randomUUID(), actor, source: 'ui',
      decision: 'approved', timestamp: new Date().toISOString() });
    await this.append('approval_recorded', { nodeId, plan, approval });
    await this.append('node_completed', { nodeId, outcome: 'pass' });
  }

  async dispatchAgent(nodeId: string, sessionId: string, attemptId: string, requestId: string, writeScopes?: string[]): Promise<void> {
    this.requireContinue();
    const node = this.flow.definition.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'agent_task') throw new Error('Not an agent task');
    if ((await this.report()).unresolvedAttemptIds.length) throw new Error('Resolve earlier unknown effects before dispatch');
    await this.append('node_claimed', writeScopes ? { nodeId, writeScopes } : { nodeId });
    await this.append('dispatch_intent', { nodeId, sessionId, attemptId }, requestId);
    try { this.adapter.dispatch(sessionId, attemptId, requestId); }
    catch (error) {
      await this.append('dispatch_receipt', { attemptId, status: 'unknown' }, requestId);
      throw error;
    }
    await this.append('dispatch_receipt', { attemptId, status: 'accepted' }, requestId);
  }

  /** Fake-only evidence: callers must not treat these assessments as production verification. */
  async acceptReview(nodeId: string, baselineHash: string, producerSessionId: string,
    results: ReviewerResult[], assessments: Record<string, ReviewAssessment>): Promise<void> {
    this.requireContinue();
    if (this.flow.definition.nodes.find(item => item.id === nodeId)?.type !== 'review_group') throw new Error('Not a review group');
    if ((await this.report()).graph.nodes[nodeId]?.status === 'ready') await this.append('node_claimed', { nodeId });
    await this.append('review_accepted', { nodeId, baselineHash, producerSessionId, results, assessments });
    await this.append('node_completed', { nodeId, outcome: 'pass' });
  }

  /** Journal-only fixture: no Git command runs and the supplied object IDs are not verified. */
  async simulateCommit(nodeId: string, reviewNodeId: string, baselineHash: string,
    parent: string, tree: string, commit: string): Promise<void> {
    this.requireContinue();
    if (this.flow.definition.nodes.find(item => item.id === nodeId)?.type !== 'git_commit') throw new Error('Not a commit node');
    const report = await this.report();
    if (report.commits.some(item => item.nodeId === nodeId)) throw new Error('Commit already attempted; reconcile the prior intent');
    const requestId = randomUUID();
    if (report.graph.nodes[nodeId]?.status === 'ready') await this.append('node_claimed', { nodeId });
    await this.append('git_commit_intent', { nodeId, reviewNodeId, baselineHash, expectedParent: parent, expectedTree: tree }, requestId);
    await this.append('git_commit_receipt', { nodeId, baselineHash, parent, tree, commit }, requestId);
    await this.append('node_completed', { nodeId, outcome: 'completed' });
  }

  /** Observe fake adapter state without dispatch; safe to call before Continue. */
  async reconcileAttempt(attemptId: string): Promise<void> {
    const attempt = (await this.report()).attempts.find(item => item.attemptId === attemptId);
    if (!attempt || attempt.status !== 'unresolved') throw new Error('Attempt does not require reconciliation');
    const actual = this.adapter.status(attemptId);
    if (!actual || actual.status === 'running') throw new Error('Runtime outcome is not yet known');
    const result = actual.result;
    const baselineHash = result && typeof result === 'object' && 'baselineHash' in result && typeof result.baselineHash === 'string'
      ? result.baselineHash : undefined;
    await this.append('attempt_finished', { attemptId, status: actual.status === 'completed' ? 'completed' : 'stopped',
      ...(baselineHash ? { baselineHash } : {}) });
  }

  async completeAgent(nodeId: string, attemptId: string, outcome: Outcome = 'completed'): Promise<void> {
    this.requireContinue();
    let attempt = (await this.report()).attempts.find(item => item.attemptId === attemptId);
    if (!attempt || attempt.nodeId !== nodeId) throw new Error('Attempt does not belong to node');
    if (attempt.status === 'unresolved') { await this.reconcileAttempt(attemptId); attempt = (await this.report()).attempts.find(item => item.attemptId === attemptId); }
    if (attempt?.status !== 'completed') throw new Error('Attempt did not complete');
    await this.append('node_completed', { nodeId, outcome });
  }
}
