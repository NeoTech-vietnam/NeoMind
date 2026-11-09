/** A scoped role result is not whole-product acceptance. The host owns its
 * dispatch and saves an actual result; the model supplies professional content. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { nativeLocalContractVersion, nativeProfessionalReportInstructions, nativeRequestOpenSchema, nativeSkillNamesSchema, nativeMcpIdsSchema, nativePluginNamesSchema, nativeSpecialists, nativeWorkerProfiles } from './native-local-contract.js';
import { assertNativeSkillsCurrent, nativeSkillInputsMatch, nativeSkillPins, nativeSkillPrompt, nativeSkillDependencies, resolveNativeSkills, type NativeSkillContext } from './native-skill-context.js';
import { parseNativeProfessionalReport, type NativeMonitorOwnership, type NativeReportArtifact } from './native-request.js';
import { nativeContextFiles, normalizeNativeProjectPaths } from './native-project-paths.js';
import { NativeMonitorSnapshot } from './native-monitor-snapshot.js';
import type { ProjectRecord } from './types.js';
import { atomicWrite, createRecord, getRecord, hash, loadRecords, requestFolderForWorkflow, safePath, saveStatus, withOperationLock } from './storage.js';
import { assertWorkspaceEditablePath, replaceWorkspaceFile, workspaceContentBytes, workspaceFileBytes, workspacePathLockKey } from './workspace.js';
import { bindNativeSkillLease } from './native-skill-context.js';
import { assertNativeDispatchCapabilities, type NativeDispatchCapabilities } from './native-dispatch-capabilities.js';

export const nativeRoleContentSchema = nativeRequestOpenSchema.extend({
  outputs: z.array(z.string().trim().min(1).max(1024)).max(100).default([]),
  skills: nativeSkillNamesSchema.describe('Optional exact currently installed workspace skill names. The host pins the receipt and files; omission uses ordinary project tools.').optional(),
  plugins: nativePluginNamesSchema.describe('Optional exact owned native package names. Source/registration are pinned by the host; MCP grants remain separate and no package agent/model policy replaces this role.').optional(),
  mcp: nativeMcpIdsSchema.describe('Optional User-approved connector IDs. The host binds exact currently observed tools; unavailable optional tools use ordinary work.').optional() });
export const nativeRoleContentJsonSchema = z.toJSONSchema(nativeRoleContentSchema, { io: 'input', target: 'draft-7' });
export const nativeRoleJobSchema = nativeRoleContentSchema.extend({ role: z.enum(nativeSpecialists) });
export const nativeRoleJobJsonSchema = z.toJSONSchema(nativeRoleJobSchema, { io: 'input', target: 'draft-7' });
type Role = (typeof nativeSpecialists)[number];
interface State {
  request_ref: string; request_key: string; title: string; requirement: string; role: Role;
  assignment_ref: string; description: string; prompt: string; context: string[]; outputs: string[];
  baseline: Record<string, string | null>; status: 'queued' | 'submitted' | 'findings' | 'uncertain' | 'cancelled';
  context_membership?: string[];
  skill_contexts?: NativeSkillContext[];
  mcp?: string[];
  plugins?: string[];
  dispatch_capabilities?: NativeDispatchCapabilities;
  native_profile?: string;
  capability_fallback?: 'ordinary-work';
  report_output_baseline?: Record<string, string | null>;
  report_write?: { result_hash: string; intent_sha256: string; outcome_sha256?: string; completed: boolean };
  report_artifact_issue?: string;
  updated_at: string; report_sha256?: string; invocation?: { host_call_id: string; agentName: Role; transport: 'vscode-native'; tool: 'runSubagent';
    invoked: true; status: string; native_context_id?: string | null; native_agent_name?: string }; result_hash?: string; report_path?: string;
  report?: { summary: string; verdict: 'pass' | 'findings'; findings: string[] }; output_hashes?: Record<string, string | null>;
}
function fileHashes(root: string, paths: string[], snapshot?: NativeMonitorSnapshot) {
  if (snapshot) return snapshot.fingerprints(paths);
  return Object.fromEntries(paths.map(path => {
    const full = safePath(root, path);
    if (!existsSync(full)) return [path, null];
    const info = lstatSync(full);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 20 * 1024 * 1024) throw new Error('Role products must be bounded ordinary files.');
    return [path, hash(readFileSync(full))];
  }));
}
function pathFor(root: string, ref: string, knownRequest?: ProjectRecord) {
  const request = knownRequest ?? getRecord(root, ref), folder = requestFolderForWorkflow(root, ref);
  if (request.meta.id !== ref || request.meta.data.delivery_scope !== 'role-only' || request.meta.data.process_contract !== nativeLocalContractVersion || !folder)
    throw new Error('Select a backend-owned native role job.');
  return safePath(root, `.workforce/${folder.directory}/native/role-job.json`);
}
function load(root: string, ref: string, knownRequest?: ProjectRecord): State {
  const path = pathFor(root, ref, knownRequest), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('Role state requires an ordinary bounded file.');
  const state = JSON.parse(readFileSync(path, 'utf8')) as State;
  if (state.request_ref !== ref || !nativeSpecialists.includes(state.role) || !Array.isArray(state.outputs)) throw new Error('Role job state needs reconciliation.');
  return state;
}
function save(root: string, state: State) { state.updated_at = new Date().toISOString(); atomicWrite(pathFor(root, state.request_ref), JSON.stringify(state, null, 2) + '\n'); }
const reportOutputs = (state: State) => state.role !== 'WF.FnD' && state.outputs.length > 0;
const contextExclusions = (state: State) => state.role === 'WF.FnD' || state.report_output_baseline ? state.outputs : [];
function contextCurrent(root: string, state: State, snapshot?: NativeMonitorSnapshot, ownedTemporary: string[] = []) {
  return nativeSkillInputsMatch(root, state.skill_contexts ?? [], fileHashes(root, Object.keys(state.baseline), snapshot), state.baseline,
    nativeSkillDependencies(root, state.skill_contexts ?? [], state.context)) &&
    (!state.context_membership || JSON.stringify(nativeContextFiles(root, state.context, false, [...contextExclusions(state), ...ownedTemporary])) === JSON.stringify(state.context_membership));
}
function view(root: string, state: State, snapshot?: NativeMonitorSnapshot) {
  const current = fileHashes(root, state.outputs, snapshot);
  const reportCurrent = !state.report_path || !!state.report_sha256 && fileHashes(root, [state.report_path], snapshot)[state.report_path] === state.report_sha256;
  let publicationCurrent = true;
  if (reportOutputs(state) && state.report_write?.completed) {
    try {
      const folder = requestFolderForWorkflow(root, state.request_ref)!;
      const intent = `.workforce/${folder.directory}/native/report-output-intent.json`, outcome = `.workforce/${folder.directory}/native/report-output-complete.json`;
      const hashes = fileHashes(root, [intent, outcome], snapshot);
      publicationCurrent = hashes[intent] === state.report_write.intent_sha256 && hashes[outcome] === state.report_write.outcome_sha256;
    } catch { publicationCurrent = false; }
  }
  const unchanged = reportCurrent && publicationCurrent && contextCurrent(root, state, snapshot) && (!state.output_hashes || JSON.stringify(current) === JSON.stringify(state.output_hashes));
  const productsComplete = Object.values(current).every(value => value !== null) && (!reportOutputs(state) || state.report_write?.completed === true);
  return { ...structuredClone(state), status: unchanged ? state.status : 'uncertain' as const, accepted: false,
    delivery_scope: 'role-only' as const, transport: 'vscode-native' as const,
    artifacts: Object.entries(current).map(([path, sha256]) => ({ path, exists: sha256 !== null })),
    completion: (state.status === 'submitted' || state.status === 'findings' && state.role !== 'WF.FnD') && unchanged && productsComplete ? 'role-completed' : 'incomplete' };
}

class ReportPublicationError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) { super(message); }
}
function privateBytes(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('Report operation history is not an ordinary bounded file.');
  return readFileSync(path);
}
function retainOnce(path: string, bytes: string | Buffer) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  if (existsSync(path)) {
    if (!privateBytes(path).equals(value)) throw new Error('The retained report operation has different immutable contents.');
  } else atomicWrite(path, value);
}
/** The model supplies professional file bodies, never ownership or CAS hashes.
 * Intent and native-result identity are durable before any product replacement. */
