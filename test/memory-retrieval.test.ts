import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryStore } from '../src/memory/store.js';
import { activeMemory, semanticScores } from '../src/memory/retrieval.js';
import { inferProjectPaths } from '../src/runtime/memory.js';

test('local semantic retrieval connects related records through the corpus and leaves unrelated records behind', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-lsa-')), store = new MemoryStore(root, path.join(root, 'db.sqlite'));
  try {
    const records = ['authentication login session cookie', 'session cookie lifetime timeout', 'compiler parser syntax', 'compiler optimizer syntax'].map((body, i) => store.write({ id: `record-${i}`, type: 'context', scope: 'project', sources: ['fixture'], tags: [], body }, null, { projectWrite: true, confirmedByUser: false }));
    const scores = semanticScores(records, 'login');
    assert.ok(scores[1]! > 0.2, 'a related record without the query word is retrieved');
    assert.ok(scores[1]! > scores[2]! + 0.1, 'unrelated code documentation ranks lower');
    assert.deepEqual(semanticScores(records, 'unseenword'), [0, 0, 0, 0]);
  } finally { store.close(); }
});

test('retrieval excludes expired, superseded and duplicate records without deleting them and rejects supersession cycles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-memory-life-')), store = new MemoryStore(root, path.join(root, 'db.sqlite'));
  const write = (id: string, body: string, fields = {}) => store.write({ id, type: 'context', scope: 'project', sources: ['fixture'], tags: [], body, ...fields }, null, { projectWrite: true, confirmedByUser: false });
  try {
    const old = write('old', 'Old rule'); write('new', 'New rule', { supersedes: ['old'] });
    write('expired', 'Temporary rule', { expiresAt: '2000-01-01T00:00:00Z' });
    write('copy-one', 'same content'); write('copy-two', ' same  content ');
    const result = activeMemory(store.search());
    assert.equal(result.active.length, 2);
    assert.deepEqual(new Set(result.excluded.map(item => item.reason)), new Set(['expired', 'superseded', 'duplicate']));
    assert.equal(store.search().length, 5, 'suppression never removes the stored records');
    write('different-tags', 'same content', { tags: ['targeted'] });
    assert.ok(activeMemory(store.search()).active.some(record => record.header.id === 'different-tags'), 'dedup never drops records with different tag applicability');
    assert.throws(() => store.write({ id: 'old', type: 'context', scope: 'project', sources: ['fixture'], tags: [], body: 'Cycle', supersedes: ['new'] }, old.revision, { projectWrite: true, confirmedByUser: false }), /cycle/);
  } finally { store.close(); }
});

test('path inference resolves a task basename to tracked and untracked project paths without needing a slash in the task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-infer-path-'));
  execFileSync('git', ['-C', root, 'init', '-q']); await mkdir(path.join(root, 'ui'));
  await writeFile(path.join(root, 'ui', 'RunStart.tsx'), 'source');
  await writeFile(path.join(root, 'other.ts'), 'other');
  assert.deepEqual(inferProjectPaths(root, 'Fix RunStart interactions'), ['ui/RunStart.tsx']);
  assert.deepEqual(inferProjectPaths(root, 'Fix no-such-component'), []);
});
