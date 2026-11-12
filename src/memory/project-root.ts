import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { primaryWorktree } from '../workspace/worktree.js';
import { projectDir } from '../storage/project-dir.js';
import { projectDirCreated } from '../storage/project-guide.js';

/** Where the default memory lives (`neomind/memory` of the primary worktree), whether or not it exists yet. */
export function defaultMemoryLocation(workspace: string): string {
  return path.join(projectDir(primaryWorktree(workspace)), 'memory');
}

/**
 * Default shared root: the primary Git worktree, never the current linked worktree copy. With `create`, a missing
 * folder is created (the first write of a project that never configured memory); otherwise it must already exist.
 */
export function resolveDefaultMemoryRoot(workspace: string, create = false): string {
  const directory = defaultMemoryLocation(workspace), metadata = path.dirname(directory);
  if (create) {
    for (const target of [metadata, directory]) {
      try { lstatSync(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(target); if (target === metadata) projectDirCreated(metadata);
      }
    }
  }
  const metadataInfo = lstatSync(metadata);
  if (metadataInfo.isSymbolicLink() || !metadataInfo.isDirectory()) throw new Error('Project metadata directory must be a real directory');
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Project memory root must be a real directory');
  return realpathSync.native(directory);
}
