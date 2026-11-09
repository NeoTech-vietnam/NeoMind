import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initialize, readConfig, loadRecords } from '../dist/storage.js';
import { prepareNativeWork } from '../dist/native-work.js';
const materializerModule = new URL('../dist/workspace-skill-components.js', import.meta.url).href;
const { installWorkspaceSkillComponents, controlWorkspaceSkillComponent, listWorkspaceSkillComponents,
  readWorkspaceSkillReceiptSnapshot } = await import(materializerModule);

const repository = 'https://github.com/example/approved-skills', commit = 'a'.repeat(40);
const sourceRoot = 'plugins/testing/skills/example-testing';
const skill = Buffer.from('---\r\nname: example-testing\r\ndescription: Test approved scenarios\r\n---\r\n# Original skill\r\nRead [scenarios](references/scenarios.md).\r\n');
const license = Buffer.from('MIT License\nCopyright Test Authors\n');
function fixture(t, second = false) {
  const parent = fs.realpathSync.native(tmpdir()), root = fs.mkdtempSync(join(parent, 'wf-skill-components-'));
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(parent + sep) && basename(absolute).startsWith('wf-skill-components-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const files = new Map([
    ['LICENSE', license],
    [`${sourceRoot}/SKILL.md`, skill],
    [`${sourceRoot}/references/scenarios.md`, Buffer.from('# Scenarios\nEmpty, singleton, repeated.\n')],
    [`${sourceRoot}/assets/icon.bin`, Buffer.from([0, 255, 1, 128])],
  ]);
  const approval = { approved: true, repository, commit, license_path: 'LICENSE',
    skills: [{ source_path: sourceRoot, target_name: 'example-testing', files: [...files.keys()].filter(p => p !== 'LICENSE') }] };
  if (second) {
    const secondRoot = 'plugins/testing/skills/another-testing';
    files.set(`${secondRoot}/SKILL.md`, Buffer.from('---\nname: another-testing\ndescription: Independent approved scenario\n---\n# Another\n'));
    approval.skills.push({ source_path: secondRoot, target_name: 'another-testing', files: [`${secondRoot}/SKILL.md`] });
  }
  const calls = [];
  const reader = async input => {
    calls.push(input);
    const content = files.get(input.path);
    if (!content) throw new Error('PRIVATE transport detail');
    return { repository: input.repository, commit: input.commit, path: input.path, complete: true, kind: 'file', content };
  };
  const target = join(root, '.github', 'skills', 'example-testing');
  const receiptFile = id => join(root, '.workforce', 'capabilities', `${id}.json`);
  return { root, files, approval, reader, calls, target, receiptFile };
}
const code = expected => error => error.code === expected && !error.message.includes('PRIVATE');
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map(path => {
    const full = join(root, path), stat = fs.lstatSync(full);
    return [path, stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : fs.readFileSync(full).toString('base64')];
  });
}

test('source approval revoked during the last awaited read publishes no component or receipt', async t => {
  const f = fixture(t), before = snapshot(f.root);
  let allowed = true;
  const expectedReads = f.files.size;
  const reader = async input => {
    const result = await f.reader(input);
    if (f.calls.length === expectedReads) { await Promise.resolve(); allowed = false; }
    return result;
  };
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, reader, { authorize: () => allowed }), code('POLICY_CHANGED'));
  assert.equal(f.calls.length, expectedReads);
  assert.deepEqual(snapshot(f.root), before, 'Revocation after source preparation must precede all receipt/stage/host writes');
  assert.equal(fs.existsSync(f.target), false);
});

test('materializer authorization is a synchronous boolean function and fails closed before transport', async t => {
  for (const authorize of [null, true, 1, 'yes', {}]) {
    const f = fixture(t);
    await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader, { authorize }), code('INVALID_APPROVAL'));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(snapshot(f.root), []);
  }
  for (const authorize of [() => false, () => undefined, () => Promise.resolve(true), () => Promise.reject(new Error('PRIVATE async policy detail')),
    () => { throw new Error('PRIVATE policy reader details'); }]) {
    const f = fixture(t);
    await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader, { authorize }), code('POLICY_CHANGED'));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(snapshot(f.root), []);
  }
});

test('authorization is rechecked before host publication and retains truthful private partial history on late revocation', async t => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader, { authorize: () => ++calls < 4 }), code('POLICY_CHANGED'));
  assert.equal(calls, 4);
  assert.equal(fs.existsSync(f.target), false);
  const capabilities = join(f.root, '.workforce/capabilities');
  const receipts = fs.existsSync(capabilities) ? fs.readdirSync(capabilities).filter(name => /^workspace-skill-.*\.json$/.test(name)) : [];
  assert.equal(receipts.length, 1, 'The already-written selection is retained as an honest partial operation');
  const receipt = JSON.parse(fs.readFileSync(join(capabilities, receipts[0])));
  assert.equal(receipt.state, 'partial'); assert.equal(receipt.published, false);
  assert.ok(receipt.history.some(event => event.action === 'publication-failed'));
});

test('copies an exact approved portable skill and binary/relative assets without rewriting source or claiming plugin loading', async t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, 'product.md'), 'Keep this generated product.');
  const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const receipt = installed.components[0];
  assert.equal(installed.changed, true);
  assert.equal(receipt.state, 'installed'); assert.equal(receipt.published, true);
  assert.equal(receipt.kind, 'selected-workspace-skill-component');
  assert.equal(receipt.claims.selection, 'exact-files-only');
  assert.equal(receipt.claims.package_completeness, 'not-established');
  assert.equal(installed.plugin_installation, 'not-performed'); assert.equal(installed.host_loading, 'unverified');
  assert.equal(installed.execution, 'not-performed');
  assert.deepEqual(fs.readFileSync(join(f.target, 'SKILL.md')), skill);
  assert.deepEqual(fs.readFileSync(join(f.target, 'assets', 'icon.bin')), Buffer.from([0, 255, 1, 128]));
  assert.deepEqual(fs.readFileSync(join(f.target, 'references', 'scenarios.md')), f.files.get(`${sourceRoot}/references/scenarios.md`));
  assert.equal(receipt.license.text, license.toString());
  assert.equal(receipt.files.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(f.receiptFile(receipt.id))).state, 'installed');
  assert.ok(f.calls.every(call => call.repository === repository && call.commit === commit && call.signal instanceof AbortSignal));
  assert.equal(fs.existsSync(join(f.root, '.vscode')), false);
  assert.equal(fs.readFileSync(join(f.root, 'product.md'), 'utf8'), 'Keep this generated product.');
});

