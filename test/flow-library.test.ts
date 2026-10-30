import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FlowLibrary } from '../src/storage/flow-library.js';
import { defaultProject, templates } from '../src/domain/templates.js';

test('drafts, publish, rename, archive, clone and delete preserve immutable versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-library-'));
  const library = new FlowLibrary(root);
  await library.create('dev', 'Dev');
  await library.saveDraft('dev', { incomplete: true });
  await assert.rejects(library.publish('dev', defaultProject.policy), /Invalid draft/);
  await library.saveDraft('dev', templates.dev);
  const first = await library.publish('dev', defaultProject.policy);
  assert.equal(first.version, 1);
  const versionPath = path.join(root, 'dev', 'versions', '000001.json');
  const original = await readFile(versionPath, 'utf8');
  await library.rename('dev', 'Custom Dev');
  const second = await library.publish('dev', defaultProject.policy);
  assert.equal(second.version, 2);
  assert.equal(second.name, 'Custom Dev');
  assert.equal((await library.readVersion('dev', 1)).name, 'Dev');
  assert.equal(await readFile(versionPath, 'utf8'), original);
  await library.setArchived('dev', true);
  await assert.rejects(library.publish('dev', defaultProject.policy), /Archived/);
  await library.setArchived('dev', false);
  await library.cloneDraft('dev', 'my-dev', 'My Dev');
  const clone = await library.publish('my-dev', defaultProject.policy);
  assert.equal(clone.flowId, 'my-dev');
  assert.equal(clone.version, 1);
  await assert.rejects(library.deletePermanently('my-dev', 'wrong name'), /confirmation/);
  assert.equal((await library.list()).length, 2);
  await library.deletePermanently('my-dev', 'My Dev');
  assert.deepEqual((await library.list()).map(item => item.flowId), ['dev']);
});

test('published version tampering is detected before use', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-library-tamper-'));
  const library = new FlowLibrary(root);
  await library.create('dev', 'Dev');
  await library.saveDraft('dev', templates.dev);
  await library.publish('dev', defaultProject.policy);
  const file = path.join(root, 'dev', 'versions', '000001.json');
  const stored = JSON.parse(await readFile(file, 'utf8')) as { description: string };
  stored.description = 'changed without publish';
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(library.readVersion('dev', 1), /hash mismatch/);
});

test('concurrent publications never overwrite an already-published version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-library-race-'));
  const first = new FlowLibrary(root), second = new FlowLibrary(root);
  await first.create('dev', 'Dev');
  await first.saveDraft('dev', templates.dev);
  const results = await Promise.allSettled([first.publish('dev', defaultProject.policy), second.publish('dev', defaultProject.policy)]);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  for (const version of await first.versions('dev')) assert.equal((await first.readVersion('dev', version)).version, version);
});

test('flow IDs cannot escape their library root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-library-path-'));
  const library = new FlowLibrary(root);
  await assert.rejects(library.create('../outside', 'Bad'));
  await assert.rejects(library.create('C:\\outside', 'Bad'));
});

test('flow library refuses a symlinked flow directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-library-link-'));
  const library = new FlowLibrary(root);
  await library.create('dev', 'Dev');
  await symlink(path.join(root, 'dev'), path.join(root, 'alias'), 'junction');
  await assert.rejects(library.metadata('alias'), /Symlink is not allowed/);
  await assert.rejects(library.deletePermanently('alias', 'Dev'), /Symlink is not allowed/);
});
