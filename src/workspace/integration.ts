import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureBaseline } from './baseline.js';
import { buildReviewTree } from './review-tree.js';
import { createDetachedWorktree, projectIdentity } from './worktree.js';
const execFileAsync = promisify(execFile);
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// Internal commits never touch user branches. Fixed identity and dates make them reproducible after a crash.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv, GIT_AUTHOR_NAME: 'NeoMind', GIT_AUTHOR_EMAIL: 'neomind@localhost',
    GIT_COMMITTER_NAME: 'NeoMind', GIT_COMMITTER_EMAIL: 'neomind@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return env;
}
async function git(root: string, args: string[], allowExit: number[] = [0]): Promise<{ stdout: string; code: number }> {
  try { return { stdout: (await execFileAsync('git', ['-C', root, ...args], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 60000 })).stdout, code: 0 }; }
  catch (error) {
    const failure = error as { code?: unknown; stdout?: string };
    if (typeof failure.code === 'number' && allowExit.includes(failure.code)) return { stdout: failure.stdout ?? '', code: failure.code };
    throw error;
  }
}
const oid = (value: string) => { const id = value.trim(); if (!objectId.test(id)) throw new Error('Git returned an invalid object ID'); return id; };

/** Create, or adopt after a crash, a clean detached worktree for one branch writer at the run's base commit. */
export async function prepareBranchWorktree(source: string, destination: string, baseCommit: string): Promise<string> {
  if (!existsSync(destination)) return createDetachedWorktree(source, destination, baseCommit).path;
  const workspace = await realpath(destination), baseline = await captureBaseline(workspace);
  if (projectIdentity(workspace) !== projectIdentity(source) || baseline.head !== baseCommit) throw new Error(`Branch workspace ${destination} belongs to another repository or commit`);
  return workspace;
}

/** Record a branch result as an internal commit on a run-private ref, from the exact completed baseline. */
export async function commitBranch(workspace: string, baselineHash: string, baseCommit: string, ref: string, message: string): Promise<{ commit: string; tree: string }> {
  if (!/^refs\/neomind\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) throw new Error('Invalid internal ref');
  const review = await buildReviewTree(workspace, baselineHash);
  if (review.head !== baseCommit) throw new Error('Branch workspace moved away from the run base');
  const commit = oid((await git(workspace, ['commit-tree', review.tree, '-p', baseCommit, '-m', message])).stdout);
  const existing = await git(workspace, ['rev-parse', '--verify', '--quiet', ref], [1]);
  if (existing.code === 0 && existing.stdout.trim() !== commit) throw new Error(`Internal ref ${ref} already points elsewhere`);
  if (existing.code !== 0) await git(workspace, ['update-ref', ref, commit, '']);
  return { commit, tree: review.tree };
}

/** Merge branch commits in order without touching any worktree. Conflicted files keep Git's markers in the result tree. */
export async function mergeBranchCommits(repository: string, commits: string[]): Promise<{ tree: string; conflicts: string[] }> {
  if (!commits.length || commits.some(item => !objectId.test(item))) throw new Error('Integration needs branch commits');
  let current = commits[0]!, tree = oid((await git(repository, ['rev-parse', `${current}^{tree}`])).stdout);
  const conflicts = new Set<string>();
  for (const next of commits.slice(1)) {
    const result = await git(repository, ['merge-tree', '--write-tree', '--name-only', '--no-messages', current, next], [1]);
    const [first, ...rest] = result.stdout.split('\n');
    tree = oid(first ?? '');
    if (result.code === 1) for (const line of rest) { if (!line.trim()) break; conflicts.add(line.trim()); }
    current = oid((await git(repository, ['commit-tree', tree, '-p', current, '-p', next, '-m', 'neomind integration'])).stdout);
  }
  return { tree, conflicts: [...conflicts].sort() };
}

/** Put a tree's content into a clean worktree as unstaged changes; the index stays at HEAD like an agent's edits. */
export async function applyTreeToWorkspace(workspace: string, baseCommit: string, tree: string): Promise<string> {
  const before = await captureBaseline(workspace);
  if (before.head !== baseCommit || !before.clean) throw new Error('Integration workspace must be clean at the run base');
  await git(workspace, ['read-tree', '-m', '-u', baseCommit, tree]);
  await git(workspace, ['read-tree', baseCommit]);
  return (await captureBaseline(workspace)).baselineHash;
}

/** Inspect an integration whose application was not journaled: not applied, applied exactly, or unknown. */
export async function inspectIntegration(workspace: string, baseCommit: string, tree: string): Promise<{ state: 'not_applied' } | { state: 'applied'; baselineHash: string } | { state: 'unknown' }> {
  const baseline = await captureBaseline(workspace);
  if (baseline.head !== baseCommit) return { state: 'unknown' };
  if (baseline.clean) return { state: 'not_applied' };
  return (await buildReviewTree(workspace, baseline.baselineHash)).tree === tree ? { state: 'applied', baselineHash: baseline.baselineHash } : { state: 'unknown' };
}

/** Files that still contain Git conflict markers. */
export async function filesWithConflictMarkers(workspace: string, paths: string[]): Promise<string[]> {
  const root = await realpath(workspace), remaining: string[] = [];
  for (const file of paths) {
    const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Conflict path escapes workspace');
    let text: string;
    try { text = await readFile(absolute, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (/^(?:<{7}|>{7})(?: |\r?$)/m.test(text) || /^\|{7}(?: |\r?$)/m.test(text)) remaining.push(file);
  }
  return remaining;
}
