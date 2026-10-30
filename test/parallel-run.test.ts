import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalRun } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile, standaloneDiagnostics } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import type { WorkerFactory } from '../src/runtime/worker.js';

type Mode = 'separate' | 'repair' | 'conflict' | 'stubborn' | 'no-packets' | 'branch-fails';

/** Deterministic runner: branch writers edit their worktree, the integration agent resolves conflicts, the reviewer cites sources. */
async function fixture(mode: Mode) {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-parallel-')), project = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(project); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await mkdir(path.join(project, 'a')); await mkdir(path.join(project, 'b'));
  await writeFile(path.join(project, 'a', 'README'), 'a\n'); await writeFile(path.join(project, 'b', 'README'), 'b\n');
  await writeFile(path.join(project, 'shared.txt'), 'header\nvalue = base\nfooter\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: role, verifier: role } };
  await mkdir(path.join(project, '.neomind')); await writeFile(path.join(project, '.neomind/project.json'), JSON.stringify(config));
  const snapshot = await materializeRun(templates.parallel, config, { 'implementer@1': builtinProfile('implementer'), 'verifier@1': builtinProfile('verifier') }, project);
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const threads = new Map<string, { cwd: string; sandbox: string }>(), tokens = new Map<string, number>();
  let activeWriters = 0, peakWriters = 0, integrationTurns = 0, reviews = 0, startedWriters = 0;
  // Writer turns finish only once both writers have started (or after 5 s), so overlap does not depend on machine load.
  let releaseWriters!: () => void; const bothStarted = new Promise<void>(resolve => { releaseWriters = resolve; });
  const separate = mode === 'separate' || mode === 'repair';
  const factory: WorkerFactory = async () => {
    const events = new CodexTurnEvents(); let active = true;
    const transport = { request: async (method: string, input: unknown): Promise<unknown> => {
      const params = input as Record<string, unknown>;
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'command/exec') return { exitCode: 0, stdout: '', stderr: '' };
      if (method === 'thread/start' || method === 'thread/resume') {
        const id = method === 'thread/start' ? randomUUID() : String(params.threadId);
        threads.set(id, { cwd: String(params.cwd), sandbox: String(params.sandbox) });
        return { thread: { id }, cwd: String(params.cwd), model: String(params.model), modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
      }
      if (method !== 'turn/start') throw new Error(`Unexpected method ${method}`);
      const threadId = String(params.threadId), turnId = randomUUID(), thread = threads.get(threadId)!;
      const schema = params.outputSchema as { properties?: Record<string, unknown> } | undefined;
      let output: unknown, delay = 0, status = 'completed';
      if (schema?.properties?.planId) {
        output = { planId: 'parallel-plan', version: 1, goal: 'Add parts A and B', scope: ['.'], approach: 'Each branch adds its part', acceptanceCriteria: ['parts present'], checks: [], riskChanges: [],
          workPackets: mode === 'no-packets' ? [] : [{ nodeId: 'implement-a', goal: 'Part A', scope: separate ? ['a'] : ['.'] }, { nodeId: 'implement-b', goal: 'Part B', scope: separate ? ['b'] : ['.'] }] };
      } else if (schema?.properties?.evidence) {
        const ref = separate ? { kind: 'source', path: 'a/a.txt', line: 1, quote: (await readFile(path.join(thread.cwd, 'a', 'a.txt'), 'utf8')).trim() } : { kind: 'source', path: 'shared.txt', line: 2, quote: (await readFile(path.join(thread.cwd, 'shared.txt'), 'utf8')).split('\n')[1] };
        const failing = mode === 'repair' && ++reviews === 1;
        output = { verdict: failing ? 'needs_changes' : 'pass', findingIds: failing ? ['part-a-incomplete'] : [], summary: failing ? 'Part A is incomplete' : 'Integrated parts verified',
          evidence: { criteria: ['approved plan', 'checks', 'regressions', 'parts present'].map(criterion => ({ criterion, status: failing && criterion === 'parts present' ? 'fail' : 'pass', references: [ref] })),
            findings: failing ? [{ id: 'part-a-incomplete', criterion: 'parts present', explanation: 'Part A lacks its final value', references: [ref] }] : [] } };
      } else if (thread.sandbox !== 'read-only' && /--implement-[ab]$/.test(thread.cwd)) {
        const branch = thread.cwd.endsWith('--implement-a') ? 'a' : 'b';
        activeWriters++; peakWriters = Math.max(peakWriters, activeWriters); delay = 1;
        if (++startedWriters === 2) releaseWriters();
        if (mode === 'branch-fails' && branch === 'b') status = 'failed';
        else if (separate) await writeFile(path.join(thread.cwd, branch, `${branch}.txt`), `from ${branch}\n`);
        else await writeFile(path.join(thread.cwd, 'shared.txt'), `header\nvalue = ${branch}\nfooter\n`);
        output = `Implemented part ${branch}`;
      } else if (thread.sandbox !== 'read-only') {
        integrationTurns++;
        if (mode === 'repair') await writeFile(path.join(thread.cwd, 'a', 'a.txt'), 'from a, complete\n');
        else if (mode !== 'stubborn') await writeFile(path.join(thread.cwd, 'shared.txt'), 'header\nvalue = a + b\nfooter\n');
        output = mode === 'repair' ? 'Repaired part A' : 'Resolved conflicts';
      } else output = 'read only';
      const emit = () => {
        if (thread.sandbox !== 'read-only' && /--implement-[ab]$/.test(thread.cwd)) activeWriters--;
        events.accept('item/completed', { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text: typeof output === 'string' ? output : JSON.stringify(output) } });
        const total = (tokens.get(threadId) ?? 0) + 100; tokens.set(threadId, total);
        events.accept('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: total - 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: total } } });
        events.accept('turn/completed', { threadId, turn: { id: turnId, status, ...(status === 'failed' ? { error: { message: 'fixture failure' } } : {}) } });
      };
      if (delay) void Promise.race([bothStarted, new Promise(resolve => setTimeout(resolve, 5000))]).then(emit); else emit();
      return { turn: { id: turnId } };
    } };
    return { events, fault: () => undefined, scope: { transport, identity: { unit: `neomind-run-${randomUUID()}.scope`, controlGroup: `/user.slice/user-0.slice/fixture.scope` }, isActive: async () => active, stop: async () => { active = false; return true; } } };
  };
  const run = await LocalRun.create({ projectRoot: project, stateRoot: state, task: 'Add parts A and B in parallel', snapshot, coordinator, workerFactory: factory, capabilityCheck: async () => ({ sandboxVerified: true, stopVerified: true }) });
  const approve = async () => { run.launch(); await run.settled(); await run.approve('fixture-user', 'cli'); await run.settled(); return run.report(); };
  return { run, coordinator, project, state, approve, peakWriters: () => peakWriters, integrationTurns: () => integrationTurns };
}
const show = (workspace: string, ref: string) => execFileSync('git', ['-C', workspace, 'show', ref], { encoding: 'utf8' });

test('parallel writers run concurrently in their own worktrees and are merged, reviewed and committed together', async () => {
  const f = await fixture('separate');
  try {
    const report = await f.approve();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(f.peakWriters(), 2, 'both branch writers ran at the same time');
    assert.equal(f.integrationTurns(), 0, 'a clean merge needs no integration agent');
    assert.equal(report.branchWorkspaces.length, 2);
    for (const branch of report.branchWorkspaces) assert.notEqual(branch.workspace, f.run.context.workspace);
    // Once committed, the run and branch worktrees are removed; commits stay reachable through NeoMind refs.
    assert.ok([f.run.context.workspace, ...report.branchWorkspaces.map(branch => branch.workspace)].every(workspace => !existsSync(workspace)));
    const commit = report.commits[0]!;
    assert.ok(commit.confirmed);
    assert.equal(show(f.project, `${commit.commit}:a/a.txt`), 'from a\n');
    assert.equal(show(f.project, `${commit.commit}:b/b.txt`), 'from b\n');
    assert.equal(execFileSync('git', ['-C', f.project, 'rev-parse', `refs/neomind/${f.run.runId}/implement-a`], { encoding: 'utf8' }).trim().length, 40);
    assert.ok(report.attempts.some(item => item.nodeId === 'integrate' && item.core), 'the merge is the review producer');
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('a review finding on the integrated result is repaired by the integration agent without merging again', async () => {
  const f = await fixture('repair');
  try {
    const report = await f.approve();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(report.repairRounds.length, 1);
    assert.equal(f.integrationTurns(), 1, 'only the repair turn used the integration agent');
    assert.equal(report.integrations.length, 1, 'the branches were merged once');
    assert.equal(show(f.project, `${report.commits[0]!.commit}:a/a.txt`), 'from a, complete\n');
    assert.equal(show(f.project, `${report.commits[0]!.commit}:b/b.txt`), 'from b\n');
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('overlapping branch edits go to the integration agent and are accepted only without conflict markers', async () => {
  const f = await fixture('conflict');
  try {
    const report = await f.approve();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(f.integrationTurns(), 1);
    assert.deepEqual(report.integrations[0]!.conflicts, ['shared.txt']);
    assert.equal(show(f.project, `${report.commits[0]!.commit}:shared.txt`), 'header\nvalue = a + b\nfooter\n');
    assert.ok(report.attempts.some(item => item.nodeId === 'integrate' && !item.core && item.status === 'completed'));
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('an integration result that still has conflict markers blocks the run before review', async () => {
  const f = await fixture('stubborn');
  try {
    const report = await f.approve();
    assert.equal(report.runtimeState.phase, 'blocked');
    assert.match(report.runtimeState.reason, /Conflict markers remain in: shared\.txt/);
    assert.equal(report.reviewerOutputs.length, 0); assert.equal(report.commits.length, 0);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('a plan without a work packet per branch writer cannot be approved', async () => {
  const f = await fixture('no-packets');
  try {
    f.run.launch(); await f.run.settled();
    await assert.rejects(f.run.approve('fixture-user', 'cli'), /work packet cho implement-a/);
    assert.equal((await f.run.report()).approvals.length, 0);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('a failing branch stops its sibling instead of leaving the run waiting', { timeout: 30000 }, async () => {
  const f = await fixture('branch-fails');
  try {
    const report = await f.approve();
    // The synthetic worker scopes carry no OS stop proof, so recovery stays blocked for the user.
    assert.equal(report.runtimeState.phase, 'blocked');
    assert.equal(report.integrations.length, 0); assert.equal(report.commits.length, 0);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('preview refuses parallel shapes the executor cannot run yet', () => {
  const flow = structuredClone(templates.parallel);
  const integrate = flow.definition.nodes.find(node => node.id === 'integrate')!;
  if (integrate.type !== 'integration') throw new Error('Bad template');
  delete integrate.bindingId; delete integrate.sessionGroup; delete integrate.profileId; delete integrate.profileVersion;
  flow.definition.nodes = flow.definition.nodes.map(node => node.id === 'repair' && node.type === 'repair_scope' ? { ...node, ownerNodeIds: ['implement-a'] } : node);
  const reasons = standaloneDiagnostics(flow).join('\n');
  assert.match(reasons, /cần profile, binding và session group/);
  assert.match(reasons, /repair cần do bước tích hợp đảm nhiệm/);
  assert.deepEqual(standaloneDiagnostics(templates.parallel), []);
});
