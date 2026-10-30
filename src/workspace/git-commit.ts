import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { WorkspaceCoordinator, type WorkspaceLease } from '../storage/coordination.js';
import { captureBaseline } from './baseline.js';
import { buildReviewTree } from './review-tree.js';
import { primaryWorktree } from './worktree.js';
const execFileAsync = promisify(execFile);
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export class GitCommitOutcomeUnknown extends Error { constructor(message: string) { super(message); this.name = 'GitCommitOutcomeUnknown'; } }
export interface CommitReceipt { commit: string; parent: string; tree: string; baselineHash: string }

/**
 * Commit an already-reviewed tree in an isolated detached worktree. Git hooks are not invoked;
 * callers must perform required checks independently. Journal intent must be durable beforehand.
 */
export async function commitReviewedTree(input: { workspace: string; lease: WorkspaceLease; coordinator: WorkspaceCoordinator;
  expectedParent: string; expectedTree: string; baselineHash: string; message: string; signal?: AbortSignal;
  /** Reviewed workspace tree when the commit holds only part of it (imported uncommitted changes stay out). */
  workspaceTree?: string }): Promise<CommitReceipt> {
  const root = await realpath(input.workspace);
  if (root !== input.lease.workspace || !input.coordinator.isCurrent(input.lease)) throw new Error('Workspace writer lease is stale');
  if (root === primaryWorktree(root)) throw new Error('Commit requires a separate worktree');
  if (!objectId.test(input.expectedParent) || !objectId.test(input.expectedTree) || (input.workspaceTree !== undefined && !objectId.test(input.workspaceTree)) || !input.message.trim()) throw new Error('Invalid commit inputs');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const git = async (...args: string[]) => {
    input.signal?.throwIfAborted();
    return (await execFileAsync('git', ['-C', root, ...args], { env, maxBuffer: 64 * 1024 * 1024, timeout: 30000, ...(input.signal ? { signal: input.signal } : {}) })).stdout.trim();
  };
  if (await git('rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD') throw new Error('Commit requires detached HEAD');
  if (await git('diff', '--cached', '--name-only') !== '') throw new Error('Index contains staged changes');
  const review = await buildReviewTree(root, input.baselineHash);
  if (review.head !== input.expectedParent || review.tree !== (input.workspaceTree ?? input.expectedTree)) throw new Error('Reviewed tree or parent changed');
  if (!input.coordinator.isCurrent(input.lease)) throw new Error('Workspace writer lease is stale');
  const commit = await git('commit-tree', input.expectedTree, '-p', input.expectedParent, '-m', input.message);
  if (!objectId.test(commit)) throw new Error('Git returned an invalid commit object ID');
  if ((await captureBaseline(root)).baselineHash !== input.baselineHash || await git('diff', '--cached', '--name-only') !== '') throw new Error('Workspace or index changed before commit');
  if (!input.coordinator.isCurrent(input.lease)) throw new Error('Workspace writer lease is stale');
  // After this point, a failure may have changed HEAD and must be reconciled before retrying.
  try {
    await git('update-ref', 'HEAD', commit, input.expectedParent);
    await git('read-tree', input.expectedTree);
    if (await git('rev-parse', 'HEAD') !== commit || await git('rev-parse', `${commit}^{tree}`) !== input.expectedTree) throw new Error('Commit verification failed');
  } catch { throw new GitCommitOutcomeUnknown('Commit outcome may have changed; inspect Git before retrying'); }
  return { commit, parent: input.expectedParent, tree: input.expectedTree, baselineHash: input.baselineHash };
}

/** Read-only reconciliation; it never retries or changes refs/index. */
export async function inspectCommitOutcome(input: { workspace: string; lease: WorkspaceLease; coordinator: WorkspaceCoordinator;
  expectedParent: string; expectedTree: string; baselineHash: string; workspaceTree?: string }): Promise<{ state: 'not_applied' | 'unknown' } | { state: 'applied'; receipt: CommitReceipt }> {
  const root = await realpath(input.workspace);
  if (root !== input.lease.workspace || !input.coordinator.isCurrent(input.lease)) throw new Error('Workspace writer lease is stale');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const git = async (...args: string[]) => (await execFileAsync('git', ['-C', root, ...args], { env, maxBuffer: 64 * 1024 * 1024, timeout: 10000 })).stdout.trim();
  const head = await git('rev-parse', 'HEAD');
  if (head === input.expectedParent) return { state: 'not_applied' };
  const parents = (await git('rev-list', '--parents', '-n', '1', head)).split(' ');
  const tree = await git('rev-parse', `${head}^{tree}`);
  if (parents.length !== 2 || parents[1] !== input.expectedParent || tree !== input.expectedTree) return { state: 'unknown' };
  const baseline = await captureBaseline(root);
  if (baseline.head !== head || !input.coordinator.isCurrent(input.lease)) return { state: 'unknown' };
  // A partial commit leaves the excluded changes in the worktree; otherwise the worktree must be clean.
  const partial = input.workspaceTree !== undefined && input.workspaceTree !== input.expectedTree;
  if (partial ? (await buildReviewTree(root, baseline.baselineHash)).tree !== input.workspaceTree : !baseline.clean) return { state: 'unknown' };
  return { state: 'applied', receipt: { commit: head, parent: input.expectedParent, tree, baselineHash: input.baselineHash } };
}