test('duplicate install is idempotent; disable/reinstall/remove retain license, products and immutable prior history', async t => {
  const f = fixture(t), first = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const id = first.components[0].id, originalReceipt = fs.readFileSync(f.receiptFile(id));
  const duplicate = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(fs.readFileSync(f.receiptFile(id)), originalReceipt);
  fs.writeFileSync(join(f.root, 'notes.md'), 'User output remains.');
  const disabled = controlWorkspaceSkillComponent(f.root, id, 'disable');
  assert.equal(disabled.components[0].state, 'disabled');
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(controlWorkspaceSkillComponent(f.root, id, 'disable').changed, false);
  const reinstalled = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  assert.equal(reinstalled.components[0].state, 'installed');
  assert.deepEqual(reinstalled.components[0].history.slice(0, 2), first.components[0].history);
  assert.deepEqual(fs.readFileSync(join(f.target, 'SKILL.md')), skill);
  const removed = controlWorkspaceSkillComponent(f.root, id, 'remove');
  assert.equal(removed.components[0].state, 'removed');
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.readFileSync(join(f.root, 'notes.md'), 'utf8'), 'User output remains.');
  assert.equal(JSON.parse(fs.readFileSync(f.receiptFile(id))).license.text, license.toString());
  assert.equal(removed.components[0].history.at(-1).action, 'remove');
  assert.equal(controlWorkspaceSkillComponent(f.root, id, 'remove').changed, false);
});

test('disable preserves changed skill/user files, removes unchanged owned assets and reports actual retained content', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  const userSkill = Buffer.concat([skill, Buffer.from('\nUser correction.\n')]);
  fs.writeFileSync(join(f.target, 'SKILL.md'), userSkill);
  fs.writeFileSync(join(f.target, 'user-notes.md'), 'Unowned personal data.');
  const disabled = controlWorkspaceSkillComponent(f.root, id, 'disable');
  assert.equal(disabled.components[0].state, 'conflict');
  assert.ok(disabled.components[0].retained_paths.some(p => p.path.endsWith('/SKILL.md') && p.reason === 'changed'));
  assert.deepEqual(fs.readFileSync(join(f.target, 'SKILL.md')), userSkill);
  assert.equal(fs.existsSync(join(f.target, 'assets', 'icon.bin')), false);
  assert.equal(fs.readFileSync(join(f.target, 'user-notes.md'), 'utf8'), 'Unowned personal data.');
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('COLLISION'));
  fs.writeFileSync(join(f.target, 'SKILL.md'), skill);
  const removed = controlWorkspaceSkillComponent(f.root, id, 'remove');
  assert.equal(removed.components[0].state, 'conflict');
  assert.equal(fs.existsSync(join(f.target, 'SKILL.md')), false);
  assert.ok(removed.components[0].retained_paths.some(p => p.reason === 'unowned-content'));
});

test('never adopts an existing identical user skill or publishes any component when another selection collides', async t => {
  const f = fixture(t, true);
  const other = join(f.root, '.github', 'skills', 'another-testing');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(join(other, 'SKILL.md'), f.files.get('plugins/testing/skills/another-testing/SKILL.md'));
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('COLLISION'));
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.existsSync(join(f.root, '.workforce')), false);
  assert.ok(fs.existsSync(join(other, 'SKILL.md')));
});

test('edited owned bytes or metadata are not overwritten and same source pin cannot silently change bytes', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  fs.writeFileSync(join(f.target, 'references', 'scenarios.md'), 'Local revision.');
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('LOCAL_CHANGED'));
  assert.equal(fs.readFileSync(join(f.target, 'references', 'scenarios.md'), 'utf8'), 'Local revision.');
  f.files.set(`${sourceRoot}/assets/icon.bin`, Buffer.from('Changed upstream bytes at the same pin.'));
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('SOURCE_PIN_MISMATCH'));
  const value = JSON.parse(fs.readFileSync(f.receiptFile(id))); value.state = 'removed';
  fs.writeFileSync(f.receiptFile(id), JSON.stringify(value));
  assert.throws(() => controlWorkspaceSkillComponent(f.root, id, 'remove'), code('INVALID_RECEIPT'));
  assert.ok(fs.existsSync(join(f.target, 'SKILL.md')));
});

test('rejects unapproved, unpinned, traversing, Windows-alias and duplicate selections before transport', async t => {
  const f = fixture(t);
  for (const change of [{ approved: false }, { commit: 'main' }, { repository: 'https://PRIVATE@example.invalid/repo' },
    { license_path: '../LICENSE' }, { license_path: '.git/config' }])
    await assert.rejects(installWorkspaceSkillComponents(f.root, { ...f.approval, ...change }, f.reader));
  for (const path of ['../escape', '/absolute', 'C:\\escape', 'plugins/CON.txt', 'plugins/name.', 'plugins/%2e%2e/secret', 'plugins/.workforce/config']) {
    const approval = structuredClone(f.approval); approval.skills[0].source_path = path;
    await assert.rejects(installWorkspaceSkillComponents(f.root, approval, f.reader), code('UNSAFE_PATH'));
  }
  for (const paths of [[`${sourceRoot}/SKILL.md`, `${sourceRoot}/skill.md`], [`${sourceRoot}/SKILL.md`, `${sourceRoot}/assets`, `${sourceRoot}/assets/icon.bin`]]) {
    const approval = structuredClone(f.approval); approval.skills[0].files = paths;
    await assert.rejects(installWorkspaceSkillComponents(f.root, approval, f.reader), code('INVALID_APPROVAL'));
  }
  const duplicate = structuredClone(f.approval); duplicate.skills.push(duplicate.skills[0]);
  await assert.rejects(installWorkspaceSkillComponents(f.root, duplicate, f.reader), code('INVALID_APPROVAL'));
  assert.equal(f.calls.length, 0);
});

