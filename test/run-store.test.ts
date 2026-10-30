import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunStore } from '../src/storage/run-store.js';

test('run store isolates IDs, refuses replacement and rejects symlinks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-runs-')), store = await RunStore.open(dir);
  const file = await store.create('run-1'); assert.equal(file, await store.journal('run-1'));
  await assert.rejects(store.create('run-1'), /EEXIST/);
  await assert.rejects(store.create('../outside'));
  await symlink(dir, path.join(dir, 'alias'), 'junction');
  await assert.rejects(store.journal('alias'), /real directory/);
  assert.deepEqual(await store.list(), ['run-1']);
});
