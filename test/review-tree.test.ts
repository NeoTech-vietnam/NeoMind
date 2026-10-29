import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { captureBaseline } from '../src/workspace/baseline.js';
import { buildReviewTree } from '../src/workspace/review-tree.js';

test('review tree captures run changes without modifying Git index or working files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-review-tree-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q'); await writeFile(path.join(root, 'code.c'), 'old'); git('add', 'code.c');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  await writeFile(path.join(root, 'code.c'), 'new'); await writeFile(path.join(root, 'new.c'), 'new file');
  const index = git('ls-files', '--stage'), status = git('status', '--porcelain'), baseline = await captureBaseline(root);
  const result = await buildReviewTree(root, baseline.baselineHash);
  assert.equal(git('show', `${result.tree}:code.c`), 'new'); assert.equal(git('show', `${result.tree}:new.c`), 'new file');
  assert.equal(git('ls-files', '--stage'), index); assert.equal(git('status', '--porcelain'), status);
  assert.equal(await readFile(path.join(root, 'code.c'), 'utf8'), 'new');
  await writeFile(path.join(root, 'code.c'), 'different');
  await assert.rejects(buildReviewTree(root, baseline.baselineHash), /baseline changed/);
});
