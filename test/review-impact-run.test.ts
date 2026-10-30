import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalRun } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import type { WorkerFactory } from '../src/runtime/worker.js';

/** Two reviewers scoped to a/ and b/. The first implementation breaks a/; the repair fixes it and may also touch package.json. */
async function fixture(repairTouchesShared: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), 'neomind-impact-')), project = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(project); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await mkdir(path.join(project, 'a')); await mkdir(path.join(project, 'b'));
  await writeFile(path.join(project, 'a', 'README'), 'a\n'); await writeFile(path.join(project, 'b', 'README'), 'b\n'); await writeFile(path.join(project, 'package.json'), '{}\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const config = { ...structuredClone(defaultProject), roleDefaults: { implementer: role, verifier: role } };
  const flow = structuredClone(templates.dev), group = flow.definition.nodes.find(node => node.type === 'review_group')!;
  if (group.type !== 'review_group') throw new Error('Bad template');
  group.reviewers = [{ ...group.reviewers[0]!, id: 'reviewer-a', scope: ['a'], instructionsOverride: 'REVIEWER-A' },
    { ...group.reviewers[0]!, id: 'reviewer-b', scope: ['b'], sessionGroup: 'reviewer-b-session', instructionsOverride: 'REVIEWER-B' }];
  flow.definition.sessionGroups.push({ id: 'reviewer-b-session', bindingId: 'verifier' });
  const snapshot = await materializeRun(flow, config, { 'implementer@1': builtinProfile('implementer'), 'verifier@1': builtinProfile('verifier') }, project);
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const threads = new Map<string, { cwd: string; sandbox: string }>(), reviews = { a: 0, b: 0 };
  let writes = 0;
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
      const threadId = String(params.threadId), turnId = randomUUID(), thread = threads.get(threadId)!, prompt = JSON.stringify(params.input);
      const schema = params.outputSchema as { properties?: Record<string, unknown> } | undefined;
      let output: unknown;
      if (schema?.properties?.planId) output = { planId: 'impact', version: 1, goal: 'Parts', scope: ['.'], approach: 'Edit', acceptanceCriteria: ['parts'], checks: ['node --version'], riskChanges: [], workPackets: [] };
      else if (schema?.properties?.evidence) {
        const part = prompt.includes('REVIEWER-A') ? 'a' : 'b'; reviews[part]++;
        const quote = (await readFile(path.join(thread.cwd, part, `${part}.txt`), 'utf8')).trim(), failed = quote !== 'ok';
        const ref = { kind: 'source', path: `${part}/${part}.txt`, line: 1, quote };
        // Cite the core receipt given in the prompt, as real reviewers do; a carried pass keeps citing its original baseline.
        const receiptId = /receiptId\\":\\"([a-f0-9]{12})/.exec(prompt)?.[1];
        const checkRef = receiptId ? [{ kind: 'check', command: 'node --version', receiptId }] : [];
        output = { verdict: failed ? 'needs_changes' : 'pass', findingIds: failed ? [`${part}-wrong`] : [], summary: failed ? 'Wrong' : 'Fine',
          evidence: { criteria: ['approved plan', 'checks', 'regressions', 'parts'].map(criterion => ({ criterion, status: failed && criterion === 'parts' ? 'fail' : 'pass', references: criterion === 'checks' ? [ref, ...checkRef] : [ref] })),
            findings: failed ? [{ id: `${part}-wrong`, criterion: 'parts', explanation: 'Expected ok', references: [ref] }] : [] } };
      } else if (thread.sandbox !== 'read-only') {
        writes++;
        await writeFile(path.join(thread.cwd, 'a', 'a.txt'), writes === 1 ? 'wrong\n' : 'ok\n');
        if (writes === 1) await writeFile(path.join(thread.cwd, 'b', 'b.txt'), 'ok\n');
        if (writes === 2 && repairTouchesShared) await writeFile(path.join(thread.cwd, 'package.json'), '{ "private": true }\n');
        output = 'Implemented';
      } else output = 'read only';
      events.accept('item/completed', { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text: typeof output === 'string' ? output : JSON.stringify(output) } });
      events.accept('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      return { turn: { id: turnId } };
    } };
    return { events, fault: () => undefined, scope: { transport, identity: { unit: `neomind-run-${randomUUID()}.scope`, controlGroup: `/user.slice/user-0.slice/fixture.scope` }, isActive: async () => active, stop: async () => { active = false; return true; } } };
  };
  const run = await LocalRun.create({ projectRoot: project, stateRoot: state, task: 'Parts', snapshot, coordinator, workerFactory: factory, capabilityCheck: async () => ({ sandboxVerified: true, stopVerified: true }) });
  run.launch(); await run.settled(); await run.approve('fixture-user', 'cli'); await run.settled();
  return { run, coordinator, reviews };
}

test('a repair outside a passing reviewer\'s scope keeps that pass through a journaled impact receipt', async () => {
  const f = await fixture(false);
  try {
    const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.deepEqual(f.reviews, { a: 2, b: 1 }, 'only the reviewer whose scope changed ran again');
    const carried = report.reviewerOutputs.find(item => item.result.reviewerId === 'reviewer-b')!;
    assert.deepEqual(carried.carried?.changedPaths, ['a/a.txt']);
    assert.ok(carried.evidence?.criteria.some(item => item.references.some(ref => ref.kind === 'check')), 'the carried pass cites a check receipt of its own baseline');
    assert.equal(carried.result.baselineHash, report.acceptedReviews[0]!.baselineHash);
    assert.equal(report.checks.filter(check => check.status === 'passed').length, 2, 'checks still run on the repaired baseline');
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('a repair that changes shared build files reruns every required reviewer', async () => {
  const f = await fixture(true);
  try {
    const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.deepEqual(f.reviews, { a: 2, b: 2 });
    assert.ok(report.reviewerOutputs.every(item => !item.carried));
  } finally { await f.run.close(); f.coordinator.close(); }
});
