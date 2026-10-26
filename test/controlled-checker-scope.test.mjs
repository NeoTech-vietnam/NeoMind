import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlledFingerprints } from '../dist/controlled-acceptance.js';
import { captureControlledCheckerScope, controlledCheckerScopeCurrent, projectControlledCheckerScope } from '../dist/controlled-checker-scope.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-checker-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'checks'));
  const write = (path, content) => writeFileSync(join(root, path), content);
  write('checks/check.cjs', 'module.exports = require("./helper.cjs");\n');
  write('checks/helper.cjs', 'module.exports = 6;\n');
  return { root, write, capture: (roots = ['checks']) => captureControlledCheckerScope(roots, paths => controlledFingerprints(root, paths)) };
}

test('an omitted imported helper is covered by the post-execution checker scope without altering explicit baseline', t => {
  const a = fixture(t), baseline = controlledFingerprints(a.root, ['checks/check.cjs']), seal = a.capture();
  assert.equal(Object.hasOwn(baseline, 'checks/helper.cjs'), false);
  assert.match(seal.files['checks/helper.cjs'], /^[a-f0-9]{64}$/);
  const receipt = { passed: true, baseline, checker_scope: seal }, original = JSON.stringify(receipt);
  a.write('checks/helper.cjs', 'module.exports = 7;\n');
  assert.deepEqual(controlledFingerprints(a.root, ['checks/check.cjs']), baseline);
  assert.equal(controlledCheckerScopeCurrent(seal, a.capture()), false);
  const projected = projectControlledCheckerScope(receipt, a.capture());
  assert.equal(projected.observed_passed, true); assert.equal(projected.passed, false); assert.equal(projected.checker_scope_current, false);
  assert.equal(JSON.stringify(receipt), original, 'No old receipt or explicit baseline was refreshed.');
});

test('checker helper additions and deletions stale the old seal while independent current reads stay fresh', t => {
  const a = fixture(t), original = a.capture();
  a.write('checks/added.cjs', 'module.exports = 1;\n');
  const added = a.capture(); assert.equal(controlledCheckerScopeCurrent(original, added), false);
  rmSync(join(a.root, 'checks/helper.cjs'));
  const removed = a.capture(); assert.equal(controlledCheckerScopeCurrent(added, removed), false);
  assert.equal(controlledCheckerScopeCurrent(removed, a.capture()), true);
  a.write('checks/helper.cjs', 'module.exports = 8;\n');
  assert.equal(controlledCheckerScopeCurrent(removed, a.capture()), false, 'No cross-call snapshot cache masks an outside edit.');
});

test('Unicode checker names have a code-unit canonical digest independent of insertion order or locale collation', t => {
  const a = fixture(t);
  a.write('checks/điều-kiện.cjs', 'module.exports = 1;\n');
  a.write('checks/Ä-check.cjs', 'module.exports = 2;\n');
  const first = a.capture(), reversed = Object.fromEntries(Object.entries(first.files).reverse());
  const compare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function() { throw new Error('Locale collation must not define a retained checksum.'); };
    const second = captureControlledCheckerScope(['checks'], () => reversed);
    assert.equal(second.sha256, first.sha256);
    assert.equal(controlledCheckerScopeCurrent(first, second), true);
  } finally { String.prototype.localeCompare = compare; }
});

test('approved empty and missing checker roots are represented without creating directories', t => {
  const a = fixture(t), missing = a.capture(['unused']);
  assert.deepEqual(missing.roots, ['unused']); assert.deepEqual(missing.files, { unused: 'missing' });
  assert.equal(controlledCheckerScopeCurrent(missing, a.capture(['unused'])), true);
  mkdirSync(join(a.root, 'unused'));
  const empty = a.capture(['unused']); assert.deepEqual(empty.files, {});
  assert.equal(controlledCheckerScopeCurrent(missing, empty), false);
  assert.equal(controlledCheckerScopeCurrent(empty, a.capture(['unused'])), true);
});

test('a positive checker may generate an approved negative fixture before its postseal and the negative read preserves it', t => {
  const a = fixture(t);
  mkdirSync(join(a.root, 'checks/negative'));
  a.write('checks/negative/value.json', '{"value":0}\n');
  const positive = a.capture();
  assert.equal(JSON.parse(readFileSync(join(a.root, 'checks/negative/value.json'), 'utf8')).value, 0);
  const negative = a.capture();
  assert.equal(controlledCheckerScopeCurrent(positive, negative), true);
  assert.equal(controlledCheckerScopeCurrent(negative, a.capture()), true);
  a.write('checks/negative/value.json', '{"value":1}\n');
  assert.equal(controlledCheckerScopeCurrent(positive, a.capture()), false, 'Fixture bytes are never silently excluded or resealed.');
});

test('historical unsealed receipts and altered scope metadata cannot become current proof', t => {
  const a = fixture(t), current = a.capture();
  assert.equal(projectControlledCheckerScope({ passed: true }, current).passed, false);
  for (const saved of [{ ...current, sha256: '0'.repeat(64) }, { ...current, roots: ['other'] },
    { ...current, files: { ...current.files, 'outside/helper.cjs': 'a'.repeat(64) } }])
    assert.equal(controlledCheckerScopeCurrent(saved, current), false);
  const failed = projectControlledCheckerScope({ passed: false, checker_scope: current }, current);
  assert.equal(failed.passed, false); assert.equal(failed.observed_passed, false);
});

test('scope capture retains existing fingerprint quotas and rejects linked scope inputs', t => {
  const a = fixture(t);
  assert.throws(() => captureControlledCheckerScope(['checks'], paths => controlledFingerprints(a.root, paths, { limits: { max_files: 1 } })), /file count limit/);
  try { symlinkSync(join(a.root, 'checks/helper.cjs'), join(a.root, 'checks/link.cjs')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  assert.throws(() => a.capture(), /links/);
});
