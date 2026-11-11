import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureBaseline } from './baseline.js';
import { snapshotWorkspace } from './integration.js';
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

/** The commit `ref` points to, or undefined when it does not exist. */
export async function resolveRef(repo: string, ref: string): Promise<string | undefined> {
  return git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).then(output => output.trim(), () => undefined);
}
export async function refExists(repo: string, ref: string): Promise<boolean> { return !!await resolveRef(repo, ref); }

/** Ignored files are not part of a workspace snapshot, so removal loses them; treat them as unsaved unless explicitly discarded. */
export async function ignoredPaths(workspace: string): Promise<string[]> {
  const output = await git(workspace, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
  return output.split('\0').filter(Boolean).sort();
}

/** Delete every ref NeoMind kept for one run (`refs/neomind/<runId>/...`), so its snapshots stop holding commits. */
export async function deleteRunRefs(repo: string, runId: string): Promise<string[]> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(runId)) throw new Error('Invalid run id');
  const refs = (await git(repo, 'for-each-ref', '--format=%(refname)', `refs/neomind/${runId}/`)).split('\n').map(line => line.trim()).filter(Boolean);
  for (const ref of refs) await git(repo, 'update-ref', '-d', ref);
  return refs;
}

/** Write each ref to its commit (idempotent: an existing ref is moved to the same commit). */
export async function preserveRefs(repo: string, refs: PreservedRef[]): Promise<void> {
  for (const item of refs) {
    if (!/^refs\/neomind\/[A-Za-z0-9._/-]+$/.test(item.ref) || item.ref.includes('..')) throw new Error(`Invalid NeoMind ref: ${item.ref}`);
    await git(repo, 'update-ref', item.ref, item.commit);
  }
}

/**
 * Keep everything a worktree holds except ignored files (tracked and untracked, staged or not) as a commit on `ref`.
 * An existing ref is kept as is: after an interrupted removal the worktree may be half deleted, and the first
 * snapshot is the complete one. Restore with `git worktree add <dir> <ref>`.
 */
export async function snapshotBeforeRemoval(repo: string, workspace: string, ref: string): Promise<string | undefined> {
  const existing = await resolveRef(repo, ref);
  if (existing || !existsSync(workspace)) return existing;
  const baseline = await captureBaseline(workspace), commit = await snapshotWorkspace(workspace, baseline.baselineHash, baseline.head);
  await preserveRefs(repo, [{ ref, commit }]);
  return commit;
}

/**
 * Delete run worktrees and drop their Git registration. Callers snapshot them first, so a removal that stops halfway
 * (on Windows, a file another program holds open) loses nothing and is simply run again.
 */
export async function removeWorktrees(repo: string, workspaces: string[], workspacesDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const workspace of workspaces) {
    if (comparable(path.dirname(workspace)) !== comparable(workspacesDir)) throw new Error(`Không xóa ${workspace}: không phải worktree của run`);
    if (!existsSync(workspace)) continue;
    if ((await lstat(workspace)).isSymbolicLink()) throw new Error('Managed workspace cannot be a symlink');
    try { await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) {
      throw new Error(`Không xóa hết được worktree ${workspace}${process.platform === 'win32' ? ' (thường do một chương trình khác đang mở file trong đó)' : ''}: ${error instanceof Error ? error.message : String(error)}. Thay đổi đã được lưu trong ref snapshot; đóng chương trình đó rồi dọn lại.`);
    }
    removed.push(workspace);
  }
  await git(repo, 'worktree', 'prune');
  return removed;
}
