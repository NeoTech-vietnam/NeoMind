import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join, posix, resolve } from 'node:path';
import { z } from 'zod';
import { runCommand, type CommandResult, type CommandInput } from './command-runner.js';
import { hash, safePath, withOperationLock } from './storage.js';
import { validateProcedurePath } from './procedures.js';
import { workspacePathLockKey } from './workspace.js';
import type { ControlledPayloadSource } from './controlled-payload.js';

const paths = z.array(z.string().min(1).max(1024)).max(128);
/** Semantic local operation. Invocation identity, cwd and hashes are backend owned. */
export const controlledExecutionSchema = z.strictObject({
  title: z.string().trim().min(1).max(256),
  command: z.array(z.string().min(1).max(8000)).min(2).max(128),
  input: z.record(z.string(), z.json()).optional().describe('Optional structured JSON document supplied directly to the project script on stdin. Do not fabricate procedure metadata or IDs.'),
  input_paths: paths.default([]).describe('Exact existing project input/dependency files; the backend also captures the executed script and preserved inputs.'),
  output_paths: paths.describe('Exact new files the local script may create, within this producer scope. Existing files are never overwritten by this tool. Use [] for version observations.'),
  timeout_ms: z.number().int().min(1).max(600000).optional(),
  max_output_bytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
});
/** Payload content is prepared by the producer; the plan declares the executable and effects. */
export const controlledExecutionDeclarationSchema = controlledExecutionSchema.omit({ input: true });
export type ControlledExecutionInput = z.infer<typeof controlledExecutionSchema>;
export type ControlledExecutionDeclaration = z.infer<typeof controlledExecutionDeclarationSchema>;

export class ControlledExecutionError extends Error {
  constructor(readonly code: 'INVALID_EXECUTION' | 'SCOPE_DENIED' | 'PRIVATE_PATH' | 'INPUT_CHANGED' | 'OUTPUT_EXISTS', message: string) {
    super(message); this.name = 'ControlledExecutionError';
  }
}
export interface ControlledExecutionBinding {
  stage: string; role: string;
  implementation_paths: string[]; verification_paths: string[];
  read_paths?: string[]; approved_inputs?: string[]; protected_paths?: string[];
  /** Exact saved preservation fingerprints, supplied by the immutable contract. */
  preserved_hashes?: Record<string, string>;
  /** Backend-observed prepared JSON input; never added to the frozen declaration. */
  payload_source?: ControlledPayloadSource;
}
export interface PreparedControlledExecution {
  request: ControlledExecutionInput;
  cwd: string; command: string[]; executable: string; script?: string;
  baseline: Record<string, string>; output_baseline: Record<string, null>;
  /** Only these initially absent output ancestors may be removed after a failed run. */
  missing_parent_paths: string[];
  input_sha256: string | null; payload_hash: string;
  /** Serialized direct input is internal and must not appear in a public receipt. */
  stdin?: string;
  binding: ControlledExecutionBinding;
}
export interface ControlledExecutionResult {
  executable: string; command: string[]; input_sha256: string | null; payload_hash: string;
  baseline: Record<string, string>; baseline_after: Record<string, string | null>;
  output_hashes: Record<string, string | null>; changed_inputs: string[]; missing_outputs: string[];
  result: CommandResult; passed: boolean;
}
export interface ControlledExecutionRollback {
  complete: boolean;
  archived: { path: string; sha256: string; archive_path: string; bytes: number; removed: boolean }[];
  removed_directories: string[]; uncertain_paths: string[]; reason?: string;
}

