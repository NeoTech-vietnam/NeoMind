import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { appendFeedback, feedbackEvent } from '../src/memory/feedback.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { doctorPaths } from '../src/runtime/doctor-paths.js';
import { sessionToolHandlers } from '../src/runtime/session-tools.js';
import { createEditorApi } from '../src/ui-server/server.js';
const execFileAsync = promisify(execFile);
const rate = (store: MemoryStore, eventId: string, record: string, rating: 'helpful') =>
  appendFeedback(store, [feedbackEvent({ eventId, record, runId: 'run-1', rating, createdAt: '2026-11-12T10:00:00.000Z' })]);

/** Every file and folder below `root` with its size and mtime, to prove a command wrote nothing. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
    const file = path.join(entry.parentPath, entry.name), info = statSync(file);
    return `${path.relative(root, file)} ${entry.isDirectory() ? 'dir' : `${info.size} ${info.mtimeMs}`}`;
  }).sort();
}

test('doctor paths reports state, journals, worktrees, memory, feedback and cache without writing anything', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nmd-')), repo = path.join(dir, 'r'), base = path.join(dir, 'x');
  mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  const env = { ...process.env, XDG_STATE_HOME: base, LOCALAPPDATA: base }, script = path.resolve('dist/src/cli/main.js');
  // A project NeoMind never opened: nothing exists and nothing is created.
  const fresh = JSON.parse(execFileSync(process.execPath, [script, 'doctor', 'paths', repo], { encoding: 'utf8', env })) as Awaited<ReturnType<typeof doctorPaths>>;
  assert.equal(fresh.state.exists, false); assert.equal(fresh.memory.exists, false); assert.equal(fresh.memory.cache.exists, false);
  assert.equal(existsSync(base), false);
  const manager = await RunManager.open(repo, base, new RunnerRegistry([]));
  try {
    await manager.addMemoryNote({ type: 'context', body: 'The alarm fires twice' });
    const search = manager.searchMemory({ query: 'alarms' });
    assert.equal(search.searchedBy, 'fts'); assert.equal(search.records.length, 1);
    assert.equal(manager.searchMemory({ query: 'larm' }).records.length, 1, 'a substring the old search found is still found');
    assert.equal(manager.searchMemory({ query: 'alarms', type: 'decision' }).records.length, 0, 'type filter still applies');
  } finally { await manager.close(); }
  const store = new MemoryStore(path.join(repo, 'neomind', 'memory'), path.join(dir, 'c.sqlite'));
  try { rate(store, 'e1', `context/${readdirSync(path.join(repo, 'neomind', 'memory', 'context'))[0]!.slice(0, -3)}`, 'helpful'); } finally { store.close(); }
  const before = [...tree(base), ...tree(repo)];
  const { stdout } = await execFileAsync(process.execPath, [script, 'doctor', 'paths', repo], { encoding: 'utf8', env });
  const report = JSON.parse(stdout) as Awaited<ReturnType<typeof doctorPaths>>;
  assert.deepEqual([...tree(base), ...tree(repo)], before, 'doctor paths wrote nothing');
  assert.equal(report.state.exists, true); assert.equal(report.coordinationDatabase.exists, true);
  assert.ok(report.state.directory.startsWith(path.join(base, 'neomind')));
  assert.equal(report.journals.directory, path.join(report.state.directory, 'runs'));
  assert.equal(report.worktrees.directory, path.join(report.state.directory, 'workspaces'));
  assert.equal(report.memory.root, path.join(repo, 'neomind', 'memory')); assert.equal(report.memory.inGit, true); assert.equal(report.memory.configured, false);
  assert.deepEqual(report.memory.feedback.files, ['2026-11.jsonl']);
  assert.deepEqual([report.memory.cache.exists, report.memory.cache.inGit, 'records' in report.memory.cache && report.memory.cache.records], [true, false, 1]);
  assert.equal('upToDate' in report.memory.cache && report.memory.cache.upToDate, false, 'the rating written after the last read makes the cache stale');
  const manager2 = await RunManager.open(repo, base, new RunnerRegistry([]));
  try {
    assert.deepEqual((await manager2.doctorPaths()).memory.root, report.memory.root);
    const runs = async () => manager2, tools = sessionToolHandlers(runs, createEditorApi(repo, runs));
    assert.deepEqual(((await tools.doctor_paths!({})) as typeof report).memory.cache.file, report.memory.cache.file, 'the session tool goes through the editor API');
  } finally { await manager2.close(); }
});
