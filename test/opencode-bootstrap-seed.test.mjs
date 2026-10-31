import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getRuntimeBuildFingerprint } from '../dist/runtime-info.js';

const source = readFileSync(new URL('../resources/opencode-bootstrap/seed.cjs', import.meta.url), 'utf8');
const temporary = resolve('artifacts/test-temp');
function fixture(t) {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'wf-bootstrap-worker-'));
  t.after(() => { assert.equal(dirname(root), temporary); rmSync(root, { recursive: true, force: true }); });
  const origin = join(root, 'origin'), destination = join(root, 'private-copy');
  mkdirSync(join(origin, 'node_modules/package'), { recursive: true }); mkdirSync(destination);
  writeFileSync(join(origin, 'package.json'), '{"private":true}\n');
  writeFileSync(join(origin, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(origin, 'node_modules/package/current.js'), 'original dependency\n');
  return { root, origin, destination };
}
async function copy(origin, destination) {
  const worker = new Worker(source, { eval: true, execArgv: [], workerData: { source: origin, destination } });
  let result, failed = false;
  worker.once('message', value => { result = value; }); worker.once('error', () => { failed = true; });
  const exit = await new Promise(resolve => worker.once('exit', resolve));
  return { exit, failed, result };
}

test('actual bootstrap worker creates independent dependencies while the owner event loop stays available', async t => {
  const { origin, destination } = fixture(t);
  let ticked = false; const timer = setTimeout(() => { ticked = true; }, 0); t.after(() => clearTimeout(timer));
  assert.deepEqual(await copy(origin, destination), { exit: 0, failed: false, result: { copied: true } });
  assert.equal(ticked, true);
  assert.equal(readFileSync(join(destination, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}\n');
  writeFileSync(join(destination, 'node_modules/package/current.js'), 'engine-specific mutation\n');
  assert.equal(readFileSync(join(origin, 'node_modules/package/current.js'), 'utf8'), 'original dependency\n');
});

test('actual bootstrap worker rejects an escaping dependency link before copying external contents', async t => {
  const { root, origin, destination } = fixture(t), outside = join(root, 'outside');
  mkdirSync(outside); writeFileSync(join(outside, 'protected.txt'), 'outside private data\n');
  symlinkSync(outside, join(origin, 'node_modules/external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await copy(origin, destination), { exit: 1, failed: false,
    result: { copied: false, code: 'BOOTSTRAP_LINK_OUTSIDE' } });
  assert.equal(existsSync(join(destination, 'node_modules/external/protected.txt')), false);
  assert.equal(readFileSync(join(outside, 'protected.txt'), 'utf8'), 'outside private data\n');
});

test('actual bootstrap worker dereferences reviewed links that remain inside the bootstrap tree', async t => {
  const { origin, destination } = fixture(t), approved = join(origin, 'approved');
  mkdirSync(approved); writeFileSync(join(approved, 'inside.txt'), 'reviewed dependency\n');
  symlinkSync(approved, join(origin, 'node_modules/internal'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await copy(origin, destination), { exit: 0, failed: false, result: { copied: true } });
  assert.equal(readFileSync(join(destination, 'node_modules/internal/inside.txt'), 'utf8'), 'reviewed dependency\n');
});

test('actual bootstrap worker failure is terminal and emits no filesystem paths or source data', async t => {
  const { root, destination } = fixture(t), secretPath = join(root, 'PRIVATE_MISSING_SOURCE');
  const result = await copy(secretPath, destination);
  assert.deepEqual(result, { exit: 1, failed: false, result: { copied: false, code: 'BOOTSTRAP_COPY_FAILED' } });
  assert.equal(JSON.stringify(result).includes(secretPath), false);
});

test('the copied worker resource participates in the approved runtime build identity', t => {
  const { root } = fixture(t), directory = join(root, 'resources/opencode-bootstrap');
  mkdirSync(directory, { recursive: true }); writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  writeFileSync(join(directory, 'seed.cjs'), source);
  const before = getRuntimeBuildFingerprint(root);
  writeFileSync(join(directory, 'seed.cjs'), `${source}\n// changed approved helper\n`);
  assert.notEqual(getRuntimeBuildFingerprint(root), before);
});
