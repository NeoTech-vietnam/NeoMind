import path from 'node:path';
import { z } from 'zod';
import { WorkspaceCoordinator } from '../storage/coordination.js';
import { RunStore } from '../storage/run-store.js';
import { SingleOwnerJournal } from '../storage/journal.js';
import { replayRun } from '../core/recovery.js';
import { LocalRun } from './local-run.js';
import { projectRuntimeRoot, snapshotProjectFlow, standaloneDiagnostics } from './project.js';
import { verifyRuntimeCapabilities } from './capabilities.js';
import { hashJson, type BindingOverride } from '../domain/resolve.js';
import { captureBaseline } from '../workspace/baseline.js';
import { startRuntimeWorker } from './worker.js';
import { memoryForRun, openProjectMemory } from './memory.js';
import { mkdir, lstat, open, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ProjectMemoryRegistry } from '../memory/registry.js';
import { resolveDefaultMemoryRoot } from '../memory/project-root.js';
import { primaryWorktree } from '../workspace/worktree.js';
import type { MemoryInput } from '../memory/store.js';
import { LessonProposals } from '../memory/proposals.js';
import type { Flow } from '../domain/schema.js';
import { selectAvailableBinding } from './model-selection.js';

export class RunManager {
  private readonly runs = new Map<string, LocalRun>();
  private constructor(readonly projectRoot: string, readonly stateRoot: string, private readonly store: RunStore, private readonly coordinator: WorkspaceCoordinator) {}
  static async open(projectRoot: string, stateBase?: string) {
    const root = await projectRuntimeRoot(projectRoot, stateBase);
    return new RunManager(projectRoot, root, await RunStore.open(path.join(root, 'runs')), new WorkspaceCoordinator(path.join(root, 'coordination.sqlite')));
  }
  async preview(flowId: string, version?: number, overrides: Record<string, BindingOverride> = {}, limits: Partial<Flow['definition']['limits']> = {}) {
    const snapshot = await snapshotProjectFlow(this.projectRoot, flowId, version, overrides, limits), baseline = await captureBaseline(this.projectRoot);
    return { snapshot, runtimeDiagnostics: standaloneDiagnostics(snapshot.configuration.flow), configurationHash: hashJson({ snapshot, sourceHead: baseline.head }), sourceHead: baseline.head, dirtyPaths: baseline.entries.map(entry => entry.path),
      workspaceChoices: ['isolated'], gitDelivery: 'Local commit from the reviewed tree; configured Git hooks are not executed. Approved checks run before review.' };
  }
  async models() {
    const worker = await startRuntimeWorker(this.projectRoot);
    try {
      const response = z.object({ data: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })) }).parse(await worker.scope.transport.request('model/list', { limit: 100 }));
      return response.data.filter(model => ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].includes(model.model));
    } finally { if (!await worker.scope.stop()) throw new Error('Model discovery worker stop unconfirmed'); }
  }
  async create(flowId: string, task: string, version?: number, overrides: Record<string, BindingOverride> = {}, configurationHash?: string, limits: Partial<Flow['definition']['limits']> = {}) {
    const snapshot = await snapshotProjectFlow(this.projectRoot, flowId, version, overrides, limits);
    const diagnostics = standaloneDiagnostics(snapshot.configuration.flow);
    if (diagnostics.length) throw new Error(diagnostics.join(' '));
    if (Object.values(snapshot.profilesByStep).some(profile => !profile.requestedPermissions.read)) throw new Error('Executor hiện cần quyền đọc trong mọi agent profile');
    const sourceHead = (await captureBaseline(this.projectRoot)).head;
    if (configurationHash !== undefined && hashJson({ snapshot, sourceHead }) !== configurationHash) throw new Error('Cấu hình hoặc HEAD đã thay đổi; xem lại trước khi bắt đầu');
    await verifyRuntimeCapabilities();
    const models = await this.models();
    const selections: { key: string; values: ReturnType<typeof selectAvailableBinding>['values'] }[] = [];
    for (const [key, binding] of Object.entries(snapshot.configuration.bindings)) {
      let selection; try { selection = selectAvailableBinding(binding, models); } catch (error) { throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`); }
      if (selection.fallback) selections.push({ key, values: selection.values });
    }
    const memory = memoryForRun(this.projectRoot, path.join(this.stateRoot, 'coordination.sqlite'), task);
    const memoryText = memory?.records.map(record => `[${record.header.type}:${record.header.id} revision=${record.revision}]\nSources: ${record.header.sources.join(', ')}\n${record.body}`).join('\n\n').slice(0, 40000);
    const run = await LocalRun.create({ projectRoot: this.projectRoot, stateRoot: this.stateRoot, task, snapshot, coordinator: this.coordinator, expectedSourceHead: sourceHead,
      ...(memory ? { memory: { root: memory.root, text: memoryText ?? '' } } : {}) });
    this.runs.set(run.runId, run);
    for (const selection of selections) await run.durable.service.selectAllowedFallback(selection.key, selection.values, 'Lựa chọn chính không khả dụng; dùng model trong danh sách thay thế đã cấu hình');
    run.launch(); return run.report();
  }
  async get(runId: string) {
    const active = this.runs.get(runId); if (active) return active.report();
    const events = await new SingleOwnerJournal(await this.store.journal(runId), runId).read(), report = replayRun(events);
    const snapshot = z.object({ snapshot: z.json().optional() }).parse(events[0]?.payload).snapshot;
    const plan = report.plans.at(-1)?.plan;
    const state = report.runtimeState;
    return { runId, ...report, ...(state && ['running', 'stopping'].includes(state.phase) ? { runtimeState: { ...state, phase: 'recovering' as const, reason: 'Run chưa có tiến trình điều phối trong phiên này; bấm Tiếp tục để đối chiếu' } } : {}), ...(plan ? { proposedPlanHash: hashJson(plan) } : {}), snapshot, busy: false, userContinueRequired: true };
  }
  async list() { return Promise.all((await this.store.list()).map(async id => {
    try {
      const run = await this.get(id);
      return { runId: id, task: run.runtimeContext?.task, phase: run.runtimeState?.phase ?? 'recovering', reason: run.runtimeState?.reason ?? '', activeMs: run.runtimeState?.activeMs ?? 0 };
    } catch (error) { return { runId: id, task: id, phase: 'blocked', reason: error instanceof Error ? error.message : String(error), activeMs: 0 }; }
  })); }
  private async owned(id: string) {
    let run = this.runs.get(id);
    if (!run) { run = await LocalRun.recover(this.store, this.coordinator, id); this.runs.set(id, run); }
    return run;
  }
  async action(id: string, action: 'approve' | 'resume' | 'pause' | 'cancel' | 'retry_git', source: 'ui' | 'cli' = 'ui', planHash?: string) {
    const run = await this.owned(id);
    if (action === 'approve') await run.approve('local-user', source, planHash);
    else if (action === 'resume') await run.resume();
    else if (action === 'retry_git') await run.retryGit();
    else await run.stop(action === 'cancel' ? 'cancel' : 'pause');
    return run.report();
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
      const metadata = path.join(primaryWorktree(this.projectRoot), '.neomind');
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
  async close() { for (const run of this.runs.values()) await run.close(); this.coordinator.close(); }
}
