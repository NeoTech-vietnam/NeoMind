import path from 'node:path';
import { z } from 'zod';
import { WorkspaceCoordinator } from '../storage/coordination.js';
import { RunStore } from '../storage/run-store.js';
import { SingleOwnerJournal } from '../storage/journal.js';
import { replayRun } from '../core/recovery.js';
import { LocalRun } from './local-run.js';
import { projectRuntimeRoot, snapshotProjectFlow, standaloneDiagnostics } from './project.js';
import { hashJson, type BindingOverride } from '../domain/resolve.js';
import { captureBaseline } from '../workspace/baseline.js';
import { memoryForRun, openProjectMemory } from './memory.js';
import { mkdir, lstat, open, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ProjectMemoryRegistry } from '../memory/registry.js';
import { resolveDefaultMemoryRoot } from '../memory/project-root.js';
import { primaryWorktree } from '../workspace/worktree.js';
import type { MemoryInput } from '../memory/store.js';
import { LessonProposals } from '../memory/proposals.js';
import type { Flow } from '../domain/schema.js';
import { bindingRunners, selectAvailableBinding } from './model-selection.js';
import { defaultRunnerRegistry, type RunnerRegistry } from '../runners/registry.js';
import { codexUnavailableReason } from '../runners/codex-runner.js';
import type { AvailableRunnerModel } from '../runners/agent-runner.js';
import type { MaterializedRun } from '../domain/materialize.js';
import { changedPaths, planDirtyImport } from '../workspace/dirty-import.js';
import { runChanges } from '../workspace/checkout-apply.js';
import { branchLayout } from '../domain/branches.js';
import { projectDir } from '../storage/project-dir.js';
import { listTranscripts, readTranscript, transcriptDirectory } from '../core/transcript.js';
import { runnerHistory, sessionTurnIndex } from './session-history.js';

/** Plain-language notes for flow exceptions the user should know before starting (Fast). */
export function flowExceptions(flow: Flow): string[] {
  const notes: string[] = [];
  if (flow.definition.nodes.some(node => node.type === 'approval' && node.mode === 'auto')) notes.push('Kế hoạch được NeoMind tự duyệt: agent bắt đầu sửa file ngay sau khi lập kế hoạch.');
  if (flow.definition.review === 'human') notes.push('Không có agent review và không commit: khi xong, bạn xem thay đổi rồi bấm "Áp dụng vào checkout".');
  return notes;
}

