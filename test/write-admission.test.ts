import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { recordApproval } from '../src/domain/approval.js';
import { defaultProject } from '../src/domain/templates.js';
import { captureBaseline } from '../src/workspace/baseline.js';
import { CodexWorkspaceWriteAdapter } from '../src/adapters/codex-workspace-write.js';
import { admitIsolatedWorkspaceWrite } from '../src/workspace/write-admission.js';
import { fakeBinding, fakeRunnerSession, fakeScope } from './helpers/fake-runner.js';

test('write admission requires live approval, full scope, verified runtime, current lease and matching baseline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-admission-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree'); await mkdir(primary);
  const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
  git('init', '-q'); await writeFile(path.join(primary, 'a'), 'before'); git('add', 'a');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  git('worktree', 'add', '--detach', workspace, 'HEAD');
  await mkdir(path.join(workspace, 'src'));
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), lease = coordinator.acquire(workspace, 'run', 'host');
  const plan = { planId: 'p', version: 1, goal: 'test', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [] };
  const approval = recordApproval(plan, defaultProject.policy, { approvalId: 'a', actor: 'user', source: 'ui', decision: 'approved', timestamp: new Date().toISOString() });
  const expectedBaselineHash = (await captureBaseline(workspace)).baselineHash;
  const args = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy, expectedBaselineHash, sandboxVerified: true, stopVerified: true };
  assert.equal((await admitIsolatedWorkspaceWrite(args)).runId, 'run');
  const scopedPlan = { ...plan, scope: ['src'] };
  const scopedApproval = recordApproval(scopedPlan, defaultProject.policy, { approvalId: 'b', actor: 'user', source: 'ui', decision: 'approved', timestamp: new Date().toISOString() });
  const scopedGrant = await admitIsolatedWorkspaceWrite({ ...args, plan: scopedPlan, approval: scopedApproval });
  assert.deepEqual(scopedGrant.writableRoots, [path.join(workspace, 'src')]);
  const filePlan = { ...plan, scope: ['a'] };
  const fileApproval = recordApproval(filePlan, defaultProject.policy, { approvalId: 'c', actor: 'user', source: 'ui', decision: 'approved', timestamp: new Date().toISOString() });
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, plan: filePlan, approval: fileApproval }), /real directories/);

  const calls: Array<{ method: string; params: unknown }> = [];
  const adapter = new CodexWorkspaceWriteAdapter({ request: async (method, params) => {
    calls.push({ method, params }); return method === 'thread/resume' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } };
  } });
  await adapter.resumeThread('thread', 'gpt-6-luna', args);
  assert.equal(await adapter.startTurn('thread', 'implement', 'low', args), 'turn');
  const turn = calls[1]?.params as { cwd: string; sandboxPolicy: { type: string; writableRoots: string[]; networkAccess: boolean } };
  assert.equal(turn.cwd, workspace); assert.equal(turn.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [workspace]); assert.equal(turn.sandboxPolicy.networkAccess, false);
  let selectedModel = 'gpt-6-luna';
  const verifiedAdapter = new CodexWorkspaceWriteAdapter({ request: async () => ({ thread: { id: 'thread' }, model: selectedModel,
    modelProvider: 'openai', cwd: workspace, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } }) });
  const binding = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  assert.throws(() => verifiedAdapter.assertBound('thread', binding, workspace), /not been verified/);
  await verifiedAdapter.resumeVerifiedThread('thread', binding.model, binding.provider, args);
  verifiedAdapter.assertBound('thread', binding, workspace);
  selectedModel = 'other';
  await assert.rejects(verifiedAdapter.resumeVerifiedThread('thread', binding.model, binding.provider, args), /does not match/);
  assert.throws(() => verifiedAdapter.assertBound('thread', binding, workspace), /not been verified/);
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, sandboxVerified: false }), /Verified sandbox/);
  await assert.rejects(admitIsolatedWorkspaceWrite({ ...args, plan: { ...plan, scope: ['src'] } }), /Approval does not match/);
  await writeFile(path.join(workspace, 'a'), 'changed');
  await assert.rejects(admitIsolatedWorkspaceWrite(args), /baseline changed/);
  coordinator.release(lease, true); coordinator.close();
});

