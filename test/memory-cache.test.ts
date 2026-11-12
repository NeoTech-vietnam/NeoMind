import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/memory/store.js';
import { appendFeedback, feedbackEvent, feedbackFiles, MemoryFeedbackStore, readFeedbackFile, type MemoryRating } from '../src/memory/feedback.js';
import { indexFile, MemoryIndex, openMemoryIndex } from '../src/memory/index-cache.js';
import { memoryForRun, memoryRatingTotals } from '../src/runtime/memory.js';
const execFileAsync = promisify(execFile);
const allowed = { projectWrite: true, confirmedByUser: false };

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nmc-')), root = path.join(dir, 'm'), db = path.join(dir, 'c.sqlite');
  mkdirSync(root);
  return { dir, root, db, store: new MemoryStore(root, db) };
}
const note = (store: MemoryStore, id: string, body: string, tags: string[] = []) => store.write({ id, type: 'context', scope: 'project', sources: ['README.md'], tags, body }, null, allowed);
const rate = (store: MemoryStore, eventId: string, record: string, rating: MemoryRating, createdAt = '2026-11-12T10:00:00.000Z') =>
  appendFeedback(store, [feedbackEvent({ eventId, record, revision: 'rev', runId: 'run-1', nodeId: 'verify', rating, createdAt })]);
const opened = (store: MemoryStore) => { const index = MemoryIndex.open(store); try { return { rebuilt: index.rebuilt, ratings: Object.fromEntries(index.ratings()), counts: index.counts() }; } finally { index.close(); } };
/** Legacy ratings exactly as the coordination database held them before they moved to JSONL. */
function legacyRows(db: string, rows: { eventId: string; key: string; rating: MemoryRating; runId?: string; createdAt?: string }[], uses: { key: string; runId: string; revision: string }[] = []) {
  new MemoryFeedbackStore(db).close();
  const database = new DatabaseSync(db);
  for (const row of rows) database.prepare('INSERT INTO memory_feedback VALUES (?, ?, ?, ?, ?, ?)').run(row.eventId, row.key, row.runId ?? 'run-1', 'verify', row.rating, row.createdAt ?? '2026-10-01T08:00:00.000Z');
  for (const use of uses) database.prepare('INSERT INTO memory_usage VALUES (?, ?, ?, ?)').run(use.key, use.runId, use.revision, '2026-10-01T07:00:00.000Z');
  database.close();
}
/** The totals the old `MemoryFeedbackStore.stats()` computed from the coordination database. */
function legacyScores(db: string) {
  const database = new DatabaseSync(db), weight = { helpful: 1, irrelevant: -1, wrong: -3 } as Record<string, number>, result: Record<string, { helpful: number; irrelevant: number; wrong: number; score: number }> = {};
  for (const row of database.prepare('SELECT record_key AS key, rating, COUNT(*) AS count FROM memory_feedback GROUP BY record_key, rating').all()) {
    const value = result[String(row.key)] ??= { helpful: 0, irrelevant: 0, wrong: 0, score: 0 };
    value[String(row.rating) as MemoryRating] += Number(row.count); value.score += weight[String(row.rating)]! * Number(row.count);
  }
  database.close();
  return result;
}

