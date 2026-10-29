import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalRun } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { RunStore } from '../src/storage/run-store.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import type { WorkerFactory } from '../src/runtime/worker.js';

async function fixture(repair = false, kind: 'dev' | 'research' = 'dev', reviewers = 1, holdCheck = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-local-runtime-')), project = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(project); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(project, 'README.md'), 'Fixture\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: role, verifier: role } };
  await mkdir(path.join(project, '.neomind')); await writeFile(path.join(project, '.neomind/project.json'), JSON.stringify(config));
  const profiles = { 'implementer@1': builtinProfile('implementer'), 'verifier@1': builtinProfile('verifier') };
  const flow = structuredClone(templates[kind]);
  if (reviewers > 1) {
    flow.definition.limits.maxConcurrency = 2;
    const group = flow.definition.nodes.find(node => node.type === 'review_group')!;
    if (group.type !== 'review_group') throw new Error('Bad fixture');
    for (let n = 2; n <= reviewers; n++) { const sessionGroup = `reviewer-session-${n}`; flow.definition.sessionGroups.push({ id: sessionGroup, bindingId: 'verifier' }); group.reviewers.push({ ...group.reviewers[0]!, id: `reviewer-${n}`, sessionGroup }); }
  }
  const snapshot = await materializeRun(flow, config, profiles, project), coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  let writes = 0, planCalls = 0, activeReviews = 0, peakReviews = 0;
  let notifyCheck!: () => void; const checkStarted = new Promise<void>(resolve => { notifyCheck = resolve; });
  const threads = new Map<string, { cwd: string; model: string; sandbox: string }>(), tokenTotals = new Map<string, number>();
  const factory: WorkerFactory = async () => {
    const events = new CodexTurnEvents(); let active = true, rejectCheck: ((error: Error) => void) | undefined;
    const transport = { request: async (method: string, input: unknown): Promise<unknown> => {
      const params = input as Record<string, unknown>;
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'thread/start' || method === 'thread/resume') {
        const id = method === 'thread/start' ? randomUUID() : String(params.threadId);
        const thread = { cwd: String(params.cwd), model: String(params.model), sandbox: String(params.sandbox) }; threads.set(id, thread);
        return { thread: { id }, cwd: thread.cwd, model: thread.model, modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: thread.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
      }
      if (method === 'command/exec') { if (holdCheck) { notifyCheck(); return new Promise((_resolve, reject) => { rejectCheck = reject; }); } return { exitCode: 0, stdout: '', stderr: '' }; }
      if (method !== 'turn/start') throw new Error(`Unexpected method ${method}`);
      const threadId = String(params.threadId), turnId = randomUUID(), thread = threads.get(threadId)!;
      const schema = params.outputSchema as { properties?: Record<string, unknown> } | undefined;
      let output: unknown;
      if (schema?.properties?.planId) output = { planId: 'fixture-plan', version: ++planCalls, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: ['test -f proof.txt'], riskChanges: [] };
      else if (schema?.properties?.evidence) {
        activeReviews++; peakReviews = Math.max(peakReviews, activeReviews);
        const filename = kind === 'research' ? 'README.md' : 'proof.txt';
        const text = (await readFile(path.join(thread.cwd, filename), 'utf8')).trim(), failed = kind !== 'research' && text !== 'ok';
        const reference = { kind: 'source', path: filename, line: 1, quote: text };
        output = { verdict: failed ? 'needs_changes' : 'pass', findingIds: failed ? ['wrong-proof'] : [], summary: failed ? 'Proof is wrong' : 'Proof matches',
          evidence: { criteria: (kind === 'research' ? ['sources', 'claims'] : ['approved plan', 'checks', 'regressions', 'proof']).map(criterion => ({ criterion, status: failed && criterion === 'proof' ? 'fail' : 'pass', references: [reference] })),
            findings: failed ? [{ id: 'wrong-proof', criterion: 'proof', explanation: 'Expected ok', references: [reference] }] : [] } };
      } else if (thread.sandbox === 'read-only') { output = 'README.md line 1 contains Fixture. This report is based on that local source.'; }
      else { writes++; await writeFile(path.join(thread.cwd, 'proof.txt'), repair && writes === 1 ? 'wrong\n' : 'ok\n'); output = 'Implemented'; }
      const emit = () => {
      events.accept('item/completed', { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text: typeof output === 'string' ? output : JSON.stringify(output) } });
      const total = (tokenTotals.get(threadId) ?? 0) + 100; tokenTotals.set(threadId, total);
      events.accept('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: total - 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: total } } });
      events.accept('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
        if (schema?.properties?.evidence) activeReviews--;
      };
      if (schema?.properties?.evidence && reviewers > 1) setTimeout(emit, 1000); else emit();
      return { turn: { id: turnId } };
    } };
    return { events, fault: () => undefined, scope: { transport, identity: { unit: `neomind-run-${randomUUID()}.scope`, controlGroup: `/user.slice/user-${process.getuid?.() ?? 0}.slice/fixture.scope` }, isActive: async () => active, stop: async () => { active = false; if (rejectCheck) { const reject = rejectCheck; rejectCheck = undefined; reject(new Error('Check interrupted')); } return true; } } };
  };
  const run = await LocalRun.create({ projectRoot: project, stateRoot: state, task: kind === 'research' ? 'Summarize README.md and cite the source' : 'Add proof', snapshot, coordinator, workerFactory: factory, capabilityCheck: async () => ({ sandboxVerified: true, stopVerified: true }) });
  return { run, coordinator, state, factory, writes: () => writes, peakReviews: () => peakReviews, checkStarted };
}