test('validates original frontmatter name rather than renaming the imported skill', async t => {
  const f = fixture(t);
  const renamed = structuredClone(f.approval); renamed.skills[0].target_name = 'other-name';
  await assert.rejects(installWorkspaceSkillComponents(f.root, renamed, f.reader), code('INVALID_SKILL'));
  f.files.set(`${sourceRoot}/SKILL.md`, Buffer.from('---\nname: example-testing\nname: duplicate\ndescription: bad\n---\n'));
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('INVALID_SKILL'));
  assert.equal(fs.existsSync(join(f.root, '.github')), false);
  assert.equal(fs.existsSync(join(f.root, '.workforce')), false);
});

test('partial/link/mismatched/oversized or failed source responses never reach host-visible files', async t => {
  const f = fixture(t);
  for (const change of [{ kind: 'symlink' }, { complete: false }])
    await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, async input => ({ ...await f.reader(input), ...change })), code('READ_INCOMPLETE'));
  for (const change of [{ repository: 'https://github.com/other/repo' }, { commit: 'b'.repeat(40) }, { path: 'another-file' }])
    await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, async input => ({ ...await f.reader(input), ...change })), code('SOURCE_PIN_MISMATCH'));
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, async () => { throw new Error('PRIVATE TOKEN'); }), code('READ_FAILED'));
  f.files.set(`${sourceRoot}/assets/icon.bin`, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('BOUND_EXCEEDED'));
  assert.equal(fs.existsSync(join(f.root, '.github')), false);
  assert.equal(fs.existsSync(join(f.root, '.workforce')), false);
});

test('deadline/cancellation stop publication even if injected reader later returns valid bytes', async t => {
  const f = fixture(t);
  let release;
  const delayed = input => new Promise(resolve => { release = () => resolve(f.reader(input)); });
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, delayed, { timeout_ms: 15 }), code('TIMEOUT'));
  release(); await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader, { signal: controller.signal }), code('CANCELLED'));
  assert.equal(fs.existsSync(join(f.root, '.github')), false);
  assert.equal(fs.existsSync(join(f.root, '.workforce')), false);
});

test('rejects linked host/metadata ancestors and preserves external bytes; hardlinks are not removed', async t => {
  const f = fixture(t), outside = join(f.root, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'marker.md'), 'Outside data.');
  fs.symlinkSync(outside, join(f.root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('UNSAFE_PATH'));
  assert.equal(fs.readFileSync(join(outside, 'marker.md'), 'utf8'), 'Outside data.');
  fs.unlinkSync(join(f.root, '.github'));
  const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  fs.unlinkSync(join(f.target, 'SKILL.md')); fs.linkSync(join(outside, 'marker.md'), join(f.target, 'SKILL.md'));
  const linkedView = listWorkspaceSkillComponents(f.root);
  assert.equal(linkedView.components[0].state, 'conflict'); assert.equal(linkedView.components[0].files.state, 'unsafe');
  assert.equal(linkedView.components[0].available, false);
  const disabled = controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'disable');
  assert.equal(disabled.components[0].state, 'conflict');
  assert.ok(disabled.components[0].retained_paths.some(p => p.reason === 'unsafe'));
  assert.equal(fs.readFileSync(join(outside, 'marker.md'), 'utf8'), 'Outside data.');
  const other = fixture(t), metadataOutside = join(other.root, 'outside');
  fs.mkdirSync(metadataOutside); fs.mkdirSync(join(other.root, '.workforce'));
  fs.writeFileSync(join(metadataOutside, 'marker.md'), 'Metadata target is outside ownership.');
  fs.symlinkSync(metadataOutside, join(other.root, '.workforce', 'capabilities'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(listWorkspaceSkillComponents(other.root).state, 'unavailable');
  await assert.rejects(installWorkspaceSkillComponents(other.root, other.approval, other.reader), code('UNSAFE_PATH'));
  assert.equal(fs.readFileSync(join(metadataOutside, 'marker.md'), 'utf8'), 'Metadata target is outside ownership.');
  assert.equal(fs.existsSync(join(other.root, '.github')), false);
});

test('publication failure is durable partial state and never authorizes deleting a later user-created target', async t => {
  const f = fixture(t), original = fs.writeFileSync;
  fs.writeFileSync = function(path, ...args) {
    if (String(path).replaceAll('\\', '/').includes('/staging/') && String(path).endsWith('icon.bin')) throw Object.assign(new Error('PRIVATE DISK ERROR'), { code: 'EIO' });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('FILESYSTEM_FAILED')); }
  finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  const receipts = fs.readdirSync(join(f.root, '.workforce', 'capabilities')).filter(p => p.endsWith('.json'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(fs.readFileSync(join(f.root, '.workforce', 'capabilities', receipts[0])));
  assert.equal(receipt.state, 'partial'); assert.equal(receipt.published, false);
  const partialView = listWorkspaceSkillComponents(f.root);
  assert.equal(partialView.components[0].state, 'partial'); assert.equal(partialView.components[0].available, false);
  assert.deepEqual(fs.readdirSync(join(f.root, '.workforce', 'capabilities', 'staging')), []);
  assert.equal(fs.existsSync(f.target), false);
  fs.mkdirSync(f.target, { recursive: true }); fs.writeFileSync(join(f.target, 'SKILL.md'), skill);
  const removed = controlWorkspaceSkillComponent(f.root, receipt.id, 'remove');
  assert.equal(removed.components[0].state, 'conflict');
  assert.deepEqual(fs.readFileSync(join(f.target, 'SKILL.md')), skill);
});

test('multi-skill failure retains the already installed component and truthful separate receipts', async t => {
  const f = fixture(t, true), original = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (String(to).endsWith('another-testing')) throw Object.assign(new Error('PRIVATE publish error'), { code: 'EIO' });
    return original.call(this, from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('FILESYSTEM_FAILED')); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  const receipts = fs.readdirSync(join(f.root, '.workforce', 'capabilities')).filter(p => p.endsWith('.json'))
    .map(p => JSON.parse(fs.readFileSync(join(f.root, '.workforce', 'capabilities', p))));
  assert.equal(receipts.find(p => p.target_name === 'example-testing').state, 'installed');
  assert.equal(receipts.find(p => p.target_name === 'another-testing').state, 'partial');
  assert.deepEqual(fs.readFileSync(join(f.target, 'SKILL.md')), skill);
  assert.equal(fs.existsSync(join(f.root, '.github', 'skills', 'another-testing')), false);
});

test('UTF-8 license BOM and source bytes remain intact across receipt reload', async t => {
  const f = fixture(t); f.files.set('LICENSE', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), license]));
  const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  assert.equal(Buffer.byteLength(installed.components[0].license.text), f.files.get('LICENSE').length);
  assert.equal(controlWorkspaceSkillComponent(f.root, installed.components[0].id, 'remove').components[0].state, 'removed');
});

