// Test-only writer dispatch through the core used by LocalRun; no real agent or user repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { WorkspaceCoordinator } from '../../../dist/src/storage/coordination.js';
import { OwnedJournal } from '../../../dist/src/storage/owned-journal.js';
import { RunService } from '../../../dist/src/core/run-service.js';
import { CodexReadOnlyDispatch } from '../../../dist/src/core/codex-readonly-dispatch.js';
import { CodexWriteDispatch } from '../../../dist/src/core/codex-write-dispatch.js';
import { defaultProject, templates } from '../../../dist/src/domain/templates.js';
import { hashJson } from '../../../dist/src/domain/resolve.js';
import { captureBaseline } from '../../../dist/src/workspace/baseline.js';
import { fakeRunnerSession, fakeScope } from '../../../dist/test/helpers/fake-runner.js';

const [source, root, mode] = process.argv.slice(2);
if (![4, 5].includes(process.argv.length) || (mode !== undefined && mode !== '--bound') || !path.isAbsolute(source) || !path.isAbsolute(root)) throw Error('Invalid fixture paths');
const primary = path.join(root, 'repo'), workspace = path.join(root, 'worktree');
const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });
git('clone', '--no-local', '--no-hardlinks', '--no-tags', '--', source, primary);
git('-C', primary, 'worktree', 'add', '--detach', workspace, 'HEAD');
const coordinator = new WorkspaceCoordinator(path.join(root, 'coordination.sqlite'));
const owner = coordinator.acquireRun('run', 'host'), lease = coordinator.acquire(workspace, 'run', 'host');
const journal = new OwnedJournal(path.join(root, 'events'), coordinator, owner);
try {
  const service = await RunService.create(journal, templates.dev, defaultProject.policy);
  await service.completeControl('start');
  const planner = await fakeRunnerSession('thread', { startTurn: async () => 'plan-turn' });
  const reader = new CodexReadOnlyDispatch(journal, planner.runner, planner.session);
  await service.dispatchReadOnly(reader, 'plan', 'thread', 'plan', 'low', 'plan-attempt', 'plan-request');
  const plan = { planId: 'p', version: 1, goal: 'edit', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: ['make test'], riskChanges: [] };
  await service.recordReadOnlyPlan(reader, 'plan-attempt', { threadId: 'thread', turnId: 'plan-turn', status: 'completed', messages: [JSON.stringify(plan)] });
  await service.approveProposedPlan('approval', 'plan', 'user', 'ui');
  const approval = (await service.report()).approvals[0].approval;
  const admission = { workspace, lease, coordinator, plan, approval, livePolicy: defaultProject.policy,
    expectedBaselineHash: (await captureBaseline(workspace)).baselineHash, sandboxVerified: true, stopVerified: true };
  const evidence = async () => ({ runId: journal.runId, attemptId: 'write-attempt', planHash: hashJson(plan),
    approvalHash: hashJson((await service.report()).approvals[0].approval), workspace: await realpath(workspace),
    fence: lease.fence, baselineHash: (await captureBaseline(workspace)).baselineHash,
    journalHash: hashJson(await journal.read()) });
  let matches = true, crashAfterDispatch = false;
  if (mode === '--bound') {
    const initial = await evidence();
    process.stdout.write(`${JSON.stringify({ event: 'ready', evidence: initial })}\n`);
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let request;
    for await (const line of input) { request = JSON.parse(line); break; }
    input.close(); process.stdin.pause();
    crashAfterDispatch = request?.crashAfterDispatch === true;
    matches = coordinator.isCurrent(lease) && JSON.stringify(request?.evidence) === JSON.stringify(initial) &&
      JSON.stringify(await evidence()) === JSON.stringify(initial);
    if (!matches) process.stdout.write(`${JSON.stringify({ ok: false, error: 'binding_changed' })}\n`);
  }
  if (matches) {
  const real = await realpath(workspace), scope = fakeScope(async () => false);
  const implementer = await fakeRunnerSession('thread', { workspace: real, access: { kind: 'write', writableRoots: [real] }, scope,
    startTurn: async () => {
      await appendFile(path.join(root, 'dispatch-count'), 'dispatch\n');
      if (crashAfterDispatch) process.exit(73);
      return 'write-turn';
    } });
  const writer = new CodexWriteDispatch(journal, implementer.runner, implementer.session);
  await service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'write-attempt', 'write-request', admission, scope);
  await assert.rejects(service.recordWriteTerminal(writer, 'write-attempt', 'thread', 'write-turn', 'stopped', admission, scope), /quarantined/);
  const held = coordinator.getWriter(workspace), report = await service.report(), events = await journal.read();
  assert.equal(held.quarantined, true);
  assert.deepEqual(report.unresolvedAttemptIds, ['write-attempt']);
  assert.equal(coordinator.isCurrent(lease), false);
  await assert.rejects(service.dispatchWrite(writer, 'implement', 'thread', 'edit', 'low', 'second-attempt', 'second-request', admission, scope));
  const types = events.filter(e => e.payload?.attemptId === 'write-attempt').map(e => e.type);
  for (const required of ['dispatch_intent', 'workspace_dispatch_bound', 'worker_scope_bound', 'dispatch_receipt']) assert.ok(types.includes(required));
  assert.ok(!types.includes('attempt_finished'));
  process.stdout.write(`${JSON.stringify({ ok: false, quarantined: true, unresolved: true, dispatches: 1, journal: types })}\n`);
  }
} finally {
  await journal.close();
  // Preserve the quarantine in the test-owned coordination DB; no unsafe release.
  coordinator.close();
}
