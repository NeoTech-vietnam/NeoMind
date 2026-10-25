import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import { atomicWrite, createRecord, getRecord, hash, loadRecords, now, safePath, updateRecord, withOperationLock } from './storage.js';
import { acceptTask, recordFingerprint, requestRepair, strings, verify } from './engineering.js';
import { decideWorkflow, workflowStatus } from './manager.js';
import { assignmentTaskOptions, authorizeNativeManager, delegateAssignment, inspectNativeAssignment, readReportedAssignment, resolveReportedAssignment, recoverPreparedAssignment,
  type ReportedAssignmentCredential } from './native-assignment.js';
import { followUpNativeAssignment } from './native-recovery.js';
import { readCornellDestination } from './cornell-workflow.js';
import type { ProjectRecord } from './types.js';

const text = z.string().trim().min(20).max(8000);
const paths = z.array(z.string().trim().min(1).max(1024)).max(128);
/** Semantic input only: actor, workflow, record IDs, links and gate policy are server-derived. */
export const nativeSoftwarePlanSchema = z.strictObject({
  process: z.literal('software-tools'), rationale: text, title: z.string().trim().min(5).max(256),
  objective: text, acceptance_criteria: z.array(z.string().trim().min(12).max(2000)).min(1).max(32),
  allowed_paths: paths.min(1), verification_paths: paths.min(1), outputs: paths.min(1), documentation_paths: paths,
  checks: z.array(z.strictObject({ title: z.string().trim().min(8).max(256),
    command: z.array(z.string().min(1).max(8000)).min(2).max(128), baseline_paths: paths.min(1),
    expected_exit_code: z.number().int().min(0).max(255).optional(),
    timeout_ms: z.number().int().min(1).max(600000).optional(),
  })).min(1).max(16), request_id: z.string().trim().min(1).max(256).optional(),
});
export type NativeSoftwarePlanInput = z.infer<typeof nativeSoftwarePlanSchema>;
export interface NativeSoftwareContract {
  schema_version: 1; process: 'software-tools'; workflow_id: string; plan_hash: string;
  request_id: string; actor_id: string; created_at: string; plan: NativeSoftwarePlanInput;
  task_id: string; check_ids: string[]; requirement_ids: string[];
  task_hash: string; check_hashes: Record<string, string>; requirement_hashes: Record<string, string>;
  historical_planning?: HistoricalPlanning;
}
export interface HistoricalPlanning {
  disposition: 'superseded-pre-contract-planning';
  administrative_records: { id: string; fingerprint: string }[];
  cornell_notes: { id: string; fingerprint: string }[];
}
export interface NativeSoftwarePlanOutput {
  process: 'software-tools'; workflow_id: string; task_id: string; check_ids: string[];
  requirement_ids: string[]; contract_hash: string; decision_id: string;
}
interface PlanJournal { schema_version: 1; plan_hash: string; historical_planning?: HistoricalPlanning; output?: NativeSoftwarePlanOutput }
type Stage = 'implementation' | 'verification' | 'review';
type ObservationState = 'completed' | 'completed-without-output' | 'failed' | 'cancelled' | 'running' | 'unknown';
export interface NativeSoftwareNextInput { observation?: { packet_id?: string | null; state: ObservationState; observation_id: string } | null }
interface StageState { packet_id: string; terminal?: ObservationState; report_id?: string }
interface ControllerJournal {
  schema_version: 1; contract_hash: string; stages: Partial<Record<Stage, StageState>>;
  observations: Record<string, { packet_id: string; state: ObservationState }>;
  ignored_observations?: Record<string, { packet_id: string | null; state: ObservationState; reason: string }>;
  cycle?: number;
  history?: { cycle: number; stages: Partial<Record<Stage, StageState>>; findings: string[]; at: string }[];
  repair_intent?: { attempt: number; feedback: string; findings: string[] };
  halted?: { status: 'repair_exhausted'; findings: string[] };
}
const directory = '.neomind/native/software-workflows';
const contractPath = (root: string, id: string) => safePath(root, `${directory}/${hash(id)}.contract.json`);
const contractHash = (value: NativeSoftwareContract) => hash(JSON.stringify(value));
function publicPath(root: string, value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '');
  if (normalized !== value || normalized !== posix.normalize(normalized) || normalized === '.' ||
      normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /[:*?\x00-\x1f]/.test(normalized) ||
      /^(?:\.git|\.neomind|\.taskforces|\.verythinker)(?:\/|$)/i.test(normalized))
    throw new Error('Software scope must use bounded canonical public project-relative paths.');
  safePath(root, normalized); return normalized;
}
function covered(path: string, scopes: string[]): boolean {
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  return scopes.some(scope => { const prefix = process.platform === 'win32' ? scope.toLowerCase() : scope;
    return key === prefix || key.startsWith(`${prefix}/`); });
}
function normalizePlan(root: string, value: unknown): NativeSoftwarePlanInput {
  const plan = nativeSoftwarePlanSchema.parse(value);
  for (const key of ['allowed_paths', 'verification_paths', 'outputs', 'documentation_paths'] as const)
    plan[key] = [...new Set(plan[key].map(path => publicPath(root, path)))];
  if (plan.allowed_paths.some(path => covered(path, plan.verification_paths)) ||
      plan.verification_paths.some(path => covered(path, plan.allowed_paths)))
    throw new Error('Implementation and independent verification paths must be disjoint.');
  for (const path of [...plan.outputs, ...plan.documentation_paths])
    if (!covered(path, plan.allowed_paths)) throw new Error('Outputs and documentation must stay in implementation scope.');
  for (const check of plan.checks) {
    check.baseline_paths = [...new Set(check.baseline_paths.map(path => publicPath(root, path)))];
    if (check.command.some(argument => /[\x00-\x1f]/.test(argument))) throw new Error('Check argv cannot contain control characters.');
    const scripts = check.command.slice(1).filter(argument => covered(argument.replaceAll('\\', '/'), plan.verification_paths));
    if (!scripts.length || !scripts.every(script => covered(publicPath(root, script), check.baseline_paths)))
      throw new Error('Each check must execute a declared independent verification script captured in its baseline_paths.');
    if (check.baseline_paths.some(path => !covered(path, [...plan.allowed_paths, ...plan.verification_paths])))
      throw new Error('Check baselines must stay within the explicit implementation and verification scope.');
  }
  if (plan.outputs.some(path => !plan.checks.some(check => covered(path, check.baseline_paths))))
    throw new Error('Actual checks must capture every delivered output in their baseline_paths.');
  return plan;
}
/** Only immutable semantics, never lifecycle status, current worker or submission fields. */
function taskHash(task: ProjectRecord): string {
  const data = task.meta.data;
  return hash(JSON.stringify({ type: task.meta.type, owner: task.meta.owner, links: task.meta.links,
    title: task.meta.title, body: task.body, workflow_id: data.workflow_id,
    acceptance_criteria: data.acceptance_criteria, allowed_paths: data.allowed_paths,
    implementation_paths: data.implementation_paths, verification_paths: data.verification_paths,
    outputs: data.outputs, documentation_paths: data.documentation_paths, documentation_required: data.documentation_required,
    routing_required: data.routing_required, native_software_plan_hash: data.native_software_plan_hash,
    dependencies: data.dependencies, requirements: data.requirements,
    required_tools: data.required_tools, protected_acceptance_paths: data.protected_acceptance_paths,
    recipe_instance_ids: data.recipe_instance_ids }));
}
function checkHash(check: ProjectRecord): string {
  return hash(JSON.stringify({ type: check.meta.type, owner: check.meta.owner, title: check.meta.title,
    body: check.body, links: check.meta.links, data: check.meta.data }));
}
function unsignedWorkflow(parent: ProjectRecord): boolean {
  return parent.meta.data.kind === 'manager-workflow' && parent.meta.data.routing_required !== true &&
    ['copilot-native', 'codex-native'].includes(String(parent.meta.data.execution_mode));
}
/** No SQLite or mutable flag can authorize scoped exceptions. Validate the authoritative saved contract each time. */
export function readNativeSoftwareContract(root: string, workflowId: string): NativeSoftwareContract | null {
  const parent = getRecord(root, workflowId), marker = parent.meta.data.native_software_contract;
  if (marker === undefined) return null;
  if (!unsignedWorkflow(parent)) throw new Error('Software contract cannot reclassify strict or legacy workflow history.');
  const value = JSON.parse(readFileSync(contractPath(root, workflowId), 'utf8')) as NativeSoftwareContract;
  if (!value || value.schema_version !== 1 || value.process !== 'software-tools' || value.workflow_id !== workflowId ||
      JSON.stringify(marker) !== JSON.stringify({ schema_version: 1, process: 'software-tools', contract_hash: contractHash(value) }) ||
      hash(JSON.stringify(normalizePlan(root, value.plan))) !== value.plan_hash ||
      !Array.isArray(value.check_ids) || !value.check_ids.length || !Array.isArray(value.requirement_ids) || !value.requirement_ids.length)
    throw new Error('Native software contract integrity changed; inspect the immutable plan before continuing.');
  const task = getRecord(root, value.task_id);
  if (task.meta.type !== 'task' || task.meta.data.workflow_id !== workflowId || task.meta.data.routing_required === true ||
      task.meta.data.native_software_plan_hash !== value.plan_hash || taskHash(task) !== value.task_hash)
    throw new Error('Native software task scope or semantic baseline changed after planning.');
  for (const id of value.check_ids) {
    const check = getRecord(root, id);
    if (check.meta.type !== 'check' || check.meta.data.workflow_id !== workflowId || check.meta.data.routing_required === true ||
        check.meta.data.native_software_plan_hash !== value.plan_hash || checkHash(check) !== value.check_hashes[id])
      throw new Error('Native software check command or semantic baseline changed after planning.');
  }
  for (const id of value.requirement_ids) {
    const requirement = getRecord(root, id);
    if (requirement.meta.type !== 'requirement' || requirement.meta.data.routing_required === true ||
        requirement.meta.data.intake_workflow_id !== workflowId || recordFingerprint(requirement) !== value.requirement_hashes[id])
      throw new Error('Native software requirement intent or acceptance baseline changed after planning.');
  }
  if (value.historical_planning) {
    const history = value.historical_planning;
    if (history.disposition !== 'superseded-pre-contract-planning' || !Array.isArray(history.administrative_records) || !Array.isArray(history.cornell_notes))
      throw new Error('Software historical planning scope is invalid.');
    for (const [category, entries] of Object.entries({ administrative_records: history.administrative_records, cornell_notes: history.cornell_notes }))
      for (const entry of entries) {
        const record = getRecord(root, entry.id);
        if (record.meta.data.workflow_id !== workflowId || recordFingerprint(record) !== entry.fingerprint ||
            (category === 'administrative_records' ? !['manager-discussion', 'review'].includes(String(record.meta.data.kind ?? record.meta.type)) : record.meta.data.format !== 'cornell-v1'))
          throw new Error('Pre-contract historical planning records changed or escape their captured scope.');
      }
  }
  return value;
}
export function nativeSoftwareTaskContract(root: string, task: ProjectRecord): NativeSoftwareContract | null {
  if (task.meta.type !== 'task' || task.meta.data.routing_required === true || typeof task.meta.data.workflow_id !== 'string') return null;
  const parent = getRecord(root, task.meta.data.workflow_id);
  if (!unsignedWorkflow(parent) || parent.meta.data.native_software_contract === undefined) return null;
  const value = readNativeSoftwareContract(root, parent.meta.id);
  return value?.task_id === task.meta.id ? value : null;
}
export function nativeSoftwareCheckContract(root: string, task: ProjectRecord, check: ProjectRecord): NativeSoftwareContract | null {
  const value = nativeSoftwareTaskContract(root, task);
  return value?.check_ids.includes(check.meta.id) ? value : null;
}
export interface NativeSoftwareApplicabilityInput {
  authorization_reference: string; rationale: string;
  criteria: { original_text: string; original_sha256: string; replacement_text: string;
    retained_obligations: ['behavioral-acceptance', 'independent-verification', 'negative-controls', 'independent-final-review'] }[];
}
export interface NativeSoftwareApplicability {
  schema_version: 1; policy: 'software-tools-administrative-applicability-v1'; workflow_id: string; contract_hash: string;
  declared_by: { kind: 'local-administration' | 'reported-local-manager'; actor_id?: string };
  input: NativeSoftwareApplicabilityInput; input_hash: string; created_at: string;
  boundary: string;
}
const applicabilityPath = (root: string, workflowId: string) => safePath(root, `${directory}/${hash(workflowId)}.applicability.v1.json`);
function applicabilityInput(value: NativeSoftwareApplicabilityInput): NativeSoftwareApplicabilityInput {
  return z.strictObject({ authorization_reference: text, rationale: text, criteria: z.array(z.strictObject({
    original_text: z.string().min(12).max(8000), original_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    replacement_text: text, retained_obligations: z.tuple([z.literal('behavioral-acceptance'), z.literal('independent-verification'), z.literal('negative-controls'), z.literal('independent-final-review')]),
  })).min(1).max(32) }).parse(value);
}
export function readNativeSoftwareApplicability(root: string, contract: NativeSoftwareContract): NativeSoftwareApplicability | null {
  const path = applicabilityPath(root, contract.workflow_id); if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as NativeSoftwareApplicability;
  if (value.schema_version !== 1 || value.policy !== 'software-tools-administrative-applicability-v1' || value.workflow_id !== contract.workflow_id ||
      value.contract_hash !== contractHash(contract) || !['local-administration', 'reported-local-manager'].includes(value.declared_by?.kind) ||
      hash(JSON.stringify(applicabilityInput(value.input))) !== value.input_hash || value.input.criteria.some(item =>
        !contract.plan.acceptance_criteria.includes(item.original_text) || hash(item.original_text) !== item.original_sha256))
    throw new Error('Software applicability disposition does not match the exact immutable contract criteria.');
  return value;
}
/** Trusted local maintenance only; no MCP surface or inferred human identity. Never edits the saved contract or requirements. */
export function applyNativeSoftwareApplicability(root: string,
  authority: ReportedAssignmentCredential | { workflow_id: string; authority: 'local-administration' },
  value: NativeSoftwareApplicabilityInput): NativeSoftwareApplicability {
  const local = 'authority' in authority;
  if (local && (authority.authority !== 'local-administration' || Object.keys(authority).some(key => !['workflow_id', 'authority'].includes(key))))
    throw new Error('Applicability maintenance requires explicit declared local administration.');
  const manager = local ? null : authorizeNativeManager(root, authority), workflowId = local ? authority.workflow_id : manager!.workflow_id;
  const input = applicabilityInput(value), inputHash = hash(JSON.stringify(input));
  return withOperationLock(root, `software-applicability-${hash(workflowId)}`, () => {
    const contract = readNativeSoftwareContract(root, workflowId);
    if (!contract || !unsignedWorkflow(getRecord(root, workflowId))) throw new Error('Applicability requires a saved unsigned software-tools contract.');
    const existing = readNativeSoftwareApplicability(root, contract);
    if (existing) {
      if (existing.input_hash !== inputHash) throw new Error('The applicability disposition is immutable; changed scope requires a new increment.');
      return existing;
    }
    const task = getRecord(root, contract.task_id);
    if (!['draft', 'ready'].includes(task.meta.status) || task.meta.data.invocation_id)
      throw new Error('Administrative applicability must be declared before a producer starts; accepted history cannot be reclassified.');
    const seen = new Set<string>();
    for (const criterion of input.criteria) {
      if (!contract.plan.acceptance_criteria.includes(criterion.original_text) || hash(criterion.original_text) !== criterion.original_sha256 || seen.has(criterion.original_sha256))
        throw new Error('Applicability needs each exact stored criterion and matching hash, without duplicate selections.');
      seen.add(criterion.original_sha256);
      if (criterion.original_text === criterion.replacement_text) throw new Error('Record a substantive effective replacement retaining behavioral acceptance and independent final checks.');
    }
    const policy: NativeSoftwareApplicability = { schema_version: 1, policy: 'software-tools-administrative-applicability-v1',
      workflow_id: workflowId, contract_hash: contractHash(contract), declared_by: manager ? { kind: 'reported-local-manager', actor_id: manager.id } : { kind: 'local-administration' },
      input, input_hash: inputHash, created_at: now(),
      boundary: 'Declared local policy authority under the referenced instruction; no human identity, native execution, old report completion or passing review is attested.' };
    atomicWrite(applicabilityPath(root, workflowId), JSON.stringify(policy) + '\n'); return policy;
  });
}
export function effectiveNativeSoftwareCriteria(root: string, contract: NativeSoftwareContract) {
  const disposition = readNativeSoftwareApplicability(root, contract);
  return { acceptance_criteria: contract.plan.acceptance_criteria.map(original => disposition?.input.criteria.find(item => item.original_text === original)?.replacement_text ?? original),
    disposition, policy_hash: disposition ? hash(JSON.stringify(disposition)) : null };
}
/** A planned check is managerial scope. Its actual executor and reviewer must remain separate claimed actors. */
export function assertSoftwareActor(root: string, task: ProjectRecord, id: string | undefined, role: 'check-executor' | 'reviewer'): void {
  const contract = nativeSoftwareTaskContract(root, task);
  if (!contract) return;
  if (!id || !/^local-report-[a-f0-9]{40}$/.test(id)) throw new Error('Software verification and review require their actual independent claimed assignment.');
  const actor = readReportedAssignment(root, id);
  if (actor.state !== 'claimed' || actor.role !== role || actor.workflow_id !== contract.workflow_id || actor.task_id !== task.meta.id ||
      actor.id === task.meta.data.invocation_id || actor.id === contract.actor_id)
    throw new Error('Software verification and review require independent task-bound executor and reviewer assignments.');
  if (role === 'reviewer' && loadRecords(root).some(record => record.meta.type === 'evidence' &&
      record.meta.data.task_id === task.meta.id && record.meta.data.execution_invocation_id === id))
    throw new Error('Independent review cannot use the verification executor identity.');
}
/** Historical notes remain readable, but only a new note containing every current passing check can close this process. */
export function currentNativeSoftwareNotes(root: string, contract: NativeSoftwareContract): ProjectRecord[] {
  const records = loadRecords(root), historical = new Set(contract.historical_planning?.cornell_notes.map(item => item.id) ?? []);
  const latest = contract.check_ids.map(id => records.filter(record => record.meta.type === 'evidence' && record.meta.data.task_id === contract.task_id &&
    record.meta.links.some(link => link.type === 'evidence-for' && link.target === id))
    .sort((a, b) => b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id))[0]);
  if (latest.some(record => !record || record.meta.data.result !== 'pass')) return [];
  const evidenceIds = latest.map(record => record!.meta.id);
  return records.filter(record => record.meta.data.workflow_id === contract.workflow_id && record.meta.data.format === 'cornell-v1' &&
    !historical.has(record.meta.id) && record.meta.links.some(link => [contract.task_id, ...contract.requirement_ids].includes(link.target)) &&
    evidenceIds.every(id => strings((record.meta.data.demonstration as { evidence_ids?: string[] } | undefined)?.evidence_ids).includes(id)));
}
/** Direct closure shares the controller's actual actor/result/terminal requirements; a task flag alone never closes it. */
export function nativeSoftwareClosureProblems(root: string, workflowId: string): string[] {
  const contract = readNativeSoftwareContract(root, workflowId); if (!contract) return [];
  const parent = getRecord(root, workflowId), managerId = parent.meta.data.reported_manager_invocation_id;
  const path = safePath(root, `${directory}/${hash(workflowId)}.controller.json`);
  if (!existsSync(path) || typeof managerId !== 'string') return ['Software closure needs its saved current delegate controller and actual Coordinator.'];
  const journal = JSON.parse(readFileSync(path, 'utf8')) as ControllerJournal;
  if (journal.schema_version !== 1 || journal.contract_hash !== contractHash(contract) || journal.repair_intent || journal.halted)
    return ['Software closure has an invalid, unfinished or exhausted repair controller.'];
  const problems: string[] = [];
  for (const [stage, role] of [['implementation', 'developer'], ['verification', 'check-executor'], ['review', 'reviewer']] as const) {
    const saved = journal.stages[stage];
    if (!saved || !['completed', 'completed-without-output', 'failed', 'cancelled'].includes(saved.terminal ?? '') || !saved.report_id) {
      problems.push(`Software ${stage} needs its actual terminal callback and own typed result.`); continue;
    }
    const packet = readReportedAssignment(root, saved.packet_id);
    const outputPath = safePath(root, `.neomind/native/assignment-runtime/${packet.id}.json`);
    const output = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8'))?.output : undefined;
    const report = getRecord(root, saved.report_id);
    if (packet.state !== 'claimed' || packet.workflow_id !== workflowId || packet.task_id !== contract.task_id || packet.role !== role ||
        output?.outcome !== 'completed' || output.assignment_id !== packet.assignment_id || output.report_id !== saved.report_id ||
        report.meta.owner !== role || report.meta.data.kind !== 'work-record' || report.meta.data.workflow_id !== workflowId || report.meta.data.invocation_id !== packet.id ||
        (output.report_fingerprint && output.report_fingerprint !== recordFingerprint(report)))
      problems.push(`Software ${stage} no longer matches its own actual scoped result.`);
    for (const artifact of output?.artifacts ?? [])
      if (hash(readFileSync(safePath(root, artifact.path))) !== artifact.sha256) problems.push(`Software ${stage} artifact changed after its result: ${artifact.path}`);
  }
  return problems;
}

