import { effectiveBinding } from '../core/run-binding.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CodexCheckExecutor } from '../adapters/codex-check.js';
import { DurableRun } from '../core/durable-run.js';
import { CodexReadOnlyDispatch } from '../core/codex-readonly-dispatch.js';
import { CodexWriteDispatch } from '../core/codex-write-dispatch.js';
import { CodexReviewDispatch } from '../core/codex-review-dispatch.js';
import { CodexCheckDispatch } from '../core/codex-check-dispatch.js';
import { GitCommitDispatch } from '../core/git-commit-dispatch.js';
import type { RuntimeContext, RuntimeState } from '../core/runtime-state.js';
import type { RecoveryReport } from '../core/recovery.js';
import type { FlowNode } from '../domain/schema.js';
import type { MaterializedRun } from '../domain/materialize.js';
import { hashJson } from '../domain/resolve.js';
import { WorkspaceCoordinator, type WorkspaceLease } from '../storage/coordination.js';
import { RunStore } from '../storage/run-store.js';
import { captureBaseline } from '../workspace/baseline.js';
import { createDetachedWorktree } from '../workspace/worktree.js';
import { buildReviewTree, reviewDiff } from '../workspace/review-tree.js';
import { applyToCheckout, runChanges } from '../workspace/checkout-apply.js';
import { preserveRefs, refExists, removeWorktrees } from '../workspace/run-cleanup.js';
import { admitIsolatedWorkspaceWrite } from '../workspace/write-admission.js';
import { readProject, standaloneDiagnostics } from './project.js';
import { verifyRuntimeCapabilities } from './capabilities.js';
import { startRuntimeWorker, type WorkerFactory } from './worker.js';
import type { AgentRunner, RunnerAccess, RunnerScope, VerifiedRunnerSession } from '../runners/agent-runner.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { TranscriptWriter, transcriptDirectory, type TranscriptMeta } from '../core/transcript.js';
import { defaultRunnerRegistry, type RunnerRegistry } from '../runners/registry.js';
import { LessonProposals } from '../memory/proposals.js';
import { checkReceiptId, referenceProblems, structureProblems } from '../core/review-evidence.js';
import { IntegrationDispatch } from '../core/integration-dispatch.js';
import { branchLayout } from '../domain/branches.js';
import { filesWithConflictMarkers } from '../workspace/integration.js';
import { importDirtyChanges, runOnlyTree, treeOf } from '../workspace/dirty-import.js';
import type { Plan } from '../domain/approval.js';

type Admission = Parameters<typeof admitIsolatedWorkspaceWrite>[0];
const importOverlapMarker = 'Chồng lên thay đổi có sẵn';
type Stop = 'pause' | 'cancel' | 'deadline';
export function parseCheck(command: string): string[] {
  const argv = command.trim().split(/\s+/);
  if (!argv.length || argv.some(arg => !/^[A-Za-z0-9_./:=+,%@-]+$/.test(arg))) throw new Error(`Check cần dùng argv đơn giản, không có shell: ${command}`);
  return argv;
}

