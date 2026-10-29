import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { captureBaseline } from '../src/workspace/baseline.js';

function git(dir: string, ...args: string[]): Buffer {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}
async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-baseline-'));
  git(dir, 'init', '-q');
  await writeFile(path.join(dir, 'tracked.txt'), 'initial\n');
  git(dir, 'add', 'tracked.txt');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  return dir;
}

test('baseline captures dirty staged and untracked files without changing Git index or contents', async () => {
  const root = await fixture();
  const clean = await captureBaseline(root);
  assert.equal(clean.clean, true);
  await writeFile(path.join(root, 'tracked.txt'), 'staged\n');
  git(root, 'add', 'tracked.txt');
  await writeFile(path.join(root, 'tracked.txt'), 'staged plus unstaged\n');
  await writeFile(path.join(root, 'new.txt'), 'untracked\n');
  const beforeIndex = git(root, 'ls-files', '--stage', '-z');
  const beforeStatus = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const baseline = await captureBaseline(root);
  assert.equal(baseline.clean, false);
  assert.equal(baseline.entries.find(e => e.path === 'tracked.txt')?.status, 'MM');
  assert.equal(baseline.entries.find(e => e.path === 'new.txt')?.status, '??');
  assert.deepEqual(git(root, 'ls-files', '--stage', '-z'), beforeIndex);
  assert.deepEqual(git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), beforeStatus);
  assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'staged plus unstaged\n');
  assert.notEqual(baseline.baselineHash, clean.baselineHash);
  await writeFile(path.join(root, 'tracked.txt'), 'later\n');
  assert.notEqual((await captureBaseline(root)).baselineHash, baseline.baselineHash);
});

test('baseline records a symlink without reading its outside target', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'neomind-outside-'));
  await writeFile(path.join(outside, 'secret'), 'private');
  await symlink(path.join(outside, 'secret'), path.join(root, 'link'));
  const entry = (await captureBaseline(root)).entries.find(e => e.path === 'link');
  assert.equal(entry?.kind, 'symlink');
  assert.notEqual(entry?.contentHash, null);
});

test('baseline includes both paths of a staged rename', async () => {
  const root = await fixture();
  git(root, 'mv', 'tracked.txt', 'renamed.txt');
  const baseline = await captureBaseline(root);
  assert.ok(baseline.entries.some(e => e.path === 'renamed.txt'));
  assert.ok(baseline.entries.some(e => e.path === 'tracked.txt' && e.kind === 'missing'));
});
