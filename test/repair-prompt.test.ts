import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkArtifactText, failedCheckOutput, LocalRun } from '../src/runtime/local-run.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { CodexRunnerFactory } from '../src/runners/codex-runner.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import type { WorkerFactory } from '../src/runtime/worker.js';
import type { RecoveryReport } from '../src/core/recovery.js';
import { FakeRunnerFactory, fakeScope } from './helpers/fake-runner.js';

const claudeRole = { runner: 'claude-code', provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: 'medium' };
const claudeModels = [{ runner: 'claude-code' as const, provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: ['low', 'medium', 'high'] }];
const environmentGuidance = 'If a failure is caused by the environment (permissions, sandbox, a missing tool or command) rather than by the code, do not change code to work around it';

test('the repair writer sees the output of the checks that failed in the last review, not the passing ones', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-repair-prompt-')), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(repo); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await writeFile(path.join(repo, 'pass-check.cjs'), '\n'); await writeFile(path.join(repo, 'fail-check.cjs'), '\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: claudeRole, verifier: claudeRole } };
  await mkdir(path.join(repo, '.neomind')); await writeFile(path.join(repo, '.neomind/project.json'), JSON.stringify(config));
  const snapshot = await materializeRun(structuredClone(templates.dev), config, { 'implementer@1': builtinProfile('implementer')!, 'verifier@1': builtinProfile('verifier')! }, repo);
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  // Checks run through Codex: fail-check fails once with long output, pass-check always passes.
  let failures = 0;
  const codex: WorkerFactory = async () => ({ events: new CodexTurnEvents(), fault: () => undefined, scope: { ...fakeScope(), transport: { request: async (method: string, params: unknown) => {
    if (method !== 'command/exec') throw new Error(`Unexpected Codex request ${method}`);
    const command = (params as { command: string[] }).command;
    if (command.at(-1) === 'fail-check.cjs' && failures++ === 0)
      return { exitCode: 1, stdout: Array.from({ length: 300 }, (_, n) => `out ${n + 1}.`).join('\n'), stderr: 'FAIL-TAIL: expected ok' };
    return { exitCode: 0, stdout: 'PASS-OUTPUT-MARKER', stderr: '' };
  } } } });
  const prompts: { plan: string[]; write: string[] } = { plan: [], write: [] };
  let writes = 0;
  const claude = new FakeRunnerFactory('claude-code', { respond: async (session, request) => {
    const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties?.planId) {
      prompts.plan.push(request.prompt);
      return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: ['node pass-check.cjs', 'node fail-check.cjs'], riskChanges: [] });
    }
    if (schema?.properties?.evidence) {
      const text = (await readFile(path.join(session.workspace, 'proof.txt'), 'utf8')).trim(), failed = text !== 'ok';
      const reference = { kind: 'source', path: 'proof.txt', line: 1, quote: text };
      return JSON.stringify({ verdict: failed ? 'needs_changes' : 'pass', findingIds: failed ? ['wrong-proof'] : [], summary: failed ? 'Proof is wrong' : 'Proof matches',
        evidence: { criteria: ['approved plan', 'checks', 'regressions', 'proof'].map(criterion => ({ criterion, status: failed && criterion === 'proof' ? 'fail' : 'pass', references: [reference] })),
          findings: failed ? [{ id: 'wrong-proof', criterion: 'proof', explanation: 'Expected ok', references: [reference] }] : [] } });
    }
    prompts.write.push(request.prompt);
    await writeFile(path.join(session.workspace, 'proof.txt'), ++writes === 1 ? 'wrong\n' : 'ok\n'); return 'Implemented';
  } }, claudeModels);
  const run = await LocalRun.create({ projectRoot: repo, stateRoot: state, task: 'Add proof', snapshot, coordinator, workerFactory: codex, runners: new RunnerRegistry([new CodexRunnerFactory(codex), claude]) });
  try {
    run.launch(); await run.settled(); await run.approve('fixture-user', 'cli'); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason); assert.equal(report.repairRounds.length, 1);
    // Planner: checks must leave the working tree alone.
    assert.match(prompts.plan[0]!, /Checks must not write files into the repository working tree/);
    assert.match(prompts.plan[0]!, /system temp directory or a path the repository already ignores/);
    const [first, repair] = prompts.write;
    assert.ok(first && repair);
    assert.doesNotMatch(first, /Checks that failed/); assert.ok(!first.includes(environmentGuidance));
    // The repair writer has the failing check's command, exit code and the end of its output, marked as truncated.
    assert.match(repair, /Checks that failed in the latest review[^\n]*\n\$ node fail-check\.cjs\nexit 1\n\[output truncated: showing the last 200 lines \/ \d+ characters of 301 lines \/ \d+ characters\]\n/);
    assert.ok(repair.includes('out 300.') && repair.includes('FAIL-TAIL: expected ok') && !repair.includes('out 1.') && !repair.includes('out 101.'));
    assert.ok(repair.includes(environmentGuidance));
    assert.ok(!repair.includes('PASS-OUTPUT-MARKER') && !repair.includes('$ node pass-check.cjs'));
    assert.ok(report.artifacts.filter(item => item.kind === 'check').every(item => item.baselineHash));
  } finally { await run.close(); coordinator.close(); }
});

test('check output keeps its end when long, and the repair excerpt is capped by characters as well as lines', () => {
  const text = checkArtifactText('npm test', 1, 'a'.repeat(500), 'FAILED: z', 200);
  const [, kept] = /^npm test\nexit 1\n\[output truncated: earlier output omitted, kept the last (\d+) of 510 characters\]\n/.exec(text) ?? [];
  assert.ok(kept && text.length <= 200 && text.length > 190); assert.ok(text.endsWith(`${'a'.repeat(Number(kept) - 10)}\nFAILED: z`));
  assert.equal(checkArtifactText('npm test', 0, 'ok', ''), 'npm test\nexit 0\nok\n');
  const report = { repairRounds: [{ roundId: 'r', scopeId: 's', baselineHash: 'b', findingIds: ['f'] }],
    checks: [{ command: 'npm test', baselineHash: 'b', status: 'failed' }, { command: 'npm run lint', baselineHash: 'b', status: 'passed' }, { command: 'npm run old', baselineHash: 'old', status: 'failed' }],
    artifacts: [{ nodeId: 'verify', kind: 'check', baselineHash: 'b', text: `npm test\nexit 1\n${'x'.repeat(50)}\nFAILED: z` },
      { nodeId: 'verify', kind: 'check', baselineHash: 'b', text: 'npm run lint\nexit 0\nclean' }, { nodeId: 'verify', kind: 'check', baselineHash: 'old', text: 'npm run old\nexit 2\nstale' }] } as unknown as RecoveryReport;
  const excerpt = failedCheckOutput(report, 200, 20);
  assert.match(excerpt, /\$ npm test\nexit 1\n\[output truncated: showing the last 2 lines \/ 20 characters of 2 lines \/ 60 characters\]\nx{10}\nFAILED: z\n$/);
  assert.ok(!excerpt.includes('npm run lint') && !excerpt.includes('stale'));
  assert.equal(failedCheckOutput({ ...report, repairRounds: [] }), '');
  assert.match(failedCheckOutput(report), /\$ npm test\nexit 1\nx{50}\nFAILED: z\n$/);
});
