import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalRun } from '../src/runtime/local-run.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { RunStore } from '../src/storage/run-store.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { CodexRunner, CodexRunnerFactory, codexModelAllowlist } from '../src/runners/codex-runner.js';
import { RunnerRegistry, defaultRunnerRegistry } from '../src/runners/registry.js';
import { ClaudeRunnerFactory } from '../src/runners/claude-runner.js';
import type { WorkerFactory } from '../src/runtime/worker.js';
import type { OwnedJournal } from '../src/storage/owned-journal.js';
import type { BindingValues } from '../src/domain/resolve.js';
import { FakeRunnerFactory, fakeScope } from './helpers/fake-runner.js';

const claudeRole = { runner: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'medium' };
const claudeModels = [{ runner: 'claude-code' as const, provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: ['low', 'medium', 'high'] }];

async function project(role: BindingValues) {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-runner-neutral-')), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(repo); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: role, verifier: role } };
  await mkdir(path.join(repo, '.neomind')); await writeFile(path.join(repo, '.neomind/project.json'), JSON.stringify(config));
  const snapshot = await materializeRun(structuredClone(templates.dev), config, { 'implementer@1': builtinProfile('implementer')!, 'verifier@1': builtinProfile('verifier')! }, repo);
  return { root, repo, state, snapshot, coordinator: new WorkspaceCoordinator(path.join(state, 'coordination.sqlite')) };
}

/** Codex worker that may only run checks: any agent request to Codex fails the test. */
function checkOnlyCodex() {
  const commands: unknown[] = [];
  const factory: WorkerFactory = async () => ({ events: new CodexTurnEvents(), fault: () => undefined, scope: { ...fakeScope(), transport: { request: async (method: string, params: unknown) => {
    if (method !== 'command/exec') throw new Error(`Codex received an agent request in a non-Codex flow: ${method}`);
    commands.push(params); return { exitCode: 0, stdout: '', stderr: '' };
  } } } });
  return { factory, commands };
}

test('dispatch is runner-neutral: a non-Codex runner plans, writes and reviews, checks run through Codex, and the run commits', async () => {
  const f = await project(claudeRole), codex = checkOnlyCodex();
  let journal: OwnedJournal | undefined;
  const boundBeforeStart: boolean[] = [];
  const claude = new FakeRunnerFactory('claude-code', {
    startTurn: async () => {
      // The scope the turn runs in must already be journaled when the runner starts the turn.
      const units = (await journal!.read()).filter(event => event.type === 'worker_scope_bound').map(event => (event.payload as { unit: string }).unit);
      boundBeforeStart.push(units.includes(claude.started.at(-1)!.scope.identity.unit));
      return randomUUID();
    },
    respond: async (session, request) => {
      const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties?.planId) return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: ['test -f proof.txt'], riskChanges: [] });
      if (schema?.properties?.evidence) {
        // Reviewers without a shell still see exactly what changed: the core supplies the run's diff.
        assert.match(request.prompt, /Changes under review \(git diff[^\n]*\n[\s\S]*\+\+\+ b\/proof\.txt[\s\S]*\n\+ok\n/);
        const reference = { kind: 'source', path: 'proof.txt', line: 1, quote: (await readFile(path.join(session.workspace, 'proof.txt'), 'utf8')).trim() };
        return JSON.stringify({ verdict: 'pass', findingIds: [], summary: 'Proof matches', evidence: { findings: [],
          criteria: ['approved plan', 'checks', 'regressions', 'proof'].map(criterion => ({ criterion, status: 'pass', references: [reference] })) } });
      }
      assert.equal(session.access.kind, 'write');
      await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n'); return 'Implemented';
    },
  }, claudeModels);
  const runners = new RunnerRegistry([new CodexRunnerFactory(codex.factory), claude]);
  let run = await LocalRun.create({ projectRoot: f.repo, stateRoot: f.state, task: 'Add proof', snapshot: f.snapshot, coordinator: f.coordinator, workerFactory: codex.factory, runners });
  journal = run.durable.journal;
  try {
    run.launch(); await run.settled();
    assert.equal((await run.report()).runtimeState.phase, 'waiting_approval', (await run.report()).runtimeState.reason);
    await run.close();
    run = await LocalRun.recover(await RunStore.open(path.join(f.state, 'runs')), f.coordinator, run.runId, codex.factory, undefined, runners);
    journal = run.durable.journal;
    await run.approve('fixture-user', 'cli'); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(report.commits[0]?.confirmed, true);
    assert.equal(codex.commands.length, 1); assert.equal(report.checks[0]?.status, 'passed');
    // Every agent attempt ran in a Claude session and scope, journaled with the existing event types.
    const sessions = claude.started.flatMap(runner => runner.opened), units = claude.started.map(runner => runner.scope.identity.unit);
    assert.deepEqual(report.attempts.map(attempt => attempt.nodeId), ['plan', 'implement', 'verify']);
    for (const attempt of report.attempts) {
      assert.ok(sessions.some(session => session.sessionId === attempt.sessionId)); assert.ok(units.includes(attempt.workerUnit!));
      assert.ok(claude.started.some(runner => runner.turns.some(turn => turn.turnId === attempt.runnerTurnId)));
    }
    assert.deepEqual(boundBeforeStart, [true, true, true]);
    const writer = sessions.find(session => session.access.kind === 'write')!;
    assert.deepEqual(writer.access, { kind: 'write', writableRoots: [run.context.workspace] });
    assert.notEqual(report.attempts[2]?.sessionId, writer.sessionId);
    const types = (await run.durable.journal.read()).map(event => event.type);
    assert.equal(types.filter(type => type === 'codex_turn_bound').length, 3);
    // The worktree is gone after delivery; the commit stays reachable under its NeoMind ref.
    assert.equal(execFileSync('git', ['-C', run.context.projectRoot, 'show', `refs/neomind/${run.runId}/delivery/${report.commits[0]!.nodeId}:proof.txt`], { encoding: 'utf8' }), 'ok\n');
    assert.ok(!existsSync(run.context.workspace) && report.workspaceCleanup?.cleaned);
  } finally { await run.close(); f.coordinator.close(); }
});