test('rejects coerced non-string commit pins before transport and in otherwise intact receipts', async t => {
  const f = fixture(t);
  for (const pin of [[commit], new String(commit), { toString: () => commit }, { commit }])
    await assert.rejects(installWorkspaceSkillComponents(f.root, { ...f.approval, commit: pin }, f.reader), code('INVALID_APPROVAL'));
  assert.equal(f.calls.length, 0);
  const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const digest = value => createHash('sha256').update(value).digest('hex');
  for (const mutate of [value => { value.source.commit = [commit]; }, value => { value.target_name = [value.target_name]; },
    value => { value.files[0].sha256 = [value.files[0].sha256]; }, value => { value.claims.host_loading = 'loaded'; }]) {
    const invalid = structuredClone(installed.components[0]); mutate(invalid);
    invalid.id = 'workspace-skill-' + digest(JSON.stringify({ source: invalid.source, target_name: invalid.target_name }));
    const { integrity: _old, ...body } = invalid;
    invalid.integrity = digest(JSON.stringify(body));
    fs.writeFileSync(f.receiptFile(invalid.id), JSON.stringify(invalid));
    assert.throws(() => controlWorkspaceSkillComponent(f.root, invalid.id, 'remove'), code('INVALID_RECEIPT'));
  }
  assert.deepEqual(fs.readFileSync(join(f.target, 'SKILL.md')), skill);
});

test('preserves initialized legacy managed namespaces through install/disable/reinstall/remove', async t => {
  for (const alias of ['.neomind', '.verythinker', '.taskforces']) {
    const f = fixture(t);
    initialize(f.root, { project_id: 'WF-SKILL-LEGACY', platforms: ['copilot'], execution_engine: 'vscode-lm', copilot_integration: 'local' });
    fs.renameSync(join(f.root, '.workforce'), join(f.root, alias));
    const config = readConfig(f.root), configBytes = fs.readFileSync(join(f.root, alias, 'config.json'));
    const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
    assert.ok(fs.existsSync(join(f.root, alias, 'capabilities', `${id}.json`)));
    const view = listWorkspaceSkillComponents(f.root);
    assert.equal(view.components[0].available, true);
    assert.equal(view.components[0].receipt.path, `${alias}/capabilities/${id}.json`);
    assert.equal(fs.existsSync(join(f.root, '.workforce')), false);
    assert.deepEqual(readConfig(f.root), config);
    assert.equal(controlWorkspaceSkillComponent(f.root, id, 'disable').components[0].state, 'disabled');
    assert.equal(listWorkspaceSkillComponents(f.root).components[0].state, 'disabled');
    assert.equal((await installWorkspaceSkillComponents(f.root, f.approval, f.reader)).components[0].state, 'installed');
    assert.equal(controlWorkspaceSkillComponent(f.root, id, 'remove').components[0].state, 'removed');
    assert.equal(fs.existsSync(join(f.root, '.workforce')), false);
    assert.deepEqual(fs.readFileSync(join(f.root, alias, 'config.json')), configBytes);
    assert.deepEqual(readConfig(f.root), config);
  }
});

test('conflicting roots or active migration reject before source transport and side effects', async t => {
  const f = fixture(t);
  fs.mkdirSync(join(f.root, '.workforce')); fs.mkdirSync(join(f.root, '.neomind'));
  await assert.rejects(installWorkspaceSkillComponents(f.root, f.approval, f.reader), code('UNSAFE_PATH'));
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(join(f.root, '.github')), false);
  const other = fixture(t); fs.writeFileSync(join(other.root, '.verythinker-migration.lock'), 'Migration owns storage.');
  await assert.rejects(installWorkspaceSkillComponents(other.root, other.approval, other.reader), code('UNSAFE_PATH'));
  assert.equal(other.calls.length, 0); assert.equal(fs.existsSync(join(other.root, '.workforce')), false);
});

test('directory cleanup failure leaves durable partial removal intent and retry reconciles remaining effects', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  const original = fs.rmdirSync;
  fs.rmdirSync = function(path, ...args) {
    if (String(path) === f.target) throw Object.assign(new Error('PRIVATE access denied'), { code: 'EACCES' });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => controlWorkspaceSkillComponent(f.root, id, 'remove'), code('FILESYSTEM_FAILED')); }
  finally { fs.rmdirSync = original; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(join(f.target, 'SKILL.md')), false);
  const partial = JSON.parse(fs.readFileSync(f.receiptFile(id)));
  assert.equal(partial.state, 'partial'); assert.equal(partial.pending_action, 'remove');
  assert.ok(partial.history.some(e => e.action === 'remove-started'));
  assert.equal(partial.history.at(-1).action, 'remove-failed');
  assert.equal(controlWorkspaceSkillComponent(f.root, id, 'remove').components[0].state, 'removed');
  assert.equal(fs.existsSync(f.target), false);
});

