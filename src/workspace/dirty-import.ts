import { gitConfigEnv } from './git-env.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureBaseline, type WorkspaceBaseline } from './baseline.js';
import { buildReviewTree } from './review-tree.js';
import { isProjectMetadataPath } from '../storage/project-dir.js';
const execFileAsync = promisify(execFile);
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface DirtyImportPlan { baselineHash: string; changes: { path: string; change: 'modified' | 'added' | 'deleted' }[]; refused: string[] }

/** NeoMind's own project metadata is configuration, never task input. */
const excluded = isProjectMetadataPath;

/** What importing the checkout's uncommitted changes would copy; `refused` lists entries that cannot be imported safely. */
export function planDirtyImport(source: WorkspaceBaseline): DirtyImportPlan {
  const changes: DirtyImportPlan['changes'] = [], refused: string[] = [];
  for (const entry of source.entries) {
    if (excluded(entry.path)) continue;
    if (entry.kind === 'symlink') { refused.push(entry.path); continue; }
    changes.push({ path: entry.path, change: entry.kind === 'missing' ? 'deleted' : entry.status === '??' || entry.status.includes('A') ? 'added' : 'modified' });
  }
  return { baselineHash: source.baselineHash, changes, refused };
}

/**
 * Copy the confirmed uncommitted state of `source` into a fresh worktree at the same HEAD. The source must still match the
 * confirmed baseline afterwards; the source checkout, its index and its staging are never modified.
 */
export async function importDirtyChanges(source: string, worktree: string, confirmedBaselineHash: string): Promise<{ paths: string[]; tree: string; baselineHash: string }> {
  const before = await captureBaseline(source), target = await captureBaseline(worktree);
  if (before.baselineHash !== confirmedBaselineHash) throw new Error('Thay đổi chưa commit ở checkout đã khác so với lúc xác nhận; xem lại preview');
  if (target.head !== before.head || !target.clean) throw new Error('Run worktree must be clean at the source HEAD before import');
  const plan = planDirtyImport(before);
  if (plan.refused.length) throw new Error(`Không thể mang symlink vào run: ${plan.refused.join(', ')}`);
  const expected = new Map(before.entries.filter(entry => !excluded(entry.path)).map(entry => [entry.path, entry]));
  for (const [file, entry] of expected) {
    const from = path.join(before.root, file), to = path.join(target.root, file);
    if (entry.kind === 'missing') { await rm(to, { force: true }); continue; }
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    if (process.platform !== 'win32' && entry.mode !== null) await chmod(to, entry.mode & 0o777);
  }
  for (const [file, entry] of expected) {
    const content = entry.kind === 'missing' ? null : createHash('sha256').update(await readFile(path.join(target.root, file))).digest('hex');
    if (content !== entry.contentHash) throw new Error(`Imported content does not match the checkout: ${file}`);
  }
  if ((await captureBaseline(source)).baselineHash !== confirmedBaselineHash) throw new Error('Checkout changed while importing; the run worktree keeps a partial copy for inspection');
  const after = await captureBaseline(worktree), tree = (await buildReviewTree(worktree, after.baselineHash)).tree;
  return { paths: [...expected.keys()].sort(), tree, baselineHash: after.baselineHash };
}

function gitEnv(index?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv, ...(index ? { GIT_INDEX_FILE: index } : {}) };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', ...(index ? [] : ['GIT_INDEX_FILE']), 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return env;
}

export async function treeOf(workspace: string, commit: string): Promise<string> {
  const tree = (await execFileAsync('git', ['-C', workspace, 'rev-parse', `${commit}^{tree}`], { env: gitEnv() })).stdout.trim();
  if (!objectId.test(tree)) throw new Error('Git returned an invalid tree object ID');
  return tree;
}

/** Paths whose content differs between two trees. */
export async function changedPaths(workspace: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', workspace, 'diff-tree', '-r', '--no-renames', '--name-only', '-z', from, to], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\0').filter(Boolean);
}

/**
 * The run's own changes on top of HEAD: the diff from the imported tree to the reviewed tree, applied to HEAD in a private
 * index. Returns undefined when that diff does not apply to HEAD because it overlaps the imported changes.
 */
export async function runOnlyTree(workspace: string, head: string, importedTree: string, reviewedTree: string): Promise<string | undefined> {
  if (![head, importedTree, reviewedTree].every(item => objectId.test(item))) throw new Error('Invalid tree inputs');
  const directory = await mkdtemp(path.join(tmpdir(), 'neomind-attribution-')), index = path.join(directory, 'index'), patch = path.join(directory, 'run.patch');
  const git = async (...args: string[]) => (await execFileAsync('git', ['-C', workspace, ...args], { env: gitEnv(index), maxBuffer: 64 * 1024 * 1024 })).stdout;
  try {
    const diff = await git('diff', '--binary', '--no-renames', '--full-index', importedTree, reviewedTree);
    if (!diff) return (await git('rev-parse', `${head}^{tree}`)).trim();
    await writeFile(patch, diff);
    await git('read-tree', head);
    try { await git('apply', '--cached', '--whitespace=nowarn', patch); } catch { return undefined; }
    const tree = (await git('write-tree')).trim();
    if (!objectId.test(tree)) throw new Error('Git returned an invalid tree object ID');
    return tree;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
