import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { hash, now, resourceRoot } from './storage.js';
import { runCommand } from './command-runner.js';

export const controlledRuntimeQuerySchema = z.strictObject({
  executables: z.strictObject({ python: z.string().max(2048).optional(),
    c11: z.string().max(2048).optional(), cpp17: z.string().max(2048).optional() }).optional(),
});
export type ControlledRuntimeQuery = z.infer<typeof controlledRuntimeQuerySchema>;
export const controlledGuidePath = '.neomind/guides/controlled-workflows.md';

/** A logical documentation resource, never a read through the project's private namespace. */
export function controlledRuntimeGuide(start = 1, maximum = 64000) {
  const bytes = readFileSync(join(resourceRoot, 'guides/controlled-workflows.md'));
  const excerpt = bytes.toString('utf8').split(/\r?\n/).slice(start - 1).join('\n');
  return { path: controlledGuidePath, exists: true, source: 'trusted-installed-runtime',
    project_private_file_read: false, sha256: hash(bytes), size_bytes: bytes.length,
    start_line: start, text: excerpt.slice(0, maximum), truncated: excerpt.length > maximum };
}
const names = { node: ['node'], python: ['python3', 'python'], c11: ['gcc', 'clang'], cpp17: ['g++', 'clang++'] } as const;
type Program = keyof typeof names;
function executable(program: Program, candidate?: string): string | null {
  if (program === 'node' && /^node(?:\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
  const legal = (path: string) => {
    const name = basename(path).replace(/\.exe$/i, '');
    return names[program].some(allowed => name.toLowerCase() === allowed || program === 'python' && /^python3(?:\.\d+)?$/i.test(name));
  };
  const ordinary = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
  if (candidate) {
    if (!isAbsolute(candidate) || !legal(candidate) || !ordinary(candidate)) throw new Error('Use an existing absolute Python/C/C++ compiler executable path for this observation.');
    return realpathSync(candidate);
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) for (const name of names[program]) {
    const path = resolve(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(path) && ordinary(path)) return realpathSync(path);
  }
  return null;
}

/** Fixed version observations: no worker-supplied argv, environment or shell. */
export async function controlledToolchain(root: string, query: ControlledRuntimeQuery, signal?: AbortSignal) {
  const observations = await Promise.all((Object.keys(names) as Program[]).map(async program => {
    const path = executable(program, program === 'node' ? undefined : query.executables?.[program]);
    if (!path) return { program, available: false, executable: null,
      reason: 'Not found on the enabled Bridge process PATH. An existing absolute executable may be supplied to runtime_context for a fixed --version observation.' };
    const result = await runCommand({ command: [path, '--version'], cwd: root, signal, timeout_ms: 5000, max_output_bytes: 4000 });
    return { program, available: result.exit_code === 0 && !result.cancelled && !result.timed_out && !result.error,
      executable: path, command: [path, '--version'], exit_code: result.exit_code,
      stdout: result.stdout, stderr: result.stderr, cancelled: result.cancelled, timed_out: result.timed_out };
  }));
  return { observed_at: now(), date_utc: new Date().toISOString().slice(0, 10),
    local_date: new Intl.DateTimeFormat('en-GB').format(new Date()), observations };
}