test('an unlink error after partial removal retains intent and retries only remaining unchanged owned files', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  const original = fs.unlinkSync;
  fs.unlinkSync = function(path, ...args) {
    if (String(path) === join(f.target, 'assets', 'icon.bin')) throw Object.assign(new Error('PRIVATE unlink denied'), { code: 'EACCES' });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => controlWorkspaceSkillComponent(f.root, id, 'remove'), code('FILESYSTEM_FAILED')); }
  finally { fs.unlinkSync = original; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(join(f.target, 'SKILL.md')), false);
  assert.ok(fs.existsSync(join(f.target, 'assets', 'icon.bin')));
  const partial = JSON.parse(fs.readFileSync(f.receiptFile(id)));
  assert.equal(partial.state, 'partial'); assert.equal(partial.pending_action, 'remove');
  assert.equal(controlWorkspaceSkillComponent(f.root, id, 'remove').components[0].state, 'removed');
  assert.equal(fs.existsSync(f.target), false);
});

test('persistent final receipt failure retains earlier durable intent instead of a stale installed claim', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  const original = fs.renameSync; let receiptWrites = 0;
  fs.renameSync = function(from, to) {
    if (String(to) === f.receiptFile(id) && ++receiptWrites > 1) throw Object.assign(new Error('PRIVATE receipt denied'), { code: 'EACCES' });
    return original.call(this, from, to);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => controlWorkspaceSkillComponent(f.root, id, 'disable'), code('FILESYSTEM_FAILED')); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(f.target), false);
  const partial = JSON.parse(fs.readFileSync(f.receiptFile(id)));
  assert.equal(partial.state, 'partial'); assert.equal(partial.pending_action, 'disable');
  assert.equal(partial.history.at(-1).action, 'disable-started');
  const reconciled = controlWorkspaceSkillComponent(f.root, id, 'disable');
  assert.equal(reconciled.components[0].state, 'disabled'); assert.equal(reconciled.components[0].pending_action, undefined);
});

test('a process exit immediately after unlink retains persisted removal intent and resumes safely', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {controlWorkspaceSkillComponent} from ${JSON.stringify(materializerModule)};
    const original=fs.unlinkSync; fs.unlinkSync=function(path,...args){const result=original.call(this,path,...args);
      if(String(path)===${JSON.stringify(join(f.target, 'SKILL.md'))})process.exit(77);return result;};
    syncBuiltinESMExports();controlWorkspaceSkillComponent(${JSON.stringify(f.root)},${JSON.stringify(id)},'remove');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 77, child.stderr);
  assert.equal(fs.existsSync(join(f.target, 'SKILL.md')), false);
  const partial = JSON.parse(fs.readFileSync(f.receiptFile(id)));
  assert.equal(partial.state, 'partial'); assert.equal(partial.pending_action, 'remove');
  assert.equal(partial.history.at(-1).action, 'remove-started');
  assert.equal(controlWorkspaceSkillComponent(f.root, id, 'remove').components[0].state, 'removed');
  assert.equal(fs.existsSync(f.target), false);
});

test('absent receipt discovery creates no directories and never uses a network or source reader', t => {
  const f = fixture(t), before = snapshot(f.root), fetch = globalThis.fetch;
  let calls = 0; globalThis.fetch = () => { calls++; throw new Error('PRIVATE network must not run'); };
  try {
    const absent = listWorkspaceSkillComponents(f.root, { request: 'Testing guidance', limit: 2 });
    assert.equal(absent.state, 'absent'); assert.deepEqual(absent.components, []);
    assert.equal(absent.fallback, 'ordinary-work'); assert.equal(absent.authorization, 'not-granted');
    assert.equal(absent.execution, 'not-performed');
    assert.deepEqual(snapshot(f.root), before); assert.equal(calls, 0); assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = fetch; }
});

test('installed discovery returns bounded original metadata and current pinned paths without changing files or records', async t => {
  const f = fixture(t); initialize(f.root, { project_id: 'WF-SKILL-READ' });
  const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const before = snapshot(f.root), records = loadRecords(f.root), reads = f.calls.length;
  const found = listWorkspaceSkillComponents(f.root, { request: 'test\nscenarios', limit: 3 });
  assert.equal(found.state, 'available'); assert.equal(found.components.length, 1);
  const item = found.components[0];
  assert.equal(item.id, installed.components[0].id); assert.equal(item.available, true);
  assert.equal(item.name, 'example-testing'); assert.equal(item.description, 'Test approved scenarios');
  assert.equal(item.skill_path, '.github/skills/example-testing/SKILL.md');
  assert.equal(item.source.commit, commit); assert.equal(item.source.repository, repository);
  assert.equal(item.files.state, 'current'); assert.equal(item.files.count, 3);
  assert.ok(Object.values(item.observations).every(value => value === 'not-observed'));
  assert.equal(item.license.sha256, installed.components[0].license.sha256);
  assert.equal('text' in item.license, false); assert.equal('history' in item, false);
  assert.deepEqual(listWorkspaceSkillComponents(f.root, { request: 'unrelated galaxies' }).components, []);
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(loadRecords(f.root), records); assert.equal(f.calls.length, reads);
});

