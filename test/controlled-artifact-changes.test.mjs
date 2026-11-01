import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hash, safePath } from '../dist/storage.js';
import { controlledArtifactChanges, artifactChangeReadCoverage, mergeArtifactChangeReadCoverage,
  completeArtifactChangeReads, controlledTextChangeAssessmentPaths, retainControlledProducerOriginals } from '../dist/controlled-artifact-changes.js';

function fixture(t, entries) {
  const root = mkdtempSync(join(tmpdir(), 'wf-artifact-changes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = {};
  for (const [path, content, original = true] of entries) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
    baseline[path] = original ? hash(Buffer.from(content)) : null;
  }
  const run = { workflow_id: 'TEST-KNW-1', epoch_id: 'owned-epoch', contract_hash: 'a'.repeat(64), attempts: [] };
  const contract = { workflow_id: run.workflow_id, epoch_id: run.epoch_id, task_id: 'TEST-TASK-1',
    plan: { outputs: entries.map(([path]) => path) }, producer_baselines: baseline };
  return { root, run, contract, read: page => controlledArtifactChanges(root, run, contract, page) };
}

test('original-content pages retain metadata at 128 characters and accumulate complete coverage across >64K text', t => {
  const original = 'x'.repeat(90000), f = fixture(t, [['README.md', original]]);
  const small = f.read({ path: 'README.md', max_chars: 128 });
  assert.equal(small.files.length, 1); assert.equal(small.files[0].original_text.length, 128);
  assert.equal(small.files[0].next_start_char, 128); assert.equal(small.files[0].before_sha256, hash(original));
  assert.ok(JSON.stringify(small).length <= 64000);
  let cursor = 0, coverage = {}, reconstructed = '', count = 0;
  do {
    const value = f.read({ path: 'README.md', start_char: cursor, max_chars: 64000 }), file = value.files[0];
    assert.equal(file.original_start_char, cursor); assert.ok(file.original_text.length > 0);
    assert.ok(JSON.stringify(value).length <= 64000);
    reconstructed += file.original_text; coverage = mergeArtifactChangeReadCoverage(coverage, artifactChangeReadCoverage(value)); count++;
    cursor = file.next_start_char;
  } while (cursor !== null && count < 10);
  assert.ok(count >= 2); assert.equal(cursor, null); assert.equal(reconstructed, original);
  assert.equal(completeArtifactChangeReads(coverage)['README.md'].before_sha256, hash(original));
  const changed = structuredClone(artifactChangeReadCoverage(small));
  changed['README.md'].current_sha256 = 'b'.repeat(64); changed['README.md'].evidence_sha256 = 'c'.repeat(64);
  const reset = mergeArtifactChangeReadCoverage(coverage, changed);
  assert.equal(completeArtifactChangeReads(reset)['README.md'], undefined, 'New current content cannot inherit old complete original-read proof.');
});

test('new large and binary outputs supply metadata without consuming existing README original-text budget', t => {
  const original = '# Navigation\r\n- [Guide](docs/guide.md)\r\n' + 'A'.repeat(12000);
  const f = fixture(t, [['new.c', 'x'.repeat(120000), false], ['image.bin', Buffer.from([0, 1, 2]), false], ['README.md', original]]);
  const evidence = f.read(), readme = evidence.files.find(file => file.path === 'README.md');
  assert.equal(evidence.files[0].path, 'README.md'); assert.equal(readme.original_text, original);
  assert.equal(readme.original_complete, true); assert.equal(readme.truncated, false);
  for (const path of ['new.c', 'image.bin']) {
    const file = evidence.files.find(file => file.path === path);
    assert.equal(file.available, true); assert.equal(file.change, 'added'); assert.equal(file.before_sha256, null);
    assert.equal(file.original_text, ''); assert.equal(file.diff, '');
  }
  assert.ok(JSON.stringify(evidence).length <= 64000);
});

test('UTF8 BOM and CRLF original text remain byte-faithful and keep raw SHA identity', t => {
  const original = '\uFEFF# Navigation\r\n- [Guide](guide.md)\r\n', f = fixture(t, [['README.md', original]]);
  const file = f.read().files[0];
  assert.equal(file.original_text, original); assert.equal(file.before_sha256, hash(Buffer.from(original)));
  assert.equal(file.original_total_chars, original.length); assert.equal(file.original_text.charCodeAt(0), 0xfeff);
});

test('original-text page cursors preserve complete Unicode code points at UTF16 boundaries', t => {
  const original = 'A'.repeat(127) + '😀\nEnd\n', f = fixture(t, [['README.md', original]]);
  const first = f.read({ path: 'README.md', max_chars: 128 }).files[0];
  assert.equal(first.original_text, 'A'.repeat(127)); assert.equal(first.next_start_char, 127);
  const second = f.read({ path: 'README.md', start_char: first.next_start_char, max_chars: 128 }).files[0];
  assert.ok(second.original_text.startsWith('😀')); assert.equal(first.original_text + second.original_text, original);
  const middle = f.read({ path: 'README.md', start_char: 128, max_chars: 128 }).files[0];
  assert.equal(middle.original_start_char, 127); assert.ok(middle.original_text.startsWith('😀'));
  for (const page of [first, second, middle]) assert.equal(Buffer.from(page.original_text, 'utf8').toString('utf8'), page.original_text);
});

test('binary and oversized existing outputs keep honest hash metadata without an impossible text-assessment gate', t => {
  const f = fixture(t, [['image.bin', Buffer.from([0, 1, 2])], ['large.txt', 'x'.repeat(150000)]]);
  writeFileSync(join(f.root, 'image.bin'), Buffer.from([0, 2, 3])); writeFileSync(join(f.root, 'large.txt'), 'y'.repeat(150000));
  const evidence = f.read();
  for (const file of evidence.files) {
    assert.equal(file.available, false); assert.equal(file.reason, 'NOT_A_BOUNDED_TEXT_OUTPUT');
    assert.equal(typeof file.current_sha256, 'string'); assert.equal(file.text_supported, false);
  }
  assert.deepEqual(controlledTextChangeAssessmentPaths(f.root, f.contract), []);
});

test('declared directory baselines retain bounded expanded files without reclassifying them as new', t => {
  const f = fixture(t, [['bundle/README.md', '# Existing directory output\n']]);
  f.contract.plan.outputs = ['bundle'];
  const file = f.read({ path: 'bundle/README.md', max_chars: 128 }).files[0];
  assert.equal(file.change, 'unchanged'); assert.equal(file.before_sha256, f.contract.producer_baselines['bundle/README.md']);
  assert.equal(file.original_text, '# Existing directory output\n');
});

test('Windows evidence path aliases resolve the canonical sealed baseline key', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, [['README.md', '# Original\n']]);
  const file = f.read({ path: 'readme.md', max_chars: 128 }).files[0];
  assert.equal(file.path, 'README.md'); assert.equal(file.before_sha256, hash('# Original\n'));
  assert.equal(file.change, 'unchanged'); assert.equal(file.original_text, '# Original\n');
});