const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const covers = (scope: string, path: string) => scope === '.' || key(scope) === key(path) || key(path).startsWith(`${key(scope)}/`);
const unique = (values: string[]) => [...new Map(values.map(path => [key(path), path])).values()];
function privatePath(path: string): boolean {
  return path.toLowerCase().split('/').some(part =>
    ['.git', '.workforce', '.workforce-private', '.neomind', '.verythinker', '.taskforces', '.codex', '.claude', '.vscode', '.agents', '.cursor', 'node_modules'].includes(part) ||
    /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|pfx|p12))$/.test(part));
}
function approvedSkillInput(path: string, binding: ControlledExecutionBinding): boolean {
  return (binding.approved_inputs ?? []).includes(path) &&
    /^\.(?:agents|github)\/skills\/[^/]+\/(?:assets|scripts)\/.+\.(?:md|py|mjs|cjs|js|json)$/i.test(path) &&
    !privatePath(path.split('/').slice(4).join('/'));
}
function checkedPath(root: string, path: string, binding: ControlledExecutionBinding, output = false): string {
  let target: string;
  try { target = validateProcedurePath(root, path); }
  catch { throw new ControlledExecutionError('INVALID_EXECUTION', 'Execution paths must be canonical project-relative paths and cannot follow symbolic links.'); }
  if (privatePath(path) && (output || !approvedSkillInput(path, binding)))
    throw new ControlledExecutionError('PRIVATE_PATH', 'Private runtime, credentials and client configuration are unavailable to local operations.');
  if (!output && !(binding.read_paths ?? ['.']).some(scope => covers(scope, path)))
    throw new ControlledExecutionError('SCOPE_DENIED', 'An execution input is outside the assigned readable inputs.');
  if (output && (!binding.implementation_paths.some(scope => covers(scope, path)) ||
      [...binding.verification_paths, ...(binding.protected_paths ?? []), ...Object.keys(binding.preserved_hashes ?? {})]
        .some(scope => covers(scope, path) || covers(path, scope))))
    throw new ControlledExecutionError('SCOPE_DENIED', 'Execution outputs must belong only to this producer and cannot overlap independent checker or protected inputs.');
  return target;
}
function fingerprint(root: string, path: string, binding: ControlledExecutionBinding, optional = false, output = false): string | null {
  const target = checkedPath(root, path, binding, output);
  if (!existsSync(target)) {
    if (optional) return null;
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Execution inputs must name existing ordinary files.');
  }
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024)
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Execution inputs and outputs must be bounded ordinary files.');
  return hash(readFileSync(target));
}
function missingOutputParents(root: string, outputs: string[]): string[] {
  const paths: string[] = [];
  for (const output of outputs) {
    for (let path = posix.dirname(output); path !== '.'; path = posix.dirname(path)) {
      const target = validateProcedurePath(root, path);
      if (existsSync(target)) {
        if (!lstatSync(target).isDirectory())
          throw new ControlledExecutionError('INVALID_EXECUTION', 'An execution output ancestor is not an ordinary directory.');
      } else paths.push(path);
    }
  }
  return unique(paths).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
}
function executablePath(command: string): string {
  if (/[\x00-\x1f]/.test(command)) throw new ControlledExecutionError('INVALID_EXECUTION', 'Use a bounded executable path without control characters.');
  const absolute = isAbsolute(command);
  if (!absolute && /[\\/:]/.test(command))
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Use an installed executable name or an absolute executable path.');
  const candidates = absolute ? [command] : (process.env.PATH ?? process.env.Path ?? '').split(delimiter)
    .filter(part => part && isAbsolute(part)).flatMap(part => process.platform === 'win32' && !extname(command)
      ? [join(part, `${command}.exe`), join(part, command)] : [join(part, command)]);
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return realpathSync.native(candidate);
    } catch { /* Resolve only actual executable files; diagnostics never expose PATH entries. */ }
  }
  throw new ControlledExecutionError('INVALID_EXECUTION', 'The declared executable was not found. Observe an installed executable; this tool never installs dependencies.');
}
function commandKind(executable: string): 'node' | 'python' | 'compiler' {
  const name = basename(executable).replace(/\.exe$/i, '').toLowerCase();
  if (/^node(?:js)?$/.test(name)) return 'node';
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) return 'python';
  if (/^(?:[a-z0-9_]+-)*g(?:cc|\+\+)(?:-\d+(?:\.\d+)*)?$/.test(name)) return 'compiler';
  throw new ControlledExecutionError('INVALID_EXECUTION', 'Only installed Node/Python project scripts and Node/Python/gcc/g++ version observations are supported. Shells and inline evaluation are unavailable.');
}
function assertArguments(args: string[], root: string, binding: ControlledExecutionBinding): void {
  for (const argument of args) {
    if (/[\x00-\x1f]/.test(argument)) throw new ControlledExecutionError('INVALID_EXECUTION', 'Execution arguments cannot contain control characters.');
    const value = argument.startsWith('-') && argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument;
    if (!value || value === '-' || /^--?[a-z0-9][a-z0-9_-]*$/i.test(value) || /^-\d+(?:\.\d+)?$/.test(value)) continue;
    if (isAbsolute(value) || /[\\]/.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value) || /^[a-z]:/i.test(value))
      throw new ControlledExecutionError('INVALID_EXECUTION', 'Script argv paths must remain project-relative. Supply structured data through input.');
    if (value.includes('/') || privatePath(value)) checkedPath(root, value, binding);
  }
}
function validateExecution(root: string, binding: ControlledExecutionBinding, input: ControlledExecutionInput,
  allowFutureInputs: boolean): { request: ControlledExecutionInput; executable: string; command: string[]; script?: string } {
  if (binding.stage !== 'implementation' || binding.role !== 'developer')
    throw new ControlledExecutionError('SCOPE_DENIED', 'Only the bound developer may execute a producer operation. Independent checks remain owned by the Verifier.');
  const request = controlledExecutionSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(request.command)) > 64 * 1024)
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Execution argv exceeds 64 KiB.');
  const executable = executablePath(request.command[0]!), kind = commandKind(executable);
  const observation = request.command.length === 2 && request.command[1] === '--version';
  let script: string | undefined;
  if (observation) {
    if (request.input !== undefined || request.input_paths.length || request.output_paths.length)
      throw new ControlledExecutionError('INVALID_EXECUTION', 'A version observation takes no input payload, project inputs or output files.');
  } else {
    if (kind === 'compiler' || request.command[1]!.startsWith('-') ||
        !(kind === 'node' ? /\.(?:mjs|cjs|js)$/i : /\.py$/i).test(request.command[1]!))
      throw new ControlledExecutionError('INVALID_EXECUTION', 'Run an exact existing Node/Python project script. Inline code, interpreter flags and compiler invocations are unavailable.');
    script = request.command[1]!;
    checkedPath(root, script, binding);
    assertArguments(request.command.slice(2), root, binding);
  }
  if (unique(request.input_paths).length !== request.input_paths.length)
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Declared execution input paths must be unique exact files.');
  const inputs = unique([...(script ? [script] : []), ...request.input_paths]);
  if (inputs.some((path, index) => inputs.some((other, otherIndex) => index !== otherIndex && covers(path, other))))
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Execution inputs must name separate exact files, not overlapping file/directory prefixes.');
  for (const path of inputs) {
    const target = checkedPath(root, path, binding);
    if (existsSync(target)) fingerprint(root, path, binding);
    else if (allowFutureInputs) checkedPath(root, path, binding, true);
    else throw new ControlledExecutionError('INVALID_EXECUTION', 'Execution inputs must name existing ordinary files.');
  }
  const outputs = unique(request.output_paths);
  if (outputs.length !== request.output_paths.length ||
      outputs.some((path, index) => outputs.some((other, otherIndex) => index !== otherIndex && covers(path, other))) ||
      outputs.some(path => inputs.some(input => covers(path, input) || covers(input, path))))
    throw new ControlledExecutionError('SCOPE_DENIED', 'Execution outputs must be separate unique new files, without overlapping prefixes or execution inputs.');
  for (const path of outputs) {
    const target = checkedPath(root, path, binding, true);
    if (existsSync(target)) throw new ControlledExecutionError('OUTPUT_EXISTS', 'An execution output already exists. Preserve authored content; use a new destination.');
  }
  missingOutputParents(root, outputs);
  return { request, executable, command: [executable, ...request.command.slice(1)], ...(script ? { script } : {}) };
}
/**
 * Read-only planning preflight. A not-yet-authored script/dependency is accepted
 * only inside the producer scope; actual execution still requires its bytes.
 * Call with the proposed developer binding, not the planner's own authority.
 */