test('disabled/removed views preserve recorded provenance while reporting absent host bytes and unobserved use', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  controlWorkspaceSkillComponent(f.root, id, 'disable');
  const disabled = listWorkspaceSkillComponents(f.root).components[0];
  assert.equal(disabled.state, 'disabled'); assert.equal(disabled.available, false); assert.equal(disabled.files.state, 'absent');
  assert.equal(disabled.description, null); assert.equal(disabled.source.commit, commit);
  controlWorkspaceSkillComponent(f.root, id, 'remove');
  const before = snapshot(f.root), removed = listWorkspaceSkillComponents(f.root).components[0];
  assert.equal(removed.state, 'removed'); assert.equal(removed.available, false);
  assert.ok(Object.values(removed.observations).every(value => value === 'not-observed'));
  assert.deepEqual(snapshot(f.root), before);
});

test('changed/missing component files and corrupt receipts are advisory conflicts, not installed or silently repaired', async t => {
  const f = fixture(t, true), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const id = installed.components.find(c => c.name === 'example-testing' || c.target_name === 'example-testing').id;
  fs.writeFileSync(join(f.target, 'SKILL.md'), '---\nname: other\ndescription: PRIVATE misleading metadata\n---\n');
  const before = snapshot(f.root), changed = listWorkspaceSkillComponents(f.root);
  const item = changed.components.find(c => c.id === id);
  assert.equal(changed.state, 'partial'); assert.equal(item.recorded_state, 'installed');
  assert.equal(item.state, 'conflict'); assert.equal(item.files.state, 'changed'); assert.equal(item.description, null); assert.equal(item.available, false);
  assert.equal(changed.components.find(c => c.name === 'another-testing').available, true);
  assert.doesNotMatch(JSON.stringify(changed), /PRIVATE/); assert.deepEqual(snapshot(f.root), before);
  fs.writeFileSync(join(f.target, 'SKILL.md'), skill); fs.unlinkSync(join(f.target, 'assets', 'icon.bin'));
  const missing = listWorkspaceSkillComponents(f.root).components.find(c => c.id === id);
  assert.equal(missing.files.state, 'incomplete'); assert.equal(missing.available, false);
  fs.writeFileSync(f.receiptFile(id), '{corrupt PRIVATE receipt');
  const corruptBefore = snapshot(f.root), corrupt = listWorkspaceSkillComponents(f.root);
  assert.equal(corrupt.state, 'partial'); assert.ok(corrupt.issues.some(issue => issue.code === 'INVALID_RECEIPT'));
  assert.equal(corrupt.components.length, 1); assert.doesNotMatch(JSON.stringify(corrupt), /PRIVATE/);
  assert.deepEqual(snapshot(f.root), corruptBefore);
});

test('query/scan/description bounds are explicit and truncated results make no completeness claim', async t => {
  const f = fixture(t, true);
  f.files.set(`${sourceRoot}/SKILL.md`, Buffer.from(`---\nname: example-testing\ndescription: ${'testing '.repeat(200)}\n---\n# Skill\n`));
  await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const limited = listWorkspaceSkillComponents(f.root, { request: 'testing', limit: 1 });
  assert.equal(limited.components.length, 1); assert.equal(limited.results_truncated, true);
  const long = listWorkspaceSkillComponents(f.root).components.find(c => c.name === 'example-testing');
  assert.equal(long.description.length, 600); assert.equal(long.description_truncated, true);
  const before = snapshot(f.root);
  for (const query of [{ limit: 0 }, { limit: 11 }, { limit: [1] }, { limit: 1.5 }, { request: ['testing'] },
    { request: 'x'.repeat(20_001) }, { request: 'bad\u0000query' }, { unknown: true }, []])
    assert.throws(() => listWorkspaceSkillComponents(f.root, query), code('INVALID_QUERY'));
  assert.deepEqual(snapshot(f.root), before);
  const bounded = fixture(t), metadata = join(bounded.root, '.workforce', 'capabilities'); fs.mkdirSync(metadata, { recursive: true });
  for (let i = 0; i < 34; i++) fs.writeFileSync(join(metadata, `workspace-skill-${i.toString(16).padStart(64, '0')}.json`), '{}');
  const scanBefore = snapshot(bounded.root), result = listWorkspaceSkillComponents(bounded.root);
  assert.equal(result.state, 'partial'); assert.equal(result.results_truncated, true); assert.equal(result.issues.length, 32);
  assert.deepEqual(snapshot(bounded.root), scanBefore);
});

test('list and native preparation never fully enumerate a noisy receipt directory or write while enforcing bounds', async t => {
  const f = fixture(t); initialize(f.root, { project_id: 'WF-SKILL-BOUNDS' });
  await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  // Prime the pre-existing optional procedure index outside the read-only view.
  prepareNativeWork(f.root, { requirement: 'Testing scenarios' });
  const metadata = join(f.root, '.workforce', 'capabilities');
  for (let index = 0; index < 300; index++) fs.writeFileSync(join(metadata, `zz-noise-${String(index).padStart(3, '0')}.txt`), 'Unowned metadata noise.');
  const before = snapshot(f.root), records = loadRecords(f.root), original = {
    readdirSync: fs.readdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, mkdirSync: fs.mkdirSync };
  let fullEnumerations = 0, writes = 0;
  fs.readdirSync = function(path, ...args) {
    if (resolve(String(path)) === metadata) { fullEnumerations++; throw new Error('PRIVATE forbidden full receipt enumeration'); }
    return original.readdirSync.call(this, path, ...args);
  };
  for (const method of ['writeFileSync', 'renameSync', 'mkdirSync']) fs[method] = function() { writes++; throw new Error('PRIVATE discovery write'); };
  syncBuiltinESMExports();
  try {
    const direct = listWorkspaceSkillComponents(f.root);
    const prepared = prepareNativeWork(f.root, { requirement: 'Testing scenarios' });
    assert.equal(fullEnumerations, 0); assert.equal(writes, 0);
    assert.equal(direct.state, 'partial'); assert.equal(direct.results_truncated, true);
    assert.ok(direct.issues.some(issue => issue.code === 'BOUND_EXCEEDED')); assert.deepEqual(direct.components, []);
    assert.equal(prepared.strategy, 'ordinary'); assert.equal(prepared.execution_authorized, false);
    assert.equal(prepared.installed_skill_components.results_truncated, true);
    assert.ok(prepared.installed_skill_components.issues.some(issue => issue.code === 'BOUND_EXCEEDED'));
  } finally {
    Object.assign(fs, original); syncBuiltinESMExports();
  }
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(loadRecords(f.root), records);
});

