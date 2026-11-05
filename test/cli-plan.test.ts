import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRun } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile, projectRuntimeRoot } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import type { WorkerFactory } from '../src/runtime/worker.js';
import { FakeRunnerFactory, fakeScope } from './helpers/fake-runner.js';

const cli = path.resolve('dist/src/cli/main.js');
const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];

test('run plan prints a pending plan as Markdown, or writes it with --out', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-cli-plan-')), repo = path.join(root, 'repo'), base = path.join(root, 'state');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  const config = { ...structuredClone(defaultProject), policy: { ...defaultProject.policy, allowAutoApproval: true, allowHumanReview: true }, roleDefaults: { implementer: codexRole, verifier: codexRole } };
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind')); await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify(config));
  git('add', '.'); git('commit', '-qm', 'baseline');
  // The run's state sits where the CLI looks for it under XDG_STATE_HOME.
  const state = await projectRuntimeRoot(repo, base), coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const snapshot = await materializeRun(structuredClone(templates.fast), config, { 'implementer@1': builtinProfile('implementer')! }, repo);
  const codex: WorkerFactory = async () => ({ events: new CodexTurnEvents(), fault: () => undefined, scope: { ...fakeScope(), transport: { request: async () => ({}) } } });
  const agents = new FakeRunnerFactory('codex', {
    respond: async (session, request) => {
      if ((request.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.planId)
        return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['proof.txt'], approach: 'Create proof.txt\nwith one line', acceptanceCriteria: ['proof exists'], checks: ['test -f proof.txt'], riskChanges: ['none expected'] });
      await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n'); return 'Implemented';
    },
  }, codexModels);
  const run = await LocalRun.create({ projectRoot: repo, stateRoot: state, task: 'Add proof', snapshot, coordinator, workerFactory: codex, runners: new RunnerRegistry([agents]) });
  let planHash: string | undefined;
  try { run.launch(); await run.settled(); planHash = (await run.report()).proposedPlanHash; }
  finally { await run.close(); coordinator.close(); }
  assert.match(planHash ?? '', /^[a-f0-9]{64}$/);

  const env = { ...process.env, XDG_STATE_HOME: base };
  const printed = spawnSync(process.execPath, [cli, 'run', 'plan', repo, run.runId], { encoding: 'utf8', env });
  assert.equal(printed.status, 0, printed.stderr);
  for (const text of ['# Plan p (v1)', `- Run: \`${run.runId}\``, '- Phase: waiting_approval', '- Status: awaiting approval', `- Plan hash: \`${planHash}\``,
    '## Goal\n\nAdd proof', '## Approach\n\nCreate proof.txt\nwith one line', '## Acceptance criteria\n\n- proof exists', '## Checks\n\n- test -f proof.txt', '## Risks\n\n- none expected', '## Scope\n\n- proof.txt'])
    assert.ok(printed.stdout.includes(text), text);

  const out = path.join(root, 'plan.md');
  const written = spawnSync(process.execPath, [cli, 'run', 'plan', repo, run.runId, '--out', out], { encoding: 'utf8', env });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(await readFile(out, 'utf8'), printed.stdout);
  assert.equal((JSON.parse(written.stdout) as { planHash: string }).planHash, planHash);
});
