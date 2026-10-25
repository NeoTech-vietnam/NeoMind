import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import { atomicWrite, createRecord, getRecord, hash, loadRecords, now, readConfig, safePath,
  saveStatus, saveWorkflowClosure, updateRecord, withOperationLock } from './storage.js';
import { beginWorkflow, readAutomationPolicy } from './manager.js';
import { startNative, waitNative, interruptNative } from './native.js';
import { invocationIsActive, readInvocation, requireRoutingPolicy, routingProblems, type NativeRole } from './routing.js';
import { exactRoot, hostRequest, readHost } from './vscode-wire.js';
import { registerControlledContext } from './controlled-context.js';
import { prepareWork, type WorkPreparation } from './procedure-reuse.js';
import { runCommand } from './command-runner.js';
import { readNativeSoftwareContract } from './native-software.js';
import type { ControlledBinding, ControlledCallbacks, ControlledPlan, ControlledReport } from './controlled-tools.js';
import { ControlledToolError } from './controlled-tools.js';
import { registerProcedure, resolveProcedure, runProcedure } from './procedures.js';
import { compileCornellResearch, readCornellDestination, type CornellResearchInput } from './cornell-workflow.js';
import { createCornellNote, validateCornellNote } from './notes.js';

type Stage = ControlledBinding['stage'];
export type ControlledState = 'queued' | 'running' | 'waiting' | 'paused' | 'interrupted' | 'uncertain' | 'blocked' | 'cancelled' | 'completed';
type FailureKind = 'implementation' | 'checker' | 'protocol' | 'environment' | 'unknown';
interface Event { id: string; at: string; kind: string; stage: Stage | 'intake'; invocation_id?: string; summary: string }
interface Attempt {
  id: string; request_id: string; stage: Stage; role: NativeRole; invocation_id?: string;
  state: 'starting' | 'running' | 'completed' | 'interrupted'; purpose?: 'specialist' | 'diagnosis' | 'check-review'; specialist_index?: number;
  report?: ControlledReport; report_id?: string; bound_hashes?: Record<string, string>; checked?: boolean;
}
interface CheckReceipt {
  id: string; attempt_id: string; invocation_id: string; title: string; command: string[];
  baseline: Record<string, string>; log_path: string; log_sha256: string;
  exit_code: number | null; expected_exit_code: number; negative: boolean; passed: boolean; cancelled: boolean; at: string;
}
interface Contract { schema_version: 2; process: 'software-tools'; workflow_id: string; epoch_id: string;
  plan: ControlledPlan; plan_hash: string; task_id: string; requirement_ids: string[];
  reviewer_required: boolean; risk_reasons: string[]; previous_contract_hash?: string; precheck_review: boolean; knowledge_directory?: string }