function publishReportOutputs(root: string, state: State, artifacts: NativeReportArtifact[] | undefined, resultHash: string,
  invocation: NonNullable<State['invocation']>, text: string) {
  if (!artifacts || artifacts.length !== state.outputs.length)
    throw new ReportPublicationError('REPORT_OUTPUT_REQUIRED', 'Provide separate content for every requested report file; missing report artifacts have not been completed.');
  const fold = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const allowed = new Map(state.outputs.map(path => [fold(path), path])), payload = new Map<string, string>();
  for (const artifact of artifacts) {
    let selected: string | undefined;
    try { selected = allowed.get(fold(normalizeNativeProjectPaths(root, [artifact.path])[0]!)); }
    catch { /* Scope failure is reported without echoing arbitrary supplied paths. */ }
    if (!selected || payload.has(selected)) throw new ReportPublicationError('REPORT_OUTPUT_SCOPE', 'Report content must map each saved report destination exactly once; no unlisted files were published.');
    try { assertWorkspaceEditablePath(selected); workspaceContentBytes(artifact.content); }
    catch { throw new ReportPublicationError('REPORT_OUTPUT_CONTENT', 'Report outputs must be bounded ordinary UTF-8 product documents, outside host configuration and credentials.'); }
    payload.set(selected, artifact.content);
  }
  if (!state.report_output_baseline) throw new ReportPublicationError('REPORT_OUTPUT_BASELINE', 'This retained job has no report-output write baseline; existing files were preserved.', true);
  const files = state.outputs.map(path => {
    const before_sha256 = state.report_output_baseline![path];
    if (before_sha256 === undefined) throw new ReportPublicationError('REPORT_OUTPUT_BASELINE', 'A saved report-output baseline is missing; existing files were preserved.', true);
    return { path, before_sha256, sha256: hash(workspaceContentBytes(payload.get(path)!)), content: payload.get(path)! };
  });
  const directory = dirname(pathFor(root, state.request_ref)), intentPath = join(directory, 'report-output-intent.json');
  const outcomePath = join(directory, 'report-output-complete.json');
  const bytes = JSON.stringify({ schema_version: 1, request_ref: state.request_ref, assignment_ref: state.assignment_ref,
    result_hash: resultHash, invocation, raw_report: text, files }, null, 2) + '\n';
  const intentHash = hash(bytes), retained = existsSync(intentPath);
  if (retained && !privateBytes(intentPath).equals(Buffer.from(bytes))) throw new Error('A different native result owns the retained report write operation.');
  if (state.report_write && (state.report_write.result_hash !== resultHash || state.report_write.intent_sha256 !== intentHash))
    throw new Error('Saved report-write ownership differs from its native outcome.');
  const current = (path: string) => { const value = workspaceFileBytes(root, path); return value === null ? null : hash(value); };
  const assertTargets = () => {
    if (!contextCurrent(root, state)) throw new ReportPublicationError('REPORT_CONTEXT_CHANGED', 'Inspected non-output context changed; current edits and unfinished report products were preserved.', true);
    for (const file of files) {
      const actual = current(file.path);
      if (actual !== file.before_sha256 && (!retained || actual !== file.sha256))
        throw new ReportPublicationError('REPORT_OUTPUT_CHANGED', 'A requested report destination changed after its saved baseline; current user edits were preserved.', true);
    }
  };
  assertTargets();
  if (!retained) {
    for (const file of files) if (file.before_sha256 !== null) {
      const previous = workspaceFileBytes(root, file.path);
      if (!previous || hash(previous) !== file.before_sha256) throw new ReportPublicationError('REPORT_OUTPUT_CHANGED', 'A requested report destination changed before publication; user edits were preserved.', true);
      retainOnce(join(directory, 'report-output-previous', `${hash(file.path)}.utf8`), previous);
    }
    retainOnce(intentPath, bytes);
  }
  for (const file of files) if (file.before_sha256 !== null &&
      hash(privateBytes(join(directory, 'report-output-previous', `${hash(file.path)}.utf8`))) !== file.before_sha256)
    throw new Error('Retained original report bytes do not match the write intent.');
  if (!state.report_write) { state.report_write = { result_hash: resultHash, intent_sha256: intentHash, completed: false }; save(root, state); }
  for (const file of files) withOperationLock(root, workspacePathLockKey(file.path), () => {
    const actual = current(file.path);
    // Only this exact durable intent can reconcile already-published bytes.
    if (actual === file.sha256) return;
    if (actual !== file.before_sha256) throw new ReportPublicationError('REPORT_OUTPUT_CHANGED', 'A requested report destination changed during publication; user edits were preserved.', true);
    try {
      replaceWorkspaceFile(root, { path: file.path, content: file.content, expected_hash: file.before_sha256,
        authorize: (temporaryPath?: string) => {
          const owned = temporaryPath ? normalizeNativeProjectPaths(root, [temporaryPath]) : [];
          if (!contextCurrent(root, state, undefined, owned)) throw new ReportPublicationError('REPORT_CONTEXT_CHANGED', 'Inspected context changed during report publication.', true);
          if (!state.outputs.includes(file.path)) throw new Error('Report scope changed before commit.');
        } });
    } catch (failure) {
      if (!contextCurrent(root, state)) throw new ReportPublicationError('REPORT_CONTEXT_CHANGED', 'Inspected context changed during publication; its edits were preserved.', true);
      if (failure instanceof Error && /File changed since it was read|File changed after atomic replacement/.test(failure.message))
        throw new ReportPublicationError('REPORT_OUTPUT_CHANGED', 'A requested report destination changed during publication; current user edits were preserved.', true);
      throw failure;
    }
  });
  if (!contextCurrent(root, state) || files.some(file => current(file.path) !== file.sha256))
    throw new ReportPublicationError('REPORT_OUTPUT_CHANGED', 'Report products or inspected context changed before completion; current edits were preserved.', true);
  const completedBytes = JSON.stringify({ schema_version: 1, result_hash: resultHash, intent_sha256: intentHash,
    output_hashes: Object.fromEntries(files.map(file => [file.path, file.sha256])) }, null, 2) + '\n';
  retainOnce(outcomePath, completedBytes);
  state.report_write.outcome_sha256 = hash(completedBytes);
  state.report_write.completed = true;
}

