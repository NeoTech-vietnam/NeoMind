import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { captureBaseline } from '../src/workspace/baseline.js';
import { buildReviewTree } from '../src/workspace/review-tree.js';
import { commitReviewedTree, inspectCommitOutcome } from '../src/workspace/git-commit.js';

test('commit creates exactly the reviewed tree and refuses a changed baseline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-commit-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree'); await mkdir(primary);
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git(primary, 'init', '-q'); git(primary, 'config', 'user.name', 'Fixture'); git(primary, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(primary, 'a'), 'old'); git(primary, 'add', 'a'); git(primary, 'commit', '-qm', 'initial');
  git(primary, 'worktree', 'add', '--detach', workspace, 'HEAD');
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), lease = coordinator.acquire(workspace, 'run', 'host');
  await writeFile(path.join(workspace, 'a'), 'new');
  const baseline = await captureBaseline(workspace), review = await buildReviewTree(workspace, baseline.baselineHash);
  const args = { workspace, lease, coordinator, expectedParent: review.head, expectedTree: review.tree, baselineHash: baseline.baselineHash, message: 'fixture' };
  assert.equal((await inspectCommitOutcome(args)).state, 'not_applied');
  await assert.rejects(commitReviewedTree({ ...args, expectedTree: 'a'.repeat(40) }), /Reviewed tree/);
  const receipt = await commitReviewedTree(args);
  assert.equal(git(workspace, 'rev-parse', 'HEAD'), receipt.commit);
  assert.equal(git(workspace, 'rev-parse', 'HEAD^{tree}'), review.tree);
  assert.equal(git(workspace, 'status', '--porcelain'), '');
  assert.equal(git(primary, 'rev-parse', 'HEAD'), review.head);
  assert.equal((await inspectCommitOutcome(args)).state, 'applied');
  await writeFile(path.join(workspace, 'a'), 'later');
  assert.equal((await inspectCommitOutcome(args)).state, 'unknown');
  await assert.rejects(commitReviewedTree(args), /baseline changed/i);
  coordinator.release(lease, true); coordinator.close();
});

test('a partial commit is recognised as applied after a crash although the worktree keeps excluded changes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-partial-commit-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree'); await mkdir(primary);
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git(primary, 'init', '-q'); git(primary, 'config', 'user.name', 'Fixture'); git(primary, 'config', 'user.email', 'fixture@example.test'); git(primary, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(primary, 'user.txt'), 'base\n'); git(primary, 'add', '.'); git(primary, 'commit', '-qm', 'initial');
  git(primary, 'worktree', 'add', '--detach', workspace, 'HEAD');
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), lease = coordinator.acquire(workspace, 'run', 'host');
  // The worktree holds an excluded user change plus the run's own file; the commit tree holds only the run's file.
  await writeFile(path.join(workspace, 'user.txt'), 'user edit\n'); await writeFile(path.join(workspace, 'run.txt'), 'run\n');
  const baseline = await captureBaseline(workspace), reviewed = await buildReviewTree(workspace, baseline.baselineHash);
  const index = path.join(dir, 'index'), env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync('git', ['-C', workspace, 'read-tree', reviewed.head], { env }); execFileSync('git', ['-C', workspace, 'update-index', '--add', 'run.txt'], { env });
  const runTree = execFileSync('git', ['-C', workspace, 'write-tree'], { env, encoding: 'utf8' }).trim();
  const args = { workspace, lease, coordinator, expectedParent: reviewed.head, expectedTree: runTree, workspaceTree: reviewed.tree, baselineHash: baseline.baselineHash, message: 'partial' };
  assert.equal((await inspectCommitOutcome(args)).state, 'not_applied');
  await commitReviewedTree(args); // a crash here leaves the intent without a receipt
  const outcome = await inspectCommitOutcome(args);
  assert.equal(outcome.state, 'applied', 'reconciliation sees the commit instead of creating a second one');
  assert.equal(git(workspace, 'show', 'HEAD:user.txt'), 'base');
  assert.equal(git(workspace, 'status', '--porcelain'), 'M user.txt', 'the excluded change is still in the worktree');
  await writeFile(path.join(workspace, 'run.txt'), 'changed after commit\n');
  assert.equal((await inspectCommitOutcome(args)).state, 'unknown');
  const { workspaceTree: _ignored, ...whole } = args;
  assert.equal((await inspectCommitOutcome(whole)).state, 'unknown', 'a full-tree intent never accepts a dirty worktree');
  coordinator.release(lease, true); coordinator.close();
});