test('old contracts and missing owned write history cannot invent original content or strengthen assurance', t => {
  const f = fixture(t, [['README.md', '# Before\n']]);
  delete f.contract.producer_baselines;
  assert.equal(f.read().reason, 'NO_ORIGINAL_EDITABLE_BASELINE');
  f.contract.producer_baselines = { 'README.md': hash('# Before\n') }; writeFileSync(join(f.root, 'README.md'), '# After\n');
  const file = f.read().files[0];
  assert.equal(file.available, false); assert.equal(file.reason, 'ORIGINAL_BASELINE_UNAVAILABLE');
  assert.equal(file.original_text, null); assert.equal(file.history_authenticated, false);
  assert.equal(completeArtifactChangeReads(artifactChangeReadCoverage(f.read()))['README.md'], undefined);
  assert.throws(() => f.read({ path: '.codex/auth.json' }));
  assert.throws(() => f.read({ path: 'README.md/../private.txt' }));
  assert.throws(() => controlledArtifactChanges(f.root, { ...f.run, epoch_id: 'other' }, f.contract));
});

test('immutable plan preimages serve any producer path and survive interrupted inference without a healthy report', t => {
  const original = '# Navigation\n- [Guide](guide.md)\n', f = fixture(t, [['README.md', original]]);
  retainControlledProducerOriginals(f.root, f.run, f.contract.producer_baselines);
  // A managed compiler or bounded script need not use the task_file_write journal.
  writeFileSync(join(f.root, 'README.md'), '# Navigation\n- [New](new.md)\n');
  f.run.attempts = [{ stage: 'implementation', role: 'developer', state: 'interrupted' }];
  const file = f.read().files[0];
  assert.equal(file.original_text, original); assert.equal(file.before_sha256, hash(original));
  assert.equal(file.history_authenticated, true); assert.match(file.diff, /-- \[Guide\]\(guide\.md\)/);
  assert.equal(completeArtifactChangeReads(artifactChangeReadCoverage(f.read()))['README.md'].current_sha256,
    hash('# Navigation\n- [New](new.md)\n'));
});