export function openNativeRoleJob(root: string, input: z.input<typeof nativeRoleJobSchema>) {
  const parsed = nativeRoleJobSchema.parse(input);
  const skillContexts = resolveNativeSkills(root, parsed.skills ?? []);
  const context = normalizeNativeProjectPaths(root, parsed.context, true), outputs = normalizeNativeProjectPaths(root, parsed.outputs);
  if (outputs.some(path => /^(?:\.git|\.workforce|\.neomind|\.verythinker|\.taskforces)(?:\/|$)/i.test(path)))
    throw new Error('Role outputs must stay outside managed execution metadata.');
  if (parsed.role !== 'WF.FnD') outputs.forEach(path => assertWorkspaceEditablePath(path));
  const protectedPaths = nativeContextFiles(root, context, false, outputs);
  const baseline = { ...fileHashes(root, [...protectedPaths, ...nativeSkillDependencies(root, skillContexts, context)]), ...nativeSkillPins(skillContexts) };
  const report_output_baseline = parsed.role !== 'WF.FnD' && outputs.length ? Object.fromEntries(outputs.map(path => {
    const value = workspaceFileBytes(root, path); return [path, value === null ? null : hash(value)];
  })) : undefined;
  const title = parsed.title ?? `${parsed.role}: ${parsed.requirement.slice(0, 100)}`;
  const created = createRecord(root, { type: 'knowledge', title, body: `# ${title}\n\n${parsed.requirement}\n`,
    data: { kind: 'workforce-request', process_contract: nativeLocalContractVersion, delivery_scope: 'role-only',
      transport: 'vscode-native', assurance: 'observed-native-local', routing_required: false, request_id: randomUUID() } });
  const folder = requestFolderForWorkflow(root, created.meta.id)!;
  const state: State = { request_ref: created.meta.id, request_key: folder.display_id, title, requirement: parsed.requirement,
    role: parsed.role, assignment_ref: randomUUID(), context, outputs, baseline, ...(report_output_baseline ? { report_output_baseline } : {}),
    ...(skillContexts.length ? { skill_contexts: skillContexts } : {}), ...(parsed.mcp ? { mcp: parsed.mcp } : {}), ...(parsed.plugins ? { plugins: parsed.plugins } : {}),
    context_membership: nativeContextFiles(root, context, false, outputs), status: 'queued', updated_at: '',
    description: `${parsed.role}: ${title}`.slice(0, 200),
    prompt: `Complete only the assigned ${parsed.role} scope. This is a direct role job; your report does not approve a whole software workflow. ${['WF.SWSD', 'WF.P-RES', 'WF.Reviewer', 'WF.Tester'].includes(parsed.role) ? 'Inspect and report; keep project files unchanged. The backend publishes requested report documents from your explicit returned content.' : 'Implement only the listed products and preserve unrelated files.'}\n\nRequirement:\n${parsed.requirement}\n\nContext:\n${context.join('\n') || '(none)'}\n\nProduct destinations:\n${outputs.join('\n') || '(professional report only)'}${nativeSkillPrompt(skillContexts)}\n\n${nativeProfessionalReportInstructions()}${report_output_baseline ? '\nAdd report_artifacts: an array of {"path": "one exact requested destination", "content": "the full distinct UTF-8 report document"}, exactly once for each listed destination. Supply the actual requested documents, not placeholder text or copies of one summary. The host handles scoped publication, baselines and history; do not call file editing or lifecycle tools.' : ''}` };
  save(root, state);
  return view(root, state);
}

