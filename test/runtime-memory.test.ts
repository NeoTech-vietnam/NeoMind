import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RunManager } from '../src/runtime/run-manager.js';
import { memoryForRun } from '../src/runtime/memory.js';

test('runtime memory shares a root, pins approved revisions, audits decisions and rejects stale writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-runtime-memory-')), project = path.join(root, 'repo'); await mkdir(project);
  execFileSync('git', ['-C', project, 'init', '-q']);
  const manager = await RunManager.open(project, path.join(root, 'state'));
  try {
    assert.equal(manager.readMemory().root, null);
    const configured = await manager.configureMemory({ initializeDefault: true, expectedPrevious: null });
    assert.equal(configured.root, path.join(project, '.neomind', 'memory'));
    const record = { id: 'test-decision', type: 'decision' as const, scope: 'project', sources: ['user:confirmed'], tags: ['flow'], body: 'Use independent review' };
    const written = await manager.writeMemory(record, null, 'ui');
    assert.ok(written.record.header.sources.includes(`user-confirmation:${written.actionId}`));
    const audit = JSON.parse(await readFile(path.join(manager.stateRoot, 'memory-actions', `${written.actionId}.requested.json`), 'utf8')) as { actor: string; record: { body: string } };
    assert.equal(audit.actor, 'local-user'); assert.equal(audit.record.body, record.body);
    const snapshot = memoryForRun(project, path.join(manager.stateRoot, 'coordination.sqlite'), 'flow review')!;
    await manager.writeMemory({ ...record, body: 'Updated decision' }, written.record.revision, 'ui');
    assert.equal(snapshot.records[0]?.body, record.body); assert.equal(snapshot.records[0]?.revision, written.record.revision);
    await assert.rejects(manager.writeMemory(record, written.record.revision, 'ui'), /revision conflict/);
    const resultFiles = (await readdir(path.join(manager.stateRoot, 'memory-actions'))).filter(name => name.endsWith('.result.json'));
    assert.equal(resultFiles.length, 2);
    await rename(configured.root!, `${configured.root}-offline`);
    assert.throws(() => manager.readMemory(), /ENOENT/);
  } finally { await manager.close(); }
});
