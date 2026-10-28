import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { controlledToolchain } from './controlled-runtime-context.js';
import { runCommand } from './command-runner.js';
import { canonicalJson } from './routing.js';
import { hash, now } from './storage.js';

export type WorkForcePrerequisiteKind = 'node' | 'python' | 'c11' | 'cpp17' | 'npm';
export interface WorkForcePrerequisite {
  schema_version: 1; kind: WorkForcePrerequisiteKind; executable: string; command_sha256: string; failure_sha256: string;
}
export interface WorkForcePrerequisiteObservation {
  schema_version: 1; ready: boolean; kind: WorkForcePrerequisiteKind; requested_executable: string; executable: string | null;
  observed_at: string; prerequisite_sha256: string; evidence_sha256: string; version_output_sha256?: string;
  exit_code?: number | null; reason?: string;
}
function program(value: string): WorkForcePrerequisiteKind | undefined {
  const name = basename(value.replaceAll('\\', '/')).replace(/\.(?:exe|cmd)$/i, '').toLowerCase();
  if (/^node(?:js)?$/.test(name)) return 'node';
  if (/^python(?:3(?:\.\d+)*)?$/.test(name)) return 'python';
  if (/^(?:[a-z0-9_]+-)*(?:gcc|clang)(?:-\d+(?:\.\d+)*)?$/.test(name)) return 'c11';
  if (/^(?:[a-z0-9_]+-)*(?:g\+\+|clang\+\+)(?:-\d+(?:\.\d+)*)?$/.test(name)) return 'cpp17';
  if (/^(?:npm|npx)$/.test(name)) return 'npm';
  return undefined;
}
/** The caller must supply a saved backend command and actual start/resolution
 * failure. Model prose alone is never a prerequisite restoration authority. */
export function deriveWorkForcePrerequisite(command: readonly string[], error: string | null | undefined): WorkForcePrerequisite | undefined {
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) ||
      typeof error !== 'string') return;
  const executable = command[0]!, kind = program(executable);
  if (!kind || !isAbsolute(executable) && executable !== basename(executable)) return;
  if (!/\b(?:ENOENT|EACCES|EPERM|NOT_FOUND|NOT_EXECUTABLE)\b/.test(error) &&
      !/^Not found on the enabled Bridge process PATH\./.test(error) &&
      !(kind === 'npm' && error === 'The installed Windows npm launcher could not be resolved without a shell.')) return;
  return { schema_version: 1, kind, executable, command_sha256: hash(canonicalJson(command)), failure_sha256: hash(error) };
}
function within(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return !local || !isAbsolute(local) && local !== '..' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}
function exactExecutable(root: string, requested: string, kind: WorkForcePrerequisiteKind): string | undefined {
  const environmentPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const suffixes = process.platform === 'win32' && !/\.(?:exe|cmd)$/i.test(requested) ? kind === 'npm' ? ['.cmd', '.exe', ''] : ['.exe', ''] : [''];
  const candidates = isAbsolute(requested) ? suffixes.map(suffix => requested + suffix) : environmentPath.split(delimiter)
    .filter(isAbsolute).flatMap(directory => suffixes.map(suffix => join(directory, requested + suffix)));
  for (const candidate of candidates) try {
    const physical = realpathSync.native(candidate);
    // A restoration probe never gains execution of a newly authored project
    // product merely because it was called gcc/python/node by its producer.
    if (within(root, physical) || !statSync(physical).isFile()) continue;
    accessSync(physical, constants.X_OK);
    const resolvedKind = program(physical);
    const npmCli = kind === 'npm' && /^(?:npm|npx)-cli\.js$/.test(basename(physical)) &&
      JSON.parse(readFileSync(join(dirname(physical), '../package.json'), 'utf8')).name === 'npm';
    if (resolvedKind !== kind && !npmCli && !(kind === 'cpp17' && resolvedKind === 'c11' && /^clang\+\+/i.test(basename(candidate)))) continue;
    return candidate;
  } catch { /* A missing exact command must not select another compiler class member. */ }
  return undefined;
}
const versionMatches = (kind: WorkForcePrerequisiteKind, text: string) => kind === 'node' ? /^v\d+\.\d+\.\d+/m.test(text)
  : kind === 'python' ? /\bPython\s+\d+\.\d+/i.test(text)
  : kind === 'npm' ? /^\d+\.\d+\.\d+(?:[-+][^\s]+)?\s*$/m.test(text)
  : /\b(?:gcc|g\+\+|clang|GNU|Free Software Foundation)\b/i.test(text);

/** Observe only a fixed --version of the exact saved known executable. The
 * successful observation is a prerequisite fact, never product/test evidence. */
export async function probeWorkForcePrerequisite(root: string, prerequisite: WorkForcePrerequisite,
  signal?: AbortSignal): Promise<WorkForcePrerequisiteObservation> {
  const prerequisiteHash = hash(canonicalJson(prerequisite)), base = { schema_version: 1 as const, kind: prerequisite.kind,
    requested_executable: prerequisite.executable, observed_at: now(), prerequisite_sha256: prerequisiteHash };
  const result = (value: { ready: boolean; executable: string | null; version_output_sha256?: string; exit_code?: number | null; reason?: string }): WorkForcePrerequisiteObservation =>
    ({ ...base, ...value, evidence_sha256: hash(canonicalJson({ prerequisite: prerequisiteHash, ...value })) });
  if (prerequisite.schema_version !== 1 || program(prerequisite.executable) !== prerequisite.kind ||
      ![prerequisite.command_sha256, prerequisite.failure_sha256].every(value => /^[a-f0-9]{64}$/.test(value)))
    return result({ ready: false, executable: null, reason: 'invalid-known-prerequisite' });
  signal?.throwIfAborted();
  root = realpathSync.native(resolve(root));
  const executable = exactExecutable(root, prerequisite.executable, prerequisite.kind);
  if (!executable) return result({ ready: false, executable: null, reason: 'exact-executable-unavailable' });
  try {
    let observed: { available: boolean; executable: string | null; stdout?: string; stderr?: string; exit_code?: number | null } | undefined;
    if (['python', 'c11', 'cpp17'].includes(prerequisite.kind)) {
      const query = { executables: { [prerequisite.kind]: executable } };
      const toolchain = await controlledToolchain(root, query, signal);
      observed = toolchain.observations.find(item => item.program === prerequisite.kind);
      if (!observed?.executable || realpathSync.native(observed.executable) !== realpathSync.native(executable))
        return result({ ready: false, executable: null, reason: 'exact-executable-was-not-observed' });
    } else {
      const executed = await runCommand({ command: [executable, '--version'], cwd: root, signal, timeout_ms: 5000, max_output_bytes: 4000 });
      observed = { available: executed.exit_code === 0 && !executed.cancelled && !executed.timed_out && !executed.output_limited && !executed.error,
        executable, stdout: executed.stdout, stderr: executed.stderr, exit_code: executed.exit_code };
    }
    signal?.throwIfAborted();
    const text = `${observed.stdout ?? ''}\n${observed.stderr ?? ''}`, ready = observed.available && versionMatches(prerequisite.kind, text);
    return result({ ready, executable, exit_code: observed.exit_code, version_output_sha256: hash(canonicalJson({ stdout: observed.stdout ?? '', stderr: observed.stderr ?? '' })),
      ...(ready ? {} : { reason: 'exact-version-observation-failed' }) });
  } catch (error) { signal?.throwIfAborted(); return result({ ready: false, executable, reason: 'fixed-version-probe-unavailable' }); }
}