export function getNativeRoleJob(root: string, ref: string) { return view(root, load(root, ref)); }
/** Private host admission; role/model inputs cannot set dispatch identity. */
export function bindNativeRoleCapabilities(root: string, ref: string, binding: NativeDispatchCapabilities) {
  assertNativeDispatchCapabilities(root, binding, ref);
  return withOperationLock(root, `native-role-${hash(ref)}`, () => {
    const state = load(root, ref);
    if (binding.owner.assignment_ref !== state.assignment_ref || binding.owner.generation !== 0 || state.invocation || state.result_hash)
      throw new Error('Bind capabilities to the issued role job before its actual native call.');
    if (state.dispatch_capabilities && JSON.stringify(state.dispatch_capabilities) !== JSON.stringify(binding)) throw new Error('Frozen capability binding cannot be replaced.');
    state.dispatch_capabilities = structuredClone(binding);
    state.skill_contexts = bindNativeSkillLease(state.skill_contexts ?? [], binding.lease, binding.owner);
    save(root, state); return view(root, state);
  });
}
export function bindNativeRoleDispatchProfile(root: string, ref: string, assignmentRef: string, useCapabilities: boolean) {
  return withOperationLock(root, `native-role-${hash(ref)}`, () => {
    const state = load(root, ref);
    if (state.assignment_ref !== assignmentRef || state.invocation || state.result_hash) throw new Error('Only the current unstarted role can bind its actual native profile.');
    state.native_profile = useCapabilities ? state.dispatch_capabilities?.roles[state.role]?.profile?.name ?? nativeWorkerProfiles[state.role] : nativeWorkerProfiles[state.role];
    if (!useCapabilities && state.dispatch_capabilities?.roles[state.role]?.profile) state.capability_fallback = 'ordinary-work';
    else delete state.capability_fallback;
    save(root, state); return view(root, state);
  });
}
/** Host-only check immediately before the actual queued native dispatch. */
export function assertNativeRoleSkillsCurrent(root: string, ref: string): void {
  assertNativeSkillsCurrent(root, load(root, ref).skill_contexts ?? []);
}

