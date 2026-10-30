import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
