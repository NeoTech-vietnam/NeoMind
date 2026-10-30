import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateMaterializedRun, type MaterializedRun } from '../domain/materialize.js';
import { recordApproval } from '../domain/approval.js';
import { flowSchema, projectPolicySchema, type Flow, type ProjectPolicy } from '../domain/schema.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { stopExistingWorkerScope, type WorkerScope } from '../adapters/worker-scope.js';
import type { RunnerScope } from '../runners/agent-runner.js';
import type { CodexCheckDispatch } from './codex-check-dispatch.js';
import type { CheckSpec } from '../adapters/codex-check.js';
import type { GitCommitDispatch } from './git-commit-dispatch.js';
import type { CodexReviewDispatch, ReviewWorkspace } from './codex-review-dispatch.js';
import type { ReviewAssessment } from './review.js';
import type { CodexWriteDispatch } from './codex-write-dispatch.js';
import type { admitIsolatedWorkspaceWrite } from '../workspace/write-admission.js';
import type { CodexReadOnlyDispatch } from './codex-readonly-dispatch.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { replayRun } from './recovery.js';
import { runtimeArtifactSchema, runtimeContextSchema, runtimeStateSchema, type RuntimeArtifact, type RuntimeContext, type RuntimeState } from './runtime-state.js';
import { captureBaseline } from '../workspace/baseline.js';
import { hashJson } from '../domain/resolve.js';
import { evaluateCondition } from './condition.js';
import type { BindingValues } from '../domain/resolve.js';
import { IntegrationDispatch } from './integration-dispatch.js';
import { changedPaths } from '../workspace/dirty-import.js';
import { IMPACT_RULE_VERSION, selectReviewersForChanges, sharedImpactPaths } from './review-impact.js';
import { buildReviewTree } from '../workspace/review-tree.js';
import type { WorkspaceCoordinator, WorkspaceLease } from '../storage/coordination.js';

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