export function recordNativeRoleResult(root: string, input: { request_ref: string; assignment_ref: string;
  invocation?: State['invocation']; raw_result?: unknown; error?: { code: string; category: string } }) {
  return withOperationLock(root, `native-role-${hash(input.request_ref)}`, () => {
    const state = load(root, input.request_ref), invocation = input.invocation;
    if (input.assignment_ref !== state.assignment_ref) throw new Error('This actual role callback belongs to another job.');
    if (invocation && (invocation.agentName !== state.role ||
        invocation.native_agent_name !== undefined && invocation.native_agent_name !==
          (state.native_profile ?? state.dispatch_capabilities?.roles[state.role]?.profile?.name ?? nativeWorkerProfiles[state.role]) ||
        invocation.transport !== 'vscode-native' || invocation.tool !== 'runSubagent' ||
        invocation.invoked !== true || !/^[A-Za-z0-9_-]{8,160}$/.test(invocation.host_call_id) || !['returned', 'rejected', 'cancelled', 'uncertain'].includes(invocation.status)))
      throw new Error('An actual owned role invocation is required.');
    if (!invocation && !input.error) throw new Error('Save an actual role outcome or a bounded preflight error.');
    const error = input.error ? { code: input.error.code, category: input.error.category } : undefined;
    if (error && !Object.values(error).every(value => /^[A-Za-z0-9_-]{1,100}$/.test(value))) throw new Error('Use bounded adapter error labels.');
    const parsed = parseNativeProfessionalReport(input.raw_result, reportOutputs(state) ? { report_artifacts: true } : {});
    const digest = hash(JSON.stringify({ invocation, text: parsed.text, error }));
    if (state.result_hash) {
      if (state.result_hash === digest) return view(root, state);
      throw new Error('The retained role outcome cannot be overwritten.');
    }
    const retainedIntentPath = join(dirname(pathFor(root, state.request_ref)), 'report-output-intent.json');
    if (existsSync(retainedIntentPath)) {
      const intentBytes = privateBytes(retainedIntentPath), intent = JSON.parse(intentBytes.toString('utf8'));
      if (intent.request_ref !== state.request_ref || intent.assignment_ref !== state.assignment_ref || intent.result_hash !== digest ||
          state.report_write && (state.report_write.result_hash !== digest || state.report_write.intent_sha256 !== hash(intentBytes)))
        throw new Error('The retained role report operation cannot be overwritten by a different outcome.');
    }
    let stable = contextCurrent(root, state), professional = parsed.report;
    let publicationIssue: ReportPublicationError | undefined;
    if (reportOutputs(state) && invocation?.status === 'returned' && professional && !stable && !error) {
      publicationIssue = new ReportPublicationError('REPORT_CONTEXT_CHANGED', 'Inspected non-output context changed; requested reports were not published over current user edits.', true);
      state.report_artifact_issue = publicationIssue.code;
      professional = { ...professional, verdict: 'findings', findings: [...professional.findings, publicationIssue.message] };
    }
    if (reportOutputs(state) && invocation?.status === 'returned' && professional && stable && !error) {
      try { publishReportOutputs(root, state, parsed.report_artifacts, digest, invocation, parsed.text); }
      catch (failure) {
        if (!(failure instanceof ReportPublicationError)) throw failure;
        publicationIssue = failure;
        professional = { ...professional, verdict: 'findings', findings: [...professional.findings, failure.message] };
        state.report_artifact_issue = failure.code;
      }
      stable = contextCurrent(root, state);
    }
    const products = fileHashes(root, state.outputs);
    state.status = invocation?.status === 'cancelled' || error?.category === 'cancellation' ? 'cancelled' :
      !invocation || invocation.status !== 'returned' || !professional || !stable || publicationIssue?.uncertain ? 'uncertain' :
      professional.verdict === 'pass' && professional.findings.length === 0 && Object.values(products).every(value => value !== null) && !publicationIssue ? 'submitted' : 'findings';
    const operation = `role-result-${state.assignment_ref}`;
    const retained = loadRecords(root).find(item => item.meta.data.workflow_id === state.request_ref && item.meta.data.native_operation === operation);
    if (retained && (retained.meta.data.result_hash !== digest || retained.body.trim() !== (parsed.text || '(No professional report returned.)').trim()))
      throw new Error('A different professional result was retained; its report is unchanged.');
    const report = retained ?? createRecord(root, { type: state.role === 'WF.Reviewer' ? 'review' : 'knowledge',
      title: `${state.role}: ${state.title}`, body: parsed.text || '(No professional report returned.)',
      data: { workflow_id: state.request_ref, process_contract: nativeLocalContractVersion, delivery_scope: 'role-only',
        native_operation: operation, result_hash: digest, native_invocation: invocation ?? null,
        adapter_error: error ?? null, report_artifact_issue: publicationIssue?.code ?? null, assurance: 'observed-native-local' } });
    state.report_path = report.path; state.report = professional; state.result_hash = digest;
    state.invocation = invocation; state.output_hashes = products;
    if ((state.status === 'submitted' || state.status === 'findings' && state.role !== 'WF.FnD') &&
        Object.values(products).every(value => value !== null) && (!reportOutputs(state) || state.report_write?.completed) &&
        report.meta.status !== 'submitted') saveStatus(root, report.meta.id, 'submitted');
    state.report_sha256 = fileHashes(root, [report.path])[report.path]!;
    save(root, state);
    return view(root, state);
  });
}

