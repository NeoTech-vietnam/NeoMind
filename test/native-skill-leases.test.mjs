// Host-owned capability leases retain pinned guidance; ordinary project/checker
// dependencies continue to compare their actual bytes without exemptions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, hash } from '../dist/storage.js';
import { installWorkspaceSkillComponents, controlWorkspaceSkillComponent } from '../dist/workspace-skill-components.js';
import { acquireNativeCapabilityLease, releaseNativeCapabilityLease, drainNativeCapabilityControls } from '../dist/native-capability-leases.js';
import * as skillContext from '../dist/native-skill-context.js';

const { resolveNativeSkills, nativeSkillReceiptDependencies } = skillContext;
const ordinaryDependencies = (...args) =>
  (skillContext.nativeSkillDependencies ?? nativeSkillReceiptDependencies)(...args);
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-skill-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-SKILL-LEASE' });
  const files = new Map([['LICENSE', 'MIT License\n'], ['skills/guide/SKILL.md',
    '---\nname: guide\ndescription: Pinned checking guidance\n---\nRead references/check.md.\n'],
    ['skills/guide/references/check.md', '# Check\nVerify the actual requested product.\n']]);
  const installed = await installWorkspaceSkillComponents(root, {
    approved: true, repository: 'https://github.com/example/approved-guidance', commit: 'a'.repeat(40),
    license_path: 'LICENSE', skills: [{ source_path: 'skills/guide', target_name: 'guide',
      files: ['skills/guide/SKILL.md', 'skills/guide/references/check.md'] }],
  }, async input => ({ ...input, kind: 'file', complete: true, content: files.get(input.path) }));
  return { root, installed, contexts: resolveNativeSkills(root, ['guide']) };
}

test('ordinary explicit asset paths retain raw semantics while the receipt-only API stays compatible', async t => {
  const { root, contexts } = await fixture(t), receipt = contexts[0].receipt_path;
  const asset = contexts[0].files.find(file => file.path.endsWith('references/check.md')).path;
  assert.deepEqual(ordinaryDependencies(root, contexts, [asset]), [asset]);
  assert.deepEqual(ordinaryDependencies(root, contexts, ['.github/skills/guide/references']), [asset]);
  assert.deepEqual(ordinaryDependencies(root, contexts, ['.']), [], 'The project root is not an explicit host-guidance dependency');
  assert.deepEqual(nativeSkillReceiptDependencies(root, contexts, [asset]), [], 'Legacy receipt callers keep their documented result shape');
  assert.deepEqual(ordinaryDependencies(root, contexts, [receipt]), [receipt]);
});

test('ordinary checker source and argv can depend on a selected asset without naming its receipt', async t => {
  const { root, contexts } = await fixture(t);
  const asset = contexts[0].files.find(file => file.path.endsWith('references/check.md')).path;
  mkdirSync(join(root, 'checks'));
  writeFileSync(join(root, 'checks/asset.mjs'), `require('node:fs').readFileSync(${JSON.stringify(asset)});\n`);
  assert.deepEqual(ordinaryDependencies(root, contexts, [], [process.execPath, 'checks/asset.mjs']), [asset]);
  assert.deepEqual(ordinaryDependencies(root, contexts, [], [process.execPath, '-e', 'process.exit(0)', asset]), [asset]);
  assert.deepEqual(ordinaryDependencies(root, contexts, [], [process.execPath, '-e', "require('node:fs').readdirSync('.github/skills/guide/references')"]), [asset]);
  writeFileSync(join(root, 'checks/ordinary.mjs'), 'process.exit(0);\n');
  assert.deepEqual(ordinaryDependencies(root, contexts, [], [process.execPath, 'checks/ordinary.mjs']), []);
});

test('uninspectable checker content conservatively retains all receipt and asset dependencies', async t => {
  const { root, contexts } = await fixture(t);
  const expected = [contexts[0].receipt_path, ...contexts[0].files.map(file => file.path)];
  mkdirSync(join(root, 'checks'));
  writeFileSync(join(root, 'checks/encoded.ps1'), Buffer.from([0xff, 0xfe, 0x61, 0]));
  assert.deepEqual(ordinaryDependencies(root, contexts, [], ['pwsh', '-File', 'checks/encoded.ps1']), expected);
  assert.deepEqual(ordinaryDependencies(root, contexts, [], [process.execPath, 'checks/missing.mjs']), expected);
});

function lease(f, generation = 0) {
  const owner = { request_ref: 'WF-REQUEST-1', assignment_ref: 'request-capabilities', generation };
  const ref = acquireNativeCapabilityLease(f.root, { owner, resources: [{ key: `skill:${f.installed.components[0].id}`,
    fingerprint: f.contexts[0].approval_sha256, skill: f.contexts[0] }] });
  return { owner, ref, contexts: skillContext.bindNativeSkillLease(f.contexts, ref, owner) };
}
const changed = error => error.code === 'SELECTED_SKILL_CHANGED';
const unavailable = error => error.code === 'SELECTED_SKILL_UNAVAILABLE';
function fingerprint(root, paths) {
  return Object.fromEntries(paths.map(path => { try { return [path, hash(readFileSync(join(root, path)))]; }
    catch (error) { if (error.code === 'ENOENT') return [path, null]; throw error; } }));
}
function settle(f, held) {
  releaseNativeCapabilityLease(f.root, held.ref, held.owner, { outcome_sha256: hash('actual settled result') });
  return drainNativeCapabilityControls(f.root, input => controlWorkspaceSkillComponent(f.root, input.key.slice('skill:'.length), input.action));
}