test('bounded path checks still refuse a case-alias host directory and preserve original bytes', async t => {
  const f = fixture(t); await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  fs.renameSync(join(f.root, '.github'), join(f.root, '.github-case-stage'));
  fs.renameSync(join(f.root, '.github-case-stage'), join(f.root, '.GITHUB'));
  const before = snapshot(f.root), found = listWorkspaceSkillComponents(f.root);
  assert.equal(found.components[0].state, 'conflict'); assert.equal(found.components[0].available, false);
  assert.equal(found.components[0].files.state, 'unsafe'); assert.ok(found.issues.some(issue => issue.code === 'UNSAFE_PATH'));
  assert.deepEqual(fs.readFileSync(join(f.root, '.GITHUB', 'skills', 'example-testing', 'SKILL.md')), skill);
  assert.deepEqual(snapshot(f.root), before);
});

test('exact skill-name lookup remains complete with more than ten related advisory matches', async t => {
  const f = fixture(t); await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const related = [];
  for (let index = 0; index < 11; index++) {
    const name = `related-testing-${String(index).padStart(2, '0')}`, source = `plugins/testing/skills/${name}`;
    f.files.set(`${source}/SKILL.md`, Buffer.from(`---\nname: ${name}\ndescription: Test approved scenarios\n---\n# Related guidance\n`));
    related.push({ source_path: source, target_name: name, files: [`${source}/SKILL.md`] });
  }
  for (let index = 0; index < related.length; index += 8)
    await installWorkspaceSkillComponents(f.root, { ...f.approval, skills: related.slice(index, index + 8) }, f.reader);
  const broad = listWorkspaceSkillComponents(f.root, { request: 'testing', limit: 10 });
  assert.equal(broad.components.length, 10); assert.equal(broad.results_truncated, true);
  const before = snapshot(f.root), reads = f.calls.length;
  const exact = listWorkspaceSkillComponents(f.root, { exact_name: 'example-testing', limit: 10 });
  assert.equal(exact.state, 'available'); assert.equal(exact.results_truncated, false);
  assert.deepEqual(exact.components.map(item => item.name), ['example-testing']);
  assert.equal(exact.components[0].available, true);
  assert.equal(exact.authorization, 'not-granted'); assert.equal(exact.execution, 'not-performed');
  assert.ok(Object.values(exact.components[0].observations).every(value => value === 'not-observed'));
  assert.deepEqual(listWorkspaceSkillComponents(f.root, { exact_name: 'missing-testing' }).components, []);
  assert.deepEqual(snapshot(f.root), before); assert.equal(f.calls.length, reads);
});

test('exact lookup retains distinct current receipt candidates with the same name rather than selecting an authority', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const alternate = structuredClone(installed.components[0]), digest = value => createHash('sha256').update(value).digest('hex');
  alternate.source.commit = 'b'.repeat(40);
  alternate.id = 'workspace-skill-' + digest(JSON.stringify({ source: alternate.source, target_name: alternate.target_name }));
  const { integrity: _old, ...body } = alternate;
  alternate.integrity = digest(JSON.stringify(body));
  fs.writeFileSync(f.receiptFile(alternate.id), JSON.stringify(alternate));
  const before = snapshot(f.root), found = listWorkspaceSkillComponents(f.root, { exact_name: 'example-testing', limit: 10 });
  assert.equal(found.results_truncated, false); assert.equal(found.components.length, 2);
  assert.equal(new Set(found.components.map(item => item.id)).size, 2);
  assert.ok(found.components.every(item => item.name === 'example-testing' && item.available));
  assert.equal(found.authorization, 'not-granted'); assert.deepEqual(snapshot(f.root), before);
});

test('exact lookup validates canonical names and keeps directory scan limits instead of bypassing them', async t => {
  const f = fixture(t); await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const before = snapshot(f.root);
  for (const exact_name of ['', 'Example-Testing', 'example_testing', '../example-testing', ['example-testing'], 'x'.repeat(65)])
    assert.throws(() => listWorkspaceSkillComponents(f.root, { exact_name }), code('INVALID_QUERY'));
  assert.deepEqual(snapshot(f.root), before);
  const metadata = join(f.root, '.workforce', 'capabilities');
  for (let index = 0; index < 300; index++) fs.writeFileSync(join(metadata, `zz-noise-${String(index).padStart(3, '0')}.txt`), 'Unowned noise.');
  const boundedBefore = snapshot(f.root), bounded = listWorkspaceSkillComponents(f.root, { exact_name: 'example-testing' });
  assert.equal(bounded.state, 'partial'); assert.equal(bounded.results_truncated, true);
  assert.ok(bounded.issues.some(issue => issue.code === 'BOUND_EXCEEDED')); assert.deepEqual(bounded.components, []);
  assert.deepEqual(snapshot(f.root), boundedBefore);
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const archivedReceipt = (f, id, digest, namespace = '.workforce') => join(f.root, namespace, 'capabilities', 'receipt-snapshots', id, digest, 'receipt.json');

test('receipt snapshot reads are exact, validated and read-only even before metadata exists', async t => {
  const f = fixture(t), id = 'workspace-skill-' + '0'.repeat(64), before = snapshot(f.root);
  assert.equal(readWorkspaceSkillReceiptSnapshot(f.root, id, 'a'.repeat(64)), undefined);
  assert.deepEqual(snapshot(f.root), before);
  const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), current = installed.components[0];
  const raw = fs.readFileSync(f.receiptFile(current.id)), populated = snapshot(f.root);
  assert.deepEqual(readWorkspaceSkillReceiptSnapshot(f.root, current.id, sha256(raw)), JSON.parse(raw));
  assert.equal(readWorkspaceSkillReceiptSnapshot(f.root, current.id, 'b'.repeat(64)), undefined);
  assert.deepEqual(snapshot(f.root), populated);
});

test('first lifecycle transition archives original pre-upgrade receipt bytes and same-source reinstall preserves that exact snapshot', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  // Original v1 bytes have no snapshot reference: no record/history migration is needed.
  const original = fs.readFileSync(f.receiptFile(id)), expected = sha256(original);
  controlWorkspaceSkillComponent(f.root, id, 'disable');
  assert.deepEqual(fs.readFileSync(archivedReceipt(f, id, expected)), original);
  assert.deepEqual(readWorkspaceSkillReceiptSnapshot(f.root, id, expected), JSON.parse(original));
  await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  const current = fs.readFileSync(f.receiptFile(id));
  assert.notEqual(sha256(current), expected, 'Lifecycle history remains truthful rather than rewriting the original receipt');
  assert.deepEqual(readWorkspaceSkillReceiptSnapshot(f.root, id, expected), JSON.parse(original));
  assert.deepEqual(readWorkspaceSkillReceiptSnapshot(f.root, id, sha256(current)), JSON.parse(current));
  const before = snapshot(f.root); await installWorkspaceSkillComponents(f.root, f.approval, f.reader);
  assert.deepEqual(snapshot(f.root), before, 'Idempotent installation does not rewrite snapshots or metadata');
  controlWorkspaceSkillComponent(f.root, id, 'remove');
  assert.deepEqual(fs.readFileSync(archivedReceipt(f, id, expected)), original);
});

