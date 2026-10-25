import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, realpathSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as acceptance from '../dist/controlled-acceptance.js';
import { hash } from '../dist/storage.js';

function fixture(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-fingerprint-')));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return root;
}
const scan = (root, paths, options) => acceptance.controlledFingerprintsAsync
  ? acceptance.controlledFingerprintsAsync(root, paths, options) : Promise.resolve(acceptance.controlledFingerprints(root, paths));

test('preservation hashing yields to an actual concurrent HTTP heartbeat instead of monopolizing its host', async t => {
  const root = fixture(t); mkdirSync(join(root, 'tree'));
  for (let index = 0; index < 256; index++) writeFileSync(join(root, 'tree', `${String(index).padStart(4, '0')}.txt`), `preserved-${index}\n`);
  const server = createServer((_req, res) => res.end('heartbeat'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let heartbeat = false;
  const response = new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${server.address().port}`, res => { res.resume(); res.on('end', () => { heartbeat = true; resolve(); }); });
    request.on('error', reject);
  });
  const result = await scan(root, ['tree', 'missing.txt']);
  const heartbeatDuringScan = heartbeat;
  await response;
  assert.equal(heartbeatDuringScan, true, 'An outstanding host heartbeat must finish before a whole preservation tree is hashed.');
  assert.equal(Object.keys(result).length, 257); assert.equal(result['missing.txt'], 'missing');
  assert.equal(result['tree/0000.txt'], hash('preserved-0\n'));
  assert.deepEqual(result, Object.fromEntries([...Array.from({ length: 256 }, (_, index) => [
    `tree/${String(index).padStart(4, '0')}.txt`, hash(`preserved-${index}\n`)]), ['missing.txt', 'missing']]), 'Frozen contract hashes and ordering remain unchanged.');
  const subset = ['tree/0000.txt', 'tree/0001.txt', 'missing.txt'];
  assert.deepEqual(acceptance.controlledFingerprints(root, subset), Object.fromEntries(subset.map(path => [path, result[path]])));
});

test('metadata inventory rejects oversized files and aggregate/count bounds before content hashing', async t => {
  const root = fixture(t); mkdirSync(join(root, 'tree'));
  for (let index = 0; index < 4; index++) writeFileSync(join(root, 'tree', `${index}.txt`), '12345678');
  await assert.rejects(scan(root, ['tree'], { limits: { max_files: 3 } }), /file count limit/);
  await assert.rejects(scan(root, ['tree'], { limits: { max_total_bytes: 24 } }), /total byte limit/);
  await assert.rejects(scan(root, ['tree'], { limits: { max_entries: 3 } }), /directory entry limit/);
  writeFileSync(join(root, 'oversized.bin'), ''); truncateSync(join(root, 'oversized.bin'), 512 * 1024 * 1024);
  await assert.rejects(scan(root, ['oversized.bin']), /per-file byte limit/);
  assert.throws(() => acceptance.controlledFingerprints(root, ['oversized.bin']), /per-file byte limit/);
  await assert.rejects(scan(root, ['tree'], { limits: { max_files: 8192 } }), /only be tightened/);
});

test('cancellation and path/link safety fail closed without following linked ancestors or hardlinks', async t => {
  const root = fixture(t); mkdirSync(join(root, 'tree')); writeFileSync(join(root, 'tree/value.txt'), 'one\n');
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(scan(root, ['tree'], { signal: cancel.signal }), /abort/i);
  await assert.rejects(scan(root, ['../outside']), /canonical/);
  linkSync(join(root, 'tree/value.txt'), join(root, 'hard.txt'));
  await assert.rejects(scan(root, ['hard.txt']), /ordinary unlinked/);
  // A directory link into the same project must still be refused: containment
  // alone does not establish immutable preservation identity.
  symlinkSync(join(root, 'tree'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(scan(root, ['alias/value.txt']), /cannot follow links/);
  assert.throws(() => acceptance.controlledFingerprints(root, ['alias/value.txt']), /cannot follow links/);
});

test('one acceptance deadline is shared across artifact groups and cannot be extended', t => {
  const root = fixture(t); writeFileSync(join(root, 'first.txt'), 'first\n'); writeFileSync(join(root, 'second.txt'), 'second\n');
  const budget = acceptance.controlledAcceptanceBudget(root, 100);
  assert.deepEqual(budget.fingerprints(['first.txt']), { 'first.txt': hash('first\n') });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 110);
  assert.throws(() => budget.fingerprints(['second.txt']), /shared 100 ms verification budget/,
    'The second group must not start a fresh deadline after earlier verification work spent it.');
  assert.deepEqual(acceptance.controlledFingerprints(root, ['second.txt']), { 'second.txt': hash('second\n') }, 'Expiry concerns the cumulative budget, not incorrect artifact content.');
  assert.throws(() => acceptance.controlledAcceptanceBudget(root, 8001), /only be tightened/);
});