test('an unknown runner fails cleanly before any dispatch is journaled', async () => {
  const f = await project({ ...claudeRole, runner: 'opencode' }), codex = checkOnlyCodex();
  const run = await LocalRun.create({ projectRoot: f.repo, stateRoot: f.state, task: 'Add proof', snapshot: f.snapshot, coordinator: f.coordinator, workerFactory: codex.factory, runners: defaultRunnerRegistry({ workerFactory: codex.factory }) });
  try {
    run.launch(); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'blocked'); assert.match(report.runtimeState.reason, /Unknown runner "opencode"; supported runners: codex, claude-code/);
    assert.equal(report.attempts.length, 0);
    assert.ok(!(await run.durable.journal.read()).some(event => event.type === 'dispatch_intent'));
  } finally { await run.close(); f.coordinator.close(); }
  assert.ok(defaultRunnerRegistry().get('claude-code') instanceof ClaudeRunnerFactory);
});

test('run preflight names the runners in use and needs Codex for checks even when agents use another runner', async () => {
  const f = await project(claudeRole); f.coordinator.close();
  const codexMissing = new CodexRunnerFactory(async () => { throw new Error('unused'); }, undefined, async () => { throw new Error('Codex CLI was not found on PATH'); });
  let manager = await RunManager.open(f.repo, f.state, new RunnerRegistry([codexMissing, new FakeRunnerFactory('claude-code', {}, claudeModels)]));
  try {
    const preview = await manager.preview('dev');
    assert.deepEqual(preview.runnerPreflight.runners, [{ runner: 'claude-code', supported: true, bindings: Object.keys(preview.snapshot.configuration.bindings) }]);
    assert.equal(preview.runnerPreflight.checks.executor, 'codex'); assert.equal(preview.runnerPreflight.checks.required, true);
    await assert.rejects(manager.create('dev', 'Add proof'), /Check của flow chạy qua Codex command\/exec nhưng Codex không khả dụng: Codex CLI was not found on PATH/);
  } finally { await manager.close(); }
  // A Claude runner that cannot prove its limits on this host blocks the run before anything is journaled.
  const codexReady = new CodexRunnerFactory(async () => { throw new Error('unused'); }, undefined, async () => ({ sandboxVerified: true, stopVerified: true }));
  const claudeUnproven = new ClaudeRunnerFactory({ executable: { command: process.execPath, args: [] }, capabilities: async () => { throw new Error('Claude Code is not logged in'); } });
  manager = await RunManager.open(f.repo, f.state, new RunnerRegistry([codexReady, claudeUnproven]));
  try { await assert.rejects(manager.create('dev', 'Add proof'), /Claude Code is not logged in/); }
  finally { await manager.close(); }
  const unknown = await project({ ...claudeRole, runner: 'opencode' }); unknown.coordinator.close();
  manager = await RunManager.open(unknown.repo, unknown.state);
  try { assert.match((await manager.preview('dev')).runnerPreflight.blockers.join('\n'), /Runner "opencode" chưa được hỗ trợ/); }
  finally { await manager.close(); }
});

