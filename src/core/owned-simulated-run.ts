import type { FakeAdapter } from '../adapters/fake.js';
import type { Plan } from '../domain/approval.js';
import { WorkspaceCoordinator, type RunOwnerLease } from '../storage/coordination.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import type { Outcome } from './graph-scheduler.js';
import type { ReviewAssessment, ReviewerResult } from './review.js';
import { SimulatedRun } from './simulated-run.js';

/** A single-owner service for simulated runs only. It does not authorize real agent execution. */
export class OwnedSimulatedRun {
  private pending: Promise<void> = Promise.resolve();
  private closing = false;
  private constructor(private readonly coordinator: WorkspaceCoordinator, private readonly lease: RunOwnerLease,
    private readonly journal: OwnedJournal, private readonly run: SimulatedRun) {}

  static async create(coordinator: WorkspaceCoordinator, runId: string, hostId: string, journalFile: string,
    flow: unknown, policy: unknown, adapter: FakeAdapter): Promise<OwnedSimulatedRun> {
    const lease = coordinator.acquireRun(runId, hostId);
    try {
      const journal = new OwnedJournal(journalFile, coordinator, lease);
      const run = await SimulatedRun.create(flow, policy, journal, adapter);
      return new OwnedSimulatedRun(coordinator, lease, journal, run);
    } catch (error) { coordinator.releaseRun(lease, true); throw error; }
  }

  static async recover(coordinator: WorkspaceCoordinator, runId: string, hostId: string, journalFile: string,
    adapter: FakeAdapter): Promise<OwnedSimulatedRun> {
    const lease = coordinator.acquireRun(runId, hostId);
    try {
      const journal = new OwnedJournal(journalFile, coordinator, lease);
      const run = await SimulatedRun.recover(journal, adapter);
      return new OwnedSimulatedRun(coordinator, lease, journal, run);
    } catch (error) { coordinator.releaseRun(lease, true); throw error; }
  }

  private execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Run service is closing'));
    const result = this.pending.then(fn);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  report() { return this.execute(() => this.run.report()); }
  continueAfterRecovery() { return this.execute(() => this.run.continueAfterRecovery()); }
  completeControl(nodeId: string) { return this.execute(() => this.run.completeControl(nodeId)); }
  approve(nodeId: string, plan: Plan, actor: string) { return this.execute(() => this.run.approve(nodeId, plan, actor)); }
  dispatchAgent(nodeId: string, sessionId: string, attemptId: string, requestId: string, writeScopes?: string[]) {
    return this.execute(() => this.run.dispatchAgent(nodeId, sessionId, attemptId, requestId, writeScopes));
  }
  acceptReview(nodeId: string, baselineHash: string, producerSessionId: string,
    results: ReviewerResult[], assessments: Record<string, ReviewAssessment>) {
    return this.execute(() => this.run.acceptReview(nodeId, baselineHash, producerSessionId, results, assessments));
  }
  simulateCommit(nodeId: string, reviewNodeId: string, baselineHash: string, parent: string, tree: string, commit: string) {
    return this.execute(() => this.run.simulateCommit(nodeId, reviewNodeId, baselineHash, parent, tree, commit));
  }
  reconcileAttempt(attemptId: string) { return this.execute(() => this.run.reconcileAttempt(attemptId)); }
  completeAgent(nodeId: string, attemptId: string, outcome?: Outcome) {
    return this.execute(() => this.run.completeAgent(nodeId, attemptId, outcome));
  }
  /** Release only scheduler ownership; worker/workspace leases require independent reconciliation. */
  async close(): Promise<void> {
    if (this.closing) throw new Error('Run service is closing');
    this.closing = true;
    await this.pending; await this.journal.close(); this.coordinator.releaseRun(this.lease, true);
  }
}
