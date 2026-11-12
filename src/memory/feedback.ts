import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { MemoryStore } from './store.js';

export const memoryRatings = ['helpful', 'irrelevant', 'wrong'] as const;
export type MemoryRating = typeof memoryRatings[number];
export interface MemoryRatingTotals { helpful: number; irrelevant: number; wrong: number; score: number }
export interface MemoryStats extends MemoryRatingTotals { uses: number }
/** What one rating adds to a record's score: a wrong record weighs more than an irrelevant one. */
export const ratingWeight: Record<MemoryRating, number> = { helpful: 1, irrelevant: -1, wrong: -3 };

/**
 * Ratings live in the memory root as `feedback/<YYYY-MM>.jsonl` so they travel with the repository (or the configured
 * memory folder). The name must stay clear of the record folders of `store.ts` (`context`, `decisions`, `lessons`).
 */
export const feedbackFolder = 'feedback';
const keySchema = z.string().regex(/^(?:context|decision|lesson)\/[a-z0-9][a-z0-9-]{0,79}$/);
/** One rating. It names the record and the revision the run used, never the record's text. */
export const feedbackEventSchema = z.object({
  eventId: z.string().min(1), record: keySchema, type: z.enum(['context', 'decision', 'lesson']), id: z.string().min(1),
  revision: z.string().min(1).nullable(), runId: z.string().min(1), nodeId: z.string().min(1).nullable(),
  attemptId: z.string().min(1).optional(), rating: z.enum(memoryRatings), createdAt: z.iso.datetime({ offset: true }),
});
export type FeedbackEvent = z.infer<typeof feedbackEventSchema>;

export function feedbackEvent(input: { eventId: string; record: string; revision?: string | null; runId: string; nodeId?: string | null; attemptId?: string; rating: MemoryRating; createdAt: string }): FeedbackEvent {
  const [type, id] = keySchema.parse(input.record).split('/') as [FeedbackEvent['type'], string];
  return feedbackEventSchema.parse({ eventId: input.eventId, record: input.record, type, id, revision: input.revision ?? null, runId: input.runId,
    nodeId: input.nodeId ?? null, ...(input.attemptId ? { attemptId: input.attemptId } : {}), rating: input.rating, createdAt: input.createdAt });
}

/** The feedback folder, refused when it is a symlink or a file, so a rating never lands outside the memory root. */
export function feedbackDirectory(root: string, create = false): string | undefined {
  const directory = path.join(root, feedbackFolder);
  try {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Memory feedback folder must be a real directory');
    return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return undefined;
    mkdirSync(directory); return directory;
  }
}

/** The monthly feedback files, oldest first; a symlinked file is refused like the folder. */
export function feedbackFiles(root: string): string[] {
  const directory = feedbackDirectory(root);
  if (!directory) return [];
  return readdirSync(directory).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().map(name => {
    const file = path.join(directory, name), info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Memory feedback file must be a regular file: ${name}`);
    return file;
  });
}

/**
 * The events of one file. A line that does not parse (a hand edit, a merge conflict marker) is skipped and counted, so
 * one bad line never hides the other ratings.
 */
export function readFeedbackFile(file: string): { events: FeedbackEvent[]; invalid: number } {
  const events: FeedbackEvent[] = [];
  let invalid = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(feedbackEventSchema.parse(JSON.parse(line))); } catch { invalid++; }
  }
  return { events, invalid };
}

/**
 * Append ratings to their month's file, skipping event ids the file already holds (a retry, or legacy ratings exported
 * twice). The caller holds the memory store's lock, so concurrent writers never interleave or duplicate a line.
 */
function appendUnlocked(root: string, events: FeedbackEvent[]): number {
  if (!events.length) return 0;
  const directory = feedbackDirectory(root, true)!, byMonth = new Map<string, FeedbackEvent[]>();
  for (const event of events) {
    const month = event.createdAt.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Invalid feedback timestamp');
    byMonth.set(month, [...byMonth.get(month) ?? [], event]);
  }
  let appended = 0;
  for (const [month, monthEvents] of byMonth) {
    const file = path.join(directory, `${month}.jsonl`);
    let existing = '';
    let info;
    try { info = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (info) {
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Memory feedback file must be a regular file: ${month}.jsonl`);
      existing = readFileSync(file, 'utf8');
    }
    const known = new Set(existing ? readFeedbackFile(file).events.map(event => event.eventId) : []), lines: string[] = [];
    for (const event of monthEvents) { if (known.has(event.eventId)) continue; known.add(event.eventId); lines.push(JSON.stringify(event)); }
    if (!lines.length) continue;
    // A file edited by hand may lack its final newline; the next line must still start on its own.
    const bytes = `${existing && !existing.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`;
    const fd = openSync(file, 'a', 0o644);
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    appended += lines.length;
  }
  return appended;
}

