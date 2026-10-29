import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { primaryWorktree } from '../workspace/worktree.js';

/** Default shared root: the primary Git worktree, never the current linked worktree copy. */
export function resolveDefaultMemoryRoot(workspace: string): string {
  const project = primaryWorktree(workspace);
  const directory = path.join(project, '.neomind', 'memory');
  const metadata = path.join(project, '.neomind');
  const metadataInfo = lstatSync(metadata);
  if (metadataInfo.isSymbolicLink() || !metadataInfo.isDirectory()) throw new Error('Project metadata directory must be a real directory');
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Project memory root must be a real directory');
  return realpathSync.native(directory);
}
