import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createRecord,
  getRecord,
  initialize,
  loadRecords,
  snapshotPaths,
  sourceHash,
} from '../dist/storage.js';
import { migrateStorage } from '../dist/migration.js';

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-migration-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function record(root) {
  return createRecord(root, {
    type: 'requirement',
    title: 'measurable contract',
    owner: 'requirements',
    data: {},
    body: 'The original record body remains measurable.\n',
  });
}

// Build a realistic pre-migration project by initializing new storage and renaming
// the physical directory back to the legacy name, mirroring an installed legacy repo.
function legacyProject(root, options = {}) {
  initialize(root, { project_id: 'LEGACY', platforms: ['copilot'], ...options });
  const item = record(root);
  renameSync(join(root, '.neomind'), join(root, '.verythinker'));
  return item;
}

test('fresh storage is created under .neomind with NeoMind defaults', (t) => {
  const root = tempRoot(t);
  const config = initialize(root);
  assert.ok(existsSync(join(root, '.neomind/config.json')));
  assert.equal(existsSync(join(root, '.verythinker')), false);
  assert.match(config.project_id, /^NM-[0-9A-F]+$/);
  assert.equal(config.name, 'NeoMind project');
  assert.deepEqual(config.platforms, ['copilot']);

  const item = record(root);
  assert.equal(item.path, `.neomind/records/${item.meta.id}.md`);
  assert.ok(existsSync(join(root, '.neomind/records', `${item.meta.id}.md`)));
  assert.equal(existsSync(join(root, '.verythinker')), false);
  assert.equal(getRecord(root, item.meta.id).meta.title, 'measurable contract');
});

test('initialize never creates a second root and leaves legacy bytes untouched', (t) => {
  const root = tempRoot(t);
  const item = legacyProject(root);
  const file = join(root, '.verythinker/records', `${item.meta.id}.md`);
  const before = readFileSync(file);

  assert.equal(loadRecords(root).length, 1);
  assert.equal(getRecord(root, item.meta.id).meta.title, 'measurable contract');

  const reread = initialize(root);
  assert.equal(reread.project_id, 'LEGACY');
  assert.equal(existsSync(join(root, '.neomind')), false);
  assert.deepEqual(readFileSync(file), before);
});

test('migration moves the directory while preserving bytes, hashes, and logical refs', (t) => {
  const root = tempRoot(t);
  const item = legacyProject(root);
  const file = join(root, '.verythinker/records', `${item.meta.id}.md`);
  const bytesBefore = readFileSync(file);
  const sourceBefore = sourceHash(root);
  const snapshotBefore = snapshotPaths(root, ['.verythinker/records']);
  const pathBefore = loadRecords(root)[0].path;

  const result = migrateStorage(root);
  assert.equal(result.moved, true);
  assert.ok(existsSync(join(root, '.neomind/records', `${item.meta.id}.md`)));
  assert.equal(existsSync(join(root, '.verythinker')), false);

  assert.deepEqual(readFileSync(join(root, '.neomind/records', `${item.meta.id}.md`)), bytesBefore);
  assert.equal(sourceHash(root), sourceBefore);
  assert.deepEqual(snapshotPaths(root, ['.verythinker/records']), snapshotBefore);
  assert.equal(loadRecords(root)[0].path, pathBefore);
  assert.ok(pathBefore.startsWith('.neomind/records/'));
});

test('migration is idempotent once storage already lives under .neomind', (t) => {
  const root = tempRoot(t);
  initialize(root, { project_id: 'DONE', platforms: ['copilot'] });
  const result = migrateStorage(root);
  assert.equal(result.moved, false);
  assert.ok(existsSync(join(root, '.neomind/config.json')));
});

test('target-only migration rejects active gates and linked roots', (t) => {
  const root = tempRoot(t);
  initialize(root);
  const gate = join(root, '.neomind-migration.lock');
  writeFileSync(gate, 'interrupted');
  assert.throws(() => migrateStorage(root), /migration lock exists/i);
  rmSync(gate);
  renameSync(join(root, '.neomind'), join(root, 'storage'));
  symlinkSync(join(root, 'storage'), join(root, '.neomind'), 'junction');
  assert.throws(() => migrateStorage(root), /real directory/i);
});