test('a rating is one JSON line in feedback/<month>.jsonl without the record text, and a repeated event id is skipped', () => {
  const f = fixture();
  try {
    note(f.store, 'alpha', 'SECRET-BODY text');
    assert.equal(rate(f.store, 'e1', 'context/alpha', 'helpful'), 1);
    assert.equal(rate(f.store, 'e1', 'context/alpha', 'helpful'), 0, 'the same event id is written once');
    rate(f.store, 'e2', 'context/alpha', 'wrong', '2026-12-01T00:00:00.000Z');
    assert.deepEqual(readdirSync(path.join(f.root, 'feedback')), ['2026-11.jsonl', '2026-12.jsonl']);
    const text = readFileSync(path.join(f.root, 'feedback', '2026-11.jsonl'), 'utf8');
    assert.doesNotMatch(text, /SECRET-BODY/);
    assert.deepEqual(JSON.parse(text.trim()), { eventId: 'e1', record: 'context/alpha', type: 'context', id: 'alpha', revision: 'rev', runId: 'run-1', nodeId: 'verify', rating: 'helpful', createdAt: '2026-11-12T10:00:00.000Z' });
    // A file edited by hand without its last newline still gets the next rating on a line of its own.
    writeFileSync(path.join(f.root, 'feedback', '2026-11.jsonl'), text.trimEnd());
    rate(f.store, 'e3', 'context/alpha', 'irrelevant');
    const reread = readFeedbackFile(path.join(f.root, 'feedback', '2026-11.jsonl'));
    assert.deepEqual([reread.events.map(event => event.eventId), reread.invalid], [['e1', 'e3'], 0]);
    assert.deepEqual(opened(f.store).ratings['context/alpha'], { helpful: 1, irrelevant: 1, wrong: 1, score: -3 });
  } finally { f.store.close(); }
});

test('ratings appended by several processes at once are all kept', async () => {
  const f = fixture(); f.store.close();
  const worker = path.resolve('dist/test/helpers/feedback-worker.js');
  await Promise.all(['a', 'b', 'c', 'd'].map(prefix => execFileAsync(process.execPath, [worker, f.root, f.db, prefix, '25'])));
  const { events, invalid } = readFeedbackFile(path.join(f.root, 'feedback', '2026-11.jsonl'));
  assert.equal(invalid, 0); assert.equal(events.length, 100); assert.equal(new Set(events.map(event => event.eventId)).size, 100);
});

test('ratings kept only in the coordination database are exported once, idempotently, with the revision the run used', () => {
  const f = fixture();
  try {
    note(f.store, 'alpha', 'Alpha'); note(f.store, 'bravo', 'Bravo');
    legacyRows(f.db, [{ eventId: 'old-1', key: 'context/alpha', rating: 'helpful' }, { eventId: 'old-2', key: 'context/bravo', rating: 'wrong', runId: 'run-2' }, { eventId: 'old-3', key: 'bad key', rating: 'helpful' }],
      [{ key: 'context/alpha', runId: 'run-1', revision: 'rev-a' }]);
    rate(f.store, 'old-1', 'context/alpha', 'helpful', '2026-10-01T08:00:00.000Z');
    const index = openMemoryIndex(f.store); index.close();
    const lines = () => feedbackFiles(f.root).flatMap(file => readFeedbackFile(file).events);
    assert.deepEqual(lines().map(event => [event.eventId, event.revision]), [['old-1', 'rev'], ['old-2', null]], 'old-1 was already in the file; the invalid row is skipped');
    openMemoryIndex(f.store).close();
    assert.equal(lines().length, 2, 'the second open exports nothing');
    // Without the marker, event ids still prevent duplicates.
    const database = new DatabaseSync(f.db); database.exec('DELETE FROM memory_feedback_export'); database.close();
    openMemoryIndex(f.store).close();
    assert.equal(lines().length, 2);
    // A rating removed from the files (a revert in Git) does not come back from the old table.
    writeFileSync(feedbackFiles(f.root)[0]!, `${JSON.stringify(lines()[0])}\n`);
    openMemoryIndex(f.store).close();
    assert.deepEqual(lines().map(event => event.eventId), ['old-1']);
  } finally { f.store.close(); }
});