test('large changed originals can be fully assessed through pages even when the navigational diff stays truncated', t => {
  const original = 'A'.repeat(90000), f = fixture(t, [['README.md', original]]);
  retainControlledProducerOriginals(f.root, f.run, f.contract.producer_baselines);
  writeFileSync(join(f.root, 'README.md'), 'B'.repeat(100000));
  let cursor = 0, coverage = {}, count = 0, diffWasTruncated = false;
  do {
    const evidence = f.read({ path: 'README.md', start_char: cursor, max_chars: 64000 }), file = evidence.files[0];
    assert.equal(file.available, true); assert.ok(file.original_text.length > 0);
    coverage = mergeArtifactChangeReadCoverage(coverage, artifactChangeReadCoverage(evidence));
    diffWasTruncated ||= !file.diff_complete; cursor = file.next_start_char; count++;
  } while (cursor !== null && count < 10);
  assert.equal(cursor, null); assert.ok(count >= 2); assert.equal(diffWasTruncated, true);
  assert.equal(completeArtifactChangeReads(coverage)['README.md'].current_sha256, hash('B'.repeat(100000)));
});

test('corrupted original snapshot cannot be replaced with later product bytes or support a preservation pass', t => {
  const original = '# Before\n', f = fixture(t, [['README.md', original]]);
  retainControlledProducerOriginals(f.root, f.run, f.contract.producer_baselines);
  const retained = `.neomind/controlled/workflows/${hash(f.run.workflow_id)}.${f.run.epoch_id}.producer-originals/${hash('README.md')}.${hash(original)}.utf8`;
  writeFileSync(safePath(f.root, retained), '# Tampered\n'); writeFileSync(join(f.root, 'README.md'), '# After\n');
  const file = f.read().files[0];
  assert.equal(file.available, false); assert.equal(file.reason, 'ORIGINAL_BASELINE_UNAVAILABLE');
  assert.equal(file.original_text, null); assert.deepEqual(completeArtifactChangeReads(artifactChangeReadCoverage(f.read())), {});
  assert.throws(() => retainControlledProducerOriginals(f.root, f.run, f.contract.producer_baselines), /changed/);
});

test('private descendants of a declared output scope never enter original-text projection', t => {
  const f = fixture(t, [['bundle/README.md', '# Public\n'], ['bundle/.env', 'PRIVATE_CANARY=secret\n']]);
  f.contract.plan.outputs = ['bundle'];
  retainControlledProducerOriginals(f.root, f.run, f.contract.producer_baselines);
  const evidence = f.read(), serialized = JSON.stringify(evidence);
  assert.equal(evidence.private_path_count, 1); assert.equal(evidence.files.length, 1);
  assert.doesNotMatch(serialized, /PRIVATE_CANARY|bundle\/\.env|secret/);
});

test('plan preimage retention cannot follow a private snapshot directory link outside its project', t => {
  const f = fixture(t, [['README.md', '# Before\n']]), external = mkdtempSync(join(tmpdir(), 'wf-original-external-'));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const folder = safePath(f.root, `.neomind/controlled/workflows/${hash(f.run.workflow_id)}.${f.run.epoch_id}.producer-originals`);
  mkdirSync(dirname(folder), { recursive: true });
  try { symlinkSync(external, folder, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('This host cannot create a test directory link.'); return; } throw error; }
  assert.throws(() => retainControlledProducerOriginals(f.root, f.run, f.contract.producer_baselines), /link/i);
  assert.deepEqual(readdirSync(external), []);
});
