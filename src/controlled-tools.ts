import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { atomicWrite, hash, now, safePath, withOperationLock } from './storage.js';
import { replaceWorkspaceFile, workspaceFileBytes, workspaceContentBytes, workspacePathLockKey } from './workspace.js';
import { registerProcedureSchema } from './procedures.js';
import { cornellResearchSchema } from './cornell-workflow.js';
import { controlledModelInput, controlledValidation, redactControlledValue } from './controlled-observability.js';

export type ControlledStage = 'planning' | 'implementation' | 'verification' | 'review' | 'diagnosis' | 'synthesis';
export interface ControlledBinding {
  workflow_id: string; task_id?: string; invocation_id?: string;
  stage: ControlledStage; role: string;
  implementation_paths: string[]; verification_paths: string[];
  read_paths?: string[]; protected_paths?: string[]; check_titles?: string[];
  approved_inputs?: string[];
}
const text = z.string().trim().min(1).max(8000);
const paths = z.array(z.string().min(1).max(1024)).max(128);
export const controlledPlanSchema = z.strictObject({
  title: text.max(256), objective: text, rationale: text,
  acceptance_criteria: z.array(text).min(1).max(32),
  allowed_paths: paths.min(1), verification_paths: paths.min(1), outputs: paths.min(1),
  documentation_paths: paths.default([]),
  checks: z.array(z.strictObject({ title: text.max(256),
    purpose: z.enum(['self-check', 'intended-use']).optional(),
    command: z.array(z.string().min(1).max(8000)).min(2).max(128),
    baseline_paths: paths.min(1), expected_exit_code: z.number().int().min(0).max(255).optional(),
    timeout_ms: z.number().int().min(1).max(600000).optional(),
    negative_controls: z.array(z.strictObject({ title: text.max(256),
      command: z.array(z.string().min(1).max(8000)).min(2).max(128),
      baseline_paths: paths.min(1), expected_exit_code: z.number().int().min(1).max(255),
    })).max(16).optional(),
  })).min(1).max(16),
  risk: z.enum(['low', 'elevated', 'high']).optional(),
  reuse: z.strictObject({ procedure_id: text.max(80), version: text.max(80).optional(), parameters: z.record(z.string(), z.unknown()) }).optional(),
  procedure_candidate: registerProcedureSchema.omit({ id: true, version: true, author: true }).optional(),
  cornell_output_dir: z.string().min(1).max(1024).optional(),
  input_paths: paths.optional(),
  preservation_paths: paths.optional(),
  specialists: z.array(z.strictObject({ role: text.max(100), objective: text })).max(4).optional(),
});
export type ControlledPlan = z.infer<typeof controlledPlanSchema>;
export const controlledReportSchema = z.strictObject({
  outcome: z.enum(['completed', 'blocked', 'failed']), summary: text,
  artifacts: paths.optional(), findings: z.array(text).max(64).optional(),
  failure_kind: z.enum(['implementation', 'checker', 'protocol', 'environment', 'unknown']).optional(),
  verdict: z.enum(['pass', 'fail']).optional(), negative_controls: z.array(text).max(32).optional(),
  limitations: z.array(text).max(32).optional(),
});
export type ControlledReport = z.infer<typeof controlledReportSchema>;
export interface ControlledCallbacks {
  /** Check authoritative invocation, epoch and current policy; writers recheck synchronously at commit. */
  assertActive(): void | Promise<void>;
  submitPlan?(plan: ControlledPlan): unknown | Promise<unknown>;
  saveReport(report: ControlledReport): unknown | Promise<unknown>;
  runCheck?(title?: string): unknown | Promise<unknown>;
  prepareWork?(query: { request: string; parameters?: Record<string, unknown> }): unknown | Promise<unknown>;
  runProcedure?(parameters?: Record<string, unknown>): unknown | Promise<unknown>;
  compileResearch?(input: Record<string, unknown>): unknown | Promise<unknown>;
  readEvidence?(title?: string): unknown | Promise<unknown>;
  trace?(event: Record<string, unknown>): void | Promise<void>;
}
/** Only explicitly public controller diagnostics cross the model-facing error seam. */
export class ControlledToolError extends Error {
  constructor(readonly code: string, message: string,
    readonly ownership?: { target_owner: 'developer' | 'verifier' | 'protected-acceptance' | 'outside-scope'; next_action: string;
      rule?: 'ROLE_HANDOFF_REQUIRED'; target_path?: string }) { super(message); }
}
interface ToolState {
  schema_version: 1; binding_hash: string;
  reads: Record<string, string | null>;
  writes: { operation: string; path: string; previous_hash: string | null; sha256: string; completed: boolean }[];
}
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const covers = (scope: string, path: string) => scope === '.' || key(path) === key(scope) || key(path).startsWith(`${key(scope)}/`);
function canonical(path: string, directory = false): string {
  if (directory && path === '.') return path;
  if (!path || path.startsWith('/') || /[\\:\x00-\x1f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)))
    throw new ControlledToolError('INVALID_PATH', 'Use a canonical project-relative path with forward slashes.');
  return path;
}
function privatePath(path: string): boolean {
  return path.toLowerCase().split('/').some(part =>
    ['.git', '.neomind', '.verythinker', '.taskforces', '.codex', '.claude', '.vscode', '.agents', '.cursor', 'node_modules'].includes(part) ||
    /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|pfx|p12))$/.test(part));
}
function publicTarget(root: string, path: string, approved: string[] = []): string {
  canonical(path, true);
  if (privatePath(path) && !approved.includes(path)) throw new ControlledToolError('PRIVATE_PATH', 'Private runtime, credentials and client configuration are unavailable to workers.');
  const target = safePath(root, path);
  let current = resolve(root);
  for (const component of path === '.' ? [] : path.split('/')) {
    current = resolve(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new ControlledToolError('INVALID_PATH', 'Worker file tools do not follow symbolic links.');
  }
  return target;
}
function assertReadable(binding: ControlledBinding, path: string, directory = false): void {
  const scopes = binding.read_paths ?? ['.'];
  if (!scopes.some(scope => covers(scope, path) || (directory && covers(path, scope))))
    throw new ControlledToolError('SCOPE_DENIED', 'This path is outside the assigned readable inputs.');
}
function assertWritable(binding: ControlledBinding, path: string): void {
  canonical(path);
  const scopes = binding.stage === 'implementation' && binding.role === 'developer' ? binding.implementation_paths
    : binding.stage === 'verification' && ['verifier', 'check-executor'].includes(binding.role) ? binding.verification_paths : [];
  const other = binding.stage === 'implementation' ? binding.verification_paths : binding.implementation_paths;
  const protectedTarget = (binding.protected_paths ?? []).some(scope => covers(scope, path));
  if (!scopes.some(scope => covers(scope, path)) || other.some(scope => covers(scope, path)) || protectedTarget) {
    const target_owner = protectedTarget ? 'protected-acceptance' : binding.verification_paths.some(scope => covers(scope, path)) ? 'verifier'
      : binding.implementation_paths.some(scope => covers(scope, path)) ? 'developer' : 'outside-scope';
    const producerHandoff = binding.stage === 'implementation' && binding.role === 'developer' && target_owner === 'verifier';
    const verifierProduct = binding.stage === 'verification' && target_owner === 'developer';
    const next_action = producerHandoff
      ? 'Finish only your assigned implementation outputs. When they are ready, save assignment_report with outcome completed. Missing checker files and negative-control fixtures are expected: the backend dispatches the independent Verifier next.'
      : verifierProduct ? 'Do not edit implementation files. Report the concrete product defect with failure_kind implementation; the backend dispatches the implementation repair.'
      : protectedTarget ? 'Preserve the protected acceptance artifact. Report the constraint for backend reconciliation; this role cannot widen its scope.'
      : !scopes.length ? 'This role is read-only. Inspect the assigned artifacts and evidence, then report your findings; route required changes to their owning role.'
      : 'Use only your assigned writable paths. Report any required scope change to the backend instead of editing another role\'s files.';
    throw new ControlledToolError('SCOPE_DENIED', `Write denied. Target owner: ${target_owner}. ${next_action}`,
      { target_owner, target_path: path, next_action, ...(producerHandoff ? { rule: 'ROLE_HANDOFF_REQUIRED' } : {}) });
  }
}
export function controlledToolNames(binding: ControlledBinding): string[] {
  return ['project_read', 'project_list', 'project_search', 'assignment_report',
    ...(binding.stage === 'planning' ? ['workflow_plan', 'work_prepare'] : []),
    ...((binding.stage === 'implementation' && binding.role === 'developer') ||
      (binding.stage === 'verification' && ['verifier', 'check-executor'].includes(binding.role)) ? ['task_file_write'] : []),
    ...(binding.stage === 'implementation' ? ['procedure_run'] : []),
    ...(['implementation', 'synthesis'].includes(binding.stage) ? ['cornell_research_compile'] : []),
    ...(['verification', 'review', 'synthesis', 'diagnosis'].includes(binding.stage) ? ['check_evidence'] : []),
    ...(binding.stage === 'verification' ? ['check_run'] : [])];
}
export function controlledInstructions(binding: ControlledBinding): string {
  const writable = binding.stage === 'implementation' && binding.role === 'developer' ? binding.implementation_paths
    : binding.stage === 'verification' && ['verifier', 'check-executor'].includes(binding.role) ? binding.verification_paths : [];
  const ownership = { your_role: binding.role, your_stage: binding.stage, your_writable_paths: writable,
    implementation: { owner: 'developer', paths: binding.implementation_paths }, verification: { owner: 'verifier', paths: binding.verification_paths } };
  const duties: Record<ControlledStage, string> = {
    planning: 'Inspect relevant files and existing reusable tools. Submit one bounded semantic workflow_plan with acceptance criteria, separate implementation/checker paths and actual check commands. Declare negative_controls using the same checker with verifier-owned deliberately invalid fixtures/inputs and their expected nonzero exits; runtime executes them as evidence. Elevate risk or suggest a bounded specialist only when needed.',
    implementation: 'Read existing files before editing. Implement only the assigned outputs with task_file_write. Backend handles file versions, operation identity and task lifecycle. Preserve independent checker and acceptance files.',
    verification: 'Inspect the delivered implementation. Author and repair only the independent checker paths, including deliberately invalid fixtures for the prescribed negative_controls. Run the prescribed checks with check_run; backend executes both positive and negative commands. Report prose alone is not negative-control evidence. Distinguish a product defect from a checker or environment failure.',
    review: 'Independently inspect the delivered artifacts and actual verification evidence. Report pass or fail and substantive findings against the unchanged acceptance criteria.',
    diagnosis: 'Inspect available evidence and identify the root cause. Classify failure_kind as implementation, checker, protocol, environment or unknown and recommend one bounded recovery action.',
    synthesis: 'Derive the final requested Cornell research note from actual artifacts and independent evidence. Use cornell_research_compile to preserve the standard format and separate practice/answers. Record limitations and actual sources, then assignment_report. Source implementation and checker files are read-only.',
  };
  return `Authoritative role ownership: ${JSON.stringify(ownership)}\n` +
    (binding.stage === 'implementation' ? 'Complete only your implementation outputs. The independent Verifier owns all checker files and negative-control fixtures; missing verifier artifacts are EXPECTED at this handoff. Do not create them or mark your work blocked because a later role has not run. When your own outputs are ready, save outcome completed; the backend advances to Verifier. Report blocked only for a real blocker to your assigned implementation.\n' : '') +
    `You are a NeoMind-owned ${binding.role} session in the ${binding.stage} stage. ${duties[binding.stage]}\n` +
    'Only the supplied tools are available. Their actor, workflow, task, scope and authorization are already bound by the runtime. Supply semantic content and project-relative file paths.\n' +
    'Reuse: planning may bind reuse {procedure_id,version,parameters} after work_prepare reports exact eligibility; implementation calls procedure_run instead of recreating the generator. For newly delivered reusable scripts declare procedure_candidate (manifest without id/version/author); runtime registers it after checked completion without claiming qualification. For requested Cornell notes declare cornell_output_dir and all three note.md/exercises.md/answers.md outputs, then implementation calls cornell_research_compile with substantive research content.\n' +
    'Before ending, save one compact assignment_report with outcome, summary, artifacts and findings. A blocked or failed report preserves useful work and does not submit a task. Reported prose is distinct from observed execution evidence. Runtime events supply progress and advance the workflow; focus on the assigned work.';
}

/** Each server belongs to one actual invocation; no model-provided identity can rebind it. */
export function createControlledMcpServer(root: string, input: ControlledBinding, callbacks: ControlledCallbacks): McpServer {
  const binding = structuredClone(input);
  for (const path of binding.approved_inputs ?? [])
    if (!/^\.(?:agents|github)\/skills\/[^/]+\/(?:assets|scripts)\/.+\.(?:md|py|mjs|cjs|js|json)$/i.test(path) || privatePath(path.split('/').slice(4).join('/')))
      throw new Error('Approved hidden inputs must be bounded skill assets or script sources, never client/runtime configuration.');
  if (!binding.invocation_id || !binding.workflow_id || !binding.role ||
      !['planning', 'implementation', 'verification', 'review', 'diagnosis', 'synthesis'].includes(binding.stage))
    throw new Error('Controlled MCP requires a backend-bound actual invocation.');
  for (const scope of [...binding.implementation_paths, ...binding.verification_paths, ...(binding.read_paths ?? []), ...(binding.protected_paths ?? [])])
    canonical(scope, true);
  const bindingHash = hash(JSON.stringify(binding));
  const base = `.neomind/controlled-tools/${hash(binding.invocation_id)}`;
  const statePath = `${base}/state.json`;
  const server = new McpServer({ name: 'neomind-controlled-worker', version: '2' }, { maxToolInputElements: 8000 });
  let closed = false;
  const originalClose = server.close.bind(server);
  server.close = async () => { closed = true; await originalClose(); };
  function loadState(): ToolState {
    const path = safePath(root, statePath);
    const state: ToolState = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
      : { schema_version: 1, binding_hash: bindingHash, reads: {}, writes: [] };
    if (state.schema_version !== 1 || state.binding_hash !== bindingHash || !state.reads || !Array.isArray(state.writes))
      throw new ControlledToolError('STATE_UNCERTAIN', 'The saved tool journal differs from this bound invocation; runtime reconciliation is required.');
    return state;
  }
  function saveState(state: ToolState): void { atomicWrite(safePath(root, statePath), `${JSON.stringify(state, null, 2)}\n`); }
  function locked<T>(action: (state: ToolState) => T): T {
    return withOperationLock(root, `controlled-tools-${hash(binding.invocation_id!).slice(0, 32)}`, () => action(loadState()));
  }
  function activeAtCommit(): void {
    if (closed) throw new ControlledToolError('ACTOR_INACTIVE', 'This worker session has ended.');
    const result = callbacks.assertActive();
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch(() => {});
      throw new ControlledToolError('PROTOCOL_ERROR', 'File commits require a synchronous authoritative invocation check.');
    }
  }
  function completeWrite(entry: ToolState['writes'][number]): void {
    const folder = `${base}/writes/${entry.operation}`;
    const intent = { schema_version: 1, operation: entry.operation, binding_hash: bindingHash, path: entry.path,
      previous_hash: entry.previous_hash, sha256: entry.sha256 };
    try {
      if (readFileSync(safePath(root, `${folder}/intent.json`), 'utf8') !== `${JSON.stringify(intent, null, 2)}\n` ||
          hash(readFileSync(safePath(root, `${folder}/next.utf8`))) !== entry.sha256 ||
          (entry.previous_hash !== null && hash(readFileSync(safePath(root, `${folder}/previous.utf8`))) !== entry.previous_hash))
        throw new Error('history mismatch');
      const completion = `${JSON.stringify({ ...intent, kind: 'completed-controlled-file-write' }, null, 2)}\n`;
      const path = safePath(root, `${folder}/completion.json`);
      if (existsSync(path) && readFileSync(path, 'utf8') !== completion) throw new Error('completion mismatch');
      if (!existsSync(path)) atomicWrite(path, completion);
    } catch {
      throw new ControlledToolError('STATE_UNCERTAIN', 'The immutable file operation history is missing or changed; runtime reconciliation is required.');
    }
    entry.completed = true;
  }
  async function trace(event: Record<string, unknown>): Promise<void> {
    // Observability cannot turn a successfully persisted operation into a model retry.
    try { await callbacks.trace?.({ ...event, stage: binding.stage, at: now(),
      backend_binding: { workflow_id: binding.workflow_id, task_id: binding.task_id ?? null, invocation_id: binding.invocation_id },
      owner: 'runtime' }); } catch { /* advisory */ }
  }
  function register(name: string, description: string, schema: z.ZodType, readOnly: boolean,
    action: (args: any) => unknown | Promise<unknown>): void {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, async (args: any) => {
      try {
        if (closed) throw new ControlledToolError('ACTOR_INACTIVE', 'This worker session has ended.');
        await callbacks.assertActive();
        await trace({ event: 'tool-request', tool: name, model_input: controlledModelInput(name, args), owner: 'runtime',
          backend_binding: { workflow_id: binding.workflow_id, task_id: binding.task_id ?? null, invocation_id: binding.invocation_id } });
        const result = await action(args);
        await trace({ event: 'tool-result', tool: name, status: 'succeeded' });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? { saved: true }) }] };
      } catch (error) {
        const validation = controlledValidation(error instanceof ControlledToolError ? error.code : undefined,
          error instanceof ControlledToolError ? error.message : undefined);
        const ownership = error instanceof ControlledToolError && error.ownership ? redactControlledValue(error.ownership) as Record<string, unknown> : {};
        await trace({ event: 'tool-result', tool: name, status: 'failed', code: validation.code, validation,
          request_sha256: hash(JSON.stringify(args)), ...ownership });
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: validation.rule, code: validation.code,
          validation, ...ownership }) }] };
      }
    });
  }
  register('project_read', 'Read an assigned UTF-8 file. The backend retains its version for subsequent scoped edits.',
    z.strictObject({ path: z.string().min(1).max(1024), max_chars: z.number().int().min(128).max(64000).optional(),
      start_line: z.number().int().min(1).optional() }), true, args => {
      const target = publicTarget(root, args.path, binding.approved_inputs); assertReadable(binding, args.path);
      if (!existsSync(target)) {
        locked(state => { state.reads[key(args.path)] = null; saveState(state); });
        return { path: args.path, exists: false, text: null };
      }
      const info = lstatSync(target);
      if (!info.isFile() || info.nlink > 1 || info.size > 2 * 1024 * 1024)
        throw new ControlledToolError('INVALID_FILE', 'Read an ordinary, unlinked text file up to 2 MiB.');
      const bytes = readFileSync(target);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new ControlledToolError('INVALID_FILE', 'The file is not valid UTF-8 text.'); }
      if (content.includes('\0')) throw new ControlledToolError('INVALID_FILE', 'Binary files require an appropriate artifact tool.');
      locked(state => { state.reads[key(args.path)] = hash(bytes); saveState(state); });
      const start = args.start_line ?? 1, excerpt = content.split(/\r?\n/).slice(start - 1).join('\n'), maximum = args.max_chars ?? 64000;
      return { path: args.path, exists: true, size_bytes: bytes.length, start_line: start,
        text: excerpt.slice(0, maximum), truncated: excerpt.length > maximum };
    });
  function walk(directory: string, limit = 200): { files: string[]; truncated: boolean } {
    publicTarget(root, directory); assertReadable(binding, directory, true);
    const files: string[] = [], queue = [directory]; let examined = 0;
    while (queue.length && files.length < limit && examined < 5000) {
      const parent = queue.shift()!;
      for (const entry of readdirSync(publicTarget(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = parent === '.' ? entry.name : `${parent}/${entry.name}`;
        if (++examined > 5000 || files.length >= limit) return { files, truncated: true };
        if (privatePath(path) || entry.isSymbolicLink()) continue;
        try { canonical(path); publicTarget(root, path); assertReadable(binding, path, entry.isDirectory()); }
        catch { continue; }
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile()) files.push(path);
      }
    }
    return { files, truncated: !!queue.length || examined >= 5000 };
  }
  register('project_list', 'List readable project files; private runtime, credential and dependency directories are excluded.',
    z.strictObject({ path: z.string().min(1).max(1024).default('.'), limit: z.number().int().min(1).max(1000).default(200) }), true,
    args => walk(args.path, args.limit));
  register('project_search', 'Find literal text in readable project files without invoking a shell.',
    z.strictObject({ query: z.string().min(1).max(1000), path: z.string().min(1).max(1024).default('.'),
      max_matches: z.number().int().min(1).max(100).default(40) }), true, args => {
      const found = walk(args.path, 1000), matches: { path: string; line: number; text: string }[] = [];
      for (const path of found.files) {
        const target = publicTarget(root, path), info = lstatSync(target);
        if (info.size > 2 * 1024 * 1024 || info.nlink > 1) continue;
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(target)); } catch { continue; }
        if (content.includes('\0')) continue;
        for (const [line, value] of content.split(/\r?\n/).entries()) if (value.includes(args.query)) {
          matches.push({ path, line: line + 1, text: value.slice(0, 1000) });
          if (matches.length >= args.max_matches) return { matches, truncated: true };
        }
      }
      return { matches, truncated: found.truncated };
    });
  if (controlledToolNames(binding).includes('task_file_write'))
    register('task_file_write', 'Write complete UTF-8 content within this stage scope. Read existing files first; the backend binds their versions and records recoverable operations.',
      z.strictObject({ path: z.string().min(1).max(1024), content: z.string().max(128 * 1024) }), false, args => {
        publicTarget(root, args.path); assertWritable(binding, args.path);
        try { workspaceContentBytes(args.content); }
        catch { throw new ControlledToolError('INVALID_FILE', 'Write valid UTF-8 text up to 128 KiB without binary control characters.'); }
        return locked(state => withOperationLock(root, workspacePathLockKey(args.path), () => {
          activeAtCommit();
          let current: Buffer | null;
          try { current = workspaceFileBytes(root, args.path); }
          catch { throw new ControlledToolError('INVALID_FILE', 'This target is not an ordinary editable UTF-8 project file.'); }
          const currentHash = current === null ? null : hash(current), nextHash = hash(args.content);
          const priorWrite = state.writes.findLast(item => item.path === args.path && item.sha256 === nextHash);
          if (priorWrite && currentHash === nextHash) {
            completeWrite(priorWrite); state.reads[key(args.path)] = nextHash; saveState(state);
            return { path: args.path, saved: true, replayed: true };
          }
          const observed = state.reads[key(args.path)];
          if (observed === undefined && current !== null)
            throw new ControlledToolError('READ_REQUIRED', 'Read the existing file before editing it; its current content will be preserved.');
          if ((observed ?? null) !== currentHash)
            throw new ControlledToolError('INPUT_CHANGED', 'This file changed after the last read. Read it again and preserve the new edits.');
          const operation = hash(JSON.stringify({ binding_hash: bindingHash, path: args.path, previous_hash: currentHash, sha256: nextHash }));
          const folder = `${base}/writes/${operation}`;
          const intent = { schema_version: 1, operation, binding_hash: bindingHash, path: args.path,
            previous_hash: currentHash, sha256: nextHash };
          for (const [path, bytes] of [[`${folder}/intent.json`, Buffer.from(`${JSON.stringify(intent, null, 2)}\n`)],
            [`${folder}/next.utf8`, Buffer.from(args.content)],
            ...(current === null ? [] : [[`${folder}/previous.utf8`, current] as const])] as const) {
            const target = safePath(root, path);
            if (existsSync(target) && !readFileSync(target).equals(bytes))
              throw new ControlledToolError('STATE_UNCERTAIN', 'The immutable file operation history changed; runtime reconciliation is required.');
            if (!existsSync(target)) atomicWrite(target, bytes);
          }
          let entry = state.writes.find(item => item.operation === operation);
          if (!entry) { entry = { operation, path: args.path, previous_hash: currentHash, sha256: nextHash, completed: false }; state.writes.push(entry); saveState(state); }
          try { replaceWorkspaceFile(root, { path: args.path, content: args.content, expected_hash: currentHash,
            authorize: () => { activeAtCommit(); assertWritable(binding, args.path); } }); }
          catch (error) {
            if (error instanceof ControlledToolError) throw error;
            throw new ControlledToolError('INPUT_CHANGED', 'File replacement could not complete safely. Current edits and the operation history were preserved; read the file again.');
          }
          completeWrite(entry); state.reads[key(args.path)] = nextHash; saveState(state);
          return { path: args.path, saved: true, replayed: false };
        }));
      });
  if (binding.stage === 'planning') {
    register('workflow_plan', 'Save one semantic plan. Backend creates and links records and applies the minimum risk policy.', controlledPlanSchema,
      false, plan => {
        if (!callbacks.submitPlan) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Planning is unavailable in this invocation.');
        return callbacks.submitPlan(plan);
      });
    register('work_prepare', 'Inspect reusable procedure applicability. Matching is advisory; the controller authorizes execution.',
      z.strictObject({ request: text.max(20000), parameters: z.record(z.string(), z.unknown()).optional() }), true, query => {
        if (!callbacks.prepareWork) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Reuse discovery is unavailable in this invocation.');
        return callbacks.prepareWork(query);
      });
  }
  if (binding.stage === 'verification')
    register('check_run', 'Run a prescribed independent check. The backend selects its saved command and captures execution evidence.',
      z.strictObject({ title: text.max(256).optional() }), false, args => {
        if (args.title && binding.check_titles && !binding.check_titles.includes(args.title))
          throw new ControlledToolError('INVALID_CHECK', 'Choose one of the prescribed check titles supplied in the assignment.');
        if (!callbacks.runCheck) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Check execution is unavailable in this invocation.');
        return callbacks.runCheck(args.title);
      });
  if (['verification', 'review', 'synthesis', 'diagnosis'].includes(binding.stage))
    register('check_evidence', 'Read actual bound check commands, execution output and intended-use evidence without private runtime files or identity fields.',
      z.strictObject({ title: text.max(256).optional() }), true, args => {
        if (!callbacks.readEvidence) throw new ControlledToolError('NO_CHECK_EVIDENCE', 'No bound check evidence is available in this session.');
        return callbacks.readEvidence(args.title);
      });
  if (binding.stage === 'implementation') {
    register('procedure_run', 'Run only the qualified procedure bound in the plan; backend derives identity, scope and execution key.',
      z.strictObject({ parameters: z.record(z.string(), z.unknown()).optional() }), false, args => {
        if (!callbacks.runProcedure) throw new ControlledToolError('NO_BOUND_PROCEDURE', 'The plan has no currently eligible exact procedure.');
        return callbacks.runProcedure(args.parameters);
      });
  }
  if (['implementation', 'synthesis'].includes(binding.stage)) {
    register('cornell_research_compile', 'Compile research into the saved Cornell format with separate questions and answers inside the assigned note folder.',
      cornellResearchSchema.omit({ requirement_id: true, expected_requirement_revision: true, workflow_id: true, task_id: true, owner: true, output_dir: true }), false,
      args => {
        if (!callbacks.compileResearch) throw new ControlledToolError('NO_CORNELL_OUTPUT', 'The plan does not request Cornell output.');
        return callbacks.compileResearch(args);
      });
  }
  register('assignment_report', 'Persist one substantive compact result. Incomplete findings are retained without submitting the task.',
    controlledReportSchema, false, report => {
      for (const path of report.artifacts ?? []) { publicTarget(root, path, binding.approved_inputs); assertReadable(binding, path); }
      return callbacks.saveReport(report);
    });
  return server;
}
