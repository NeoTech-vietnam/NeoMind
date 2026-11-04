import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureBaseline } from './baseline.js';
import { buildReviewTree } from './review-tree.js';
import { changedPaths } from './dirty-import.js';

/** Bounded source evidence from the exact reviewed tree, for reviewers whose tool access is unavailable. */
export async function collectReviewSources(workspace: string, baselineHash: string, from: string, extraPaths: string[] = []): Promise<string> {
  const root = await realpath(workspace), tree = await buildReviewTree(root, baselineHash), changed = await changedPaths(root, from, tree.tree);
  const files: unknown[] = []; let budget = 60000;
  for (const file of [...new Set([...extraPaths, ...changed])].slice(0, 30)) {
    const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const stat = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!stat) { files.push({ path: file, deleted: true }); continue; }
    if (!stat.isFile() || await realpath(absolute) !== absolute || stat.size > 256000) { files.push({ path: file, omitted: 'symlink, special file or size limit' }); continue; }
    const bytes = await readFile(absolute), sha256 = createHash('sha256').update(bytes).digest('hex');
    const content = bytes.includes(0) ? { bytes: bytes.length <= 2048 ? [...bytes] : undefined, size: bytes.length, sha256 }
      : { content: bytes.toString('utf8').slice(0, Math.min(16000, budget)), truncated: bytes.toString('utf8').length > Math.min(16000, budget), sha256 };
    const entry = { path: file, unchangedFromBase: !changed.includes(file), ...content }, size = JSON.stringify(entry).length;
    if (size > budget) continue;
    files.push(entry); budget -= size;
  }
  if ((await captureBaseline(root)).baselineHash !== baselineHash) throw new Error('Review source baseline changed');
  return JSON.stringify({ baselineHash, tree: tree.tree, files });
}
