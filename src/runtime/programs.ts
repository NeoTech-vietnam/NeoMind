import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { templates } from '../domain/templates.js';
import type { BindingOverride } from '../domain/resolve.js';
import { FlowLibrary } from '../storage/flow-library.js';
import { projectDir } from '../storage/project-dir.js';
import { projectDirCreated } from '../storage/project-guide.js';
import { withLibraryLock } from '../storage/library-lock.js';
import { gitConfigEnv } from '../workspace/git-env.js';
import type { RunManager } from './run-manager.js';

const execFileAsync = promisify(execFile);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const override = z.strictObject({ runner: z.string().min(1).optional(), provider: z.string().min(1).optional(), model: z.string().min(1).optional(), reasoning: z.string().min(1).optional() });
export const programSchema = z.strictObject({
  schemaVersion: z.literal(1), programId: id, name: z.string().min(1), goal: z.string().min(1),
  phases: z.array(z.strictObject({ id, title: z.string().min(1), task: z.string().min(1), flowId: id, dependsOn: z.array(id),
    runnerOverrides: z.record(z.string(), override).optional() })).min(1),
});
export type Program = z.infer<typeof programSchema>;
export type PhaseStatus = 'blocked_by_dependency' | 'ready' | 'running' | 'waiting_user' | 'delivered' | 'failed';
/** Lessons handed to a later phase stay short so they never crowd out its own task. */
export const LESSONS_LIMIT = 4000;

const folder = (root: string) => path.join(projectDir(root), 'programs');
const file = (root: string, programId: string) => path.join(folder(root), `${id.parse(programId)}.json`);
/** Manual delivery marks are user state of this checkout, kept with the runs instead of in the versioned program file. */
const marksFile = (runs: RunManager, programId: string) => path.join(runs.stateRoot, 'programs', `${id.parse(programId)}.marks.json`);
const marksSchema = z.record(z.string(), z.strictObject({ note: z.string(), markedAt: z.iso.datetime(), runId: z.string().optional() }));

function validateGraph(program: Program) {
  const ids = new Set<string>();
  for (const phase of program.phases) { if (ids.has(phase.id)) throw new Error(`Duplicate phase ID ${phase.id}`); ids.add(phase.id); }
  for (const phase of program.phases) for (const dependency of phase.dependsOn) {
    if (!ids.has(dependency)) throw new Error(`Phase ${phase.id} depends on unknown phase ${dependency}`);
    if (dependency === phase.id) throw new Error(`Phase ${phase.id} depends on itself`);
  }
  const visiting = new Set<string>(), done = new Set<string>(), byId = new Map(program.phases.map(phase => [phase.id, phase]));
  const visit = (phaseId: string) => {
    if (done.has(phaseId)) return;
    if (visiting.has(phaseId)) throw new Error(`Phase dependencies form a cycle at ${phaseId}`);
    visiting.add(phaseId); for (const next of byId.get(phaseId)!.dependsOn) visit(next); visiting.delete(phaseId); done.add(phaseId);
  };
  for (const phase of program.phases) visit(phase.id);
}

/** A phase may only name a flow that can start now: a published project flow or an unshadowed built-in template. */
async function requirePublished(root: string, flowId: string) {
  const library = new FlowLibrary(path.join(projectDir(root), 'flows')), listed = await library.list();
  const item = listed.find(flow => flow.flowId === flowId);
  if (item) { if (item.archived) throw new Error(`Flow ${flowId} is archived`); if (!(await library.versions(flowId)).length) throw new Error(`Flow ${flowId} has no published version`); return; }
  if (!Object.hasOwn(templates, flowId)) throw new Error(`Flow ${flowId} does not exist`);
}

export async function createProgram(root: string, input: unknown) {
  const program = programSchema.parse(input);
  validateGraph(program);
  for (const flowId of new Set(program.phases.map(phase => phase.flowId))) await requirePublished(root, flowId);
  projectDirCreated(await mkdir(folder(root), { recursive: true }));
  return withLibraryLock(folder(root), async () => {
    const target = file(root, program.programId);
    try { await writeFile(target, `${JSON.stringify(program, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Program ${program.programId} already exists`); throw error; }
    return program;
  });
}

export async function readProgram(root: string, programId: string): Promise<Program> {
  const program = programSchema.parse(JSON.parse(await readFile(file(root, programId), 'utf8')));
  if (program.programId !== programId) throw new Error('Program ID mismatch');
  validateGraph(program); return program;
}

