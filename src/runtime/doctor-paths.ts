import { existsSync, readdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashJson } from '../domain/resolve.js';
import { stateBase } from '../platform/state-dir.js';
import { primaryWorktree, projectIdentity } from '../workspace/worktree.js';
import { defaultMemoryLocation } from '../memory/project-root.js';
import { feedbackFiles } from '../memory/feedback.js';
import { inspectMemoryIndex } from '../memory/index-cache.js';

const entries = (directory: string) => { try { return readdirSync(directory); } catch { return undefined; } };

/**
 * The memory root configured for this project in the coordination database, read without writing: a read-only SQLite
 * connection to a WAL database leaves `-wal`/`-shm` files behind, so a database without a WAL file is opened immutable.
 */
function configuredMemoryRoot(database: string, projectId: string): { root?: string; error?: string } {
  if (!existsSync(database)) return {};
  const target = pathToFileURL(database);
  if (!existsSync(`${database}-wal`)) target.searchParams.set('immutable', '1');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_memory_root'").get()) return {};
    const row = db.prepare('SELECT root FROM project_memory_root WHERE project_id = ?').get(projectId);
    return typeof row?.root === 'string' ? { root: row.root } : {};
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  finally { db?.close(); }
}

/**
 * Where everything of one project lives on this machine and in the repository, and whether it is in Git: per-machine state
 * (coordination database, run journals, run worktrees) and the memory root with its ratings and rebuildable cache.
 * Creates, migrates and rebuilds nothing; `stateRoot` defaults to the one `RunManager.open` would use.
 */
export async function doctorPaths(projectRoot: string, stateRoot?: string) {
  const project = await realpath(projectRoot), projectId = projectIdentity(project);
  const state = stateRoot ?? path.join(stateBase(), 'neomind', hashJson(projectId));
  const coordination = path.join(state, 'coordination.sqlite'), runs = path.join(state, 'runs'), workspaces = path.join(state, 'workspaces');
  const configured = configuredMemoryRoot(coordination, projectId), fallback = defaultMemoryLocation(project);
  const root = configured.root ?? fallback, relative = path.relative(primaryWorktree(project), root);
  // Memory is in Git when it sits in the primary worktree (the default `neomind/memory`, or a configured folder there).
  const inGit = !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  let feedback: string[] | { error: string } = [];
  try { feedback = existsSync(root) ? feedbackFiles(root).map(file => path.basename(file)) : []; }
  catch (error) { feedback = { error: error instanceof Error ? error.message : String(error) }; }
  return {
    project,
    state: { directory: state, exists: existsSync(state), inGit: false },
    coordinationDatabase: { file: coordination, exists: existsSync(coordination), inGit: false,
      holds: 'run ownership, workspace writers, counters, project memory root, memory usage counts' },
    journals: { directory: runs, runs: entries(runs)?.length ?? 0, inGit: false },
    worktrees: { directory: workspaces, entries: entries(workspaces) ?? [], inGit: false },
    memory: {
      root, configured: !!configured.root, ...(configured.error ? { configurationError: configured.error } : {}), exists: existsSync(root),
      inGit, feedback: { directory: path.join(root, 'feedback'), files: feedback, inGit },
      cache: { ...inspectMemoryIndex(root), inGit: false },
    },
  };
}
