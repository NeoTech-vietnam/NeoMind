import { gitConfigEnv } from './git-env.js';
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

function git(root: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Primary worktree is the first worktree in Git's porcelain listing. */
export function primaryWorktree(workspace: string): string {
  const listing = git(realpathSync.native(workspace), ['worktree', 'list', '--porcelain', '-z']);
  const first = listing.split('\0')[0];
  if (!first?.startsWith('worktree ')) throw new Error('Cannot determine primary worktree');
  return realpathSync.native(first.slice('worktree '.length));
}

/** Creates a detached worktree at a caller-selected, currently nonexistent path.
 * Source dirty changes are not copied. On failure any partial worktree is retained for inspection. */
export function createDetachedWorktree(source: string, destination: string, commit: string): { path: string; commit: string } {
  const root = realpathSync.native(source);
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error('Expected a full Git commit object ID');
  const resolved = git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  if (resolved !== commit) throw new Error('Commit object ID mismatch');
  const absolute = path.resolve(destination), parent = realpathSync.native(path.dirname(absolute));
  const target = path.join(parent, path.basename(absolute));
  try { lstatSync(target); throw new Error('Worktree destination already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  git(root, ['worktree', 'add', '--detach', '--', target, commit]);
  return { path: realpathSync.native(target), commit: resolved };
}

/** Canonical Git common directory identifies a repository across linked worktrees. */
export function projectIdentity(workspace: string): string {
  const root = realpathSync.native(workspace);
  return realpathSync.native(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
}
