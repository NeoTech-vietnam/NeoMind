import { DatabaseSync } from 'node:sqlite';

export const memoryRatings = ['helpful', 'irrelevant', 'wrong'] as const;
export type MemoryRating = typeof memoryRatings[number];
export interface MemoryStats { uses: number; helpful: number; irrelevant: number; wrong: number; score: number }
/** What one rating adds to a record's score: a wrong record weighs more than an irrelevant one. */
const weight: Record<MemoryRating, number> = { helpful: 1, irrelevant: -1, wrong: -3 };

/**
 * How often each approved record was pinned into a run and how users rated it, in the coordination database. The run
 * journal keeps each rating as the source of truth; this table is the aggregate retrieval reads. Keys are `type/id`.
 */
export class MemoryFeedbackStore {
  private readonly db: DatabaseSync;
  constructor(coordinationDatabase: string) {
    this.db = new DatabaseSync(coordinationDatabase);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_usage (record_key TEXT NOT NULL, run_id TEXT NOT NULL, revision TEXT NOT NULL, used_at TEXT NOT NULL, PRIMARY KEY (record_key, run_id));
      CREATE TABLE IF NOT EXISTS memory_feedback (event_id TEXT PRIMARY KEY, record_key TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT, rating TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }
  close(): void { this.db.close(); }
  /** A run pinned these records; counting it again (recovery, retries) changes nothing. */
  recordUse(runId: string, records: { key: string; revision: string }[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO memory_usage(record_key, run_id, revision, used_at) VALUES (?, ?, ?, ?)'), now = new Date().toISOString();
    for (const record of records) insert.run(record.key, runId, record.revision, now);
  }
  /** The journal event id makes the aggregate idempotent when a rating is replayed. */
  recordFeedback(input: { eventId: string; key: string; runId: string; nodeId?: string; rating: MemoryRating; createdAt: string }): void {
    this.db.prepare('INSERT OR IGNORE INTO memory_feedback(event_id, record_key, run_id, node_id, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.eventId, input.key, input.runId, input.nodeId ?? null, input.rating, input.createdAt);
  }
  /** Usage and rating totals per record key; a record nobody used or rated is absent. */
  stats(): Map<string, MemoryStats> {
    const result = new Map<string, MemoryStats>();
    const entry = (key: string) => { let value = result.get(key); if (!value) { value = { uses: 0, helpful: 0, irrelevant: 0, wrong: 0, score: 0 }; result.set(key, value); } return value; };
    for (const row of this.db.prepare('SELECT record_key AS key, COUNT(*) AS uses FROM memory_usage GROUP BY record_key').all()) entry(String(row.key)).uses = Number(row.uses);
    for (const row of this.db.prepare('SELECT record_key AS key, rating, COUNT(*) AS count FROM memory_feedback GROUP BY record_key, rating').all()) {
      const rating = String(row.rating) as MemoryRating, value = entry(String(row.key));
      if (!(rating in weight)) continue;
      value[rating] += Number(row.count); value.score += weight[rating] * Number(row.count);
    }
    return result;
  }
}
