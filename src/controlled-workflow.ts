import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, posix, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { atomicWrite, createRecord, getRecord, hash, loadRecords, now, readConfig, safePath,
  saveStatus, saveWorkflowClosure, updateRecord, withOperationLock } from './storage.js';
import { beginWorkflow, readAutomationPolicy } from './manager.js';
import { startNative, waitNative, interruptNative, nativeStatus } from './native.js';
import { canonicalJson, invocationIsActive, readInvocation, requireRoutingPolicy, routingProblems, type NativeRole } from './routing.js';
import { exactRoot, hostRequest, readHost } from './vscode-wire.js';
import { registerControlledContext } from './controlled-context.js';
import { prepareWork, type WorkPreparation } from './procedure-reuse.js';
import { runCommand } from './command-runner.js';
import { readNativeSoftwareContract } from './native-software.js';
import type { ControlledBinding, ControlledCallbacks, ControlledPlan, ControlledReport } from './controlled-tools.js';
import { ControlledToolError, controlledReviewInstructions, controlledPublicReferencePath, controlledSkillInputPath, controlledToolNames } from './controlled-tools.js';
import { controlledRuntimeContextGuide, controlledToolchain } from './controlled-runtime-context.js';
import { controlledExecutionSchema, controlledExecutionDeclarationSchema, ControlledExecutionError,
  prepareControlledExecution, runControlledExecution, rollbackControlledExecutionOutputs, type ControlledExecutionInput } from './controlled-execution.js';
import { normalizeControlledCornellSources, existingControlledCornellNote, controlledCornellResult, bindControlledCornellPractice, bindControlledCornellDemonstration, type ControlledCornellSourceContext, type ControlledCornellResult } from './controlled-cornell-sources.js';
import { registerProcedure, resolveProcedure, runProcedure } from './procedures.js';
import { compileCornellResearch, readCornellDestination, type CornellResearchInput } from './cornell-workflow.js';
import { createCornellNote, validateCornellNote } from './notes.js';
import { controlledFailure } from './controlled-failure.js';
import { continuationObligations, controlledFingerprints, controlledFingerprintsAsync, executeControlledPilot, materializeControlledEvidence,
  prepareControlledCheckEvidence, verifyControlledTask, controlledContractForTask, type ContinuationObligations } from './controlled-acceptance.js';
import { evidenceRecordFingerprint, type EvidenceInputSnapshot } from './evidence-inputs.js';
import type { ProjectRecord } from './types.js';
import { normalizeControlledPlanInput, controlledConsultationRole } from './controlled-plan-input.js';
import { controlledPlanConflicts, type ControlledPlanConflict } from './controlled-plan-queue.js';
import { controlledPlanningRecovery } from './controlled-recovery-context.js';
import { controlledRegistrationEvidence } from './controlled-registration-evidence.js';
import { assertControlledReadBaseline } from './controlled-read-baselines.js';
import { ControlledOperationDrain } from './controlled-operation-drain.js';
import { assertControlledPayloadCurrent, ControlledPayloadError, type ControlledPayloadSource } from './controlled-payload.js';
import { persistControlledCornellNote, ControlledCornellWriteError } from './controlled-cornell-write.js';
import { controlledReviewContext } from './controlled-review-context.js';
import { evidenceReportPaths, pendingEvidenceDocumentation, controlledChecksForPhase, type EvidenceDocumentationSource } from './controlled-report-phase.js';
import { controlledCornellDirectories, controlledKnowledgeFreshness } from './controlled-cornell-selection.js';
import { assertEvidenceDocumentationAuthority } from './controlled-report-authority.js';
import { readCheckReconciliations, unresolvedControlledChecks, recheckBeforeReconciledResume, normalizedMaintenanceInput,
  prepareInterruptedCheckReconciliation, reconciliationPath, maintenanceLockKey, type InterruptedCheckMaintenanceInput,
  type InterruptedCheckReconciliationLink } from './controlled-check-reconciliation.js';

type Stage = ControlledBinding['stage'];
export type ControlledState = 'queued' | 'running' | 'waiting' | 'paused' | 'interrupted' | 'uncertain' | 'blocked' | 'cancelled' | 'completed';
type FailureKind = 'implementation' | 'checker' | 'protocol' | 'environment' | 'unknown';
interface Event { id: string; at: string; kind: string; stage: Stage | 'intake'; invocation_id?: string; summary: string }
interface Attempt {
  id: string; request_id: string; stage: Stage; role: NativeRole; invocation_id?: string;
  state: 'starting' | 'running' | 'completed' | 'interrupted'; purpose?: 'specialist' | 'diagnosis' | 'check-review' | 'evidence-documentation'; specialist_index?: number;
  documentation_source?: EvidenceDocumentationSource;
  report?: ControlledReport; report_id?: string; report_fingerprint?: string; bound_hashes?: Record<string, string>; checked?: boolean;
}
export interface ControlledCheckReceipt {
  id: string; attempt_id: string; invocation_id: string; title: string; command: string[];
  baseline: Record<string, string>; log_path: string; log_sha256: string;
  exit_code: number | null; expected_exit_code: number; negative: boolean; passed: boolean; cancelled: boolean; at: string;
  planned_command?: string[]; purpose?: 'self-check' | 'intended-use'; evidence_id?: string;
  evidence_input?: { check_id: string; check_fingerprint: string; record_baseline: Record<string, string>; input_snapshot: EvidenceInputSnapshot };
  pilot_receipt_path?: string; pilot_receipt_hash?: string;
}
export interface ControlledContract { schema_version: 2; process: 'software-tools'; workflow_id: string; epoch_id: string;
  plan: ControlledPlan; plan_hash: string; task_id: string; requirement_ids: string[];
  requirement_fingerprints: Record<string, string>; preserved_hashes: Record<string, string>;
  reviewer_required: boolean; risk_reasons: string[]; previous_contract_hash?: string; precheck_review: boolean; knowledge_directory?: string;
  continuation?: { original_task_id: string; original_task_fingerprint: string; original_contract_path: string;
    original_contract_sha256: string; obligations: ContinuationObligations } }
type Contract = ControlledContract;
export interface ControlledSnapshot {
  schema_version: 1; workflow_id: string; epoch_id: string; status: ControlledState; phase: Stage | 'intake' | 'completed';
  process_contract: 'software-tools/v2'; transport: 'vscode-lm'; owner_pid: number; updated_at: string;
  owner_instance: string;
  requirement: string; title: string; revision: number; request_id: string; contract_hash?: string;
  attempts: Attempt[]; checks: ControlledCheckReceipt[]; events: Event[]; repairs: number;
  active_invocations: { id: string; role: string; state: string; requested_model: string; confirmed_model: string | null; provider: string | null }[];
  blocker?: { kind: FailureKind; message: string; code?: string; trace_id?: string; owner?: string; next_action?: string }; reuse?: WorkPreparation; final_report_id?: string;
  continuation?: { original_mode: string; original_fingerprint: string; original_contract_hash: string };
  intake_recovery?: { code: 'INTAKE_OUTCOME_UNCERTAIN'; observed_records: string[]; observed_invocations: string[]; observed_artifacts: string[] };
  repair_budget?: { schema_version: 1; product: number; protocol: number; environment: number };
  repair_counter_migration?: { legacy_count: number; product: number; protocol: number; environment: number };
  role_handoff?: { attempt_id: string; task_id: string; denial_trace: string; target_path: string; legacy_trace: boolean };
  finalizing_report_id?: string;
  procedure_runs?: { id: string; status: string }[]; procedure_candidate_id?: string; procedure_candidate_version?: string; cornell_note_ids?: string[];
  cornell_results?: ControlledCornellResult[];
  check_reconciliations?: InterruptedCheckReconciliationLink[];
  pending_plan?: { plan: ControlledPlan; attempt_id: string; parent_fingerprint: string;
    requirement_fingerprints: Record<string, string>; conflicts: ControlledPlanConflict[]; payload_source?: ControlledPayloadSource };
  pending_documentation?: EvidenceDocumentationSource;
  local_executions?: { id: string; attempt_id: string; request_hash: string; title: string; state: 'running' | 'completed';
    pid?: number; intent_path: string; intent_sha256: string; result_path?: string; result_sha256?: string; passed?: boolean }[];
  pending_check_review?: boolean;
  check_intents?: { id: string; attempt_id: string; title: string; baseline: Record<string, string>;
    state: 'starting' | 'running' | 'completed'; pid?: number; pilot_root?: string; pilot_nonce?: string }[];
}
export interface ControlledStartInput { requirement?: string; requirements?: string[]; workflow_id?: string; request_id?: string; title?: string }
/** Current evidence belongs to the latest Verifier, even before that attempt has produced receipts. */
export function currentControlledChecks(run: Pick<ControlledSnapshot, 'attempts' | 'checks'>): ControlledCheckReceipt[] {
  const verifier = run.attempts.findLast(attempt => attempt.stage === 'verification');
  return verifier ? run.checks.filter(check => check.attempt_id === verifier.id) : [];
}
/** Repair diagnostics retain old checks; new knowledge may cite only a later independent Verifier. */
export function currentControlledCornellChecks(run: Pick<ControlledSnapshot, 'attempts' | 'checks'>): ControlledCheckReceipt[] {
  return run.attempts.findLastIndex(item => item.stage === 'verification') >
    run.attempts.findLastIndex(item => item.stage === 'implementation') ? currentControlledChecks(run) : [];
}
const controlledStartSchema = z.strictObject({ requirement: z.string().trim().min(1).max(20000).optional(),
  requirements: z.array(z.string().trim().min(1).max(20000)).min(1).max(32).optional(),
  workflow_id: z.string().min(1).optional(), request_id: z.string().trim().min(1).max(256).optional(), title: z.string().trim().min(1).max(256).optional() });