test('journaled writer requires the recorded approval before dispatch and captures changed baseline', async () => {
  const { RunService } = await import('../src/core/run-service.js');
  const { CodexReadOnlyDispatch } = await import('../src/core/codex-readonly-dispatch.js');
  const { CodexWriteDispatch } = await import('../src/core/codex-write-dispatch.js');
  const { CodexReviewDispatch } = await import('../src/core/codex-review-dispatch.js');
  const { GitCommitDispatch } = await import('../src/core/git-commit-dispatch.js');
  const { CodexCheckDispatch } = await import('../src/core/codex-check-dispatch.js');
  const { CodexCheckExecutor } = await import('../src/adapters/codex-check.js');
  const { buildReviewTree } = await import('../src/workspace/review-tree.js');
  const { OwnedJournal } = await import('../src/storage/owned-journal.js');
  const { templates } = await import('../src/domain/templates.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-write-dispatch-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree');
  await mkdir(primary); const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(primary, 'a'), 'before'); git('add', 'a');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  git('worktree', 'add', '--detach', workspace, 'HEAD');
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), owner = coordinator.acquireRun('run', 'host');
  const lease = coordinator.acquire(workspace, 'run', 'host'), journal = new OwnedJournal(path.join(dir, 'events'), coordinator, owner);
  const service = await RunService.create(journal, templates.dev, defaultProject.policy); await service.completeControl('start');
  const planner = await fakeRunnerSession('thread', { startTurn: async () => 'plan-turn' });
  const reader = new CodexReadOnlyDispatch(journal, planner.runner, planner.session);
  await service.dispatchReadOnly(reader, 'plan', 'thread', 'plan', 'low', 'plan-attempt', 'plan-request');
  const plan = { planId: 'p', version: 1, goal: 'edit', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: ['make test'], riskChanges: [] };
  await service.recordReadOnlyPlan(reader, 'plan-attempt', { threadId: 'thread', turnId: 'plan-turn', status: 'completed', messages: [JSON.stringify(plan)] });
  await service.approveProposedPlan('approval', 'plan', 'user', 'ui');
  const report = await service.report(), approval = report.approvals[0]!.approval;
  const admission = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy,
    expectedBaselineHash: (await captureBaseline(workspace)).baselineHash, sandboxVerified: true, stopVerified: true };
  let calls = 0;
  const real = await realpath(workspace), implementer = await fakeRunnerSession('thread', { startTurn: async () => { calls++; return 'write-turn'; },
    workspace: real, access: { kind: 'write', writableRoots: [real] } });
  const scope = implementer.runner.scope, writer = new CodexWriteDispatch(journal, implementer.runner, implementer.session);
  await assert.rejects(service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', { ...admission, stopVerified: false }, scope), /Verified sandbox/);
  assert.equal(calls, 0);
  await service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', admission, scope);
  await writeFile(path.join(workspace, 'a'), 'after');
  await assert.rejects(service.recordWriteTerminal(writer, 'write-attempt', 'thread', 'write-turn', 'completed', { ...admission, workspace: primary }, scope), /does not match dispatch/);
  await service.recordWriteTerminal(writer, 'write-attempt', 'thread', 'write-turn', 'completed', admission, scope);
  const after = await service.report(); assert.equal(after.graph.nodes.repair?.status, 'ready');
  assert.equal(after.attempts.find(item => item.attemptId === 'write-attempt')?.baselineHash, (await captureBaseline(workspace)).baselineHash);
  const reviewedBaseline = after.attempts.find(item => item.attemptId === 'write-attempt')!.baselineHash!;
  await service.completeControl('repair');
  const reviewer = await fakeRunnerSession('review-thread', { startTurn: async () => 'review-turn', workspace: real });
  const review = new CodexReviewDispatch(journal, reviewer.runner, reviewer.session);
  // The implementer's own session must not review its work.
  const producerSession = await reviewer.runner.openSession({ workspace: real, binding: fakeBinding, access: { kind: 'read' }, resumeSessionId: 'thread' });
  await writeFile(path.join(workspace, 'a'), 'changed after implementation');
  await assert.rejects(service.dispatchReview(review, 'verify', 'required-reviewer', 'review-thread', 'review', 'low', 'review-attempt', 'review-request', reviewedBaseline, admission), /baseline changed/);
  await writeFile(path.join(workspace, 'a'), 'after');

  await assert.rejects(service.dispatchReview(new CodexReviewDispatch(journal, reviewer.runner, producerSession), 'verify', 'required-reviewer', 'thread', 'review', 'low', 'review-attempt', 'review-request', reviewedBaseline, admission), /independent session/);
  await service.dispatchReview(review, 'verify', 'required-reviewer', 'review-thread', 'review', 'low', 'review-attempt', 'review-request', reviewedBaseline, admission);
  const result = { threadId: 'review-thread', turnId: 'review-turn', status: 'completed' as const, messages: [JSON.stringify({ verdict: 'pass', findingIds: [], summary: 'Fixture checks pass' })] };
  await assert.rejects(service.recordReview(review, 'verify', 'wrong-reviewer', reviewedBaseline, 'review-attempt', result, admission), /does not match/);
  await service.recordReview(review, 'verify', 'required-reviewer', reviewedBaseline, 'review-attempt', result, admission);
  const assessments = { 'required-reviewer': { evidenceValidated: true, criteriaCovered: true, verifiedFindingIds: [], unresolvedDisagreement: false, mandatoryCriteriaFailed: false } };
  await assert.rejects(service.finishReview(review, 'verify', 'thread', reviewedBaseline, assessments, admission), /has not passed/);
  const checkTransport = { request: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) };
  const checkScope = { identity: { unit: 'neomind-run-efab.scope', controlGroup: '/user.slice/neomind-run-efab.scope' }, transport: checkTransport, isActive: async () => true, stop: async () => true };
  const check = new CodexCheckDispatch(journal, new CodexCheckExecutor(checkTransport));
  await service.runCheck(check, { id: 'tests', command: ['make', 'test'], cwd: workspace, timeoutMs: 10000 }, reviewedBaseline, admission, 'check-request', checkScope);
  const decision = await service.finishReview(review, 'verify', 'thread', reviewedBaseline, assessments, admission);
  assert.equal(decision.decision, 'pass'); assert.equal((await service.report()).graph.nodes.commit?.status, 'ready');
  const reviewed = await buildReviewTree(workspace, reviewedBaseline);
  const committed = await service.commit(new GitCommitDispatch(journal), { nodeId: 'commit', reviewNodeId: 'verify', workspace, lease, coordinator,
    livePolicy: defaultProject.policy, baselineHash: reviewedBaseline, parent: reviewed.head, tree: reviewed.tree, message: 'fixture', requestId: 'commit-request' });
  assert.equal(committed.tree, reviewed.tree);
  await service.completeControl('finish');
  assert.equal((await service.report()).graph.nodes.finish?.status, 'succeeded');


  await journal.close(); coordinator.release(lease, true); coordinator.releaseRun(owner, true); coordinator.close();
});

