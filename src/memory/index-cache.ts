import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { feedbackFiles, feedbackFolder, MemoryFeedbackStore, ratingWeight, readFeedbackFile, type MemoryRatingTotals } from './feedback.js';
import { memoryFolders, type MemoryRecord, type MemoryStore } from './store.js';

/**
 * A rebuildable SQLite cache of the memory root, in `<root>/.cache/index.sqlite`. The Markdown records and the
 * `feedback/*.jsonl` ratings are the source of truth; the cache holds the rating totals retrieval ranks by and a full-text
 * index for search. Deleting `.cache/` loses nothing: the next read rebuilds it.
 *
 * Bump the schema whenever the tables or what goes into them change, so every older cache is rebuilt.
 */
export const memoryIndexSchema = 1;
export const cacheFolder = '.cache';
export const indexFile = (root: string) => path.join(root, cacheFolder, 'index.sqlite');
const kinds = Object.entries(memoryFolders) as [MemoryRecord['header']['type'], string][];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The cache folder, refused when it is a symlink so a rebuild never writes outside the memory root. */
function cacheDirectory(root: string, create: boolean): string | undefined {
  const directory = path.join(root, cacheFolder);
  try {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Memory cache folder must be a real directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return undefined;
    mkdirSync(directory);
  }
  // Its own ignore file keeps the cache out of Git whatever the repository's `.gitignore` says.
  const ignore = path.join(directory, '.gitignore');
  if (create && !existsSync(ignore)) {
    try { writeFileSync(ignore, '*\n', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  return directory;
}

/** Every file the cache is derived from: record Markdown in the type folders and the monthly feedback files. */
export function memorySourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const [, folder] of kinds) {
    const directory = path.join(root, folder);
    let info;
    try { info = lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Memory directory is not a real directory');
    for (const name of readdirSync(directory).filter(item => item.endsWith('.md')).sort()) {
      const file = path.join(directory, name);
      if (lstatSync(file).isSymbolicLink()) throw new Error('Memory record cannot be a symlink');
      files.push(file);
    }
  }
  return [...files, ...feedbackFiles(root)];
}

/**
 * Hash of the sources: each relative path with the SHA-256 of its content. Content rather than size and mtime, because a
 * Git checkout, `cp -p` or a coarse file system can keep size and mtime across a real change, and a stale cache would rank
 * by ratings that no longer exist. Every memory read already reads all records, so hashing them costs little more.
 */
export function memorySourceHash(root: string): string {
  const hash = createHash('sha256');
  for (const file of memorySourceFiles(root)) hash.update(`${path.relative(root, file).split(path.sep).join('/')}\0${sha(readFileSync(file))}\n`);
  return hash.digest('hex');
}

/** The cache's own schema and store hash when it matches; never scans its tables. */
function openCurrent(file: string, hash: string): DatabaseSync | undefined {
  if (!existsSync(file)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const meta = db.prepare('SELECT schema, store_hash FROM meta').get();
    if (meta && Number(meta.schema) === memoryIndexSchema && meta.store_hash === hash) return db;
  } catch { /* unreadable or older layout: rebuild */ }
  db?.close();
  return undefined;
}

/** Fill a fresh database from the sources. A record that fails its integrity check is left out, like an unrated one. */
function build(db: DatabaseSync, store: MemoryStore, hash: string): void {
  db.exec(`CREATE TABLE meta (schema INTEGER NOT NULL, store_hash TEXT NOT NULL);
    CREATE TABLE records (key TEXT PRIMARY KEY, type TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, tags TEXT NOT NULL, revision TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE feedback (event_id TEXT PRIMARY KEY, record_key TEXT NOT NULL, revision TEXT, run_id TEXT NOT NULL, node_id TEXT, rating TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ratings (record_key TEXT PRIMARY KEY, helpful INTEGER NOT NULL, irrelevant INTEGER NOT NULL, wrong INTEGER NOT NULL, score INTEGER NOT NULL);
    CREATE TABLE invalid_feedback (file TEXT PRIMARY KEY, lines INTEGER NOT NULL);
    CREATE VIRTUAL TABLE records_fts USING fts5(key UNINDEXED, id, scope, tags, body, tokenize="porter unicode61 remove_diacritics 2");`);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO meta(schema, store_hash) VALUES (?, ?)').run(memoryIndexSchema, hash);
    const record = db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)'), text = db.prepare('INSERT INTO records_fts(key, id, scope, tags, body) VALUES (?, ?, ?, ?, ?)');
    for (const [type, folder] of kinds) {
      const directory = path.join(store.root, folder);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).filter(item => item.endsWith('.md')).sort()) {
        let value: MemoryRecord | undefined;
        try { value = store.read(type, name.slice(0, -3)); } catch { continue; }
        if (!value) continue;
        const key = `${type}/${value.header.id}`;
        record.run(key, type, value.header.id, value.header.scope, JSON.stringify(value.header.tags), value.revision, value.header.updatedAt);
        text.run(key, value.header.id, value.header.scope, value.header.tags.join(' '), value.body);
      }
    }
    // The same event in two files (a merge that kept both sides) counts once.
    const event = db.prepare('INSERT OR IGNORE INTO feedback VALUES (?, ?, ?, ?, ?, ?, ?)'), invalid = db.prepare('INSERT INTO invalid_feedback VALUES (?, ?)');
    for (const file of feedbackFiles(store.root)) {
      const read = readFeedbackFile(file);
      for (const item of read.events) event.run(item.eventId, item.record, item.revision, item.runId, item.nodeId, item.rating, item.createdAt);
      if (read.invalid) invalid.run(path.basename(file), read.invalid);
    }
    db.exec(`INSERT INTO ratings SELECT record_key, SUM(rating = 'helpful'), SUM(rating = 'irrelevant'), SUM(rating = 'wrong'),
      SUM(CASE rating WHEN 'helpful' THEN ${ratingWeight.helpful} WHEN 'irrelevant' THEN ${ratingWeight.irrelevant} WHEN 'wrong' THEN ${ratingWeight.wrong} ELSE 0 END) FROM feedback GROUP BY record_key`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const check = db.prepare('PRAGMA integrity_check').get();
  if (check?.integrity_check !== 'ok') throw new Error(`Memory cache failed its integrity check: ${String(check?.integrity_check)}`);
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Windows refuses to replace a file another process holds open; those errors are worth a short retry. */
const busy = (error: unknown) => ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');
function removeQuietly(file: string) { try { unlinkSync(file); } catch { /* already gone or still open elsewhere */ } }

export class MemoryIndex {
  private constructor(private readonly db: DatabaseSync, readonly file: string, readonly rebuilt: boolean, private readonly temporary?: string) {}

  /**
   * The cache for this store, rebuilt when its schema or store hash differs from the sources. A rebuild writes a scratch
   * file next to the cache, checks its integrity, makes sure the sources did not change while it ran, then renames it over
   * the cache. If Windows keeps the old cache open in another process, this read uses the scratch file and deletes it.
   */
  static open(store: MemoryStore): MemoryIndex {
    const file = indexFile(store.root);
    let hash = memorySourceHash(store.root);
    const current = cacheDirectory(store.root, false) ? openCurrent(file, hash) : undefined;
    if (current) return new MemoryIndex(current, file, false);
    let directory: string;
    try { directory = cacheDirectory(store.root, true)!; }
    catch (error) {
      // A read-only memory folder still gets correct ratings and search, only without the cache.
      if (!busy(error) && (error as NodeJS.ErrnoException).code !== 'EROFS') throw error;
      const db = new DatabaseSync(':memory:'); build(db, store, hash); return new MemoryIndex(db, ':memory:', true);
    }
    for (const name of readdirSync(directory)) {
      // Scratch files of a crashed rebuild; a recent one may belong to a rebuild still running.
      const leftover = path.join(directory, name);
      if (/^index\.[0-9a-f-]+\.tmp$/.test(name) && Date.now() - statSync(leftover).mtimeMs > 10 * 60_000) removeQuietly(leftover);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const scratch = path.join(directory, `index.${randomUUID()}.tmp`);
      try {
        const db = new DatabaseSync(scratch);
        try { build(db, store, hash); } finally { db.close(); }
      } catch (error) { removeQuietly(scratch); throw error; }
      const after = memorySourceHash(store.root);
      if (after !== hash) { removeQuietly(scratch); hash = after; continue; }
      let published = false;
      for (let retry = 0; retry < 5 && !published; retry++) {
        try { renameSync(scratch, file); published = true; }
        catch (error) { if (!busy(error)) { removeQuietly(scratch); throw error; } sleep(20 * (retry + 1)); }
      }
      if (!published) return new MemoryIndex(new DatabaseSync(scratch, { readOnly: true }), scratch, true, scratch);
      // Another process may have published a newer cache in between; it must match what was just hashed.
      const opened = openCurrent(file, hash);
      if (opened) return new MemoryIndex(opened, file, true);
      hash = memorySourceHash(store.root);
    }
    throw new Error('Memory changed while its cache was being rebuilt; try again');
  }

  close(): void { this.db.close(); if (this.temporary) removeQuietly(this.temporary); }

  /** Rating totals per record key, as the coordination database used to hold them. */
  ratings(): Map<string, MemoryRatingTotals> {
    return new Map(this.db.prepare('SELECT record_key AS key, helpful, irrelevant, wrong, score FROM ratings').all()
      .map(row => [String(row.key), { helpful: Number(row.helpful), irrelevant: Number(row.irrelevant), wrong: Number(row.wrong), score: Number(row.score) }]));
  }

  /**
   * Record keys matching every word of the query, best first. Words are quoted so FTS syntax in the query is plain text;
   * the tokenizer stems them, so "alarms" finds "alarm". Undefined when the query has no word to search for.
   */
  search(query: string): string[] | undefined {
    const words = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu);
    if (!words?.length) return undefined;
    const match = words.map(word => `"${word.replaceAll('"', '""')}"`).join(' ');
    return this.db.prepare('SELECT key FROM records_fts WHERE records_fts MATCH ? ORDER BY bm25(records_fts), key').all(match).map(row => String(row.key));
  }

  counts(): { records: number; feedbackEvents: number; invalidFeedbackLines: number } {
    const count = (sql: string) => Number(this.db.prepare(sql).get()?.count ?? 0);
    return { records: count('SELECT COUNT(*) AS count FROM records'), feedbackEvents: count('SELECT COUNT(*) AS count FROM feedback'),
      invalidFeedbackLines: count('SELECT COALESCE(SUM(lines), 0) AS count FROM invalid_feedback') };
  }
}

