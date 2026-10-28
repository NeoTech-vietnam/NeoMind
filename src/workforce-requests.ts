import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { controlledStatus, startControlledWorkflow, controlControlledWorkflow, answerControlledWorkflow, validateControlledStartInput, type ControlledSnapshot, type ControlledStartInput, type ControlledContract } from './controlled-workflow.js';
import { controlledPublicReferencePath } from './controlled-tools.js';
import { safePath, hash, getRecord, readConfig, requestFolderForWorkflow } from './storage.js';
import { createRuntimeInfo } from './runtime-info.js';
import { openCodeBinary, openCodeBootstrap, openCodeStorage, opencodeRuntimeVersion, configuredOpenCodeEndpoint } from './opencode-engine.js';
import { readRoutingPolicy } from './routing.js';
import { readHost } from './vscode-wire.js';
import { workForceConnectionProof } from './workforce-connection.js';
import { controlledFingerprints, verifyControlledTask } from './controlled-acceptance.js';
import { prepareWorkForceIntake, recordWorkForceAdmission } from './workforce-intake.js';
import { observeWorkForceClient, workForceClientStatus } from './workforce-clients.js';

const roleNames: Record<string, string> = { manager: 'WF.PM', requirements: 'WF.SWSD', architect: 'WF.P-RES',
  'component-owner': 'WF.P-RES', developer: 'WF.FnD', reviewer: 'WF.Reviewer', verifier: 'WF.Tester', 'check-executor': 'WF.Tester' };
