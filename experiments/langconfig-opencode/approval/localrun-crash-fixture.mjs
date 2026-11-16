// Crash/recovery experiment on LocalRun itself, with fake runner/scope and synthetic Git only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalRun } from '../../../dist/src/runtime/local-run.js';
import { WorkspaceCoordinator } from '../../../dist/src/storage/coordination.js';
import { RunStore } from '../../../dist/src/storage/run-store.js';
import { templates, defaultProject } from '../../../dist/src/domain/templates.js';
import { materializeRun } from '../../../dist/src/domain/materialize.js';
import { builtinProfile } from '../../../dist/src/runtime/project.js';
import { RunnerRegistry } from '../../../dist/src/runners/registry.js';
import { FakeRunner, FakeRunnerFactory, fakeScope } from '../../../dist/test/helpers/fake-runner.js';
import { allocateProcessScope } from '../../../dist/src/adapters/worker-scope.js';

const [mode, source, root] = process.argv.slice(2);
if (process.argv.length !== 5 || !['crash', 'scope-crash', 'scope-hold', 'inspect-held', 'recover', 'recover-stopped'].includes(mode) || !path.isAbsolute(source) || !path.isAbsolute(root)) throw Error('Invalid fixture paths');
const state = path.join(root, 'state'), repo = path.join(root, 'repo');
const coordinatorFile = path.join(state, 'coordination.sqlite');
if (mode === 'crash' || mode === 'scope-crash' || mode === 'scope-hold') {
  execFileSync('git', ['clone', '--no-local', '--no-hardlinks', '--no-tags', '--', source, repo], { stdio: 'ignore' });
  await mkdir(path.join(state, 'runs'), { recursive: true });
  await mkdir(path.join(state, 'workspaces'));
  const binding = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: binding, verifier: binding } };
  await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify(config));
  const snapshot = await materializeRun(structuredClone(templates.dev), config,
    { 'implementer@1': builtinProfile('implementer'), 'verifier@1': builtinProfile('verifier') }, repo);
  const behaviour = {
    startTurn: async session => {
      if (session.access.kind === 'write') {
        if (mode === 'scope-crash' || mode === 'scope-hold') {
          const scope = agents.started.at(-1).scope;
          assert.equal(await scope.isActive(), true);
        }
        await appendFile(path.join(root, 'dispatch-count'), 'dispatch\n');
        if (mode === 'scope-hold') {
          process.stdout.write(`${JSON.stringify({ event: 'writer_active' })}\n`);
          await new Promise(() => {});
        }
        process.exit(73);
      }
      return 'plan-turn';
    },
    respond: () => JSON.stringify({ planId: 'p', version: 1, goal: 'edit', scope: ['.'], approach: 'edit',
      acceptanceCriteria: ['done'], checks: ['test -f task.txt'], riskChanges: [] }),
  };
  const agents = mode === 'crash' ? new FakeRunnerFactory('codex', behaviour) : {
    runner: 'codex', started: [],
    async models() { return []; },
    async verifyCapabilities() { return { sandboxVerified: true, stopVerified: true }; },
    async start(workspace) {
      const scope = this.started.length === 0 ? fakeScope() : await allocateProcessScope();
      if (this.started.length !== 0) {
        await writeFile(path.join(root, 'scope.json'), JSON.stringify(scope.identity));
        await scope.start({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: workspace, env: process.env });
      }
      const runner = new FakeRunner('codex', scope, behaviour);
      this.started.push(runner);
      return runner;
    },
  };
  const coordinator = new WorkspaceCoordinator(coordinatorFile);
  const run = await LocalRun.create({ projectRoot: repo, stateRoot: state, task: 'synthetic fixture only', snapshot, coordinator,
    runners: new RunnerRegistry([agents]), capabilityCheck: async () => ({ sandboxVerified: true, stopVerified: true }) });
  await writeFile(path.join(root, 'run.json'), JSON.stringify({ runId: run.runId, workspace: run.context.workspace }));
  run.launch(); await run.settled();
  assert.equal((await run.report()).runtimeState.phase, 'waiting_approval');
  await run.approve('fixture-user', 'cli');
  await run.settled();
  throw Error(`Expected fixture process to crash during writer dispatch: ${JSON.stringify((await run.report()).runtimeState)}`);
} else if (mode === 'inspect-held') {
  const { workspace } = JSON.parse(await readFile(path.join(root, 'run.json'), 'utf8'));
  const coordinator = new WorkspaceCoordinator(coordinatorFile);
  try {
    const held = coordinator.getWriter(workspace);
    assert.ok(held);
    assert.throws(() => coordinator.acquire(workspace, 'other-run', 'other-host'), /already has a writer/);
    assert.throws(() => coordinator.release(held, false), /stop is unconfirmed/);
    process.stdout.write('{"leaseRetained":true}\n');
  } finally { coordinator.close(); }
} else {
  const { runId, workspace } = JSON.parse(await readFile(path.join(root, 'run.json'), 'utf8'));
  const coordinator = new WorkspaceCoordinator(coordinatorFile);
  let run;
  try {
    const old = coordinator.getRunOwner(runId);
    if (old) coordinator.reclaimDeadRun(old);
    const held = coordinator.getWriter(workspace);
    assert.ok(held);
    assert.throws(() => coordinator.acquire(workspace, 'other-run', 'other-host'), /already has a writer/);
    run = await LocalRun.recover(await RunStore.open(path.join(state, 'runs')), coordinator, runId);
    const report = await run.report();
    if (mode === 'recover-stopped') {
      assert.equal(report.runtimeState.phase, 'recovering');
      assert.equal(report.attempts.filter(a => a.nodeId === 'implement' && a.status === 'stopped').length, 1);
      assert.deepEqual(report.unresolvedAttemptIds, []);
    } else {
      assert.equal(report.runtimeState.phase, 'blocked');
      assert.match(report.runtimeState.reason, /Worker stop is unconfirmed/);
      assert.equal(report.attempts.filter(a => a.nodeId === 'implement' && a.status === 'unresolved').length, 1);
    }
    assert.throws(() => coordinator.acquire(workspace, 'other-run', 'other-host'), /already has a writer/);
    assert.throws(() => coordinator.release(held, false), /stop is unconfirmed/);
    assert.deepEqual(coordinator.getWriter(workspace), held);
    if (mode !== 'recover-stopped') await assert.rejects(run.resume(), /Worker stop is unconfirmed/);
    assert.equal(await readFile(path.join(root, 'dispatch-count'), 'utf8'), 'dispatch\n');
    process.stdout.write(`${JSON.stringify({ phase: report.runtimeState.phase, reason: report.runtimeState.reason,
      unresolved: report.unresolvedAttemptIds.length, leaseRetained: true, quarantined: coordinator.getWriter(workspace).quarantined,
      dispatches: 1 })}\n`);
  } finally {
    if (run) await run.close();
    coordinator.close();
  }
}
