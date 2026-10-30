import { existsSync } from 'node:fs';
import path from 'node:path';

/** A worker must not attach itself to the parent desktop task's tool bridge. */
export function workerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete env[key];
  return env;
}

/**
 * Codex on Windows launches argv[0] without PATHEXT, so a bare `npm` fails while `npm.cmd` works. Resolve a bare
 * command name to its full path the way a shell would. Batch files expand `%VAR%`, so those arguments are refused.
 */
export function resolveHostCommand(argv: string[]): string[] {
  const [name, ...rest] = argv;
  if (process.platform !== 'win32' || !name || /[\\/:]/.test(name) || path.extname(name)) return argv;
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (!existsSync(candidate)) continue;
      if (/^\.(?:bat|cmd)$/i.test(extension) && rest.some(arg => /[%!^&|<>"]/.test(arg))) throw new Error(`Check arguments for ${name}${extension} cannot contain batch metacharacters`);
      return [candidate, ...rest];
    }
  }
  return argv;
}

/**
 * The Node executable for running an npm package entry. Inside Electron (a Nimbalyst backend module) `process.execPath`
 * is the app itself, so Node is taken from PATH instead.
 */
function nodeExecutable(): string {
  if (!process.versions.electron) return process.execPath;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = dir && path.join(dir, 'node.exe');
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('Codex is installed through npm but node.exe was not found on PATH');
}

/** Resolve Codex to an executable that can be launched without a shell: a native codex.exe, or Node running the npm package entry. */
export function resolveWindowsCodex(): { command: string; args: string[] } {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const native = path.join(dir, 'codex.exe');
    if (existsSync(native)) return { command: native, args: [] };
    const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(path.join(dir, 'codex.cmd')) && existsSync(entry)) return { command: nodeExecutable(), args: [entry] };
  }
  throw new Error('Codex CLI was not found on PATH');
}
