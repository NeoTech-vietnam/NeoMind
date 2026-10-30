import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalRun } from '../src/runtime/local-run.js';
import { RunStore } from '../src/storage/run-store.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { claudeEnvironment } from '../src/adapters/claude-cli.js';
import { stopExistingWorkerScope } from '../src/adapters/worker-scope.js';
import { ClaudeRunner, ClaudeRunnerFactory, claudeSessionStored, claudeTurnPolicy } from '../src/runners/claude-runner.js';
import { CodexRunnerFactory } from '../src/runners/codex-runner.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import type { WorkerFactory } from '../src/runtime/worker.js';
import { fakeScope } from './helpers/fake-runner.js';
import { listTranscripts, readTranscript } from '../src/core/transcript.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-claude.js');
const scoped = { skip: process.platform !== 'win32' && 'Claude process scope tests run on Windows', timeout: 120000 };
const binding = { runner: 'claude-code', provider: 'anthropic', model: 'claude-haiku-5-5', reasoning: 'low' };
const proven = async () => ({ sandboxVerified: true as const, stopVerified: true as const });

async function claudeHome(mode: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-claude-runner-')), configDir = path.join(root, 'claude-config'), log = path.join(root, 'calls.jsonl');
  await mkdir(configDir);
  const factory = new ClaudeRunnerFactory({ executable: { command: process.execPath, args: [fake] }, configDir, capabilities: proven,
    env: claudeEnvironment({ ...process.env, CLAUDE_CONFIG_DIR: configDir, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log }) });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; cwd: string });
  return { root, configDir, factory, calls };
}