function requestRun(root: string, id: string): ControlledSnapshot {
  const runs = controlledStatus(root) as ControlledSnapshot[];
  const candidates = runs.filter(run => run.workflow_id === id || run.request_id === id || requestFolderForWorkflow(root, run.workflow_id)?.display_id === id);
  if (candidates.length !== 1) throw new Error('Select one existing WorkForce request.');
  return candidates[0]!;
}
function contractFor(root: string, run: ControlledSnapshot): ControlledContract | undefined {
  if (!run.contract_hash) return;
  const path = safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`);
  const bytes = readFileSync(path);
  if (hash(bytes) !== run.contract_hash) throw new Error('Saved request contract integrity changed.');
  return JSON.parse(bytes.toString('utf8'));
}
export interface WorkForceRequestView {
  schema_version: 1; workflow_id: string; epoch_id: string; request_id: string; requirement: string; title: string;
  status: ControlledSnapshot['status'] | 'changed'; historical_status: ControlledSnapshot['status']; phase: ControlledSnapshot['phase']; revision: number; updated_at: string;
  process_contract: ControlledSnapshot['process_contract']; transport: ControlledSnapshot['transport'];
  request_key: string; folder?: string; stage: string; current_action: string;
  active_agents: { id: string; role: string; state: string; name: string; requested_model: string; confirmed_model: string | null; provider: string | null }[];
  stages: { id: string; label: string; role: string | undefined; state: string; rationale?: string }[];
  artifacts: { path: string; label: string | undefined; state: string; bytes: number; sha256: string; exists: boolean }[];
  criteria: { id: string; text: string; state: string }[];
  findings: { message: string; owner?: string; code?: string }[];
  accepted: boolean; runtime_health: { state: string; message: string; owner: string };
  dependency_wait?: { code: 'storage' | 'provider' | 'prerequisite'; attempts: number; next_condition_check_at: string; last_check_at?: string };
  question?: { text: string; reason: string; missing: string; criterion: string; status: 'pending'; id: string };
}
export function requestProjection(root: string, run: ControlledSnapshot): WorkForceRequestView {
  const contract = contractFor(root, run), folder = requestFolderForWorkflow(root, run.workflow_id);
  const acceptedAtCompletion = run.status === 'completed' && !!contract && getRecord(root, contract.task_id).meta.status === 'accepted';
  const current = contract ? controlledFingerprints(root, contract.plan.outputs) : {};
  const final = run.final_report_id ? getRecord(root, run.final_report_id).meta.data.output_hashes : undefined;
  const delivered = final && typeof final === 'object' && !Array.isArray(final) ? final as Record<string, string> : {};
  const changed = acceptedAtCompletion && (JSON.stringify(Object.keys(current).sort()) !== JSON.stringify(Object.keys(delivered).sort()) ||
    Object.entries(current).some(([path, digest]) => digest !== delivered[path]));
  const verification = acceptedAtCompletion && !changed && contract ? verifyControlledTask(root, getRecord(root, contract.task_id)) : undefined;
  const accepted = !!verification?.ok;
  const actionLabels: Record<string, string> = { intake: 'Preparing the request', planning: 'WF.PM is planning the deliverable and its checks',
    requirements: 'WF.SWSD is checking requirements and expected outcomes', design: 'WF.P-RES is defining the applicable design',
    implementation: 'WF.FnD is building the requested product', review: 'WF.Reviewer is independently reviewing the current revision',
    verification: 'WF.Tester is independently verifying the product', diagnosis: 'WorkForce is diagnosing the observed findings',
    synthesis: 'WF.PM is preparing the requested final knowledge', completed: 'Final delivery is being checked' };
  const last = run.attempts.at(-1), actionStage = last && ['running', 'starting'].includes(last.state) ? last.stage : run.phase;
  const waiting = run.status === 'waiting' ? run.dependency_wait : undefined;
  const currentAction = accepted ? 'Verified product ready' : changed ? 'Product changed after the verified delivery'
    : waiting ? `Waiting for ${waiting.code === 'provider' ? 'the configured model provider' : waiting.code === 'prerequisite' ? 'the required local tool' : 'local storage'}; the runtime will check again at ${waiting.next_condition_check_at}`
    : run.status === 'needs_input' ? run.pending_question?.question ?? 'A product decision is needed'
    : run.status === 'paused' ? 'Paused with its saved checkpoint' : run.status === 'cancelled' ? 'Cancelled; existing artifacts retained'
    : run.status === 'blocked' ? 'A technical incident remains unresolved; existing artifacts are retained'
    : run.status === 'uncertain' || run.status === 'interrupted' ? 'Reconciling the saved execution checkpoint'
    : actionLabels[actionStage] ?? 'Processing the saved request';
  const stage = (id: string, label: string, role: string, phase: string) => {
    const attempt = run.attempts.findLast(item => item.stage === phase && item.role === role);
    return { id, label, role: roleNames[role], state: attempt?.state === 'running' || attempt?.state === 'starting' ? 'running'
      : attempt?.state === 'completed' ? attempt.report?.outcome === 'completed' && attempt.report?.verdict !== 'fail' ? 'completed' : 'repairing'
      : 'pending' };
  };
  const artifacts = Object.keys(current).flatMap(path => {
    const absolute = safePath(root, path); if (!existsSync(absolute)) return [];
    const info = lstatSync(absolute); if (!info.isFile() || info.isSymbolicLink()) return [];
    return [{ path, label: path.split('/').at(-1), state: changed && delivered[path] !== current[path] ? 'changed' : accepted ? 'verified' : 'draft', bytes: info.size,
      sha256: hash(readFileSync(absolute)), exists: true }];
  });
  const stages = [stage('requirements', 'Requirement Gathering', 'requirements', 'requirements'),
    stage('analysis', 'System Analysis', 'requirements', 'requirements'), stage('software-design', 'Software Design', 'architect', 'design'),
    { ...stage('module-design', 'Module Design', 'architect', 'design'), rationale: 'WF.P-RES reports the applicable interface and module decisions in its design result.' }, stage('coding', 'Coding', 'developer', 'implementation'),
    stage('review', 'Independent Review', 'reviewer', 'review')];
  const tester = run.attempts.findLast(item => item.stage === 'verification');
  const testerPassed = tester?.state === 'completed' && tester.report?.outcome === 'completed' && tester.report?.verdict === 'pass';
  const testedHashes = tester?.bound_hashes ? controlledFingerprints(root, Object.keys(tester.bound_hashes)) : {};
  const testerCurrent = !!tester?.bound_hashes && Object.entries(tester.bound_hashes).every(([path, digest]) => testedHashes[path] === digest);
  for (const [id, label] of [['unit', 'Unit Testing'], ['integration', 'Integration Testing'], ['system', 'System Testing'], ['acceptance', 'Acceptance Testing']]) {
    const level = contract?.verification_levels?.find(level => level.level === id);
    let state = 'pending';
    if (level && !level.applicable) state = 'not-applicable';
    else if (level && tester) {
      const executions = level.checks.every(title => {
        const receipt = run.checks.findLast(check => check.attempt_id === tester.id && check.title === title);
        if (!receipt?.passed) return false;
        const baseline = controlledFingerprints(root, Object.keys(receipt.baseline));
        return Object.entries(receipt.baseline).every(([path, digest]) => baseline[path] === digest);
      });
      state = testerPassed && testerCurrent && !changed && (id === 'acceptance' ? accepted : level.method === 'inspection' || executions)
        ? 'completed' : ['starting', 'running'].includes(tester.state) ? 'running' : testerPassed ? 'uncertain' : 'pending';
    }
    stages.push({ id: id!, label: label!, role: 'WF.Tester', state,
      rationale: level?.rationale ?? 'Verification level has not yet been allocated by the saved request contract.' });
  }
  return { schema_version: 1, workflow_id: run.workflow_id, epoch_id: run.epoch_id, request_id: run.request_id,
    requirement: run.requirement, title: run.title.replace(/^Workflow:\s*/i, ''), status: changed ? 'changed' : acceptedAtCompletion && !accepted ? 'uncertain' : run.status,
    historical_status: run.status, phase: run.phase, revision: run.revision,
    updated_at: run.updated_at, process_contract: run.process_contract, transport: run.transport,
    ...(waiting ? { dependency_wait: { code: waiting.code, attempts: waiting.attempts,
      next_condition_check_at: waiting.next_condition_check_at, ...(waiting.last_check_at ? { last_check_at: waiting.last_check_at } : {}) } } : {}),
    ...(run.pending_question ? { question: { id: run.pending_question.id, text: run.pending_question.question,
      reason: run.pending_question.why_cannot_infer, missing: run.pending_question.missing,
      criterion: run.pending_question.criterion, status: 'pending' as const } } : {}),
    request_key: folder?.display_id ?? run.workflow_id, folder: folder ? `.workforce/${folder.directory}` : undefined,
    stage: actionStage, current_action: currentAction,
    active_agents: run.active_invocations.map(item => ({ ...item, name: roleNames[item.role] ?? item.role })),
    stages, artifacts, criteria: (contract?.plan.acceptance_criteria ?? []).map((text, index) => ({ id: `C${index + 1}`, text, state: accepted ? 'passed' : 'pending' })),
    findings: changed ? [{ message: 'Product files changed after the accepted delivery. Historical checks do not verify this revision.', owner: 'runtime', code: 'DELIVERY_CHANGED' }]
      : verification && !verification.ok ? verification.findings.map(finding => ({ message: finding.message, code: finding.code, owner: 'runtime' }))
      : run.blocker?.findings ?? (run.blocker ? [{ message: run.blocker.message, owner: run.blocker.owner ?? 'runtime' }] : []),
    accepted, runtime_health: acceptedAtCompletion && !accepted
      ? { state: changed ? 'changed' : 'incident', owner: 'runtime', message: changed
        ? 'The accepted delivery is retained in history; current edits need fresh verification.' : 'The saved acceptance proof does not validate the current revision.' }
      : waiting ? { state: 'waiting', owner: 'runtime', message: currentAction }
      : run.blocker && run.status !== 'needs_input'
      ? { state: run.active_invocations.length ? 'recovering' : 'incident', owner: 'runtime', message: run.active_invocations.length
        ? 'WorkForce is reconciling a technical failure; no additional product input is implied.'
        : 'A runtime incident remains unresolved. Saved artifacts are retained; the request is not accepted and no additional product input is implied.' }
      : { state: 'connected', owner: 'runtime', message: 'Reading the saved request state.' } };
}
type WorkForceStartInput = Omit<ControlledStartInput, 'context'> & {
  context?: { path: string; kind?: 'file' | 'directory' }[]; new_request?: boolean };
/** Client attachment paths are observations, not internal identifiers. Resolve
 * their actual type and project relation before creating a durable request. */
export function workForceIntakeContext(root: string, context: WorkForceStartInput['context']): ControlledStartInput['context'] {
  if (!context) return undefined;
  root = realpathSync.native(root);
  return context.map(item => {
    const supplied = item.path.startsWith('file:') ? fileURLToPath(item.path) : item.path;
    const path = relative(resolve(root), isAbsolute(supplied) ? supplied : resolve(root, supplied));
    if (!path) return { path: '.', kind: 'directory' as const };
    if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path))
      throw new Error('The attachment must be an actual file or directory inside this project.');
    const canonical = path.replaceAll('\\', '/');
    if (!controlledPublicReferencePath(canonical)) throw new Error('The attachment must be an ordinary public project source, not runtime data or credentials.');
    const target = safePath(root, canonical), actual = lstatSync(target);
    if (actual.isSymbolicLink() || !actual.isFile() && !actual.isDirectory()) throw new Error('The attachment must be an ordinary local file or directory.');
    let ancestor = dirname(target);
    while (ancestor !== resolve(root)) {
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error('The attachment cannot pass through a linked directory.');
      const parent = dirname(ancestor); if (parent === ancestor) throw new Error('The attachment is outside this project.'); ancestor = parent;
    }
    const actualRelative = relative(realpathSync.native(root), realpathSync.native(target));
    if (actualRelative === '..' || actualRelative.startsWith('../') || actualRelative.startsWith('..\\') || isAbsolute(actualRelative))
      throw new Error('The attachment is outside this project.');
    return { path: canonical, kind: actual.isDirectory() ? 'directory' as const : 'file' as const };
  });
}
export async function requestSubmit(root: string, input: WorkForceStartInput) {
  const { new_request: newRequest, context, title, ...payload } = input;
  const validated = validateControlledStartInput({ ...payload, ...(title?.trim() ? { title: title.trim() } : {}),
    ...(context ? { context: workForceIntakeContext(root, context) } : {}) });
  const prepared = prepareWorkForceIntake(root, validated, newRequest);
  const run = await startControlledWorkflow(root, prepared);
  try { recordWorkForceAdmission(root, run.request_id, run.workflow_id); }
  catch { /* The pre-dispatch admission ID and canonical workflow already persisted. Do not turn their lost auxiliary link update into a duplicate submission. */ }
  return requestProjection(root, run);
}
export function requestStatus(root: string, id?: string) {
  if (id) { const run = requestRun(root, id);
    try { recordWorkForceAdmission(root, run.request_id, run.workflow_id, true); } catch { /* Observation still returns canonical request/artifact state. */ }
    return requestProjection(root, run); }
  return { requests: (controlledStatus(root) as ControlledSnapshot[]).map(run => requestProjection(root, run)) };
}
export async function requestControl(root: string, input: { request_id?: string; workflow_id?: string; action: 'pause' | 'resume' | 'cancel'; answer?: string; question_id?: string }) {
  const id = input.workflow_id ?? input.request_id; if (!id) throw new Error('Select the saved request to control.');
  const run = requestRun(root, id);
  if (input.answer !== undefined) {
    if (input.action !== 'resume') throw new Error('An answer continues the pending request; use action resume.');
    if (!input.question_id) throw new Error('Answer the issued question using its question_id from request_status.');
    return requestProjection(root, await answerControlledWorkflow(root, run.workflow_id, input.answer, input.question_id));
  }
  return requestProjection(root, await controlControlledWorkflow(root, { workflow_id: run.workflow_id, action: input.action }));
}
export function requestSetupStatus(root: string) {
  const config = readConfig(root), routing = readRoutingPolicy(root), info = createRuntimeInfo(root);
  const checks: { label: string; state: string; summary: string }[] = [];
  const check = (label: string, action: () => string) => { try { checks.push({ label, state: 'passed', summary: action() }); }
    catch { checks.push({ label, state: 'missing', summary: `${label} needs connection or configuration.` }); } };
  check('Engine', () => { if (config.execution_engine !== 'opencode') throw new Error(); openCodeBinary(); openCodeBootstrap(); return `OpenCode ${opencodeRuntimeVersion} and locked bootstrap installed`; });
  check('Private execution storage', () => { const storage = openCodeStorage(root);
    if (storage.free_bytes < storage.required_bytes) throw new Error(); return 'Private execution storage has sufficient free space'; });
  check('Workspace owner', () => { readHost(root); return 'WorkForce owner connected'; });
  check('Routing', () => { if (!routing?.strong_model || !routing.worker_models.length) throw new Error();
    configuredOpenCodeEndpoint(root, 'manager'); configuredOpenCodeEndpoint(root, 'developer');
    return `${routing.strong_model} / ${routing.worker_models.join(', ')}`; });
  const proof = workForceConnectionProof(root), configured = checks.every(check => check.state === 'passed');
  checks.push({ label: 'Model tool capability', state: proof.valid ? 'passed' : 'missing',
    summary: proof.valid ? `Actual configured routes checked at ${proof.checked_at}` : 'Connect WorkForce to check actual model tool calls once for this build/configuration.' });
  const clients = workForceClientStatus(root);
  for (const entry of clients.registrations) checks.push({ label: `${entry.client} MCP registration`, state: entry.configured ? 'passed' : 'missing', summary: entry.message });
  return { ready: configured && proof.valid && clients.registrations.every(entry => entry.configured),
    engine_ready: configured && proof.valid, configured, checks, clients, version: info.package_version, engine_version: opencodeRuntimeVersion,
    build_fingerprint: info.build_fingerprint, capability_proof: proof,
    summary: configured && proof.valid ? 'Worker engine connected and tool-tested. Check the separate client registrations and observed connections before using Copilot or Codex.'
      : 'Complete the workspace connection and actual model tool-call check before submitting work.' };
}
export function createWorkForceMcpServer(root: string): McpServer {
  const info = createRuntimeInfo(root), server = new McpServer({ name: 'workforce', version: info.package_version });
  server.server.oninitialized = () => { try { observeWorkForceClient(root, server.server.getClientVersion()); } catch { /* Observation never blocks product work. */ } };
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const receipt = (value: WorkForceRequestView) => ({ request_id: value.request_id, request_key: value.request_key,
    workflow_id: value.workflow_id, epoch_id: value.epoch_id, status: value.status, stage: value.stage, revision: value.revision,
    folder: value.folder, artifacts: value.artifacts.slice(0, 8), accepted: value.accepted,
    next_action: 'WorkForce owns execution. Use request_status for this saved request when the user asks for progress.' });
  server.registerTool('request_submit', { description: 'Submit the complete user requirement once. Backend owns sessions, IDs, tools and verification. Return its saved receipt.',
    inputSchema: { requirement: z.string().trim().min(1).max(20000), title: z.string().max(256).optional().describe('Optional human-readable title. An empty title is omitted by the backend.'),
      context: z.array(z.strictObject({ path: z.string().min(1).max(2000).describe('An actual workspace attachment: relative path, absolute local path or file URI. Backend resolves its project relation and file/directory type.'),
        kind: z.enum(['file', 'directory']).optional() })).max(32).optional(),
      new_request: z.boolean().optional().describe('True for a new user-request turn, including repeating an earlier completed request. Omit on a same-turn retry after a lost response to recover its saved admission; never repeat true to repair delivery.') } },
    async input => result(receipt(await requestSubmit(root, input))));
  server.registerTool('request_status', { description: 'Read saved request status and delivered artifacts. Does not run the request again.',
    inputSchema: { request_id: z.string().optional() } }, input => result(requestStatus(root, input.request_id)));
  server.registerTool('request_control', { description: 'Pause, resume or cancel the selected saved request.',
    inputSchema: { request_id: z.string(), action: z.enum(['pause', 'resume', 'cancel']), answer: z.string().optional(), question_id: z.uuid().optional() } }, async input => result(await requestControl(root, input)));
  return server;
}