test('the cache is rebuilt when a record or feedback file is added, changed or removed, and only then', () => {
  const f = fixture();
  try {
    note(f.store, 'alpha', 'Alpha body');
    assert.equal(opened(f.store).rebuilt, true);
    assert.equal(opened(f.store).rebuilt, false, 'unchanged sources reuse the cache');
    assert.equal(readFileSync(path.join(f.root, '.cache', '.gitignore'), 'utf8'), '*\n');
    const bravo = note(f.store, 'bravo', 'Bravo body');
    assert.deepEqual([opened(f.store).rebuilt, opened(f.store).counts.records], [true, 2]);
    f.store.write({ id: 'bravo', type: 'context', scope: 'project', sources: ['README.md'], tags: [], body: 'Bravo edited' }, bravo.revision, allowed);
    assert.equal(opened(f.store).rebuilt, true);
    rate(f.store, 'e1', 'context/alpha', 'helpful');
    assert.deepEqual([opened(f.store).rebuilt, opened(f.store).ratings['context/alpha']?.score], [true, 1]);
    rate(f.store, 'e2', 'context/alpha', 'helpful');
    assert.equal(opened(f.store).rebuilt, true);
    // Same size and mtime, different content: only a content hash notices.
    const file = feedbackFiles(f.root)[0]!, before = statSync(file), text = readFileSync(file, 'utf8');
    const marker = '"rating":"helpful"', at = text.lastIndexOf(marker);
    writeFileSync(file, `${text.slice(0, at)}"rating":"wrong"  ${text.slice(at + marker.length)}`);
    utimesSync(file, before.atime, before.mtime);
    assert.equal(statSync(file).size, before.size);
    assert.deepEqual([opened(f.store).rebuilt, opened(f.store).ratings['context/alpha']], [true, { helpful: 1, irrelevant: 0, wrong: 1, score: -2 }]);
    rmSync(file);
    assert.deepEqual([opened(f.store).rebuilt, opened(f.store).ratings], [true, {}]);
    rmSync(path.join(f.root, 'context', 'bravo.md'));
    assert.deepEqual([opened(f.store).rebuilt, opened(f.store).counts.records], [true, 1]);
    assert.deepEqual(readdirSync(path.join(f.root, '.cache')).sort(), ['.gitignore', 'index.sqlite'], 'no scratch file is left behind');
  } finally { f.store.close(); }
});

test('deleting .cache loses nothing, a schema change rebuilds, and full-text search stems words', () => {
  const f = fixture();
  try {
    note(f.store, 'alpha', 'The alarm fires twice when the pump stalls', ['pump']);
    note(f.store, 'bravo', 'Unrelated build notes');
    rate(f.store, 'e1', 'context/alpha', 'helpful'); rate(f.store, 'e2', 'context/bravo', 'wrong');
    const search = () => { const index = MemoryIndex.open(f.store); try { return index.search('alarms'); } finally { index.close(); } };
    const first = { ...opened(f.store), search: search() };
    assert.deepEqual(first.search, ['context/alpha'], '"alarms" finds "alarm"');
    rmSync(path.join(f.root, '.cache'), { recursive: true });
    const again = opened(f.store);
    assert.equal(again.rebuilt, true); assert.deepEqual(again.ratings, first.ratings); assert.deepEqual(search(), first.search);
    const database = new DatabaseSync(indexFile(f.root)); database.exec('UPDATE meta SET schema = 0'); database.close();
    assert.equal(opened(f.store).rebuilt, true, 'an older schema is rebuilt');
    assert.equal(opened(f.store).rebuilt, false);
    const index = MemoryIndex.open(f.store);
    try { assert.equal(index.search('!!'), undefined); assert.deepEqual(index.search('pump* "stalls'), ['context/alpha'], 'FTS syntax in a query is plain text'); }
    finally { index.close(); }
  } finally { f.store.close(); }
});

test('the cache stays out of Git through its own .gitignore', () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '-q', f.dir]);
    note(f.store, 'alpha', 'Alpha'); rate(f.store, 'e1', 'context/alpha', 'helpful'); opened(f.store);
    const status = execFileSync('git', ['-C', f.dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    assert.match(status, /m\/feedback\/2026-11\.jsonl/); assert.match(status, /m\/context\/alpha\.md/);
    assert.doesNotMatch(status, /\.cache/);
  } finally { f.store.close(); }
});

