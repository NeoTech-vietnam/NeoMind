import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureBaseline } from './baseline.js';
const execFileAsync = promisify(execFile);

/** Build a candidate Git tree without touching the user's index. Requires an isolated workspace lease externally. */
export async function buildReviewTree(workspace: string, expectedBaselineHash: string): Promise<{ head: string; tree: string; baselineHash: string }> {
  const before = await captureBaseline(workspace);
  if (before.baselineHash !== expectedBaselineHash) throw new Error('Workspace baseline changed before tree creation');
  const directory = await mkdtemp(path.join(tmpdir(), 'neomind-index-'));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index'), GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const git = async (...args: string[]) => (await execFileAsync('git', ['-C', workspace, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  try {
    await git('read-tree', before.head);
    await git('add', '--all', '--', '.');
    const tree = await git('write-tree');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw new Error('Git returned an invalid tree object ID');
    const after = await captureBaseline(workspace);
    if (after.baselineHash !== before.baselineHash) throw new Error('Workspace changed while creating review tree');
    return { head: before.head, tree, baselineHash: before.baselineHash };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/**
 * Unified diff from `from` (a commit or tree) to the reviewed tree of `workspace`, built by the core so reviewers without
 * a shell see exactly the changes under review. `undefined` when the diff exceeds `limit` characters.
 */
export async function reviewDiff(workspace: string, expectedBaselineHash: string, from: string, limit = 60000): Promise<string | undefined> {
  const review = await buildReviewTree(workspace, expectedBaselineHash);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const { stdout } = await execFileAsync('git', ['-C', workspace, '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-renames', '--no-ext-diff', from, review.tree], { env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.length > limit ? undefined : stdout;
}
