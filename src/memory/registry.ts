import { lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { projectIdentity } from '../workspace/worktree.js';

/** Local shared registry. Both hosts must use the same registry/coordination DB. */
export class ProjectMemoryRegistry {
  private readonly db: DatabaseSync;
  constructor(readonly coordinationDatabase: string) {
    this.db = new DatabaseSync(coordinationDatabase);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS project_memory_root (project_id TEXT PRIMARY KEY, root TEXT NOT NULL)`);
  }
  close(): void { this.db.close(); }
  private checkedRoot(root: string): string {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Configured memory root must be a real directory');
    return realpathSync.native(root);
  }
  /** Configuration changes require an explicit caller action and compare the previous mapping. */
  set(workspace: string, root: string, expectedPrevious: string | null): void {
    const projectId = projectIdentity(workspace), canonical = this.checkedRoot(root);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT root FROM project_memory_root WHERE project_id = ?').get(projectId);
      const existing = row?.root ?? null;
      if (existing !== expectedPrevious) throw new Error('Project memory mapping conflict');
      this.db.prepare('INSERT INTO project_memory_root(project_id, root) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET root = excluded.root')
        .run(projectId, canonical);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  resolve(workspace: string): string | undefined {
    const row = this.db.prepare('SELECT root FROM project_memory_root WHERE project_id = ?').get(projectIdentity(workspace));
    if (!row) return undefined;
    if (typeof row.root !== 'string') throw new Error('Invalid memory mapping');
    // If unavailable, fail rather than silently creating a second root.
    const root = this.checkedRoot(row.root);
    if (root !== row.root) throw new Error('Configured memory root changed identity');
    return root;
  }
}
