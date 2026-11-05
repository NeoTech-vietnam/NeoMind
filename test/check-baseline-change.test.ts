import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalRun } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { allocateProcessScope, type ProcessScope } from '../src/adapters/worker-scope.js';
import { describeCheckBaselineChange } from '../src/core/codex-check-dispatch.js';
import { captureBaseline } from '../src/workspace/baseline.js';
import type { WorkerFactory } from '../src/runtime/worker.js';

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-check-diff-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline');
  return root;
}

test('baseline change names added, modified and removed paths', async () => {
  const root = await repo({ 'kept.py': 'x = 1\n', 'gone.py': 'y = 2\n', 'dirty.py': 'z = 3\n' });
  await writeFile(path.join(root, 'dirty.py'), 'z = 4\n'); await writeFile(path.join(root, 'scratch.txt'), 'before\n');
  const before = await captureBaseline(root);
  await mkdir(path.join(root, 'tools', '__pycache__'), { recursive: true });
  await writeFile(path.join(root, 'tools', '__pycache__', 'gen.cpython-312.pyc'), 'bytecode');
  await writeFile(path.join(root, 'kept.py'), 'x = 2\n'); await rm(path.join(root, 'gone.py'));
  await writeFile(path.join(root, 'dirty.py'), 'z = 3\n'); await rm(path.join(root, 'scratch.txt'));
  const message = describeCheckBaselineChange(before, await captureBaseline(root));
  assert.match(message, /^Check changed the reviewed baseline; outcome requires reconciliation\./);
  assert.match(message, /added tools\/__pycache__\/gen\.cpython-312\.pyc/);
  assert.match(message, /modified kept\.py/); assert.match(message, /removed gone\.py/);
  // A dirty file the check restored and an untracked file it deleted also changed the reviewed state.
  assert.match(message, /modified dirty\.py/); assert.match(message, /removed scratch\.txt/);
  assert.match(message, /\.gitignore/); assert.doesNotMatch(message, /more/);
});

test('baseline change lists at most twenty paths and counts the rest', async () => {
  const root = await repo({ 'a.txt': 'a\n' }), before = await captureBaseline(root);
  for (let n = 0; n < 25; n++) await writeFile(path.join(root, `gen-${String(n).padStart(2, '0')}.out`), `${n}\n`);
  const message = describeCheckBaselineChange(before, await captureBaseline(root));
  assert.equal(message.match(/added gen-\d+\.out/g)?.length, 20);
  assert.match(message, /added gen-19\.out; and 5 more\./); assert.doesNotMatch(message, /gen-20/);
});

test('check that writes into the worktree blocks the run with the generated path and runs without bytecode caches', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-check-dirty-')), project = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(project); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(project, 'README.md'), 'Fixture\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: role, verifier: role } };
  await mkdir(path.join(project, '.neomind')); await writeFile(path.join(project, '.neomind/project.json'), JSON.stringify(config));
  const profiles = { 'implementer@1': builtinProfile('implementer'), 'verifier@1': builtinProfile('verifier') };
  const snapshot = await materializeRun(structuredClone(templates.dev), config, profiles, project), coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const threads = new Map<string, { cwd: string; sandbox: string }>(), checkEnvs: unknown[] = [], scopes: ProcessScope[] = [];
  const factory: WorkerFactory = async () => {
    const events = new CodexTurnEvents(); let active = true;
    // Reconciling the unfinished check needs OS proof that its worker stopped; otherwise that failure replaces the reason.
    const os = await allocateProcessScope(); scopes.push(os);
    await os.start({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 120000)'], cwd: root, env: process.env });
    const transport = { request: async (method: string, input: unknown): Promise<unknown> => {
      const params = input as Record<string, unknown>;
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'thread/start' || method === 'thread/resume') {
        const id = method === 'thread/start' ? randomUUID() : String(params.threadId);
        threads.set(id, { cwd: String(params.cwd), sandbox: String(params.sandbox) });
        return { thread: { id }, cwd: String(params.cwd), model: String(params.model), modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
      }
      if (method === 'command/exec') {
        // Mirrors `python -m py_compile`, which writes bytecode even when import-time caching is disabled.
        checkEnvs.push(params.env);
        await mkdir(path.join(String(params.cwd), 'tools', '__pycache__'), { recursive: true });
        await writeFile(path.join(String(params.cwd), 'tools', '__pycache__', 'proof.cpython-312.pyc'), 'bytecode');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (method !== 'turn/start') throw new Error(`Unexpected method ${method}`);
      const threadId = String(params.threadId), turnId = randomUUID(), thread = threads.get(threadId)!;
      const schema = params.outputSchema as { properties?: Record<string, unknown> } | undefined;
      let output: unknown;
      if (schema?.properties?.planId) output = { planId: 'fixture-plan', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: ['test -f proof.txt'], riskChanges: [] };
      else { await writeFile(path.join(thread.cwd, 'proof.txt'), 'ok\n'); output = 'Implemented'; }
      events.accept('item/completed', { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text: typeof output === 'string' ? output : JSON.stringify(output) } });
      events.accept('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      return { turn: { id: turnId } };
    } };
    return { events, fault: () => undefined, scope: { transport, identity: os.identity, isActive: async () => active, stop: async () => { active = false; return true; } } };
  };
  const run = await LocalRun.create({ projectRoot: project, stateRoot: state, task: 'Add proof', snapshot, coordinator, workerFactory: factory, capabilityCheck: async () => ({ sandboxVerified: true, stopVerified: true }) });
  try {
    run.launch(); await run.settled(); await run.approve('fixture-user-simulated-approval', 'cli'); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'blocked');
    assert.match(report.runtimeState.reason, /Check changed the reviewed baseline; outcome requires reconciliation\. Changed paths: added tools\/__pycache__\/proof\.cpython-312\.pyc\./);
    assert.ok(!report.checks.some(check => check.status === 'passed'));
    assert.deepEqual(checkEnvs, [{ PYTHONDONTWRITEBYTECODE: '1' }]);
  } finally { await run.close(); coordinator.close(); for (const scope of scopes) await scope.stop(); }
});
