import path from 'node:path';
import { z } from 'zod';
import { WorkspaceCoordinator } from '../storage/coordination.js';
import { RunStore } from '../storage/run-store.js';
import { SingleOwnerJournal, type RunEvent } from '../storage/journal.js';
import { replayRun } from '../core/recovery.js';
import { LocalRun } from './local-run.js';
import { projectRuntimeRoot, readProject, readProjectRules, snapshotProjectFlow, standaloneDiagnostics } from './project.js';
import { hashJson, type BindingOverride } from '../domain/resolve.js';
import { captureBaseline } from '../workspace/baseline.js';
import { describeStepMemory, formatMemorySnapshot, memoryForRun, memoryLocation, openProjectMemory, stepMemoryPolicy } from './memory.js';
import { compactLegacyLesson, duplicateRecord, maxUserNotesPerRun, memoryFingerprint, noteId, proposalIds, proposalInputSchema, proposalStates, type ProposalInput, type ProposalState } from './memory-proposals.js';
import { memoryFeedbackSchema, type MemoryFeedback, type RecoveryReport } from '../core/recovery.js';
import { DurableRun } from '../core/durable-run.js';
import { MemoryFeedbackStore, type MemoryRating } from '../memory/feedback.js';
import { activeMemory } from '../memory/retrieval.js';
import { mkdir, lstat, open, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ProjectMemoryRegistry } from '../memory/registry.js';
import { resolveDefaultMemoryRoot } from '../memory/project-root.js';
import { primaryWorktree } from '../workspace/worktree.js';
import { MemoryConflict, type MemoryInput, type MemoryRecord } from '../memory/store.js';
import { compactLegacyLessonBody, legacyLessonHeader, maxSessionProposalLength } from '../memory/lesson-body.js';
import { LessonProposals } from '../memory/proposals.js';
import type { Flow } from '../domain/schema.js';
import { bindingRunners, selectAvailableBinding } from './model-selection.js';
import { deleteRunRefs } from '../workspace/run-cleanup.js';
import { defaultRunnerRegistry, type RunnerRegistry } from '../runners/registry.js';
import { codexUnavailableReason } from '../runners/codex-runner.js';
import type { AvailableRunnerModel } from '../runners/agent-runner.js';
import type { MaterializedRun } from '../domain/materialize.js';
import { changedPaths, planDirtyImport } from '../workspace/dirty-import.js';
import { runChanges } from '../workspace/checkout-apply.js';
import { branchLayout } from '../domain/branches.js';
import { projectDir } from '../storage/project-dir.js';
import { projectDirCreated } from '../storage/project-guide.js';
import { listTranscripts, readTranscript, transcriptDirectory } from '../core/transcript.js';
import { runnerHistory, sessionTurnIndex } from './session-history.js';
import { withLibraryLock } from '../storage/library-lock.js';

