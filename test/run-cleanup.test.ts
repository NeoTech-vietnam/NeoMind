import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRun } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { captureBaseline } from '../src/workspace/baseline.js';
import { resolveRef, snapshotBeforeRemoval } from '../src/workspace/run-cleanup.js';
import { parseRunCommand } from '../src/cli/run-command.js';
import type { WorkerFactory } from '../src/runtime/worker.js';
import { FakeRunnerFactory, fakeScope } from './helpers/fake-runner.js';

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];

/** A finished Fast run (plan approved by NeoMind, `proof.txt` written, nothing applied yet). */
async function finishedFastRun(policy: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-cleanup-')), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(repo); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n');
  const config = { ...structuredClone(defaultProject), policy: { ...defaultProject.policy, allowAutoApproval: true, allowHumanReview: true, ...policy }, roleDefaults: { implementer: codexRole, verifier: codexRole } };
  await mkdir(path.join(repo, 'neomind')); await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify(config));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const snapshot = await materializeRun(structuredClone(templates.fast), config, { 'implementer@1': builtinProfile('implementer')! }, repo);
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const codex: WorkerFactory = async () => ({ events: new CodexTurnEvents(), fault: () => undefined, scope: { ...fakeScope(), transport: { request: async () => ({}) } } });
  const agents = new FakeRunnerFactory('codex', {
    respond: async (session, request) => {
      if ((request.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.planId)
        return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] });
      await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n'); return 'Implemented';
    },
  }, codexModels);
  const run = await LocalRun.create({ projectRoot: repo, stateRoot: state, task: 'Add proof', snapshot, coordinator, workerFactory: codex, runners: new RunnerRegistry([agents]) });
  run.launch(); await run.settled();
  assert.equal((await run.report()).runtimeState.phase, 'completed');
  const worktrees = () => git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length;
  const snapshotRef = `refs/neomind/${run.runId}/snapshot/workspace`, show = (spec: string) => git('show', spec);
  return { run, repo, coordinator, worktrees, snapshotRef, show, close: async () => { await run.close(); coordinator.close(); } };
}

test('a delivered run cleans its worktree by itself; unapplied changes keep it until the user decides', async () => {
  const f = await finishedFastRun();
  try {
    // Finished but not applied: the worktree holds the only working copy of the change, so neither auto nor plain cleanup removes it.
    assert.ok(existsSync(f.run.context.workspace)); assert.equal(f.worktrees(), 2);
    await assert.rejects(f.run.cleanWorkspaces(), /Run còn thay đổi chưa áp dụng hoặc chưa commit: proof\.txt/);
    assert.equal((await f.run.report()).workspaceCleanup, undefined, 'a refused cleanup journals nothing');
    await f.run.applyToCheckout();
    assert.equal(await readFile(path.join(f.repo, 'proof.txt'), 'utf8'), 'ok\n');
    const report = await f.run.report(), commit = await resolveRef(f.repo, f.snapshotRef);
    assert.deepEqual(report.workspaceCleanup, { workspaces: [f.run.context.workspace], refs: [], discarded: [], snapshots: [{ workspace: f.run.context.workspace, ref: f.snapshotRef, commit }], cleaned: true });
    assert.ok(!existsSync(f.run.context.workspace)); assert.equal(f.worktrees(), 1, 'the worktree is deleted and unregistered');
    assert.equal(f.coordinator.isCurrent(f.run.context.lease), false, 'the workspace lease is released');
    assert.deepEqual(await f.run.cleanWorkspaces(), report.workspaceCleanup, 'cleaning again is a no-op');
  } finally { await f.close(); }
});

test('forcing a cleanup records what it discarded; the snapshot keeps it and restores as a worktree', async () => {
  const f = await finishedFastRun();
  try {
    const cleanup = await f.run.cleanWorkspaces(true);
    assert.deepEqual([cleanup.cleaned, cleanup.discarded], [true, ['proof.txt']]);
    assert.ok(!existsSync(f.run.context.workspace));
    await assert.rejects(f.run.applyToCheckout(), /đã được dọn/);
    assert.ok(!existsSync(path.join(f.repo, 'proof.txt')));
    assert.equal(f.show(`${f.snapshotRef}:proof.txt`), 'ok\n');
    const restored = path.join(path.dirname(f.repo), 'restored');
    execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-q', '--detach', restored, f.snapshotRef]);
    assert.equal(await readFile(path.join(restored, 'proof.txt'), 'utf8'), 'ok\n');
  } finally { await f.close(); }
});

test('a project can keep run worktrees; an interrupted cleanup resumes from its journaled plan', async () => {
  const f = await finishedFastRun({ keepRunWorktrees: true });
  try {
    await f.run.applyToCheckout();
    assert.ok(existsSync(f.run.context.workspace), 'kept by project policy');
    // A cleanup that stopped after journaling its plan finishes it, without re-deciding what to keep.
    await f.run.durable.service.recordWorkspaceCleanup('intent', { workspaces: [f.run.context.workspace], refs: [], discarded: [] });
    assert.equal((await f.run.report()).workspaceCleanup?.cleaned, false);
    assert.equal((await f.run.cleanWorkspaces()).cleaned, true);
    assert.ok(!existsSync(f.run.context.workspace)); assert.equal(f.worktrees(), 1);
  } finally { await f.close(); }
});