test('migration accepts canonical Windows case variants', { skip: process.platform !== 'win32' }, (t) => {
  const root = tempRoot(t);
  legacyProject(root);
  assert.equal(migrateStorage(root.toUpperCase()).moved, true);
});

test('migration refuses when both storage roots exist', (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, '.verythinker'), { recursive: true });
  mkdirSync(join(root, '.neomind'), { recursive: true });
  assert.throws(() => migrateStorage(root), /both the legacy and neomind/i);
});

test('migration refuses a linked legacy root', (t) => {
  const root = tempRoot(t);
  const realStore = join(root, 'elsewhere');
  mkdirSync(realStore, { recursive: true });
  symlinkSync(realStore, join(root, '.verythinker'), 'junction');
  assert.throws(() => migrateStorage(root), /link|junction|symbolic/i);
});

test('migration refuses while any lock is present', (t) => {
  const writeLockRoot = tempRoot(t);
  legacyProject(writeLockRoot);
  writeFileSync(join(writeLockRoot, '.verythinker/write.lock'), '{}');
  assert.throws(() => migrateStorage(writeLockRoot), /lock/i);

  const operationLockRoot = tempRoot(t);
  legacyProject(operationLockRoot);
  mkdirSync(join(operationLockRoot, '.verythinker/operations'), { recursive: true });
  writeFileSync(join(operationLockRoot, '.verythinker/operations/intake.lock'), '{}');
  assert.throws(() => migrateStorage(operationLockRoot), /lock/i);

  const toolLockRoot = tempRoot(t);
  legacyProject(toolLockRoot);
  mkdirSync(join(toolLockRoot, '.verythinker/tools'), { recursive: true });
  writeFileSync(join(toolLockRoot, '.verythinker/tools/codex.install.lock'), '{}');
  assert.throws(() => migrateStorage(toolLockRoot), /lock/i);
});

test('migration refuses while native work is still active or indeterminate', (t) => {
  const activeRoot = tempRoot(t);
  legacyProject(activeRoot);
  mkdirSync(join(activeRoot, '.verythinker/native/receipts'), { recursive: true });
  writeFileSync(
    join(activeRoot, '.verythinker/native/receipts', `${randomUUID()}.json`),
    JSON.stringify({ state: 'running' }),
  );
  assert.throws(() => migrateStorage(activeRoot), /active/i);

  const malformedRoot = tempRoot(t);
  legacyProject(malformedRoot);
  mkdirSync(join(malformedRoot, '.verythinker/native/receipts'), { recursive: true });
  writeFileSync(
    join(malformedRoot, '.verythinker/native/receipts', `${randomUUID()}.json`),
    'not valid json',
  );
  assert.throws(() => migrateStorage(malformedRoot), /indeterminate/i);
});

test('settled native receipts do not block migration', (t) => {
  const root = tempRoot(t);
  legacyProject(root);
  mkdirSync(join(root, '.verythinker/native/receipts'), { recursive: true });
  writeFileSync(
    join(root, '.verythinker/native/receipts', `${randomUUID()}.json`),
    JSON.stringify({ state: 'completed' }),
  );
  assert.equal(migrateStorage(root).moved, true);
  assert.ok(existsSync(join(root, '.neomind/native/receipts')));
});

test('migration gate blocks new core writers and interrupted migrations fail closed', (t) => {
  const root = tempRoot(t);
  legacyProject(root);
  const gate = join(root, '.neomind-migration.lock');
  writeFileSync(gate, 'Interrupted migration fixture.');
  assert.throws(() => record(root), /migration is active/i);
  assert.throws(() => migrateStorage(root), /migration lock exists/i);
  assert.equal(existsSync(join(root, '.neomind')), false);
  assert.equal(readFileSync(gate, 'utf8'), 'Interrupted migration fixture.');
  rmSync(gate);
  const receipts = join(root, '.verythinker/native/receipts');
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, `${randomUUID()}.json`), JSON.stringify({ state: 'unknown-state' }));
  assert.throws(() => migrateStorage(root), /active/i);
  assert.equal(existsSync(gate), false);
});