export function planNativeSoftware(root: string, handle: ReportedAssignmentCredential, value: NativeSoftwarePlanInput): NativeSoftwarePlanOutput {
  const manager = authorizeNativeManager(root, handle), plan = normalizePlan(root, value), workflowId = manager.workflow_id;
  const intake = getRecord(root, workflowId);
  const originals = [...new Set([String(intake.meta.data.requirement_id), ...strings(intake.meta.data.requirement_ids)])];
  // Refinement is additive. Original stakeholder wording and previously recorded acceptance remain immutable history.
  plan.acceptance_criteria = [...new Set([...originals.flatMap(id => strings(getRecord(root, id).meta.data.acceptance_criteria)), ...plan.acceptance_criteria])];
  nativeSoftwarePlanSchema.parse(plan);
  const planHash = hash(JSON.stringify(plan));
  return withOperationLock(root, `software-plan-${hash(workflowId)}`, () => {
    let parent = getRecord(root, workflowId);
    const journalPath = safePath(root, `${directory}/${hash(workflowId)}.plan.json`);
    const journal: PlanJournal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : { schema_version: 1, plan_hash: planHash };
    if (journal.schema_version !== 1 || journal.plan_hash !== planHash)
      throw new Error('The software plan is immutable and already describes different work; start a new increment.');
    if (journal.output) { readNativeSoftwareContract(root, workflowId); return journal.output; }
    // A client can disconnect after the existing decision updates the parent but before the output journal is saved.
    if (parent.meta.data.phase === 'execution' && parent.meta.data.native_software_contract !== undefined) {
      const saved = readNativeSoftwareContract(root, workflowId)!;
      if (saved.plan_hash !== planHash || typeof parent.meta.data.decision_id !== 'string')
        throw new Error('Interrupted software plan does not match the current execution decision.');
      const output: NativeSoftwarePlanOutput = { process: 'software-tools', workflow_id: workflowId, task_id: saved.task_id,
        check_ids: saved.check_ids, requirement_ids: saved.requirement_ids, contract_hash: contractHash(saved), decision_id: parent.meta.data.decision_id };
      atomicWrite(journalPath, JSON.stringify({ ...journal, output }) + '\n'); return output;
    }
    if (!unsignedWorkflow(parent) || parent.meta.data.phase !== 'intake')
      throw new Error('A software-tools contract can be adopted only at unsigned native intake before execution.');
    if (parent.meta.data.native_software_contract !== undefined) {
      const saved = readNativeSoftwareContract(root, workflowId)!;
      if (saved.plan_hash !== planHash) throw new Error('The existing software contract is immutable.');
    }
    if (strings(parent.meta.data.open_questions).length) throw new Error('Resolve substantive user questions before defining the software contract.');
    if (loadRecords(root).some(record => record.meta.type === 'task' && record.meta.data.workflow_id === workflowId &&
      !['draft', 'ready', 'blocked', 'superseded'].includes(record.meta.status)))
      throw new Error('Existing active or delivered tasks cannot be reclassified as software-only history.');
    // The intent predates all record writes; retries locate server-created records by this immutable key.
    if (!journal.historical_planning) {
      const records = loadRecords(root).filter(record => record.meta.data.workflow_id === workflowId);
      const snapshots = (selected: ProjectRecord[]) => selected.map(record => ({ id: record.meta.id, fingerprint: recordFingerprint(record) }));
      journal.historical_planning = { disposition: 'superseded-pre-contract-planning',
        administrative_records: snapshots(records.filter(record => ['manager-discussion', 'review'].includes(String(record.meta.data.kind ?? record.meta.type)))),
        cornell_notes: snapshots(records.filter(record => record.meta.data.format === 'cornell-v1')) };
    }
    atomicWrite(journalPath, JSON.stringify(journal) + '\n');
    for (const id of originals) {
      const requirement = getRecord(root, id);
      if (requirement.meta.type !== 'requirement' || requirement.meta.data.intake_workflow_id !== workflowId || requirement.meta.data.routing_required === true)
        throw new Error('The software plan must preserve its actual unsigned intake requirements.');
    }
    function findOrCreate(key: string, input: Parameters<typeof createRecord>[1]): ProjectRecord {
      const matches = loadRecords(root).filter(record => record.meta.data.workflow_id === workflowId &&
        record.meta.data.native_software_plan_hash === planHash && record.meta.data.software_record_key === key);
      if (matches.length > 1) throw new Error('Ambiguous interrupted software plan records; inspect before continuing.');
      if (matches[0]) {
        const existing = matches[0];
        if (existing.meta.type !== input.type || existing.meta.owner !== input.owner || existing.meta.title !== input.title ||
            existing.body !== input.body || JSON.stringify(existing.meta.links) !== JSON.stringify(input.links) ||
            Object.entries(input.data ?? {}).some(([field, expected]) => JSON.stringify(existing.meta.data[field]) !== JSON.stringify(expected)))
          throw new Error('An interrupted software plan record changed from its saved requested semantics.');
      }
      return matches[0] ?? createRecord(root, { ...input, data: { ...input.data, workflow_id: workflowId,
        native_software_plan_hash: planHash, software_record_key: key, author_invocation_id: manager.id,
        identity_assurance: manager.assurance } });
    }
    const refined = findOrCreate('requirement', { type: 'requirement', title: `Software contract: ${plan.title}`, owner: 'manager',
      body: `# Derived software requirement\n${plan.objective}\n\n# Applicability\n${plan.rationale}\n\n# Acceptance criteria\n${plan.acceptance_criteria.map(item => `- ${item}`).join('\n')}\n`,
      links: originals.map(target => ({ type: 'derives-from', target })), data: { intake_workflow_id: workflowId,
        source: 'coordinator-software-refinement', acceptance_criteria: plan.acceptance_criteria } });
    const requirementIds = [...originals, refined.meta.id];
    const task = findOrCreate('task', { type: 'task', title: plan.title, owner: 'developer',
      body: `# Objective\n${plan.objective}\n\n# Software applicability\n${plan.rationale}\n\n# Independence\nImplementation and verification paths are separate. Actual verification and independent review remain required.\n`,
      links: [{ type: 'satisfies', target: refined.meta.id }], data: {
        acceptance_criteria: plan.acceptance_criteria, allowed_paths: [...plan.allowed_paths, ...plan.verification_paths],
        implementation_paths: plan.allowed_paths, verification_paths: plan.verification_paths,
        outputs: plan.outputs, documentation_paths: plan.documentation_paths, documentation_required: true,
        routing_required: false } });
    const checks = plan.checks.map((check, index) => findOrCreate(`check-${index}`, { type: 'check', title: check.title, owner: 'manager',
      body: `# Planned executable contract\n${check.title}\n\n# Authorship\nThe Coordinator planned this command and scope. The independent Verifier must author its actual script and collect execution evidence.\n`,
      links: [{ type: 'verifies', target: refined.meta.id }], data: { method: 'test', command: check.command,
        baseline_paths: check.baseline_paths, expected_exit_code: check.expected_exit_code ?? 0, timeout_ms: check.timeout_ms ?? 60000 } }));
    let contract: NativeSoftwareContract;
    if (existsSync(contractPath(root, workflowId))) {
      contract = JSON.parse(readFileSync(contractPath(root, workflowId), 'utf8'));
      if (contract.plan_hash !== planHash || contract.task_id !== task.meta.id || JSON.stringify(contract.check_ids) !== JSON.stringify(checks.map(check => check.meta.id)))
        throw new Error('An immutable software contract already exists with different records.');
    } else {
      contract = { schema_version: 1, process: 'software-tools', workflow_id: workflowId, plan_hash: planHash,
        request_id: plan.request_id ?? `software-${planHash.slice(0, 32)}`, actor_id: manager.id, created_at: now(), plan,
        task_id: task.meta.id, check_ids: checks.map(check => check.meta.id), requirement_ids: requirementIds,
        task_hash: taskHash(task), check_hashes: Object.fromEntries(checks.map(check => [check.meta.id, checkHash(check)])),
        requirement_hashes: Object.fromEntries(requirementIds.map(id => [id, recordFingerprint(getRecord(root, id))])),
        historical_planning: journal.historical_planning };
      atomicWrite(contractPath(root, workflowId), JSON.stringify(contract) + '\n');
    }
    const marker = { schema_version: 1, process: 'software-tools', contract_hash: contractHash(contract) };
    if (parent.meta.data.native_software_contract === undefined)
      parent = updateRecord(root, workflowId, { data: { native_software_contract: marker } });
    readNativeSoftwareContract(root, workflowId);
    const decided = decideWorkflow(root, workflowId, { summary: plan.objective, rationale: plan.rationale, task_ids: [task.meta.id] });
    const output: NativeSoftwarePlanOutput = { process: 'software-tools', workflow_id: workflowId, task_id: task.meta.id,
      check_ids: contract.check_ids, requirement_ids: requirementIds, contract_hash: marker.contract_hash, decision_id: String(decided.meta.data.decision_id) };
    atomicWrite(journalPath, JSON.stringify({ ...journal, output }) + '\n'); return output;
  });
}

