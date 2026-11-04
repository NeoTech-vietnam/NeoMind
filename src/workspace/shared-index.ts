import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gitConfigEnv } from './git-env.js';
import { runOnlyTree } from './dirty-import.js';
const execute = promisify(execFile);
export type SharedIndex = { before: string; after: string; ref: string };
function environment(index?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...gitConfigEnv, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE']) delete env[key];
  if (index) env.GIT_INDEX_FILE = index;
  return env;
}
const git = async (workspace: string, args: string[], index?: string) => (await execute('git', ['-C', workspace, ...args], { env: environment(index), maxBuffer: 64 * 1024 * 1024, timeout: 30000 })).stdout.trim();
export async function indexTreeOf(workspace: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'neomind-stage-'));
  try {
    const index = path.join(directory, 'index');
    const original = await git(workspace, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    await copyFile(original, index);
    return await git(workspace, ['write-tree'], index);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
/** Rebase the user's staged changes onto the run commit without consuming their staging. */
export async function prepareSharedIndex(workspace: string, parent: string, committedTree: string, includeExisting: boolean): Promise<SharedIndex> {
  const before = await indexTreeOf(workspace), ref = await git(workspace, ['symbolic-ref', '-q', 'HEAD']).catch(() => 'HEAD');
  const after = includeExisting ? committedTree : await runOnlyTree(workspace, committedTree, parent, before);
  if (!after) throw new Error('Staging của người dùng chồng lên commit; giữ nguyên index và chờ xử lý');
  return { before, after, ref };
}
/** Hold Git's index lock through the HEAD update and atomic index replacement. */
export async function withSharedIndex<T>(workspace: string, expected: SharedIndex, operation: () => Promise<T>): Promise<T> {
  const index = await git(workspace, ['rev-parse', '--path-format=absolute', '--git-path', 'index']), lock = `${index}.lock`;
  const directory = await mkdtemp(path.join(tmpdir(), 'neomind-commit-index-'));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    handle = await open(lock, 'wx', 0o600);
    const bytes = await readFile(index), candidate = path.join(directory, 'index');
    await copyFile(index, candidate);
    if (await git(workspace, ['write-tree'], candidate) !== expected.before) throw new Error('Staging changed before commit');
    const ref = await git(workspace, ['symbolic-ref', '-q', 'HEAD']).catch(() => 'HEAD');
    if (ref !== expected.ref) throw new Error('Checkout branch changed before commit');
    await git(workspace, ['read-tree', expected.after], candidate);
    if (hash(await readFile(index)) !== hash(bytes)) throw new Error('Index changed despite lock; retain workspace');
    const result = await operation();
    if (hash(await readFile(index)) !== hash(bytes)) throw new Error('Index changed during commit; retain workspace');
    await handle.close();
    await copyFile(candidate, lock); const synced = await open(lock, 'r+'); try { await synced.sync(); } finally { await synced.close(); }
    await rename(lock, index);
    return result;
  } finally { if (handle) { await handle.close().catch(() => {}); await rm(lock, { force: true }); } await rm(directory, { recursive: true, force: true }); }
}