test('the Claude turn policy grants tools by role and denies delegation, web and the Claude config dir', () => {
  const workspace = path.resolve(tmpdir(), 'ws'), configDir = path.resolve(tmpdir(), 'cfg');
  const reader = claudeTurnPolicy(workspace, { kind: 'read' }, configDir);
  assert.deepEqual(reader.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(reader.args, ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep']);
  const writer = claudeTurnPolicy(workspace, { kind: 'write', writableRoots: [workspace, path.join(workspace, 'src')] }, configDir);
  assert.deepEqual(writer.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit']);
  const settings = writer.settings as { permissions: { allow: string[]; deny: string[] } };
  assert.deepEqual(settings.permissions.allow, ['Write(**)', 'Edit(**)', 'Write(src/**)', 'Edit(src/**)']);
  for (const denied of ['Task', 'Agent', 'WebFetch', 'WebSearch']) assert.ok(settings.permissions.deny.includes(denied));
  assert.ok(settings.permissions.deny.some(rule => rule.startsWith('Write(') && rule.endsWith('/cfg/**)')));
  assert.throws(() => claudeTurnPolicy(workspace, { kind: 'write', writableRoots: [path.dirname(workspace)] }, configDir), /escapes the workspace/);
});

test('a Claude runner session is verified, runs exactly one scoped turn and resumes only stored sessions', scoped, async () => {
  const { root, configDir, factory, calls } = await claudeHome('success');
  const workspace = path.join(root, 'ws'); await mkdir(workspace);
  const runner = await factory.start();
  await assert.rejects(runner.openSession({ workspace, binding: { ...binding, runner: 'codex' }, access: { kind: 'read' } }), /not claude-code/);
  await assert.rejects(runner.openSession({ workspace, binding: { ...binding, model: 'claude-legacy' }, access: { kind: 'read' } }), /not allowed/);
  const session = await runner.openSession({ workspace, binding, access: { kind: 'read' } });
  assert.equal(await runner.scope.isActive(), true, 'an allocated scope counts as active before its turn');
  await runner.verifyNoDelegation(session);
  await assert.rejects(runner.startTurn({ ...session }, { prompt: 'hi', effort: 'low' }), /not been verified/);
  const turnId = await runner.startTurn(session, { prompt: 'hi', effort: 'low' });
  await assert.rejects(runner.startTurn(session, { prompt: 'again', effort: 'low' }), /one turn per dispatch/);
  const result = await runner.waitForTurn(session, turnId, () => false);
  assert.equal(result.status, 'completed'); assert.equal(result.threadId, session.sessionId);
  assert.equal(await runner.scope.isActive(), false); assert.equal(await stopExistingWorkerScope(runner.scope.identity), true);
  assert.equal(claudeSessionStored(workspace, session.sessionId, configDir), true);
  assert.equal(await runner.close(), true);

  // The next dispatch resumes the stored session; a session id whose first turn never ran is started under the same id.
  const next = await factory.start(), resumed = await next.openSession({ workspace, binding, access: { kind: 'read' }, resumeSessionId: session.sessionId });
  await next.waitForTurn(resumed, await next.startTurn(resumed, { prompt: 'more', effort: 'low' }), () => false);
  const unstarted = '0f1e2d3c-4b5a-4968-8776-655443322110', fresh = await factory.start();
  const restarted = await fresh.openSession({ workspace, binding, access: { kind: 'read' }, resumeSessionId: unstarted });
  assert.equal((await fresh.waitForTurn(restarted, await fresh.startTurn(restarted, { prompt: 'first', effort: 'low' }), () => false)).status, 'completed');
  const [first, second, third] = calls();
  assert.ok(first!.argv.includes('--session-id') && second!.argv.includes('--resume') && third!.argv.includes('--session-id'));
  assert.equal(third!.argv[third!.argv.indexOf('--session-id') + 1], unstarted);
  for (const call of [first!, second!, third!]) {
    assert.equal(call.argv[call.argv.indexOf('--tools') + 1], 'Read,Glob,Grep'); assert.equal(call.argv[call.argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'claude-haiku-5-5'); assert.ok(call.argv.includes('--strict-mcp-config'));
  }
  const stopped = await factory.start();
  assert.equal(await stopped.close(), true);
  const late = await stopped.openSession({ workspace, binding, access: { kind: 'read' } });
  await assert.rejects(stopped.startTurn(late, { prompt: 'late', effort: 'low' }), /scope was stopped/);
});

test('a Claude turn whose init does not match the request is never accepted', scoped, async () => {
  const { root, factory } = await claudeHome('task-tool'), workspace = path.join(root, 'ws'); await mkdir(workspace);
  const runner = await factory.start(), session = await runner.openSession({ workspace, binding, access: { kind: 'read' } });
  await assert.rejects(runner.startTurn(session, { prompt: 'hi', effort: 'low' }), /delegation/);
  assert.equal(await runner.scope.isActive(), false);
  assert.ok(new ClaudeRunner(fakeScope() as never).scope);
});

test('a Dev flow runs end to end on the Claude runner: Claude plans, writes and reviews; checks run through Codex', scoped, async () => {
  const { root, factory, calls } = await claudeHome('flow');
  const repo = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(repo); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: binding, verifier: binding } };
  await mkdir(path.join(repo, '.neomind')); await writeFile(path.join(repo, '.neomind/project.json'), JSON.stringify(config));
  const snapshot = await materializeRun(structuredClone(templates.dev), config, { 'implementer@1': builtinProfile('implementer')!, 'verifier@1': builtinProfile('verifier')! }, repo);
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const commands: unknown[] = [];
  const codex: WorkerFactory = async () => ({ events: new CodexTurnEvents(), fault: () => undefined, scope: { ...fakeScope(), transport: { request: async (method: string, params: unknown) => {
    if (method !== 'command/exec') throw new Error(`Codex received an agent request: ${method}`);
    commands.push(params); return { exitCode: 0, stdout: '', stderr: '' };
  } } } });
  const runners = new RunnerRegistry([new CodexRunnerFactory(codex), factory]);
  let run = await LocalRun.create({ projectRoot: repo, stateRoot: state, task: 'Add proof', snapshot, coordinator, workerFactory: codex, runners });
  try {
    run.launch(); await run.settled();
    assert.equal((await run.report()).runtimeState.phase, 'waiting_approval', (await run.report()).runtimeState.reason);
    await run.close();
    run = await LocalRun.recover(await RunStore.open(path.join(state, 'runs')), coordinator, run.runId, codex, undefined, runners);
    await run.approve('fixture-user', 'cli'); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(report.commits[0]?.confirmed, true); assert.equal(commands.length, 1);
    // The worktree is gone after delivery; the commit stays reachable under its NeoMind ref.
    assert.equal(execFileSync('git', ['-C', run.context.projectRoot, 'show', `refs/neomind/${run.runId}/delivery/${report.commits[0]!.nodeId}:proof.txt`], { encoding: 'utf8' }), 'ok\n');
    assert.ok(!existsSync(run.context.workspace) && report.workspaceCleanup?.cleaned);
    assert.deepEqual(report.attempts.map(attempt => attempt.nodeId), ['plan', 'implement', 'verify']);
    const invocations = calls(), writer = invocations.find(call => call.argv.includes('Read,Glob,Grep,Write,Edit'))!;
    assert.equal(invocations.length, 3);
    const settings = JSON.parse(writer.argv[writer.argv.indexOf('--settings') + 1]!) as { permissions: { allow: string[] } };
    assert.deepEqual(settings.permissions.allow, ['Write(**)', 'Edit(**)']);
    assert.equal(path.resolve(writer.cwd).toLowerCase(), path.resolve(run.context.workspace).toLowerCase());
    for (const attempt of report.attempts) assert.match(attempt.workerUnit ?? '', /^neomind-run-[a-f0-9-]+\.job$/);
    // Every attempt has a transcript recorded from Claude's stream: prompt, activity with workspace-relative paths, outcome.
    const transcripts = path.join(state, 'runs', run.runId, 'transcripts'), summaries = listTranscripts(transcripts);
    assert.deepEqual(summaries.map(item => [item.meta.nodeId, item.meta.role, item.meta.runner, item.status]),
      [['plan', 'plan', 'claude-code', 'completed'], ['implement', 'write', 'claude-code', 'completed'], ['verify', 'review', 'claude-code', 'completed']]);
    const write = readTranscript(transcripts, summaries[1]!.meta.attemptId)!, edit = write.find(event => event.kind === 'edit');
    assert.deepEqual(write.map(event => event.kind).filter(kind => kind !== 'turn'), ['meta', 'prompt', 'message', 'edit', 'result', 'end']);
    assert.ok(write.some(event => event.kind === 'turn' && event.turnId));
    assert.deepEqual(edit && { path: edit.path, added: edit.added }, { path: 'proof.txt', added: 1 });
    assert.deepEqual(summaries[1]!.files, ['proof.txt']); assert.ok(summaries[1]!.usage, 'token usage recorded at the end');
    assert.ok(readTranscript(transcripts, summaries[2]!.meta.attemptId)!.some(event => event.kind === 'structured_output'));
  } finally { await run.close(); coordinator.close(); }
});
