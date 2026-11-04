import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareSharedIndex, withSharedIndex } from '../src/workspace/shared-index.js';

test('shared commit fencing blocks concurrent Git staging and never deletes another owner index lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-shared-lock-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  await writeFile(path.join(root, 'app'), 'baseline\n'); git('add', '.'); git('commit', '-qm', 'base');
  await writeFile(path.join(root, 'app'), 'user staged\n'); git('add', 'app');
  const parent = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}'), expected = await prepareSharedIndex(root, parent, tree, false);
  const index = git('rev-parse', '--path-format=absolute', '--git-path', 'index');
  await withSharedIndex(root, expected, async () => { assert.throws(() => git('add', 'app'), /index.lock|Unable to create/); });
  assert.equal(git('show', ':app'), 'user staged');
  const after = await readFile(index);
  await writeFile(`${index}.lock`, 'another owner');
  try {
    await assert.rejects(withSharedIndex(root, expected, async () => {}), /EEXIST/);
    assert.equal(await readFile(`${index}.lock`, 'utf8'), 'another owner');
    assert.deepEqual(await readFile(index), after, 'failed lock acquisition leaves the full index bytes intact');
  } finally { await rm(`${index}.lock`); }
});
