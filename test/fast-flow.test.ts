import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRun } from '../src/runtime/local-run.js';
import { flowExceptions } from '../src/runtime/run-manager.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { compileFlow } from '../src/domain/compiler.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { CodexRunnerFactory } from '../src/runners/codex-runner.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import type { WorkerFactory } from '../src/runtime/worker.js';
import { FakeRunnerFactory, fakeScope } from './helpers/fake-runner.js';

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];
const codes = (flow: unknown, policy: unknown) => { const result = compileFlow(flow, policy); return result.ok ? [] : result.diagnostics.map(item => item.code); };

test('Fast is a quick plan approved by NeoMind, then implement, reviewed by the user; the project policy can forbid both exceptions', () => {
  const fast = templates.fast;
  assert.deepEqual(fast.definition.nodes.map(node => node.type), ['start', 'agent_task', 'approval', 'agent_task', 'finish']);
  assert.equal(fast.definition.review, 'human');
  assert.equal(fast.definition.bindings['fast-planner']?.reasoning.mode === 'pinned' && fast.definition.bindings['fast-planner'].reasoning.value, 'low');
  assert.deepEqual(codes(fast, defaultProject.policy), []);
  assert.deepEqual(codes(fast, { ...defaultProject.policy, allowAutoApproval: false }), ['auto_approval_denied']);
  assert.deepEqual(codes(fast, { ...defaultProject.policy, allowHumanReview: false }), ['human_review_denied']);
  // A user-reviewed flow never commits, and Dev keeps its gates.
  assert.ok(codes({ ...templates.dev, definition: { ...templates.dev.definition, review: 'human' } }, defaultProject.policy).includes('human_review_commit'));
  const devWithoutReview = structuredClone(templates.dev);
  devWithoutReview.definition.nodes = devWithoutReview.definition.nodes.filter(node => !['verify', 'repair', 'commit'].includes(node.id));
  devWithoutReview.definition.edges = [...devWithoutReview.definition.edges.filter(edge => !['verify', 'repair', 'commit'].includes(edge.to) && !['verify', 'repair', 'commit'].includes(edge.from)), { from: 'implement', to: 'finish', outcome: 'completed' }];
  assert.ok(codes(devWithoutReview, defaultProject.policy).includes('review_bypass'));
  assert.equal(flowExceptions(fast).length, 2); assert.deepEqual(flowExceptions(templates.dev), []);
});

test('a Fast run approves its own plan, implements without stopping, and the user applies the changes to the checkout once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-fast-')), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(repo); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await writeFile(path.join(repo, 'notes.md'), 'mine\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: codexRole, verifier: codexRole } };
  await mkdir(path.join(repo, 'neomind')); await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify(config));
  git('add', '.'); git('commit', '-qm', 'neomind config');
  const snapshot = await materializeRun(structuredClone(templates.fast), config, { 'implementer@1': builtinProfile('implementer')! }, repo);
  assert.equal(snapshot.configuration.bindings.plan?.values.reasoning, 'low', 'the quick plan runs with low reasoning');
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const codexAgentCalls: string[] = [];
  const codex: WorkerFactory = async () => ({ events: new CodexTurnEvents(), fault: () => undefined, scope: { ...fakeScope(), transport: { request: async (method: string) => { codexAgentCalls.push(method); return {}; } } } });
  const agents = new FakeRunnerFactory('codex', {
    respond: async (session, request) => {
      const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties?.planId) return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] });
      assert.equal(session.access.kind, 'write');
      await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n'); return 'Implemented';
    },
  }, codexModels);
  const run = await LocalRun.create({ projectRoot: repo, stateRoot: state, task: 'Add proof', snapshot, coordinator, workerFactory: codex, runners: new RunnerRegistry([agents]) });
  try {
    run.launch(); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(report.approvals[0]?.approval.source, 'flow'); assert.equal(report.approvals[0]?.approval.actor, 'neomind');
    assert.deepEqual(report.attempts.map(attempt => attempt.nodeId), ['plan', 'implement']);
    assert.deepEqual([report.commits, report.checks, report.reviewerOutputs], [[], [], []], 'no commit, checks or agent review');
    assert.deepEqual(codexAgentCalls, [], 'checks never ran');
    // The checkout is untouched until the user applies the changes.
    await assert.rejects(readFile(path.join(repo, 'proof.txt')), /ENOENT/);
    await writeFile(path.join(repo, 'notes.md'), 'still mine\n');
    await run.applyToCheckout();
    assert.equal(await readFile(path.join(repo, 'proof.txt'), 'utf8'), 'ok\n');
    assert.equal(await readFile(path.join(repo, 'notes.md'), 'utf8'), 'still mine\n', 'unrelated uncommitted work is kept');
    assert.equal(git('status', '--porcelain', '--', 'proof.txt').trim(), '?? proof.txt', 'applied, not staged or committed');
    const applied = await run.report();
    assert.deepEqual(applied.checkoutApply && { paths: applied.checkoutApply.paths, applied: applied.checkoutApply.applied }, { paths: ['proof.txt'], applied: true });
    await assert.rejects(run.applyToCheckout(), /đã được áp dụng/);
  } finally { await run.close(); coordinator.close(); }
});

test('applying refuses when the checkout has its own uncommitted changes to a file the run changed', async () => {
  const { applyToCheckout, runChanges } = await import('../src/workspace/checkout-apply.js');
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-apply-')), repo = path.join(root, 'repo'), work = path.join(root, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await mkdir(repo); git(repo, 'init', '-q'); git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'user.name', 'F'); git(repo, 'config', 'user.email', 'f@example.test');
  await writeFile(path.join(repo, 'calc.js'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'worktree', 'add', '-q', '--detach', work, head);
  await writeFile(path.join(work, 'calc.js'), 'two\n');
  const changes = await runChanges(work, head);
  assert.deepEqual(changes.paths, ['calc.js']);
  await writeFile(path.join(repo, 'calc.js'), 'user edit\n');
  await assert.rejects(applyToCheckout(repo, changes), /Checkout đang có thay đổi chưa commit ở file run cũng sửa: calc.js/);
  git(repo, 'checkout', '--', 'calc.js');
  assert.equal(await applyToCheckout(repo, changes), 'applied');
  assert.equal(await applyToCheckout(repo, changes), 'already', 'a retry after an interrupted apply is recognised');
});
