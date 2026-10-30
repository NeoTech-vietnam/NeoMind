import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureBaseline } from './baseline.js';
import { changedPaths } from './dirty-import.js';
import { buildReviewTree } from './review-tree.js';
const execFileAsync = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return env;
}
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args], { env: gitEnv(), maxBuffer: 256 * 1024 * 1024 })).stdout;

export interface RunChanges { tree: string; paths: string[]; patch: string; patchHash: string }

/** What a run changed in its worktree since `base` (a commit or tree), as a binary patch. */
export async function runChanges(workspace: string, base: string): Promise<RunChanges> {
  const baseline = await captureBaseline(workspace), { tree } = await buildReviewTree(workspace, baseline.baselineHash);
  const paths = await changedPaths(workspace, base, tree);
  const patch = paths.length ? await git(workspace, 'diff', '--binary', '--no-renames', '--full-index', base, tree) : '';
  return { tree, paths, patch, patchHash: createHash('sha256').update(patch).digest('hex') };
}

/**
 * Apply a run's patch to the user's checkout (working tree only; nothing is staged or committed). Refuses when a path
 * the run changed also has uncommitted changes in the checkout, or when the patch no longer applies cleanly.
 * Returns `already` when the checkout already contains exactly these changes (a retry after an interrupted apply).
 */
export async function applyToCheckout(checkout: string, changes: RunChanges): Promise<'applied' | 'already'> {
  if (!changes.patch) throw new Error('Run không có thay đổi để áp dụng');
  const directory = await mkdtemp(path.join(tmpdir(), 'neomind-apply-')), file = path.join(directory, 'run.patch');
  try {
    await writeFile(file, changes.patch);
    const tryGit = (...args: string[]) => git(checkout, ...args).then(() => true, () => false);
    if (await tryGit('apply', '--check', '--reverse', '--binary', file) && !await tryGit('apply', '--check', '--binary', file)) return 'already';
    const dirty = new Set((await captureBaseline(checkout)).entries.map(entry => entry.path));
    const overlap = changes.paths.filter(item => dirty.has(item));
    if (overlap.length) throw new Error(`Checkout đang có thay đổi chưa commit ở file run cũng sửa: ${overlap.join(', ')}. Commit hoặc cất (stash) chúng rồi áp dụng lại.`);
    if (!await tryGit('apply', '--check', '--binary', file)) throw new Error('Thay đổi của run không áp sạch vào checkout (checkout đã khác so với lúc run bắt đầu). Xem diff trong worktree của run và áp tay.');
    await git(checkout, 'apply', '--binary', file);
    return 'applied';
  } finally { await rm(directory, { recursive: true, force: true }); }
}
