import { DatabaseSync } from 'node:sqlite';
import { currentProcessIdentity, ownerLiveness, type ProcessIdentity } from './process-identity.js';
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
      CREATE TABLE IF NOT EXISTS run_owner_process (
        run_id TEXT PRIMARY KEY, fence INTEGER NOT NULL, pid INTEGER NOT NULL, start_ticks TEXT NOT NULL, boot_id TEXT NOT NULL
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
      const identity = currentProcessIdentity();
      if (identity) this.database.prepare('INSERT INTO run_owner_process(run_id, fence, pid, start_ticks, boot_id) VALUES (?, ?, ?, ?, ?)')
        .run(runId, fence, identity.pid, identity.startTicks, identity.bootId);
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

  ownerIdentity(lease: RunOwnerLease): ProcessIdentity | undefined {
    const row = this.database.prepare('SELECT pid, start_ticks, boot_id FROM run_owner_process WHERE run_id = ? AND fence = ?').get(lease.runId, lease.fence);
    if (!row) return undefined;
    const pid = Number(row.pid);
    if (!Number.isSafeInteger(pid) || typeof row.start_ticks !== 'string' || typeof row.boot_id !== 'string') throw new Error('Invalid run owner process identity');
    return { pid, startTicks: row.start_ticks, bootId: row.boot_id };
  }
  /** A dead scheduler does not establish that its workers stopped; workspace leases remain held. */
  reclaimDeadRun(lease: RunOwnerLease): void {
    const identity = this.ownerIdentity(lease);
    if (!identity || ownerLiveness(identity) !== 'dead') throw new Error('Prior scheduler death is not verified');
    this.releaseRun(lease, true);
  }

  /** The caller must verify the prior scheduler has stopped; this says nothing about its workers. */
  releaseRun(lease: RunOwnerLease, schedulerConfirmedStopped: boolean): void {
    if (!schedulerConfirmedStopped) throw new Error('Cannot release run ownership while scheduler stop is unconfirmed');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database.prepare('DELETE FROM run_owner WHERE run_id = ? AND host_id = ? AND fence = ?')
        .run(lease.runId, lease.hostId, lease.fence);
      if (Number(result.changes) !== 1) throw new Error('Stale run owner lease');
      this.database.prepare('DELETE FROM run_owner_process WHERE run_id = ? AND fence = ?').run(lease.runId, lease.fence);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
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

  getWriter(workspace: string): (WorkspaceLease & { quarantined: boolean }) | undefined {
    const canonical = realpathSync.native(workspace);
    const row = this.database.prepare('SELECT run_id, host_id, fence, quarantined FROM workspace_writer WHERE workspace = ?').get(canonical);
    if (!row) return undefined;
    const fence = Number(row.fence);
    if (typeof row.run_id !== 'string' || typeof row.host_id !== 'string' || !Number.isSafeInteger(fence)) throw new Error('Invalid workspace writer lease');
    return { workspace: canonical, runId: row.run_id, hostId: row.host_id, fence, quarantined: row.quarantined !== 0 };
  }
  /** Only call after independent verification that every worker using this lease stopped. */
  clearQuarantine(lease: WorkspaceLease, workersConfirmedStopped: boolean): void {
    if (!workersConfirmedStopped) throw new Error('Cannot clear quarantine while worker stop is unconfirmed');
    const result = this.database.prepare('UPDATE workspace_writer SET quarantined = 0 WHERE workspace = ? AND run_id = ? AND host_id = ? AND fence = ? AND quarantined = 1')
      .run(lease.workspace, lease.runId, lease.hostId, lease.fence);
    if (Number(result.changes) !== 1) throw new Error('Stale or non-quarantined workspace lease');
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