/** Serializes run transitions. Runtime dispatch must share this same serialization boundary. */
export class RunService {
  private pending: Promise<void> = Promise.resolve();
  private resumed: boolean;
  private closed = false;
  private constructor(private readonly journal: OwnedJournal, readonly flow: Flow, readonly policy: ProjectPolicy, resumed: boolean, readonly snapshot?: MaterializedRun) {
    this.resumed = resumed;
  }
  static async create(journal: OwnedJournal, flowInput: unknown, policyInput: unknown): Promise<RunService> {
    if ((await journal.read()).length) throw new Error('Run journal already exists');
    const flow = flowSchema.parse(flowInput), policy = projectPolicySchema.parse(policyInput);
    const service = new RunService(journal, flow, policy, true);
    await service.append('run_created', { flow, policy });
    return service;
  }
  static async createMaterialized(journal: OwnedJournal, snapshotInput: unknown): Promise<RunService> {
    if ((await journal.read()).length) throw new Error('Run journal already exists');
    const snapshot = freezeSnapshot(validateMaterializedRun(snapshotInput));
    const service = new RunService(journal, snapshot.configuration.flow, snapshot.policy, true, snapshot);
    await service.append('run_created', { flow: snapshot.configuration.flow, policy: snapshot.policy, snapshot });
    return service;
  }
  static async recover(journal: OwnedJournal): Promise<RunService> {
    const events = await journal.read(); replayRun(events);
    const created = z.strictObject({ flow: flowSchema, policy: projectPolicySchema, snapshot: z.json().optional() }).parse(events[0]?.payload);
    const snapshot = created.snapshot === undefined ? undefined : freezeSnapshot(validateMaterializedRun(created.snapshot));
    return new RunService(journal, snapshot?.configuration.flow ?? created.flow, snapshot?.policy ?? created.policy, false, snapshot);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Run service is closed'));
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async close(): Promise<void> { this.closed = true; await this.pending; }
  private async append(type: string, payload: unknown) {
    const events = await this.journal.read();
    const event = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.journal.runId, requestId: randomUUID(),
      type, timestamp: new Date().toISOString(), payload: z.json().parse(payload) };
    replayRun([...events, { ...event, sequence: events.length + 1 }]);
    await this.journal.append(event, events.length);
  }
  report() { return this.serialize(async () => ({ ...replayRun(await this.journal.read()), userContinueRequired: !this.resumed })); }
  initializeRuntime(context: RuntimeContext) { return this.serialize(() => this.append('runtime_context', runtimeContextSchema.parse(context))); }
  checkpointRuntime(state: RuntimeState) { return this.serialize(() => this.append('runtime_state', runtimeStateSchema.parse(state))); }
  extendRuntimeTime(seconds: number) { return this.serialize(() => this.append('runtime_time_extended', { seconds })); }
  selectAllowedFallback(key: string, values: BindingValues, reason: string) { return this.serialize(() => this.append('binding_fallback_selected', { key, values, reason })); }
  recordArtifact(artifact: RuntimeArtifact) { return this.serialize(() => this.append('runtime_artifact', runtimeArtifactSchema.parse(artifact))); }
  recordUsage(attemptId: string, result: TurnResult) { return this.serialize(async () => {
    if (result.usage) await this.append('usage_observed', { attemptId, threadId: result.threadId, turnId: result.turnId, total: result.usage });
  }); }
  requestPlanRevision(planningNodeId: string, feedback: string, expectedPlanHash: string) {
    return this.serialize(async () => {
      const report = replayRun(await this.journal.read()), proposal = report.plans.find(item => item.nodeId === planningNodeId);
      if (!proposal || hashJson(proposal.plan) !== expectedPlanHash) throw new Error('Kế hoạch đã thay đổi; cần xem lại');
      await this.append('plan_revision_requested', { planningNodeId, planId: proposal.plan.planId, version: proposal.plan.version + 1, feedback });
    });
  }
  authorizeWorkspaceContinuation() {
    return this.serialize(async () => {
      const report = replayRun(await this.journal.read()), context = report.runtimeContext;
      if (!context) throw new Error('Run has no runtime workspace');
      const baseline = await captureBaseline(context.workspace), scope = report.approvals.flatMap(item => item.plan.scope);
      if (baseline.head !== context.sourceHead && !report.commits.some(item => item.confirmed)) throw new Error('Workspace HEAD changed; approval must be reviewed');
      // Imported uncommitted changes are input; only changes made since the import must lie inside the approved scope.
      const changed = context.imported && baseline.head === context.sourceHead
        ? await changedPaths(context.workspace, context.imported.tree, (await buildReviewTree(context.workspace, baseline.baselineHash)).tree)
        : baseline.entries.map(entry => entry.path);
      if (changed.some(file => !scope.some(allowed => allowed === '.' || file === allowed || file.startsWith(`${allowed.replace(/\/$/, '')}/`)))) throw new Error('Workspace changes exceed the approved scope');
      await this.append('continuation_baseline', { baselineHash: baseline.baselineHash });
      return baseline.baselineHash;
    });
  }
  /** A user decision: commit the reviewed result including the imported uncommitted changes it cannot be separated from. */
  /** Journal applying a finished run's changes to the user's checkout: the intent before touching it, the receipt after. */
  recordCheckoutApply(stage: 'intent', payload: { tree: string; paths: string[]; patchHash: string }): Promise<void>;
  recordCheckoutApply(stage: 'applied', payload: { patchHash: string }): Promise<void>;
  recordCheckoutApply(stage: 'intent' | 'applied', payload: unknown) { return this.serialize(() => this.append(stage === 'intent' ? 'checkout_apply_intent' : 'checkout_applied', payload)); }
  /** Journal removing a finished run's worktrees: the plan (refs to keep, files discarded) before touching them, the receipt after. */
  recordWorkspaceCleanup(stage: 'intent', payload: { workspaces: string[]; refs: { ref: string; commit: string }[]; discarded: string[] }): Promise<void>;
  recordWorkspaceCleanup(stage: 'cleaned'): Promise<void>;
  recordWorkspaceCleanup(stage: 'intent' | 'cleaned', payload: unknown = {}) { return this.serialize(() => this.append(stage === 'intent' ? 'workspace_cleanup_intent' : 'workspace_cleaned', payload)); }
  includeImportedInCommit(nodeId: string) { return this.serialize(() => this.append('commit_scope_selected', { nodeId, includeImported: true })); }
  requeueStoppedNode(nodeId: string) { return this.serialize(() => { this.requireContinue(); return this.append('node_requeued', { nodeId }); }); }
  retryReview(nodeId: string, reason: 'user' | 'validation' = 'user', reviewerIds?: string[]) { return this.serialize(() => { this.requireContinue(); return this.append('review_retry_requested', { nodeId, reason, ...(reviewerIds ? { reviewerIds } : {}) }); }); }
  updateProducerBaseline(attemptId: string, baselineHash: string) {
    return this.serialize(async () => {
      this.requireContinue();
      const report = replayRun(await this.journal.read());
      if (!report.runtimeContext || (await captureBaseline(report.runtimeContext.workspace)).baselineHash !== baselineHash) throw new Error('Continuation baseline changed');
      await this.append('producer_baseline_updated', { attemptId, baselineHash });
    });
  }
  reconcileScopedAttempt(attemptId: string) {
    return this.serialize(async () => {
      const attempt = replayRun(await this.journal.read()).attempts.find(item => item.attemptId === attemptId);
      if (!attempt || attempt.status !== 'unresolved' || !attempt.workerUnit || !attempt.workerControlGroup) throw new Error('No persisted worker scope to reconcile');
      if (!await stopExistingWorkerScope({ unit: attempt.workerUnit, controlGroup: attempt.workerControlGroup })) throw new Error('Worker stop is unconfirmed');
      await this.append('attempt_finished', { attemptId, status: 'stopped' });
    });
  }
  beginRepair(scopeId: string, baselineHash: string, findingIds: string[], reviewedTree?: string) {
    return this.serialize(async () => {
      this.requireContinue();
      const roundId = randomUUID();
      await this.append('repair_round_started', { roundId, scopeId, baselineHash, findingIds, ...(reviewedTree ? { reviewedTree } : {}) });
      return roundId;
    });
  }
  /**
   * Keep the passing reviewers of the replaced round whose scopes the repair did not touch. Core derives the changed paths
   * from the reviewed tree and the current workspace; replay re-applies the same rule. Returns the reviewers still to run.
   */
  carryUnaffectedReviews(nodeId: string, baselineHash: string) {
    return this.serialize(async () => {
      this.requireContinue();
      const report = replayRun(await this.journal.read()), round = report.repairRounds.at(-1), context = report.runtimeContext;
      const node = this.flow.definition.nodes.find(item => item.id === nodeId);
      if (node?.type !== 'review_group' || !context) throw new Error('Not a review group');
      const all = node.reviewers.map(item => item.id), done = report.reviewerOutputs.filter(item => item.nodeId === nodeId).map(item => item.result.reviewerId);
      if (!round?.reviewedTree || done.length) return all.filter(id => !done.includes(id));
      const reviewed = await buildReviewTree(context.workspace, baselineHash);
      const changed = await changedPaths(context.workspace, round.reviewedTree, reviewed.tree);
      if (!changed.length) return all;
      const prior = report.priorReviewerOutputs[nodeId] ?? [];
      const selection = selectReviewersForChanges(node.reviewers.map(item => ({ id: item.id, required: item.required, scopes: item.scope })), changed,
        prior.filter(item => item.result.verdict !== 'pass').map(item => item.result.reviewerId), sharedImpactPaths(changed).length === 0);
      if (selection.reason !== 'scoped') return all;
      for (const reviewer of node.reviewers) {
        if (selection.reviewerIds.includes(reviewer.id) || prior.find(item => item.result.reviewerId === reviewer.id)?.result.verdict !== 'pass') continue;
        await this.append('review_carried_forward', { nodeId, reviewerId: reviewer.id, toBaselineHash: baselineHash, receipt: { fromBaselineHash: round.baselineHash,
          oldTree: round.reviewedTree, newTree: reviewed.tree, changedPaths: changed, scopes: reviewer.scope, ruleVersion: IMPACT_RULE_VERSION } });
      }
      const carried = replayRun(await this.journal.read()).reviewerOutputs.filter(item => item.nodeId === nodeId).map(item => item.result.reviewerId);
      return all.filter(id => !carried.includes(id));
    });
  }
  continueAfterRecovery() {
    return this.serialize(async () => {
      const report = replayRun(await this.journal.read());
      if (report.unresolvedAttemptIds.length || report.unresolvedCommitNodeIds.length || report.unresolvedCheckIds.length || report.unresolvedIntegrationNodeIds.length) throw new Error('Reconcile uncertain effects before continuing');
      this.resumed = true;
    });
  }
  private requireContinue() { if (!this.resumed) throw new Error('Explicit user continuation required'); }
  evaluateConditionNode(nodeId: string) {
    return this.serialize(async () => {
      this.requireContinue(); const node = this.flow.definition.nodes.find(item => item.id === nodeId), report = replayRun(await this.journal.read());
      if (node?.type !== 'condition') throw new Error('Not a condition node');
      const value = evaluateCondition(node, { nodes: report.graph.nodes, incomingIds: this.flow.definition.edges.filter(edge => edge.to === nodeId).map(edge => edge.from), checks: report.checks, acceptedReviewCount: report.acceptedReviews.length, repairRounds: report.repairRounds.length });
      await this.append('condition_evaluated', { nodeId, value });
    });
  }
  completeControl(nodeId: string) {
    return this.serialize(async () => {
      this.requireContinue();
      const node = this.flow.definition.nodes.find(item => item.id === nodeId);
      if (!node || !['start', 'fork', 'join', 'repair_scope', 'finish'].includes(node.type)) throw new Error('Unsupported control node');
      await this.append('node_claimed', { nodeId }); await this.append('node_completed', { nodeId, outcome: 'completed' });
    });
  }
  /** Finish an already-durable result after a crash; this never invokes an agent or Git. */
  finalizePersisted(nodeId: string) {
    return this.serialize(async () => {
      this.requireContinue();
      const report = replayRun(await this.journal.read());
      if (report.graph.nodes[nodeId]?.status !== 'running') throw new Error('Node is not awaiting finalization');
      const node = this.flow.definition.nodes.find(item => item.id === nodeId);
      let outcome: 'completed' | 'pass';
      if (node?.type === 'agent_task' && report.plans.some(item => item.nodeId === nodeId)) outcome = 'completed';
      else if (node?.type === 'agent_task') {
        const attempt = [...report.attempts].reverse().find(item => item.nodeId === nodeId);
        if (!attempt || attempt.status !== 'completed' || !attempt.baselineHash || !attempt.workspace || (await captureBaseline(attempt.workspace)).baselineHash !== attempt.baselineHash) throw new Error('No durable agent result for this baseline');
        outcome = 'completed';
      }
      else if (node?.type === 'integration') { await new IntegrationDispatch(this.journal).complete(nodeId); return; }
      else if (node?.type === 'review_group' && report.acceptedReviews.some(item => item.nodeId === nodeId)) outcome = 'pass';
      else if (node?.type === 'git_commit' && report.commits.some(item => item.nodeId === nodeId && item.confirmed)) outcome = 'completed';
      else throw new Error('No durable result to finalize');
      await this.append('node_completed', { nodeId, outcome });
    });
  }
  dispatchReadOnly(dispatcher: CodexReadOnlyDispatch, nodeId: string, threadId: string, prompt: string,
    effort: string, attemptId: string, requestId: string, scope?: RunnerScope, context?: ReviewWorkspace) {
    return this.serialize(async () => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.dispatch(nodeId, threadId, prompt, effort, attemptId, requestId, true, scope, context);
    });
  }
  recordReadOnlyPlan(dispatcher: CodexReadOnlyDispatch, attemptId: string, result: TurnResult) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.recordPlan(attemptId, result);
    });
  }
  recordReadOnlyResult(dispatcher: CodexReadOnlyDispatch, attemptId: string, result: TurnResult, context: ReviewWorkspace) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.recordResult(attemptId, result, context);
    });
  }
  dispatchWrite(dispatcher: CodexWriteDispatch, nodeId: string, threadId: string, prompt: string, effort: string,
    attemptId: string, requestId: string, admission: Parameters<typeof admitIsolatedWorkspaceWrite>[0], scope: RunnerScope) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.dispatch(nodeId, threadId, prompt, effort, attemptId, requestId, admission, scope, true);
    });
  }
  reconcileWriteStop(dispatcher: CodexWriteDispatch, attemptId: string, admission: Parameters<typeof admitIsolatedWorkspaceWrite>[0]) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.reconcileStopped(attemptId, admission);
    });
  }
  recordWriteTerminal(dispatcher: CodexWriteDispatch, attemptId: string, threadId: string, turnId: string,
    status: 'completed' | 'stopped', admission: Parameters<typeof admitIsolatedWorkspaceWrite>[0], scope: RunnerScope) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.recordTerminal(attemptId, threadId, turnId, status, admission, scope);
    });
  }
  reconcileCheckStop(dispatcher: CodexCheckDispatch, checkId: string, context: ReviewWorkspace) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.reconcileStopped(checkId, context);
    });
  }
  runCheck(dispatcher: CodexCheckDispatch, spec: CheckSpec, baselineHash: string, context: ReviewWorkspace, requestId: string, scope: WorkerScope) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.run(spec, baselineHash, context, requestId, scope, true);
    });
  }
  dispatchReview(dispatcher: CodexReviewDispatch, nodeId: string, reviewerId: string, threadId: string, prompt: string,
    effort: string, attemptId: string, requestId: string, baselineHash: string, context: ReviewWorkspace, scope?: RunnerScope) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.dispatch(nodeId, reviewerId, threadId, prompt, effort, attemptId, requestId, baselineHash, context, true, scope);
    });
  }
  recordReview(dispatcher: CodexReviewDispatch, nodeId: string, reviewerId: string, baselineHash: string,
    attemptId: string, result: TurnResult, context: ReviewWorkspace) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.record(nodeId, reviewerId, baselineHash, attemptId, result, context);
    });
  }
  finishReview(dispatcher: CodexReviewDispatch, nodeId: string, producerSessionId: string, baselineHash: string,
    assessments: Record<string, ReviewAssessment>, context: ReviewWorkspace) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.finish(nodeId, producerSessionId, baselineHash, assessments, context);
    });
  }
  reconcileCommit(dispatcher: GitCommitDispatch, nodeId: string, workspace: string,
    lease: Parameters<GitCommitDispatch['reconcile']>[2], coordinator: Parameters<GitCommitDispatch['reconcile']>[3]) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.reconcile(nodeId, workspace, lease, coordinator);
    });
  }
  authorizeCommitRetry(dispatcher: GitCommitDispatch, nodeId: string, workspace: string,
    lease: Parameters<GitCommitDispatch['authorizeRetry']>[2], coordinator: Parameters<GitCommitDispatch['authorizeRetry']>[3]) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.authorizeRetry(nodeId, workspace, lease, coordinator);
    });
  }
  commit(dispatcher: GitCommitDispatch, input: Omit<Parameters<GitCommitDispatch['commit']>[0], 'authorized'>) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.commit({ ...input, authorized: true });
    });
  }
  /** Accept the current content of a branch worktree on explicit user continuation; it must stay inside the packet scope. */
  authorizeBranchContinuation(nodeId: string) {
    return this.serialize(async () => {
      this.requireContinue();
      const report = replayRun(await this.journal.read()), branch = report.branchWorkspaces.find(item => item.nodeId === nodeId);
      const packet = report.approvals.at(-1)?.plan.workPackets?.find(item => item.nodeId === nodeId);
      if (!branch || !packet) throw new Error('No branch workspace to continue');
      const baseline = await captureBaseline(branch.workspace);
      if (baseline.head !== branch.baseCommit) throw new Error('Branch workspace HEAD changed; approval must be reviewed');
      if (baseline.entries.some(entry => !packet.scope.some(allowed => allowed === '.' || entry.path === allowed || entry.path.startsWith(`${allowed.replace(/\/$/, '')}/`)))) throw new Error('Branch changes exceed the work packet scope');
      await this.append('continuation_baseline', { baselineHash: baseline.baselineHash });
      return baseline.baselineHash;
    });
  }
  prepareBranchWorkspace(dispatcher: IntegrationDispatch, nodeId: string, coordinator: WorkspaceCoordinator, hostId: string) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.prepareBranch(nodeId, coordinator, hostId);
    });
  }
  integrate(dispatcher: IntegrationDispatch, nodeId: string, coordinator: WorkspaceCoordinator, lease: WorkspaceLease) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.integrate(nodeId, coordinator, lease);
    });
  }
  /** Recovery only: complete an interrupted, already journaled merge. */
  reconcileIntegration(dispatcher: IntegrationDispatch, nodeId: string, coordinator: WorkspaceCoordinator, lease: WorkspaceLease) {
    return this.serialize(() => {
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.reconcile(nodeId, coordinator, lease);
    });
  }
  completeIntegration(dispatcher: IntegrationDispatch, nodeId: string) {
    return this.serialize(() => {
      this.requireContinue();
      if (!dispatcher.usesJournal(this.journal)) throw new Error('Dispatcher uses another run journal');
      return dispatcher.complete(nodeId);
    });
  }
  /** Call only for an authenticated user action or a flow-declared automatic approval, never for content generated by an agent. */
  approveProposedPlan(nodeId: string, planningNodeId: string, actor: string, source: 'ui' | 'cli' | 'flow' | 'session') {
    return this.serialize(async () => {
      this.requireContinue();
      const report = replayRun(await this.journal.read()), proposal = report.plans.find(item => item.nodeId === planningNodeId);
      if (!proposal) throw new Error('No persisted plan from this planning node');
      if (!this.flow.definition.edges.some(edge => edge.from === planningNodeId && edge.to === nodeId)) throw new Error('Plan does not feed this approval');
      if (report.graph.nodes[nodeId]?.status === 'ready') await this.append('node_claimed', { nodeId });
      const approval = recordApproval(proposal.plan, this.policy, { approvalId: randomUUID(), actor, source,
        decision: 'approved', timestamp: new Date().toISOString() });
      await this.append('approval_recorded', { nodeId, plan: proposal.plan, approval });
      await this.append('node_completed', { nodeId, outcome: 'pass' });
    });
  }
}