function nextInput(value: NativeSoftwareNextInput): { observation?: { packet_id?: string; state: ObservationState; observation_id: string } } {
  return z.strictObject({ observation: z.preprocess(value => value === null ? undefined : value, z.strictObject({
    packet_id: z.preprocess(value => value === null || (typeof value === 'string' && !value.trim()) ? undefined : value,
      z.string().regex(/^local-report-[a-f0-9]{40}$/).optional()),
    state: z.enum(['completed', 'completed-without-output', 'failed', 'cancelled', 'running', 'unknown']),
    observation_id: z.string().trim().min(1).max(256) }).optional()) }).parse(value);
}
/** The host still launches delegates. Only actual terminal callbacks and independently saved results advance a stage. */
export function nextNativeSoftware(root: string, handle: ReportedAssignmentCredential, value: NativeSoftwareNextInput = {}): Record<string, any> {
  const claimed = resolveReportedAssignment(root, handle); let parent = getRecord(root, claimed.workflow_id);
  if (claimed.role !== 'manager' || claimed.profile_id !== 'coordinator' || parent.meta.data.reported_manager_invocation_id !== claimed.id)
    throw new Error('Only the current actual Coordinator can advance its software workflow.');
  const closed = /^completed/.test(String(parent.meta.data.phase));
  const manager = closed ? claimed : authorizeNativeManager(root, handle), input = nextInput(value), workflowId = manager.workflow_id;
  if (!closed && parent.meta.data.phase === 'intake' && parent.meta.data.native_software_contract !== undefined) {
    const saved = readNativeSoftwareContract(root, workflowId)!;
    planNativeSoftware(root, handle, saved.plan); parent = getRecord(root, workflowId);
  }
  return withOperationLock(root, `software-next-${hash(workflowId)}`, () => {
    if (closed) {
      try {
        const observed = workflowStatus(root, workflowId) as { phase: string; final_report_id: string | null; closure_blockers: string[];
          decision_findings: string[]; native_completion_findings: string[]; tasks: { accepted: { ok: boolean; findings: unknown[] } }[] };
        const complete = observed.phase === 'completed' && typeof observed.final_report_id === 'string';
        return { status: complete ? 'completed' : 'workflow_closed_with_blockers', workflow_id: workflowId,
          phase: observed.phase, persisted_phase: parent.meta.data.phase, final_report_id: observed.final_report_id,
          closure_blockers: observed.closure_blockers, decision_findings: observed.decision_findings,
          native_completion_findings: observed.native_completion_findings, task_findings: observed.tasks.flatMap(task => task.accepted.findings),
          next_action: complete ? 'This workflow already closed. Reuse its saved final report; new work requires a new increment.' :
            'This workflow remains closed with unresolved effective state. Inspect workflow_status and reconcile its actual publication or changed-baseline blocker through dedicated recovery; do not launch workers or report clean completion.' };
      } catch {
        return { status: 'workflow_closed_with_blockers', workflow_id: workflowId, phase: parent.meta.data.phase,
          persisted_phase: parent.meta.data.phase, final_report_id: parent.meta.data.final_report_id ?? null,
          closure_blockers: ['Saved closure could not be validated against its current records and evidence.'],
          next_action: 'Preserve closed history and inspect the concrete workflow integrity failure; no new worker was prepared and clean completion is unverified.' };
      }
    }
    const contract = readNativeSoftwareContract(root, workflowId);
    if (!contract) throw new Error('Plan the explicit software-tools process before requesting its next bounded action.');
    const journalPath = safePath(root, `${directory}/${hash(workflowId)}.controller.json`);
    const journal: ControllerJournal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) :
      { schema_version: 1, contract_hash: contractHash(contract), stages: {}, observations: {} };
    if (journal.schema_version !== 1 || journal.contract_hash !== contractHash(contract)) throw new Error('Software controller contract changed.');
    const save = () => atomicWrite(journalPath, JSON.stringify(journal) + '\n');
    let task = getRecord(root, contract.task_id);
    if (task.meta.status === 'superseded') return { status: 'task_superseded', workflow_id: workflowId,
      next_action: 'This immutable task was superseded. Inspect its successor increment; do not restart or reuse this controller.' };
    if (input.observation) {
      const observation = input.observation, existing = journal.observations[observation.observation_id];
      const ignored = journal.ignored_observations?.[observation.observation_id];
      const currentStage = (['implementation', 'verification', 'review'] as Stage[]).map(stage => journal.stages[stage]).find(stage => stage && !stage.report_id);
      const packetId = observation.packet_id ?? existing?.packet_id ?? (ignored ? ignored.packet_id ?? undefined : currentStage?.packet_id);
      if (packetId && readReportedAssignment(root, packetId).workflow_id !== workflowId)
        throw new Error('Native callback belongs to another workflow; only same-workflow observations can be considered.');
      if (existing && (existing.packet_id !== packetId || existing.state !== observation.state))
        throw new Error('Observation ID already describes a different actual delegate callback.');
      const state = Object.values(journal.stages).find(stage => stage?.packet_id === packetId);
      if (!state && !existing) {
        if (ignored && (ignored.packet_id !== (packetId ?? null) || ignored.state !== observation.state))
          throw new Error('Ignored callback ID already describes a different preflight observation.');
        journal.ignored_observations ??= {};
        journal.ignored_observations[observation.observation_id] = { packet_id: packetId ?? null, state: observation.state,
          reason: packetId ? 'same-workflow callback is not a managed software stage' : 'no managed software stage existed for this callback' };
      } else {
      if (state?.terminal && state.terminal !== observation.state)
        throw new Error('An actual terminal delegate callback cannot be rewritten as another state.');
      journal.observations[observation.observation_id] = { packet_id: packetId!, state: observation.state };
      observation.packet_id = packetId;
      if (state && !['running', 'unknown'].includes(observation.state)) state.terminal = observation.state;
      }
      save();
    }
    const effective = effectiveNativeSoftwareCriteria(root, contract);
    const stages = (): { stage: Stage; profile: 'implementer' | 'debugger' | 'verifier' | 'reviewer'; objective: string }[] => {
      const prefix = journal.cycle ? `Repair cycle ${journal.cycle}. Inspect actual task_context.repair_feedback and failing evidence; preserve previous records. ` : '';
      return [
        { stage: 'implementation', profile: journal.cycle ? 'debugger' : 'implementer', objective: `${prefix}Implement the authoritative saved objective and effective acceptance_criteria from assignment_open.context.task_context. FIRST use assignment_start with your opened handle and no copied task IDs. Edit only context.allowed_paths. Save actual findings through assignment_result. A completed producer result uses submit_task:true; a blocked or failed result leaves submit_task false or omitted. Do not author the independent verification script or a Cornell note.` },
        { stage: 'verification', profile: 'verifier', objective: `${prefix}Independently verify the delivered software against assignment_open.context.task_context.acceptance_criteria and its explicit applicability disposition. Author scripts only within context.allowed_paths, then use assignment_check with your opened handle and no copied IDs. Persist its actual evidence references through your own assignment_result. Do not modify implementation or write a Cornell note.` },
        { stage: 'review', profile: 'reviewer', objective: `${prefix}Independently inspect the submitted implementation, documentation, verification scripts and actual evidence. Use assignment_review with your opened handle, actual decision and findings (no copied task IDs), then persist your own assignment_result. Do not fabricate passing evidence, change implementation or write a Cornell note.` },
      ];
    };
    const latestChecks = () => contract.check_ids.map(id => loadRecords(root).filter(record => record.meta.type === 'evidence' &&
      record.meta.data.task_id === task.meta.id && record.meta.links.some(link => link.type === 'evidence-for' && link.target === id))
      .sort((a, b) => b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id))[0]);
    const delegateStage = (profile: 'implementer' | 'debugger' | 'verifier' | 'reviewer', objective: string) => {
      const selected = assignmentTaskOptions(root, workflowId).find(option => option.record.meta.id === contract.task_id);
      if (!selected) throw new Error('The saved software contract task is not currently available for delegation; inspect its actual lifecycle before resuming.');
      return delegateAssignment(root, handle, { profile_id: profile, scope: 'task', objective, task_selector: selected.selector });
    };
    const repair = (findings: string[]): Record<string, any> => {
      if (Object.values(journal.stages).some(stage => !stage?.terminal))
        return { status: 'wait_for_delegate', workflow_id: workflowId, task_id: task.meta.id, findings,
          next_action: 'Observe the actual current delegate terminal callback before any producer repair or replacement.' };
      const priorAttempt = journal.cycle ?? 0;
      if (!journal.repair_intent) {
        journal.repair_intent = { attempt: priorAttempt + 1,
          feedback: `Actual software verification or review failed:\n${findings.join('\n')}`.slice(0, 12000), findings };
        save();
      }
      const intent = journal.repair_intent;
      task = getRecord(root, task.meta.id);
      if (Number(task.meta.data.attempts ?? 0) === priorAttempt) task = requestRepair(root, task.meta.id, intent.feedback);
      if (Number(task.meta.data.attempts) !== intent.attempt || task.meta.data.feedback !== intent.feedback ||
          !['ready', 'blocked'].includes(task.meta.status))
        throw new Error('Interrupted software repair differs from the actual task repair lifecycle; preserve history and inspect it.');
      journal.history ??= [];
      journal.history.push({ cycle: priorAttempt, stages: structuredClone(journal.stages), findings: intent.findings, at: now() });
      journal.cycle = intent.attempt; journal.stages = {}; delete journal.repair_intent;
      if (task.meta.status === 'blocked') {
        journal.halted = { status: 'repair_exhausted', findings: intent.findings }; save();
        return { ...journal.halted, workflow_id: workflowId, task_id: task.meta.id, check_ids: contract.check_ids,
          next_action: 'The existing bounded repair budget is exhausted. Preserve the actual failing evidence and report the remaining engineering defect; do not reset attempts or assert completion.' };
      }
      save();
      const next = stages()[0]!;
      const prepared = delegateStage(next.profile, next.objective);
      if (prepared.packet_id) { journal.stages.implementation = { packet_id: prepared.packet_id }; save(); }
      return { ...prepared, stage: 'implementation', repair_attempt: journal.cycle, findings: intent.findings,
        next_action: 'Launch this fresh bounded Debugger with packet.handoff unchanged. It repairs the same scoped task; a fresh independent Verifier and Reviewer follow.' };
    };
    if (journal.halted) return { ...journal.halted, workflow_id: workflowId, task_id: task.meta.id,
      next_action: 'The actual defect exhausted the saved repair budget; preserve its history and report the remaining concrete failure.' };
    if (journal.repair_intent) return repair(journal.repair_intent.findings);
    if (Number(task.meta.data.attempts ?? 0) !== (journal.cycle ?? 0))
      throw new Error('Task repair attempts changed outside this saved software controller; inspect the actual repair before resuming.');
    for (const { stage, profile, objective } of stages()) {
      let state = journal.stages[stage];
      if (state?.report_id) {
        const current = inspectNativeAssignment(root, handle, state.packet_id);
        if (!state.terminal || current.status !== 'continue_workflow' || current.report_id !== state.report_id)
          throw new Error('Previously completed software stage no longer matches its actual terminal callback and saved typed report.');
        continue;
      }
      if (stage === 'verification' && !['submitted', 'accepted'].includes(task.meta.status))
        return { status: 'needs_submission', stage: 'implementation', workflow_id: workflowId, next_action: 'The actual Implementer must submit its bounded task; a completed prose report does not replace submission.' };
      if (stage === 'review') {
        const checked = verify(root, task.meta.id, 'verified');
        if (!checked.ok) {
          if (latestChecks().some(record => record?.meta.data.result === 'fail' &&
              record.meta.data.execution_invocation_id === journal.stages.verification?.packet_id))
            return repair(checked.findings.map(finding => finding.message));
          return { status: 'verification_failed', stage: 'verification', workflow_id: workflowId, task_id: task.meta.id,
            check_ids: contract.check_ids, findings: checked.findings,
            next_action: 'The Verifier result omitted valid required evidence. Inspect the current check contracts through assignment context and collect the missing actual checks; prose completion cannot replace execution.' };
        }
      }
      if (!state) {
        const prepared = delegateStage(profile, objective);
        if (!prepared.packet_id) return { ...prepared, stage };
        state = journal.stages[stage] = { packet_id: prepared.packet_id }; save();
        return { ...prepared, stage };
      }
      const inspected = inspectNativeAssignment(root, handle, state.packet_id);
      if (!state.terminal) {
        if (input.observation?.packet_id === state.packet_id && ['running', 'unknown'].includes(input.observation.state))
          return { status: 'wait_for_delegate', stage, packet_id: state.packet_id, next_action: 'Observe this actual delegate. Do not launch duplicates while its native state is running or unknown.' };
        if (inspected.packet_state === 'prepared') return { status: 'prepared', stage, workflow_id: workflowId,
          packet_id: state.packet_id, packet: recoverPreparedAssignment(root, { workflow_id: workflowId, packet_id: state.packet_id }),
          next_action: 'Launch this existing prepared specialist with packet.handoff unchanged; no duplicate packet was created.' };
        return { status: 'needs_observation', stage, packet_id: state.packet_id, next_action: 'Read the actual native delegate terminal callback and supply its packet_id, state and stable observation_id; a saved report alone does not attest that the delegate stopped.' };
      }
      const currentFailures = latestChecks().filter(record => record?.meta.data.result === 'fail' && record.meta.data.execution_invocation_id === state!.packet_id);
      if (stage === 'verification' && currentFailures.length) {
        if (inspected.report_id) state.report_id = inspected.report_id;
        return repair(currentFailures.map(record =>
          `${record!.meta.id}: actual check result fail, exit code ${String(record!.meta.data.exit_code)}; inspect ${String(record!.meta.data.log_path)}.`));
      }
      if (stage === 'review') {
        const review = loadRecords(root).filter(record => record.meta.type === 'review' && record.meta.data.invocation_id === state!.packet_id &&
          record.meta.links.some(link => link.type === 'reviews' && link.target === task.meta.id))
          .sort((a, b) => b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id))[0];
        if (review?.meta.data.decision === 'fail') {
          if (inspected.report_id) state.report_id = inspected.report_id;
          return repair(strings(review.meta.data.findings).length ? strings(review.meta.data.findings) : [`${review.meta.id}: independent reviewer reported failure.`]);
        }
      }
      const requiredGate = stage === 'verification' ? 'verified' as const : stage === 'review' ? 'accepted' as const : undefined;
      const requiredGateSatisfied = requiredGate === undefined || verify(root, task.meta.id, requiredGate).ok;
      if (inspected.status === 'continue_workflow' && inspected.report_id && requiredGateSatisfied) {
        state.report_id = inspected.report_id; save(); task = getRecord(root, contract.task_id); continue;
      }
      const recovery = followUpNativeAssignment(root, handle, { packet_id: state.packet_id,
        observation: state.terminal, observation_id: `software-${hash(`${state.packet_id}:${state.terminal}`).slice(0, 32)}` },
        requiredGate ? { required_gate: requiredGate } : undefined);
      if (recovery.status === 'followup_prepared' && recovery.followup) {
        journal.stages[stage] = { packet_id: recovery.followup.id }; save();
        return { ...recovery, stage, packet: recovery.followup, packet_id: recovery.followup.id,
          next_action: 'Launch only this bounded follow-up with packet.handoff unchanged; preserve and reuse its lineage saved work.' };
      }
      return { ...recovery, stage };
    }
    const accepted = verify(root, task.meta.id, 'accepted');
    if (!accepted.ok) return { status: 'acceptance_failed', workflow_id: workflowId, findings: accepted.findings,
      next_action: 'Resolve the actual current submission, evidence or independent review findings before closure.' };
    if (task.meta.status !== 'accepted') acceptTask(root, task.meta.id);
    const records = loadRecords(root), evidence = latestChecks().filter((record): record is ProjectRecord => Boolean(record));
    const notes = currentNativeSoftwareNotes(root, contract);
    const refinedRequirement = getRecord(root, contract.requirement_ids.at(-1)!);
    const retrievedAt = now();
    return { status: notes.length ? 'ready_for_closure' : 'ready_for_cornell', workflow_id: workflowId,
      task_id: task.meta.id, cornell: { workflow_id: workflowId, requirement_ids: contract.requirement_ids,
        task_ids: [task.meta.id], report_ids: Object.values(journal.stages).map(stage => stage!.report_id!).filter(Boolean),
        evidence_ids: evidence.map(record => record.meta.id), note_ids: notes.map(record => record.meta.id),
        prior_evidence_ids: records.filter(record => record.meta.type === 'evidence' && record.meta.data.task_id === task.meta.id &&
          !evidence.some(current => current.meta.id === record.meta.id)).map(record => record.meta.id),
        previous_cycles: journal.history ?? [],
        historical_planning: contract.historical_planning,
        worker_notes_required: false, compiler: 'cornell_research_compile', topic: contract.plan.title,
        schema_version: 1, requirement_id: refinedRequirement.meta.id, expected_requirement_revision: refinedRequirement.meta.revision,
        task_id: task.meta.id, date: retrievedAt.slice(0, 10),
        output_dir: `${readCornellDestination(root).directory}/${workflowId.toLowerCase()}`,
        context: contract.plan.objective, constraints: [contract.plan.rationale, 'Unsigned local assignments do not attest model or native process identity.'],
        acceptance_criteria: effective.acceptance_criteria, applicability_disposition: effective.disposition,
        sources: [...contract.requirement_ids, ...Object.values(journal.stages).map(stage => stage!.report_id!).filter(Boolean)].map((id, index) => ({
          id: `S${index + 1}`, record_id: id, title: getRecord(root, id).meta.title, uri: `neomind:record/${id}`, retrieved_at: retrievedAt })),
        worked_example: { command: contract.plan.checks[0]!.command,
          evidence_ids: evidence.map(record => record.meta.id), observed: evidence.map(record =>
            `${record.meta.id}: saved result ${String(record.meta.data.result)}, actual exit code ${String(record.meta.data.exit_code)}.`).join(' ') },
        required_authored_sections: ['Abstract and objectives', 'Readable research narrative with source references', 'Practice exercise and separate answers', 'Findings, limitations and summary'] },
      next_action: notes.length ? 'Validate the existing evidence-linked final Cornell note, then manager_finish the same workflow; human release/publication approval remains separate.' :
        'Author one readable final Cornell research note using these actual references and the existing compiler. Do not create a note for every internal worker. Then continue to workflow closure.' };
  });
}