type MemoryKind = 'context' | 'decision' | 'lesson';

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
  async preview(flowId: string, version?: number, overrides: Record<string, BindingOverride> = {}, limits: Partial<Flow['definition']['limits']> = {}, workspaceMode?: Flow['definition']['workspacePolicy']) {
    const snapshot = await snapshotProjectFlow(this.projectRoot, flowId, version, overrides, limits, workspaceMode), baseline = await captureBaseline(this.projectRoot);
    const dirty = planDirtyImport(baseline), rules = await readProjectRules(this.projectRoot), importBlockers = [...(dirty.refused.length ? [`Symlink không mang vào run được: ${dirty.refused.join(', ')}`] : [])];
    return { snapshot, codexSandbox: snapshot.policy.codexSandbox ?? 'disabled', runtimeDiagnostics: standaloneDiagnostics(snapshot.configuration.flow), runnerPreflight: this.runnerPreflight(snapshot), flowExceptions: flowExceptions(snapshot.configuration.flow), rules: rules ? { rules: rules.rules, warnings: rules.warnings } : { rules: [], warnings: [] }, configurationHash: hashJson({ snapshot, sourceHead: baseline.head, ...(rules?.rules.length ? { rules: rules.hash } : {}) }), sourceHead: baseline.head, dirtyPaths: baseline.entries.map(entry => entry.path),
      // Confirming `baselineHash` copies exactly these changes into the run; they stay out of its commit.
      dirtyImport: { baselineHash: dirty.baselineHash, changes: snapshot.configuration.flow.definition.workspacePolicy === 'isolated' ? dirty.changes : baseline.entries.map(entry => ({ path: entry.path, change: entry.kind === 'missing' ? 'deleted' as const : entry.status === '??' ? 'added' as const : 'modified' as const })), blockers: snapshot.configuration.flow.definition.workspacePolicy === 'isolated' ? importBlockers : [] },
      workspaceChoices: ['isolated', 'current', 'shared'], gitDelivery: 'Local commit from the reviewed tree; configured Git hooks are not executed. Approved checks run before review.' };
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
  async create(flowId: string, task: string, version?: number, overrides: Record<string, BindingOverride> = {}, configurationHash?: string, limits: Partial<Flow['definition']['limits']> = {}, importDirty?: string, workspaceMode?: Flow['definition']['workspacePolicy'], program?: { programId: string; phaseId: string }) {
    const snapshot = await snapshotProjectFlow(this.projectRoot, flowId, version, overrides, limits, workspaceMode);
    const diagnostics = standaloneDiagnostics(snapshot.configuration.flow);
    if (diagnostics.length) throw new Error(diagnostics.join(' '));
    if (Object.values(snapshot.profilesByStep).some(profile => !profile.requestedPermissions.read)) throw new Error('Executor hiện cần quyền đọc trong mọi agent profile');
    const sourceHead = (await captureBaseline(this.projectRoot)).head, rules = await readProjectRules(this.projectRoot);
    // Rules join the hash only when the project has some, so previews from before rules existed still match.
    if (configurationHash !== undefined && hashJson({ snapshot, sourceHead, ...(rules?.rules.length ? { rules: rules.hash } : {}) }) !== configurationHash) throw new Error('Cấu hình hoặc HEAD đã thay đổi; xem lại trước khi bắt đầu');
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
    const project = await readProject(this.projectRoot), selectionPolicy = project.memorySelection;
    const memory = memoryForRun(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'), task, selectionPolicy, project.projectId);
    const run = await LocalRun.create({ projectRoot: this.projectRoot, stateRoot: this.stateRoot, task, snapshot, coordinator: this.coordinator, runners: this.runners, expectedSourceHead: sourceHead, ...(importDirty ? { importDirty } : {}), ...(program ? { program } : {}), ...(rules?.rules.length ? { rules: { hash: rules.hash, rules: rules.rules } } : {}),
      ...(memory ? { memory: formatMemorySnapshot(memory, task, selectionPolicy) } : {}) });
    this.runs.set(run.runId, run);
    if (run.context.memory?.records?.length) this.recordMemoryUse(run.runId, run.context.memory.records);
    for (const selection of selections) await run.durable.service.selectAllowedFallback(selection.key, selection.values, 'Lựa chọn chính không khả dụng; dùng model trong danh sách thay thế đã cấu hình');
    run.launch(); return run.report();
  }
  async get(runId: string) { const report = await this.withHandoff(await this.withDelivery(await this.report(runId))); return { ...report, memoryUse: this.memoryUse(report), nodeData: report.nodeData.map(({ prompt: _prompt, output, ...input }) => ({ ...input, ...(output ? { output: { outputHash: output.outputHash, truncated: output.truncated, messageCount: output.messages.length } } : {}) })) }; }
  async nodeData(runId: string, attemptId: string) { const item = (await this.report(runId)).nodeData.find(item => item.attemptId === attemptId); if (!item) throw new Error('No recorded input/output for this attempt'); return item; }
  async previewMemory(task: string) {
    const project = await readProject(this.projectRoot), selectionPolicy = project.memorySelection;
    const memory = memoryForRun(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'), task, selectionPolicy, project.projectId);
    if (!memory) return { root: null, records: [], ...(selectionPolicy?.inferTaskPaths ? { inferredPaths: [] as string[] } : {}), ...(selectionPolicy ? { selectionPolicy } : {}) };
    const snapshot = formatMemorySnapshot(memory, task, selectionPolicy);
    return { root: snapshot.root, records: snapshot.records, ...(snapshot.excluded ? { excluded: snapshot.excluded } : {}), ...(snapshot.inferredPaths ? { inferredPaths: snapshot.inferredPaths } : {}), ...(snapshot.selectionPolicy ? { selectionPolicy: snapshot.selectionPolicy } : {}) };
  }
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
    return { ...report, handoff: { files, applied: (report.runtimeContext as { workspaceMode?: string } | undefined)?.workspaceMode && (report.runtimeContext as { workspaceMode?: string }).workspaceMode !== 'isolated' ? true : report.checkoutApply?.applied ?? false } };
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
  async list() { const runs = await Promise.all((await this.store.list()).map(async id => {
    try {
      const run = await this.report(id);
      const flow = run.snapshot ? (run.snapshot as MaterializedRun).configuration.flow : undefined;
      const createdAt = (await new SingleOwnerJournal(await this.store.journal(id), id).read())[0]?.timestamp;
      return { runId: id, task: run.runtimeContext?.task, flowId: flow?.flowId, flowName: flow?.name, createdAt, programId: run.runtimeContext?.programId, phaseId: run.runtimeContext?.phaseId, phase: run.runtimeState?.phase ?? 'recovering', reason: run.runtimeState?.reason ?? '', activeMs: run.runtimeState?.activeMs ?? 0, tokens: run.usage.totalTokens };
    } catch (error) { return { runId: id, task: id, createdAt: undefined, phase: 'blocked', reason: error instanceof Error ? error.message : String(error), activeMs: 0 }; }
  })); return runs.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.runId.localeCompare(b.runId)); }
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
  /**
   * Delete a finished (completed or cancelled) run for good: its worktrees, the refs NeoMind kept for it, the journal and
   * transcripts. Unsaved changes in the worktree are discarded, so callers must ask the user first.
   */
  async delete(id: string) {
    const report = await this.report(id), phase = report.runtimeState?.phase ?? '';
    if (!['completed', 'cancelled'].includes(phase)) throw new Error('Chỉ xóa được run đã hoàn tất hoặc đã hủy; hủy run trước khi xóa');
    const run = await this.owned(id), mode = report.runtimeContext?.workspaceMode;
    if ((!mode || mode === 'isolated') && !report.workspaceCleanup?.cleaned) await run.cleanWorkspaces(true);
    await run.close(); this.runs.delete(id);
    await deleteRunRefs(report.runtimeContext?.projectRoot ?? this.projectRoot, id);
    await this.store.remove(id);
    return { runId: id, deleted: true };
  }
  /** Delete every finished run; a run that cannot be deleted is reported and left as is. */
  async deleteFinished() {
    const results: { runId: string; status: 'deleted' | 'kept'; reason?: string }[] = [];
    for (const id of await this.store.list()) {
      try {
        if (!['completed', 'cancelled'].includes((await this.report(id)).runtimeState?.phase ?? '')) continue;
        await this.delete(id); results.push({ runId: id, status: 'deleted' });
      } catch (error) { results.push({ runId: id, status: 'kept', reason: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }
  async revisePlan(id: string, feedback: string, planHash: string) { const run = await this.owned(id); await run.revisePlan(feedback, planHash); return run.report(); }
  async extendTime(id: string, seconds: number, tokens = 0) { const run = await this.owned(id); await run.extendTime(seconds, tokens); return run.report(); }
  async settle(id: string) { await this.runs.get(id)?.settled(); return this.get(id); }
  /** Approved records with where memory lives (a configured folder or `neomind/memory` in the repo) and each record's use and rating totals. */
  readMemory(query?: string) {
    const database = path.join(this.stateRoot, 'coordination.sqlite'), location = memoryLocation(this.projectRoot, database);
    const memory = openProjectMemory(this.projectRoot, database), feedback = new MemoryFeedbackStore(database);
    try {
      const stats = Object.fromEntries(feedback.stats());
      if (!memory) return { root: null, records: [], location, stats, inactive: [] as { id: string; reason: string }[] };
      // Expired, superseded and duplicate records stay listed; `inactive` says which ones retrieval skips and why.
      const records = memory.store.search(query ? { query } : {});
      return { root: memory.root, records, location, stats, inactive: activeMemory(records).excluded };
    } finally { memory?.store.close(); feedback.close(); }
  }
  async configureMemory(input: { root?: string; initializeDefault: boolean; expectedPrevious: string | null }) {
    let root = input.root;
    if (input.initializeDefault) {
      const metadata = projectDir(primaryWorktree(this.projectRoot));
      try { const info = await lstat(metadata); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Project metadata directory must be a real directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(metadata); projectDirCreated(metadata); }
      const target = path.join(metadata, 'memory'); await mkdir(target, { recursive: true }); root = resolveDefaultMemoryRoot(this.projectRoot);
    }
    if (!root) throw new Error('Memory root is required');
    const registry = new ProjectMemoryRegistry(path.join(this.stateRoot, 'coordination.sqlite'));
    try { registry.set(this.projectRoot, root, input.expectedPrevious); } finally { registry.close(); }
    return this.readMemory();
  }
  async writeMemory(input: MemoryInput, expectedRevision: string | null, source: 'ui' | 'cli') {
    // A new lesson enters memory only through an approved proposal; the user may edit one that is already approved.
    if (input.type === 'lesson' && expectedRevision === null) throw new Error('Lessons require a proposal approval');
    const database = path.join(this.stateRoot, 'coordination.sqlite'), memory = openProjectMemory(this.projectRoot, database, true);
    if (!memory) throw new Error('Chọn memory root trước khi ghi');
    const actionId = `memory-${randomUUID()}`, directory = path.join(this.stateRoot, 'memory-actions'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const persist = async (suffix: string, value: unknown) => {
      const file = await open(path.join(directory, `${actionId}.${suffix}.json`), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    };
    const record = { ...input, sources: [...input.sources, `user-confirmation:${actionId}`] };
    try {
      await persist('requested', { actionId, actor: 'local-user', source, root: memory.root, expectedRevision, record, timestamp: new Date().toISOString() });
      const written = input.type === 'lesson' ? memory.store.update(record, expectedRevision!, { projectWrite: true, confirmedByUser: true }) : memory.store.write(record, expectedRevision, { projectWrite: true, confirmedByUser: true });
      await persist('result', { actionId, state: 'confirmed', revision: written.revision });
      return { record: written, actionId };
    } finally { memory.store.close(); }
  }
  async lessons(runId: string) {
    const directory = path.dirname(await this.store.journal(runId)), proposals = new LessonProposals(directory);
    const database = path.join(this.stateRoot, 'coordination.sqlite'), memory = openProjectMemory(this.projectRoot, database);
    try {
      const files = (await readdir(directory)).filter(file => file.endsWith('.proposal.json'));
      // Without a memory folder yet, approving creates the default one, so the default location is shown.
      return { memoryRoot: memory?.root ?? memoryLocation(this.projectRoot, database).root, proposals: files.map(file => {
        const { proposal, version } = proposals.readVersion(file.slice(0, -'.proposal.json'.length)), current = memory?.store.read(proposal.record.type, proposal.record.id);
        return { proposal, version, proposalHash: hashJson(proposal), expectedRevision: current?.revision ?? null, promoted: current?.header.sources.includes(`proposal:${proposal.proposalId}`) ?? false, rejected: !!proposals.rejection(proposal.proposalId) };
      }) };
    } finally { memory?.store.close(); }
  }
  /** List pending proposals from the most recent completed runs; each approval still validates its own immutable hash. */
  async lessonQueue() {
    const completed = (await this.list()).filter(item => item.phase === 'completed').reverse();
    const runs: { runId: string; task: string; pending: number }[] = [], errors: { runId: string; error: string }[] = [];
    for (const item of completed.slice(0, 50)) {
      try {
        const { proposals } = await this.lessons(item.runId);
        const pending = proposals.filter(proposal => !proposal.promoted && !proposal.rejected).length;
        if (pending) runs.push({ runId: item.runId, task: item.task ?? item.runId, pending });
      } catch (error) { errors.push({ runId: item.runId, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { runs, errors, scanned: Math.min(completed.length, 50), totalCompleted: completed.length };
  }
  async approveLesson(runId: string, input: { proposalId: string; proposalHash: string; expectedRevision: string | null; memoryRoot: string }) {
    const directory = path.dirname(await this.store.journal(runId));
    return withLibraryLock(directory, async () => {
    const proposals = new LessonProposals(directory), proposal = proposals.read(input.proposalId);
    // Repair lessons wait for the run to complete; other proposals (plan feedback, "remember this") can be approved any time.
    if (!proposal.origin || proposal.origin === 'repair') { const report = await this.get(runId); if (report.runtimeState?.phase !== 'completed') throw new Error('Chỉ duyệt lessons từ run đã hoàn tất'); }
    if (proposal.runId !== runId) throw new Error('Lesson belongs to another run');
    const database = path.join(this.stateRoot, 'coordination.sqlite'), displayed = memoryLocation(this.projectRoot, database).root;
    const memory = openProjectMemory(this.projectRoot, database, true);
    if (!memory) throw new Error('Chọn memory root trước khi duyệt lesson');
    try {
      if (memory.root !== input.memoryRoot && displayed !== input.memoryRoot) throw new Error('Memory root changed since the lesson was displayed');
      const approvalId = `approval-${randomUUID()}`;
      proposals.approve(input.proposalId, approvalId, 'local-user', input.expectedRevision, { projectWrite: true, confirmedByUser: true }, input.proposalHash);
      return proposals.promote(approvalId, memory.store, { projectWrite: true });
    } finally { memory.store.close(); }
    });
  }
  async rejectLesson(runId: string, input: { proposalId: string; proposalHash: string }) {
    const directory = path.dirname(await this.store.journal(runId));
    return withLibraryLock(directory, async () => {
      const proposals = new LessonProposals(directory), proposal = proposals.read(input.proposalId);
      if (!proposal.origin || proposal.origin === 'repair') { const report = await this.get(runId); if (report.runtimeState?.phase !== 'completed') throw new Error('Chỉ từ chối lessons từ run đã hoàn tất'); }
      if (proposal.runId !== runId) throw new Error('Lesson belongs to another run');
      const memory = openProjectMemory(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'));
      try { if (memory?.store.read(proposal.record.type, proposal.record.id)?.header.sources.includes(`proposal:${proposal.proposalId}`)) throw new Error('Lesson đã được duyệt'); }
      finally { memory?.store.close(); }
      return proposals.reject(input.proposalId, input.proposalHash, { confirmedByUser: true });
    });
  }
  async reviseLesson(runId: string, input: { proposalId: string; proposalHash: string; body: string }) {
    const directory = path.dirname(await this.store.journal(runId));
    return withLibraryLock(directory, async () => {
      const proposals = new LessonProposals(directory), proposal = proposals.read(input.proposalId);
      if (!proposal.origin || proposal.origin === 'repair') { const report = await this.get(runId); if (report.runtimeState?.phase !== 'completed') throw new Error('Chỉ sửa lessons từ run đã hoàn tất'); }
      if (proposal.runId !== runId) throw new Error('Lesson belongs to another run');
      const memory = openProjectMemory(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'));
      try { if (memory?.store.read(proposal.record.type, proposal.record.id)?.header.sources.includes(`proposal:${proposal.proposalId}`)) throw new Error('Lesson đã được duyệt'); }
      finally { memory?.store.close(); }
      return proposals.revise(input.proposalId, input.proposalHash, input.body, { confirmedByUser: true });
    });
  }
  // Memory the user and agents can grow (11/11): proposals from AI sessions, runs and users, quick notes, edits and ratings.
  // One core shared by session tools, the CLI and the editor API.
  private get memoryDatabase() { return path.join(this.stateRoot, 'coordination.sqlite'); }
  /** Proposals made outside a run (AI sessions, CLI) wait here, next to the runs' own proposal artifacts. */
  private async projectProposalDirectory() { const directory = path.join(this.stateRoot, 'memory-proposals'); await mkdir(directory, { recursive: true, mode: 0o700 }); return directory; }
  private async proposalDirectory(runId: string | null) { return runId ? path.dirname(await this.store.journal(runId)) : this.projectProposalDirectory(); }
  private recordMemoryUse(runId: string, records: { type: string; id: string; revision: string }[]) {
    const feedback = new MemoryFeedbackStore(this.memoryDatabase);
    try { feedback.recordUse(runId, records.map(record => ({ key: `${record.type}/${record.id}`, revision: record.revision }))); } finally { feedback.close(); }
  }
  /** Approved records matching a query and filters, as short summaries; `active` is false for expired, superseded or duplicate ones. */
  searchMemory(filters: { query?: string; type?: MemoryKind; scope?: string; tags?: string[]; limit?: number } = {}) {
    const memory = openProjectMemory(this.projectRoot, this.memoryDatabase);
    if (!memory) return { root: null, total: 0, records: [] };
    try {
      const all = memory.store.search({ ...(filters.query ? { query: filters.query } : {}), ...(filters.scope ? { scope: filters.scope } : {}), ...(filters.tags?.length ? { tags: filters.tags } : {}), ...(filters.type ? { types: [filters.type] } : {}) });
      const active = new Set(activeMemory(all).active.map(record => `${record.header.type}/${record.header.id}`));
      return { root: memory.root, total: all.length, records: all.slice(0, Math.min(100, filters.limit ?? 20)).map(record => ({ id: record.header.id, type: record.header.type, scope: record.header.scope, tags: record.header.tags,
        summary: record.body.length > 240 ? `${record.body.slice(0, 240)}…` : record.body, revision: record.revision, updatedAt: record.header.updatedAt, active: active.has(`${record.header.type}/${record.header.id}`) })) };
    } finally { memory.store.close(); }
  }
  getMemory(type: MemoryKind, id: string) {
    const memory = openProjectMemory(this.projectRoot, this.memoryDatabase);
    try {
      const record = memory?.store.read(type, id);
      if (!record) throw new Error(`Không có bản ghi memory ${type}/${id}`);
      return { root: memory!.root, record };
    } finally { memory?.store.close(); }
  }
  /**
   * Proposals waiting for the user: the project's own queue and every run's. The same text proposed more than once (by
   * several runs, or by a session and a run) is listed once with the others under `merged`; `duplicateOf` names an approved
   * record that already says it.
   */
  async memoryProposals(options: { includeDone?: boolean } = {}) {
    const database = this.memoryDatabase, memory = openProjectMemory(this.projectRoot, database);
    try {
      const states: ProposalState[] = [], errors: { runId: string; error: string }[] = [];
      states.push(...proposalStates(await this.projectProposalDirectory(), null, memory?.store));
      for (const runId of await this.store.list()) {
        try { states.push(...proposalStates(path.dirname(await this.store.journal(runId)), runId, memory?.store)); }
        catch (error) { errors.push({ runId, error: error instanceof Error ? error.message : String(error) }); }
      }
      const approved = memory?.store.search() ?? [], groups = new Map<string, ProposalState & { merged: { runId: string | null; proposalId: string; proposalHash: string }[]; duplicateOf?: string }>();
      for (const state of states.filter(item => options.includeDone || (!item.promoted && !item.rejected)).sort((a, b) => a.proposal.createdAt.localeCompare(b.proposal.createdAt))) {
        const key = memoryFingerprint(state.proposal.record), group = groups.get(key);
        if (group && !state.promoted && !state.rejected && !group.promoted && !group.rejected) { group.merged.push({ runId: state.runId, proposalId: state.proposal.proposalId, proposalHash: state.proposalHash }); continue; }
        const duplicate = !state.promoted ? duplicateRecord(approved, state.proposal.record) : undefined;
        groups.set(group ? `${key}:${state.runId}:${state.proposal.proposalId}` : key, { ...state, merged: [], ...(duplicate ? { duplicateOf: `${duplicate.header.type}/${duplicate.header.id}` } : {}) });
      }
      return { memoryRoot: memory?.root ?? memoryLocation(this.projectRoot, database).root, proposals: [...groups.values()], errors };
    } finally { memory?.store.close(); }
  }
  /**
   * Propose a record for the user to approve (an AI session, the CLI, or "remember this" on a run). Text an approved
   * record or a pending proposal already holds is not proposed again; the answer names it instead.
   */
  async proposeMemory(input: ProposalInput, origin: 'ai_session' | 'user_note' = 'ai_session', runId?: string) {
    const value = proposalInputSchema.parse(input), memory = openProjectMemory(this.projectRoot, this.memoryDatabase);
    // Memory is read in a review queue and pasted into later prompts, so an AI's proposal must be a short note, not a log.
    if (origin === 'ai_session' && value.body.length > maxSessionProposalLength) throw new Error(`Đề xuất memory dài ${value.body.length} ký tự; viết gọn dưới ${maxSessionProposalLength} ký tự (dòng đầu là tiêu đề) và dẫn bằng chứng qua sources`);
    let approved: ReturnType<NonNullable<typeof memory>['store']['search']> = [];
    try { approved = memory?.store.search() ?? []; } finally { memory?.store.close(); }
    const duplicate = duplicateRecord(approved, value);
    if (duplicate) return { created: false as const, duplicateOf: `${duplicate.header.type}/${duplicate.header.id}`, message: 'Memory đã có bản ghi cùng nội dung; không tạo đề xuất mới' };
    const pending = (await this.memoryProposals()).proposals.find(item => memoryFingerprint(item.proposal.record) === memoryFingerprint(value));
    if (pending) return { created: false as const, pending: { runId: pending.runId, proposalId: pending.proposal.proposalId }, message: 'Đã có đề xuất cùng nội dung đang chờ duyệt' };
    const directory = await this.proposalDirectory(runId ?? null);
    return withLibraryLock(directory, async () => {
      const proposals = new LessonProposals(directory);
      if (runId && origin === 'user_note' && proposalIds(directory).filter(id => proposals.read(id).origin === 'user_note').length >= maxUserNotesPerRun) throw new Error(`Run này đã có ${maxUserNotesPerRun} ghi chú chờ duyệt; duyệt hoặc từ chối bớt trước`);
      const store = openProjectMemory(this.projectRoot, this.memoryDatabase);
      let recordId: string;
      try { do recordId = noteId(value.body, randomUUID().slice(0, 8)); while (store?.store.read(value.type, recordId)); } finally { store?.store.close(); }
      const proposalId = `memory-${randomUUID()}`;
      proposals.create({ proposalId, ...(runId ? { runId } : {}), createdAt: new Date().toISOString(), origin, reason: value.reason,
        record: { id: recordId, type: value.type, scope: value.scope, sources: value.sources, tags: value.tags, body: value.body, ...(value.supersedes?.length ? { supersedes: value.supersedes } : {}) } });
      return { created: true as const, runId: runId ?? null, proposalId, proposalHash: hashJson(proposals.read(proposalId)), recordId };
    });
  }
  /** Approve a proposal (optionally editing its text first, as a new immutable revision), then settle its duplicates. */
  async approveMemoryProposal(input: { runId?: string | null | undefined; proposalId: string; proposalHash: string; body?: string | undefined; memoryRoot?: string | undefined }) {
    const runId = input.runId ?? null, directory = await this.proposalDirectory(runId);
    let proposalHash = input.proposalHash;
    if (input.body !== undefined) proposalHash = (await this.reviseMemoryProposal({ runId, proposalId: input.proposalId, proposalHash, body: input.body })).proposalHash;
    const location = memoryLocation(this.projectRoot, this.memoryDatabase).root, memoryRoot = input.memoryRoot ?? location;
    let record;
    if (runId) record = await this.approveLesson(runId, { proposalId: input.proposalId, proposalHash, expectedRevision: null, memoryRoot });
    else record = await withLibraryLock(directory, async () => {
      const memory = openProjectMemory(this.projectRoot, this.memoryDatabase, true);
      if (!memory) throw new Error('Chọn memory root trước khi duyệt');
      try {
        if (memory.root !== memoryRoot && location !== memoryRoot) throw new Error('Memory root changed since the proposal was displayed');
        const proposals = new LessonProposals(directory), approvalId = `approval-${randomUUID()}`;
        proposals.approve(input.proposalId, approvalId, 'local-user', null, { projectWrite: true, confirmedByUser: true }, proposalHash);
        return proposals.promote(approvalId, memory.store, { projectWrite: true });
      } finally { memory.store.close(); }
    });
    await this.settleDuplicates(record.header.type, record.body, { runId, proposalId: input.proposalId });
    return { record };
  }
  async rejectMemoryProposal(input: { runId?: string | null | undefined; proposalId: string; proposalHash: string }) {
    const runId = input.runId ?? null, directory = await this.proposalDirectory(runId);
    let proposal;
    if (runId) { await this.rejectLesson(runId, input); proposal = new LessonProposals(directory).read(input.proposalId); }
    else proposal = await withLibraryLock(directory, async () => {
      const proposals = new LessonProposals(directory), current = proposals.read(input.proposalId), memory = openProjectMemory(this.projectRoot, this.memoryDatabase);
      try { if (memory?.store.read(current.record.type, current.record.id)?.header.sources.includes(`proposal:${current.proposalId}`)) throw new Error('Đề xuất đã được duyệt'); } finally { memory?.store.close(); }
      proposals.reject(input.proposalId, input.proposalHash, { confirmedByUser: true }); return current;
    });
    await this.settleDuplicates(proposal.record.type, proposal.record.body, { runId, proposalId: input.proposalId });
    return { rejected: true };
  }
  async reviseMemoryProposal(input: { runId?: string | null | undefined; proposalId: string; proposalHash: string; body: string }) {
    const runId = input.runId ?? null;
    if (runId) return this.reviseLesson(runId, input);
    const directory = await this.projectProposalDirectory();
    return withLibraryLock(directory, async () => new LessonProposals(directory).revise(input.proposalId, input.proposalHash, input.body, { confirmedByUser: true }));
  }
  /**
   * Rewrite lessons in the old repair format (raw reviewer JSON plus the agent's whole reply) as the short body new runs
   * write. An approved record gets a new revision through the audited write path, keeping its sources plus `compacted`
   * (and `project` instead of the project id as scope); a pending proposal gets a new revision of its text. Bodies not in
   * the old format are never touched. `target` limits the pass to one record or one proposal; `dryRun` writes nothing.
   */
  async compactMemory(options: { dryRun?: boolean; target?: { type: MemoryKind; id: string } | { runId: string | null; proposalId: string }; source?: 'ui' | 'cli' } = {}) {
    const { projectId } = await readProject(this.projectRoot), target = options.target;
    type Change = { kind: 'record' | 'proposal'; key: string; runId?: string | null; before: string; after: string; applied: boolean };
    const changes: Change[] = [], skipped: { kind: 'record' | 'proposal'; key: string; reason: string }[] = [];
    const reason = 'Không tìm thấy finding trong bằng chứng cũ hay journal của run nguồn';
    /** The short body, from the embedded evidence or, when that was cut before the finding, from the source run's journal. */
    const shorten = async (body: string) => {
      const header = legacyLessonHeader(body);
      if (!header) return undefined;
      let events: RunEvent[] | undefined;
      if (!compactLegacyLessonBody(body)) { try { events = await new SingleOwnerJournal(await this.store.journal(header.runId), header.runId).read(); } catch { events = undefined; } }
      return compactLegacyLesson(body, events) ?? null;
    };
    const memory = openProjectMemory(this.projectRoot, this.memoryDatabase);
    let records: MemoryRecord[] = [];
    try { records = memory?.store.search() ?? []; } finally { memory?.store.close(); }
    for (const record of target && !('type' in target) ? [] : records) {
      const key = `${record.header.type}/${record.header.id}`;
      if (target && 'type' in target && (target.type !== record.header.type || target.id !== record.header.id)) continue;
      const after = await shorten(record.body);
      if (!after) { if (after === null) skipped.push({ kind: 'record', key, reason }); continue; }
      const change: Change = { kind: 'record', key, before: record.body, after, applied: false };
      if (!options.dryRun) {
        await this.writeMemory({ id: record.header.id, type: record.header.type, scope: record.header.scope === projectId ? 'project' : record.header.scope,
          sources: [...record.header.sources.filter(source => source !== 'compacted'), 'compacted'], tags: record.header.tags, body: after,
          ...(record.header.expiresAt ? { expiresAt: record.header.expiresAt } : {}), ...(record.header.supersedes ? { supersedes: record.header.supersedes } : {}) }, record.revision, options.source ?? 'cli');
        change.applied = true;
      }
      changes.push(change);
    }
    if (target && 'type' in target) return { dryRun: !!options.dryRun, changes, skipped };
    const directories: { runId: string | null; directory: string }[] = [];
    if (!target || target.runId === null) directories.push({ runId: null, directory: await this.projectProposalDirectory() });
    for (const runId of await this.store.list()) if (!target || target.runId === runId) directories.push({ runId, directory: path.dirname(await this.store.journal(runId)) });
    for (const { runId, directory } of directories) {
      const opened = openProjectMemory(this.projectRoot, this.memoryDatabase);
      let states: ProposalState[];
      try { states = proposalStates(directory, runId, opened?.store); } finally { opened?.store.close(); }
      for (const state of states.filter(item => !item.promoted && !item.rejected && (!target || target.proposalId === item.proposal.proposalId))) {
        const key = `${runId ?? 'project'}/${state.proposal.proposalId}`, after = await shorten(state.proposal.record.body);
        if (!after) { if (after === null) skipped.push({ kind: 'proposal', key, reason }); continue; }
        const change: Change = { kind: 'proposal', key, runId, before: state.proposal.record.body, after, applied: false };
        if (!options.dryRun) { await this.reviseMemoryProposal({ runId, proposalId: state.proposal.proposalId, proposalHash: state.proposalHash, body: after }); change.applied = true; }
        changes.push(change);
      }
    }
    return { dryRun: !!options.dryRun, changes, skipped };
  }
  /** The user decided on one proposal; the same text pending elsewhere was the same decision, so it is closed as rejected (merged). */
  private async settleDuplicates(type: MemoryKind, body: string, decided: { runId: string | null; proposalId: string }) {
    const key = memoryFingerprint({ type, body });
    for (const item of (await this.memoryProposals()).proposals.flatMap(group => [{ runId: group.runId, proposalId: group.proposal.proposalId, proposalHash: group.proposalHash, record: group.proposal.record }, ...group.merged.map(merged => ({ ...merged, record: group.proposal.record }))])) {
      if (memoryFingerprint(item.record) !== key || (item.runId === decided.runId && item.proposalId === decided.proposalId)) continue;
      const directory = await this.proposalDirectory(item.runId);
      await withLibraryLock(directory, async () => { new LessonProposals(directory).reject(item.proposalId, item.proposalHash, { confirmedByUser: true }); }).catch(() => undefined);
    }
  }
  /** "Ghi nhớ điều này" on a run: the user's sentence becomes a proposal whose source is the run (and step). */
  async rememberFromRun(runId: string, input: { text: string; type?: MemoryKind | undefined; nodeId?: string | undefined }) {
    await this.store.journal(runId);
    return this.proposeMemory({ type: input.type ?? 'lesson', body: input.text, sources: [`run:${runId}`, ...(input.nodeId ? [`run:${runId}/step:${input.nodeId}`] : [])],
      reason: 'Bạn chọn "Ghi nhớ điều này" trên run này' }, 'user_note', runId);
  }
  /**
   * A note the user writes on the Memory page is approved as written. Context and decisions are written directly; a lesson
   * goes through a proposal the user approves in the same action, so every lesson keeps a proposal and approval receipt.
   */
  async addMemoryNote(input: { type: MemoryKind; scope?: string | undefined; tags?: string[] | undefined; body: string; sources?: string[] | undefined; supersedes?: string[] | undefined }, source: 'ui' | 'cli' = 'ui') {
    const body = input.body.trim(), scope = input.scope?.trim() || 'project', tags = (input.tags ?? []).map(tag => tag.trim()).filter(Boolean), sources = input.sources?.length ? input.sources : ['user-note'];
    if (!body) throw new Error('Nội dung ghi chú không được trống');
    if (input.type !== 'lesson') {
      const memory = openProjectMemory(this.projectRoot, this.memoryDatabase, true);
      let id: string;
      try { do id = noteId(body, randomUUID().slice(0, 8)); while (memory?.store.read(input.type, id)); } finally { memory?.store.close(); }
      return this.writeMemory({ id, type: input.type, scope, sources, tags, body, ...(input.supersedes?.length ? { supersedes: input.supersedes } : {}) }, null, source);
    }
    const proposed = await this.proposeMemory({ type: 'lesson', scope, tags, body, sources, reason: 'Ghi chú bạn tự thêm trên trang Memory', ...(input.supersedes?.length ? { supersedes: input.supersedes } : {}) }, 'user_note');
    if (!proposed.created) throw new Error(proposed.message);
    return this.approveMemoryProposal({ runId: null, proposalId: proposed.proposalId, proposalHash: proposed.proposalHash });
  }
  /** Mark a record expired now; retrieval skips it but the page still shows it. */
  async expireMemory(type: MemoryKind, id: string, expectedRevision: string, source: 'ui' | 'cli' = 'ui') {
    const current = this.getMemory(type, id).record;
    if (current.revision !== expectedRevision) throw new MemoryConflict();
    return this.writeMemory({ id, type, scope: current.header.scope, sources: current.header.sources, tags: current.header.tags, body: current.body, expiresAt: new Date().toISOString(),
      ...(current.header.supersedes ? { supersedes: current.header.supersedes } : {}) }, expectedRevision, source);
  }
  /** Delete an approved record after the user confirmed; the request is audited like every other memory write. */
  async deleteMemory(type: MemoryKind, id: string, expectedRevision: string, source: 'ui' | 'cli' = 'ui') {
    const memory = openProjectMemory(this.projectRoot, this.memoryDatabase);
    if (!memory) throw new Error('Chưa có memory');
    const actionId = `memory-${randomUUID()}`, directory = path.join(this.stateRoot, 'memory-actions'); await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(path.join(directory, `${actionId}.deleted.json`), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ actionId, actor: 'local-user', source, root: memory.root, type, id, expectedRevision, record: memory.store.read(type, id), timestamp: new Date().toISOString() })); await file.sync(); } finally { await file.close(); }
      memory.store.remove(type, id, expectedRevision, { projectWrite: true, confirmedByUser: true });
      return { deleted: true, actionId };
    } finally { memory.store.close(); }
  }
  /**
   * The user's rating of a record a run used. The run's journal keeps the rating (`memory_feedback`); the coordination
   * database keeps the totals retrieval ranks by. Rating never changes the run's state.
   */
  async memoryFeedback(runId: string, input: MemoryFeedback) {
    const feedback = memoryFeedbackSchema.parse(input), active = this.runs.get(runId);
    const durable = active?.durable ?? await DurableRun.recover(this.store, this.coordinator, runId);
    try {
      const report = await durable.service.report();
      const used = report.runtimeContext?.memory?.records?.find(record => `${record.type}/${record.id}` === feedback.record);
      if (!used) throw new Error('Run này không dùng bản ghi memory đó');
      const event = await durable.service.recordMemoryFeedback({ ...feedback, ...(feedback.revision ? {} : { revision: used.revision }) });
      const store = new MemoryFeedbackStore(this.memoryDatabase);
      try {
        store.recordFeedback({ eventId: event.eventId, key: feedback.record, runId, ...(feedback.nodeId ? { nodeId: feedback.nodeId } : {}), rating: feedback.rating as MemoryRating, createdAt: event.timestamp });
        return { recorded: true, record: feedback.record, rating: feedback.rating, stats: store.stats().get(feedback.record) ?? null };
      } finally { store.close(); }
    } finally { if (!active) await durable.close(); }
  }
  /** Which pinned records each agent turn received, why, and how the step filters memory; plus the user's ratings. */
  private memoryUse(report: Pick<RecoveryReport, 'nodeData' | 'attempts' | 'runtimeContext' | 'memoryFeedback'> & { snapshot?: unknown }) {
    const pinned = new Map((report.runtimeContext?.memory?.records ?? []).map(record => [`${record.type}/${record.id}`, record]));
    const flow = (report.snapshot as MaterializedRun | undefined)?.configuration.flow;
    if (!pinned.size) return [];
    return report.nodeData.map(item => {
      const reviewerId = report.attempts.find(attempt => attempt.attemptId === item.attemptId)?.reviewerId, key = reviewerId ? `${item.nodeId}/${reviewerId}` : item.nodeId;
      const records = item.sources.filter(source => source.kind === 'memory').map(source => {
        const record = pinned.get(source.id), rating = [...(report.memoryFeedback ?? [])].reverse().find(entry => entry.record === source.id && (entry.attemptId ? entry.attemptId === item.attemptId : entry.nodeId === item.nodeId));
        return { record: source.id, id: record?.id ?? source.id.split('/')[1]!, type: record?.type ?? source.id.split('/')[0]!, scope: record?.scope ?? '', revision: source.hash, reason: record?.selectionReason ?? '', ...(rating ? { rating: rating.rating } : {}) };
      });
      return { nodeId: item.nodeId, attemptId: item.attemptId, key, filter: describeStepMemory(flow ? stepMemoryPolicy(flow, key) : undefined), records };
    });
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
