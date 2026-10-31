import { accessSync, constants, realpathSync, statSync, readFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { hash, now, resourceRoot, readConfig } from './storage.js';
import { runCommand } from './command-runner.js';

export const controlledRuntimeQuerySchema = z.strictObject({
  executables: z.strictObject({ python: z.string().max(2048).optional(),
    c11: z.string().max(2048).optional(), cpp17: z.string().max(2048).optional() }).optional(),
});
export type ControlledRuntimeQuery = z.infer<typeof controlledRuntimeQuerySchema>;
export const controlledGuidePath = '.neomind/guides/controlled-workflows.md';
export const workforceGuidePath = '.workforce/guides/workforce.md';
function guideMetadata(bytes: Buffer, workforce = false) {
  return { path: workforce ? workforceGuidePath : controlledGuidePath, exists: true, source: 'trusted-installed-runtime',
    project_private_file_read: false, sha256: hash(bytes), size_bytes: bytes.length };
}

/** Context references the trusted guide without repeating its instructions. */
export function controlledRuntimeContextGuide(processContract?: string) {
  const workforce = processContract === 'workforce/v1';
  return guideMetadata(readFileSync(join(resourceRoot, workforce ? 'guides/workforce.md' : 'guides/controlled-workflows.md')), workforce);
}

/** A logical documentation resource, never a read through the project's private namespace. */
export function controlledRuntimeGuide(start = 1, maximum = 64000, processContract?: string) {
  const workforce = processContract === 'workforce/v1';
  const bytes = readFileSync(join(resourceRoot, workforce ? 'guides/workforce.md' : 'guides/controlled-workflows.md'));
  const excerpt = bytes.toString('utf8').split(/\r?\n/).slice(start - 1).join('\n');
  return { ...guideMetadata(bytes, workforce),
    start_line: start, text: excerpt.slice(0, maximum), truncated: excerpt.length > maximum };
}
const names = { node: ['node'], python: ['python3', 'python'], c11: ['gcc', 'clang'], cpp17: ['g++', 'clang++'] } as const;
type Program = keyof typeof names;
interface RejectedCandidate { path: string; code: string; reason: string }
export function legalProgram(program: Program, path: string): boolean {
  const name = basename(path).replace(/\.exe$/i, '').toLowerCase();
  if (program === 'node') return /^node(?:js)?$/.test(name);
  if (program === 'python') return /^python(?:3(?:\.\d+)*)?$/.test(name);
  return (program === 'c11' ? /^(?:[a-z0-9_]+-)*(?:gcc|clang)(?:-\d+(?:\.\d+)*)?$/
    : /^(?:[a-z0-9_]+-)*(?:g\+\+|clang\+\+)(?:-\d+(?:\.\d+)*)?$/).test(name);
}
function resolveCandidate(program: Program, path: string): { path: string } | { rejection: RejectedCandidate } {
  const rejected = (code: string, reason: string) => ({ rejection: { path, code, reason } });
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path))
    return rejected('INVALID_PATH', 'Use an existing absolute executable path without control characters.');
  if (!legalProgram(program, path))
    return rejected('WRONG_PROGRAM', 'The supplied executable is not the requested Python/C/C++ program type.');
  try {
    if (!statSync(path).isFile()) return rejected('NOT_EXECUTABLE', 'The supplied executable path is not an ordinary file.');
    accessSync(path, constants.X_OK);
    const actual = realpathSync(path);
    // LLVM commonly shares one binary between clang and clang++; argv[0]
    // selects the C++ driver, so retain the validated clang++ alias itself.
    const clangCppAlias = program === 'cpp17' &&
      /^clang\+\+(?:-\d+(?:\.\d+)*)?$/i.test(basename(path).replace(/\.exe$/i, '')) &&
      /^clang(?:-\d+(?:\.\d+)*)?$/i.test(basename(actual).replace(/\.exe$/i, ''));
    if (!legalProgram(program, actual) && !clangCppAlias)
      return rejected('WRONG_PROGRAM', 'The resolved executable is not the requested Python/C/C++ program type.');
    return { path: clangCppAlias ? resolve(path) : actual };
  } catch {
    return rejected('NOT_FOUND', 'The supplied executable was not found or is not executable.');
  }
}
function executable(program: Program, candidate?: string, installedToolchains = false): { path: string | null; rejected_candidate?: RejectedCandidate } {
  let rejected_candidate: RejectedCandidate | undefined;
  if (candidate !== undefined) {
    const checked = resolveCandidate(program, candidate);
    if ('path' in checked) return checked;
    rejected_candidate = checked.rejection;
  }
  if (program === 'node' && legalProgram(program, process.execPath)) {
    const checked = resolveCandidate(program, process.execPath);
    if ('path' in checked) return { ...checked, ...(rejected_candidate ? { rejected_candidate } : {}) };
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(path => path && isAbsolute(path))) for (const name of names[program]) {
    const checked = resolveCandidate(program, resolve(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`));
    if ('path' in checked) return { ...checked, ...(rejected_candidate ? { rejected_candidate } : {}) };
  }
  // VS Code can inherit a PATH older than an already-installed MSYS2 toolchain.
  // Observe only known compiler executables; never install or run a discovery shell.
  if (installedToolchains && process.platform === 'win32' && (program === 'c11' || program === 'cpp17')) {
    const drive = /^[a-z]:$/i.test(process.env.SystemDrive ?? '') ? process.env.SystemDrive! : 'C:';
    for (const distribution of ['ucrt64', 'mingw64', 'clang64']) for (const name of names[program]) {
      const checked = resolveCandidate(program, `${drive}/msys64/${distribution}/bin/${name}.exe`);
      if ('path' in checked) return { ...checked, ...(rejected_candidate ? { rejected_candidate } : {}) };
    }
  }
  return { path: null, ...(rejected_candidate ? { rejected_candidate } : {}) };
}

/** The same executable resolver used by runtime_context, without model-selected argv. */
export function controlledPythonExecutable(): string | null { return executable('python').path; }

/** Fixed version observations: no worker-supplied argv, environment or shell. */
export async function controlledToolchain(root: string, query: ControlledRuntimeQuery, signal?: AbortSignal) {
  let installedToolchains = false;
  try { installedToolchains = readConfig(root).execution_engine === 'opencode'; } catch { /* Historical uninitialized observations use PATH only. */ }
  const observations = await Promise.all((Object.keys(names) as Program[]).map(async program => {
    let diagnostic: { rejected_candidate?: RejectedCandidate } = {};
    try {
      const resolved = executable(program, program === 'node' ? undefined : query.executables?.[program], installedToolchains);
      diagnostic = resolved.rejected_candidate ? { rejected_candidate: resolved.rejected_candidate } : {};
      const path = resolved.path;
      if (!path) return { program, available: false, executable: null, ...diagnostic,
        reason: 'Not found on the enabled Bridge process PATH. An existing absolute executable may be supplied to runtime_context for a fixed --version observation.' };
      const result = await runCommand({ command: [path, '--version'], cwd: root, signal, timeout_ms: 5000, max_output_bytes: 4000 });
      return { program, available: result.exit_code === 0 && !result.cancelled && !result.timed_out && !result.output_limited && !result.error,
        executable: path, command: [path, '--version'], exit_code: result.exit_code, ...diagnostic,
        stdout: result.stdout, stderr: result.stderr, cancelled: result.cancelled, timed_out: result.timed_out,
        output_limited: result.output_limited, ...(result.error ? { reason: result.error } : {}) };
    } catch {
      return { program, available: false, executable: null, ...diagnostic,
        reason: 'This fixed toolchain observation could not complete. Other runtime context and program observations remain available.' };
    }
  }));
  return { observed_at: now(), date_utc: new Date().toISOString().slice(0, 10),
    local_date: new Intl.DateTimeFormat('en-GB').format(new Date()), observations };
}
