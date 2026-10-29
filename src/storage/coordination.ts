import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';

export interface RunOwnerLease { runId: string; hostId: string; fence: number }

export interface WorkspaceLease { workspace: string; runId: string; hostId: string; fence: number }

/**
 * SQLite-backed local writer ownership. No lease timeout is used: a crashed
 * scheduler does not prove its workers have stopped. The caller is responsible
 * for verifying runtime stop before releasing a lease. This is not an OS sandbox.
 */
export class WorkspaceCoordinator {
  private readonly database: DatabaseSync;
  constructor(file: string) {
    this.database = new DatabaseSync(file);
    this.database.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counter(id, value) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS run_owner (
        run_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, fence INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS workspace_writer (
        workspace TEXT PRIMARY KEY, run_id TEXT NOT NULL, host_id TEXT NOT NULL,
        fence INTEGER NOT NULL UNIQUE, quarantined INTEGER NOT NULL DEFAULT 0
      );`);
  }

  /** Ownership does not expire automatically. Recovery must confirm the old scheduler stopped. */
  acquireRun(runId: string, hostId: string): RunOwnerLease {
    if (!runId || !hostId) throw new Error('runId and hostId are required');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.database.prepare('SELECT run_id FROM run_owner WHERE run_id = ?').get(runId)) throw new Error('Run already has an owner');
      this.database.exec('UPDATE counter SET value = value + 1 WHERE id = 1');
      const fence = Number(this.database.prepare('SELECT value FROM counter WHERE id = 1').get()?.value);
      if (!Number.isSafeInteger(fence)) throw new Error('Invalid fencing counter');
      this.database.prepare('INSERT INTO run_owner(run_id, host_id, fence) VALUES (?, ?, ?)').run(runId, hostId, fence);
      this.database.exec('COMMIT');
      return { runId, hostId, fence };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  /** Inspect a retained owner to support explicit recovery after verifying scheduler exit. */
  getRunOwner(runId: string): RunOwnerLease | undefined {
    const row = this.database.prepare('SELECT host_id, fence FROM run_owner WHERE run_id = ?').get(runId);
    if (!row) return undefined;
    const fence = Number(row.fence);
    if (typeof row.host_id !== 'string' || !Number.isSafeInteger(fence)) throw new Error('Invalid stored run owner');
    return { runId, hostId: row.host_id, fence };
  }

  isRunOwner(lease: RunOwnerLease): boolean {
    return !!this.database.prepare('SELECT run_id FROM run_owner WHERE run_id = ? AND host_id = ? AND fence = ?')
      .get(lease.runId, lease.hostId, lease.fence);
  }

  /** The caller must verify the prior scheduler has stopped; this says nothing about its workers. */
  releaseRun(lease: RunOwnerLease, schedulerConfirmedStopped: boolean): void {
    if (!schedulerConfirmedStopped) throw new Error('Cannot release run ownership while scheduler stop is unconfirmed');
    const result = this.database.prepare('DELETE FROM run_owner WHERE run_id = ? AND host_id = ? AND fence = ?')
      .run(lease.runId, lease.hostId, lease.fence);
    if (Number(result.changes) !== 1) throw new Error('Stale run owner lease');
  }

  acquire(workspace: string, runId: string, hostId: string): WorkspaceLease {
    if (!runId || !hostId) throw new Error('runId and hostId are required');
    const canonical = realpathSync.native(workspace);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const held = this.database.prepare('SELECT run_id FROM workspace_writer WHERE workspace = ?').get(canonical);
      if (held) throw new Error('Workspace already has a writer');
      this.database.exec('UPDATE counter SET value = value + 1 WHERE id = 1');
      const row = this.database.prepare('SELECT value FROM counter WHERE id = 1').get();
      const fence = Number(row?.value);
      if (!Number.isSafeInteger(fence)) throw new Error('Invalid fencing counter');
      this.database.prepare('INSERT INTO workspace_writer(workspace, run_id, host_id, fence) VALUES (?, ?, ?, ?)')
        .run(canonical, runId, hostId, fence);
      this.database.exec('COMMIT');
      return { workspace: canonical, runId, hostId, fence };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  isCurrent(lease: WorkspaceLease): boolean {
    const row = this.database.prepare('SELECT quarantined FROM workspace_writer WHERE workspace = ? AND run_id = ? AND host_id = ? AND fence = ?')
      .get(lease.workspace, lease.runId, lease.hostId, lease.fence);
    return !!row && row.quarantined === 0;
  }

  quarantine(lease: WorkspaceLease): void {
    const result = this.database.prepare('UPDATE workspace_writer SET quarantined = 1 WHERE workspace = ? AND run_id = ? AND host_id = ? AND fence = ?')
      .run(lease.workspace, lease.runId, lease.hostId, lease.fence);
    if (Number(result.changes) !== 1) throw new Error('Stale workspace lease');
  }

  /** `confirmedStopped` must come from runtime reconciliation, not a timeout. */
  release(lease: WorkspaceLease, confirmedStopped: boolean): void {
    if (!confirmedStopped) throw new Error('Cannot release workspace while worker stop is unconfirmed');
    const result = this.database.prepare('DELETE FROM workspace_writer WHERE workspace = ? AND run_id = ? AND host_id = ? AND fence = ?')
      .run(lease.workspace, lease.runId, lease.hostId, lease.fence);
    if (Number(result.changes) !== 1) throw new Error('Stale workspace lease');
  }

  close(): void { this.database.close(); }
}
