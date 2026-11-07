import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as filesystem from 'node:fs';
import * as promises from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(repository, 'resources/opencode-bootstrap/seed.cjs'), 'utf8');
const require = createRequire(import.meta.url);

function fixture(t, fileCount = 16) {
  const directory = mkdtempSync(join(tmpdir(), 'workforce-bootstrap-seed '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const from = join(directory, 'reviewed bootstrap'), destination = join(directory, 'private copy');
  mkdirSync(join(from, 'node_modules/package/empty'), { recursive: true });
  mkdirSync(destination);
  writeFileSync(join(from, 'package.json'), '{"private":true}\n');
  writeFileSync(join(from, 'package-lock.json'), '{"lockfileVersion":3}\n');
  for (let index = 0; index < fileCount; index++)
    writeFileSync(join(from, 'node_modules/package', `file-${index}.bin`), Buffer.alloc(8192, index % 256));
  return { directory, from, destination };
}

async function workerCopy(from, destination) {
  const worker = new Worker(source, { eval: true, execArgv: [], workerData: { source: from, destination } });
  let result;
  worker.on('message', value => { result = value; });
  const code = await new Promise((fulfill, reject) => { worker.once('exit', fulfill); worker.once('error', reject); });
  return { code, result };
}

function entries(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(item => {
    const path = join(prefix, item.name);
    return item.isDirectory() ? [path, ...entries(root, path)] : [path];
  }).sort();
}

test('bootstrap worker copies exact bytes and empty directories into independently mutable private files', async t => {
  const { from, destination } = fixture(t);
  assert.deepEqual(await workerCopy(from, destination), { code: 0, result: { copied: true } });
  assert.deepEqual(entries(destination), entries(from));
  for (const entry of entries(from)) {
    const original = join(from, entry), copied = join(destination, entry);
    if (lstatSync(original).isFile()) {
      assert.deepEqual(readFileSync(copied), readFileSync(original), entry);
      assert.equal(lstatSync(copied).nlink, 1, 'Mutable copies must not be hard links.');
    }
  }
  const edited = join(destination, 'node_modules/package/file-0.bin');
  writeFileSync(edited, 'private edit');
  assert.equal(readFileSync(join(from, 'node_modules/package/file-0.bin')).length, 8192);
});

test('bootstrap worker preserves existing destination files and returns only a fixed failure code', async t => {
  const { from, destination } = fixture(t);
  writeFileSync(join(destination, 'package.json'), 'MUST_REMAIN');
  const result = await workerCopy(from, destination);
  assert.deepEqual(result, { code: 1, result: { copied: false, code: 'BOOTSTRAP_COPY_FAILED' } });
  assert.equal(readFileSync(join(destination, 'package.json'), 'utf8'), 'MUST_REMAIN');
  assert.doesNotMatch(JSON.stringify(result), /private copy|reviewed bootstrap|MUST_REMAIN/);
});

test('bootstrap worker rejects links outside the reviewed tree without copying their contents', async t => {
  const { directory, from, destination } = fixture(t);
  const outside = join(directory, 'unreviewed'); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.bin'), 'DO_NOT_COPY');
  symlinkSync(outside, join(from, 'node_modules/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await workerCopy(from, destination), { code: 1, result: { copied: false, code: 'BOOTSTRAP_LINK_OUTSIDE' } });
  assert.equal(existsSync(join(destination, 'node_modules/escape/secret.bin')), false);
});

test('bootstrap worker dereferences reviewed internal directory links without creating shared links', async t => {
  const { from, destination } = fixture(t);
  symlinkSync(join(from, 'node_modules/package'), join(from, 'node_modules/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await workerCopy(from, destination), { code: 0, result: { copied: true } });
  assert.equal(lstatSync(join(destination, 'node_modules/alias')).isSymbolicLink(), false);
  assert.deepEqual(readFileSync(join(destination, 'node_modules/alias/file-0.bin')), readFileSync(join(from, 'node_modules/package/file-0.bin')));
});

test('bootstrap worker rejects an internal directory link cycle instead of traversing indefinitely', { timeout: 10_000 }, async t => {
  const { from, destination } = fixture(t);
  symlinkSync(join(from, 'node_modules'), join(from, 'node_modules/package/loop'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await workerCopy(from, destination), { code: 1, result: { copied: false, code: 'BOOTSTRAP_COPY_FAILED' } });
});

test('a cancellation queued before worker startup is acknowledged through the actual worker channel', { timeout: 10_000 }, async t => {
  const { from, destination } = fixture(t, 64);
  const worker = new Worker(source, { eval: true, execArgv: [], workerData: { source: from, destination } });
  let result;
  worker.on('message', value => { result = value; });
  worker.postMessage({ type: 'cancel' });
  const code = await new Promise((fulfill, reject) => { worker.once('exit', fulfill); worker.once('error', reject); });
  assert.deepEqual({ code, result }, { code: 1, result: { copied: false, code: 'BOOTSTRAP_COPY_CANCELLED' } });
  const afterExit = entries(destination);
  await new Promise(setImmediate);
  assert.deepEqual(entries(destination), afterExit, 'The exited sole writer must not change its copy afterward.');
});

test('actual worker script bounds asynchronous copies and drains active I/O before cancellation completes', async t => {
  const { from, destination } = fixture(t, 64);
  const port = new EventEmitter(), results = [], processState = { platform: process.platform };
  let active = 0, maximum = 0, started = 0, synchronous = 0, cancelled = false, closed = false;
  const releases = [];
  port.postMessage = value => { results.push(value); };
  port.close = () => { assert.equal(active, 0, 'The worker must drain its copies before reporting exit.'); closed = true; };
  const fsPromises = { ...promises, copyFile: async (...args) => {
    assert.equal(cancelled, false, 'Cancellation must stop queued copies from starting.');
    active++; started++; maximum = Math.max(maximum, active);
    await new Promise(fulfill => { releases.push(fulfill); });
    try { return await promises.copyFile(...args); } finally { active--; }
  } };
  const fsSync = { ...filesystem, constants, cpSync: (...args) => { synchronous++; return filesystem.cpSync(...args); } };
  const completion = runInNewContext(source, {
    require(name) {
      if (name === 'node:worker_threads') return { parentPort: port, workerData: { source: from, destination } };
      if (name === 'node:fs/promises') return fsPromises;
      if (name === 'node:fs') return fsSync;
      return require(name);
    },
    process: processState, setImmediate, Buffer,
  }, { filename: 'actual-bootstrap-worker.cjs' });
  // Observe overlap at a controlled I/O seam; do not depend on disk speed.
  for (let tick = 0; tick < 200 && releases.length < 2 && !results.length; tick++) await new Promise(setImmediate);
  assert.equal(synchronous, 0, 'A synchronous full-tree copy prevents cancellation from being serviced.');
  assert.ok(releases.length >= 2, 'Independent copies must overlap rather than block the worker loop.');
  assert.ok(maximum <= 8, 'Preparation must keep its bounded resource limit.');
  cancelled = true; port.emit('message', { type: 'cancel' });
  const startedAtCancellation = started;
  releases.forEach(release => release());
  await completion;
  assert.equal(started, startedAtCancellation);
  assert.equal(active, 0);
  assert.equal(closed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(results)), [{ copied: false, code: 'BOOTSTRAP_COPY_CANCELLED' }]);
  assert.equal(processState.exitCode, 1);
});