/** The memory's cache after exporting ratings an older NeoMind kept only in this machine's coordination database. */
export function openMemoryIndex(store: MemoryStore): MemoryIndex {
  const legacy = new MemoryFeedbackStore(store.coordinationDatabase);
  try { legacy.exportLegacyFeedback(store); } finally { legacy.close(); }
  return MemoryIndex.open(store);
}

/**
 * What the cache of a memory root holds, without creating, rebuilding or migrating anything (`doctor paths`).
 * `upToDate` compares its store hash with the sources as they are now.
 */
export function inspectMemoryIndex(root: string) {
  const file = indexFile(root), directory = path.join(root, cacheFolder);
  const base = { directory, file, feedbackDirectory: path.join(root, feedbackFolder), exists: existsSync(file) };
  if (!base.exists) return base;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const meta = db.prepare('SELECT schema, store_hash FROM meta').get(), count = (sql: string) => Number(db!.prepare(sql).get()?.count ?? 0);
    let upToDate: boolean | undefined;
    try { upToDate = Number(meta?.schema) === memoryIndexSchema && meta?.store_hash === memorySourceHash(root); } catch { upToDate = undefined; }
    return { ...base, schema: Number(meta?.schema), currentSchema: memoryIndexSchema, upToDate, records: count('SELECT COUNT(*) AS count FROM records'),
      feedbackEvents: count('SELECT COUNT(*) AS count FROM feedback') };
  } catch (error) { return { ...base, error: error instanceof Error ? error.message : String(error) }; }
  finally { db?.close(); }
}