export function validateControlledExecutionDeclaration(root: string, binding: ControlledExecutionBinding,
  input: ControlledExecutionDeclaration): ControlledExecutionDeclaration {
  const declaration = controlledExecutionDeclarationSchema.parse(input);
  validateExecution(root, binding, declaration, true);
  return declaration;
}
/** Validate only; this does not grant a procedure qualification or create durable state. */
export function prepareControlledExecution(root: string, binding: ControlledExecutionBinding, input: ControlledExecutionInput): PreparedControlledExecution {
  const { request, executable, command, script } = validateExecution(root, binding, input, false);
  const stdin = request.input === undefined ? undefined : JSON.stringify(request.input);
  if (stdin !== undefined && Buffer.byteLength(stdin) > 1024 * 1024)
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Structured execution input exceeds one MiB.');
  const inputs = unique([...(script ? [script] : []), ...request.input_paths, ...Object.keys(binding.preserved_hashes ?? {})]);
  const source = binding.payload_source;
  if (source && (typeof source.path !== 'string' || !/\.json$/i.test(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 0 || source.size_bytes > 1024 * 1024))
    throw new ControlledExecutionError('INVALID_EXECUTION', 'The backend prepared-source observation must name a bounded JSON file and its exact content identity.');
  if (source && privatePath(source.path))
    throw new ControlledExecutionError('PRIVATE_PATH', 'Prepared JSON data cannot come from private runtime, client, credential or dependency files.');
  if (unique([...inputs, ...(source ? [source.path] : [])]).length > 512)
    throw new ControlledExecutionError('INVALID_EXECUTION', 'The execution baseline exceeds 512 exact files.');
  const baseline = Object.fromEntries(inputs.map(path => [path, fingerprint(root, path, binding)!]));
  for (const [path, expected] of Object.entries(binding.preserved_hashes ?? {}))
    if (baseline[path] !== expected) throw new ControlledExecutionError('INPUT_CHANGED', 'An immutable preservation input changed before execution.');
  if (source) {
    const digest = fingerprint(root, source.path, binding)!, info = lstatSync(checkedPath(root, source.path, binding));
    if (info.nlink !== 1 || info.size !== source.size_bytes || digest !== source.sha256)
      throw new ControlledExecutionError('INPUT_CHANGED', 'Prepared JSON source changed before its backend-owned execution baseline was captured.');
    // Preserve original declared/preserved keys, while retaining the exact
    // private observation key even when Windows resolves a case variant.
    baseline[source.path] = digest;
  }
  const outputs = request.output_paths;
  const missing_parent_paths = missingOutputParents(root, outputs);
  const input_sha256 = stdin === undefined ? null : hash(stdin);
  return { request, cwd: resolve(root), executable, command, ...(script ? { script } : {}), baseline,
    output_baseline: Object.fromEntries(outputs.map(path => [path, null])), missing_parent_paths, input_sha256,
    payload_hash: hash(JSON.stringify({ cwd: resolve(root), request, command, baseline, missing_parent_paths, input_sha256, binding })),
    ...(stdin !== undefined ? { stdin } : {}), binding: structuredClone(binding) };
}

/**
 * Retain and roll back only the exact new files from an observed failed process.
 * The controller must retain the failed process result before calling this seam.
 * No worker-facing delete operation or recursive deletion is exposed.
 */
export function rollbackControlledExecutionOutputs(prepared: PreparedControlledExecution,
  execution: ControlledExecutionResult, archiveDirectory: string): ControlledExecutionRollback {
  const rollback: ControlledExecutionRollback = { complete: false, archived: [], removed_directories: [], uncertain_paths: [] };
  const uncertain = (path: string) => { if (!rollback.uncertain_paths.includes(path)) rollback.uncertain_paths.push(path); };
  const unchanged = () => Object.entries(prepared.baseline).every(([path, expected]) => {
    try { return fingerprint(prepared.cwd, path, prepared.binding) === expected; } catch { return false; }
  });
  const preparedHash = hash(JSON.stringify({ cwd: prepared.cwd, request: prepared.request, command: prepared.command,
    baseline: prepared.baseline, missing_parent_paths: prepared.missing_parent_paths,
    input_sha256: prepared.input_sha256, binding: prepared.binding }));
  if (execution.passed !== false || preparedHash !== prepared.payload_hash || execution.payload_hash !== prepared.payload_hash ||
      Object.keys(prepared.output_baseline).length !== prepared.request.output_paths.length ||
      Object.keys(prepared.output_baseline).some(path => !prepared.request.output_paths.includes(path)) ||
      JSON.stringify(execution.baseline) !== JSON.stringify(prepared.baseline) || execution.changed_inputs.length ||
      Object.entries(prepared.baseline).some(([path, value]) => execution.baseline_after[path] !== value) || !unchanged())
    return { ...rollback, reason: 'Rollback requires the exact failed process and unchanged execution inputs.' };
  // Archive destinations are internal, caller-owned paths, never model-provided output paths.
  if (!archiveDirectory.startsWith('.neomind/controlled/') || /[\\:\x00-\x1f]/.test(archiveDirectory) ||
      archiveDirectory.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)))
    return { ...rollback, reason: 'Rollback requires a canonical backend-owned controlled archive directory.' };
  const archiveTarget = (): string => {
    const target = safePath(prepared.cwd, archiveDirectory);
    let cursor = prepared.cwd;
    for (const part of archiveDirectory.split('/')) {
      cursor = resolve(cursor, part);
      if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory()))
        throw new Error('Archive ancestor is not an ordinary directory.');
    }
    return target;
  };
  const retain = (path: string, bytes: Buffer | string) => {
    archiveTarget();
    const target = safePath(prepared.cwd, path), buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== buffer.length || !readFileSync(target).equals(buffer))
        throw new Error('A retained rollback artifact changed.');
    } else writeFileSync(target, buffer, { flag: 'wx' });
  };
  const readRetained = (path: string): Buffer => {
    archiveTarget();
    const target = safePath(prepared.cwd, path), info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024)
      throw new Error('A retained rollback artifact is not a bounded ordinary file.');
    return readFileSync(target);
  };
  try { mkdirSync(archiveTarget(), { recursive: true }); }
  catch { return { ...rollback, reason: 'The private rollback archive could not be retained safely.' }; }
  for (const path of Object.keys(prepared.output_baseline)) {
    if (prepared.output_baseline[path] !== null) { uncertain(path); continue; }
    try {
      withOperationLock(prepared.cwd, workspacePathLockKey(path), () => {
        const target = checkedPath(prepared.cwd, path, prepared.binding, true), expected = execution.output_hashes[path];
        const prefix = `${archiveDirectory}/${hash(path)}`;
        const snapshotPath = `${prefix}.json`, completedPath = `${prefix}.removed.json`, archivePath = `${prefix}.bin`;
        if (existsSync(safePath(prepared.cwd, completedPath))) {
          const metadata = JSON.parse(readRetained(snapshotPath).toString('utf8'));
          const completion = JSON.parse(readRetained(completedPath).toString('utf8'));
          const retained = readRetained(archivePath);
          if (metadata.payload_hash !== prepared.payload_hash || metadata.path !== path || metadata.sha256 !== expected ||
              metadata.archive_path !== archivePath || metadata.bytes !== retained.length || completion.path !== path ||
              completion.payload_hash !== prepared.payload_hash || completion.sha256 !== expected || completion.removed !== true ||
              hash(retained) !== expected || existsSync(target)) {
            uncertain(path); return;
          }
          rollback.archived.push({ path, sha256: expected!, archive_path: archivePath, bytes: metadata.bytes, removed: true });
          return;
        }
        // A prior intent without its completion is uncertain; never replay deletion.
        if (existsSync(safePath(prepared.cwd, snapshotPath))) { uncertain(path); return; }
        if (!existsSync(target)) { if (expected !== null) uncertain(path); return; }
        if (!expected || !unchanged() || fingerprint(prepared.cwd, path, prepared.binding, false, true) !== expected) {
          uncertain(path); return;
        }
        const bytes = readFileSync(target);
        if (hash(bytes) !== expected) { uncertain(path); return; }
        retain(archivePath, bytes);
        retain(snapshotPath, JSON.stringify({ schema_version: 1, payload_hash: prepared.payload_hash, path,
          sha256: expected, bytes: bytes.length, archive_path: archivePath }, null, 2) + '\n');
        const archived = { path, sha256: expected, archive_path: archivePath, bytes: bytes.length, removed: false };
        rollback.archived.push(archived);
        // Cooperating workspace edits use the same lock. A fresh hash also protects direct user edits.
        if (!unchanged() || fingerprint(prepared.cwd, path, prepared.binding, false, true) !== expected) {
          uncertain(path); return;
        }
        unlinkSync(checkedPath(prepared.cwd, path, prepared.binding, true));
        archived.removed = true;
        retain(completedPath, JSON.stringify({ schema_version: 1, payload_hash: prepared.payload_hash,
          path, sha256: expected, removed: true }, null, 2) + '\n');
      });
    } catch { uncertain(path); }
  }
  if (!rollback.uncertain_paths.length && unchanged()) {
    for (const path of prepared.missing_parent_paths) {
      if (!Object.keys(prepared.output_baseline).some(output => covers(path, output))) { uncertain(path); continue; }
      try {
        withOperationLock(prepared.cwd, workspacePathLockKey(path), () => {
          const target = validateProcedurePath(prepared.cwd, path);
          if (!existsSync(target)) return;
          if (!unchanged() || privatePath(path) || !lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) {
            uncertain(path); return;
          }
          rmdirSync(target); // Empty directories only; any unexpected contents are preserved.
          rollback.removed_directories.push(path);
        });
      } catch { uncertain(path); }
    }
  }
  rollback.complete = !rollback.uncertain_paths.length && unchanged();
  if (!rollback.complete) rollback.reason = 'Some failed outputs or ancestors could not be safely restored to their initial absence; retained bytes and user changes are preserved.';
  return rollback;
}