test('symlinked feedback and cache folders are refused', () => {
  const f = fixture(), outside = path.join(f.dir, 'out');
  mkdirSync(outside);
  try {
    note(f.store, 'alpha', 'Alpha');
    symlinkSync(outside, path.join(f.root, 'feedback'), 'junction');
    assert.throws(() => rate(f.store, 'e1', 'context/alpha', 'helpful'), /real directory/);
    assert.throws(() => MemoryIndex.open(f.store), /real directory/);
    rmSync(path.join(f.root, 'feedback'));
    symlinkSync(outside, path.join(f.root, '.cache'), 'junction');
    assert.throws(() => MemoryIndex.open(f.store), /real directory/);
    assert.deepEqual(readdirSync(outside), [], 'nothing was written through a link');
    rmSync(path.join(f.root, '.cache'));
    mkdirSync(path.join(f.root, 'feedback'));
    try { symlinkSync(path.join(outside, 'x.jsonl'), path.join(f.root, 'feedback', '2026-11.jsonl'), 'file'); }
    catch { return; } // creating file symlinks needs a privilege on Windows
    assert.throws(() => rate(f.store, 'e1', 'context/alpha', 'helpful'), /regular file/);
    assert.throws(() => MemoryIndex.open(f.store), /regular file/);
  } finally { f.store.close(); }
});

test('ranking from the cache matches the ranking from the old coordination table, after its ratings are exported', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nmr-')), repo = path.join(dir, 'r'), db = path.join(dir, 'c.sqlite');
  mkdirSync(path.join(repo, 'neomind', 'memory'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const store = new MemoryStore(path.join(repo, 'neomind', 'memory'), db);
  for (const [id, body] of [['alpha', 'deploy pipeline steps'], ['bravo', 'deploy notes'], ['charlie', 'unrelated thing'], ['delta', 'pipeline cache']]) note(store, id!, body!);
  store.close();
  const ratings: [string, MemoryRating][] = [['charlie', 'helpful'], ['charlie', 'helpful'], ['charlie', 'helpful'], ['alpha', 'wrong'], ['bravo', 'irrelevant'], ['delta', 'helpful'], ['delta', 'helpful'], ['delta', 'irrelevant'], ['delta', 'helpful']];
  legacyRows(db, ratings.map(([id, rating], i) => ({ eventId: `e${i}`, key: `context/${id}`, rating, runId: `run-${i}` })));
  const expected = legacyScores(db);
  const selected = memoryForRun(repo, db, 'deploy pipeline')!;
  // Task words: alpha 2, bravo 1, charlie 0, delta 1; ratings: alpha -3, bravo -1, charlie +3, delta +2. Charlie and
  // delta tie at 3 and keep the id order.
  assert.deepEqual(selected.records.map(record => record.header.id), ['charlie', 'delta', 'bravo', 'alpha']);
  assert.deepEqual(selected.feedback, { 'context/alpha': -3, 'context/bravo': -1, 'context/charlie': 3, 'context/delta': 2 });
  const reopened = new MemoryStore(path.join(repo, 'neomind', 'memory'), db);
  try { assert.deepEqual(Object.fromEntries(memoryRatingTotals(reopened)), expected); } finally { reopened.close(); }
});

test('a copy of the memory folder on another machine keeps its ratings', () => {
  const f = fixture();
  try {
    note(f.store, 'alpha', 'Alpha'); rate(f.store, 'e1', 'context/alpha', 'helpful'); rate(f.store, 'e2', 'context/alpha', 'wrong');
    const original = opened(f.store).ratings;
    const clone = path.join(f.dir, 'clone');
    cpSync(f.root, clone, { recursive: true, filter: source => path.basename(source) !== '.cache' });
    const other = new MemoryStore(clone, path.join(f.dir, 'other.sqlite'));
    try { assert.equal(existsSync(path.join(clone, '.cache')), false); assert.deepEqual(opened(other).ratings, original); } finally { other.close(); }
  } finally { f.store.close(); }
});