const states = '.neomind/controlled/workflows';
const hosts = new Map<string, Controller>();
const statePath = (root: string, id: string) => safePath(root, `${states}/${hash(id)}.json`);
const contractPath = (root: string, id: string, epoch: string) => safePath(root, `${states}/${hash(id)}.${epoch}.contract.json`);
function assertSupportedContinuation(criteria: string[]): void {
  if (continuationObligations(criteria).pilot_kind === 'unsupported-generic')
    throw new ControlledToolError('CONTINUATION_PILOT_UNSUPPORTED', 'The original contract requires an intended-use pilot for a task family without a reviewed runtime adapter. Its obligations remain open; define that adapter before controlled continuation. NeoMind will not substitute LeetCode, Cornell or C/C++ requirements.');
}
function assertIntakePayload(parent: ProjectRecord, input: ControlledStartInput): void {
  if (parent.meta.type !== 'knowledge' || parent.meta.data.kind !== 'manager-workflow')
    throw new ControlledToolError('WORKFLOW_REQUIRED', 'Select an actual NeoMind manager workflow receipt before continuing saved work.');
  const supplied = input.requirements ?? (input.requirement ? [input.requirement] : undefined);
  const original = parent.meta.data.original_requirements ?? [parent.meta.data.original_requirement];
  if (supplied && canonicalJson(supplied.map(value => value.trim())) !== canonicalJson(original) ||
      input.title && parent.meta.title !== `Workflow: ${input.title.trim()}`)
    throw new ControlledToolError('INTAKE_PAYLOAD_MISMATCH', 'The saved request identity belongs to a different requirement or title. Keep that receipt unchanged; submit an intentional new task through a new intake identity.');
}
/** Derive only exact saved backend events; unclassified old usage remains product usage. */
export function controlledRepairBudget(run: Pick<ControlledSnapshot, 'repairs' | 'repair_budget' | 'events'>) {
  const number = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!number(run.repairs)) throw new ControlledToolError('REPAIR_STATE_UNCERTAIN', 'Saved repair usage requires runtime reconciliation.');
  if (run.repair_budget) {
    const saved = run.repair_budget;
    if (saved.schema_version !== 1 || !number(saved.product) || !number(saved.protocol) || !number(saved.environment) || saved.product !== run.repairs)
      throw new ControlledToolError('REPAIR_STATE_UNCERTAIN', 'Saved repair counters disagree; existing results must be reconciled.');
    return { ...saved };
  }
  const known = { product: 0, protocol: 0, environment: 0 };
  for (const event of run.events) {
    if (event.kind !== 'repair') continue;
    const kind = /^Backend routes (implementation|checker|protocol|environment) to (?:planning|implementation|verification|review|diagnosis|synthesis)\.$/.exec(event.summary)?.[1];
    if (kind === 'implementation' || kind === 'checker') known.product++;
    else if (kind === 'protocol') known.protocol++;
    else if (kind === 'environment') known.environment++;
  }
  const unknown = Math.max(0, run.repairs - known.product - known.protocol - known.environment);
  return { schema_version: 1 as const, product: known.product + unknown, protocol: known.protocol, environment: known.environment };
}
/** An absent journal is recoverable only before any execution could have begun. */
function orphanedIntakeEffects(root: string, parent: ProjectRecord) {
  const records = loadRecords(root).filter(record => record.meta.id !== parent.meta.id && record.meta.data.workflow_id === parent.meta.id);
  const invocations: { id: string; epoch?: string }[] = [];
  const receipts = safePath(root, '.neomind/native/receipts');
  let receiptCount = 0;
  if (existsSync(receipts)) for (const name of readdirSync(receipts).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    if (++receiptCount > 4096) { invocations.push({ id: 'receipt-scan-limit' }); break; }
    // Existence is an uncertainty signal, never authenticated completion evidence.
    // A damaged matching receipt must not authorize a fresh model invocation.
    try {
      const path = safePath(root, `.neomind/native/receipts/${name}`), info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) { invocations.push({ id: 'unreadable-receipt' }); continue; }
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.workflow_id === parent.meta.id) invocations.push({ id: name.slice(0, -5), epoch: receipt.controlled_execution?.epoch_id });
    } catch { invocations.push({ id: 'unreadable-receipt' }); }
  }
  const artifacts: string[] = [], observedEpochs: string[] = [];
  const created = Date.parse(parent.meta.created_at), queue = [
    { path: '.neomind/controlled/traces', depth: 0 }, { path: '.neomind/controlled/checks', depth: 0 },
    { path: '.neomind/controlled/pilots', depth: 0 }, { path: '.neomind/controlled-tools', depth: 0 },
  ];
  let examined = 0;
  while (queue.length) {
    const entry = queue.shift()!, directory = safePath(root, entry.path);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      if (++examined > 4096) { artifacts.push('controlled-signal-scan-limit'); queue.length = 0; break; }
      const path = `${entry.path}/${name}`, full = safePath(root, path), info = lstatSync(full);
      if (info.isSymbolicLink()) { artifacts.push(path); continue; }
      if (info.isDirectory()) { if (entry.depth < 4) queue.push({ path, depth: entry.depth + 1 }); else artifacts.push(path); continue; }
      if (!info.isFile() || !/\.(?:json|log|tmp)$/.test(name)) continue;
      if (info.size > 4 * 1024 * 1024) { if (info.mtimeMs >= created) artifacts.push(path); continue; }
      try {
        const value = JSON.parse(readFileSync(full, 'utf8'));
        if (value.workflow_id === parent.meta.id || value.backend_binding?.workflow_id === parent.meta.id || value.binding?.workflow_id === parent.meta.id) {
          artifacts.push(path); if (typeof value.epoch_id === 'string') observedEpochs.push(value.epoch_id);
        } else if (info.mtimeMs >= created && value.workflow_id === undefined &&
            (name === 'intent.json' || name === 'state.json' && Array.isArray(value.writes) && value.writes.length || name.endsWith('.log')))
          artifacts.push(path); // Unattributed recent writes cannot establish absence of effects.
      } catch { if (info.mtimeMs >= created) artifacts.push(path); }
    }
  }
  const operations = safePath(root, '.neomind/operations');
  if (existsSync(operations)) for (const name of readdirSync(operations).filter(name => /^(?:controlled-|workspace-path-).+\.lock$/.test(name))) {
    const path = `.neomind/operations/${name}`;
    if (lstatSync(safePath(root, path)).mtimeMs >= created) artifacts.push(path);
  }
  const prefix = `${hash(parent.meta.id)}.`, dir = safePath(root, states);
  const contractExists = existsSync(dir) && readdirSync(dir).some(name => name.startsWith(prefix) && name.endsWith('.contract.json'));
  const epoch = typeof parent.meta.data.controlled_epoch_id === 'string' ? parent.meta.data.controlled_epoch_id
    : records.find(record => typeof record.meta.data.epoch_id === 'string')?.meta.data.epoch_id
      ?? invocations.find(receipt => typeof receipt.epoch === 'string')?.epoch ?? observedEpochs[0];
  const originals = parent.meta.data.original_requirements;
  const validPayload = Array.isArray(originals) && originals.length > 0 && originals.every(value => typeof value === 'string' && value.trim() === value && !!value) &&
    parent.meta.data.original_requirement === (originals.length === 1 ? originals[0] : originals.map((value, index) => `${index + 1}. ${value}`).join('\n'));
  const pristine = validPayload && parent.meta.data.kind === 'manager-workflow' && parent.meta.data.process_contract === 'software-tools/v2' &&
    parent.meta.data.transport === 'vscode-lm' && parent.meta.data.phase === 'intake' && parent.meta.status === 'in-progress' &&
    !parent.meta.data.controlled_epoch_id && !parent.meta.data.controlled_contract_hash && !parent.meta.data.final_report_id && !parent.meta.data.closed_at &&
    Array.isArray(parent.meta.data.task_ids) && !parent.meta.data.task_ids.length && !records.length && !invocations.length && !artifacts.length && !contractExists;
  return { pristine, epoch: typeof epoch === 'string' ? epoch : '', records: records.map(record => record.meta.id), invocations: invocations.map(receipt => receipt.id), artifacts };
}
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
  paths.forEach(path => canonical(root, path));
  return controlledFingerprints(root, paths);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function controlledRisk(plan: ControlledPlan, originalRequirement = ''): { reviewer_required: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const paths = [...plan.allowed_paths, ...plan.verification_paths];
  const sensitive = /(?:^|\/)(?:auth[^/]*|security[^/]*|routing[^/]*|storage[^/]*|native[^/]*|controlled[^/]*|workspace[^/]*|engineering[^/]*|manager[^/]*|mcp[^/]*|command-runner[^/]*|vscode[^/]*|installer[^/]*|migration[^/]*)(?:\.|\/|$)/i;
  if (paths.some(path => sensitive.test(path) || path.startsWith('.github/') || /(?:^|\/)(?:package(?:-lock)?\.json|Dockerfile|Makefile|requirements\.txt)|\.sql$/i.test(path))) reasons.push('Security, persistence, execution or orchestration scope.');
  const intent = `${originalRequirement} ${plan.title} ${plan.objective} ${plan.rationale} ${plan.acceptance_criteria.join(' ')}`
    .normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
  if (/\b(?:authentication|authorization|credentials|secrets|permissions|database migration|schema migration|orchestration|login|access control|token|xac thuc|phan quyen|quyen truy cap|mat khau|dieu phoi|luu tru)\b/i.test(intent))
    reasons.push('The plan declares sensitive behavior.');
  if (plan.risk === 'high' || plan.risk === 'elevated') reasons.push('Coordinator elevated the risk.');
  if (plan.risk === undefined) reasons.push('Risk has not been explicitly assessed.');
  return { reviewer_required: reasons.length > 0, reasons };
}
function validatePlan(root: string, value: ControlledPlan): ControlledPlan {
  const plan = structuredClone(value);
  for (const path of plan.input_paths ?? []) {
    canonical(root, path);
    if (!/^\.(?:agents|github)\/skills\/[^/]+\/(?:assets|scripts)\/.+\.(?:md|py|mjs|cjs|js|json)$/i.test(path))
      throw new Error('input_paths names exact hidden skill asset/script inputs; ordinary source files are already readable.');
  }
  for (const path of plan.preservation_paths ?? []) canonical(root, path);
  if (!plan.acceptance_criteria.length || !plan.outputs.length || !plan.checks.length || !plan.allowed_paths.length || !plan.verification_paths.length)
    throw new Error('Plan needs explicit acceptance, implementation scope, outputs and independent checks.');
  for (const key of ['allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'] as const)
    plan[key] = [...new Set(plan[key].map(path => canonical(root, path)))];
  evidenceReportPaths(plan);
  controlledChecksForPhase({ attempts: [], checks: [] }, { plan });
  if (plan.allowed_paths.some(path => covers(path, plan.verification_paths)) || plan.verification_paths.some(path => covers(path, plan.allowed_paths)))
    throw new Error('Implementation and independent checker scopes must be disjoint.');
  if ((plan.preservation_paths ?? []).some(path => covers(path, [...plan.allowed_paths, ...plan.verification_paths]) ||
      [...plan.allowed_paths, ...plan.verification_paths].some(owned => covers(owned, [path]))))
    throw new Error('Preservation paths must be outside all producer and checker write scopes.');
  if ((plan.input_paths ?? []).some(path => covers(path, [...plan.allowed_paths, ...plan.verification_paths]) ||
      [...plan.allowed_paths, ...plan.verification_paths].some(owned => covers(owned, [path]))))
    throw new Error('Approved read-only inputs must be outside all producer and checker write scopes. Keep those inputs read-only instead of granting write scope for their check baselines.');
  if ([...plan.outputs, ...plan.documentation_paths].some(path => !covers(path, plan.allowed_paths))) throw new Error('Outputs must be within implementation scope.');
  for (const check of plan.checks) {
    if ((check.expected_exit_code ?? 0) !== 0) throw new Error('The positive independent check must exit zero; declare expected failures as negative controls.');
    if (check.command.length < 2 || check.command.some(arg => /[\x00-\x1f]/.test(arg))) throw new Error('Use explicit check argv.');
    check.baseline_paths.forEach(path => canonical(root, path));
    if (!check.command.slice(1).some(arg => covers(arg, plan.verification_paths) && check.baseline_paths.includes(arg)))
      throw new Error('Every check must execute its declared independent checker script.');
    check.baseline_paths.forEach(path => assertControlledReadBaseline(root, plan, path));
    if (!check.negative_controls?.length) throw new Error('Each check needs backend-executed negative controls against its independent checker.');
    for (const negative of check.negative_controls) {
      negative.baseline_paths.forEach(path => canonical(root, path));
      negative.baseline_paths.forEach(path => assertControlledReadBaseline(root, plan, path));
      if (!same(check.command.slice(0, 2), negative.command.slice(0, 2)) ||
          !(negative.command.slice(2).some(arg => covers(arg, plan.verification_paths) && negative.baseline_paths.includes(arg)) ||
            negative.command.includes('--negative-control') && negative.command.length >= 4 && negative.baseline_paths.includes(check.command[1]!)) ||
          negative.command.some(arg => /[\x00-\x1f]/.test(arg)))
        throw new Error('Negative controls must invoke the same checker with declared verifier-owned invalid fixtures.');
    }
  }
  const titles = plan.checks.flatMap(check => [check.title, ...(check.negative_controls ?? []).map(item => item.title)]);
  if (new Set(titles).size !== titles.length) throw new Error('Positive and negative check titles must be distinct.');
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
  private launchTail: Promise<void> = Promise.resolve();
  private jobs = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private operationDrain = new ControlledOperationDrain();
  private localExecutions = new Map<string, Promise<unknown>>();
  private closing: Promise<void> | null = null;
  constructor(readonly root: string) {}
  private async launch(input: Parameters<typeof startNative>[1], signal: AbortSignal) {
    const prior = this.launchTail;
    let release!: () => void;
    this.launchTail = new Promise<void>(done => { release = done; });
    await prior;
    try {
      while (!signal.aborted && input.role !== 'manager' &&
          (nativeStatus(this.root) as ReturnType<typeof readInvocation>[]).filter(item => item.role !== 'manager' && invocationIsActive(item)).length >= readConfig(this.root).max_workers)
        await new Promise<void>(done => setTimeout(done, 250));
      if (this.closed || signal.aborted) throw new Error('Controlled launch cancelled.');
      return await startNative(this.root, input);
    } finally { release(); }
  }
  submit(input: ControlledStartInput): ControlledSnapshot {
    const parsed = controlledStartSchema.parse(input);
    if (this.closed) throw new Error('Controlled host is closing.');
    requireRoutingPolicy(this.root);
    if (!readAutomationPolicy(this.root).manager_enabled) throw new Error('Project manager is disabled.');
    if (parsed.requirement && parsed.requirements) throw new Error('Provide one requirement or a batch.');
    let request = parsed.request_id ?? randomUUID();
    const existing = parsed.workflow_id ? getRecord(this.root, parsed.workflow_id)
      : loadRecords(this.root).find(r => r.meta.data.request_id === request && r.meta.data.kind === 'manager-workflow');
    if (existing) assertIntakePayload(existing, parsed);
    if (existing && existsSync(statePath(this.root, existing.meta.id))) {
      const saved = readState(this.root, existing.meta.id);
      // A repeated intake is a receipt, not permission to resume interrupted
      // command effects. Only explicit control.resume may continue that state.
      if (saved.status !== 'interrupted') this.schedule(saved.workflow_id);
      return readState(this.root, saved.workflow_id);
    }
    let original: ReturnType<typeof readNativeSoftwareContract> = null;
    let recovered = false;
    if (existing?.meta.data.execution_mode === 'neomind-controlled') {
      if (typeof existing.meta.data.request_id !== 'string' || !existing.meta.data.request_id ||
          parsed.request_id !== undefined && parsed.request_id !== existing.meta.data.request_id)
        throw new ControlledToolError('INTAKE_IDENTITY_MISMATCH', 'Recover this intake with its saved request identity; a different identity cannot replace its missing journal.');
      request = existing.meta.data.request_id;
      const effects = orphanedIntakeEffects(this.root, existing);
      if (!effects.pristine || this.jobs.has(existing.meta.id)) {
        const uncertain: ControlledSnapshot = { schema_version: 1, workflow_id: existing.meta.id, epoch_id: effects.epoch,
          status: 'uncertain', phase: 'intake', process_contract: 'software-tools/v2', transport: 'vscode-lm',
          owner_pid: process.pid, owner_instance: readHost(this.root).instance, updated_at: now(),
          requirement: String(existing.meta.data.original_requirement), title: existing.meta.title,
          revision: 0, request_id: request, attempts: [], checks: [], events: [], repairs: 0, active_invocations: [],
          intake_recovery: { code: 'INTAKE_OUTCOME_UNCERTAIN', observed_records: effects.records, observed_invocations: effects.invocations, observed_artifacts: effects.artifacts },
          blocker: { kind: 'protocol', code: 'INTAKE_OUTCOME_UNCERTAIN', owner: 'runtime',
            message: 'The initial workflow journal is missing, but execution records or effects may already exist. No new workflow or model invocation was started.',
            next_action: 'Reconcile the existing execution records, receipts and side effects before resuming this same intake.' } };
        save(this.root, uncertain, 'intake-uncertain', uncertain.blocker!.message);
        this.jobs.get(existing.meta.id)?.abort.abort();
        return uncertain;
      }
      recovered = true;
    } else if (existing) {
      // Explicit controlled resumption is append-only. No original mode, criteria or reports are rewritten.
      original = readNativeSoftwareContract(this.root, existing.meta.id);
      if (!original || existing.meta.data.phase === 'completed') throw new Error('Controlled continuation requires an open bounded software contract.');
      assertSupportedContinuation(original.plan.acceptance_criteria);
    }
    const parent = recovered ? beginWorkflow(this.root, { requirements: existing!.meta.data.original_requirements as string[] ?? [String(existing!.meta.data.original_requirement)],
      request_id: request, execution_mode: 'neomind-controlled' })
      : existing ?? beginWorkflow(this.root, { ...parsed, request_id: request, execution_mode: 'neomind-controlled' });
    const run: ControlledSnapshot = { schema_version: 1, workflow_id: parent.meta.id, epoch_id: randomUUID(),
      status: 'queued', phase: 'planning', process_contract: 'software-tools/v2', transport: 'vscode-lm',
      owner_pid: process.pid, owner_instance: readHost(this.root).instance, updated_at: now(), requirement: String(parent.meta.data.original_requirement), title: parent.meta.title,
      revision: 0, request_id: request, attempts: [], checks: [], events: [], repairs: 0, active_invocations: [] };
    run.repair_budget = { schema_version: 1, product: 0, protocol: 0, environment: 0 };
    if (original) run.continuation = { original_mode: String(parent.meta.data.execution_mode),
      original_fingerprint: hash(JSON.stringify(parent)), original_contract_hash: hash(JSON.stringify(original)) };
    save(this.root, run, recovered ? 'intake-recovered' : 'accepted', recovered
      ? 'Recovered the same unexecuted intake after its interrupted initial journal write; no duplicate workflow was created.'
      : 'Request durably accepted by the VS Code owned controller.');
    this.schedule(run.workflow_id);
    return readState(this.root, run.workflow_id);
  }
  private async plan(run: ControlledSnapshot, proposed: ControlledPlan, signal: AbortSignal, assertActorActive: () => void, deferred = false,
    source?: ControlledPayloadSource): Promise<unknown> {
    const assertActive = () => { assertActorActive(); if (source) assertControlledPayloadCurrent(this.root, source); };
    assertActive();
    const emptyExecutionDefault = !run.contract_hash || readContract(this.root, run).plan.execution_steps?.length === 0;
    const supplied = proposed.execution_steps === undefined && emptyExecutionDefault ? { ...proposed, execution_steps: [] } : proposed;
    const plan = validatePlan(this.root, normalizeControlledPlanInput(this.root, mergeOriginalCriteria(this.root, run, supplied),
      run.continuation ? readNativeSoftwareContract(this.root, run.workflow_id)?.plan.checks ?? [] : []));
    if (run.continuation) {
      const original = readNativeSoftwareContract(this.root, run.workflow_id)!;
      for (const key of ['allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'] as const)
        if (!same([...original.plan[key]].sort(), [...plan[key]].sort())) throw new Error('Continuation cannot change the original scope or delivered outputs.');
      if (original.plan.acceptance_criteria.some(item => !plan.acceptance_criteria.includes(item)) || original.plan.checks.some(old => !plan.checks.some(check =>
        same(old.command, check.command) && same(old.baseline_paths, check.baseline_paths) && (old.expected_exit_code ?? 0) === (check.expected_exit_code ?? 0) &&
        (check.timeout_ms ?? 60000) >= (old.timeout_ms ?? 60000))))
        throw new Error('Continuation must retain every original acceptance criterion and positive check.');
      const obligations = continuationObligations(original.plan.acceptance_criteria);
      if (obligations.pilot_kind === 'unsupported-generic') throw new Error('The original intended-use task family has no reviewed pilot adapter; keep its original acceptance open.');
      if (obligations.registration && !plan.procedure_candidate) throw new Error('Original acceptance requires a planned reusable procedure candidate using the actual producer and checker scripts.');
      if (obligations.intended_use && !plan.checks.some(check => check.purpose === 'intended-use' && !original.plan.checks.some(old => same(old.command, check.command))))
        throw new Error('Original acceptance needs a separate intended-use pilot check; keep the original fixture self-check and add purpose intended-use with its own checker argv.');
      if (obligations.preservation && !plan.preservation_paths?.length) throw new Error('Declare the existing exercise/asset preservation paths; backend fingerprints them before work.');
    }
    if (run.contract_hash) {
      const prior = readContract(this.root, run);
      if (!same(prior.plan, plan)) throw new Error('Saved contract is immutable.');
      return { saved: true, next: 'Finish the planning report; runtime dispatches the next stage.' };
    }
    const parent = getRecord(this.root, run.workflow_id);
    const original = run.continuation ? readNativeSoftwareContract(this.root, run.workflow_id)! : null;
    const requirementIds = [...new Set([...(original?.requirement_ids ?? []), String(parent.meta.data.requirement_id),
      ...(Array.isArray(parent.meta.data.requirement_ids) ? parent.meta.data.requirement_ids.filter((id): id is string => typeof id === 'string') : [])])];
    const parentFingerprint = evidenceRecordFingerprint(parent), requirementFingerprints = Object.fromEntries(requirementIds.map(id => [id, evidenceRecordFingerprint(getRecord(this.root, id))]));
    const queue = (conflicts: ControlledPlanConflict[]) => {
      assertActive(); run = readState(this.root, run.workflow_id);
      run.pending_plan = { plan, attempt_id: run.attempts.at(-1)!.id, parent_fingerprint: parentFingerprint,
        ...(source ? { payload_source: source } : {}),
        requirement_fingerprints: requirementFingerprints, conflicts };
      save(this.root, run, 'plan-waiting', 'Validated plan saved without a task or frozen inputs; runtime waits for active writer scopes.');
      return { saved: true, contract_frozen: false, waiting_for: conflicts,
        next: 'Save the completed planning report, then finish this session. The backend waits and freezes fresh inputs automatically; do not poll or resubmit the plan.' };
    };
    const conflicts = controlledPlanConflicts(this.root, run.workflow_id, plan);
    if (conflicts.length) return queue(conflicts);
    const originalTaskFingerprint = original ? hash(JSON.stringify(getRecord(this.root, original.task_id))) : undefined;
    const originalContractPath = `.neomind/native/software-workflows/${hash(run.workflow_id)}.contract.json`;
    const originalContractSha256 = original ? hash(readFileSync(safePath(this.root, originalContractPath))) : undefined;
    const knowledgeDirectory = original ? `${readCornellDestination(this.root).directory}/${run.workflow_id.toLowerCase()}` : undefined;
    controlledCornellDirectories(plan, knowledgeDirectory);
    const attemptId = run.attempts.at(-1)?.id, epoch = run.epoch_id;
    const preservedHashes = await controlledFingerprintsAsync(this.root, [...new Set([...(plan.preservation_paths ?? []), ...(plan.input_paths ?? []),
      ...(original ? ['.gitignore', '.agents/skills/leetcode-notes/assets/cornell-note-template.md', '.agents/skills/leetcode-notes/scripts/validate_notes.py']
        .filter(path => existsSync(safePath(this.root, path))) : [])])], { signal });
    for (const step of plan.execution_steps ?? []) {
      const inputs = new Set([...Object.keys(preservedHashes), ...step.input_paths,
        ...(step.command[1] === '--version' ? [] : [step.command[1]!])]);
      if (inputs.size > 512) throw new Error('A producer execution baseline exceeds 512 exact inputs. Select only the relevant preservation files before freezing this plan.');
    }
    // No records or contract have been written before this yielding, cancellable preflight.
    // Re-read authoritative state after the await; trace/heartbeat events must not be overwritten.
    return withOperationLock(this.root, 'controlled-plan-admission', () => withOperationLock(this.root, `controlled-plan-${hash(run.workflow_id).slice(0, 32)}`, () => {
    signal.throwIfAborted(); assertActive();
    run = readState(this.root, run.workflow_id);
    if (run.epoch_id !== epoch || run.attempts.at(-1)?.id !== attemptId || run.status !== (deferred ? 'waiting' : 'running') ||
        run.attempts.at(-1)?.state !== (deferred ? 'completed' : 'running'))
      throw new Error('Planning owner changed while preservation inputs were captured.');
    if (run.contract_hash) {
      if (!same(readContract(this.root, run).plan, plan)) throw new Error('Saved contract is immutable.');
      return { saved: true, next: 'Finish the planning report; runtime dispatches the next stage.' };
    }
    const currentConflicts = controlledPlanConflicts(this.root, run.workflow_id, plan);
    if (currentConflicts.length) return queue(currentConflicts);
    if (evidenceRecordFingerprint(getRecord(this.root, run.workflow_id)) !== parentFingerprint ||
        Object.entries(requirementFingerprints).some(([id, fingerprint]) => evidenceRecordFingerprint(getRecord(this.root, id)) !== fingerprint) ||
        (original && (hash(JSON.stringify(readNativeSoftwareContract(this.root, run.workflow_id))) !== hash(JSON.stringify(original)) ||
          hash(JSON.stringify(getRecord(this.root, original.task_id))) !== originalTaskFingerprint ||
          hash(readFileSync(safePath(this.root, originalContractPath))) !== originalContractSha256)))
      throw new Error('Planning requirements or workflow ownership changed during preservation preflight; retry from current inputs.');
    const taskData = { workflow_id: run.workflow_id, process_contract: 'software-tools/v2', epoch_id: run.epoch_id,
      acceptance_criteria: plan.acceptance_criteria, allowed_paths: plan.allowed_paths, verification_paths: plan.verification_paths,
      outputs: plan.outputs, documentation_paths: plan.documentation_paths, ...(original ? { previous_task_id: original.task_id } : {}) };
    const taskLinks = [...requirementIds.map(target => ({ type: 'satisfies' as const, target })), ...(original ? [{ type: 'derives-from' as const, target: original.task_id }] : [])];
    const taskBody = `# Objective\n${plan.objective}\n\n# Acceptance\n${plan.acceptance_criteria.map(x => `- ${x}`).join('\n')}\n`;
    const oldTasks = loadRecords(this.root).filter(record => record.meta.type === 'task' && record.meta.data.workflow_id === run.workflow_id && record.meta.data.epoch_id === run.epoch_id);
    const matchingTask = (record: ProjectRecord) => {
      const lineage = record.meta.data.previous_uncommitted_task_ids;
      if (lineage !== undefined && (!Array.isArray(lineage) || lineage.some(id => typeof id !== 'string' || id === record.meta.id || !oldTasks.some(old => old.meta.id === id)))) return false;
      const expectedLinks = [...taskLinks, ...(Array.isArray(lineage) ? lineage.map(target => ({ type: 'derives-from' as const, target })) : [])];
      const links = (value: { type: string; target: string }[]) => [...value].sort((a, b) => `${a.type}:${a.target}`.localeCompare(`${b.type}:${b.target}`));
      return record.meta.title === plan.title && record.meta.owner === 'developer' && record.meta.status === 'ready' && record.body.trimEnd() === taskBody.trimEnd() &&
        same(links(record.meta.links), links(expectedLinks)) && Object.entries(taskData).every(([key, value]) => same(record.meta.data[key], value)) &&
        Object.keys(record.meta.data).every(key => key in taskData || ['documentation_required', 'routing_required', 'assurance', 'controlled_contract_hash', 'previous_uncommitted_task_ids'].includes(key));
    };
    const savedPath = contractPath(this.root, run.workflow_id, run.epoch_id);
    const savedBytes = existsSync(savedPath) ? readFileSync(savedPath, 'utf8') : null;
    const savedContract = savedBytes ? JSON.parse(savedBytes) as Contract : null;
    if (savedContract && (savedContract.workflow_id !== run.workflow_id || savedContract.epoch_id !== run.epoch_id || !same(savedContract.plan, plan) ||
        !same(savedContract.preserved_hashes, preservedHashes) || !same(savedContract.requirement_fingerprints, requirementFingerprints) ||
        !oldTasks.some(record => record.meta.id === savedContract.task_id && matchingTask(record))))
      throw new Error('An interrupted immutable plan differs from current inputs; preserve its history and reconcile before resuming.');
    const existingTask = savedContract ? oldTasks.find(record => record.meta.id === savedContract.task_id)! : oldTasks.find(record => matchingTask(record) && !record.meta.data.controlled_contract_hash);
    const orphaned = oldTasks.filter(record => record.meta.id !== existingTask?.meta.id);
    const task = existingTask ?? createRecord(this.root, { type: 'task', title: plan.title, owner: 'developer', status: 'ready',
      links: [...taskLinks, ...orphaned.map(record => ({ type: 'derives-from' as const, target: record.meta.id }))],
      data: { ...taskData, ...(orphaned.length ? { previous_uncommitted_task_ids: orphaned.map(record => record.meta.id) } : {}) }, body: taskBody });
    const risk = controlledRisk(plan, run.requirement);
    const contract: Contract = { schema_version: 2, process: 'software-tools', workflow_id: run.workflow_id, epoch_id: run.epoch_id,
      plan, plan_hash: hash(JSON.stringify(plan)), task_id: task.meta.id,
      requirement_ids: requirementIds, requirement_fingerprints: requirementFingerprints, preserved_hashes: preservedHashes,
      reviewer_required: !!run.continuation || risk.reviewer_required,
      risk_reasons: risk.reasons, previous_contract_hash: run.continuation?.original_contract_hash,
      precheck_review: !!run.continuation, ...(original ? { knowledge_directory: knowledgeDirectory,
        continuation: { original_task_id: original.task_id, original_task_fingerprint: originalTaskFingerprint!,
          original_contract_path: originalContractPath, original_contract_sha256: originalContractSha256!,
          obligations: continuationObligations(original.plan.acceptance_criteria) } } : {}) };
    const bytes = savedBytes ?? JSON.stringify(contract, null, 2) + '\n';
    if (savedContract && !same(savedContract, contract)) throw new Error('Interrupted plan contract failed exact reconciliation.');
    if (!savedBytes) atomicWrite(savedPath, bytes);
    run.contract_hash = hash(bytes);
    delete run.pending_plan;
    updateRecord(this.root, task.meta.id, { data: { controlled_contract_hash: run.contract_hash } });
    updateRecord(this.root, run.workflow_id, { data: { controlled_epoch_id: run.epoch_id, controlled_contract_hash: run.contract_hash,
      task_ids: [...new Set([...(Array.isArray(parent.meta.data.task_ids) ? parent.meta.data.task_ids : []), task.meta.id])] } });
    save(this.root, run, 'plan-saved', 'Backend created the bound task and immutable scope/check contract.');
    return { saved: true, reviewer_required: contract.reviewer_required, next: 'Save a compact completed planning report.' };
    }));
  }
  private schedule(id: string): void {
    if (this.closed || this.jobs.has(id)) return;
    const state = readState(this.root, id);
    if (['completed', 'cancelled', 'paused', 'blocked', 'uncertain'].includes(state.status)) return;
    const abort = new AbortController();
    const promise = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.drive(id, abort.signal))
      .catch(error => {
        const run = readState(this.root, id);
        if (!['paused', 'interrupted', 'cancelled', 'uncertain'].includes(run.status)) {
          const failure = controlledFailure(error), traceId = randomUUID();
          atomicWrite(safePath(this.root, `.neomind/controlled/traces/${traceId}.json`), JSON.stringify({
            event: 'runtime-failure', workflow_id: id, epoch_id: run.epoch_id, stage: run.phase,
            attempt_id: run.attempts.at(-1)?.id, at: now(), ...failure,
          }, null, 2) + '\n');
          run.status = 'blocked'; run.blocker = { kind: failure.kind, message: failure.message,
            code: failure.code, trace_id: traceId, owner: failure.owner, next_action: failure.next_action };
          save(this.root, run, 'blocked', run.blocker.message);
        }
      }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, { promise, abort });
  }
  private admitCheckEffects(run: ControlledSnapshot): boolean {
    if (run.local_executions?.some(operation => operation.state !== 'completed')) {
      run.status = 'uncertain'; run.blocker = { kind: 'environment', message: 'An owned local script has no durable result. Preserve its operation record and reconcile actual effects before another execution; no command was replayed.' };
      save(this.root, run, 'uncertain', run.blocker.message); return false;
    }
    const contract = run.contract_hash ? readContract(this.root, run) : undefined;
    const reconciliations = contract ? readCheckReconciliations(this.root, run, contract) : [];
    if (unresolvedControlledChecks(run, reconciliations).length) {
      run.status = 'uncertain'; run.blocker = { kind: 'environment', message: 'A check was interrupted without a durable result. Its saved process/command baseline must be reconciled before another execution; no command was automatically replayed.' };
      save(this.root, run, 'uncertain', run.blocker.message); return false;
    }
    recheckBeforeReconciledResume(this.root, run, reconciliations, paths => fingerprints(this.root, paths));
    return true;
  }
  private async drive(id: string, signal: AbortSignal): Promise<void> {
    while (!this.closed && !signal.aborted) {
      await this.operationDrain.drain(id);
      if (this.closed || signal.aborted) return;
      let run = readState(this.root, id);
      if (!['queued', 'running', 'waiting', 'interrupted'].includes(run.status)) return;
      if (run.pending_plan && !run.contract_hash && run.attempts.at(-1)?.stage === 'planning' &&
          run.attempts.at(-1)?.state === 'completed' && run.attempts.at(-1)?.report?.outcome === 'completed') {
        const pending = run.pending_plan, planner = run.attempts.at(-1)!;
        const conflicts = controlledPlanConflicts(this.root, id, pending.plan);
        if (run.status !== 'waiting' || !same(conflicts, pending.conflicts)) {
          run.status = 'waiting'; pending.conflicts = conflicts;
          save(this.root, run, 'scope-wait', 'The saved Coordinator result is retained while another workflow owns required input scope.');
        }
        if (conflicts.length) { await new Promise<void>(done => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
          const timer = setTimeout(finish, 1000); signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        }); continue; }
        const receipt = planner.invocation_id ? readInvocation(this.root, planner.invocation_id) : undefined;
        const report = planner.report_id ? getRecord(this.root, planner.report_id) : undefined;
        if (planner.id !== pending.attempt_id || planner.stage !== 'planning' || planner.role !== 'manager' || planner.report?.outcome !== 'completed' ||
            receipt?.state !== 'completed' || receipt.issuer !== 'neomind-vscode-lm' || receipt.role !== planner.role ||
            !receipt.inference_completed || receipt.workflow_id !== id || receipt.request_id !== planner.request_id ||
            receipt.controlled_execution?.epoch_id !== run.epoch_id || receipt.controlled_execution.stage !== 'planning' ||
            !report || evidenceRecordFingerprint(report) !== planner.report_fingerprint || report.meta.data.invocation_id !== receipt.id ||
            report.meta.owner !== planner.role || report.meta.data.workflow_id !== id || report.meta.data.epoch_id !== run.epoch_id ||
            report.meta.data.attempt_id !== planner.id || report.meta.data.stage !== 'planning' ||
            routingProblems(this.root, planner.role, receipt.id, { workflow_id: id, require_completed: true }).length ||
            evidenceRecordFingerprint(getRecord(this.root, id)) !== pending.parent_fingerprint ||
            Object.entries(pending.requirement_fingerprints).some(([record, fingerprint]) => evidenceRecordFingerprint(getRecord(this.root, record)) !== fingerprint))
          throw new ControlledToolError('STATE_UNCERTAIN', 'The waiting plan no longer matches its completed Coordinator or immutable requirement observations.');
        const epoch = run.epoch_id, attemptId = planner.id;
        const assertPending = () => { const current = readState(this.root, id);
          if (this.closed || signal.aborted || current.epoch_id !== epoch || current.status !== 'waiting' || current.contract_hash ||
              current.pending_plan?.attempt_id !== attemptId || current.attempts.at(-1)?.id !== attemptId)
            throw new ControlledToolError('ACTOR_INACTIVE', 'The waiting plan changed owner or was cancelled before freezing.'); };
        await this.plan(run, pending.plan, signal, assertPending, true, pending.payload_source);
        run = readState(this.root, id);
        if (!run.contract_hash) continue;
        run.phase = 'implementation'; run.status = 'queued';
        save(this.root, run, 'scope-ready', 'Conflicting writer finished; fresh preservation inputs frozen under the original Coordinator result.');
        continue;
      }
      if (!this.admitCheckEffects(run)) return;
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
      // Final reports describe an actual completed check checkpoint. Their
      // bounded authoring pass precedes fresh verification and final review.
      // This also resumes old frozen promises without rewriting the contract.
      if (contract && ['review', 'completed'].includes(run.phase) && !run.pending_check_review) {
        const documentation = pendingEvidenceDocumentation(run, contract);
        if (documentation) {
          run.pending_documentation = documentation; run.phase = 'implementation'; run.status = 'queued';
          save(this.root, run, 'evidence-documentation-needed', 'Actual checks are available; the backend schedules only the promised final report outputs before fresh independent verification.');
        }
      }
      const specialistIndex = run.phase === 'implementation' ? (contract?.plan.specialists ?? []).findIndex((_, index) =>
        !run.attempts.some(attempt => attempt.purpose === 'specialist' && attempt.specialist_index === index && attempt.state === 'completed' && attempt.report?.outcome === 'completed')) : -1;
      const specialist = specialistIndex >= 0 ? contract!.plan.specialists![specialistIndex] : undefined;
      const stage = specialist ? 'diagnosis' : run.phase === 'intake' ? 'planning' : run.phase;
      const documentation = stage === 'implementation' ? run.pending_documentation : undefined;
      if (documentation && (!contract || !same(documentation, pendingEvidenceDocumentation(run, contract))))
        throw new ControlledToolError('STATE_UNCERTAIN', 'The post-check documentation assignment no longer matches its original producer and actual check checkpoint.');
      const documentationGuard = documentation && contract ? assertEvidenceDocumentationAuthority(this.root, run, contract, documentation) : undefined;
      let role: NativeRole;
      try { role = specialist ? controlledConsultationRole(specialist.role) : stage === 'planning' || stage === 'diagnosis' || stage === 'synthesis' ? 'manager'
        : stage === 'implementation' ? 'developer' : stage === 'verification' ? 'verifier' : 'reviewer'; }
      catch (error) {
        if (!(error instanceof ControlledToolError) || error.code !== 'UNSUPPORTED_SPECIALIST_ROLE') throw error;
        run.status = 'blocked'; run.blocker = { kind: 'protocol', code: error.code, owner: 'runtime', message: error.message,
          next_action: 'Preserve this immutable plan and its required review gates. Reconcile the unsupported consultation through a reviewed new plan; do not silently substitute a different role.' };
        save(this.root, run, 'blocked', run.blocker.message); return;
      }
      const attempt: Attempt = { id: randomUUID(), request_id: randomUUID(), stage, role, state: 'starting',
        ...(specialist ? { purpose: 'specialist', specialist_index: specialistIndex } : {}),
        ...(stage === 'review' && run.pending_check_review ? { purpose: 'check-review' } : {}),
        ...(documentation ? { purpose: 'evidence-documentation' as const, documentation_source: documentation } : {}) };
      run.attempts.push(attempt); run.status = 'running'; run.owner_pid = process.pid;
      if (stage === 'implementation' && contract) saveStatus(this.root, contract.task_id, 'in-progress');
      save(this.root, run, 'dispatch', `NeoMind dispatches ${role} for ${stage}.`);
      const binding: ControlledBinding = { workflow_id: id, task_id: stage === 'planning' ? undefined : contract?.task_id,
        stage, role, implementation_paths: documentation?.paths ?? contract?.plan.allowed_paths ?? [], verification_paths: contract?.plan.verification_paths ?? [],
        ...(documentation ? { evidence_documentation: true, evidence_documentation_source_hash: hash(canonicalJson(documentation)) } : {}),
        cornell_bound: !documentation && !!(stage === 'synthesis' ? contract?.knowledge_directory : contract?.plan.cornell_output_dir),
        cornell_starter_allowed: stage === 'synthesis' || !!contract?.plan.cornell_output_dir &&
          contract.plan.outputs.includes(`${contract.plan.cornell_output_dir}/practice-solution.md`),
        ...(documentation ? { execution_steps: [] } : contract?.plan.execution_steps === undefined ? {} : { execution_steps: contract.plan.execution_steps }),
        procedure_bound: !documentation && !!contract?.plan.reuse,
        ...(stage === 'review' ? { review_purpose: attempt.purpose === 'check-review' ? 'checker-readiness' as const : 'final-product' as const } : {}),
        approved_inputs: [...(contract?.plan.input_paths ?? []), ...(run.continuation ? [
          '.agents/skills/leetcode-notes/assets/cornell-note-template.md', '.agents/skills/leetcode-notes/scripts/validate_notes.py',
        ] : [])],
        read_paths: ['.'], protected_paths: contract ? this.protectedPaths(contract) : [],
        check_titles: contract ? controlledChecksForPhase(run, contract).map(check => check.title) : [] };
      const attemptAbort = new AbortController();
      const abortAttempt = () => attemptAbort.abort(); signal.addEventListener('abort', abortAttempt, { once: true });
      const assertActive = () => {
        const current = readState(this.root, id), last = current.attempts.at(-1);
        if (this.closed || signal.aborted || current.epoch_id !== run.epoch_id || current.status !== 'running' || last?.id !== attempt.id)
          throw new Error('Controlled attempt ended or changed owner.');
        if (current.contract_hash) readContract(this.root, current);
        if (documentationGuard && !same(documentationGuard, fingerprints(this.root, Object.keys(documentationGuard))))
          throw new ControlledToolError('INPUT_CHANGED', 'Implementation changed outside the report-only handoff. Preserve current files; fresh implementation ownership and verification are required.');
        if (documentation && contract) assertEvidenceDocumentationAuthority(this.root, current, contract, documentation);
      };
      const callbacks: ControlledCallbacks = {
        assertActive,
        runtimeContext: async query => {
          assertActive();
          const current = readState(this.root, id), host = readHost(this.root), active = current.attempts.at(-1)!;
          const native = readInvocation(this.root, active.invocation_id!);
          if (host.pid !== current.owner_pid || host.instance !== current.owner_instance || native.issuer !== 'neomind-vscode-lm')
            throw new ControlledToolError('ACTOR_INACTIVE', 'This worker is not owned by the current enabled project Bridge.');
          const nextAction = stage === 'verification' ? 'Read the assigned implementation/checker files, author independent checks, then use check_run and save your verdict.'
            : stage === 'planning' ? 'Inspect relevant project sources, prepare the bounded plan, then report its result.'
            : stage === 'implementation' ? 'Finish the assigned product outputs using the scoped tools, then save your substantive report.'
            : 'Continue the assigned professional review or synthesis using the current evidence.';
          const contextPath = safePath(this.root, `.neomind/controlled/context/${attempt.id}.${hash(canonicalJson(query))}.json`);
          if (existsSync(contextPath)) {
            const saved = JSON.parse(readFileSync(contextPath, 'utf8'));
            if (saved.context !== 'backend-owned-worker' || saved.role !== role || saved.stage !== stage)
              throw new Error('Saved runtime context does not match the current owned session.');
            return { ...saved, replayed: true, next_action: nextAction,
              snapshot_notice: 'These unchanged session facts are already established. Continue the assigned work instead of repeating this query.' };
          }
          let toolchain;
          try { toolchain = await controlledToolchain(this.root, query, attemptAbort.signal); }
          catch { throw new ControlledToolError('INVALID_EXECUTION', 'Supply an existing absolute executable of the requested toolchain type; version observations use fixed --version argv.'); }
          assertActive();
          const observation = { schema_version: 1, observed_at: now(), context: 'backend-owned-worker',
            execution_mode: 'neomind-controlled', transport: 'vscode-lm', role, stage,
            bridge: { enabled: true, exact_project_owner: true, workspace_trust_checked_by_extension: true },
            model: { requested: native.requested_model, observed: native.confirmed_model, vendor: native.model_provider,
              current_owned_tool_request_observed: true, upstream_identity_attested: false },
            preflight_complete: true, next_action: nextAction,
            available_tools: controlledToolNames(binding), guide: controlledRuntimeContextGuide(), toolchain,
            producer_capabilities: { tools: controlledToolNames(binding),
              declaration: 'The tools listed here are the operations actually assigned to this session. New plans declare future producer script operations in execution_steps; that declaration does not grant execution to a read-only stage.',
              direct_execution_input_limit_bytes: 1024 * 1024, direct_execution_baseline_limit_files: 512,
              script_interpreters: ['node', 'python'], version_observations: ['node', 'python', 'gcc', 'g++'] },
            policy: { network: false, publication: false, scoped_execution_is_os_sandbox: false,
              repair_attempts: readConfig(this.root).repair_attempts },
            reuse: { qualified_automatic_reuse_required: true, direct_local_script_execution: 'task_run under the immutable producer scope; does not qualify a candidate' } };
          atomicWrite(contextPath, JSON.stringify(observation, null, 2) + '\n');
          return observation;
        },
        runTask: input => {
          assertActive();
          const key = hash(canonicalJson({ id, epoch: run.epoch_id, input }));
          const existing = this.localExecutions.get(key); if (existing) return existing;
          const operation = this.operationDrain.run(id, () => this.executeTask(id, attempt.id, input, attemptAbort.signal, assertActive));
          this.localExecutions.set(key, operation);
          void operation.finally(() => { if (this.localExecutions.get(key) === operation) this.localExecutions.delete(key); }).catch(() => {});
          return operation;
        },
        submitPlan: async (plan, source) => {
          assertActive(); run = readState(this.root, id);
          try { return await this.plan(run, plan, attemptAbort.signal, assertActive, false, source); }
          catch (error) {
            if (error instanceof ControlledPayloadError || error instanceof ControlledToolError) throw error;
            throw new ControlledToolError('PLAN_INVALID', error instanceof Error ? error.message : 'The semantic plan is invalid.');
          }
        },
        saveReport: (report, source) => {
          if (source) assertControlledPayloadCurrent(this.root, source);
          assertActive(); const current = readState(this.root, id), active = current.attempts.at(-1)!;
          if (stage === 'implementation' && !documentation && report.outcome === 'completed' && contract?.plan.execution_steps?.some(step =>
            !current.local_executions?.some(operation => operation.title === step.title && operation.state === 'completed' && operation.passed)))
            throw new ControlledToolError('ACCEPTANCE_INCOMPLETE', 'Complete each declared producer execution step through task_run before reporting the implementation complete.');
          if (['verification', 'review'].includes(stage) && report.outcome === 'completed' && !report.verdict)
            throw new ControlledToolError('VERDICT_REQUIRED', 'Completed independent verification or review must state verdict pass or fail.');
          if (active.report) {
            if (canonicalJson(active.report) !== canonicalJson(report)) throw new Error('Attempt already saved a different report.');
            return { saved: true, outcome: report.outcome };
          }
          const artifactPaths = [...new Set([...(report.artifacts ?? []), ...(stage === 'implementation' ? contract!.plan.outputs : []),
            ...(attempt.purpose === 'check-review' ? contract!.plan.verification_paths : []),
            ...(stage === 'synthesis' && contract?.knowledge_directory ? ['note.md', 'exercises.md', 'answers.md'].map(name => `${contract.knowledge_directory}/${name}`) : [])])];
          if (documentation && (report.artifacts ?? []).some(path => !documentation.paths.includes(path)))
            throw new ControlledToolError('SCOPE_DENIED', 'This post-check assignment reports only its declared final report paths; all other product and checker files are read-only.');
          if (artifactPaths.some(path => !covers(canonical(this.root, path), [...(contract?.plan.allowed_paths ?? binding.implementation_paths), ...binding.verification_paths, ...(contract?.knowledge_directory ? [contract.knowledge_directory] : [])])) && !['planning', 'diagnosis'].includes(stage))
            throw new ControlledToolError('SCOPE_DENIED', 'Report artifact exceeds assigned scope.');
          active.bound_hashes = fingerprints(this.root, artifactPaths);
          active.report = report;
          const payloadHash = hash(canonicalJson(report));
          const priorReport = loadRecords(this.root).find(record => record.meta.data.kind === 'controlled-work-record' &&
            record.meta.data.epoch_id === current.epoch_id && record.meta.data.attempt_id === active.id);
          if (priorReport && priorReport.meta.data.report_payload_hash !== payloadHash) throw new Error('Attempt already saved a different report.');
          if (priorReport && !same(priorReport.meta.data.artifact_hashes, active.bound_hashes))
            throw new ControlledToolError('INPUT_CHANGED', 'Artifacts changed after the durable report; do not refresh an old result against new bytes.');
          const record = priorReport ?? createRecord(this.root, { type: stage === 'review' ? 'review' : 'knowledge', title: `${role}: ${current.title}`.slice(0, 256), owner: role,
            data: { kind: 'controlled-work-record', workflow_id: id, task_id: contract?.task_id, invocation_id: active.invocation_id,
              epoch_id: current.epoch_id, attempt_id: active.id, stage, report_payload_hash: payloadHash, outcome: report.outcome, artifact_hashes: active.bound_hashes },
            body: `# Result\n${report.summary}\n\n# Findings\n${(report.findings ?? []).join('\n')}\n\n# Limitations\n${(report.limitations ?? []).join('\n')}\n` });
          active.report_id = record.meta.id;
          active.report_fingerprint = evidenceRecordFingerprint(record);
          if (source) (active as Attempt & { payload_source?: ControlledPayloadSource }).payload_source = source;
          save(this.root, current, 'report-saved', `${role} saved ${report.outcome}; acceptance is pending backend evidence.`);
          return { saved: true, outcome: report.outcome, next: 'Return your final concise result. Runtime advances after your actual session completes.' };
        },
        runCheck: title => {
          assertActive();
          return this.operationDrain.run(id, () => this.checks(id, attempt.id, attemptAbort.signal, title));
        },
        readEvidence: (title, kind = 'execution') => {
          assertActive();
          const current = readState(this.root, id);
          if (kind === 'workflow') return controlledReviewContext(this.root, current, contract,
            binding.review_purpose ?? 'final-product');
          if (kind === 'registration') return controlledRegistrationEvidence(this.root, current, contract);
          return currentControlledChecks(current).filter(check => title === undefined || check.title === title).slice(-16).map(check => {
            const log = JSON.parse(readFileSync(safePath(this.root, check.log_path), 'utf8'));
            return { title: check.title, purpose: check.purpose ?? 'self-check', negative: check.negative, passed: check.passed,
              command: check.command, exit_code: check.exit_code, expected_exit_code: check.expected_exit_code,
              stdout: typeof log.result?.stdout === 'string' ? log.result.stdout.slice(-8000) : '',
              stderr: typeof log.result?.stderr === 'string' ? log.result.stderr.slice(-8000) : '',
              ...(check.pilot_receipt_path ? { intended_use: (() => {
                const proof = JSON.parse(readFileSync(safePath(this.root, check.pilot_receipt_path), 'utf8'));
                const command = (value: any) => ({ command: value.command, passed: value.passed, exit_code: value.result?.exit_code,
                  stdout: typeof value.result?.stdout === 'string' ? value.result.stdout.slice(-4000) : '',
                  stderr: typeof value.result?.stderr === 'string' ? value.result.stderr.slice(-4000) : '' });
                return { kind: proof.kind, validation: command(proof.validation), artifacts: proof.artifacts,
                  solutions: proof.solutions.map((solution: any) => ({ language: solution.language, compile: command(solution.compile), run: command(solution.run) })) };
              })() } : {}) };
          });
        },
        runProcedure: parameters => {
          assertActive();
          return this.operationDrain.run(id, async () => {
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
          });
        },
        compileResearch: (input, source) => {
          assertActive();
          if (source) assertControlledPayloadCurrent(this.root, source);
          const directory = stage === 'synthesis' ? contract?.knowledge_directory : contract?.plan.cornell_output_dir;
          if (!directory) throw new ControlledToolError('NO_CORNELL_OUTPUT', 'The immutable plan does not include a Cornell research bundle.');
          const requirement = getRecord(this.root, contract!.requirement_ids[0]!);
          try {
            const completed = readState(this.root, id);
            // Repair workers may inspect old failing evidence, but Cornell
            // observations must never borrow a Verifier from before this producer.
            const currentChecks = currentControlledCornellChecks(completed);
            const evidenceIds = currentChecks.filter(check => !check.negative && check.passed)
              .map(check => check.evidence_id).filter((id): id is string => !!id);
            const sourceContext: ControlledCornellSourceContext = { workflow_id: id, epoch_id: completed.epoch_id,
              task_id: contract!.task_id, requirement_ids: contract!.requirement_ids,
              saved_results: completed.cornell_results,
              evidence: currentChecks.filter(check => !check.negative && check.passed && check.evidence_id)
                .map(check => ({ evidence_id: check.evidence_id!, log_path: check.log_path })),
              file_allowed: path => (controlledPublicReferencePath(path) ||
                !!binding.approved_inputs?.includes(path) && controlledSkillInputPath(path)) &&
                (binding.read_paths ?? ['.']).some(scope => scope === '.' || covers(path, [scope])) };
            const sources = normalizeControlledCornellSources(this.root, input.sources, sourceContext);
            const worked = bindControlledCornellDemonstration(input.worked_example, evidenceIds, stage === 'synthesis');
            const compiled = compileCornellResearch(this.root, { ...input, schema_version: 1, practice: bindControlledCornellPractice(input.practice, directory, binding.cornell_starter_allowed),
              sources: sources.sources, worked_example: worked, requirement_id: requirement.meta.id,
              expected_requirement_revision: requirement.meta.revision, workflow_id: id, task_id: contract!.task_id,
              owner: role, output_dir: directory } as CornellResearchInput, { approved_source_files: sources.approved_source_files });
            const solutionPath = compiled.note.practice.solution_path;
            const solutionExisted = solutionPath ? existsSync(safePath(this.root, solutionPath)) : false;
            const note = persistControlledCornellNote(this.root, compiled, sourceContext);
            const solutionCreated = !!solutionPath && !solutionExisted && existsSync(safePath(this.root, solutionPath));
            const current = readState(this.root, id); current.cornell_note_ids = [...new Set([...(current.cornell_note_ids ?? []), note.meta.id])];
            if (!current.cornell_results?.some(result => result.note_id === note.meta.id && result.input_hash === compiled.input_hash &&
                result.record_fingerprint === evidenceRecordFingerprint(note)))
              current.cornell_results = [...(current.cornell_results ?? []), { ...controlledCornellResult(compiled, note),
                ...(source ? { payload_source: source } : {}) }];
            save(this.root, current, 'cornell-compiled', 'Research note, exercises and separate answers compiled by the existing Cornell formatter.');
            return { saved: true, observation_policy: stage === 'implementation' ? 'Expected-only primary deliverable; the independent Verifier supplies execution evidence next.' : 'Actual current independent evidence bound by the backend.',
              artifacts: [`${directory}/note.md`, `${directory}/exercises.md`, `${directory}/answers.md`, ...(solutionCreated ? [solutionPath!] : [])],
              ...(solutionPath ? { learner_solution: { path: solutionPath, created: solutionCreated } } : {}),
              ...(sources.unfetched_sources.length ? { unfetched_source_ids: sources.unfetched_sources,
                source_limitation: 'External URLs are recorded references; the runtime did not fetch or verify their contents.' } : {}) };
          } catch (error) {
            if (error instanceof ControlledCornellWriteError) throw new ControlledToolError('STATE_UNCERTAIN', error.message);
            if (error instanceof ControlledToolError || error instanceof ControlledPayloadError) throw error;
            throw new ControlledToolError('CORNELL_INVALID', error instanceof Error ? error.message : 'Research did not satisfy the Cornell format.');
          }
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
        const prompt = this.prompt(run, stage, contract, binding.review_purpose, binding) + (specialist ? `\n\nBounded specialist consultation: ${specialist.objective}. Inspect and report your findings; this is a consultation, not a repair diagnosis.` : '');
        let receipt = await this.launch({ role, prompt, workflow_id: id, task_id: binding.task_id, request_id: attempt.request_id }, signal);
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
          const hardFailure = /CONTROLLED_TOOL_LOOP|MODEL_NOT_SUPPORTED|MODEL_NOT_FOUND|AUTHENTICATION_REQUIRED|AUTHORIZATION_DENIED|CONTEXT_LIMIT_EXCEEDED|TOOL_CALLING_UNSUPPORTED|NoPermissions|NotFound|access denied|permission|policy|configuration changed|cancelled|canceled/i.test(message);
          if (!hardFailure && this.repair(run, kind, message)) continue;
          this.block(run, kind, message); return;
        }
        if (active.report.outcome !== 'completed') {
          const handoff = stage === 'implementation' && active.report.outcome === 'blocked' && contract ? this.roleHandoff(run, active, contract) : null;
          if (handoff) {
            run.role_handoff = handoff;
            if (!this.repair(run, 'protocol', 'A backend-observed write refusal belongs to the independent Verifier. Re-read your current implementation outputs and finish only your own scope. Save a new honest completed producer report only when those outputs are ready; the backend will dispatch Verifier afterwards. The earlier blocked report remains unsubmitted.')) return;
            continue;
          }
          const kind = this.reportedFailureKind(run, active);
          if (!this.repair(run, kind, active.report.summary)) return;
          continue;
        }
        if (specialist) { run.status = 'queued'; save(this.root, run, 'consultation-complete', `${role} consultation saved.`); continue; }
        if (stage === 'planning') {
          if (!run.contract_hash) {
            if (run.pending_plan?.attempt_id === active.id) { run.status = 'waiting'; save(this.root, run, 'scope-wait', 'Completed Coordinator retained; waiting for required scope before freezing.'); continue; }
            this.block(run, 'protocol', 'Planning session returned without saving a semantic plan.'); return;
          }
          run.phase = 'implementation';
        } else if (stage === 'implementation') {
          if (documentation) delete run.pending_documentation;
          saveStatus(this.root, contract!.task_id, 'submitted'); run.phase = 'verification';
        }
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
          if (contract!.plan.procedure_candidate) {
            const producer = [...run.attempts].reverse().find(item => item.stage === 'implementation' && item.state === 'completed');
            const definition = contract!.plan.procedure_candidate;
            const existing = run.procedure_candidate_id ? resolveProcedure(this.root, run.procedure_candidate_id, run.procedure_candidate_version ?? '1.0.0') : null;
            if (!existing || existing.script_sha256 !== hash(readFileSync(safePath(this.root, definition.script))) ||
                existing.verification_sha256 !== hash(readFileSync(safePath(this.root, definition.verification_script)))) {
              const candidate = registerProcedure(this.root, { ...definition,
                id: `workflow-${hash(run.workflow_id).slice(0, 24)}`, version: `1.0.${run.repairs}`, author: producer!.invocation_id! });
              run.procedure_candidate_id = candidate.id; run.procedure_candidate_version = candidate.version;
              save(this.root, run, 'procedure-registered', 'Actual scripts registered as a reusable candidate before independent final review; fixture runs do not qualify it.');
            }
          }
          const documentation = pendingEvidenceDocumentation(run, contract!);
          if (documentation) {
            run.pending_documentation = documentation; run.phase = 'implementation';
            save(this.root, run, 'evidence-documentation-needed', 'Passed independent checks are now available for the promised final execution report; fresh verification follows.');
          } else run.phase = contract?.knowledge_directory && !controlledKnowledgeFreshness(run, contract, id => getRecord(this.root, id)).ready
            ? 'synthesis' : readContract(this.root, run).reviewer_required ? 'review' : 'completed';
        } else if (stage === 'review') {
          if (active.report.verdict !== 'pass') { if (!this.repair(run, active.report.failure_kind ?? 'unknown', active.report.summary)) return; continue; }
          if (attempt.purpose === 'check-review') { delete run.pending_check_review; run.phase = 'verification'; }
          else run.phase = 'completed';
        } else if (stage === 'synthesis') {
          if (!contract || !controlledKnowledgeFreshness(run, contract, id => getRecord(this.root, id)).ready) {
            this.block(run, 'protocol', 'Final synthesis must save its requested evidence-derived Cornell bundle; a primary note does not substitute for it.'); return;
          }
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
  private prompt(run: ControlledSnapshot, stage: Stage, contract?: Contract, reviewPurpose: ControlledBinding['review_purpose'] = 'final-product', binding?: ControlledBinding): string {
    const original = run.continuation && !contract ? readNativeSoftwareContract(this.root, run.workflow_id) : undefined;
    const obligations = original ? continuationObligations(original.plan.acceptance_criteria) : undefined;
    const recovery = stage === 'planning' ? controlledPlanningRecovery(this.root, run) : [];
    const documentation = stage === 'implementation' ? run.pending_documentation : undefined;
    const operations = binding ? new Set(controlledToolNames(binding)) : new Set<string>();
    const reportPaths = contract ? evidenceReportPaths(contract.plan) : [];
    return [
      `User requirement:\n${run.requirement}`,
      `Your stage: ${stage}. Use only the supplied semantic tools. Runtime owns identity, records, transitions and checks.`,
      stage === 'planning' ? 'Inspect the project and existing scripts. Save one bounded workflow_plan, then assignment_report. Define an independently authored checker in verification_paths, disjoint from implementation paths. Use explicit check argv. Keep ordinary work low-risk; elevate real security/storage/runtime changes.' : '',
      recovery.length ? `Earlier backend validation in this same execution, retained across resume. These are diagnostic constraints, not an accepted plan or instructions to replay a request:\n${JSON.stringify(recovery)}` : '',
      contract ? `Immutable plan:\n${JSON.stringify(contract.plan)}` : '',
      contract?.knowledge_directory ? `Managed final knowledge destination: ${contract.knowledge_directory}. Coordinator synthesis must compile a separate evidence-derived research Cornell bundle after checks and before final review.` : '',
      contract?.plan.cornell_output_dir && !documentation ? `Primary Cornell deliverable: ${contract.plan.cornell_output_dir}. Its producer interface supplies an expected worked example, without an observed-result field. Verifier independently checks the delivered files. Proof remains in current check receipts and the final report, so do not rewrite checked files to add future proof identities. Any separately assigned final knowledge synthesis retains its own evidence obligations.` : '',
      contract?.continuation ? `Continuation uses a NEW execution task linked to the unchanged historical task. Required obligations: ${JSON.stringify(contract.continuation.obligations)}. Preservation inputs are backend-fingerprinted. A planned intended-use check is separate from fixture checks; the backend appends --neomind-pilot-root <owned-temp-directory> and --neomind-pilot-nonce <nonce>. The backend supplies fresh owned root/nonce flags to both the intended-use check and each associated negative control; negatives retain their declared failing exit and never create positive pilot proof. That independently authored checker mode must prepare pilot-input.json in that directory: {schema_version:1,kind:"intended-use",nonce,note:"relative/note.md",python:"absolute configured Python",case_classes:[at least ten meaningful classes],solutions:[{language:"c11",source:"relative/program.c",compiler:"absolute configured gcc",local_test:true|false},{language:"cpp17",source:"relative/program.cpp",compiler:"absolute configured g++",local_test:true|false}]}. Generate an explicitly disposable intended-use exercise via the actual adapter, with problem-specific notes and independently authored per-language oracle/harness; do not copy fixture outcomes. The backend independently runs the canonical Cornell validator, fresh strict builds and each executable, retaining actual evidence. Do not remove the owned pilot directory before the backend collects it.` : '',
      original ? `Original saved plan, scope, outputs, criteria and positive checks must be retained. Reuse these exact scope values and argv:\n${JSON.stringify(original.plan)}` : '',
      obligations ? `Required continuation plan additions: ${[
        'Explicit negative controls in the existing independent verification scope.',
        ...(obligations.registration ? ['A procedure_candidate manifest bound to the actual producer and independent checker scripts; inspect their existing CLI schema before declaring parameters.'] : []),
        ...(obligations.intended_use ? ['Keep the original self-check and add a separate check with purpose intended-use. Runtime appends --neomind-pilot-root and --neomind-pilot-nonce arguments to the reviewed checker; its pilot mode prepares pilot-input.json there. Runtime validates it and executes fresh canonical Cornell/C11/C++17 checks.'] : []),
        ...(obligations.preservation ? ['preservation_paths listing the existing exercises and canonical assets that must remain byte-identical.'] : []),
      ].join(' ')}` : '',
      run.reuse?.manager_brief ?? '',
      `Cornell destination default: ${readCornellDestination(this.root).directory}/${run.workflow_id.toLowerCase()}. Only add a Cornell bundle when requested by the user.`,
      run.blocker ? `Repair/diagnosis context:\n${JSON.stringify(run.blocker)}` : '',
      `Prior reports:\n${JSON.stringify(run.attempts.filter(item => item.report).slice(-4).map(item => ({ stage: item.stage, report: item.report })))}`,
      'Your current signed-session context establishes the active Bridge and model request. Use runtime_context only for missing execution facts; one completed snapshot suffices. Continue the role work after preflight_complete instead of repeating unchanged context queries. Optional executable paths must come from actual project configuration, never guessed locations. Missing optional languages do not invalidate the session. Client intake setup instructions do not become worker preconditions.',
      stage === 'planning' ? 'Declare required producer execution_steps before freeze. For requested post-check factual reports, declare evidence_report_paths as exact outputs also listed in documentation_paths. Preserve all promised output and independent check criteria.' : '',
      operations.has('task_run') ? 'Use the available task_run only for its bound producer operations. A blocked automatic-reuse candidate does not prohibit a separately scoped direct operation. Prepared JSON data is passed by input_path when declared in that operation input_paths, without recopying serialized tool text.' : '',
      documentation ? `Post-verification documentation purpose. Write ONLY these already promised report outputs: ${JSON.stringify(documentation.paths)}. Implementation, checker and Cornell files are read-only. Read check_evidence for the actual completed checkpoint commands, diagnostics, exits and limitations. Report its actual facts without claiming future final review, final verification or workflow closure. Save one assignment_report when the reports are complete. Backend runs fresh independent verification before required review and acceptance. This is a normal scheduled handoff, not a product repair or permission to change scope.` : '',
      stage === 'implementation' && !documentation && reportPaths.length ? `Promised final execution reports: ${JSON.stringify(reportPaths)}. Create their truthful implementation handoff before reporting this stage complete so the first check can fingerprint all declared outputs. State that independent results are pending; record only actual observations already available. The backend schedules their factual post-check completion separately, followed by fresh full verification. These handoff files do not establish acceptance.` : '',
      contract && (stage === 'review' || stage === 'verification' || documentation) ? `Current backend workflow evidence: ${JSON.stringify(controlledReviewContext(this.root, run, contract, reviewPurpose))}\nRead check_evidence({kind:"workflow"}) to refresh the original preservation and report lifecycle observations. This preserves only the declared historical coverage; do not require an invented whole-repository baseline. Genuine missing or changed required artifacts remain defects.` : '',
      stage === 'synthesis' ? `Current actual evidence: ${JSON.stringify(currentControlledChecks(run).filter(check => !check.negative && check.passed).map(check => ({ title: check.title, evidence_id: check.evidence_id, source_uri: `record:${check.evidence_id}` })))}. Use check_evidence for bounded actual stdout/stderr; private runtime log files are not readable source files. The backend binds evidence and source metadata automatically; cite supplied source_uri or readable project files, and describe only facts supported by these checks.` : '',
      contract?.plan.procedure_candidate && (stage === 'synthesis' || stage === 'review' && reviewPurpose === 'final-product')
        ? `Current backend registry observation: ${JSON.stringify(controlledRegistrationEvidence(this.root, run, contract))}\nUse check_evidence({kind:"registration"}) to refresh this exact bound manifest observation. It is actual registry provenance, not a separate native signed receipt, independent contract review or automatic-reuse qualification.` : '',
      stage === 'verification' ? 'Independently inspect implementation, author only checker files, execute check_run, and report pass/fail. Include negative controls that prove bad output fails. Distinguish product defects from checker defects.' : '',
      stage === 'verification' && contract ? `Current check phase: ${controlledChecksForPhase(run, contract).length === contract.plan.checks.length ? 'full final independent verification' : 'product checkpoint before the factual report is written'}. Available check titles: ${JSON.stringify(controlledChecksForPhase(run, contract).map(check => check.title))}. A checkpoint pass is not final acceptance. The backend retains every deferred report check and runs the complete contract after documentation.` : '',
      stage === 'verification' && run.check_reconciliations?.length ? 'Historical interruption context: an earlier checker has outcome UNKNOWN under an explicit unsigned local maintenance effect assessment. Its original intent and interrupted session remain unchanged. No command was automatically replayed and no passing/cancelled execution result was invented. Inspect the current bound implementation/checker inputs and obtain fresh prescribed positive/negative evidence through this new Verifier session before reporting a verdict.' : '',
      stage === 'review' ? controlledReviewInstructions(reviewPurpose) : '',
      stage === 'diagnosis' ? 'Diagnose existing evidence without modifying files. Report failure_kind implementation/checker/protocol/environment, concrete findings, and bounded repair direction.' : '',
    ].filter(Boolean).join('\n\n');
  }
  private async executeTask(id: string, attemptId: string, value: ControlledExecutionInput, signal: AbortSignal,
    assertActive: () => void): Promise<unknown> {
    assertActive();
    const input = controlledExecutionSchema.parse(value), requestHash = hash(canonicalJson(input));
    let run = readState(this.root, id);
    const contract = readContract(this.root, run), attempt = run.attempts.find(item => item.id === attemptId);
    if (attempt?.stage !== 'implementation' || attempt.role !== 'developer' || attempt.id !== run.attempts.at(-1)?.id || !attempt.invocation_id)
      throw new ControlledToolError('SCOPE_DENIED', 'Only the active bound Implementer may run a producer operation.');
    if (contract.plan.execution_steps !== undefined) {
      const step = contract.plan.execution_steps.find(item => item.title === input.title);
      const { input: _payload, ...declaration } = input;
      if (!step || !same(controlledExecutionDeclarationSchema.parse(step), declaration))
        throw new ControlledToolError('INVALID_EXECUTION', 'Use an execution_steps operation exactly as frozen in the plan; provide only its prepared JSON input.');
    }
    const summarize = (saved: any, replayed: boolean) => ({ replayed, passed: saved.execution?.passed ?? false,
      command: saved.execution?.command ?? input.command, exit_code: saved.execution?.result?.exit_code ?? null,
      stdout: saved.execution?.result?.stdout?.slice(-24000) ?? '', stderr: saved.execution?.result?.stderr?.slice(-12000) ?? '',
      cancelled: saved.execution?.result?.cancelled ?? false, timed_out: saved.execution?.result?.timed_out ?? false,
      output_hashes: saved.execution?.output_hashes ?? {}, not_started: saved.not_started ?? false,
      ...(saved.start_failure ? { start_failure: saved.start_failure } : {}),
      ...(saved.execution?.passed ? {} : { error: 'The local operation did not pass. Inspect its retained actual result and correct the script or JSON input before retrying.' }),
      ...(saved.rollback ? { rollback: { complete: saved.rollback.complete,
        retained_failed_outputs: saved.rollback.archived?.map((item: any) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes, removed: item.removed })),
        uncertain_paths: saved.rollback.uncertain_paths, reason: saved.rollback.reason } } : {}),
      note: 'Observed direct local execution; independent verification remains required. Registry qualification was not changed.' });
    const prior = [...(run.local_executions ?? [])].reverse().find(item => item.request_hash === requestHash &&
      (item.attempt_id === attemptId || item.state === 'completed'));
    if (prior) {
      if (prior.state !== 'completed' || !prior.result_path || !prior.result_sha256)
        throw new ControlledToolError('STATE_UNCERTAIN', 'This local operation has no durable result. Preserve and reconcile its effects before retrying.');
      const bytes = readFileSync(safePath(this.root, prior.result_path));
      if (hash(bytes) !== prior.result_sha256) throw new ControlledToolError('STATE_UNCERTAIN', 'The immutable local execution result changed.');
      const saved = JSON.parse(bytes.toString('utf8'));
      if (saved.workflow_id !== id || saved.epoch_id !== run.epoch_id || saved.contract_hash !== run.contract_hash || saved.request_hash !== requestHash)
        throw new ControlledToolError('STATE_UNCERTAIN', 'Saved local execution belongs to another immutable operation.');
      const inputMatches = !saved.execution || same(saved.execution.baseline, fingerprints(this.root, Object.keys(saved.execution.baseline)));
      const expectedOutputs = saved.rollback?.complete
        ? Object.fromEntries(Object.keys(saved.execution?.output_hashes ?? {}).map(path => [path, 'missing'])) : saved.execution?.output_hashes;
      const outputMatches = !expectedOutputs || same(expectedOutputs, fingerprints(this.root, Object.keys(expectedOutputs)));
      if (!outputMatches || saved.execution?.passed && !inputMatches)
        throw new ControlledToolError('INPUT_CHANGED', 'Local execution inputs or outputs changed after the saved result. Inspect the current artifacts before continuing.');
      if (inputMatches) return summarize(saved, true);
      if (!saved.rollback?.complete)
        throw new ControlledToolError('STATE_UNCERTAIN', 'A failed local operation needs safe effect reconciliation before another execution.');
      // A producer-authored script changed after a retained failed operation.
      // The exact new source must have been read through the bound file tool.
    }
    let prepared;
    try { prepared = prepareControlledExecution(this.root, { stage: 'implementation', role: 'developer',
      implementation_paths: contract.plan.allowed_paths, verification_paths: contract.plan.verification_paths,
      read_paths: ['.'], approved_inputs: contract.plan.input_paths, protected_paths: this.protectedPaths(contract),
      preserved_hashes: contract.preserved_hashes }, input); }
    catch (error) {
      if (error instanceof ControlledExecutionError) throw new ControlledToolError(error.code, error.message);
      throw error;
    }
    const operationId = randomUUID(), folder = `.neomind/controlled/executions/${operationId}`;
    const { input: _directInput, ...declaredOperation } = input;
    const guardedBefore = fingerprints(this.root, [...contract.plan.verification_paths, ...this.protectedPaths(contract)]);
    const identity = { schema_version: 1, kind: 'controlled-direct-local-execution', id: operationId,
      workflow_id: id, task_id: contract.task_id, epoch_id: run.epoch_id, contract_hash: run.contract_hash,
      attempt_id: attemptId, invocation_id: attempt.invocation_id, request_hash: requestHash };
    const intent = JSON.stringify({ ...identity, created_at: now(), authorization: 'immutable-producer-scope',
      command: prepared.command, input_sha256: prepared.input_sha256, baseline: prepared.baseline,
      output_baseline: prepared.output_baseline, payload_hash: prepared.payload_hash,
      declaration: controlledExecutionDeclarationSchema.parse(declaredOperation), guarded_before: guardedBefore }, null, 2) + '\n';
    atomicWrite(safePath(this.root, `${folder}/intent.json`), intent);
    run.local_executions = [...(run.local_executions ?? []), { id: operationId, attempt_id: attemptId,
      request_hash: requestHash, title: input.title, state: 'running', intent_path: `${folder}/intent.json`, intent_sha256: hash(intent) }];
    save(this.root, run, 'local-execution-authorized', 'Backend bound the local script, input hashes and producer-only output scope. No procedure qualification was granted.');
    let execution: Awaited<ReturnType<typeof runControlledExecution>> | undefined, started = false, notStarted = false;
    let startFailure: { code: string; rule: string } | undefined;
    try {
      execution = await runControlledExecution(prepared, { signal, assertActive, onStart: pid => {
        started = true; const current = readState(this.root, id);
        current.local_executions!.find(item => item.id === operationId)!.pid = pid; save(this.root, current);
      } });
    } catch (error) {
      if (started) throw error; // An unobserved started process remains uncertain; never invent a result.
      notStarted = true;
      startFailure = error instanceof ControlledExecutionError ? { code: error.code, rule: error.message }
        : { code: signal.aborted ? 'ACTOR_INACTIVE' : 'CONTROLLED_OPERATION_FAILED',
          rule: signal.aborted ? 'The owned operation was cancelled before process start.' : 'The backend could not start this bound local operation.' };
    }
    const guardedAfter = fingerprints(this.root, [...contract.plan.verification_paths, ...this.protectedPaths(contract)]);
    const guardMatches = same(guardedBefore, guardedAfter);
    if (execution && !guardMatches) { execution.passed = false; execution.changed_inputs.push(...Object.keys(guardedBefore).filter(path => guardedBefore[path] !== guardedAfter[path])); }
    const raw = { ...identity, finished_at: now(), execution, not_started: notStarted, start_failure: startFailure,
      guarded_before: guardedBefore, guarded_after: guardedAfter };
    atomicWrite(safePath(this.root, `${folder}/execution.json`), JSON.stringify(raw, null, 2) + '\n');
    const rollback = execution && !execution.passed && guardMatches
      ? rollbackControlledExecutionOutputs(prepared, execution, `${folder}/failed-outputs`) : undefined;
    const result = { ...raw, rollback };
    const bytes = JSON.stringify(result, null, 2) + '\n', path = `${folder}/result.json`;
    atomicWrite(safePath(this.root, path), bytes);
    run = readState(this.root, id);
    const entry = run.local_executions!.find(item => item.id === operationId)!;
    entry.state = 'completed'; entry.result_path = path; entry.result_sha256 = hash(bytes); entry.passed = execution?.passed ?? false;
    if (!guardMatches || rollback && !rollback.complete) {
      run.status = 'uncertain'; run.blocker = { kind: 'protocol', message: 'Local execution effects differ from another role or protected baseline. Retained artifacts require reconciliation; no files were silently overwritten.' };
    }
    save(this.root, run, 'local-execution-result', notStarted ? 'Owned local operation ended before process start; no execution pass was recorded.' :
      `Actual direct local execution ${execution?.passed ? 'succeeded' : 'did not pass'}; result and output hashes retained.`);
    return summarize(result, false);
  }

  private reportedFailureKind(run: ControlledSnapshot, attempt: Attempt): FailureKind {
    const reported = attempt.report?.failure_kind ?? 'unknown';
    if (reported !== 'environment') return reported;
    // A model's setup assumption is not an observed environment failure. The
    // provider failure path above already uses the actual signed native result.
    for (const entry of run.local_executions ?? []) if (entry.attempt_id === attempt.id && entry.result_path) {
      const result = JSON.parse(readFileSync(safePath(this.root, entry.result_path), 'utf8')).execution?.result;
      if (typeof result?.error === 'string' && /\b(?:ENOENT|EACCES|EPERM|ENOSPC|ECONNREFUSED)\b/.test(result.error)) return 'environment';
    }
    const directory = safePath(this.root, '.neomind/controlled/context');
    const contract = run.contract_hash ? readContract(this.root, run) : undefined;
    const commands = [...(contract?.plan.checks.flatMap(check => [check.command, ...(check.negative_controls ?? []).map(control => control.command)]) ?? []),
      ...(contract?.plan.execution_steps?.map(step => step.command) ?? [])];
    const required = new Set(commands.map(command => command[0]!.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase()));
    const latest = existsSync(directory) ? readdirSync(directory).filter(name => name.startsWith(`${attempt.id}.`))
      .sort((a, b) => lstatSync(join(directory, b)).mtimeMs - lstatSync(join(directory, a)).mtimeMs)[0] : undefined;
    if (latest) {
      const observation = JSON.parse(readFileSync(join(directory, latest), 'utf8'));
      const names: Record<string, string[]> = { node: ['node'], python: ['python', 'python3'], c11: ['gcc', 'clang'], cpp17: ['g++', 'clang++'] };
      if (observation.toolchain?.observations?.some((item: any) => item.available === false &&
        names[item.program]?.some(program => required.has(program)))) return 'environment';
    }
    return 'unknown';
  }

  private async checks(id: string, attemptId: string, signal: AbortSignal, title?: string): Promise<unknown> {
    let run = readState(this.root, id);
    const contract = readContract(this.root, run), attempt = run.attempts.find(item => item.id === attemptId);
    if (!attempt?.invocation_id || attempt.stage !== 'verification') throw new Error('Only the bound Verifier can run planned checks.');
    if (contract.precheck_review && !this.checkApproval(run, contract))
      return { status: 'awaiting-independent-check-review', next: 'Save a completed preparation report with verdict pass and the actual checker artifacts. Runtime obtains exact-byte review before executing these checks.' };
    const selected = controlledChecksForPhase(run, contract).filter(check => title === undefined || check.title === title).flatMap(check => {
      // Associated negative commands need the same adapter context as their
      // parent, without inheriting its positive-proof or acceptance semantics.
      const runtimePilotContext = check.purpose === 'intended-use' && contract.continuation?.obligations.pilot_kind === 'leetcode-c11-cpp17';
      return [{ ...check, negative: false, runtimePilotContext }, ...(check.negative_controls ?? []).map(negative =>
        ({ ...negative, timeout_ms: check.timeout_ms, negative: true, runtimePilotContext }))];
    });
    if (!selected.length) throw new Error('Choose a check title from the assigned plan.');
    for (const check of selected) {
      run = readState(this.root, id);
      const baseline = fingerprints(this.root, check.baseline_paths);
      const prior = run.checks.find(item => item.attempt_id === attemptId && item.title === check.title && same(item.baseline, baseline));
      if (prior) continue;
      const checkId = randomUUID(), logPath = `.neomind/controlled/checks/${checkId}.log`;
      const purpose = !check.negative && 'purpose' in check && check.purpose === 'intended-use' ? 'intended-use' as const : 'self-check' as const;
      // A generic check's purpose describes its evidence, not its task family.
      // Only the explicitly bound continuation adapter may add argv or impose
      // the independent Cornell/C11/C++17 pilot proof on the declared command.
      const requiresPilotProof = !check.negative && check.runtimePilotContext;
      const pilotRoot = check.runtimePilotContext ? realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'neomind-intended-use-'))) : undefined;
      const pilotNonce = pilotRoot ? randomUUID() : undefined;
      const command = pilotRoot ? [...check.command, '--neomind-pilot-root', pilotRoot, '--neomind-pilot-nonce', pilotNonce!] : check.command;
      const evidenceInput = prepareControlledCheckEvidence(this.root, run, contract, check, baseline, attempt.invocation_id);
      run.check_intents ??= [];
      run.check_intents.push({ id: checkId, attempt_id: attemptId, title: check.title, baseline, state: 'starting',
        ...(pilotRoot ? { pilot_root: pilotRoot, pilot_nonce: pilotNonce } : {}) });
      save(this.root, run, 'check-start', check.title);
      const deadline = Date.now() + (check.timeout_ms ?? 60000);
      const result = await runCommand({ command, cwd: this.root, signal, timeout_ms: check.timeout_ms ?? 60000,
        onStart: pid => { const current = readState(this.root, id), intent = current.check_intents!.find(item => item.id === checkId)!;
          intent.state = 'running'; intent.pid = pid; save(this.root, current); } });
      let pilot: { path: string; sha256: string } | undefined, pilotError: string | undefined;
      if (requiresPilotProof && pilotRoot && result.exit_code === 0 && !result.cancelled && !result.timed_out && !result.output_limited && !result.error) {
        try { pilot = await executeControlledPilot(this.root, run, checkId, pilotRoot, pilotNonce!, signal, deadline); }
        catch { pilotError = 'The intended-use pilot did not produce valid retained artifacts and passing independent validation/build/run results.'; }
      }
      const log = JSON.stringify({ command, planned_command: check.command, purpose, baseline, result, pilot, pilot_error: pilotError }, null, 2) + '\n';
      atomicWrite(safePath(this.root, logPath), log);
      run = readState(this.root, id);
      run.check_intents!.find(item => item.id === checkId)!.state = 'completed';
      run.checks.push({ id: checkId, attempt_id: attemptId, invocation_id: attempt.invocation_id, title: check.title,
        command, planned_command: check.command, purpose, baseline, log_path: logPath, log_sha256: hash(log), exit_code: result.exit_code,
        expected_exit_code: check.expected_exit_code ?? 0, negative: check.negative,
        passed: result.exit_code === (check.expected_exit_code ?? 0) && !result.cancelled && !result.timed_out && !result.output_limited && !result.error && !pilotError &&
          (!requiresPilotProof || !!pilot) && same(baseline, fingerprints(this.root, check.baseline_paths)),
        cancelled: result.cancelled, at: now(), evidence_input: evidenceInput,
        ...(pilot ? { pilot_receipt_path: pilot.path, pilot_receipt_hash: pilot.sha256 } : {}) });
      const savedCheck = run.checks.at(-1)!;
      savedCheck.evidence_id = materializeControlledEvidence(this.root, run, contract, savedCheck);
      save(this.root, run, 'check-result', `${check.title}: ${run.checks.at(-1)!.passed ? 'passed' : 'failed'}.`);
      if (signal.aborted) break;
    }
    run = readState(this.root, id);
    return { checks: run.checks.filter(item => item.attempt_id === attemptId).map(item => ({ title: item.title, passed: item.passed, exit_code: item.exit_code, evidence: item.log_path })) };
  }
  private repair(run: ControlledSnapshot, kind: FailureKind, message: string, diagnosed = false): boolean {
    this.reconcileRepairBudget(run);
    const budget = run.repair_budget!, max = readConfig(this.root).repair_attempts;
    run.blocker = { kind, message: message.slice(0, 2000) };
    if (kind === 'unknown' && !diagnosed) {
      if (run.attempts.some(attempt => attempt.stage === 'diagnosis' && attempt.purpose !== 'specialist')) { this.block(run, kind, `Diagnostic reconciliation exhausted. ${message}`); return false; }
      run.phase = 'diagnosis';
    } else if (kind === 'implementation' || kind === 'checker') {
      if (budget.product >= max) { this.block(run, kind, `Product/checker repair budget exhausted. ${message}`); return false; }
      run.phase = kind === 'implementation' ? 'implementation' : 'verification'; budget.product++; run.repairs = budget.product;
    } else if (kind === 'protocol' || kind === 'environment') {
      if (budget[kind] >= 1) { this.block(run, kind, `${kind === 'protocol' ? 'Protocol' : 'Environment'} reconciliation budget exhausted. ${message}`); return false; }
      budget[kind]++;
    }
    else { this.block(run, kind, message); return false; }
    run.status = 'queued'; save(this.root, run, 'repair', `Backend routes ${kind} to ${run.phase}.`); return true;
  }
  private reconcileRepairBudget(run: ControlledSnapshot): void {
    if (run.repair_budget) { controlledRepairBudget(run); return; }
    const legacy = run.repairs, budget = controlledRepairBudget(run);
    run.repair_budget = budget; run.repairs = budget.product;
    run.repair_counter_migration = { legacy_count: legacy, product: budget.product, protocol: budget.protocol, environment: budget.environment };
    save(this.root, run, 'repair-budget-reconciled', 'Saved backend repair events reconciled into separate product, protocol and environment limits; prior events and reports remain unchanged.');
  }
  private roleHandoff(run: ControlledSnapshot, attempt: Attempt, contract: Contract): ControlledSnapshot['role_handoff'] | null {
    if (attempt.role !== 'developer' || !attempt.invocation_id || attempt.report?.outcome !== 'blocked') return null;
    if (attempt.report.failure_kind !== undefined && attempt.report.failure_kind !== 'protocol') return null;
    const own = fingerprints(this.root, contract.plan.outputs);
    if (Object.values(own).some(value => value === 'missing') || !Object.entries(own).every(([path, digest]) => attempt.bound_hashes?.[path] === digest)) return null;
    const receipt = readInvocation(this.root, attempt.invocation_id);
    if (receipt.task_id !== contract.task_id || receipt.request_id !== attempt.request_id || receipt.controlled_execution?.epoch_id !== run.epoch_id ||
        routingProblems(this.root, 'developer', receipt.id, { workflow_id: run.workflow_id, task_id: contract.task_id }).length) return null;
    const ids = [...new Set(run.events.flatMap(event => /trace ([a-f0-9-]{36})$/.exec(event.summary)?.[1] ?? []))].slice(-512);
    const traces: { id: string; value: any }[] = [];
    for (const id of ids) {
      const path = safePath(this.root, `.neomind/controlled/traces/${id}.json`);
      if (!existsSync(path) || lstatSync(path).size > 128000) continue;
      try { const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.attempt_id === attempt.id && value.epoch_id === run.epoch_id && value.workflow_id === run.workflow_id) traces.push({ id, value });
      } catch { return null; }
    }
    const bound = (value: any) => value.backend_binding?.workflow_id === run.workflow_id && value.backend_binding?.task_id === contract.task_id && value.backend_binding?.invocation_id === attempt.invocation_id;
    const verifierPath = (path: unknown): path is string => {
      if (typeof path !== 'string') return false;
      try { canonical(this.root, path); } catch { return false; }
      return covers(path, contract.plan.verification_paths) && !covers(path, contract.plan.allowed_paths) && !covers(path, this.protectedPaths(contract));
    };
    const failures = traces.filter(({ value }) => value.event === 'tool-result' && value.tool === 'task_file_write' && value.status === 'failed');
    if (!failures.length || failures.some(({ value }) => value.code !== 'SCOPE_DENIED')) return null;
    const ownership = (value: any) => ({ rule: value.rule ?? value.ownership?.rule,
      target_owner: value.target_owner ?? value.ownership?.target_owner, target_path: value.target_path ?? value.ownership?.target_path });
    if (failures.every(({ value }) => { const validation = ownership(value);
      return validation.rule === 'ROLE_HANDOFF_REQUIRED' && validation.target_owner === 'verifier' && verifierPath(validation.target_path) && bound(value); })) {
      const failed = failures[0]!, validation = ownership(failed.value);
      return { attempt_id: attempt.id, task_id: contract.task_id, denial_trace: failed.id, target_path: validation.target_path, legacy_trace: false };
    }
    // Older 2f results omitted ownership. Pair only a bounded, unambiguous set of
    // preceding requests in this actual attempt/task. New ownership cannot be
    // downgraded to this legacy rule when it contradicts the required handoff.
    if (failures.length > 4 || failures.some(({ value }) => {
      const validation = ownership(value);
      return validation.rule !== undefined || validation.target_owner !== undefined || validation.target_path !== undefined;
    })) return null;
    let proof: ControlledSnapshot['role_handoff'] | null = null;
    for (const failed of failures) {
      const ended = Date.parse(failed.value.at);
      const requests = traces.filter(({ value }) => value.event === 'tool-request' && value.tool === 'task_file_write' && bound(value) && Date.parse(value.at) <= ended)
        .sort((a, b) => Date.parse(b.value.at) - Date.parse(a.value.at));
      const request = requests[0];
      if (!request || !Number.isFinite(ended) || !verifierPath(request.value.model_input?.path) ||
          requests[1] && Date.parse(requests[1].value.at) === Date.parse(request.value.at)) return null;
      proof = { attempt_id: attempt.id, task_id: contract.task_id, denial_trace: failed.id, target_path: request.value.model_input.path, legacy_trace: true };
    }
    return proof;
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
    const producer = latest('implementation'), verifier = latest('verification'), reviewer = latest('review');
    const acceptance = () => {
      const verified = verifyControlledTask(this.root, getRecord(this.root, contract.task_id), 'accepted');
      if (!verified?.ok) throw new ControlledToolError('ACCEPTANCE_INCOMPLETE', verified?.findings.map(item => item.message).join('\n') ?? 'Controlled acceptance is unavailable.');
    };
    acceptance();
    const checks = run.checks.filter(check => check.attempt_id === verifier!.id);
    const output = fingerprints(this.root, contract.plan.outputs);
    const existingReport = run.finalizing_report_id ? getRecord(this.root, run.finalizing_report_id)
      : loadRecords(this.root).find(record => record.meta.data.kind === 'controlled-final-report' && record.meta.data.workflow_id === run.workflow_id && record.meta.data.epoch_id === run.epoch_id);
    const report = existingReport ?? createRecord(this.root, { type: 'knowledge', title: `Completed: ${contract.plan.title}`.slice(0, 256), owner: 'manager',
      data: { kind: 'controlled-final-report', workflow_id: run.workflow_id, epoch_id: run.epoch_id, contract_hash: run.contract_hash,
        invocation_ids: [producer!.invocation_id, verifier!.invocation_id, reviewer?.invocation_id].filter(Boolean),
        evidence: checks.map(check => check.log_path), output_hashes: output, cornell_note_ids: run.cornell_note_ids ?? [], assurance: 'invocation-bound-local' },
      body: `# Result\n${producer!.report!.summary}\n\n# Independent verification\n${verifier!.report!.summary}\n\n# Evidence\n${checks.map(check => `- ${check.log_path}`).join('\n')}\n\n# Limitations\nModel identities are local VS Code vendor/model observations; upstream 9router model identity is unverified.\n` });
    if (report.meta.data.kind !== 'controlled-final-report' || report.meta.data.workflow_id !== run.workflow_id || report.meta.data.epoch_id !== run.epoch_id ||
        report.meta.data.contract_hash !== run.contract_hash || !same(report.meta.data.output_hashes, output)) throw new Error('Saved final report belongs to another controlled result.');
    if (!run.finalizing_report_id) { run.finalizing_report_id = report.meta.id; save(this.root, run, 'finalizing', 'Validated closure intent saved.'); }
    saveStatus(this.root, contract.task_id, 'accepted', acceptance);
    saveWorkflowClosure(this.root, run.workflow_id, { data: { phase: 'completed', final_report_id: report.meta.id,
      closed_at: now(), controlled_epoch_id: run.epoch_id, controlled_contract_hash: run.contract_hash,
      completed_execution_task_id: contract.task_id } }, acceptance);
    saveStatus(this.root, run.workflow_id, 'accepted', acceptance);
    run.final_report_id = report.meta.id; run.status = 'completed'; run.phase = 'completed'; delete run.blocker;
    save(this.root, run, 'completed', 'Actual independent checks and required review passed; workflow accepted.');
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<ControlledSnapshot> {
    if (this.closed && action === 'resume') throw new ControlledToolError('ACTOR_INACTIVE', 'The controlled owner is closing; reopen the Model Bridge before resuming work.');
    const admission = maintenanceLockKey(id), deadline = Date.now() + 8000;
    for (;;) {
      try { withOperationLock(this.root, admission, () => {}, 0); break; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith(`Operation ${admission} remains locked.`) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (this.closed && action === 'resume') throw new ControlledToolError('ACTOR_INACTIVE', 'The controlled owner is closing; reopen the Model Bridge before resuming work.');
    if (action === 'resume' && !this.jobs.has(id)) await this.operationDrain.drain(id);
    if (this.closed && action === 'resume') throw new ControlledToolError('ACTOR_INACTIVE', 'The controlled owner is closing; reopen the Model Bridge before resuming work.');
    const run = readState(this.root, id);
    if (run.status === 'completed' || run.status === 'cancelled') {
      await this.operationDrain.drain(id); return readState(this.root, id);
    }
    const job = this.jobs.get(id);
    if (action === 'resume' && run.intake_recovery) return run;
    if (action !== 'resume') {
      run.status = action === 'cancel' ? 'cancelled' : 'paused'; save(this.root, run, action, `User requested ${action}.`);
      job?.abort.abort();
      const active = run.attempts.at(-1);
      if (active?.invocation_id) await interruptNative(this.root, active.invocation_id);
      // Cancelling an MCP client settles its delivery promise before the actual
      // server-side check has finished killing its process and persisting EVD.
      await this.operationDrain.drain(id);
      await job?.promise;
      const current = readState(this.root, id), last = current.attempts.at(-1);
      if (last && last.state !== 'completed') last.state = 'interrupted';
      save(this.root, current); return current;
    }
    if (job) return readState(this.root, id);
    if (!this.admitCheckEffects(run)) return run;
    this.reconcileRepairBudget(run);
    const last = run.attempts.at(-1);
    if (run.status === 'blocked' && run.blocker?.message.startsWith('Product/checker repair budget exhausted.') &&
        (run.blocker.kind === 'implementation' || run.blocker.kind === 'checker')) {
      // An explicit allowance increase resumes the already diagnosed repair,
      // rather than rerunning an unchanged failed review. It never refunds usage.
      if (run.repair_budget!.product >= readConfig(this.root).repair_attempts) return run;
      if (!last || last.state !== 'completed' || !last.report ||
          (last.report.outcome === 'completed' && last.report.verdict !== 'fail') ||
          last.report.failure_kind !== run.blocker.kind || !last.invocation_id || !last.report_id) return run;
      const contract = readContract(this.root, run), report = getRecord(this.root, last.report_id);
      const receipt = readInvocation(this.root, last.invocation_id);
      if (last.report_fingerprint !== evidenceRecordFingerprint(report) ||
          report.meta.data.report_payload_hash !== hash(canonicalJson(last.report)) ||
          report.meta.data.kind !== 'controlled-work-record' || report.meta.data.outcome !== last.report.outcome ||
          report.meta.data.stage !== last.stage ||
          report.meta.data.workflow_id !== run.workflow_id || report.meta.data.epoch_id !== run.epoch_id ||
          report.meta.data.task_id !== contract.task_id || report.meta.data.attempt_id !== last.id ||
          report.meta.data.invocation_id !== last.invocation_id || report.meta.owner !== last.role ||
          receipt.issuer !== 'neomind-vscode-lm' || receipt.state !== 'completed' || !receipt.inference_completed ||
          receipt.workflow_id !== run.workflow_id || receipt.task_id !== contract.task_id || receipt.role !== last.role ||
          receipt.request_id !== last.request_id || receipt.controlled_execution?.epoch_id !== run.epoch_id ||
          receipt.controlled_execution.stage !== last.stage) return run;
      // The completed failure is authenticated against its own signed binding.
      // It is not acceptance evidence under the newly selected project policy.
      run.owner_pid = process.pid; run.owner_instance = readHost(this.root).instance;
      if (!this.repair(run, run.blocker.kind, last.report.summary)) return run;
      save(this.root, run, 'resume', 'Explicit project repair allowance resumed the existing failed result with its next charged product/checker attempt.');
      this.schedule(id); return run;
    }
    if (last && ['running', 'starting'].includes(last.state)) {
      if (last.invocation_id && invocationIsActive(readInvocation(this.root, last.invocation_id))) {
        run.status = 'uncertain'; save(this.root, run, 'uncertain', 'Previous owner needs reconciliation before another invocation.'); return run;
      }
      last.state = 'interrupted';
    }
    run.status = 'queued'; run.owner_pid = process.pid; run.owner_instance = readHost(this.root).instance; delete run.blocker;
    save(this.root, run, 'resume', 'Resume from durable contract and prior results.'); this.schedule(id); return run;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of this.jobs.values()) job.abort.abort();
    this.closing = (async () => {
      const workflows = new Set([...this.jobs.keys(), ...this.operationDrain.workflows()]);
      await Promise.allSettled([...workflows].map(async id => {
        await this.control(id, 'pause');
        await this.operationDrain.drain(id);
        const run = readState(this.root, id); if (run.status === 'paused') { run.status = 'interrupted'; save(this.root, run, 'interrupted', 'VS Code owner closed.'); }
      }));
    })();
    return this.closing;
  }
}