export class RunManager {
  private readonly runs = new Map<string, LocalRun>();
  private closing: Promise<{ runId: string; phase: string; reason: string }[]> | undefined;
  private constructor(readonly projectRoot: string, readonly stateRoot: string, private readonly store: RunStore, private readonly coordinator: WorkspaceCoordinator,
    private readonly runners: RunnerRegistry) {}
  static async open(projectRoot: string, stateBase?: string, runners: RunnerRegistry = defaultRunnerRegistry({ workspace: projectRoot })) {
    const root = await projectRuntimeRoot(projectRoot, stateBase);
    return new RunManager(projectRoot, root, await RunStore.open(path.join(root, 'runs')), new WorkspaceCoordinator(path.join(root, 'coordination.sqlite')), runners);
  }
  /** Which runners the bindings use and whether each can run here; checks always need Codex `command/exec`. */
  private runnerPreflight(snapshot: MaterializedRun) {
    const bindings = snapshot.configuration.bindings, checks = snapshot.configuration.flow.definition.nodes.some(node => node.type === 'review_group');
    const runners = bindingRunners(bindings).map(runner => ({ runner, supported: this.runners.has(runner),
      bindings: Object.entries(bindings).filter(([, binding]) => binding.values.runner === runner || binding.fallback.some(item => item.runner === runner)).map(([key]) => key) }));
    const codexUsed = runners.some(item => item.runner === 'codex'), missing = checks || codexUsed ? codexUnavailableReason() : undefined;
    const blockers = [...runners.filter(item => !item.supported).map(item => `Runner "${item.runner}" chưa được hỗ trợ (dùng bởi ${item.bindings.join(', ')})`),
      ...(missing && checks ? [`Check của flow chạy qua Codex command/exec nhưng Codex không khả dụng: ${missing}`] : []),
      ...(missing && codexUsed ? [`Runner codex không khả dụng: ${missing}`] : [])];
    return { runners, checks: { executor: 'codex' as const, required: checks, available: !missing, ...(missing ? { reason: missing } : {}) }, blockers };
  }
  async preview(flowId: string, version?: number, overrides: Record<string, BindingOverride> = {}, limits: Partial<Flow['definition']['limits']> = {}) {
    const snapshot = await snapshotProjectFlow(this.projectRoot, flowId, version, overrides, limits), baseline = await captureBaseline(this.projectRoot);
    const dirty = planDirtyImport(baseline), importBlockers = [...(dirty.refused.length ? [`Symlink không mang vào run được: ${dirty.refused.join(', ')}`] : []),
      ...(branchLayout(snapshot.configuration.flow).branchWriters.length ? ['Flow có bước ghi song song chưa hỗ trợ mang thay đổi chưa commit'] : [])];
    return { snapshot, runtimeDiagnostics: standaloneDiagnostics(snapshot.configuration.flow), runnerPreflight: this.runnerPreflight(snapshot), flowExceptions: flowExceptions(snapshot.configuration.flow), configurationHash: hashJson({ snapshot, sourceHead: baseline.head }), sourceHead: baseline.head, dirtyPaths: baseline.entries.map(entry => entry.path),
      // Confirming `baselineHash` copies exactly these changes into the run; they stay out of its commit.
      dirtyImport: { baselineHash: dirty.baselineHash, changes: dirty.changes, blockers: importBlockers },
      workspaceChoices: ['isolated'], gitDelivery: 'Local commit from the reviewed tree; configured Git hooks are not executed. Approved checks run before review.' };
  }
  /** Allowed models of each runner, discovered one runner at a time; a runner that cannot list models is reported, not fatal. */
  private async discoverModels(runners: readonly string[]) {
    const models: AvailableRunnerModel[] = [], failures: string[] = [];
    for (const runner of runners) {
      try { models.push(...await this.runners.get(runner).models()); }
      catch (error) { failures.push(`${runner}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { models, failures };
  }
  /** Allowed models of the given runners on this host. */
  async models(runners: readonly string[] = ['codex']): Promise<AvailableRunnerModel[]> {
    const { models, failures } = await this.discoverModels(runners);
    if (failures.length) throw new Error(failures.join('; '));
    return models;
  }
  async create(flowId: string, task: string, version?: number, overrides: Record<string, BindingOverride> = {}, configurationHash?: string, limits: Partial<Flow['definition']['limits']> = {}, importDirty?: string) {
    const snapshot = await snapshotProjectFlow(this.projectRoot, flowId, version, overrides, limits);
    const diagnostics = standaloneDiagnostics(snapshot.configuration.flow);
    if (diagnostics.length) throw new Error(diagnostics.join(' '));
    if (Object.values(snapshot.profilesByStep).some(profile => !profile.requestedPermissions.read)) throw new Error('Executor hiện cần quyền đọc trong mọi agent profile');
    const sourceHead = (await captureBaseline(this.projectRoot)).head;
    if (configurationHash !== undefined && hashJson({ snapshot, sourceHead }) !== configurationHash) throw new Error('Cấu hình hoặc HEAD đã thay đổi; xem lại trước khi bắt đầu');
    const { models, failures } = await this.discoverModels(bindingRunners(snapshot.configuration.bindings));
    const selections: { key: string; values: ReturnType<typeof selectAvailableBinding>['values'] }[] = [], selected = new Set<string>();
    for (const [key, binding] of Object.entries(snapshot.configuration.bindings)) {
      let selection; try { selection = selectAvailableBinding(binding, models); } catch (error) { throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}${failures.length ? ` (${failures.join('; ')})` : ''}`); }
      if (selection.fallback) selections.push({ key, values: selection.values });
      selected.add(selection.values.runner);
    }
    // Checks run through Codex `command/exec` whichever runner the agents use, so a flow with reviews needs Codex too.
    if (snapshot.configuration.flow.definition.nodes.some(node => node.type === 'review_group') && !selected.has('codex')) {
      try { await this.runners.get('codex').verifyCapabilities(); }
      catch (error) { throw new Error(`Check của flow chạy qua Codex command/exec nhưng Codex không khả dụng: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const runner of selected) await this.runners.get(runner).verifyCapabilities();
    const memory = memoryForRun(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'), task);
    const memoryText = memory?.records.map(record => `[${record.header.type}:${record.header.id} revision=${record.revision}]\nSources: ${record.header.sources.join(', ')}\n${record.body}`).join('\n\n').slice(0, 40000);
    const run = await LocalRun.create({ projectRoot: this.projectRoot, stateRoot: this.stateRoot, task, snapshot, coordinator: this.coordinator, runners: this.runners, expectedSourceHead: sourceHead, ...(importDirty ? { importDirty } : {}),
      ...(memory ? { memory: { root: memory.root, text: memoryText ?? '' } } : {}) });
    this.runs.set(run.runId, run);
    for (const selection of selections) await run.durable.service.selectAllowedFallback(selection.key, selection.values, 'Lựa chọn chính không khả dụng; dùng model trong danh sách thay thế đã cấu hình');
    run.launch(); return run.report();
  }
  async get(runId: string) { return this.withHandoff(await this.withDelivery(await this.report(runId))); }
  /**
   * A finished flow without a commit hands its changes to the user: list the files it changed in its worktree and
   * whether they were applied to the checkout.
   */
  private async withHandoff<T extends { runtimeState?: { phase: string } | undefined; runtimeContext?: { workspace: string; sourceHead: string; imported?: { tree: string } | undefined } | undefined;
    snapshot?: unknown; checkoutApply?: { applied: boolean; paths: string[] } | undefined; workspaceCleanup?: unknown }>(report: T) {
    const flow = (report.snapshot as MaterializedRun | undefined)?.configuration.flow, context = report.runtimeContext;
    if (!flow || !context || report.runtimeState?.phase !== 'completed' || flow.definition.nodes.some(node => node.type === 'git_commit')) return report;
    let files: string[] = report.checkoutApply?.paths ?? [];
    if (!report.workspaceCleanup) { try { files = (await runChanges(context.workspace, context.imported?.tree ?? context.sourceHead)).paths; } catch { /* the run worktree may have been removed */ } }
    return { ...report, handoff: { files, applied: report.checkoutApply?.applied ?? false } };
  }
  private readonly deliveredFiles = new Map<string, string[]>();
  /** Confirmed local commits with the paths each one changed, so a frontend can show what the run delivered. */
  private async withDelivery<T extends { commits: { nodeId: string; confirmed: boolean; commit?: string; expectedParent: string; workspace?: string }[] }>(report: T) {
    const delivery: { nodeId: string; commit: string; parent: string; files: string[] }[] = [];
    for (const item of report.commits) {
      if (!item.confirmed || !item.commit) continue;
      let files = this.deliveredFiles.get(item.commit);
      // Run worktrees share the project's object store, so the commit is readable after its worktree was removed.
      if (!files) { try { files = await changedPaths(this.projectRoot, item.expectedParent, item.commit); this.deliveredFiles.set(item.commit, files); } catch { /* the commit is no longer reachable */ } }
      delivery.push({ nodeId: item.nodeId, commit: item.commit, parent: item.expectedParent, files: files ?? [] });
    }
    return { ...report, delivery };
  }
  private async report(runId: string) {
    const active = this.runs.get(runId); if (active) return active.report();
    const events = await new SingleOwnerJournal(await this.store.journal(runId), runId).read(), report = replayRun(events);
    const snapshot = z.object({ snapshot: z.json().optional() }).parse(events[0]?.payload).snapshot;
    const plan = report.plans.at(-1)?.plan;
    const state = report.runtimeState;
    return { runId, ...report, ...(state && ['running', 'stopping'].includes(state.phase) ? { runtimeState: { ...state, phase: 'recovering' as const, reason: 'Run chưa có tiến trình điều phối trong phiên này; bấm Tiếp tục để đối chiếu' } } : {}), ...(plan ? { proposedPlanHash: hashJson(plan) } : {}), snapshot, busy: false, userContinueRequired: true };
  }
  private async transcriptDirectory(runId: string) { return transcriptDirectory(path.dirname(await this.store.journal(runId))); }
  /** Agent attempts of a run: those NeoMind recorded a transcript for, and older ones only the runner's history can show. */
  async transcripts(runId: string) {
    const report = await this.report(runId), recorded = listTranscripts(await this.transcriptDirectory(runId));
    const attempts = new Map(report.attempts.map(item => [item.attemptId, item])), known = new Set(recorded.map(item => item.meta.attemptId));
    return {
      transcripts: recorded.map(item => ({ ...item, attemptStatus: attempts.get(item.meta.attemptId)?.status ?? null })),
      history: report.attempts.filter(item => !item.core && !known.has(item.attemptId)).map(item => ({ attemptId: item.attemptId, nodeId: item.nodeId,
        key: item.reviewerId ? `${item.nodeId}/${item.reviewerId}` : item.nodeId, sessionId: item.sessionId, attemptStatus: item.status, ...(item.runnerTurnId ? { runnerTurnId: item.runnerTurnId } : {}) })),
    };
  }
  /**
   * One attempt's activity: NeoMind's transcript from sequence number `after`, or (`source: 'runner'`) the same turn read back
   * from the runner's own session history.
   */
  async transcript(runId: string, attemptId: string, after = 0, source: 'neomind' | 'runner' = 'neomind') {
    const directory = await this.transcriptDirectory(runId);
    if (source === 'neomind') {
      const events = readTranscript(directory, attemptId, after);
      return { source, recorded: !!events, events: events ?? [] };
    }
    const report = await this.report(runId), attempt = report.attempts.find(item => item.attemptId === attemptId), recorded = readTranscript(directory, attemptId) ?? [];
    const meta = recorded.find(event => event.kind === 'meta')?.meta;
    if (!attempt && !meta) throw new Error('Attempt not found');
    const sessionId = meta?.sessionId ?? attempt!.sessionId, runnerTurnId = attempt?.runnerTurnId ?? recorded.find(event => event.kind === 'turn')?.turnId;
    const prompt = recorded.find(event => event.kind === 'prompt' && !event.truncated)?.text, workspace = meta?.workspace ?? attempt?.workspace ?? report.runtimeContext?.workspace;
    const turnIndex = sessionTurnIndex(report.attempts, attemptId);
    const history = await runnerHistory({ sessionId, ...(runnerTurnId ? { runnerTurnId } : {}), ...(prompt ? { prompt } : {}), ...(workspace ? { workspace } : {}),
      ...(turnIndex !== undefined ? { turnIndex } : {}) }, meta?.runner);
    return { source, recorded: true, ...history, events: history.events.filter(event => (event.i ?? 0) >= after) };
  }
  async list() { return Promise.all((await this.store.list()).map(async id => {
    try {
      const run = await this.report(id);
      return { runId: id, task: run.runtimeContext?.task, flowName: run.snapshot ? (run.snapshot as MaterializedRun).configuration.flow.name : undefined, phase: run.runtimeState?.phase ?? 'recovering', reason: run.runtimeState?.reason ?? '', activeMs: run.runtimeState?.activeMs ?? 0 };
    } catch (error) { return { runId: id, task: id, phase: 'blocked', reason: error instanceof Error ? error.message : String(error), activeMs: 0 }; }
  })); }
  private async owned(id: string) {
    let run = this.runs.get(id);
    if (!run) { run = await LocalRun.recover(this.store, this.coordinator, id, undefined, undefined, this.runners); this.runs.set(id, run); }
    return run;
  }
  async action(id: string, action: 'approve' | 'resume' | 'pause' | 'cancel' | 'retry_git' | 'include_imported' | 'apply', source: 'ui' | 'cli' | 'session' = 'ui', planHash?: string, actor = 'local-user') {
    const run = await this.owned(id);
    if (action === 'approve') await run.approve(actor, source, planHash);
    else if (action === 'resume') await run.resume();
    else if (action === 'retry_git') await run.retryGit();
    else if (action === 'include_imported') await run.includeImportedInCommit();
    else if (action === 'apply') await run.applyToCheckout();
    else await run.stop(action === 'cancel' ? 'cancel' : 'pause');
    return run.report();
  }
  /** Remove a finished run's worktrees; refuses changes that exist nowhere else unless `force`. */
  async clean(id: string, force = false) { const run = await this.owned(id); await run.cleanWorkspaces(force); return this.get(id); }
  /**
   * Remove the worktrees of every finished run. Runs with unsaved changes are kept unless `force`; a run another process
   * owns is reported, not touched.
   */
  async cleanFinished(force = false) {
    const results: { runId: string; status: 'cleaned' | 'kept'; reason?: string }[] = [];
    for (const id of await this.store.list()) {
      try {
        const report = await this.report(id);
        if (!['completed', 'cancelled'].includes(report.runtimeState?.phase ?? '') || report.workspaceCleanup?.cleaned) continue;
        await (await this.owned(id)).cleanWorkspaces(force); results.push({ runId: id, status: 'cleaned' });
      } catch (error) { results.push({ runId: id, status: 'kept', reason: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }
  async revisePlan(id: string, feedback: string, planHash: string) { const run = await this.owned(id); await run.revisePlan(feedback, planHash); return run.report(); }
  async extendTime(id: string, seconds: number) { const run = await this.owned(id); await run.extendTime(seconds); return run.report(); }
  async settle(id: string) { await this.runs.get(id)?.settled(); return this.get(id); }
  readMemory(query?: string) {
    const memory = openProjectMemory(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'));
    if (!memory) return { root: null, records: [] };
    try { return { root: memory.root, records: memory.store.search(query ? { query } : {}) }; } finally { memory.store.close(); }
  }
  async configureMemory(input: { root?: string; initializeDefault: boolean; expectedPrevious: string | null }) {
    let root = input.root;
    if (input.initializeDefault) {
      const metadata = projectDir(primaryWorktree(this.projectRoot));
      try { const info = await lstat(metadata); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Project metadata directory must be a real directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(metadata); }
      const target = path.join(metadata, 'memory'); await mkdir(target, { recursive: true }); root = resolveDefaultMemoryRoot(this.projectRoot);
    }
    if (!root) throw new Error('Memory root is required');
    const registry = new ProjectMemoryRegistry(path.join(this.stateRoot, 'coordination.sqlite'));
    try { registry.set(this.projectRoot, root, input.expectedPrevious); } finally { registry.close(); }
    return this.readMemory();
  }
  async writeMemory(input: MemoryInput, expectedRevision: string | null, source: 'ui' | 'cli') {
    if (input.type === 'lesson') throw new Error('Lessons require a proposal approval');
    const database = path.join(this.stateRoot, 'coordination.sqlite'), memory = openProjectMemory(this.projectRoot, database);
    if (!memory) throw new Error('Chọn memory root trước khi ghi');
    const actionId = `memory-${randomUUID()}`, directory = path.join(this.stateRoot, 'memory-actions'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const persist = async (suffix: string, value: unknown) => {
      const file = await open(path.join(directory, `${actionId}.${suffix}.json`), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    };
    const record = { ...input, sources: [...input.sources, `user-confirmation:${actionId}`] };
    try {
      await persist('requested', { actionId, actor: 'local-user', source, root: memory.root, expectedRevision, record, timestamp: new Date().toISOString() });
      const written = memory.store.write(record, expectedRevision, { projectWrite: true, confirmedByUser: true });
      await persist('result', { actionId, state: 'confirmed', revision: written.revision });
      return { record: written, actionId };
    } finally { memory.store.close(); }
  }
  async lessons(runId: string) {
    const directory = path.dirname(await this.store.journal(runId)), proposals = new LessonProposals(directory);
    const memory = openProjectMemory(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'));
    try {
      const files = (await readdir(directory)).filter(file => file.endsWith('.proposal.json'));
      return { memoryRoot: memory?.root ?? null, proposals: files.map(file => {
        const proposal = proposals.read(file.slice(0, -'.proposal.json'.length)), current = memory?.store.read('lesson', proposal.record.id);
        return { proposal, proposalHash: hashJson(proposal), expectedRevision: current?.revision ?? null, promoted: current?.header.sources.includes(`proposal:${proposal.proposalId}`) ?? false };
      }) };
    } finally { memory?.store.close(); }
  }
  async approveLesson(runId: string, input: { proposalId: string; proposalHash: string; expectedRevision: string | null; memoryRoot: string }) {
    const report = await this.get(runId); if (report.runtimeState?.phase !== 'completed') throw new Error('Chỉ duyệt lessons từ run đã hoàn tất');
    const proposals = new LessonProposals(path.dirname(await this.store.journal(runId))), proposal = proposals.read(input.proposalId);
    if (proposal.runId !== runId) throw new Error('Lesson belongs to another run');
    const memory = openProjectMemory(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'));
    if (!memory) throw new Error('Chọn memory root trước khi duyệt lesson');
    try {
      if (memory.root !== input.memoryRoot) throw new Error('Memory root changed since the lesson was displayed');
      const approvalId = `approval-${randomUUID()}`;
      proposals.approve(input.proposalId, approvalId, 'local-user', input.expectedRevision, { projectWrite: true, confirmedByUser: true }, input.proposalHash);
      return proposals.promote(approvalId, memory.store, { projectWrite: true });
    } finally { memory.store.close(); }
  }
  /** Pause active runs (confirming worker stop) and release resources. Returns the final state of each run this process owned. */
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const states: { runId: string; phase: string; reason: string }[] = [];
      for (const run of this.runs.values()) {
        try {
          if (run.busy) await run.stop('pause');
          // Read the state while the journal is still open; close() releases it.
          const report = await run.report().catch(() => undefined);
          states.push({ runId: run.runId, phase: report?.runtimeState.phase ?? 'unknown', reason: report?.runtimeState.reason ?? '' });
        } finally { await run.close(); }
      }
      this.coordinator.close();
      return states;
    })();
    return this.closing;
  }
}