export function appendFeedback(store: MemoryStore, events: FeedbackEvent[]): number {
  return store.locked(() => appendUnlocked(store.root, events));
}

/**
 * Per-machine memory data in the coordination database. `memory_usage` (which run pinned which record) stays here: every
 * run writes it, so keeping it in the repository would dirty `git status` after each run. `memory_feedback` is where
 * ratings lived before they moved to `feedback/*.jsonl`; it is only read to export them once per memory root.
 */
export class MemoryFeedbackStore {
  private readonly db: DatabaseSync;
  constructor(coordinationDatabase: string) {
    this.db = new DatabaseSync(coordinationDatabase);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_usage (record_key TEXT NOT NULL, run_id TEXT NOT NULL, revision TEXT NOT NULL, used_at TEXT NOT NULL, PRIMARY KEY (record_key, run_id));
      CREATE TABLE IF NOT EXISTS memory_feedback (event_id TEXT PRIMARY KEY, record_key TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT, rating TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_feedback_export (root TEXT PRIMARY KEY, exported_at TEXT NOT NULL, events INTEGER NOT NULL)`);
  }
  close(): void { this.db.close(); }
  /** A run pinned these records; counting it again (recovery, retries) changes nothing. */
  recordUse(runId: string, records: { key: string; revision: string }[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO memory_usage(record_key, run_id, revision, used_at) VALUES (?, ?, ?, ?)'), now = new Date().toISOString();
    for (const record of records) insert.run(record.key, runId, record.revision, now);
  }
  /** How many runs pinned each record key. */
  uses(): Map<string, number> {
    return new Map(this.db.prepare('SELECT record_key AS key, COUNT(*) AS uses FROM memory_usage GROUP BY record_key').all().map(row => [String(row.key), Number(row.uses)]));
  }
  /**
   * Write the ratings an older NeoMind kept only in this database to the memory root's feedback files, once per root.
   * Event ids make it idempotent even if the marker is lost; the marker keeps a rating removed from the files (a revert in
   * Git) from coming back. Returns how many lines were added.
   */
  exportLegacyFeedback(store: MemoryStore): number {
    if (this.db.prepare('SELECT 1 FROM memory_feedback_export WHERE root = ?').get(store.root)) return 0;
    const rows = this.db.prepare(`SELECT f.event_id, f.record_key, f.run_id, f.node_id, f.rating, f.created_at, u.revision FROM memory_feedback f
      LEFT JOIN memory_usage u ON u.record_key = f.record_key AND u.run_id = f.run_id ORDER BY f.created_at, f.event_id`).all();
    const events: FeedbackEvent[] = [];
    for (const row of rows) {
      try {
        events.push(feedbackEvent({ eventId: String(row.event_id), record: String(row.record_key), revision: row.revision === null ? null : String(row.revision), runId: String(row.run_id),
          nodeId: row.node_id === null ? null : String(row.node_id), rating: String(row.rating) as MemoryRating, createdAt: String(row.created_at) }));
      } catch { /* a row the old code could not have written; nothing to rank by */ }
    }
    const appended = events.length ? appendFeedback(store, events) : 0;
    this.db.prepare('INSERT OR IGNORE INTO memory_feedback_export(root, exported_at, events) VALUES (?, ?, ?)').run(store.root, new Date().toISOString(), appended);
    return appended;
  }
}

/** Uses and rating totals per record key; a record nobody used or rated is absent. */
export function combineStats(uses: Map<string, number>, ratings: Map<string, MemoryRatingTotals>): Map<string, MemoryStats> {
  const result = new Map<string, MemoryStats>();
  for (const key of new Set([...uses.keys(), ...ratings.keys()])) {
    result.set(key, { uses: uses.get(key) ?? 0, ...(ratings.get(key) ?? { helpful: 0, irrelevant: 0, wrong: 0, score: 0 }) });
  }
  return result;
}