export interface ControlledSnapshot {
  schema_version: 1; workflow_id: string; epoch_id: string; status: ControlledState; phase: Stage | 'intake' | 'completed';
  process_contract: 'software-tools/v2'; transport: 'vscode-lm'; owner_pid: number; updated_at: string;
  owner_instance: string;
  requirement: string; title: string; revision: number; request_id: string; contract_hash?: string;
  attempts: Attempt[]; checks: CheckReceipt[]; events: Event[]; repairs: number;
  active_invocations: { id: string; role: string; state: string; requested_model: string; confirmed_model: string | null; provider: string | null }[];
  blocker?: { kind: FailureKind; message: string }; reuse?: WorkPreparation; final_report_id?: string;
  continuation?: { original_mode: string; original_fingerprint: string; original_contract_hash: string };
  finalizing_report_id?: string;
  procedure_runs?: { id: string; status: string }[]; procedure_candidate_id?: string; cornell_note_ids?: string[];
  pending_check_review?: boolean;
}
export interface ControlledStartInput { requirement?: string; requirements?: string[]; workflow_id?: string; request_id?: string; title?: string }
const states = '.neomind/controlled/workflows';
const hosts = new Map<string, Controller>();
const statePath = (root: string, id: string) => safePath(root, `${states}/${hash(id)}.json`);
const contractPath = (root: string, id: string, epoch: string) => safePath(root, `${states}/${hash(id)}.${epoch}.contract.json`);
const covers = (path: string, roots: string[]) => {
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  return roots.some(root => key(path) === key(root) || key(path).startsWith(`${key(root)}/`));
};
function readState(root: string, id: string): ControlledSnapshot {
  const value = JSON.parse(readFileSync(statePath(root, id), 'utf8'));
  if (value.schema_version !== 1 || value.workflow_id !== id || value.process_contract !== 'software-tools/v2')
    throw new Error('Controlled workflow journal is invalid.');
  return value;
}
function save(root: string, run: ControlledSnapshot, kind?: string, summary?: string): void {
  if (kind) run.events.push({ id: randomUUID(), at: now(), kind, stage: run.phase === 'completed' ? 'intake' : run.phase,
    invocation_id: run.attempts.at(-1)?.invocation_id, summary: summary ?? kind });
  run.revision++; run.updated_at = now();
  // The journal is authoritative; status readers do not infer liveness from an old activity report.
  atomicWrite(statePath(root, run.workflow_id), JSON.stringify(run, null, 2) + '\n');
}
function canonical(root: string, path: string): string {
  if (!path || path !== posix.normalize(path) || path === '.' || path.startsWith('../') || path.startsWith('/') ||
      /[\\:*?\x00-\x1f]/.test(path) || path.split('/').some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      /^(?:\.git|\.neomind|\.verythinker|\.taskforces)(?:\/|$)/i.test(path))
    throw new Error('Use bounded canonical public project-relative paths.');
  safePath(root, path); return path;
}
function fingerprints(root: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(path: string) {
    canonical(root, path);
    const full = safePath(root, path);
    if (!existsSync(full)) { result[path] = 'missing'; return; }
    const info = lstatSync(full);
    if (info.isSymbolicLink()) throw new Error('Controlled evidence cannot follow symlinks.');
    if (Object.keys(result).length > 4096) throw new Error('Evidence baseline exceeds its file limit.');
    if (info.isDirectory()) { for (const name of readdirSync(full).sort()) visit(`${path}/${name}`); }
    else if (info.isFile() && info.nlink === 1) result[path] = hash(readFileSync(full));
    else throw new Error('Evidence requires ordinary unlinked files.');
  }
  for (const path of paths) visit(path);
  return result;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function controlledRisk(plan: ControlledPlan): { reviewer_required: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const paths = [...plan.allowed_paths, ...plan.verification_paths];
  const sensitive = /(?:^|\/)(?:auth[^/]*|security[^/]*|routing[^/]*|storage[^/]*|native[^/]*|controlled[^/]*|workspace[^/]*|engineering[^/]*|manager[^/]*|mcp[^/]*|command-runner[^/]*|vscode[^/]*|installer[^/]*|migration[^/]*)(?:\.|\/|$)/i;
  if (paths.some(path => sensitive.test(path) || path.startsWith('.github/') || /(?:^|\/)(?:package(?:-lock)?\.json|Dockerfile|Makefile|requirements\.txt)|\.sql$/i.test(path))) reasons.push('Security, persistence, execution or orchestration scope.');
  if (/\b(?:authentication|authorization|credentials|secrets|permissions|database migration|schema migration|orchestration|login|access control|token)\b/i.test(`${plan.title} ${plan.objective} ${plan.rationale} ${plan.acceptance_criteria.join(' ')}`))
    reasons.push('The plan declares sensitive behavior.');
  if (plan.risk === 'high' || plan.risk === 'elevated') reasons.push('Coordinator elevated the risk.');
  if (plan.risk === undefined) reasons.push('Risk has not been explicitly assessed.');
  return { reviewer_required: reasons.length > 0, reasons };
}
function validatePlan(root: string, value: ControlledPlan): ControlledPlan {
  const plan = structuredClone(value);
  if (!plan.acceptance_criteria.length || !plan.outputs.length || !plan.checks.length || !plan.allowed_paths.length || !plan.verification_paths.length)
    throw new Error('Plan needs explicit acceptance, implementation scope, outputs and independent checks.');
  for (const key of ['allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'] as const)
    plan[key] = [...new Set(plan[key].map(path => canonical(root, path)))];
  if (plan.allowed_paths.some(path => covers(path, plan.verification_paths)) || plan.verification_paths.some(path => covers(path, plan.allowed_paths)))
    throw new Error('Implementation and independent checker scopes must be disjoint.');
  if ([...plan.outputs, ...plan.documentation_paths].some(path => !covers(path, plan.allowed_paths))) throw new Error('Outputs must be within implementation scope.');
  for (const check of plan.checks) {
    if (check.command.length < 2 || check.command.some(arg => /[\x00-\x1f]/.test(arg))) throw new Error('Use explicit check argv.');
    check.baseline_paths.forEach(path => canonical(root, path));
    if (!check.command.slice(1).some(arg => covers(arg, plan.verification_paths) && check.baseline_paths.includes(arg)))
      throw new Error('Every check must execute its declared independent checker script.');
    if (check.baseline_paths.some(path => !covers(path, [...plan.allowed_paths, ...plan.verification_paths]))) throw new Error('Check baseline exceeds plan scope.');
    if (!check.negative_controls?.length) throw new Error('Each check needs backend-executed negative controls against its independent checker.');
    for (const negative of check.negative_controls) {
      negative.baseline_paths.forEach(path => canonical(root, path));
      if (!same(check.command.slice(0, 2), negative.command.slice(0, 2)) ||
          !(negative.command.slice(2).some(arg => covers(arg, plan.verification_paths) && negative.baseline_paths.includes(arg)) ||
            negative.command.includes('--negative-control') && negative.command.length >= 4 && negative.baseline_paths.includes(check.command[1]!)) ||
          negative.baseline_paths.some(path => !covers(path, [...plan.allowed_paths, ...plan.verification_paths])) ||
          negative.command.some(arg => /[\x00-\x1f]/.test(arg)))
        throw new Error('Negative controls must invoke the same checker with declared verifier-owned invalid fixtures.');
    }
  }
  if (plan.outputs.some(path => !plan.checks.some(check => covers(path, check.baseline_paths)))) throw new Error('Checks must capture every delivered output.');
  if (plan.cornell_output_dir) {
    canonical(root, plan.cornell_output_dir);
    if (['note.md', 'exercises.md', 'answers.md'].some(name => !plan.outputs.includes(`${plan.cornell_output_dir}/${name}`)))
      throw new Error('Cornell output requires note.md, exercises.md and answers.md in delivered outputs and check baselines.');
  }
  if (plan.procedure_candidate) {
    const candidate = plan.procedure_candidate;
    if (!covers(canonical(root, candidate.script), plan.allowed_paths) || !covers(canonical(root, candidate.verification_script), plan.verification_paths) ||
        candidate.effects.network || candidate.effects.publication)
      throw new Error('A reusable candidate must use the assigned producer/checker scripts and local effects.');
  }
  return plan;
}
function readContract(root: string, run: ControlledSnapshot): Contract {
  const bytes = readFileSync(contractPath(root, run.workflow_id, run.epoch_id), 'utf8');
  if (hash(bytes) !== run.contract_hash) throw new Error('Controlled contract changed after planning.');
  const value = JSON.parse(bytes) as Contract;
  if (value.workflow_id !== run.workflow_id || value.epoch_id !== run.epoch_id || value.plan_hash !== hash(JSON.stringify(validatePlan(root, value.plan))))
    throw new Error('Controlled contract identity or semantic baseline changed.');
  if (run.continuation) {
    const old = readNativeSoftwareContract(root, run.workflow_id);
    if (!old || hash(JSON.stringify(old)) !== run.continuation.original_contract_hash) throw new Error('Original continuation contract changed.');
  }
  return value;
}
function mergeOriginalCriteria(root: string, run: ControlledSnapshot, plan: ControlledPlan): ControlledPlan {
  const parent = getRecord(root, run.workflow_id);
  const ids = [...new Set([parent.meta.data.requirement_id, ...(Array.isArray(parent.meta.data.requirement_ids) ? parent.meta.data.requirement_ids : [])])].filter(id => typeof id === 'string') as string[];
  const existing = ids.flatMap(id => { const value = getRecord(root, id).meta.data.acceptance_criteria; return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []; });
  return { ...plan, acceptance_criteria: [...new Set([...existing, ...plan.acceptance_criteria])] };
}

class Controller {
  private closed = false;
  private jobs = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  constructor(readonly root: string) {}
  submit(input: ControlledStartInput): ControlledSnapshot {
    const parsed = z.strictObject({ requirement: z.string().trim().min(1).max(20000).optional(),
      requirements: z.array(z.string().trim().min(1).max(20000)).min(1).max(32).optional(),
      workflow_id: z.string().min(1).optional(), request_id: z.string().trim().min(1).max(256).optional(), title: z.string().trim().min(1).max(256).optional() }).parse(input);
    if (this.closed) throw new Error('Controlled host is closing.');
    requireRoutingPolicy(this.root);
    if (!readAutomationPolicy(this.root).manager_enabled) throw new Error('Project manager is disabled.');
    if (parsed.requirement && parsed.requirements) throw new Error('Provide one requirement or a batch.');
    const request = parsed.request_id ?? randomUUID();
    const existing = parsed.workflow_id ? getRecord(this.root, parsed.workflow_id)
      : loadRecords(this.root).find(r => r.meta.data.request_id === request && r.meta.data.kind === 'manager-workflow');
    if (existing && existsSync(statePath(this.root, existing.meta.id))) {
      const saved = readState(this.root, existing.meta.id);
      if (parsed.requirement && parsed.requirement !== saved.requirement) throw new Error('Receipt already belongs to another request.');
      this.schedule(saved.workflow_id); return saved;
    }
    let original: ReturnType<typeof readNativeSoftwareContract> = null;
    if (existing) {
      // Explicit controlled resumption is append-only. No original mode, criteria or reports are rewritten.
      original = readNativeSoftwareContract(this.root, existing.meta.id);
      if (!original || existing.meta.data.phase === 'completed') throw new Error('Controlled continuation requires an open bounded software contract.');
    }
    const parent = existing ?? beginWorkflow(this.root, { ...parsed, request_id: request, execution_mode: 'neomind-controlled' });
    const run: ControlledSnapshot = { schema_version: 1, workflow_id: parent.meta.id, epoch_id: randomUUID(),
      status: 'queued', phase: 'planning', process_contract: 'software-tools/v2', transport: 'vscode-lm',
      owner_pid: process.pid, owner_instance: readHost(this.root).instance, updated_at: now(), requirement: String(parent.meta.data.original_requirement), title: parent.meta.title,
      revision: 0, request_id: request, attempts: [], checks: [], events: [], repairs: 0, active_invocations: [] };
    if (original) run.continuation = { original_mode: String(parent.meta.data.execution_mode),
      original_fingerprint: hash(JSON.stringify(parent)), original_contract_hash: hash(JSON.stringify(original)) };
    save(this.root, run, 'accepted', 'Request durably accepted by the VS Code owned controller.');
    this.schedule(run.workflow_id);
    return readState(this.root, run.workflow_id);
  }
  private plan(run: ControlledSnapshot, proposed: ControlledPlan): unknown {
    const plan = validatePlan(this.root, mergeOriginalCriteria(this.root, run, proposed));
    if (run.continuation) {
      const original = readNativeSoftwareContract(this.root, run.workflow_id)!;
      for (const key of ['allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'] as const)
        if (!same([...original.plan[key]].sort(), [...plan[key]].sort())) throw new Error('Continuation cannot change the original scope or delivered outputs.');
      if (original.plan.acceptance_criteria.some(item => !plan.acceptance_criteria.includes(item)) || original.plan.checks.some(old => !plan.checks.some(check =>
        same(old.command, check.command) && same(old.baseline_paths, check.baseline_paths) && (old.expected_exit_code ?? 0) === (check.expected_exit_code ?? 0))))
        throw new Error('Continuation must retain every original acceptance criterion and positive check.');
    }
    if (run.contract_hash) {
      const prior = readContract(this.root, run);
      if (!same(prior.plan, plan)) throw new Error('Saved contract is immutable.');
      return { saved: true, next: 'Finish the planning report; runtime dispatches the next stage.' };
    }
    const parent = getRecord(this.root, run.workflow_id);
    const task = run.continuation ? getRecord(this.root, readNativeSoftwareContract(this.root, run.workflow_id)!.task_id)
      : createRecord(this.root, { type: 'task', title: plan.title, owner: 'developer', status: 'ready',
        data: { workflow_id: run.workflow_id, process_contract: 'software-tools/v2', epoch_id: run.epoch_id,
          acceptance_criteria: plan.acceptance_criteria, allowed_paths: plan.allowed_paths, verification_paths: plan.verification_paths,
          outputs: plan.outputs, documentation_paths: plan.documentation_paths }, body: `# Objective\n${plan.objective}\n\n# Acceptance\n${plan.acceptance_criteria.map(x => `- ${x}`).join('\n')}\n` });
    const risk = controlledRisk(plan);
    const contract: Contract = { schema_version: 2, process: 'software-tools', workflow_id: run.workflow_id, epoch_id: run.epoch_id,
      plan, plan_hash: hash(JSON.stringify(plan)), task_id: task.meta.id,
      requirement_ids: [String(parent.meta.data.requirement_id)], reviewer_required: !!run.continuation || risk.reviewer_required,
      risk_reasons: risk.reasons, previous_contract_hash: run.continuation?.original_contract_hash,
      precheck_review: !!run.continuation, ...(run.continuation ? { knowledge_directory: `${readCornellDestination(this.root).directory}/${run.workflow_id.toLowerCase()}` } : {}) };
    const bytes = JSON.stringify(contract, null, 2) + '\n';
    atomicWrite(contractPath(this.root, run.workflow_id, run.epoch_id), bytes);
    run.contract_hash = hash(bytes);
    updateRecord(this.root, run.workflow_id, { data: { controlled_epoch_id: run.epoch_id, controlled_contract_hash: run.contract_hash,
      task_ids: [...new Set([...(Array.isArray(parent.meta.data.task_ids) ? parent.meta.data.task_ids : []), task.meta.id])] } });
    save(this.root, run, 'plan-saved', 'Backend created the bound task and immutable scope/check contract.');
    return { saved: true, reviewer_required: contract.reviewer_required, next: 'Save a compact completed planning report.' };
  }
  private schedule(id: string): void {
    if (this.closed || this.jobs.has(id)) return;
    const state = readState(this.root, id);
    if (['completed', 'cancelled', 'paused', 'blocked', 'uncertain'].includes(state.status)) return;
    const abort = new AbortController();
    const promise = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.drive(id, abort.signal))
      .catch(() => {
        const run = readState(this.root, id);
        if (!['paused', 'interrupted', 'cancelled'].includes(run.status)) {
          run.status = 'blocked'; run.blocker = { kind: 'protocol', message: 'Controller could not reconcile its saved state. Inspect the sanitized trace; no stage was blindly replayed.' };
          save(this.root, run, 'blocked', run.blocker.message);
        }
      }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, { promise, abort });
  }
  private async drive(id: string, signal: AbortSignal): Promise<void> {
    while (!this.closed && !signal.aborted) {
      let run = readState(this.root, id);
      if (!['queued', 'running', 'waiting', 'interrupted'].includes(run.status)) return;
      if (run.attempts.at(-1)?.state === 'running' || run.attempts.at(-1)?.state === 'starting') {
        run.status = 'uncertain'; run.blocker = { kind: 'protocol', message: 'Previous invocation needs reconciliation before resume.' };
        save(this.root, run, 'uncertain', run.blocker.message); return;
      }
      if (run.phase === 'completed') { this.complete(run); return; }
      if (!run.reuse) {
        run.reuse = prepareWork(this.root, { request: run.requirement, request_id: run.request_id,
          environment: { client: 'copilot' }, scope: { mode: 'neomind-controlled', assurance: 'invocation-bound-local', publication: false, network: false } });
        save(this.root, run, 'reuse-inspected', run.reuse.decision);
      }
      const contract = run.contract_hash ? readContract(this.root, run) : undefined;
      const specialistIndex = run.phase === 'implementation' ? (contract?.plan.specialists ?? []).findIndex((_, index) =>
        !run.attempts.some(attempt => attempt.purpose === 'specialist' && attempt.specialist_index === index && attempt.state === 'completed' && attempt.report?.outcome === 'completed')) : -1;
      const specialist = specialistIndex >= 0 ? contract!.plan.specialists![specialistIndex] : undefined;
      const stage = specialist ? 'diagnosis' : run.phase === 'intake' ? 'planning' : run.phase;
      const specialistRoles: Record<string, NativeRole> = { explorer: 'codebase-analyst', planner: 'requirements', architect: 'architect', researcher: 'researcher', curator: 'curator', 'component-owner': 'component-owner' };
      const role: NativeRole = specialist ? specialistRoles[specialist.role] ?? 'architect' : stage === 'planning' || stage === 'diagnosis' || stage === 'synthesis' ? 'manager'
        : stage === 'implementation' ? 'developer' : stage === 'verification' ? 'verifier' : 'reviewer';
      const attempt: Attempt = { id: randomUUID(), request_id: randomUUID(), stage, role, state: 'starting',
        ...(specialist ? { purpose: 'specialist', specialist_index: specialistIndex } : {}),
        ...(stage === 'review' && run.pending_check_review ? { purpose: 'check-review' } : {}) };
      run.attempts.push(attempt); run.status = 'running'; run.owner_pid = process.pid;
      save(this.root, run, 'dispatch', `NeoMind dispatches ${role} for ${stage}.`);
      const binding: ControlledBinding = { workflow_id: id, task_id: stage === 'planning' ? undefined : contract?.task_id,
        stage, role, implementation_paths: contract?.plan.allowed_paths ?? [], verification_paths: contract?.plan.verification_paths ?? [],
        read_paths: ['.'], protected_paths: contract ? this.protectedPaths(contract) : [], check_titles: contract?.plan.checks.map(check => check.title) ?? [] };
      const attemptAbort = new AbortController();
      const abortAttempt = () => attemptAbort.abort(); signal.addEventListener('abort', abortAttempt, { once: true });
      const assertActive = () => {
        const current = readState(this.root, id), last = current.attempts.at(-1);
        if (this.closed || signal.aborted || current.epoch_id !== run.epoch_id || current.status !== 'running' || last?.id !== attempt.id)
          throw new Error('Controlled attempt ended or changed owner.');
        if (current.contract_hash) readContract(this.root, current);
      };
      const callbacks: ControlledCallbacks = {
        assertActive,
        submitPlan: plan => {
          assertActive(); run = readState(this.root, id);
          try { return this.plan(run, plan); }
          catch (error) { throw new ControlledToolError('PLAN_INVALID', error instanceof Error ? error.message : 'The semantic plan is invalid.'); }
        },
        saveReport: report => {
          assertActive(); const current = readState(this.root, id), active = current.attempts.at(-1)!;
          if (['verification', 'review'].includes(stage) && report.outcome === 'completed' && !report.verdict)
            throw new ControlledToolError('VERDICT_REQUIRED', 'Completed independent verification or review must state verdict pass or fail.');
          if (active.report) {
            if (!same(active.report, report)) throw new Error('Attempt already saved a different report.');
            return { saved: true, outcome: report.outcome };
          }
          const artifactPaths = [...new Set([...(report.artifacts ?? []), ...(stage === 'implementation' ? contract!.plan.outputs : []),
            ...(attempt.purpose === 'check-review' ? contract!.plan.verification_paths : []),
            ...(stage === 'synthesis' && contract?.knowledge_directory ? ['note.md', 'exercises.md', 'answers.md'].map(name => `${contract.knowledge_directory}/${name}`) : [])])];
          if (artifactPaths.some(path => !covers(canonical(this.root, path), [...binding.implementation_paths, ...binding.verification_paths, ...(contract?.knowledge_directory ? [contract.knowledge_directory] : [])])) && !['planning', 'diagnosis'].includes(stage))
            throw new ControlledToolError('SCOPE_DENIED', 'Report artifact exceeds assigned scope.');
          active.bound_hashes = fingerprints(this.root, artifactPaths);
          active.report = report;
          const record = createRecord(this.root, { type: stage === 'review' ? 'review' : 'knowledge', title: `${role}: ${current.title}`.slice(0, 256), owner: role,
            data: { kind: 'controlled-work-record', workflow_id: id, task_id: contract?.task_id, invocation_id: active.invocation_id,
              epoch_id: current.epoch_id, outcome: report.outcome, artifact_hashes: active.bound_hashes },
            body: `# Result\n${report.summary}\n\n# Findings\n${(report.findings ?? []).join('\n')}\n\n# Limitations\n${(report.limitations ?? []).join('\n')}\n` });
          active.report_id = record.meta.id;
          save(this.root, current, 'report-saved', `${role} saved ${report.outcome}; acceptance is pending backend evidence.`);
          return { saved: true, outcome: report.outcome, next: 'Return your final concise result. Runtime advances after your actual session completes.' };
        },
        runCheck: title => this.checks(id, attempt.id, attemptAbort.signal, title),
        runProcedure: async parameters => {
          assertActive();
          const reuse = contract?.plan.reuse;
          if (!reuse || parameters && !same(parameters, reuse.parameters)) throw new ControlledToolError('NO_BOUND_PROCEDURE', 'Use the exact parameters of the saved qualified procedure.');
          const preparation = prepareWork(this.root, { request: run.requirement, parameters: reuse.parameters,
            procedure_id: reuse.procedure_id, procedure_version: reuse.version, environment: { client: 'copilot' },
            scope: { allowed_paths: contract!.plan.allowed_paths, network: false, publication: false, mode: 'neomind-controlled', assurance: 'invocation-bound-local' } });
          if (preparation.decision !== 'exact' || !preparation.selected_procedure) throw new ControlledToolError('REUSE_NOT_APPLICABLE', preparation.next_action);
          const procedure = resolveProcedure(this.root, preparation.selected_procedure.id, preparation.selected_procedure.version);
          const result = await runProcedure(this.root, { procedure_id: procedure.id, version: procedure.version, parameters: reuse.parameters,
            request_id: `${run.epoch_id}:procedure:${procedure.contract_hash}`, actor: binding.invocation_id ?? readState(this.root, id).attempts.at(-1)!.invocation_id!,
            client: 'copilot', mode: 'automatic', authorized_effects: { write_roots: contract!.plan.allowed_paths, network: false, publication: false },
            workflow_mode: 'neomind-controlled', assurance: 'invocation-bound-local' }, { signal: attemptAbort.signal });
          const current = readState(this.root, id); current.procedure_runs = [...(current.procedure_runs ?? []), { id: result.id, status: result.status }];
          save(this.root, current, 'procedure-result', `Qualified procedure ${procedure.id}: ${result.status}.`);
          return { status: result.status, outputs: result.outputs, error: result.status === 'succeeded' ? undefined : 'Procedure did not succeed; retained outputs require reconciliation.' };
        },
        compileResearch: input => {
          assertActive();
          const directory = stage === 'synthesis' ? contract?.knowledge_directory : contract?.plan.cornell_output_dir;
          if (!directory) throw new ControlledToolError('NO_CORNELL_OUTPUT', 'The immutable plan does not include a Cornell research bundle.');
          const requirement = getRecord(this.root, contract!.requirement_ids[0]!);
          try {
            const compiled = compileCornellResearch(this.root, { ...input, requirement_id: requirement.meta.id,
              expected_requirement_revision: requirement.meta.revision, workflow_id: id, task_id: contract!.task_id,
              owner: role, output_dir: directory } as CornellResearchInput);
            const note = createCornellNote(this.root, compiled.note);
            const current = readState(this.root, id); current.cornell_note_ids = [...new Set([...(current.cornell_note_ids ?? []), note.meta.id])];
            save(this.root, current, 'cornell-compiled', 'Research note, exercises and separate answers compiled by the existing Cornell formatter.');
            return { saved: true, artifacts: [`${directory}/note.md`, `${directory}/exercises.md`, `${directory}/answers.md`] };
          } catch (error) { throw new ControlledToolError('CORNELL_INVALID', error instanceof Error ? error.message : 'Research did not satisfy the Cornell format.'); }
        },
        prepareWork: query => prepareWork(this.root, { request: query.request, parameters: query.parameters,
          environment: { client: 'copilot' }, scope: { allowed_paths: contract?.plan.allowed_paths ?? [], network: false, publication: false,
            mode: 'neomind-controlled', assurance: 'invocation-bound-local' } }),
        trace: event => {
          const current = readState(this.root, id), traceId = randomUUID();
          // The facade supplies allowlisted content hashes/path metadata, never credentials or raw provider errors.
          atomicWrite(safePath(this.root, `.neomind/controlled/traces/${traceId}.json`), JSON.stringify({ ...event,
            workflow_id: id, epoch_id: current.epoch_id, attempt_id: attempt.id }, null, 2) + '\n');
          save(this.root, current, 'tool', `Semantic tool ${String(event.tool ?? 'operation')}: ${String(event.status ?? event.event ?? 'request')}; trace ${traceId}`);
        },
      };
      const unregister = registerControlledContext(this.root, attempt.request_id, { binding, callbacks, epoch_id: run.epoch_id,
        bindInvocation: invocation => {
          const current = readState(this.root, id), active = current.attempts.at(-1)!;
          if (active.id !== attempt.id || active.invocation_id && active.invocation_id !== invocation) throw new Error('Attempt invocation binding changed.');
          active.invocation_id = invocation; active.state = 'running'; save(this.root, current);
          const dispatch = [...current.events].reverse().find(event => event.kind === 'dispatch' && !event.invocation_id);
          if (dispatch) { dispatch.invocation_id = invocation; save(this.root, current); }
        } });
      try {
        const prompt = this.prompt(run, stage, contract) + (specialist ? `\n\nBounded specialist consultation: ${specialist.objective}. Inspect and report your findings; this is a consultation, not a repair diagnosis.` : '');
        let receipt = await startNative(this.root, { role, prompt, workflow_id: id, task_id: binding.task_id, request_id: attempt.request_id });
        while (invocationIsActive(receipt) && !signal.aborted) receipt = await waitNative(this.root, receipt.id, 1000);
        if (signal.aborted) { await interruptNative(this.root, receipt.id); return; }
        run = readState(this.root, id);
        const active = run.attempts.at(-1)!;
        active.invocation_id = receipt.id; active.state = 'completed'; run.active_invocations = [];
        save(this.root, run, 'returned', `${role} session returned ${receipt.state}.`);
        if (receipt.state !== 'completed' || !active.report) {
          const kind = receipt.state === 'completed' ? 'protocol' : 'environment';
          const message = receipt.state === 'completed' ? 'Session ended without its required typed result. Saved work is retained; inspect current artifacts then save the missing compact result.'
            : receipt.error ?? 'Model session did not complete.';
          const hardFailure = /NoPermissions|NotFound|access denied|permission|policy|configuration changed|cancelled|canceled/i.test(message);
          if (!hardFailure && this.repair(run, kind, message)) continue;
          this.block(run, kind, message); return;
        }
        if (active.report.outcome !== 'completed') {
          if (!this.repair(run, active.report.failure_kind ?? 'unknown', active.report.summary)) return;
          continue;
        }
        if (specialist) { run.status = 'queued'; save(this.root, run, 'consultation-complete', `${role} consultation saved.`); continue; }
        if (stage === 'planning') {
          if (!run.contract_hash) { this.block(run, 'protocol', 'Planning session returned without saving a semantic plan.'); return; }
          run.phase = 'implementation';
        } else if (stage === 'implementation') run.phase = 'verification';
        else if (stage === 'verification') {
          if (contract?.precheck_review && !this.checkApproval(run, contract)) {
            run.pending_check_review = true; run.phase = 'review'; run.status = 'queued'; save(this.root, run, 'check-review-needed', 'Original contract requires independent approval of exact checker bytes before executing pilots.'); continue;
          }
          await this.checks(id, attempt.id, signal);
          if (signal.aborted) return;
          run = readState(this.root, id);
          const evidence = run.checks.filter(check => check.attempt_id === attempt.id);
          if (!evidence.length || evidence.some(check => !check.passed) || active.report.verdict !== 'pass') {
            if (!this.repair(run, active.report.failure_kind ?? 'unknown', active.report.summary)) return;
            continue;
          }
          run.phase = contract?.knowledge_directory && !run.cornell_note_ids?.length ? 'synthesis' : readContract(this.root, run).reviewer_required ? 'review' : 'completed';
        } else if (stage === 'review') {
          if (active.report.verdict !== 'pass') { if (!this.repair(run, active.report.failure_kind ?? 'unknown', active.report.summary)) return; continue; }
          if (attempt.purpose === 'check-review') { delete run.pending_check_review; run.phase = 'verification'; }
          else run.phase = 'completed';
        } else if (stage === 'synthesis') {
          if (!run.cornell_note_ids?.length) { this.block(run, 'protocol', 'Final synthesis must save the requested Cornell note.'); return; }
          run.phase = 'review';
        } else {
          const kind = active.report.failure_kind;
          if (!kind || kind === 'unknown' || !this.repair(run, kind, active.report.summary, true)) { this.block(run, 'unknown', 'Diagnosis could not assign a bounded safe repair.'); return; }
          continue;
        }
        run.status = 'queued'; save(this.root, run, 'transition', `Backend selected ${run.phase}.`);
        if (run.phase === 'completed') { this.complete(run); return; }
      } finally { attemptAbort.abort(); signal.removeEventListener('abort', abortAttempt); unregister(); }
    }
  }
  private prompt(run: ControlledSnapshot, stage: Stage, contract?: Contract): string {
    return [
      `User requirement:\n${run.requirement}`,
      `Your stage: ${stage}. Use only the supplied semantic tools. Runtime owns identity, records, transitions and checks.`,
      stage === 'planning' ? 'Inspect the project and existing scripts. Save one bounded workflow_plan, then assignment_report. Define an independently authored checker in verification_paths, disjoint from implementation paths. Use explicit check argv. Keep ordinary work low-risk; elevate real security/storage/runtime changes.' : '',
      contract ? `Immutable plan:\n${JSON.stringify(contract.plan)}` : '',
      contract?.knowledge_directory ? `Managed final knowledge destination: ${contract.knowledge_directory}. Coordinator synthesis must compile a separate evidence-derived research Cornell bundle after checks and before final review.` : '',
      run.pending_check_review ? 'This is the original contract required pre-execution check review. Read the exact checker source and protected cases; pass only if the checker/oracle and negative controls are adequate. No check execution is claimed yet.' : '',
      run.continuation && !contract ? `Original saved plan, scope, outputs, criteria and positive checks must be retained. Reuse it; only add explicit negative controls in its existing verification scope:\n${JSON.stringify(readNativeSoftwareContract(this.root, run.workflow_id)!.plan)}` : '',
      run.reuse?.manager_brief ?? '',
      `Cornell destination default: ${readCornellDestination(this.root).directory}/${run.workflow_id.toLowerCase()}. Only add a Cornell bundle when requested by the user.`,
      run.blocker ? `Repair/diagnosis context:\n${JSON.stringify(run.blocker)}` : '',
      `Prior reports:\n${JSON.stringify(run.attempts.filter(item => item.report).slice(-4).map(item => ({ stage: item.stage, report: item.report })))}`,
      stage === 'verification' ? 'Independently inspect implementation, author only checker files, execute check_run, and report pass/fail. Include negative controls that prove bad output fails. Distinguish product defects from checker defects.' : '',
      stage === 'review' ? 'Review the actual change, acceptance criteria and current checks independently. Save assignment_report with verdict pass or fail.' : '',
      stage === 'diagnosis' ? 'Diagnose existing evidence without modifying files. Report failure_kind implementation/checker/protocol/environment, concrete findings, and bounded repair direction.' : '',
    ].filter(Boolean).join('\n\n');
  }
  private async checks(id: string, attemptId: string, signal: AbortSignal, title?: string): Promise<unknown> {
    let run = readState(this.root, id);
    const contract = readContract(this.root, run), attempt = run.attempts.find(item => item.id === attemptId);
    if (!attempt?.invocation_id || attempt.stage !== 'verification') throw new Error('Only the bound Verifier can run planned checks.');
    if (contract.precheck_review && !this.checkApproval(run, contract))
      return { status: 'awaiting-independent-check-review', next: 'Save a completed preparation report with verdict pass and the actual checker artifacts. Runtime obtains exact-byte review before executing these checks.' };
    const selected = contract.plan.checks.filter(check => title === undefined || check.title === title).flatMap(check => [
      { ...check, negative: false }, ...(check.negative_controls ?? []).map(negative => ({ ...negative, timeout_ms: check.timeout_ms, negative: true })),
    ]);
    if (!selected.length) throw new Error('Choose a check title from the assigned plan.');
    for (const check of selected) {
      run = readState(this.root, id);
      const baseline = fingerprints(this.root, check.baseline_paths);
      const prior = run.checks.find(item => item.attempt_id === attemptId && item.title === check.title && same(item.baseline, baseline));
      if (prior) continue;
      const checkId = randomUUID(), logPath = `.neomind/controlled/checks/${checkId}.log`;
      save(this.root, run, 'check-start', check.title);
      const result = await runCommand({ command: check.command, cwd: this.root, signal, timeout_ms: check.timeout_ms ?? 60000 });
      const log = JSON.stringify({ command: check.command, baseline, result }, null, 2) + '\n';
      atomicWrite(safePath(this.root, logPath), log);
      run = readState(this.root, id);
      run.checks.push({ id: checkId, attempt_id: attemptId, invocation_id: attempt.invocation_id, title: check.title,
        command: check.command, baseline, log_path: logPath, log_sha256: hash(log), exit_code: result.exit_code,
        expected_exit_code: check.expected_exit_code ?? 0, negative: check.negative,
        passed: result.exit_code === (check.expected_exit_code ?? 0) && !result.cancelled && !result.timed_out && !result.output_limited && !result.error && same(baseline, fingerprints(this.root, check.baseline_paths)),
        cancelled: result.cancelled, at: now() });
      save(this.root, run, 'check-result', `${check.title}: ${run.checks.at(-1)!.passed ? 'passed' : 'failed'}.`);
      if (signal.aborted) break;
    }
    run = readState(this.root, id);
    return { checks: run.checks.filter(item => item.attempt_id === attemptId).map(item => ({ title: item.title, passed: item.passed, exit_code: item.exit_code, evidence: item.log_path })) };
  }
  private repair(run: ControlledSnapshot, kind: FailureKind, message: string, diagnosed = false): boolean {
    const max = readConfig(this.root).repair_attempts;
    if (run.repairs >= max) { this.block(run, kind, `Repair budget exhausted. ${message}`); return false; }
    run.blocker = { kind, message: message.slice(0, 2000) };
    if (kind === 'unknown' && !diagnosed) run.phase = 'diagnosis';
    else if (kind === 'implementation') { run.phase = 'implementation'; run.repairs++; }
    else if (kind === 'checker') { run.phase = 'verification'; run.repairs++; }
    else if (kind === 'protocol' || kind === 'environment') { run.repairs++; }
    else { this.block(run, kind, message); return false; }
    run.status = 'queued'; save(this.root, run, 'repair', `Backend routes ${kind} to ${run.phase}.`); return true;
  }
  private block(run: ControlledSnapshot, kind: FailureKind, message: string): void {
    run.status = 'blocked'; run.blocker = { kind, message: message.slice(0, 2000) };
    save(this.root, run, 'blocked', run.blocker.message);
  }
  private protectedPaths(contract: Contract): string[] {
    const task = getRecord(this.root, contract.task_id);
    const paths = task.meta.data.protected_acceptance_paths;
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
  }
  private checkApproval(run: ControlledSnapshot, contract: Contract): boolean {
    const approved = [...run.attempts].reverse().find(attempt => attempt.purpose === 'check-review' && attempt.state === 'completed' && attempt.report?.verdict === 'pass');
    if (!approved?.invocation_id || !approved.bound_hashes) return false;
    const hashes = fingerprints(this.root, contract.plan.verification_paths);
    return Object.entries(hashes).every(([path, sha]) => approved.bound_hashes?.[path] === sha) &&
      !routingProblems(this.root, 'reviewer', approved.invocation_id, { workflow_id: run.workflow_id }).length;
  }
  private complete(run: ControlledSnapshot): void {
    const contract = readContract(this.root, run);
    const latest = (stage: Stage) => [...run.attempts].reverse().find(item => item.stage === stage && item.state === 'completed');
    const producer = latest('implementation'), verifier = latest('verification'), reviewer = latest('review'), synthesis = latest('synthesis');
    for (const attempt of [producer, verifier, ...(contract.reviewer_required ? [reviewer] : []), ...(contract.knowledge_directory ? [synthesis] : [])]) {
      if (!attempt?.invocation_id || attempt.report?.outcome !== 'completed') throw new Error('Required completed independent result missing.');
      const receipt = readInvocation(this.root, attempt.invocation_id);
      if (routingProblems(this.root, attempt.role, receipt.id, { workflow_id: run.workflow_id }).length ||
          receipt.issuer !== 'neomind-vscode-lm' || !receipt.inference_completed) throw new Error('Actual owned session evidence is invalid.');
      if (!same(attempt.bound_hashes, fingerprints(this.root, Object.keys(attempt.bound_hashes ?? {})))) throw new Error('Reported artifacts changed after their result.');
    }
    if (producer!.invocation_id === verifier!.invocation_id || reviewer?.invocation_id === producer!.invocation_id) throw new Error('Verification/review must be independent.');
    if (verifier!.report!.verdict !== 'pass') throw new Error('Independent verifier did not pass.');
    if (contract.reviewer_required && reviewer?.report?.verdict !== 'pass') throw new Error('Independent review did not pass.');
    const checks = run.checks.filter(check => check.attempt_id === verifier!.id);
    if (!contract.plan.checks.every(check => checks.some(result => result.title === check.title && result.passed &&
      result.log_sha256 === hash(readFileSync(safePath(this.root, result.log_path))) && same(result.baseline, fingerprints(this.root, check.baseline_paths))))) throw new Error('Fresh independent check evidence missing.');
    if (!contract.plan.checks.every(check => check.negative_controls?.every(negative => checks.some(result => result.negative && result.title === negative.title &&
        result.passed && result.expected_exit_code === negative.expected_exit_code && result.log_sha256 === hash(readFileSync(safePath(this.root, result.log_path))) &&
        same(result.baseline, fingerprints(this.root, negative.baseline_paths)))))) throw new Error('Actual negative-control evidence missing.');
    const output = fingerprints(this.root, contract.plan.outputs);
    if (Object.values(output).some(value => value === 'missing')) throw new Error('Delivered output missing.');
    if ((contract.plan.cornell_output_dir || contract.knowledge_directory) && (!run.cornell_note_ids?.length || run.cornell_note_ids.some(id => !validateCornellNote(this.root, id).ok)))
      throw new Error('Requested Cornell output must pass its existing formatter and structural validation.');
    if (contract.plan.procedure_candidate && !run.procedure_candidate_id) {
      const candidate = registerProcedure(this.root, { ...contract.plan.procedure_candidate,
        id: `workflow-${hash(run.workflow_id).slice(0, 24)}`, version: '1.0.0', author: producer!.invocation_id! });
      run.procedure_candidate_id = candidate.id; save(this.root, run, 'procedure-registered', 'Reusable scripts registered as a candidate; qualification still requires independent review and real uses.');
    }
    const report = run.finalizing_report_id ? getRecord(this.root, run.finalizing_report_id) : createRecord(this.root, { type: 'knowledge', title: `Completed: ${contract.plan.title}`.slice(0, 256), owner: 'manager',
      data: { kind: 'controlled-final-report', workflow_id: run.workflow_id, epoch_id: run.epoch_id, contract_hash: run.contract_hash,
        invocation_ids: [producer!.invocation_id, verifier!.invocation_id, reviewer?.invocation_id].filter(Boolean),
        evidence: checks.map(check => check.log_path), output_hashes: output, cornell_note_ids: run.cornell_note_ids ?? [], assurance: 'invocation-bound-local' },
      body: `# Result\n${producer!.report!.summary}\n\n# Independent verification\n${verifier!.report!.summary}\n\n# Evidence\n${checks.map(check => `- ${check.log_path}`).join('\n')}\n\n# Limitations\nModel identities are local VS Code vendor/model observations; upstream 9router model identity is unverified.\n` });
    if (!run.finalizing_report_id) { run.finalizing_report_id = report.meta.id; save(this.root, run, 'finalizing', 'Validated closure intent saved.'); }
    saveStatus(this.root, contract.task_id, 'accepted', () => { readContract(this.root, run); });
    saveWorkflowClosure(this.root, run.workflow_id, { data: { phase: 'completed', final_report_id: report.meta.id,
      closed_at: now(), controlled_epoch_id: run.epoch_id, controlled_contract_hash: run.contract_hash } }, () => { readContract(this.root, run); });
    saveStatus(this.root, run.workflow_id, 'accepted', () => { readContract(this.root, run); });
    run.final_report_id = report.meta.id; run.status = 'completed'; run.phase = 'completed'; delete run.blocker;
    save(this.root, run, 'completed', 'Actual independent checks and required review passed; workflow accepted.');
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<ControlledSnapshot> {
    const run = readState(this.root, id);
    if (run.status === 'completed' || run.status === 'cancelled') return run;
    const job = this.jobs.get(id);
    if (action !== 'resume') {
      run.status = action === 'cancel' ? 'cancelled' : 'paused'; save(this.root, run, action, `User requested ${action}.`);
      job?.abort.abort();
      const active = run.attempts.at(-1);
      if (active?.invocation_id) await interruptNative(this.root, active.invocation_id);
      await job?.promise;
      const current = readState(this.root, id), last = current.attempts.at(-1);
      if (last && last.state !== 'completed') last.state = 'interrupted';
      save(this.root, current); return current;
    }
    if (job) return readState(this.root, id);
    const last = run.attempts.at(-1);
    if (last && ['running', 'starting'].includes(last.state)) {
      if (last.invocation_id && invocationIsActive(readInvocation(this.root, last.invocation_id))) {
        run.status = 'uncertain'; save(this.root, run, 'uncertain', 'Previous owner needs reconciliation before another invocation.'); return run;
      }
      last.state = 'interrupted';
    }
    run.status = 'queued'; run.owner_pid = process.pid; run.owner_instance = readHost(this.root).instance; delete run.blocker;
    save(this.root, run, 'resume', 'Resume from durable contract and prior results.'); this.schedule(id); return run;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.jobs.keys()].map(async id => {
      await this.control(id, 'pause');
      const run = readState(this.root, id); if (run.status === 'paused') { run.status = 'interrupted'; save(this.root, run, 'interrupted', 'VS Code owner closed.'); }
    }));
  }
}