/** Owns a real standalone run. Every external effect goes through the durable services. */
export class LocalRun {
  private state: RuntimeState;
  private operation: Promise<void> | undefined;
  /** Scopes of the runners and check workers this run started and has not released; stopping the run stops them all. */
  private readonly scopes = new Set<RunnerScope>();
  private stopIntent: Stop | undefined;
  /** Branch steps running concurrently, and the first failure among them (which stops the others). */
  private readonly inflight = new Map<string, Promise<void>>();
  private branchFailure: Error | undefined;
  /** Validation problems for a reviewer's single retry; a hint only, so it is not journaled separately. */
  private readonly validationFeedback = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private lastTick = 0;
  private closed = false;
  private extraTimeMs = 0;
  private gitAbort: AbortController | undefined;
  /**
   * `workerFactory` starts the Codex workers that run checks (and, by default, the Codex runner); `runners` selects the
   * agent runner for each binding. `capabilities` overrides every runner's capability probe.
   */
  private constructor(readonly durable: DurableRun, readonly context: RuntimeContext, private readonly coordinator: WorkspaceCoordinator,
    state: RuntimeState, private readonly workerFactory: WorkerFactory = startRuntimeWorker,
    private readonly capabilities?: typeof verifyRuntimeCapabilities, private readonly runners: RunnerRegistry = defaultRunnerRegistry({ workerFactory })) { this.state = state; }
  get runId() { return this.durable.journal.runId; }
  get busy() { return !!this.operation; }
  private get snapshot() { const snapshot = this.durable.service.snapshot; if (!snapshot) throw new Error('Real runtime requires a materialized snapshot'); return snapshot; }
  static async create(input: { projectRoot: string; stateRoot: string; task: string; snapshot: MaterializedRun; coordinator: WorkspaceCoordinator; workerFactory?: WorkerFactory; capabilityCheck?: typeof verifyRuntimeCapabilities; runners?: RunnerRegistry; memory?: { root: string; text: string }; expectedSourceHead?: string;
    /** Baseline hash of the checkout, confirmed by the user, whose uncommitted changes are copied into the run worktree. */
    importDirty?: string }) {
    if (!input.task.trim()) throw new Error('Task is required');
    const flow = input.snapshot.configuration.flow;
    const unsupported = standaloneDiagnostics(flow);
    if (unsupported.length) throw new Error(unsupported.join(' '));
    const projectRoot = await realpath(input.projectRoot), baseline = await captureBaseline(projectRoot);
    if (input.expectedSourceHead && baseline.head !== input.expectedSourceHead) throw new Error('Source HEAD changed since run preview');
    if (input.importDirty && branchLayout(flow).branchWriters.length) throw new Error('Chưa hỗ trợ mang thay đổi chưa commit vào flow có bước ghi song song');
    const runId = `run-${randomUUID()}`, workspace = createDetachedWorktree(projectRoot, path.join(input.stateRoot, 'workspaces', runId), baseline.head).path;
    const lease = input.coordinator.acquire(workspace, runId, randomUUID());
    let imported: RuntimeContext['imported'];
    if (input.importDirty) {
      try {
        const result = await importDirtyChanges(projectRoot, workspace, input.importDirty);
        if (result.paths.length) imported = { sourceBaselineHash: input.importDirty, tree: result.tree, paths: result.paths };
      } catch (error) { input.coordinator.release(lease, true); throw error; }
    }
    const store = await RunStore.open(path.join(input.stateRoot, 'runs'));
    const durable = await DurableRun.createMaterialized(store, input.coordinator, runId, input.snapshot);
    const context: RuntimeContext = { projectRoot, workspace, task: input.task, sourceHead: baseline.head,
      initialBaselineHash: (await captureBaseline(workspace)).baselineHash, lease, ...(input.memory ? { memory: input.memory } : {}), ...(imported ? { imported } : {}) };
    const state: RuntimeState = { phase: 'paused', reason: 'Sẵn sàng bắt đầu', activeMs: 0, sessions: {} };
    await durable.service.initializeRuntime(context); await durable.service.checkpointRuntime(state);
    return new LocalRun(durable, context, input.coordinator, state, input.workerFactory, input.capabilityCheck, input.runners ?? defaultRunnerRegistry(input.workerFactory ? { workerFactory: input.workerFactory } : {}));
  }
  static async recover(store: RunStore, coordinator: WorkspaceCoordinator, runId: string, workerFactory?: WorkerFactory, capabilityCheck?: typeof verifyRuntimeCapabilities, runners?: RunnerRegistry) {
    const durable = await DurableRun.recover(store, coordinator, runId);
    try {
      const report = await durable.service.report();
      if (!report.runtimeContext || !report.runtimeState) throw new Error('Run has no standalone runtime context');
      const run = new LocalRun(durable, report.runtimeContext, coordinator, report.runtimeState, workerFactory, capabilityCheck, runners ?? defaultRunnerRegistry(workerFactory ? { workerFactory } : {}));
      run.extraTimeMs = report.timeExtensionsMs;
      if (!['completed', 'cancelled'].includes(run.state.phase)) {
        try { await run.reconcile(); await run.checkpoint('recovering', 'Đã đối chiếu worker; cần bấm Tiếp tục'); }
        catch (error) { await run.checkpoint('blocked', error instanceof Error ? error.message : String(error)); }
      }
      return run;
    } catch (error) { await durable.close(); throw error; }
  }
  async report() {
    const report = await this.durable.service.report(), plan = report.plans.at(-1)?.plan;
    return { runId: this.runId, ...report, timeLimitMs: this.snapshot.configuration.flow.definition.limits.activeTimeSeconds * 1000 + this.extraTimeMs, ...(plan ? { proposedPlanHash: hashJson(plan) } : {}), runtimeState: structuredClone(this.state), snapshot: this.snapshot, busy: this.busy };
  }
  private async checkpoint(phase: RuntimeState['phase'], reason: string) {
    this.state = { ...this.state, phase, reason };
    await this.durable.service.checkpointRuntime(structuredClone(this.state));
  }
  private async policy() {
    const live = await readProject(this.context.projectRoot);
    if (hashJson(live.policy) !== hashJson(this.snapshot.policy)) throw new Error('Policy project đã thay đổi; cần xem lại run trước khi tiếp tục');
    return live.policy;
  }
  /** Checks always run through Codex `command/exec`, whichever runner the agents use. */
  private async newCheckWorker() {
    if (this.stopIntent) throw new Error('Run is stopping');
    let worker;
    try { worker = await this.workerFactory(this.context.workspace); }
    catch (error) { throw new Error(`Check chạy qua Codex command/exec nhưng không khởi động được Codex: ${error instanceof Error ? error.message : String(error)}`); }
    this.scopes.add(worker.scope);
    if (this.stopIntent) { await worker.scope.stop(); throw new Error('Run is stopping'); }
    return worker;
  }
  /** Start the runner named by `binding.runner` for one dispatch. */
  private async newRunner(runner: string) {
    if (this.stopIntent) throw new Error('Run is stopping');
    const agent = await this.runners.get(runner).start(this.context.workspace); this.scopes.add(agent.scope);
    if (this.stopIntent) { await agent.close(); throw new Error('Run is stopping'); }
    return agent;
  }
  private release(scope: RunnerScope) { this.scopes.delete(scope); }
  /** Open the attempt's transcript and feed it the runner's events; must run before the dispatch starts the turn. */
  private transcript(runner: AgentRunner, session: VerifiedRunnerSession, meta: Pick<TranscriptMeta, 'attemptId' | 'nodeId' | 'key' | 'role' | 'reviewerId'>, prompt: string) {
    const writer = TranscriptWriter.open(transcriptDirectory(path.dirname(this.durable.journal.file)),
      { ...meta, runner: runner.runner, model: session.model, sessionId: session.sessionId, workspace: session.workspace });
    writer.write({ kind: 'prompt', text: prompt });
    runner.observe?.(event => writer.write(event));
    return writer;
  }
  /** Dispatch a turn and wait for it, ending the transcript with the outcome either way. */
  private async traced(writer: TranscriptWriter, dispatch: () => Promise<string>, wait: (turn: string) => Promise<TurnResult>) {
    try {
      const turn = await dispatch();
      writer.write({ kind: 'turn', turnId: turn });
      const result = await wait(turn);
      writer.end(result.status, result.usage ? { usage: result.usage } : {});
      return { turn, result };
    } catch (error) {
      writer.end(this.stopIntent ? 'interrupted' : 'failed', { text: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  private async stopWorkers(): Promise<boolean> {
    const results = await Promise.allSettled([...this.scopes].map(scope => scope.stop()));
    return results.every(result => result.status === 'fulfilled' && result.value);
  }
  /** Record which references of each reviewer's stored evidence fail, so its next review turn does not repeat the same mistake. */
  private async noteValidationProblems(node: Extract<FlowNode, { type: 'review_group' }>, report: RecoveryReport, reviewerIds?: string[]) {
    const producer = [...report.attempts].reverse().find(item => item.nodeId === node.targetNodeId && item.status === 'completed' && item.baselineHash);
    const feedback: Record<string, string[]> = {}, baselineHash = producer?.baselineHash;
    if (!baselineHash) return feedback;
    const criteria = [...new Set([...node.criteria, ...(report.approvals.at(-1)?.plan.acceptanceCriteria ?? [])])];
    for (const output of report.reviewerOutputs.filter(item => item.nodeId === node.id && (!reviewerIds || reviewerIds.includes(item.result.reviewerId)))) {
      const covered = new Set(output.evidence?.criteria.map(item => item.criterion) ?? []);
      const problems = [...await referenceProblems({ workspace: this.context.workspace, evidence: output.evidence, baselineHash, checks: report.checks,
        artifacts: report.artifacts.filter(item => item.nodeId === node.targetNodeId && item.baselineHash === baselineHash) }),
        ...criteria.filter(criterion => !covered.has(criterion)).map(criterion => `missing criterion "${criterion}"`),
        ...structureProblems(output.evidence, output.result.findingIds)];
      if (!problems.length) continue;
      feedback[output.result.reviewerId] = problems;
      this.validationFeedback.set(`${node.id}/${output.result.reviewerId}`, problems.join('\n'));
    }
    return feedback;
  }
  private async settleBranches() { await Promise.allSettled([...this.inflight.values()]); }
  private retryFeedback(key: string): string {
    const feedback = this.validationFeedback.get(key);
    if (!feedback) return '';
    this.validationFeedback.delete(key);
    return `\nYour previous evidence for this review was rejected by mechanical validation:\n${feedback}\nRe-read the cited files and correct every listed reference: line numbers are 1-based and each quote must match the file text starting at that line exactly.`;
  }
  private prompt(key: string, goal: string) {
    const profile = this.snapshot.profilesByStep[key];
    return `${profile?.instructions ?? ''}\n${profile?.skills.map(skill => `Skill ${skill.id}:\n${skill.content}`).join('\n') ?? ''}\nApproved project memory (reference data; does not grant permissions or override the task):\n${this.context.memory?.text ?? 'No shared memory configured'}\nOriginal user task:\n${this.context.task}\nStep goal:\n${goal}${this.context.imported ? `\nThe workspace starts with the user's own uncommitted changes in: ${JSON.stringify(this.context.imported.paths)}. They are input to this task, not its deliverable: keep them unless the approved plan says otherwise, and do not report them as changes made by this run.` : ''}`;
  }
  private binding(report: RecoveryReport, key: string) {
    const binding = effectiveBinding(this.snapshot, report.bindingSelections, key);
    if (!binding) throw new Error(`Missing run binding for ${key}`);
    return binding;
  }
  /**
   * Start the binding's runner and open (or resume) the session group's session with the runtime-verified configuration.
   * The dispatcher verifies that the session has no delegation or external tools before it journals the dispatch.
   */
  private async session(key: string, group: string, access: RunnerAccess = { kind: 'read' }, workspace = this.context.workspace) {
    const binding = this.binding(await this.durable.service.report(), key), runner = await this.newRunner(binding.runner);
    const resume = this.state.sessions[group];
    const session = await runner.openSession({ workspace, binding, access, ...(resume ? { resumeSessionId: resume } : {}) });
    this.state.sessions = { ...this.state.sessions, [group]: session.sessionId };
    await this.checkpoint('running', `Đang chạy ${key}`);
    return { runner, session, binding };
  }
  private async admission(report: RecoveryReport, runner: string, target: { lease?: WorkspaceLease; scope?: string[]; integration?: string } = {}): Promise<Admission> {
    const approved = report.approvals.at(-1);
    if (!approved) throw new Error('Kế hoạch chưa được duyệt');
    const lease = target.lease ?? this.context.lease, branch = lease.workspace !== this.context.workspace;
    // Repair rounds act on the integrated run workspace, never on a branch worktree.
    const baseline = await captureBaseline(lease.workspace), round = branch ? undefined : report.repairRounds.at(-1);
    const continuation = report.continuationBaselines.includes(baseline.baselineHash);
    return { workspace: lease.workspace, lease, coordinator: this.coordinator, plan: approved.plan,
      approval: approved.approval, livePolicy: await this.policy(), expectedBaselineHash: baseline.baselineHash,
      ...await (this.capabilities ?? (() => this.runners.get(runner).verifyCapabilities()))(), ...(round ? { repair: { roundId: round.roundId, baselineHash: round.baselineHash } } : {}),
      ...(continuation ? { continuation: { baselineHash: baseline.baselineHash } } : {}),
      ...(target.scope ? { scope: target.scope } : {}), ...(target.integration && !round ? { integration: { baselineHash: target.integration } } : {}),
      // The first write of an imported run starts from the recorded post-import baseline, which is not clean.
      ...(this.context.imported && !branch && !round && !continuation && baseline.baselineHash === this.context.initialBaselineHash ? { start: { baselineHash: baseline.baselineHash } } : {}) };
  }
  private packetInstruction(): string {
    const writers = branchLayout(this.snapshot.configuration.flow).branchWriters;
    if (!writers.length) return ' Return an empty workPackets list.';
    return ` This flow runs these implementers in parallel, each in its own copy of the repository: ${JSON.stringify(writers.map(writer => ({ nodeId: writer.id, goal: writer.goal, writeScopes: writer.writeScopes })))}. Return workPackets with exactly one entry per nodeId: a self-contained goal and, as scope, the narrowest existing workspace-relative directories that implementer must edit (within plan scope). Split the work so packets change different files where possible; the branches are merged afterwards and any conflicts go to an integration step.`;
  }
  /** Work packets must give every branch writer exactly one scope inside both the plan and the node's declared scopes. */
  private packetProblems(plan: Plan): string[] {
    const writers = branchLayout(this.snapshot.configuration.flow).branchWriters, packets = plan.workPackets ?? [], problems: string[] = [];
    const within = (child: string, parent: string) => parent === '.' || child === parent || child.startsWith(`${parent.replace(/\/$/, '')}/`);
    if (!writers.length) return packets.length ? ['Flow không có bước ghi song song nhưng kế hoạch có work packets'] : [];
    for (const writer of writers) {
      const matching = packets.filter(packet => packet.nodeId === writer.id);
      if (matching.length !== 1) { problems.push(`Cần đúng một work packet cho ${writer.id}`); continue; }
      for (const scope of matching[0]!.scope) if (!plan.scope.some(allowed => within(scope, allowed)) || !writer.writeScopes.some(allowed => within(scope, allowed))) problems.push(`${writer.id}: phạm vi ${scope} nằm ngoài kế hoạch hoặc phạm vi của bước`);
    }
    for (const packet of packets) if (!writers.some(writer => writer.id === packet.nodeId)) problems.push(`Work packet cho bước không tồn tại: ${packet.nodeId}`);
    return problems;
  }
  async approve(actor = 'local-user', source: 'ui' | 'cli' | 'session' = 'ui', expectedPlanHash?: string) {
    if (this.busy || !['waiting_approval', 'recovering'].includes(this.state.phase)) throw new Error('Run không chờ duyệt kế hoạch');
    await this.policy();
    await this.durable.service.continueAfterRecovery();
    const report = await this.durable.service.report();
    const approval = this.snapshot.configuration.flow.definition.nodes.find(node => node.type === 'approval' && report.graph.nodes[node.id]?.status === 'ready');
    const planning = approval && this.snapshot.configuration.flow.definition.edges.find(edge => edge.to === approval.id && report.plans.some(plan => plan.nodeId === edge.from));
    if (!approval || !planning) throw new Error('Không tìm thấy kế hoạch cần duyệt');
    const plan = report.plans.find(item => item.nodeId === planning.from)!.plan;
    if (expectedPlanHash !== undefined && hashJson(plan) !== expectedPlanHash) throw new Error('Kế hoạch đã thay đổi; cần đọc lại trước khi duyệt');
    const problem = await this.planProblem(plan);
    if (problem) throw new Error(problem);
    await this.durable.service.approveProposedPlan(approval.id, planning.from, actor, source);
    await this.checkpoint('paused', 'Đã duyệt kế hoạch');
    this.launch();
  }
  /** Why a proposed plan cannot be approved as it is (checks, scopes, work packets, workspace), or undefined. */
  private async planProblem(plan: Plan): Promise<string | undefined> {
    try { for (const command of plan.checks) parseCheck(command); } catch (error) { return error instanceof Error ? error.message : String(error); }
    const notDirectories: string[] = [];
    for (const scope of [...plan.scope, ...(plan.workPackets ?? []).flatMap(packet => packet.scope)]) {
      const target = path.resolve(this.context.workspace, scope), relative = path.relative(this.context.workspace, target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(target).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false))) notDirectories.push(scope);
    }
    if (notDirectories.length) return `Phạm vi kế hoạch phải là thư mục có sẵn trong repo (dùng "." cho thư mục gốc), không phải file: ${[...new Set(notDirectories)].join(', ')}. Hãy yêu cầu sửa kế hoạch.`;
    const packetProblems = this.packetProblems(plan);
    if (packetProblems.length) return `Kế hoạch chưa chia việc hợp lệ cho các nhánh: ${packetProblems.join('; ')}. Hãy yêu cầu sửa kế hoạch.`;
    if ((await captureBaseline(this.context.workspace)).baselineHash !== this.context.initialBaselineHash) return 'Workspace đã thay đổi từ khi khảo sát; cần xem lại kế hoạch';
    return undefined;
  }
  /** An automatic approval node: NeoMind approves the plan itself; a plan it cannot approve waits for the user instead. */
  private async autoApprove(node: Extract<FlowNode, { type: 'approval' }>, report: RecoveryReport): Promise<boolean> {
    const planning = this.snapshot.configuration.flow.definition.edges.find(edge => edge.to === node.id && report.plans.some(plan => plan.nodeId === edge.from));
    const plan = planning && report.plans.find(item => item.nodeId === planning.from)!.plan;
    const problem = plan ? await this.planProblem(plan) : 'Không có kế hoạch để tự duyệt';
    if (problem || !planning) { await this.checkpoint('waiting_approval', `Không tự duyệt được kế hoạch: ${problem}`); return false; }
    await this.durable.service.approveProposedPlan(node.id, planning.from, 'neomind', 'flow');
    return true;
  }
  async revisePlan(feedback: string, expectedPlanHash: string) {
    if (this.busy || !['waiting_approval', 'recovering'].includes(this.state.phase)) throw new Error('Run không chờ sửa kế hoạch');
    const report = await this.durable.service.report(), proposal = report.plans.at(-1);
    if (!proposal) throw new Error('Không có kế hoạch để sửa');
    await this.durable.service.continueAfterRecovery();
    await this.durable.service.requestPlanRevision(proposal.nodeId, feedback, expectedPlanHash);
    await this.checkpoint('paused', 'Đã yêu cầu sửa kế hoạch'); this.launch();
  }
  async retryGit() {
    if (this.busy || this.state.phase !== 'blocked') throw new Error('Run không chờ xử lý Git');
    const report = await this.durable.service.report(), commit = report.commits.find(item => !item.confirmed);
    if (!commit || report.unresolvedAttemptIds.length || report.unresolvedCheckIds.length) throw new Error('Cần đối chiếu worker trước khi thử commit');
    await this.policy();
    await this.durable.service.authorizeCommitRetry(new GitCommitDispatch(this.durable.journal), commit.nodeId, this.context.workspace, this.context.lease, this.coordinator);
    await this.durable.service.continueAfterRecovery();
    await this.checkpoint('paused', 'Người dùng yêu cầu thử commit lại'); this.launch();
  }
  async extendTime(seconds: number) {
    if (this.busy) throw new Error('Tạm dừng run trước khi đổi ngân sách thời gian');
    await this.durable.service.extendRuntimeTime(seconds);
    this.extraTimeMs = (await this.durable.service.report()).timeExtensionsMs;
    await this.resume();
  }
  launch(): void {
    if (this.closed || this.operation) throw new Error('Run is already active or closed');
    if (['completed', 'cancelled', 'recovering'].includes(this.state.phase)) throw new Error('Run requires an explicit resumable state');
    this.stopIntent = undefined; this.branchFailure = undefined;
    const operation = this.drive(); this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; }).catch(() => {});
  }
  async settled() { await this.operation; }
  async resume() {
    if (this.busy || ['completed', 'cancelled', 'waiting_approval'].includes(this.state.phase)) throw new Error('Run không thể tiếp tục ở trạng thái này');
    if (this.state.activeMs >= this.snapshot.configuration.flow.definition.limits.activeTimeSeconds * 1000 + this.extraTimeMs) throw new Error('Hết ngân sách thời gian; thêm thời gian trước khi tiếp tục');
    await this.reconcile(); await this.policy();
    let report = await this.durable.service.report();
    const continuationHash = report.approvals.length ? await this.durable.service.authorizeWorkspaceContinuation() : undefined;
    await this.durable.service.continueAfterRecovery();
    if (continuationHash) {
      // Only results in the run workspace move with its continuation; branch worktrees keep their own baselines.
      const completed = new Map(report.attempts.filter(item => item.status === 'completed' && item.baselineHash && item.workspace === this.context.workspace).map(item => [item.nodeId, item]));
      for (const attempt of completed.values()) if (report.graph.nodes[attempt.nodeId]?.status === 'succeeded' && attempt.baselineHash !== continuationHash) await this.durable.service.updateProducerBaseline(attempt.attemptId, continuationHash);
      report = await this.durable.service.report();
    }
    for (const branch of report.branchWorkspaces) if (branch.fence !== undefined && report.graph.nodes[branch.nodeId]?.status !== 'succeeded') await this.durable.service.authorizeBranchContinuation(branch.nodeId);
    for (const node of this.snapshot.configuration.flow.definition.nodes) if (node.type === 'review_group' &&
      report.reviewerOutputs.some(item => item.nodeId === node.id) && !report.acceptedReviews.some(item => item.nodeId === node.id)) {
      await this.noteValidationProblems(node, report);
      await this.durable.service.recordArtifact({ nodeId: node.id, kind: 'agent', text: JSON.stringify(report.reviewerOutputs.filter(item => item.nodeId === node.id)).slice(0, 100000) });
      await this.durable.service.retryReview(node.id);
    }
    for (const [id, node] of Object.entries((await this.durable.service.report()).graph.nodes)) if (node.status === 'running') {
      const current = await this.durable.service.report(), latest = [...current.attempts].reverse().find(item => item.nodeId === id);
      const conflicted = !!current.integrations.find(item => item.nodeId === id)?.conflicts.length;
      // A merge with conflicts is only a result once the integration agent has completed a turn.
      const durableResult = current.plans.some(item => item.nodeId === id) || current.acceptedReviews.some(item => item.nodeId === id) || current.commits.some(item => item.nodeId === id && item.confirmed) || latest?.status === 'completed' && !!latest.baselineHash && !(latest.core && conflicted);
      if (durableResult) await this.durable.service.finalizePersisted(id); else await this.durable.service.requeueStoppedNode(id);
    }
    await this.checkpoint('paused', 'Tiếp tục theo yêu cầu người dùng'); this.launch();
  }
  async stop(intent: Stop) {
    if (['completed', 'cancelled'].includes(this.state.phase)) return;
    this.stopIntent = intent;
    this.gitAbort?.abort();
    const checkpoint = this.checkpoint('stopping', intent === 'cancel' ? 'Đang hủy run' : intent === 'deadline' ? 'Đã hết thời gian xử lý tự động' : 'Đang tạm dừng');
    const stopped = await this.stopWorkers();
    await checkpoint;
    if (!stopped) {
      this.coordinator.quarantine(this.context.lease); await this.checkpoint('blocked', 'Chưa xác nhận worker đã dừng; workspace bị giữ'); return;
    }
    await this.operation;
    if (!this.operation) {
      try { await this.reconcile(); }
      catch (error) { await this.checkpoint('blocked', error instanceof Error ? error.message : String(error)); return; }
      await this.checkpoint(intent === 'cancel' ? 'cancelled' : 'paused', intent === 'cancel' ? 'Đã hủy; giữ code và artifacts' : 'Đã tạm dừng');
    }
  }
  private async reconcile() {
    const report = await this.durable.service.report();
    for (const attempt of report.attempts.filter(item => item.status === 'unresolved')) await this.durable.service.reconcileScopedAttempt(attempt.attemptId);
    const context = { workspace: this.context.workspace, lease: this.context.lease, coordinator: this.coordinator };
    for (const check of report.checks.filter(item => item.status === 'unresolved')) {
      // Reconciliation stops the recorded scope and never reruns the command.
      const dispatcher = new CodexCheckDispatch(this.durable.journal, new CodexCheckExecutor({ request: async () => { throw new Error('No dispatch during recovery'); } }));
      await this.durable.service.reconcileCheckStop(dispatcher, check.checkId, context);
    }
    for (const commit of report.commits.filter(item => !item.confirmed)) {
      const outcome = await this.durable.service.reconcileCommit(new GitCommitDispatch(this.durable.journal), commit.nodeId, this.context.workspace, this.context.lease, this.coordinator);
      if (outcome.state !== 'applied') throw new Error('Commit chưa rõ kết quả; cần xử lý Git trước khi tiếp tục');
    }
    for (const nodeId of report.unresolvedIntegrationNodeIds) await this.durable.service.reconcileIntegration(new IntegrationDispatch(this.durable.journal), nodeId, this.coordinator, this.context.lease);
    const held = this.coordinator.getWriter(this.context.workspace);
    if (held?.quarantined) this.coordinator.clearQuarantine(this.context.lease, true);
    // Branch worktrees are fenced like the run workspace; their workers were just proven stopped.
    for (const branch of report.branchWorkspaces) {
      if (branch.fence === undefined || !branch.hostId) continue;
      const lease = { workspace: branch.workspace, runId: this.runId, hostId: branch.hostId, fence: branch.fence };
      if (this.coordinator.getWriter(branch.workspace)?.quarantined && this.coordinator.isCurrent(lease)) this.coordinator.clearQuarantine(lease, true);
    }
  }
  private async drive() {
    this.lastTick = Date.now();
    await this.checkpoint('running', 'Đang thực thi flow');
    this.timer = setInterval(() => {
      const now = Date.now(); this.state.activeMs += now - this.lastTick; this.lastTick = now;
      if (this.state.activeMs >= this.snapshot.configuration.flow.definition.limits.activeTimeSeconds * 1000 + this.extraTimeMs) void this.stop('deadline').catch(() => {});
      else void this.durable.service.checkpointRuntime(structuredClone(this.state)).catch(() => {});
    }, 1000);
    try {
      const flow = this.snapshot.configuration.flow, layout = branchLayout(flow);
      const concurrency = Math.min(flow.definition.limits.maxConcurrency, this.snapshot.policy.maxConcurrency);
      while (!this.stopIntent) {
        if (this.branchFailure) throw this.branchFailure;
        await this.policy();
        const report = await this.durable.service.report();
        // Agent steps inside fork branches run concurrently (each writer in its own worktree); every other step waits for them.
        const ready = flow.definition.nodes.filter(item => report.graph.nodes[item.id]?.status === 'ready' && !this.inflight.has(item.id));
        const parallel = ready.find(item => item.type === 'agent_task' && layout.insideBranch(item.id));
        if (parallel?.type === 'agent_task' && this.inflight.size < concurrency) {
          const task = this.agent(parallel, report).catch(error => { this.branchFailure ??= error instanceof Error ? error : new Error(String(error)); })
            .finally(() => { this.inflight.delete(parallel.id); });
          this.inflight.set(parallel.id, task); continue;
        }
        if (this.inflight.size) { await Promise.race(this.inflight.values()); continue; }
        if (flow.definition.nodes.filter(node => node.type === 'finish').some(node => report.graph.nodes[node.id]?.status === 'succeeded')) {
          try { await this.proposeRepairLessons(report); }
          catch (error) { await this.durable.service.recordArtifact({ nodeId: 'run', kind: 'summary', text: `Không tạo được lesson proposal: ${error instanceof Error ? error.message : String(error)}` }); }
          await this.durable.service.recordArtifact({ nodeId: 'run', kind: 'summary', text: `Completed: ${this.context.task}\nWorkspace: ${this.context.workspace}` });
          await this.checkpoint('completed', 'Flow đã hoàn tất'); await this.autoClean(); return;
        }
        const node = ready[0];
        if (!node) throw new Error('Flow không có bước sẵn sàng; cần kiểm tra các bước đang chờ');
        if (node.type === 'approval') {
          if (node.mode === 'auto' && this.snapshot.policy.allowAutoApproval !== false) { if (await this.autoApprove(node, report)) continue; return; }
          await this.checkpoint('waiting_approval', node.purpose); return;
        }
        if (['start', 'fork', 'join', 'repair_scope', 'finish'].includes(node.type)) await this.durable.service.completeControl(node.id);
        else if (node.type === 'condition') await this.durable.service.evaluateConditionNode(node.id);
        else if (node.type === 'agent_task') await this.agent(node, report);
        else if (node.type === 'review_group') { if (!await this.review(node, report)) return; }
        else if (node.type === 'git_commit') await this.commit(node, report);
        else if (node.type === 'integration') await this.integrate(node, report);
        else throw new Error(`Unsupported node type: ${node.type}`);
      }
      await this.settleBranches();
      if (this.branchFailure) throw this.branchFailure;
    } catch (error) {
      try {
        this.branchFailure ??= error instanceof Error ? error : new Error(String(error));
        const stopped = await this.stopWorkers();
        await this.settleBranches();
        if (!stopped) this.coordinator.quarantine(this.context.lease);
        await this.reconcile();
        await this.checkpoint(this.stopIntent === 'cancel' ? 'cancelled' : this.stopIntent ? 'paused' : 'blocked',
          this.stopIntent === 'cancel' ? 'Đã hủy; giữ code và artifacts' : this.stopIntent === 'deadline' ? 'Hết thời gian; chờ bạn tiếp tục' : this.stopIntent ? 'Đã tạm dừng' : error instanceof Error ? error.message : String(error));
      } catch (recoveryError) { await this.checkpoint('blocked', `Cần đối chiếu worker: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`); }
    } finally {
      if (this.timer) clearInterval(this.timer); this.timer = undefined;
      this.state.activeMs += Math.max(0, Date.now() - this.lastTick); this.lastTick = Date.now();
      await this.durable.service.checkpointRuntime(structuredClone(this.state));
      this.scopes.clear();
    }
  }
  private async agent(node: Extract<FlowNode, { type: 'agent_task' }>, report: RecoveryReport) {
    const attempt = randomUUID();
    if (!node.permissions.write) {
      const { runner, session, binding } = await this.session(node.id, node.sessionGroup);
      const dispatcher = new CodexReadOnlyDispatch(this.durable.journal, runner, session);
      const context = { workspace: this.context.workspace, lease: this.context.lease, coordinator: this.coordinator };
      const instruction = node.outputContract === 'plan' ? `Requested plan revision (if present, keep planId and use the specified version):\n${JSON.stringify(report.planRevisions.filter(item => item.planningNodeId === node.id).at(-1) ?? null)}\nReturn the required plan JSON. The plan describes the changes a later implementation step will make to accomplish the original user task; it does not describe this read-only survey. Its goal is the user's intended outcome, its approach lists the concrete edits, its acceptance criteria are verifiable properties of the finished change, and its checks verify that change (prefer the project's own test or build command). Do not put this step's read-only restriction into the plan.${this.packetInstruction()} Scope entries (in the plan and in work packets) must be existing workspace-relative directories, never files; use "." for the repository root. Each checks entry is one complete command line such as "npm test"; never split one command into several entries. Checks must be simple argv commands (no pipes, redirects or shell operators).${process.platform === 'win32' ? ' Checks run on Windows without a shell: use real programs such as npm, node, git or python, not POSIX shell builtins such as test or ls.' : ''}`
        : `Your current directory is the project workspace: inspect its files with your tools before answering. ${report.repairRounds.length ? `Address these review findings on your previous report:\n${JSON.stringify(report.artifacts.filter(item => item.kind === 'agent' && item.nodeId !== node.id).slice(-1))}\n` : ''}Produce a report that answers the original task, with concrete references to local project sources. Cite sources as workspace-relative paths with line numbers (for example src/cli/main.ts:39), never as absolute paths. This executor has no web or external connector access. Do not assert facts you cannot verify locally.`;
      const prompt = `${this.prompt(node.id, node.goal)}\nRead-only task; do not edit files. ${instruction}`;
      const writer = this.transcript(runner, session, { attemptId: attempt, nodeId: node.id, key: node.id, role: node.outputContract === 'plan' ? 'plan' : 'read' }, prompt);
      const { result } = await this.traced(writer, () => this.durable.service.dispatchReadOnly(dispatcher, node.id, session.sessionId, prompt, binding.reasoning, attempt, randomUUID(), runner.scope, context),
        turn => runner.waitForTurn(session, turn, () => !!this.stopIntent || !!this.branchFailure));
      await this.durable.service.recordUsage(attempt, result);
      if (!await runner.close()) throw new Error('Planning worker stop unconfirmed');
      if (node.outputContract === 'plan') await this.durable.service.recordReadOnlyPlan(dispatcher, attempt, result);
      else await this.durable.service.recordReadOnlyResult(dispatcher, attempt, result, context);
      this.release(runner.scope); return;
    }
    if (!branchLayout(this.snapshot.configuration.flow).branchWriters.some(writer => writer.id === node.id)) {
      await this.writeTurn(node.id, node.sessionGroup, node.goal, report, {}, ''); return;
    }
    const packet = report.approvals.at(-1)?.plan.workPackets?.find(item => item.nodeId === node.id);
    if (!packet) throw new Error(`Thiếu work packet cho ${node.id}`);
    const lease = await this.durable.service.prepareBranchWorkspace(new IntegrationDispatch(this.durable.journal), node.id, this.coordinator, this.context.lease.hostId);
    await this.writeTurn(node.id, node.sessionGroup, node.goal, report, { lease, scope: packet.scope },
      `\nYour work packet. Other implementers carry out the rest of the plan in parallel, each in their own copy of the repository; edit only inside your packet scope:\n${JSON.stringify(packet)}`);
  }
  /** One write turn by a writer or integration agent in the target workspace (the run workspace by default). */
  private async writeTurn(nodeId: string, sessionGroup: string, goal: string, report: RecoveryReport,
    target: { lease?: WorkspaceLease; scope?: string[]; integration?: string }, extra: string) {
    const attempt = randomUUID(), branch = !!target.lease && target.lease.workspace !== this.context.workspace;
    const admission = await this.admission(report, this.binding(report, nodeId).runner, target), grant = await admitIsolatedWorkspaceWrite(admission);
    const { runner, session, binding } = await this.session(nodeId, sessionGroup, { kind: 'write', writableRoots: grant.writableRoots }, grant.workspace);
    const dispatcher = new CodexWriteDispatch(this.durable.journal, runner, session);
    // Branch writers never repair, and sibling branches' output is not theirs to read.
    const findings = branch ? '' : `\nRepair findings (if any):\n${JSON.stringify(report.artifacts.filter(item => item.kind === 'agent').slice(-3))}`;
    const prompt = `${this.prompt(nodeId, goal)}\nApproved plan:\n${JSON.stringify(admission.plan)}${extra}${findings}\nDo not commit, push, create PRs, launch agents or change files outside approved scope.`;
    const writer = this.transcript(runner, session, { attemptId: attempt, nodeId, key: nodeId, role: 'write' }, prompt);
    const { turn, result } = await this.traced(writer, () => this.durable.service.dispatchWrite(dispatcher, nodeId, session.sessionId, prompt, binding.reasoning, attempt, randomUUID(), admission, runner.scope),
      turn => runner.waitForTurn(session, turn, () => !!this.stopIntent || !!this.branchFailure));
    await this.durable.service.recordUsage(attempt, result);
    // Recording the terminal stops the runner's scope and proves it stopped before the result is accepted.
    await this.durable.service.recordWriteTerminal(dispatcher, attempt, session.sessionId, turn, 'completed', admission, runner.scope);
    await this.durable.service.recordArtifact({ nodeId, kind: 'agent', text: result.messages.join('\n').slice(0, 100000) });
    this.release(runner.scope);
  }
  /** Merge branch results into the run workspace; the integration agent runs only for conflicts or a repair round. */
  private async integrate(node: Extract<FlowNode, { type: 'integration' }>, report: RecoveryReport) {
    const dispatcher = new IntegrationDispatch(this.durable.journal);
    if (!report.integrations.find(item => item.nodeId === node.id)?.baselineHash) {
      const { conflicts } = await this.durable.service.integrate(dispatcher, node.id, this.coordinator, this.context.lease);
      await this.durable.service.recordArtifact({ nodeId: node.id, kind: 'summary', text: conflicts.length ? `Gộp các nhánh còn conflict ở: ${conflicts.join(', ')}` : 'Đã gộp các nhánh, không có conflict' });
      if (!conflicts.length) return;
      report = await this.durable.service.report();
    }
    if (!node.sessionGroup) throw new Error(`${node.id}: cần agent tích hợp để xử lý conflict hoặc repair`);
    const integration = report.integrations.find(item => item.nodeId === node.id)!;
    const remaining = await filesWithConflictMarkers(this.context.workspace, integration.conflicts);
    const packets = `\nWork packets implemented in parallel and merged into this workspace:\n${JSON.stringify(report.approvals.at(-1)?.plan.workPackets ?? [])}`;
    const conflictText = remaining.length ? `\nGit could not merge these files automatically; they contain conflict markers (<<<<<<<, =======, >>>>>>>): ${JSON.stringify(remaining)}. Resolve every conflict so the result satisfies the approved plan and every work packet, and remove all markers. Do not change unrelated files.` : '';
    await this.writeTurn(node.id, node.sessionGroup, remaining.length ? 'Resolve the merge conflicts left by integrating parallel branches' : 'Repair the integrated result according to the review findings',
      report, { integration: integration.baselineHash! }, packets + conflictText);
    await this.durable.service.completeIntegration(dispatcher, node.id);
  }
  private async review(node: Extract<FlowNode, { type: 'review_group' }>, report: RecoveryReport): Promise<boolean> {
    const producer = [...report.attempts].reverse().find(item => item.nodeId === node.targetNodeId && item.status === 'completed' && item.baselineHash);
    if (!producer?.baselineHash) throw new Error('Không có baseline thực hiện để review');
    const baselineHash = producer.baselineHash, context = { workspace: this.context.workspace, lease: this.context.lease, coordinator: this.coordinator };
    const plan = report.approvals.at(-1)?.plan;
    for (const command of plan?.checks ?? []) {
      if ((await this.durable.service.report()).checks.some(check => check.command === command && check.baselineHash === baselineHash && check.status === 'passed')) continue;
      const worker = await this.newCheckWorker(), dispatcher = new CodexCheckDispatch(this.durable.journal, new CodexCheckExecutor(worker.scope.transport));
      const result = await this.durable.service.runCheck(dispatcher, { id: randomUUID(), command: parseCheck(command), cwd: this.context.workspace, timeoutMs: 120000 }, baselineHash, context, randomUUID(), worker.scope);
      await this.durable.service.recordArtifact({ nodeId: node.id, kind: 'check', text: `${command}\nexit ${result.exitCode}\n${result.stdout}\n${result.stderr}`.slice(0, 100000) });
      this.release(worker.scope);

    }
    // Reviewers get the core's diff of the run's changes, so a reviewer without a shell (Claude Code) can judge regressions.
    const diff = await reviewDiff(this.context.workspace, baselineHash, this.context.imported?.tree ?? this.context.sourceHead);
    const changes = diff === undefined ? '\nChanges under review: the diff is too large to include; inspect the changed source directly.\n'
      : diff ? `\nChanges under review (git diff from the run's starting point to the reviewed workspace, computed by NeoMind; authoritative for what changed):\n${diff}\n` : '';
    let lastDispatcher: CodexReviewDispatch | undefined;
    const runReviewer = async (reviewer: typeof node.reviewers[number]) => {
      if ((await this.durable.service.report()).reviewerOutputs.some(item => item.nodeId === node.id && item.result.reviewerId === reviewer.id)) return;
      const key = `${node.id}/${reviewer.id}`, { runner, session, binding } = await this.session(key, reviewer.sessionGroup);
      const dispatcher = new CodexReviewDispatch(this.durable.journal, runner, session); lastDispatcher = dispatcher;
      const current = await this.durable.service.report(), criteria = [...new Set([...node.criteria, ...(plan?.acceptanceCriteria ?? [])])];
      const artifacts = current.artifacts.filter(item => item.nodeId === node.targetNodeId && item.baselineHash === baselineHash && item.attemptId === producer.attemptId);
      const target = this.snapshot.configuration.flow.definition.nodes.find(item => item.id === node.targetNodeId);
      const research = target?.type === 'agent_task' && !target.permissions.write ? artifacts.map(item => ({ nodeId: item.nodeId, sha256: createHash('sha256').update(item.text).digest('hex'), text: item.text })) : [];
      const prompt = `${this.prompt(key, 'Independently review the task and approved changes.')}\nApproved plan:\n${JSON.stringify(plan)}\nRequired criteria (use exact strings):\n${JSON.stringify(criteria)}\nCheck receipts:\n${JSON.stringify(current.checks.filter(check => check.baselineHash === baselineHash && check.outputHash).map(check => ({ receiptId: checkReceiptId(check.outputHash!), command: check.command, status: check.status })))}\nRead-only research artifacts (if any):\n${JSON.stringify(research)}\n${changes}${research.length ? 'A research artifact passes only if it actually answers the original task; one that does not answer it, or whose claims the cited sources do not support, fails the relevant criterion with a finding. ' : ''}Inspect the source and the changes independently. Return verdict, findingIds, summary and evidence. Each criterion needs a status and references. A source reference uses workspace-relative path, 1-based line and an exact quote starting at that line. A check reference uses kind check with the command and receiptId copied EXACTLY from one of the supplied core receipts. NEVER invent receipts or cite commands you ran yourself; cite source instead for those inspections. An artifact reference uses kind artifact, nodeId, sha256 from the artifact above and an exact quote from its text. Generic criteria such as approved plan or regressions can cite source and the supplied receipts. Findings need id, criterion, explanation and references; a finding belongs only to a criterion with status fail, and every finding id is listed in findingIds. Observations about passing criteria go in the summary, not in findings. Do not claim pass when evidence is missing. Do not edit files.${this.retryFeedback(key)}`;
      const attempt = randomUUID(), writer = this.transcript(runner, session, { attemptId: attempt, nodeId: node.id, key, role: 'review', reviewerId: reviewer.id }, prompt);
      const { result } = await this.traced(writer, () => this.durable.service.dispatchReview(dispatcher, node.id, reviewer.id, session.sessionId, prompt, binding.reasoning, attempt, randomUUID(), baselineHash, context, runner.scope),
        turn => runner.waitForTurn(session, turn, () => !!this.stopIntent || !!this.branchFailure));
      await this.durable.service.recordUsage(attempt, result);
      if (!await runner.close()) throw new Error('Reviewer worker stop unconfirmed');
      await this.durable.service.recordReview(dispatcher, node.id, reviewer.id, baselineHash, attempt, result, context);
      this.release(runner.scope);
    };
    const concurrency = Math.min(this.snapshot.configuration.flow.definition.limits.maxConcurrency, this.snapshot.policy.maxConcurrency);
    // After a repair, reviewers whose scope the repair did not touch keep their pass through a journaled impact receipt.
    const pending = new Set(await this.durable.service.carryUnaffectedReviews(node.id, baselineHash)), toRun = node.reviewers.filter(reviewer => pending.has(reviewer.id));
    for (let index = 0; index < toRun.length; index += concurrency) {
      const results = await Promise.allSettled(toRun.slice(index, index + concurrency).map(runReviewer));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
    lastDispatcher ??= new CodexReviewDispatch(this.durable.journal);
    const decision = await this.durable.service.finishReview(lastDispatcher, node.id, producer.sessionId, baselineHash, {}, context);
    if (decision.decision === 'pass') return true;
    if (decision.decision === 'waiting') {
      const current = await this.durable.service.report();
      const invalid = node.reviewers.filter(reviewer => decision.reasons.includes(`${reviewer.id}: evidence or criteria not verified`)).map(reviewer => reviewer.id);
      if (invalid.length && !current.reviewValidationRetries.some(item => item.nodeId === node.id && item.round === current.repairRounds.length)) {
        const feedback = await this.noteValidationProblems(node, current, invalid);
        await this.durable.service.recordArtifact({ nodeId: node.id, kind: 'agent', text: `Review evidence validation failed. Required receipts must be copied exactly. Problems: ${JSON.stringify(feedback)} ${JSON.stringify(current.reviewerOutputs.filter(item => invalid.includes(item.result.reviewerId)))}`.slice(0, 100000) });
        await this.durable.service.retryReview(node.id, 'validation', invalid);
        return this.review(node, await this.durable.service.report());
      }
      await this.checkpoint('blocked', decision.reasons.join('; ')); return false;
    }
    const scope = this.snapshot.configuration.flow.definition.nodes.find(item => item.type === 'repair_scope' && item.targetReviewId === node.id);
    if (!scope) throw new Error('Review yêu cầu sửa nhưng flow chưa khai báo repair scope');
    const findings = (await this.durable.service.report()).reviewerOutputs.filter(item => item.nodeId === node.id);
    await this.durable.service.recordArtifact({ nodeId: node.id, kind: 'agent', text: JSON.stringify(findings).slice(0, 100000) });
    await this.durable.service.beginRepair(scope.id, baselineHash, decision.findingIds, (await buildReviewTree(this.context.workspace, baselineHash)).tree); return true;
  }
  private async commit(node: Extract<FlowNode, { type: 'git_commit' }>, report: RecoveryReport) {
    const review = report.acceptedReviews.at(-1);
    if (!review) throw new Error('Commit cần review đã đạt');
    const tree = await buildReviewTree(this.context.workspace, review.baselineHash);
    // Imported uncommitted changes stay out of the commit unless the user chose to include them.
    let committed = tree.tree;
    const imported = this.context.imported;
    if (imported && !report.includeImportedCommitNodeIds.includes(node.id)) {
      const own = await runOnlyTree(this.context.workspace, tree.head, imported.tree, tree.tree);
      if (!own) throw new Error(`${importOverlapMarker}: thay đổi của run chồng lên thay đổi chưa commit có sẵn và không tách riêng được. Chọn "Commit kèm thay đổi có sẵn" hoặc tự xử lý trong worktree ${this.context.workspace}.`);
      if (own === await treeOf(this.context.workspace, tree.head)) throw new Error('Run không có thay đổi riêng ngoài thay đổi chưa commit có sẵn; không có gì để commit');
      committed = own;
    }
    if (this.stopIntent) throw new Error('Run is stopping before Git commit');
    this.gitAbort = new AbortController();
    try { await this.durable.service.commit(new GitCommitDispatch(this.durable.journal), { nodeId: node.id, reviewNodeId: review.nodeId,
      workspace: this.context.workspace, lease: this.context.lease, coordinator: this.coordinator, livePolicy: await this.policy(), baselineHash: review.baselineHash,
      parent: tree.head, tree: committed, workspaceTree: tree.tree, message: this.context.task.split('\n')[0]!.slice(0, 200), requestId: randomUUID(), signal: this.gitAbort.signal }); }
    finally { this.gitAbort = undefined; }
  }
  /** User decision after an attribution overlap: commit the reviewed result together with the imported changes. */
  /**
   * Apply a finished run's changes to the project checkout. Only flows without a commit hand changes over this way
   * (the user reviews them outside the flow); the journal records the intent before the checkout is touched.
   */
  async applyToCheckout() {
    if (this.busy || this.state.phase !== 'completed') throw new Error('Chỉ áp dụng được khi run đã hoàn tất');
    if (this.snapshot.configuration.flow.definition.nodes.some(node => node.type === 'git_commit')) throw new Error('Flow này giao kết quả bằng commit; dùng commit của run');
    const report = await this.durable.service.report();
    if (report.checkoutApply?.applied) throw new Error('Thay đổi của run này đã được áp dụng vào checkout');
    if (report.workspaceCleanup) throw new Error('Worktree của run đã được dọn; không còn thay đổi để áp dụng');
    const changes = await runChanges(this.context.workspace, this.context.imported?.tree ?? this.context.sourceHead);
    if (!changes.paths.length) throw new Error('Run không có thay đổi để áp dụng');
    if (report.checkoutApply && report.checkoutApply.patchHash !== changes.patchHash) throw new Error('Worktree của run đã đổi so với lần áp dụng dở trước; xem lại trước khi áp');
    if (!report.checkoutApply) await this.durable.service.recordCheckoutApply('intent', { tree: changes.tree, paths: changes.paths, patchHash: changes.patchHash });
    await applyToCheckout(this.context.projectRoot, changes);
    await this.durable.service.recordCheckoutApply('applied', { patchHash: changes.patchHash });
    await this.autoClean();
  }
  /**
   * Paths whose changes exist only in the run's worktrees: not in a run commit, a NeoMind ref, the checkout (applied)
   * or the user's own imported changes. Removing the worktrees would lose them.
   */
  private async unsavedChanges(report: RecoveryReport): Promise<string[]> {
    const unsaved = new Set<string>(), commit = report.commits.filter(item => item.confirmed && item.commit).at(-1)?.commit;
    if (existsSync(this.context.workspace)) {
      const base = commit ?? (report.checkoutApply?.applied ? report.checkoutApply.tree : this.context.imported?.tree ?? this.context.sourceHead);
      // A commit leaves out the imported changes, which are still the user's own uncommitted work in the checkout.
      const imported = new Set(commit ? this.context.imported?.paths ?? [] : []);
      for (const file of (await runChanges(this.context.workspace, base)).paths) if (!imported.has(file)) unsaved.add(file);
    }
    for (const branch of report.branchWorkspaces) {
      if (!existsSync(branch.workspace) || await refExists(this.context.projectRoot, `refs/neomind/${this.runId}/${branch.nodeId}`)) continue;
      for (const file of (await runChanges(branch.workspace, branch.baseCommit)).paths) unsaved.add(`${branch.nodeId}: ${file}`);
    }
    return [...unsaved];
  }
  /**
   * Remove the worktrees of a finished run. Commits only the worktree's HEAD kept are first preserved under
   * `refs/neomind/<run>/delivery/<node>` (`git cherry-pick` keeps working); changes that exist nowhere else are refused
   * unless `force`. The journal holds the plan before anything is removed, so an interrupted cleanup resumes it.
   */
  async cleanWorkspaces(force = false) {
    if (this.busy) throw new Error('Run đang chạy; chỉ dọn được khi run đã dừng hẳn');
    return this.clean(force);
  }
  private async clean(force: boolean) {
    if (!['completed', 'cancelled'].includes(this.state.phase)) throw new Error('Chỉ dọn worktree của run đã hoàn tất hoặc đã hủy');
    let report = await this.durable.service.report();
    if (report.workspaceCleanup?.cleaned) return report.workspaceCleanup;
    const writer = (workspace: string) => { try { return this.coordinator.getWriter(workspace); } catch { return undefined; } };
    if (!report.workspaceCleanup) {
      const workspaces = [this.context.workspace, ...report.branchWorkspaces.map(item => item.workspace)];
      if (workspaces.some(workspace => writer(workspace)?.quarantined)) throw new Error('Worktree của run đang bị cách ly vì worker chưa xác nhận dừng; không dọn');
      const unsaved = await this.unsavedChanges(report);
      if (unsaved.length && !force) throw new Error(`Run còn thay đổi chưa áp dụng hoặc chưa commit: ${unsaved.slice(0, 10).join(', ')}${unsaved.length > 10 ? ` và ${unsaved.length - 10} file khác` : ''}. Dọn sẽ bỏ các thay đổi này.`);
      const refs = report.commits.filter(item => item.confirmed && item.commit).map(item => ({ ref: `refs/neomind/${this.runId}/delivery/${item.nodeId}`, commit: item.commit! }));
      await this.durable.service.recordWorkspaceCleanup('intent', { workspaces, refs, discarded: unsaved });
      report = await this.durable.service.report();
    }
    const plan = report.workspaceCleanup!, leases = plan.workspaces.map(writer).filter(item => item?.runId === this.runId && !item.quarantined);
    await preserveRefs(this.context.projectRoot, plan.refs);
    await removeWorktrees(this.context.projectRoot, plan.workspaces, path.dirname(this.context.workspace));
    for (const lease of leases) this.coordinator.release(lease!, true);
    await this.durable.service.recordWorkspaceCleanup('cleaned');
    return { ...plan, cleaned: true };
  }
  /** After delivery, remove the run's worktrees unless the project keeps them. Never discards changes and never fails the run. */
  private async autoClean() {
    try {
      if ((await readProject(this.context.projectRoot)).policy.keepRunWorktrees) return;
      const report = await this.durable.service.report();
      if (report.workspaceCleanup || (report.checkoutApply && !report.checkoutApply.applied) || (await this.unsavedChanges(report)).length) return;
      await this.clean(false);
    } catch (error) {
      await this.durable.service.recordArtifact({ nodeId: 'run', kind: 'summary', text: `Chưa tự dọn được worktree của run: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
    }
  }
  async includeImportedInCommit() {
    if (this.busy || this.state.phase !== 'blocked' || !this.state.reason.startsWith(importOverlapMarker)) throw new Error('Run không chờ quyết định về thay đổi có sẵn');
    const report = await this.durable.service.report();
    const node = this.snapshot.configuration.flow.definition.nodes.find(item => item.type === 'git_commit' && report.graph.nodes[item.id]?.status === 'ready');
    if (!node) throw new Error('Không có bước commit đang chờ');
    await this.durable.service.includeImportedInCommit(node.id);
    await this.resume();
  }
  private async proposeRepairLessons(report: RecoveryReport) {
    if (!report.repairRounds.length) return;
    const store = new LessonProposals(path.dirname(this.durable.journal.file)), events = await this.durable.journal.read();
    const findingIds = [...new Set(report.repairRounds.flatMap(round => round.findingIds))].slice(0, 5);
    for (const findingId of findingIds) {
      const proposalId = `lesson-${hashJson({ runId: this.runId, findingId }).slice(0, 24)}`;
      try { store.read(proposalId); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const event = events.find(event => event.type === 'reviewer_output' && JSON.stringify(event.payload).includes(JSON.stringify(findingId)));
      const body = `Review finding corrected in run ${this.runId}: ${findingId}\n\nOriginal review evidence:\n${JSON.stringify(event?.payload ?? {}).slice(0, 5000)}\n\nImplementation response:\n${report.artifacts.filter(item => item.kind === 'agent').at(-1)?.text.slice(0, 3000) ?? ''}\n\nThis is a proposed lesson from a completed repair. Review its applicability before sharing.`;
      store.create({ proposalId, runId: this.runId, createdAt: new Date().toISOString(), record: { id: proposalId, type: 'lesson', scope: this.snapshot.configuration.projectId,
        sources: [`run:${this.runId}`, ...(event ? [`run:${this.runId}/event:${event.sequence}`] : [])], tags: ['repair', 'review'], body } });
    }
  }
  async close() {
    if (this.closed) return;
    if (this.busy) await this.stop('pause');
    await this.durable.close(); this.closed = true;
  }
}
