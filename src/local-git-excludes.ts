import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { retryWindowsFileOperation } from './storage.js';

const localPatterns = [
  '.neomind/',
  '.github/agents/neomind-*.agent.md',
  '.github/agents/neomind-*.agent.md.neomind-update*',
  '.github/hooks/neomind.json',
  '.github/hooks/neomind.json.neomind-update*',
  '.github/skills/neomind-*/',
  '.github/instructions/neomind.instructions.md',
  '.github/instructions/neomind.instructions.md.neomind-update*',
];

interface LocalGitExclusions {
  path?: string;
  changed: boolean;
  warning?: string;
}

function outside(path: string): boolean {
  return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
}

/** Keep a nested project's directory name literal in Git ignore patterns. */
function literalDirectory(path: string): string {
  return path.split(sep).join('/').replace(/[\\*?\[\]#! ]/g, '\\$&');
}

function entry(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Only local Git metadata is changed; existing author rules retain precedence. */
export function ensureLocalGitExclusions(root: string): LocalGitExclusions {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-path', 'info/exclude'], {
    encoding: 'utf8', env: environment, windowsHide: true, timeout: 5000, maxBuffer: 65536,
  });
  if (git.error || git.status !== 0)
    return { changed: false, warning: 'NeoMind local Git exclusions were not installed: Git is unavailable or the project is not in an accessible Git working tree. No repository was initialized.' };
  const paths = git.stdout.trimEnd().split(/\r?\n/);
  if (paths.length !== 3 || paths.some(path => !isAbsolute(path)))
    return { changed: false, warning: 'NeoMind local Git exclusions were not installed: Git returned unsupported repository paths.' };
  const [top, common, gitExclude] = paths as [string, string, string];
  let lock: number | undefined;
  let lockPath: string | undefined;
  let temporary: string | undefined;
  let outcome: LocalGitExclusions = { changed: false };
  try {
    // The native Windows resolver expands 8.3 names (for example RUNNER~1),
    // matching Git's expanded paths before applying the containment check.
    const projectDirectory = relative(realpathSync.native(top), realpathSync.native(root));
    if (outside(projectDirectory) || relative(resolve(common), resolve(gitExclude)).replaceAll('\\', '/') !== 'info/exclude')
      throw new Error('Git metadata does not belong to the selected working tree.');
    const directory = join(realpathSync.native(common), 'info');
    if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()))
      throw new Error('Git info directory is not a regular directory.');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'exclude');
    lockPath = `${path}.neomind.lock`;
    const deadline = Date.now() + 2000;
    while (lock === undefined) {
      try { lock = openSync(lockPath, 'wx'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
    const initial = entry(path);
    if (initial && (!initial.isFile() || initial.isSymbolicLink()))
      throw new Error('Git exclude is not a regular file.');
    const previous = initial ? readFileSync(path) : Buffer.alloc(0);
    const bomLength = previous.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
    const body = previous.subarray(bomLength);
    const source = body.toString('utf8');
    const existing = new Set(source.split(/\r?\n/));
    const prefix = projectDirectory ? `${literalDirectory(projectDirectory)}/` : '';
    const missing = localPatterns.map(pattern => `/${prefix}${pattern}`).filter(pattern => !existing.has(pattern));
    if (!missing.length) {
      outcome = { path, changed: false };
      return outcome;
    }
    const eol = /\r?\n/.exec(source)?.[0] ?? '\n';
    const addition = Buffer.from(['# NeoMind local installation: generated files', ...missing, '', ''].join(eol));
    const next = Buffer.concat([previous.subarray(0, bomLength), addition, body]);
    temporary = `${path}.${randomUUID()}.neomind.tmp`;
    writeFileSync(temporary, next, { flag: 'wx', mode: initial ? initial.mode & 0o777 : 0o666 });
    // A user's editor need not honor our lock. Never replace a changed baseline.
    const current = entry(path);
    if (initial ? (!current?.isFile() || current.isSymbolicLink() || !readFileSync(path).equals(previous)) : current !== undefined)
      throw new Error('Git exclusions changed during installation; retry the update.');
    retryWindowsFileOperation(() => renameSync(temporary!, path));
    temporary = undefined;
    outcome = { path, changed: true };
    return outcome;
  } catch {
    outcome = { changed: false, warning: 'NeoMind local Git exclusions could not be updated safely. Existing exclusions were preserved; inspect Git metadata, permissions or exclude.neomind.lock, then retry neomind update.' };
    return outcome;
  } finally {
    let cleanupFailed = false;
    const removeOwned = (path: string) => {
      try { retryWindowsFileOperation(() => unlinkSync(path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailed = true; }
    };
    if (temporary) removeOwned(temporary);
    if (lock !== undefined) {
      try { closeSync(lock); } catch { cleanupFailed = true; }
      if (lockPath) removeOwned(lockPath);
    }
    if (cleanupFailed) outcome.warning = `${outcome.warning ? `${outcome.warning} ` : ''}Temporary Git-exclusion cleanup did not finish; inspect the Git metadata before retrying.`;
  }
}
