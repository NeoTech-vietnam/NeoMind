import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, safePath } from '../dist/storage.js';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'neomind-path-guards-'));
  const root = join(base, 'project'); mkdirSync(root);
  initialize(root, { project_id: 'PATH-GUARDS' });
  t.after(() => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    assert.match(base, /neomind-path-guards-/);
    rmSync(base, { recursive: true, force: true });
  });
  return { root, base };
}

test('storage paths resolve missing descendants and preserve managed-root alias and migration guards', t => {
  const { root } = fixture(t);
  assert.equal(safePath(root, 'src/not-yet-created/value.mjs'), join(root, 'src', 'not-yet-created', 'value.mjs'));
  assert.throws(() => safePath(root, '../outside.txt'), /escapes/);
  assert.equal(safePath(root, '.neomind/config.json'), join(root, '.workforce', 'config.json'));
  renameSync(join(root, '.workforce'), join(root, '.verythinker'));
  assert.equal(safePath(root, '.neomind/config.json'), join(root, '.verythinker', 'config.json'));
  writeFileSync(join(root, '.verythinker-migration.lock'), 'migration in progress');
  assert.throws(() => safePath(root, 'src/value.mjs'), /migration is active/);
});

test('storage path checks re-read retargeted junctions rather than trusting earlier physical paths', t => {
  const { root, base } = fixture(t);
  const inside = join(root, 'inside'), outside = join(base, 'outside'), link = join(root, 'link');
  mkdirSync(inside); mkdirSync(outside);
  try { symlinkSync(inside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host cannot create test junctions.'); return; } throw error; }
  assert.equal(safePath(root, 'link/missing/value.mjs'), join(link, 'missing', 'value.mjs'));
  // Remove the link itself; never recursively delete its physical target.
  rmSync(link);
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safePath(root, 'link/missing/value.mjs'), /link outside/);
  rmSync(link);
  symlinkSync(inside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(safePath(root, 'link/missing/value.mjs'), join(link, 'missing', 'value.mjs'));
});