test('missing, tampered, wrong-identity and linked receipt snapshots cannot reconstruct an original selection', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  const original = fs.readFileSync(f.receiptFile(id)), expected = sha256(original), archive = archivedReceipt(f, id, expected);
  controlWorkspaceSkillComponent(f.root, id, 'disable');
  fs.writeFileSync(archive, original.toString('utf8') + ' ');
  assert.throws(() => readWorkspaceSkillReceiptSnapshot(f.root, id, expected), code('INVALID_RECEIPT'));
  fs.unlinkSync(archive);
  assert.equal(readWorkspaceSkillReceiptSnapshot(f.root, id, expected), undefined, 'Original bytes cannot be invented from current lifecycle history');
  const copy = join(f.root, 'original-receipt.json'); fs.writeFileSync(copy, original);
  fs.linkSync(copy, archive);
  assert.throws(() => readWorkspaceSkillReceiptSnapshot(f.root, id, expected), code('UNSAFE_PATH'));
  fs.unlinkSync(archive);
  const linked = join(f.root, 'linked-snapshot'); fs.mkdirSync(linked); fs.writeFileSync(join(linked, 'receipt.json'), original);
  const archiveDirectory = join(archive, '..'); fs.rmdirSync(archiveDirectory);
  fs.symlinkSync(linked, archiveDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readWorkspaceSkillReceiptSnapshot(f.root, id, expected), code('UNSAFE_PATH'));
  const invalid = JSON.parse(original); invalid.source.commit = [commit];
  invalid.id = 'workspace-skill-' + sha256(JSON.stringify({ source: invalid.source, target_name: invalid.target_name }));
  const { integrity: _old, ...body } = invalid; invalid.integrity = sha256(JSON.stringify(body));
  const raw = Buffer.from(JSON.stringify(invalid)), invalidHash = sha256(raw), destination = archivedReceipt(f, id, invalidHash);
  fs.mkdirSync(join(destination, '..'), { recursive: true }); fs.writeFileSync(destination, raw);
  assert.throws(() => readWorkspaceSkillReceiptSnapshot(f.root, id, invalidHash), code('INVALID_RECEIPT'));
  for (const [selected, digest] of [[id, [expected]], [id, expected.toUpperCase()], ['../private', expected]])
    assert.throws(() => readWorkspaceSkillReceiptSnapshot(f.root, selected, digest), code('INVALID_RECEIPT'));
});

test('snapshot publication failure precedes receipt replacement and every disable side effect', async t => {
  const f = fixture(t), installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
  const original = fs.readFileSync(f.receiptFile(id)), expected = sha256(original), directory = join(archivedReceipt(f, id, expected), '..');
  const rename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (String(to) === directory) throw Object.assign(new Error('PRIVATE archive denied'), { code: 'EACCES' });
    return rename.call(this, from, to);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => controlWorkspaceSkillComponent(f.root, id, 'disable'), code('FILESYSTEM_FAILED')); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.receiptFile(id)), original);
  assert.deepEqual(fs.readFileSync(join(f.target, 'SKILL.md')), skill);
  assert.equal(controlWorkspaceSkillComponent(f.root, id, 'disable').components[0].state, 'disabled');
  assert.deepEqual(fs.readFileSync(archivedReceipt(f, id, expected)), original);
});

test('receipt snapshot archives follow the existing legacy managed namespace without creating another root', async t => {
  for (const alias of ['.neomind', '.verythinker', '.taskforces']) {
    const f = fixture(t); initialize(f.root, { project_id: 'WF-SNAPSHOT-LEGACY' });
    const installed = await installWorkspaceSkillComponents(f.root, f.approval, f.reader), id = installed.components[0].id;
    const original = fs.readFileSync(f.receiptFile(id)), expected = sha256(original);
    fs.renameSync(join(f.root, '.workforce'), join(f.root, alias));
    controlWorkspaceSkillComponent(f.root, id, 'disable');
    assert.deepEqual(readWorkspaceSkillReceiptSnapshot(f.root, id, expected), JSON.parse(original));
    assert.deepEqual(fs.readFileSync(archivedReceipt(f, id, expected, alias)), original);
    assert.equal(fs.existsSync(join(f.root, '.workforce')), false);
    assert.doesNotThrow(() => readConfig(f.root));
  }
});