test('pending deactivation closes new selection while an exact live leased skill remains current', async t => {
  const f = await fixture(t), held = lease(f), original = structuredClone(f.contexts);
  const before = fingerprint(f.root, [f.contexts[0].receipt_path, ...f.contexts[0].files.map(file => file.path)]);
  const result = controlWorkspaceSkillComponent(f.root, f.installed.components[0].id, 'disable');
  assert.equal(result.control.state, 'deferred'); assert.equal(result.control.active_count, 1);
  assert.throws(() => resolveNativeSkills(f.root, ['guide']), unavailable);
  assert.throws(() => skillContext.assertNativeSkillsCurrent(f.root, f.contexts), changed, 'An unbound selection does not borrow another owner lease');
  assert.doesNotThrow(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts));
  assert.deepEqual(f.contexts, original, 'Host binding does not mutate previously frozen contexts');
  const prompt = skillContext.nativeSkillPrompt(held.contexts);
  for (const privateValue of [held.ref.id, held.ref.owner_sha256, held.owner.request_ref, held.owner.assignment_ref, 'content_base64'])
    assert.equal(prompt.includes(privateValue), false, 'Host lease metadata and snapshot bytes never enter model-facing guidance');
  assert.deepEqual(fingerprint(f.root, Object.keys(before)), before, 'Pending control has no asset or receipt side effect');
});

test('settled authorized removal bridges only pinned guidance, retaining raw ordinary dependencies and all original maps', async t => {
  const f = await fixture(t), held = lease(f), selected = held.contexts[0];
  const paths = [selected.receipt_path, ...selected.files.map(file => file.path)], expected = fingerprint(f.root, paths), originalExpected = { ...expected };
  const asset = selected.files.find(file => file.path.endsWith('references/check.md')).path;
  controlWorkspaceSkillComponent(f.root, f.installed.components[0].id, 'remove');
  assert.deepEqual(settle(f, held).map(item => item.state), ['applied']);
  assert.throws(() => resolveNativeSkills(f.root, ['guide']), unavailable);
  assert.throws(() => skillContext.assertNativeSkillsCurrent(f.root, f.contexts), changed);
  assert.doesNotThrow(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts));
  const actual = fingerprint(f.root, paths);
  assert.equal(skillContext.nativeSkillInputsMatch(f.root, held.contexts, actual, expected), true);
  assert.equal(skillContext.nativeSkillInputsMatch(f.root, held.contexts, actual, expected, [asset]), false);
  assert.equal(skillContext.nativeSkillInputsMatch(f.root, held.contexts, actual, expected, [selected.receipt_path]), false);
  assert.equal(skillContext.nativeSkillInputsMatch(f.root, held.contexts, { ...actual, [asset]: 'f'.repeat(64) }, expected), false);
  assert.equal(skillContext.nativeSkillInputsMatch(f.root, held.contexts, { ...actual, 'ordinary.txt': hash('new') }, { ...expected, 'ordinary.txt': hash('old') }), false);
  assert.deepEqual(expected, originalExpected); assert.equal(actual[asset], null);
  assert.notEqual(actual[selected.receipt_path], expected[selected.receipt_path], 'Actual provenance never becomes a synthetic old hash');
});

test('a live lease does not forgive manual removal, modified assets, owner substitution or forged context pins', async t => {
  const f = await fixture(t), held = lease(f), asset = held.contexts[0].files[0].path, original = readFileSync(join(f.root, asset));
  writeFileSync(join(f.root, asset), 'User changed this selected asset.\n');
  assert.throws(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts), changed);
  writeFileSync(join(f.root, asset), original);
  for (const modify of [contexts => { contexts[0].lease.owner.generation = 2; }, contexts => { contexts[0].files[0].sha256 = 'f'.repeat(64); },
    contexts => { contexts[0].receipt_sha256 = 'e'.repeat(64); }, contexts => { contexts[0].source.commit = 'b'.repeat(40); }]) {
    const forged = structuredClone(held.contexts); modify(forged);
    assert.throws(() => skillContext.assertNativeSkillsCurrent(f.root, forged), changed);
  }
  releaseNativeCapabilityLease(f.root, held.ref, held.owner, { outcome_sha256: hash('settled without removal') });
  rmSync(join(f.root, asset));
  assert.throws(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts), changed, 'A snapshot alone is not authorization to remove live guidance');
});

test('archival approval is revoked by re-created guidance paths or a changed receipt even after an authorized control', async t => {
  const f = await fixture(t), held = lease(f), selected = held.contexts[0];
  controlWorkspaceSkillComponent(f.root, f.installed.components[0].id, 'disable'); settle(f, held);
  assert.doesNotThrow(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts));
  const asset = selected.files[0].path;
  mkdirSync(join(f.root, '.github/skills/guide'), { recursive: true }); writeFileSync(join(f.root, asset), 'Unowned replacement\n');
  assert.throws(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts), changed);
  rmSync(join(f.root, '.github/skills/guide'), { recursive: true });
  const receiptPath = join(f.root, selected.receipt_path), raw = readFileSync(receiptPath), receipt = JSON.parse(raw);
  receipt.license.text = 'Different approval\n'; receipt.license.bytes = Buffer.byteLength(receipt.license.text); receipt.license.sha256 = hash(receipt.license.text);
  const { integrity, ...unsigned } = receipt; receipt.integrity = hash(JSON.stringify(unsigned));
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  assert.throws(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts), changed);
  writeFileSync(receiptPath, raw);
  assert.doesNotThrow(() => skillContext.assertNativeSkillsCurrent(f.root, held.contexts));
});