async function readMarks(runs: RunManager, programId: string) {
  try { return marksSchema.parse(JSON.parse(await readFile(marksFile(runs, programId), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

async function isAncestor(root: string, commit: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  try { await execFileAsync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, 'HEAD'], { env, timeout: 60000 }); return true; }
  catch (error) { if ((error as { code?: unknown }).code === 1) return false; throw error; }
}

export async function programStatus(root: string, runs: RunManager, programId: string) {
  const program = await readProgram(root, programId), marks = await readMarks(runs, programId);
  const all = (await runs.list()).filter(run => run.programId === programId);
  const phases: { id: string; title: string; flowId: string; dependsOn: string[]; status: PhaseStatus; reason: string; runId?: string; runs: string[]; commits?: string[]; note?: string }[] = [];
  const statusOf = new Map<string, PhaseStatus>();
  // Phases are listed dependencies-first by validateGraph's guarantee of no cycles; resolve in that order.
  const order: Program['phases'] = [], placed = new Set<string>();
  while (order.length < program.phases.length) for (const phase of program.phases) if (!placed.has(phase.id) && phase.dependsOn.every(item => placed.has(item))) { order.push(phase); placed.add(phase.id); }
  for (const phase of order) {
    const own = all.filter(run => run.phaseId === phase.id), latest = own.at(-1), mark = marks[phase.id];
    let status: PhaseStatus, reason = '', commits: string[] | undefined;
    if (mark) { status = 'delivered'; reason = 'Người dùng đã đánh dấu giao'; }
    else if (latest) {
      if (['running', 'stopping', 'recovering'].includes(latest.phase)) { status = 'running'; reason = latest.reason; }
      else if (latest.phase === 'cancelled') { status = 'failed'; reason = latest.reason || 'Run đã hủy'; }
      else if (latest.phase === 'completed') {
        const report = await runs.get(latest.runId) as Awaited<ReturnType<RunManager['get']>> & { handoff?: { applied: boolean; files: string[] } };
        commits = report.delivery.map(item => item.commit);
        const merged = commits.length ? (await Promise.all(commits.map(commit => isAncestor(root, commit).catch(() => false)))).every(Boolean) : false;
        // A read-only phase (research) changes no file, so its report is the delivery.
        const readOnly = !commits.length && report.handoff !== undefined && !report.handoff.files.length;
        if (merged || report.handoff?.applied || readOnly) { status = 'delivered'; reason = merged ? 'Commit của giai đoạn đã có trong HEAD' : readOnly ? 'Run không thay đổi file' : 'Thay đổi đã áp dụng vào checkout'; }
        else { status = 'waiting_user'; reason = commits.length ? 'Run đã commit; đưa commit vào branch hiện tại (merge/cherry-pick) để mở giai đoạn sau' : 'Run xong; áp dụng thay đổi vào checkout để mở giai đoạn sau'; }
      } else { status = 'waiting_user'; reason = latest.reason; }
    } else if (phase.dependsOn.every(item => statusOf.get(item) === 'delivered')) { status = 'ready'; reason = 'Sẵn sàng bắt đầu'; }
    else { status = 'blocked_by_dependency'; reason = `Chờ giai đoạn ${phase.dependsOn.filter(item => statusOf.get(item) !== 'delivered').join(', ')}`; }
    statusOf.set(phase.id, status);
    phases.push({ id: phase.id, title: phase.title, flowId: phase.flowId, dependsOn: phase.dependsOn, status, reason, ...(latest ? { runId: latest.runId } : {}), runs: own.map(run => run.runId),
      ...(commits?.length ? { commits } : {}), ...(mark?.note ? { note: mark.note } : {}) });
  }
  const sorted = program.phases.map(phase => phases.find(item => item.id === phase.id)!);
  const delivered = sorted.filter(phase => phase.status === 'delivered').length;
  const current = sorted.find(phase => ['running', 'waiting_user', 'failed'].includes(phase.status)) ?? sorted.find(phase => phase.status === 'ready');
  return { programId, name: program.name, goal: program.goal, progress: { delivered, total: sorted.length }, ...(current ? { currentPhaseId: current.id } : {}),
    nextReady: sorted.find(phase => phase.status === 'ready' || phase.status === 'failed' && phase.dependsOn.every(item => statusOf.get(item) === 'delivered'))?.id ?? null, phases: sorted };
}

export async function listPrograms(root: string, runs: RunManager) {
  let names: string[];
  try { names = (await readdir(folder(root))).filter(name => name.endsWith('.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { programs: [], errors: [] }; throw error; }
  const programs: Awaited<ReturnType<typeof programStatus>>[] = [], errors: { programId: string; error: string }[] = [];
  for (const name of names.sort()) {
    const programId = name.slice(0, -'.json'.length);
    try { programs.push(await programStatus(root, runs, programId)); }
    catch (error) { errors.push({ programId, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { programs, errors };
}

/**
 * What earlier phases taught: review findings a repair fixed, lessons the user approved from those runs and the user's
 * delivery notes. Built from the journal, so it is the same whichever surface starts the phase.
 */
export async function programLessons(root: string, runs: RunManager, programId: string, before: string[]) {
  const status = await programStatus(root, runs, programId), marks = await readMarks(runs, programId), lines: string[] = [];
  for (const phase of status.phases.filter(item => before.includes(item.id))) {
    for (const runId of phase.runs) {
      const report = await runs.get(runId);
      for (const outputs of Object.values(report.priorReviewerOutputs ?? {})) for (const output of outputs) if (output.result.verdict === 'needs_changes')
        for (const finding of output.evidence?.findings ?? []) lines.push(`- [${phase.id}] Review đã yêu cầu sửa (${finding.criterion}): ${finding.explanation}`);
      try { for (const item of (await runs.lessons(runId)).proposals) if (item.promoted) lines.push(`- [${phase.id}] Lesson đã duyệt: ${item.proposal.record.body}`); }
      catch { /* a run without lesson proposals contributes none */ }
    }
    if (marks[phase.id]?.note) lines.push(`- [${phase.id}] Ghi chú khi giao: ${marks[phase.id]!.note}`);
  }
  const unique = [...new Set(lines)];
  let text = '';
  for (const line of unique) { if (text.length + line.length + 1 > LESSONS_LIMIT) { text += `${text ? '\n' : ''}- …`; break; } text += `${text ? '\n' : ''}${line}`; }
  return text;
}

function ancestors(program: Program, phaseId: string): string[] {
  const byId = new Map(program.phases.map(phase => [phase.id, phase])), seen = new Set<string>();
  const walk = (current: string) => { for (const next of byId.get(current)?.dependsOn ?? []) if (!seen.has(next)) { seen.add(next); walk(next); } };
  walk(phaseId); return [...seen];
}

/** Start one phase that is ready (or whose last run was cancelled); never starts a later phase on its own. */
export async function startPhase(root: string, runs: RunManager, programId: string, phaseId: string, options: { importDirty?: string } = {}) {
  const program = await readProgram(root, programId), phase = program.phases.find(item => item.id === phaseId);
  if (!phase) throw new Error(`Unknown phase ${phaseId}`);
  const status = await programStatus(root, runs, programId), current = status.phases.find(item => item.id === phaseId)!;
  const retry = current.status === 'failed' && phase.dependsOn.every(item => status.phases.find(other => other.id === item)?.status === 'delivered');
  if (current.status !== 'ready' && !retry) throw new Error(`Phase ${phaseId} is ${current.status}: ${current.reason}`);
  const lessons = await programLessons(root, runs, programId, ancestors(program, phaseId));
  const task = `${phase.task}\n\nChương trình: ${program.name} — ${program.goal}\nGiai đoạn: ${phase.title}${lessons ? `\n\nBài học từ các giai đoạn trước:\n${lessons}` : ''}`;
  const preview = await runs.preview(phase.flowId, undefined, (phase.runnerOverrides ?? {}) as Record<string, BindingOverride>);
  const blockers = [...preview.runtimeDiagnostics, ...(preview.runnerPreflight?.blockers ?? [])];
  if (blockers.length) return { started: false as const, phaseId, blockers };
  const run = await runs.create(phase.flowId, task, undefined, (phase.runnerOverrides ?? {}) as Record<string, BindingOverride>, preview.configurationHash, {}, options.importDirty, undefined, { programId, phaseId });
  return { started: true as const, phaseId, runId: run.runId, task };
}

/** The first phase that can start now; the caller asks the user before calling. */
export async function programNext(root: string, runs: RunManager, programId: string, options: { importDirty?: string } = {}) {
  const status = await programStatus(root, runs, programId);
  if (!status.nextReady) return { started: false as const, reason: status.progress.delivered === status.progress.total ? 'Chương trình đã giao đủ mọi giai đoạn' : 'Chưa có giai đoạn sẵn sàng', status };
  return startPhase(root, runs, programId, status.nextReady, options);
}

/** Mark a finished phase delivered when its result reached the branch in a way Git cannot see (squash, rebase, manual copy). */
export async function markPhaseDelivered(root: string, runs: RunManager, programId: string, phaseId: string, note: string) {
  const program = await readProgram(root, programId);
  if (!program.phases.some(phase => phase.id === phaseId)) throw new Error(`Unknown phase ${phaseId}`);
  const status = await programStatus(root, runs, programId), phase = status.phases.find(item => item.id === phaseId)!;
  if (!phase.runId || (await runs.get(phase.runId)).runtimeState?.phase !== 'completed') throw new Error('Chỉ đánh dấu giao giai đoạn có run đã hoàn tất');
  const target = marksFile(runs, programId); await mkdir(path.dirname(target), { recursive: true });
  return withLibraryLock(path.dirname(target), async () => {
    const marks = await readMarks(runs, programId); marks[phaseId] = { note: note.trim(), markedAt: new Date().toISOString(), runId: phase.runId };
    const temporary = `${target}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(marks, null, 2)); await rename(temporary, target);
    return programStatus(root, runs, programId);
  });
}