test('the Codex runner keeps the verified thread, sandbox and tool contract', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'neomind-codex-runner-')), calls: { method: string; params: Record<string, unknown> }[] = [];
  let reportedModel = 'gpt-6-luna', tools: Record<string, unknown> = {};
  const events = new CodexTurnEvents(), scope = fakeScope();
  const transport = { request: async (method: string, input: unknown): Promise<unknown> => {
    const params = input as Record<string, unknown>; calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: method === 'thread/start' ? randomUUID() : params.threadId }, model: reportedModel, modelProvider: 'openai', cwd: params.cwd,
      approvalPolicy: 'never', sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
    if (method === 'mcpServerStatus/list') return { data: [{ tools, resources: [], resourceTemplates: [] }], nextCursor: null };
    if (method === 'model/list') return { data: ['gpt-6-luna', 'gpt-4-legacy'].map(model => ({ id: model, model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] })) };
    return { turn: { id: 'turn' } };
  } };
  const runner = new CodexRunner({ scope: { ...scope, transport }, events, fault: () => undefined });
  const binding = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const reader = await runner.openSession({ workspace, binding, access: { kind: 'read' } });
  assert.deepEqual(calls[0], { method: 'thread/start', params: { cwd: workspace, model: 'gpt-6-luna', modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false, config: {} } });
  await runner.verifyNoDelegation(reader);
  assert.equal(await runner.startTurn(reader, { prompt: 'plan', effort: 'low', outputSchema: { type: 'object' } }), 'turn');
  assert.deepEqual(calls.at(-1), { method: 'turn/start', params: { threadId: reader.sessionId, model: 'gpt-6-luna', effort: 'low', input: [{ type: 'text', text: 'plan' }], outputSchema: { type: 'object' } } });
  events.accept('item/completed', { threadId: reader.sessionId, turnId: 'turn', item: { id: 'm', type: 'agentMessage', text: 'answer' } });
  events.accept('turn/completed', { threadId: reader.sessionId, turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual((await runner.waitForTurn(reader, 'turn', () => false)).messages, ['answer']);
  // Only the session object this runner verified is accepted.
  await assert.rejects(runner.startTurn({ ...reader }, { prompt: 'plan', effort: 'low' }), /not been verified/);
  tools = { search: {} }; await assert.rejects(runner.verifyNoDelegation(reader), /External MCP/);
  await assert.rejects(runner.openSession({ workspace, binding: { ...binding, runner: 'claude-code' }, access: { kind: 'read' } }), /not codex/);
  reportedModel = 'gpt-6.1-sol'; await assert.rejects(runner.openSession({ workspace, binding, access: { kind: 'read' }, resumeSessionId: reader.sessionId }), /does not match/);
  await assert.rejects(runner.startTurn(reader, { prompt: 'plan', effort: 'low' }), /not been verified/);
  reportedModel = 'gpt-6-luna';
  const writer = await runner.openSession({ workspace, binding, access: { kind: 'write', writableRoots: [workspace] } });
  assert.equal(calls.at(-1)?.params.sandbox, 'workspace-write');
  await runner.startTurn(writer, { prompt: 'edit', effort: 'low' });
  assert.deepEqual(calls.at(-1)?.params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
  assert.equal(calls.at(-1)?.params.cwd, workspace); assert.equal(calls.at(-1)?.params.model, 'gpt-6-luna');
  assert.equal(runner.scope.identity, scope.identity);
  assert.equal(await runner.close(), true); assert.equal(await runner.scope.isActive(), false);
  const factory = new CodexRunnerFactory(async () => ({ scope: { ...fakeScope(), transport }, events, fault: () => undefined }));
  assert.deepEqual(await factory.models(), [{ runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: ['low'] }]);
  assert.deepEqual(codexModelAllowlist, ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
});
