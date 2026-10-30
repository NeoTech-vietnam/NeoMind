import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { captureBaseline } from '../src/workspace/baseline.js';
import { createDetachedWorktree } from '../src/workspace/worktree.js';
import { changedPaths, importDirtyChanges, planDirtyImport, runOnlyTree } from '../src/workspace/dirty-import.js';
import { buildReviewTree } from '../src/workspace/review-tree.js';

async function checkout() {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-dirty-')), project = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', project]);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'app.js'), 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n');
  await writeFile(path.join(project, 'old.txt'), 'old\n'); await writeFile(path.join(project, 'keep.txt'), 'keep\n');
  git('add', '.'); git('-c', 'user.name=F', '-c', 'user.email=f@x.test', 'commit', '-qm', 'base');
  // The user's uncommitted work: an edit, a staged edit, a deletion, an untracked file and NeoMind metadata.
  await writeFile(path.join(project, 'app.js'), 'line 1 (user)\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n');
  await writeFile(path.join(project, 'keep.txt'), 'keep, staged by user\n'); git('add', 'keep.txt');
  git('rm', '-q', 'old.txt');
  await mkdir(path.join(project, 'notes')); await writeFile(path.join(project, 'notes', 'todo.md'), 'todo\n');
  await mkdir(path.join(project, '.neomind')); await writeFile(path.join(project, '.neomind', 'project.json'), '{}');
  const head = git('rev-parse', 'HEAD'), run = createDetachedWorktree(project, path.join(root, 'run'), head).path;
  return { project, run, head, git };
}

test('uncommitted changes are copied into the run worktree without touching the checkout or its staging', async () => {
  const { project, run, git } = await checkout();
  const source = await captureBaseline(project), plan = planDirtyImport(source);
  assert.deepEqual(plan.changes.map(item => `${item.change}:${item.path}`).sort(), ['added:notes/todo.md', 'deleted:old.txt', 'modified:app.js', 'modified:keep.txt']);
  const stagedBefore = git('diff', '--cached', '--name-only');
  const imported = await importDirtyChanges(project, run, source.baselineHash);
  assert.deepEqual(imported.paths, ['app.js', 'keep.txt', 'notes/todo.md', 'old.txt']);
  assert.equal(await readFile(path.join(run, 'app.js'), 'utf8'), 'line 1 (user)\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n');
  assert.equal(await readFile(path.join(run, 'notes', 'todo.md'), 'utf8'), 'todo\n');
  await assert.rejects(readFile(path.join(run, 'old.txt')), /ENOENT/);
  await assert.rejects(readFile(path.join(run, '.neomind', 'project.json')), /ENOENT/, 'NeoMind metadata is never imported');
  assert.equal(git('diff', '--cached', '--name-only'), stagedBefore, 'the checkout staging is unchanged');
  assert.equal((await captureBaseline(project)).baselineHash, source.baselineHash, 'the checkout is unchanged');
  assert.equal((await captureBaseline(run)).baselineHash, imported.baselineHash);
});

test('import refuses a checkout that changed after confirmation', async () => {
  const { project, run } = await checkout();
  const confirmed = (await captureBaseline(project)).baselineHash;
  await writeFile(path.join(project, 'app.js'), 'changed again\n');
  await assert.rejects(importDirtyChanges(project, run, confirmed), /đã khác so với lúc xác nhận/);
});

test('the commit tree holds only the run changes; overlapping hunks are reported instead of guessed', async () => {
  const { project, run, head } = await checkout();
  const imported = await importDirtyChanges(project, run, (await captureBaseline(project)).baselineHash);
  // The run edits a distant line of the user's file and adds a file of its own.
  await writeFile(path.join(run, 'app.js'), 'line 1 (user)\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8 (run)\n');
  await writeFile(path.join(run, 'feature.js'), 'run\n');
  const reviewed = (await buildReviewTree(run, (await captureBaseline(run)).baselineHash)).tree;
  assert.deepEqual(await changedPaths(run, imported.tree, reviewed), ['app.js', 'feature.js']);
  const runTree = await runOnlyTree(run, head, imported.tree, reviewed);
  assert.ok(runTree);
  const show = (spec: string) => execFileSync('git', ['-C', run, 'show', spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(show(`${runTree}:app.js`), 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8 (run)\n', 'the user edit stays out of the commit');
  assert.equal(show(`${runTree}:feature.js`), 'run\n');
  assert.equal(show(`${runTree}:keep.txt`), 'keep\n'); assert.equal(show(`${runTree}:old.txt`), 'old\n');
  assert.throws(() => show(`${runTree}:notes/todo.md`));
  // Rewriting the user's own line cannot be separated from it.
  await writeFile(path.join(run, 'app.js'), 'line 1 (user, then run)\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8 (run)\n');
  const overlapping = (await buildReviewTree(run, (await captureBaseline(run)).baselineHash)).tree;
  assert.equal(await runOnlyTree(run, head, imported.tree, overlapping), undefined);
  // No changes of its own: the run-only tree is exactly HEAD's tree.
  assert.equal(await runOnlyTree(run, head, imported.tree, imported.tree), execFileSync('git', ['-C', run, 'rev-parse', `${head}^{tree}`], { encoding: 'utf8' }).trim());
});