/** A mediated host process, not an operating-system filesystem or network sandbox. */
export async function runControlledExecution(prepared: PreparedControlledExecution, options: {
  assertActive(): void | Promise<void>; signal?: AbortSignal; onStart?: (pid: number) => void;
  runner?: (input: CommandInput) => Promise<CommandResult>;
}): Promise<ControlledExecutionResult> {
  await options.assertActive();
  // Re-prepare immediately before start so changed files, links and output collisions fail closed.
  const current = prepareControlledExecution(prepared.cwd, prepared.binding, prepared.request);
  if (current.payload_hash !== prepared.payload_hash)
    throw new ControlledExecutionError('INPUT_CHANGED', 'Execution inputs or resolved executable changed before the owned process could start.');
  await options.assertActive();
  const result = await (options.runner ?? runCommand)({ command: current.command, cwd: current.cwd, stdin: current.stdin,
    timeout_ms: current.request.timeout_ms ?? 60000, max_output_bytes: current.request.max_output_bytes ?? 1024 * 1024,
    signal: options.signal, onStart: options.onStart });
  return finishControlledExecution(current, result);
}
/** Finalize only an actually observed or authenticated durable process result. */
export function finishControlledExecution(current: PreparedControlledExecution, result: CommandResult): ControlledExecutionResult {
  const after = (path: string, output = false): string | null => {
    try { return fingerprint(current.cwd, path, current.binding, true, output); } catch { return null; }
  };
  const baseline_after = Object.fromEntries(Object.keys(current.baseline).map(path => [path, after(path)]));
  const output_hashes = Object.fromEntries(Object.keys(current.output_baseline).map(path => [path, after(path, true)]));
  const changed_inputs = Object.keys(current.baseline).filter(path => baseline_after[path] !== current.baseline[path]);
  const missing_outputs = Object.keys(output_hashes).filter(path => output_hashes[path] === null);
  return { executable: current.executable, command: current.command, input_sha256: current.input_sha256,
    payload_hash: current.payload_hash, baseline: current.baseline, baseline_after, output_hashes,
    changed_inputs, missing_outputs, result,
    passed: result.exit_code === 0 && !result.cancelled && !result.timed_out && !result.output_limited && !result.error &&
      !changed_inputs.length && !missing_outputs.length };
}
