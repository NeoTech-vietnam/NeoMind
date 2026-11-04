import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureBaseline } from '../src/workspace/baseline.js';
import { collectReviewSources } from '../src/workspace/review-sources.js';

test('review evidence includes exact text, binary bytes and unchanged check scripts and rejects a stale baseline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-review-source-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost'); git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'verify.cjs'), 'assert();\n'); await writeFile(path.join(root, 'value.txt'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'value.txt'), 'alpha+beta\n'); await writeFile(path.join(root, 'value.bin'), Buffer.from([0, 65, 66]));
  const baseline = (await captureBaseline(root)).baselineHash;
  const result = JSON.parse(await collectReviewSources(root, baseline, base, ['verify.cjs', '../outside'])) as { files: { path: string; content?: string; bytes?: number[]; unchangedFromBase: boolean }[] };
  assert.equal(result.files.find(item => item.path === 'value.txt')?.content, 'alpha+beta\n');
  assert.deepEqual(result.files.find(item => item.path === 'value.bin')?.bytes, [0, 65, 66]);
  assert.equal(result.files.find(item => item.path === 'verify.cjs')?.unchangedFromBase, true);
  assert.ok(!result.files.some(item => item.path === '../outside'));
  await writeFile(path.join(root, 'value.txt'), 'later\n');
  await assert.rejects(collectReviewSources(root, baseline, base), /baseline changed/);
});