export function nativeRoleListForMonitor(root: string, ownership: NativeMonitorOwnership = {}, snapshot = new NativeMonitorSnapshot(root)) {
  if (!existsSync(safePath(root, '.neomind/config.json'))) return [];
  snapshot.assertRoot(root);
  return snapshot.records().filter(item => item.meta.data.kind === 'workforce-request' && item.meta.data.delivery_scope === 'role-only' &&
    item.meta.data.process_contract === nativeLocalContractVersion).map(item => {
    const state = view(root, load(root, item.meta.id, item), snapshot);
    const calls = (ownership.calls ?? []).filter(call => call.request_ref === state.request_ref && call.assignment_ref === state.assignment_ref && call.agentName === state.role && !state.result_hash);
    const queued = (ownership.queued_calls ?? []).some(call => call.request_ref === state.request_ref && call.assignment_ref === state.assignment_ref && call.agentName === state.role && !state.result_hash);
    const ids: Record<Role, string[]> = { 'WF.SWSD': ['requirements', 'analysis'], 'WF.P-RES': ['architecture', 'module-design'],
      'WF.FnD': ['coding'], 'WF.Reviewer': [], 'WF.Tester': [] };
    const stage = calls.length ? 'running' : queued ? 'queued' : state.status === 'cancelled' ? 'interrupted' :
      state.completion === 'role-completed' ? 'completed' : state.status === 'findings' ? 'failed' : 'uncertain';
    return { workflow_id: state.request_ref, request_key: state.request_key, title: state.title, source: 'native-local', transport: 'vscode-native',
      live: calls.length > 0 || queued, status: calls.length ? 'working' : queued ? 'queued' : state.status === 'cancelled' ? 'cancelled' : state.completion,
      updated_at: state.updated_at, accepted: false,
      current_action: calls.length ? `${state.role} running in native Local chat. Whole-product acceptance is outside this job.` :
        queued ? `${state.role} queued for an available native worker slot.` : state.status === 'cancelled'
          ? `${state.role} cancelled · ${state.completion}. Its actual report and existing artifacts are retained; whole-product acceptance is outside this job.`
          : `${state.role} only · ${state.completion}. Whole-product acceptance is outside this job.`,
      stages: ['requirements', 'analysis', 'architecture', 'module-design', 'coding', 'unit', 'integration', 'system', 'acceptance'].map(id =>
        ({ id, role: ['requirements', 'analysis'].includes(id) ? 'WF.SWSD' : ['architecture', 'module-design'].includes(id) ? 'WF.P-RES' : id === 'coding' ? 'WF.FnD' : 'WF.Tester',
          state: ids[state.role].includes(id) ? stage : 'not-applicable', rationale: `Direct ${state.role} scope; no other workflow stage is implied.` })),
      review: { state: state.role === 'WF.Reviewer' ? stage : 'not-applicable' },
      active_agents: calls.map(call => ({ role: state.role, requested_model: call.requested_model, observed_model: 'unknown', observed_provider: 'unknown' })),
      artifacts: state.artifacts, evidence: state.report_path ? [{ path: state.report_path, label: `${state.role} professional report` }] : [] };
  });
}