/** Called only by the explicitly enabled VS Code Bridge owner; MCP clients never own execution. */
export async function startControlledHost(root: string): Promise<{ close(): Promise<void> }> {
  root = exactRoot(root);
  if (readHost(root).pid !== process.pid) throw new Error('Controlled owner must be the enabled VS Code host process.');
  if (hosts.has(root)) throw new Error('Controlled owner already enabled for this project.');
  const controller = new Controller(root); hosts.set(root, controller);
  return { close: async () => { await controller.close(); if (hosts.get(root) === controller) hosts.delete(root); } };
}
export async function dispatchControlledHost(root: string, operation: string, input: any): Promise<unknown> {
  const owner = hosts.get(exactRoot(root));
  if (!owner) throw new Error('Enable the controlled workflow host in VS Code first.');
  if (operation === 'controlled-start') return owner.submit(input);
  if (operation === 'controlled-control') {
    const value = z.strictObject({ workflow_id: z.string().min(1), action: z.enum(['pause', 'resume', 'cancel']) }).parse(input);
    return owner.control(value.workflow_id, value.action);
  }
  if (operation === 'controlled-status') return controlledStatus(root, input.workflow_id);
  throw new Error('Unknown controlled host operation.');
}
export async function startControlledWorkflow(root: string, input: ControlledStartInput): Promise<ControlledSnapshot> {
  return hostRequest(readHost(root), 'controlled-start', input);
}
export async function controlControlledWorkflow(root: string, input: { workflow_id: string; action: 'pause' | 'resume' | 'cancel' }): Promise<ControlledSnapshot> {
  return hostRequest(readHost(root), 'controlled-control', input);
}
export function controlledStatus(root: string, workflowId?: string): ControlledSnapshot | ControlledSnapshot[] {
  if (!workflowId) {
    const dir = safePath(root, states);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const run = JSON.parse(readFileSync(safePath(root, `${states}/${name}`), 'utf8'));
      return controlledStatus(root, run.workflow_id) as ControlledSnapshot;
    }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  const run = readState(root, workflowId);
  let live = false; try { const owner = readHost(root); live = owner.pid === run.owner_pid && owner.instance === run.owner_instance; } catch { /* Last durable checkpoint remains readable. */ }
  run.active_invocations = [];
  for (const attempt of run.attempts.filter(item => item.state === 'running' && item.invocation_id)) {
    try {
      const receipt = readInvocation(root, attempt.invocation_id!);
      run.active_invocations.push({ id: receipt.id, role: receipt.role, state: live ? receipt.state : 'uncertain', requested_model: receipt.requested_model,
        confirmed_model: receipt.confirmed_model, provider: receipt.model_provider });
    } catch { /* Invalid provenance never becomes running. */ }
  }
  if (!live && ['queued', 'running', 'waiting'].includes(run.status)) run.status = 'uncertain';
  return run;
}
export function hasControlledWorkflow(root: string, id: string): boolean { return existsSync(statePath(root, id)); }