test('real orchestration services wait for approval, resume after reopen and commit reviewed output', async () => {
  const f = await fixture(); let run = f.run;
  try {
    run.launch(); await run.settled();
    assert.equal((await run.report()).runtimeState.phase, 'waiting_approval'); assert.equal(f.writes(), 0);
    await run.close();
    run = await LocalRun.recover(await RunStore.open(path.join(f.state, 'runs')), f.coordinator, run.runId, f.factory, async () => ({ sandboxVerified: true, stopVerified: true }));
    await run.approve('fixture-user-simulated-approval', 'cli'); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(report.commits[0]?.confirmed, true); assert.equal(f.writes(), 1);
    assert.equal(report.usage.totalTokens, 300); assert.equal(report.usage.partial, false);
    assert.equal(await readFile(path.join(run.context.workspace, 'proof.txt'), 'utf8'), 'ok\n');
  } finally { await run.close(); f.coordinator.close(); }
});

test('repair runs through the same services, keeps approval and reuses independent sessions', async () => {
  const f = await fixture(true);
  try {
    f.run.launch(); await f.run.settled(); await f.run.approve('fixture-user-simulated-approval', 'cli'); await f.run.settled();
    const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason); assert.equal(report.repairRounds.length, 1); assert.equal(f.writes(), 2);
    assert.equal(report.approvals.length, 1);
    const writers = report.attempts.filter(attempt => attempt.nodeId === 'implement'), reviewers = report.attempts.filter(attempt => attempt.nodeId === 'verify');
    assert.equal(writers[0]?.sessionId, writers[1]?.sessionId); assert.equal(reviewers[0]?.sessionId, reviewers[1]?.sessionId);
    assert.notEqual(writers[0]?.sessionId, reviewers[0]?.sessionId);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('plan feedback creates a new unapproved version and stale approval is rejected', async () => {
  const f = await fixture();
  try {
    f.run.launch(); await f.run.settled(); const first = await f.run.report();
    await f.run.revisePlan('Keep the change small', first.proposedPlanHash!); await f.run.settled();
    const revised = await f.run.report();
    assert.equal(revised.plans[0]?.plan.version, 2); assert.equal(revised.approvals.length, 0); assert.equal(f.writes(), 0);
    await assert.rejects(f.run.approve('fixture-user', 'cli', first.proposedPlanHash), /đã thay đổi/);
    await f.run.approve('fixture-user', 'cli', revised.proposedPlanHash); await f.run.settled();
    assert.equal((await f.run.report()).runtimeState.phase, 'completed');
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('cancelling at approval retains the workspace and prevents subsequent execution', async () => {
  const f = await fixture();
  try {
    f.run.launch(); await f.run.settled(); await f.run.stop('cancel');
    assert.equal((await f.run.report()).runtimeState.phase, 'cancelled'); assert.equal(f.writes(), 0);
    assert.equal(await readFile(path.join(f.run.context.workspace, 'README.md'), 'utf8'), 'Fixture\n');
    await assert.rejects(f.run.resume(), /không thể tiếp tục/);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('local commit failure preserves technical acceptance and retries only after an explicit Git action', async () => {
  const f = await fixture();
  const git = (...args: string[]) => execFileSync('git', ['-C', f.run.context.workspace, ...args], { stdio: 'ignore' });
  try {
    git('config', 'user.name', ''); git('config', 'user.email', '');
    f.run.launch(); await f.run.settled(); await f.run.approve('fixture-user', 'cli'); await f.run.settled();
    const waiting = await f.run.report();
    assert.equal(waiting.runtimeState.phase, 'blocked'); assert.equal(waiting.acceptedReviews.length, 1); assert.equal(waiting.unresolvedCommitNodeIds.length, 1);
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    await f.run.retryGit(); await f.run.settled();
    const finished = await f.run.report(); assert.equal(finished.runtimeState.phase, 'completed', finished.runtimeState.reason); assert.equal(f.writes(), 1);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('local Research completes with an independently reviewed artifact and no source write or commit', async () => {
  const f = await fixture(false, 'research');
  try {
    f.run.launch(); await f.run.settled(); const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(f.writes(), 0); assert.equal(report.approvals.length, 0); assert.equal(report.commits.length, 0);
    const artifact = report.artifacts.find(item => item.nodeId === 'research');
    assert.ok(artifact?.attemptId); assert.ok(artifact?.baselineHash); assert.match(artifact?.text ?? '', /README.md/);
    assert.equal(report.acceptedReviews.length, 1);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('multiple required reviewers run concurrently within the per-run cap and all must pass', async () => {
  const f = await fixture(false, 'dev', 3);
  try {
    f.run.launch(); await f.run.settled(); await f.run.approve('fixture-user', 'cli'); await f.run.settled();
    const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason); assert.equal(report.reviewerOutputs.length, 3);
    assert.equal(f.peakReviews(), 2); assert.equal(new Set(report.reviewerOutputs.map(output => output.result.sessionId)).size, 3);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('waiting time is excluded and an explicit time extension survives recovery', async () => {
  const f = await fixture(); let run = f.run;
  try {
    run.launch(); await run.settled(); const waiting = await run.report();
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await run.report()).runtimeState.activeMs, waiting.runtimeState.activeMs);
    await run.stop('pause'); await run.extendTime(60); await run.settled();
    assert.equal((await run.report()).timeExtensionsMs, 60000);
    await run.close(); run = await LocalRun.recover(await RunStore.open(path.join(f.state, 'runs')), f.coordinator, run.runId, f.factory, async () => ({ sandboxVerified: true, stopVerified: true }));
    const recovered = await run.report(); assert.equal(recovered.timeLimitMs, 1860000); assert.equal(recovered.runtimeState.phase, 'recovering'); assert.equal(f.writes(), 0);
  } finally { await run.close(); f.coordinator.close(); }
});

test('pause interrupts an active check before waiting for serialized state updates', async () => {
  const f = await fixture(false, 'dev', 1, true);
  try {
    f.run.launch(); await f.run.settled(); await f.run.approve('fixture-user', 'cli'); await f.checkStarted;
    let timeout: NodeJS.Timeout | undefined;
    try { await Promise.race([f.run.stop('pause'), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Pause waited for the active check')), 3000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    const report = await f.run.report();
    // The test transport's synthetic scope has no OS stop proof, so it must remain blocked.
    assert.equal(report.runtimeState.phase, 'blocked'); assert.equal(report.unresolvedCheckIds.length, 1);
    assert.equal(f.coordinator.getWriter(f.run.context.workspace)?.quarantined, true);
  } finally { await f.run.close(); f.coordinator.close(); }
});
