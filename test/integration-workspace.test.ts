import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { captureBaseline } from '../src/workspace/baseline.js';
import { createDetachedWorktree } from '../src/workspace/worktree.js';
import { applyTreeToWorkspace, commitBranch, filesWithConflictMarkers, inspectIntegration, mergeBranchCommits, prepareBranchWorktree } from '../src/workspace/integration.js';

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-integration-')), primary = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', primary]);
  const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).trim();
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(primary, 'shared.txt'), 'one\ntwo\nthree\n'); await writeFile(path.join(primary, 'gone.txt'), 'remove me\n');
  git('add', '.'); git('-c', 'user.name=F', '-c', 'user.email=f@x.test', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD'), run = createDetachedWorktree(primary, path.join(root, 'run'), base).path;
  return { root, primary, base, run, git };
}

test('branches merge without touching worktrees and apply to the run workspace as unstaged changes', async () => {
  const { root, base, run } = await repository();
  const a = await prepareBranchWorktree(run, path.join(root, 'run--a'), base), b = await prepareBranchWorktree(run, path.join(root, 'run--b'), base);
  assert.equal(await prepareBranchWorktree(run, path.join(root, 'run--a'), base), a, 'an existing clean branch worktree is adopted');
  await writeFile(path.join(a, 'a.txt'), 'from a\n'); await writeFile(path.join(b, 'b.txt'), 'from b\n');
  execFileSync('git', ['-C', b, 'rm', '-q', 'gone.txt']); execFileSync('git', ['-C', b, 'reset', '-q']);
  const ca = await commitBranch(a, (await captureBaseline(a)).baselineHash, base, 'refs/neomind/run/a', 'branch a');
  const cb = await commitBranch(b, (await captureBaseline(b)).baselineHash, base, 'refs/neomind/run/b', 'branch b');
  assert.deepEqual(await commitBranch(a, (await captureBaseline(a)).baselineHash, base, 'refs/neomind/run/a', 'branch a'), ca, 'internal commits are reproducible');
  const merged = await mergeBranchCommits(run, [ca.commit, cb.commit]);
  assert.deepEqual(merged.conflicts, []);
  assert.equal((await inspectIntegration(run, base, merged.tree)).state, 'not_applied');
  const baselineHash = await applyTreeToWorkspace(run, base, merged.tree);
  assert.equal(await readFile(path.join(run, 'a.txt'), 'utf8'), 'from a\n');
  assert.equal(await readFile(path.join(run, 'b.txt'), 'utf8'), 'from b\n');
  await assert.rejects(readFile(path.join(run, 'gone.txt')), /ENOENT/);
  assert.equal(execFileSync('git', ['-C', run, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }), '', 'index stays at HEAD');
  assert.deepEqual(await inspectIntegration(run, base, merged.tree), { state: 'applied', baselineHash });
  await writeFile(path.join(run, 'a.txt'), 'edited later\n');
  assert.equal((await inspectIntegration(run, base, merged.tree)).state, 'unknown');
  await assert.rejects(applyTreeToWorkspace(run, base, merged.tree), /clean/);
});

test('overlapping edits are reported as conflicts with markers left for the integration agent', async () => {
  const { root, base, run } = await repository();
  const a = await prepareBranchWorktree(run, path.join(root, 'run--a'), base), b = await prepareBranchWorktree(run, path.join(root, 'run--b'), base);
  await writeFile(path.join(a, 'shared.txt'), 'one\nTWO from a\nthree\n'); await writeFile(path.join(b, 'shared.txt'), 'one\nTWO from b\nthree\n');
  const ca = await commitBranch(a, (await captureBaseline(a)).baselineHash, base, 'refs/neomind/run/a', 'a');
  const cb = await commitBranch(b, (await captureBaseline(b)).baselineHash, base, 'refs/neomind/run/b', 'b');
  const merged = await mergeBranchCommits(run, [ca.commit, cb.commit]);
  assert.deepEqual(merged.conflicts, ['shared.txt']);
  await applyTreeToWorkspace(run, base, merged.tree);
  assert.match(await readFile(path.join(run, 'shared.txt'), 'utf8'), /^<{7} /m);
  assert.deepEqual(await filesWithConflictMarkers(run, merged.conflicts), ['shared.txt']);
  await writeFile(path.join(run, 'shared.txt'), 'one\nTWO from a and b\nthree\n');
  assert.deepEqual(await filesWithConflictMarkers(run, merged.conflicts), []);
  await assert.rejects(prepareBranchWorktree(run, path.join(root, 'run--a'), 'f'.repeat(40)), /another repository or commit/);
});
