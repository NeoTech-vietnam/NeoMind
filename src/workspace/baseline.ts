import { gitConfigEnv } from './git-env.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { hashJson } from '../domain/resolve.js';

export interface DirtyEntry {
  status: string;
  path: string;
  kind: 'file' | 'symlink' | 'missing';
  contentHash: string | null;
  mode: number | null;
}
export interface WorkspaceBaseline {
  root: string; head: string; statusHash: string; indexHash: string;
  entries: DirtyEntry[]; clean: boolean; baselineHash: string;
}

function digest(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function git(workspace: string, args: string[]): Buffer {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitConfigEnv };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[name];
  }
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: null, env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`);
  return result.stdout;
}

function decodeUtf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Git paths or metadata are not valid UTF-8'); }
}

function parseStatus(bytes: Buffer): { status: string; path: string }[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) throw new Error('Malformed Git status output');
  const entries = decodeUtf8(bytes).split('\0'); entries.pop();
  const result: { status: string; path: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Malformed Git status entry');
    const status = entry.slice(0, 2), name = entry.slice(3);
    result.push({ status, path: name });
    if (status.includes('R') || status.includes('C')) {
      const original = entries[++i];
      if (!original) throw new Error('Malformed Git rename entry');
      result.push({ status: 'original', path: original });
    }
  }
  return result;
}

async function inspect(root: string, entry: { status: string; path: string }): Promise<DirtyEntry> {
  const absolute = path.resolve(root, entry.path), relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Git path escapes workspace');
  try {
    const parent = await realpath(path.dirname(absolute));
    const parentRelative = path.relative(root, parent);
    if (parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) throw new Error('Git path parent escapes workspace');
    const before = await lstat(absolute, { bigint: true });
    if (before.isSymbolicLink()) {
      const target = await readlink(absolute);
      const after = await lstat(absolute, { bigint: true });
      if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Workspace changed while inspecting symlink');
      return { ...entry, kind: 'symlink', contentHash: digest(target), mode: Number(before.mode) };
    }
    if (!before.isFile()) throw new Error(`Unsupported dirty entry type: ${entry.path}`);
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('Workspace changed while opening file');
      const contents = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) throw new Error('Workspace changed while reading file');
      return { ...entry, kind: 'file', contentHash: digest(contents), mode: Number(opened.mode) };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...entry, kind: 'missing', contentHash: null, mode: null };
    throw error;
  }
}

/** Read-only Git snapshot; fails closed if status/index/HEAD change during capture. */
export async function captureBaseline(workspace: string): Promise<WorkspaceBaseline> {
  const topOutput = decodeUtf8(git(workspace, ['rev-parse', '--show-toplevel']));
  const top = topOutput.endsWith('\n') ? topOutput.slice(0, -1) : topOutput;
  const root = await realpath(top);
  const head = decodeUtf8(git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const index = git(root, ['ls-files', '--stage', '-z']);
  const entries: DirtyEntry[] = [];
  for (const entry of parseStatus(status)) entries.push(await inspect(root, entry));
  const laterHead = decodeUtf8(git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  const laterStatus = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const laterIndex = git(root, ['ls-files', '--stage', '-z']);
  if (head !== laterHead || !status.equals(laterStatus) || !index.equals(laterIndex)) throw new Error('Workspace changed while capturing baseline');
  const checkedEntries: DirtyEntry[] = [];
  for (const entry of parseStatus(laterStatus)) checkedEntries.push(await inspect(root, entry));
  if (hashJson(entries) !== hashJson(checkedEntries)) throw new Error('Workspace file content changed while capturing baseline');
  const fields = { root, head, statusHash: digest(status), indexHash: digest(index), entries, clean: entries.length === 0 };
  return { ...fields, baselineHash: hashJson(fields) };
}