/** INTERNAL trusted-operator maintenance. Never registered as an MCP worker tool. */
export function reconcileInterruptedControlledChecks(root: string, value: InterruptedCheckMaintenanceInput) {
  root = exactRoot(root);
  const input = normalizedMaintenanceInput(value);
  return withOperationLock(root, maintenanceLockKey(input.workflow_id), () => {
    const run = readState(root, input.workflow_id), sealed = readFileSync(contractPath(root, run.workflow_id, run.epoch_id));
    const contract = JSON.parse(sealed.toString('utf8')) as Contract;
    if (hash(sealed) !== run.contract_hash || contract.workflow_id !== run.workflow_id || contract.epoch_id !== run.epoch_id ||
        contract.plan_hash !== hash(JSON.stringify(contract.plan))) throw new Error('The immutable execution identity changed.');
    const existing = readCheckReconciliations(root, run, contract).find(ledger => ledger.expected_revision === input.expected_revision);
    const response = (ledger: typeof existing & {}, sha256: string, replayed: boolean) => ({ id: ledger.id, sha256,
      workflow_id: ledger.workflow_id, epoch_id: ledger.epoch_id, outcome: ledger.outcome, assurance: ledger.assurance, replayed });
    if (existing) {
      if (canonicalJson(existing.assessment) !== canonicalJson(input.assessment)) throw new Error('This maintenance revision already belongs to a different effect assessment.');
      return response(existing, run.check_reconciliations!.find(link => link.id === existing.id)!.sha256, true);
    }
    readContract(root, run);
    const requireDisabledBridge = () => {
      let enabled = false;
      try { readHost(root); enabled = true; } catch { /* A dead or absent descriptor cannot own execution. */ }
      if (enabled) throw new Error('Disable this project Model Bridge before trusted external interruption maintenance.');
    };
    requireDisabledBridge();
    const before = readFileSync(statePath(root, run.workflow_id));
    const authority = controlledContractForTask(root, getRecord(root, contract.task_id));
    if (authority.run.revision !== run.revision || authority.run.contract_hash !== run.contract_hash)
      throw new Error('The authoritative workflow changed before maintenance.');
    const ledger = prepareInterruptedCheckReconciliation(root, run, contract, input, paths => fingerprints(root, paths));
    requireDisabledBridge();
    if (hash(readFileSync(statePath(root, run.workflow_id))) !== hash(before) ||
        hash(readFileSync(contractPath(root, run.workflow_id, run.epoch_id))) !== run.contract_hash)
      throw new Error('Workflow revision or immutable contract changed during maintenance; no ledger was committed.');
    const bytes = `${JSON.stringify(ledger, null, 2)}\n`, path = safePath(root, reconciliationPath(ledger.id));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    const sha256 = hash(readFileSync(path));
    if (sha256 !== hash(bytes)) throw new Error('Immutable maintenance ledger did not persist completely.');
    run.check_reconciliations = [...(run.check_reconciliations ?? []), { id: ledger.id, sha256, intent_ids: ledger.intents.map(intent => intent.id) }];
    save(root, run, 'check-interruption-reconciled', 'Trusted local maintenance assessed quiescent effects; historical command outcome remains UNKNOWN. No execution result was created and no command was replayed.');
    return response(ledger, sha256, false);
  }, 0);
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
  input = controlledStartSchema.parse(input);
  // Preserve this fixed public diagnostic before the credential-hiding wire seam.
  // The owner repeats the same check against current state before dispatch.
  const existing = typeof input.workflow_id === 'string' && input.workflow_id ? getRecord(root, input.workflow_id)
    : typeof input.request_id === 'string' ? loadRecords(root).find(record => record.meta.data.kind === 'manager-workflow' && record.meta.data.request_id === input.request_id) : undefined;
  if (existing) {
    assertIntakePayload(existing, input);
    if (existing.meta.data.execution_mode === 'neomind-controlled' && !existsSync(statePath(root, existing.meta.id)) &&
        input.request_id !== undefined && input.request_id !== existing.meta.data.request_id)
      throw new ControlledToolError('INTAKE_IDENTITY_MISMATCH', 'Recover this intake with its saved request identity; a different identity cannot replace its missing journal.');
    const original = readNativeSoftwareContract(root, existing.meta.id);
    if (original) assertSupportedContinuation(original.plan.acceptance_criteria);
  }
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