test('a cleanup receipt needs its journaled plan, and the CLI parses clean for one run or all', async () => {
  const f = await finishedFastRun();
  try {
    await assert.rejects(f.run.durable.service.recordWorkspaceCleanup('cleaned', { snapshots: [] }), /without its intent/);
  } finally { await f.close(); }
  assert.deepEqual(parseRunCommand(['run', 'clean', 'p', 'run-1']), { kind: 'clean', project: 'p', runId: 'run-1', force: false });
  assert.deepEqual(parseRunCommand(['run', 'clean', 'p', '--all', '--force']), { kind: 'clean', project: 'p', force: true });
  assert.equal(parseRunCommand(['run', 'clean', 'p', 'run-1', '--yes']), undefined);
});

test('files written after an interrupted cleanup journaled its plan are kept in the snapshot', async () => {
  const f = await finishedFastRun({ keepRunWorktrees: true });
  try {
    await f.run.applyToCheckout();
    const workspace = f.run.context.workspace;
    await f.run.durable.service.recordWorkspaceCleanup('intent', { workspaces: [workspace], refs: [], discarded: [] });
    await writeFile(path.join(workspace, 'later.txt'), 'keep me\n');
    await f.run.cleanWorkspaces();
    assert.ok(!existsSync(workspace));
    assert.equal(f.show(`${f.snapshotRef}:later.txt`), 'keep me\n');
  } finally { await f.close(); }
});

test('a resumed cleanup keeps the first snapshot of a half-removed worktree', async () => {
  const f = await finishedFastRun({ keepRunWorktrees: true });
  try {
    await f.run.applyToCheckout();
    const workspace = f.run.context.workspace;
    await writeFile(path.join(workspace, 'extra.txt'), 'extra\n');
    await f.run.durable.service.recordWorkspaceCleanup('intent', { workspaces: [workspace], refs: [], discarded: [] });
    const first = await snapshotBeforeRemoval(f.repo, workspace, f.snapshotRef);
    await rm(path.join(workspace, 'extra.txt')); // the removal stopped after deleting this file
    const cleanup = await f.run.cleanWorkspaces();
    assert.equal(cleanup.snapshots?.[0]?.commit, first);
    assert.equal(f.show(`${f.snapshotRef}:extra.txt`), 'extra\n');
  } finally { await f.close(); }
});

test('cleanup keeps ignored files that exist only in a run worktree unless forced', async () => {
  const f = await finishedFastRun({ keepRunWorktrees: true });
  try {
    await f.run.applyToCheckout();
    const excludeFile = path.join(path.dirname(f.repo), 'excludes');
    await writeFile(excludeFile, 'private-output.log\n');
    execFileSync('git', ['-C', f.repo, 'config', 'core.excludesFile', excludeFile]);
    await writeFile(path.join(f.run.context.workspace, 'private-output.log'), 'keep\n');
    await assert.rejects(f.run.cleanWorkspaces(), /private-output\.log/);
    assert.equal(await readFile(path.join(f.run.context.workspace, 'private-output.log'), 'utf8'), 'keep\n');
    // Ignored files are not part of the snapshot: forcing records them as discarded.
    assert.deepEqual((await f.run.cleanWorkspaces(true)).discarded, ['private-output.log']);
    assert.throws(() => f.show(`${f.snapshotRef}:private-output.log`));
  } finally { await f.close(); }
});

test('a plan journaled before snapshots (baselines, retained directory) still replays and finishes', async () => {
  const f = await finishedFastRun({ keepRunWorktrees: true });
  try {
    await f.run.applyToCheckout();
    const workspace = f.run.context.workspace;
    await f.run.durable.service.recordWorkspaceCleanup('intent', { workspaces: [workspace], refs: [], discarded: [],
      baselines: { [workspace]: (await captureBaseline(workspace)).baselineHash }, retained: { [workspace]: path.join(path.dirname(workspace), '.retained', path.basename(workspace)) } } as never);
    assert.equal((await f.run.cleanWorkspaces()).cleaned, true);
    assert.ok(!existsSync(workspace));
  } finally { await f.close(); }
});

test('on Windows a process holding the worktree stops the removal; the snapshot is kept and cleanup resumes', { skip: process.platform !== 'win32' && 'Windows-only sharing semantics', timeout: 60000 }, async () => {
  const f = await finishedFastRun();
  const workspace = f.run.context.workspace;
  // A process whose working directory is inside the worktree keeps Windows from deleting that directory.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: workspace, stdio: 'ignore' });
  try {
    await assert.rejects(f.run.cleanWorkspaces(true), /Không xóa hết được worktree/);
    assert.equal(f.show(`${f.snapshotRef}:proof.txt`), 'ok\n');
  } finally { holder.kill(); await new Promise(resolve => holder.once('exit', resolve)); }
  try {
    assert.equal((await f.run.cleanWorkspaces()).cleaned, true);
    assert.ok(!existsSync(workspace)); assert.equal(f.worktrees(), 1);
  } finally { await f.close(); }
});
