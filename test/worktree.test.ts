import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { ProjectMemoryRegistry } from '../src/memory/registry.js';
import { resolveDefaultMemoryRoot } from '../src/memory/project-root.js';
import { createDetachedWorktree, primaryWorktree } from '../src/workspace/worktree.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { commitReviewedTree } from '../src/workspace/git-commit.js';
import { admitIsolatedWorkspaceWrite } from '../src/workspace/write-admission.js';
import { defaultProject } from '../src/domain/templates.js';
import { recordApproval } from '../src/domain/approval.js';
import { captureBaseline } from '../src/workspace/baseline.js';
import { buildReviewTree } from '../src/workspace/review-tree.js';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
test('detached worktree uses exact commit and resolves shared primary without disturbing dirty source', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-worktree-')), root = path.join(dir, 'repo'); mkdirSync(root);
  git(root, 'init', '-q'); writeFileSync(path.join(root, 'file'), 'committed'); git(root, 'add', 'file');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  const commit = git(root, 'rev-parse', 'HEAD').trim(); writeFileSync(path.join(root, 'file'), 'dirty');
  const before = git(root, 'status', '--porcelain');
  const result = createDetachedWorktree(root, path.join(dir, 'worktree'), commit);
  assert.equal(result.commit, commit);
  assert.equal(readFileSync(path.join(result.path, 'file'), 'utf8'), 'committed');
  assert.equal(readFileSync(path.join(root, 'file'), 'utf8'), 'dirty');
  assert.equal(git(root, 'status', '--porcelain'), before);
  assert.equal(primaryWorktree(result.path), root);
  assert.throws(() => resolveDefaultMemoryRoot(result.path), /ENOENT/);
  mkdirSync(path.join(root, '.neomind')); mkdirSync(path.join(root, '.neomind', 'memory'));
  assert.equal(resolveDefaultMemoryRoot(result.path), path.join(root, '.neomind', 'memory'));
  assert.equal(resolveDefaultMemoryRoot(root), resolveDefaultMemoryRoot(result.path));
  const registry = new ProjectMemoryRegistry(path.join(dir, 'registry.sqlite'));
  registry.set(root, resolveDefaultMemoryRoot(root), null);
  assert.equal(registry.resolve(result.path), resolveDefaultMemoryRoot(root));
  assert.throws(() => registry.set(result.path, resolveDefaultMemoryRoot(root), null), /mapping conflict/);
  registry.close();
  const memory = new MemoryStore(resolveDefaultMemoryRoot(root), path.join(dir, 'registry.sqlite'));
  memory.write({ id: 'fact', type: 'context', scope: 'project', sources: ['file'], tags: [], body: 'Shared fact' }, null, { projectWrite: true, confirmedByUser: false });
  memory.close();
  const output = execFileSync(process.execPath, [path.resolve('dist/src/cli/main.js'), 'memory', 'project-search', result.path, path.join(dir, 'registry.sqlite'), 'shared'], { encoding: 'utf8' });
  assert.equal((JSON.parse(output) as unknown[]).length, 1);
  assert.throws(() => createDetachedWorktree(root, result.path, commit), /already exists/);
  assert.throws(() => createDetachedWorktree(root, path.join(dir, 'other'), 'HEAD'), /full Git commit/);
});

test('submodule primary and linked worktree resolve to the checkout and protect it from isolated writes', async () => {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'neomind-submodule-')));
  const source = path.join(dir, 'source'), parent = path.join(dir, 'parent');
  mkdirSync(source); mkdirSync(parent);
  for (const repo of [source, parent]) {
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(path.join(repo, 'file'), 'initial'); git(repo, 'add', 'file'); git(repo, 'commit', '-qm', 'initial');
  }
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'child');
  const child = realpathSync.native(path.join(parent, 'child'));
  git(child, 'checkout', '--detach', '-q');
  git(child, 'config', 'user.name', 'Fixture'); git(child, 'config', 'user.email', 'fixture@example.test');
  const linked = createDetachedWorktree(child, path.join(dir, 'linked'), git(child, 'rev-parse', 'HEAD').trim()).path;
  assert.equal(primaryWorktree(parent), parent);
  assert.equal(primaryWorktree(child), child);
  assert.equal(primaryWorktree(linked), child);
  mkdirSync(path.join(child, 'neomind'));
  assert.equal(resolveDefaultMemoryRoot(child, true), path.join(child, 'neomind', 'memory'));
  assert.equal(resolveDefaultMemoryRoot(linked), path.join(child, 'neomind', 'memory'));

  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db'));
  const lease = coordinator.acquire(child, 'run', 'host');
  const plan = { planId: 'p', version: 1, goal: 'test', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [] };
  const approval = recordApproval(plan, defaultProject.policy, { approvalId: 'a', actor: 'user', source: 'ui', decision: 'approved', timestamp: new Date().toISOString() });
  try {
    await assert.rejects(admitIsolatedWorkspaceWrite({ workspace: child, lease, coordinator, plan, approval, livePolicy: defaultProject.policy,
      expectedBaselineHash: '', sandboxVerified: true, stopVerified: true }), /separate Git worktree/);
    await assert.rejects(commitReviewedTree({ workspace: child, lease, coordinator, expectedParent: '', expectedTree: '', baselineHash: '', message: 'test' }), /separate worktree/);
    const linkedLease = coordinator.acquire(linked, 'linked-run', 'host');
    try {
      const baseline = await captureBaseline(linked);
      await admitIsolatedWorkspaceWrite({ workspace: linked, lease: linkedLease, coordinator, plan, approval, livePolicy: defaultProject.policy,
        expectedBaselineHash: baseline.baselineHash, sandboxVerified: true, stopVerified: true });
      const review = await buildReviewTree(linked, baseline.baselineHash);
      const receipt = await commitReviewedTree({ workspace: linked, lease: linkedLease, coordinator, expectedParent: review.head,
        expectedTree: review.tree, baselineHash: baseline.baselineHash, message: 'fixture' });
      assert.equal(git(linked, 'rev-parse', 'HEAD').trim(), receipt.commit);
      assert.equal(git(child, 'rev-parse', 'HEAD').trim(), review.head);
    } finally { coordinator.release(linkedLease, true); }
  } finally { coordinator.release(lease, true); coordinator.close(); }
});
