import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
const execFileAsync = promisify(execFile);
const record = { id: 'project-facts', type: 'context' as const, scope: 'project', sources: ['README.md'], tags: ['architecture'], body: 'Original fact' };

test('shared memory requires sources and permission, enforces CAS and detects tampering', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-memory-')), root = path.join(dir, 'memory'); mkdirSync(root);
  const db = path.join(dir, 'coordination.sqlite'), a = new MemoryStore(root, db), b = new MemoryStore(root, db);
  assert.throws(() => a.write(record, null, { projectWrite: false, confirmedByUser: false }), /permission/);
  assert.throws(() => a.write({ ...record, sources: [] }, null, { projectWrite: true, confirmedByUser: false }));
  const original = a.write(record, null, { projectWrite: true, confirmedByUser: false });
  assert.equal(b.read('context', record.id)?.revision, original.revision);
  const updated = b.write({ ...record, body: 'Updated fact' }, original.revision, { projectWrite: true, confirmedByUser: false });
  assert.throws(() => a.write(record, original.revision, { projectWrite: true, confirmedByUser: false }), /revision conflict/);
  assert.equal(a.read('context', record.id)?.revision, updated.revision);
  assert.equal(a.search({ query: 'updated', tags: ['architecture'], scope: 'project' }).length, 1);
  assert.equal(a.search({ query: 'missing' }).length, 0);
  assert.equal(a.search({ types: ['lesson'] }).length, 0);
  assert.throws(() => a.write({ ...record, type: 'decision' }, null, { projectWrite: true, confirmedByUser: false }), /confirmation/);
  assert.throws(() => a.write({ ...record, type: 'lesson' }, null, { projectWrite: true, confirmedByUser: false }), /proposal/);
  writeFileSync(path.join(root, 'context', `${record.id}.md`), 'broken');
  assert.throws(() => a.read('context', record.id), /frontmatter/);
  a.close(); b.close();
});

test('missing memory root and symlinked record directory are rejected', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-memory-path-'));
  assert.throws(() => new MemoryStore(path.join(dir, 'missing'), path.join(dir, 'db')));
  const root = path.join(dir, 'memory'); mkdirSync(root); symlinkSync(dir, path.join(root, 'context'), 'junction');
  const store = new MemoryStore(root, path.join(dir, 'db'));
  assert.throws(() => store.write(record, null, { projectWrite: true, confirmedByUser: false }), /real directory/);
  store.close();
});

test('concurrent hosts cannot overwrite the same expected memory revision', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-memory-process-')), root = path.join(dir, 'memory'); mkdirSync(root);
  const db = path.join(dir, 'coordination.sqlite'), store = new MemoryStore(root, db);
  const initial = store.write(record, null, { projectWrite: true, confirmedByUser: false }); store.close();
  const worker = path.resolve('dist/test/helpers/memory-worker.js');
  const results = await Promise.all(['first', 'second'].map(async content => {
    const { stdout } = await execFileAsync(process.execPath, [worker, root, db, initial.revision, content]);
    return JSON.parse(stdout) as { success: boolean; message?: string };
  }));
  assert.equal(results.filter(r => r.success).length, 1);
  assert.match(results.find(r => !r.success)?.message ?? '', /revision conflict/);
});

test('lesson proposal stays out of approved memory until trusted user promotion', async () => {
  const { LessonProposals } = await import('../src/memory/proposals.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-lessons-')), root = path.join(dir, 'memory'), artifacts = path.join(dir, 'artifacts');
  mkdirSync(root); mkdirSync(artifacts);
  const store = new MemoryStore(root, path.join(dir, 'coordination.sqlite')), proposals = new LessonProposals(artifacts);
  proposals.create({ proposalId: 'lesson-1', runId: 'run-1', createdAt: new Date().toISOString(),
    record: { ...record, id: 'learned', type: 'lesson', body: 'Use explicit approval' } });
  assert.equal(store.search({ types: ['lesson'] }).length, 0);
  assert.throws(() => proposals.approve('lesson-1', 'approval-1', 'user', null, { projectWrite: true, confirmedByUser: false }), /confirmation/);
  assert.throws(() => proposals.approve('lesson-1', 'approval-stale', 'user', null, { projectWrite: true, confirmedByUser: true }, 'a'.repeat(64)), /changed since/);
  proposals.approve('lesson-1', 'approval-1', 'user', null, { projectWrite: true, confirmedByUser: true });
  assert.throws(() => proposals.promote('approval-1', store, { projectWrite: false }), /permission/);
  const promoted = proposals.promote('approval-1', store, { projectWrite: true });
  assert.throws(() => proposals.promote('approval-1', store, { projectWrite: true }), /revision conflict/);
  assert.ok(promoted.header.sources.includes('proposal:lesson-1'));
  assert.ok(promoted.header.sources.includes('approval:approval-1'));
  assert.equal(store.search({ types: ['lesson'] }).length, 1);
  store.close();
});

test('CLI reads approved memory and filters lexical search', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-memory-cli-')), root = path.join(dir, 'memory'); mkdirSync(root);
  const db = path.join(dir, 'coordination.sqlite'), store = new MemoryStore(root, db);
  store.write(record, null, { projectWrite: true, confirmedByUser: false }); store.close();
  const cli = path.resolve('dist/src/cli/main.js');
  const got = await execFileAsync(process.execPath, [cli, 'memory', 'get', root, db, 'context', record.id]);
  assert.equal((JSON.parse(got.stdout) as { body: string }).body, record.body);
  const found = await execFileAsync(process.execPath, [cli, 'memory', 'search', root, db, 'original']);
  assert.equal((JSON.parse(found.stdout) as unknown[]).length, 1);
});
