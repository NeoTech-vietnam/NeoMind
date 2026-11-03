import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return env;
}
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024 })).stdout;

/** A ref NeoMind writes before removing a worktree, so a commit that only the worktree's HEAD pointed to stays reachable. */
export interface PreservedRef { ref: string; commit: string }

const comparable = (file: string) => { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };

/** Worktrees Git has registered for the repository of `repo` (any of its worktrees). */
export async function registeredWorktrees(repo: string): Promise<Set<string>> {
  const listing = await git(repo, 'worktree', 'list', '--porcelain', '-z');
  return new Set(listing.split('\0').filter(line => line.startsWith('worktree ')).map(line => comparable(line.slice('worktree '.length))));
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  return git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).then(() => true, () => false);
}

/** Git force-removal also deletes ignored files; treat them as unsaved unless explicitly discarded. */
export async function ignoredPaths(workspace: string): Promise<string[]> {
  const output = await git(workspace, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
  return output.split('\0').filter(Boolean).sort();
}

/** Hash ignored entries without following symlinks, so a resumed forced cleanup cannot discard changed data. */
export async function ignoredFingerprint(workspace: string): Promise<string> {
  const hash = createHash('sha256'), root = path.resolve(workspace);
  async function visit(relative: string): Promise<void> {
    const absolute = path.resolve(root, relative), inside = path.relative(root, absolute);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Ignored path escapes workspace');
    const info = await lstat(absolute);
    hash.update(JSON.stringify([relative, info.mode, info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'special']));
    if (info.isSymbolicLink()) hash.update(JSON.stringify(await readlink(absolute)));
    else if (info.isDirectory()) for (const child of (await readdir(absolute)).sort()) await visit(path.join(relative, child));
    else if (info.isFile()) { const content = createHash('sha256'); for await (const chunk of createReadStream(absolute)) content.update(chunk as Buffer); hash.update(content.digest()); }
    else throw new Error(`Không dọn file đặc biệt bị ignore: ${relative}`);
  }
  for (const entry of await ignoredPaths(workspace)) await visit(entry);
  return hash.digest('hex');
}

/** Write each ref to its commit (idempotent: an existing ref is moved to the same commit). */
export async function preserveRefs(repo: string, refs: PreservedRef[]): Promise<void> {
  for (const item of refs) {
    if (!/^refs\/neomind\/[A-Za-z0-9._/-]+$/.test(item.ref) || item.ref.includes('..')) throw new Error(`Invalid NeoMind ref: ${item.ref}`);
    await git(repo, 'update-ref', item.ref, item.commit);
  }
}

/**
 * Remove run worktrees from `repo`. A registered worktree is removed through Git (with its uncommitted files: callers
 * decide beforehand whether anything there still matters); an unregistered leftover directory is deleted only when it
 * lies directly inside `workspacesDir`, NeoMind's own directory of run worktrees. Missing paths are skipped.
 */
export async function removeWorktrees(repo: string, workspaces: string[], workspacesDir: string): Promise<string[]> {
  const registered = await registeredWorktrees(repo), removed: string[] = [];
  for (const workspace of workspaces) {
    if (registered.has(comparable(workspace))) { await git(repo, 'worktree', 'remove', '--force', '--force', workspace); removed.push(workspace); continue; }
    if (!existsSync(workspace)) continue;
    if (comparable(path.dirname(workspace)) !== comparable(workspacesDir)) throw new Error(`Không xóa ${workspace}: không phải worktree của run`);
    await rm(workspace, { recursive: true, force: true }); removed.push(workspace);
  }
  await git(repo, 'worktree', 'prune');
  return removed;
}