test('terminal writer event without verified worker stop quarantines workspace', async () => {
  const { RunService } = await import('../src/core/run-service.js');
  const { CodexReadOnlyDispatch } = await import('../src/core/codex-readonly-dispatch.js');
  const { CodexWriteDispatch } = await import('../src/core/codex-write-dispatch.js');
  const { OwnedJournal } = await import('../src/storage/owned-journal.js');
  const { templates } = await import('../src/domain/templates.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-quarantine-')), primary = path.join(dir, 'repo'), workspace = path.join(dir, 'worktree'); await mkdir(primary);
  const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
  git('init', '-q'); await writeFile(path.join(primary, 'a'), 'before'); git('add', 'a');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial'); git('worktree', 'add', '--detach', workspace, 'HEAD');
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), owner = coordinator.acquireRun('run', 'host');
  const lease = coordinator.acquire(workspace, 'run', 'host'), journal = new OwnedJournal(path.join(dir, 'events'), coordinator, owner);
  const service = await RunService.create(journal, templates.dev, defaultProject.policy); await service.completeControl('start');
  const planner = await fakeRunnerSession('thread', { startTurn: async () => 'plan-turn' });
  const reader = new CodexReadOnlyDispatch(journal, planner.runner, planner.session);
  await service.dispatchReadOnly(reader, 'plan', 'thread', 'plan', 'low', 'plan-attempt', 'plan-request');
  const plan = { planId: 'p', version: 1, goal: 'edit', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [] };
  await service.recordReadOnlyPlan(reader, 'plan-attempt', { threadId: 'thread', turnId: 'plan-turn', status: 'completed', messages: [JSON.stringify(plan)] });
  await service.approveProposedPlan('approval', 'plan', 'user', 'ui');
  const approval = (await service.report()).approvals[0]!.approval;
  const admission = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy, expectedBaselineHash: (await captureBaseline(workspace)).baselineHash, sandboxVerified: true, stopVerified: true };
  const real = await realpath(workspace), scope = fakeScope(async () => false);
  const implementer = await fakeRunnerSession('thread', { startTurn: async () => 'write-turn', workspace: real, access: { kind: 'write', writableRoots: [real] }, scope });
  const writer = new CodexWriteDispatch(journal, implementer.runner, implementer.session);
  await service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', admission, scope);
  await assert.rejects(service.recordWriteTerminal(writer, 'write-attempt', 'thread', 'write-turn', 'stopped', admission, scope), /quarantined/);
  assert.equal(coordinator.isCurrent(lease), false); assert.deepEqual((await service.report()).unresolvedAttemptIds, ['write-attempt']);
  await journal.close(); coordinator.release(lease, true); coordinator.releaseRun(owner, true); coordinator.close();
});
