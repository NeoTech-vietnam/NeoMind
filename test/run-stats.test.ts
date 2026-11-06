import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject } from '../src/domain/templates.js';
import { estimateFor, flowRunnersKey } from '../src/domain/estimate.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { runStats, statsCsv } from '../src/runtime/run-stats.js';
import { sessionToolHandlers } from '../src/runtime/session-tools.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import { FakeRunnerFactory } from './helpers/fake-runner.js';

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];

/** Fake Codex agents that each report 1000 tokens per turn. */
async function project(pricing?: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), roleDefaults: { implementer: codexRole, verifier: codexRole } }));
  if (pricing) await writeFile(path.join(repo, 'neomind/pricing.json'), JSON.stringify(pricing));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const agents = new FakeRunnerFactory('codex', { tokensPerTurn: 1000, respond: async (session, request) => {
    const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties?.planId) return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach: 'Create proof.txt', acceptanceCriteria: ['proof'], checks: [], riskChanges: [] });
    if (schema?.properties?.evidence) {
      const reference = { kind: 'source', path: 'proof.txt', line: 1, quote: (await readFile(path.join(session.workspace, 'proof.txt'), 'utf8')).trim() };
      return JSON.stringify({ verdict: 'pass', findingIds: [], summary: 'Proof matches', evidence: { findings: [], criteria: ['approved plan', 'checks', 'regressions', 'proof'].map(criterion => ({ criterion, status: 'pass', references: [reference] })) } });
    }
    await writeFile(path.join(session.workspace, 'proof.txt'), 'ok\n'); return 'Implemented';
  } }, codexModels);
  const manager = await RunManager.open(repo, path.join(root, 's'), new RunnerRegistry([agents]));
  const runs = async () => manager;
  return { root, repo, manager, tools: sessionToolHandlers(runs, createEditorApi(repo, runs)) };
}

async function completeDev(f: Awaited<ReturnType<typeof project>>, limits = {}) {
  const preview = await f.manager.preview('dev', undefined, {}, limits);
  const run = await f.manager.create('dev', 'Add proof', undefined, {}, preview.configurationHash, limits);
  await f.manager.settle(run.runId); await f.manager.action(run.runId, 'approve', 'cli');
  return f.manager.settle(run.runId);
}

test('a run pauses when its tokens reach maxTokens and continues after the user adds tokens', async () => {
  const f = await project();
  try {
    const run = await completeDev(f, { maxTokens: 1500 });
    // Planning used 1000, implementing 1000 more: the budget check before the review pauses the run.
    assert.equal(run.runtimeState?.phase, 'paused', run.runtimeState?.reason);
    assert.match(run.runtimeState?.reason ?? '', /Hết ngân sách token \(2000\/1500\)/);
    assert.equal((run as { tokenLimit?: number | null }).tokenLimit, 1500);
    assert.equal((await f.manager.list())[0]?.tokens, 2000);
    await assert.rejects(f.manager.action(run.runId, 'resume', 'cli'), /Hết ngân sách token/);
    await assert.rejects(f.tools.extend_time!({ runId: run.runId }), /seconds, tokens or both/);
    await f.tools.extend_time!({ runId: run.runId, tokens: 5000 });
    const done = await f.manager.settle(run.runId);
    assert.equal(done.runtimeState?.phase, 'completed', done.runtimeState?.reason);
    assert.equal(done.tokenExtensions, 5000); assert.equal(done.usage.totalTokens, 3000);
  } finally { await f.manager.close(); }
});

test('statistics aggregate journals by flow, profile and runner, price runs and estimate only from three finished runs', async () => {
  const f = await project({ schemaVersion: 1, models: { 'gpt-6-luna': { inputPerMTok: 1, outputPerMTok: 4 } } });
  try {
    await completeDev(f); await completeDev(f);
    let stats = await runStats(f.repo, f.manager);
    const key = flowRunnersKey('dev', ['codex']);
    assert.equal(stats.byFlowRunners.find(item => item.key === key)?.completed, 2);
    assert.equal(estimateFor(stats.byFlowRunners, 'dev', ['codex']), null);
    await completeDev(f);
    const paused = await f.manager.create('dev', 'Never approved', undefined, {}, (await f.manager.preview('dev')).configurationHash);
    await f.manager.settle(paused.runId);
    stats = await runStats(f.repo, f.manager);
    const dev = stats.byFlow.find(item => item.key === 'dev')!;
    assert.deepEqual([dev.runs, dev.completed, dev.delivered], [4, 3, 3]);
    assert.equal(dev.completionRate, 0.75); assert.equal(dev.deliveryRate, 0.75);
    assert.deepEqual(dev.tokens, { average: 3000, median: 3000, samples: 3 }); assert.equal(dev.firstPassReviewRate, 1); assert.equal(dev.repairRounds, 0);
    // 3 sessions × 1000 tokens, a quarter output: 2250 × $1 + 750 × $4 per million tokens.
    assert.ok(Math.abs((dev.costUSD?.median ?? 0) - 0.00525) < 1e-9);
    assert.deepEqual(stats.byProfile.map(item => item.key), ['implementer@1', 'verifier@1']);
    assert.deepEqual(stats.byRunnerModel.map(item => item.key), ['codex/gpt-6-luna']);
    const estimate = estimateFor(stats.byFlowRunners, 'dev', ['codex']);
    assert.equal(estimate?.runs, 3); assert.equal(estimate?.tokens, 3000);
    assert.equal(estimateFor(stats.byFlowRunners, 'dev', ['claude-code', 'codex']), null);
    const csv = statsCsv(stats).split('\n');
    assert.match(csv[0]!, /^group,key,runs,completed,delivered/); assert.ok(csv.some(line => line.startsWith('flow,dev,4,3,3,0.75,0.75,3000,3000')));
    const tool = await f.tools.stats!({ flowId: 'dev' }) as { byFlow: { key: string }[]; runs?: unknown };
    assert.deepEqual(tool.byFlow.map(item => item.key), ['dev']); assert.equal(tool.runs, undefined);
    const assessed = await f.tools.assess!({ task: 'Thêm proof' }) as { flowId: string; statistics?: Record<string, { runs: number }>; reasons: string[] };
    assert.equal(assessed.flowId, 'dev'); assert.equal(assessed.statistics?.dev?.runs, 4); assert.ok(assessed.reasons.some(reason => /Thống kê dev: giao 75%/.test(reason)));
  } finally { await f.manager.close(); }
});

test('without pricing.json statistics show tokens only, and the CLI prints CSV', async () => {
  const f = await project();
  try {
    await completeDev(f);
    const stats = await runStats(f.repo, f.manager);
    assert.equal(stats.pricing, false); assert.equal(stats.byFlow[0]?.costUSD, null);
    assert.equal(stats.byFlow[0]?.tokens.median, 3000);
  } finally { await f.manager.close(); }
  const script = path.resolve('dist/src/cli/main.js'), env = { ...process.env, XDG_STATE_HOME: path.join(f.root, 'x'), LOCALAPPDATA: path.join(f.root, 'x') };
  const csv = execFileSync(process.execPath, [script, 'run', 'stats', f.repo, '--csv'], { encoding: 'utf8', env });
  assert.match(csv, /^group,key,runs/);
  assert.throws(() => execFileSync(process.execPath, [script, 'run', 'stats', f.repo, '--csv', '--json'], { encoding: 'utf8', env, stdio: 'pipe' }));
});
