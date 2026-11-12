import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRun, maxPlanSelfRepairs, parseCheck } from '../src/runtime/local-run.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { builtinProfile } from '../src/runtime/project.js';
import { materializeRun } from '../src/domain/materialize.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { RunStore } from '../src/storage/run-store.js';
import { CodexTurnEvents } from '../src/adapters/codex-turn-events.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import type { WorkerFactory } from '../src/runtime/worker.js';
import type { RunnerTurnRequest } from '../src/runners/agent-runner.js';
import { checkCommandPattern, plannerJsonSchema } from '../src/domain/approval.js';
import { replayRun } from '../src/core/recovery.js';
import { proposalIds } from '../src/runtime/memory-proposals.js';
import { LessonProposals } from '../src/memory/proposals.js';
import { FakeRunnerFactory, fakeScope } from './helpers/fake-runner.js';

const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const models = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];
type PlanTurn = { sessionId: string; request: RunnerTurnRequest };
/** What the planner returns on its n-th turn (1-based). */
type Planner = (turn: number) => { scope: string[]; checks: string[] };

/** Agent runners whose n-th start fails, like a NeoMind process that dies before the next turn is dispatched. */
class DyingRunnerFactory extends FakeRunnerFactory {
  private starts = 0;
  dieAt: number | undefined;
  override async start() {
    if (++this.starts === this.dieAt) throw new Error('NeoMind process died');
    return super.start();
  }
}

/** The plan version a planning prompt asks for: the requested revision's version, or 1 for a first plan. */
function requestedVersion(prompt: string): number {
  const line = prompt.split('use the specified version):\n')[1]?.split('\n')[0];
  return (line ? (JSON.parse(line) as { version: number } | null)?.version : undefined) ?? 1;
}

/** A Fast flow whose writer may only edit `c`, like a practice repo that adds one directory per problem. */
async function fixture(planner: Planner, approval: 'auto' | 'user' = 'auto') {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-psr-')), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  await mkdir(path.join(repo, 'c'), { recursive: true }); await mkdir(path.join(state, 'runs'), { recursive: true }); await mkdir(path.join(state, 'workspaces'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  const config = { ...structuredClone(defaultProject), policy: { ...defaultProject.policy, allowAutoApproval: true, allowHumanReview: true }, roleDefaults: { implementer: role, verifier: role } };
  await writeFile(path.join(repo, 'c', 'README.md'), 'C\n'); await mkdir(path.join(repo, 'neomind')); await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify(config));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const flow = structuredClone(templates.fast);
  for (const node of flow.definition.nodes) {
    if (node.id === 'implement' && node.type === 'agent_task') node.writeScopes = ['c'];
    if (node.type === 'approval') { node.mode = approval; if (approval === 'user') node.purpose = 'Review the plan'; }
  }
  const snapshot = await materializeRun(flow, config, { 'implementer@1': builtinProfile('implementer')! }, repo);
  const coordinator = new WorkspaceCoordinator(path.join(state, 'coordination.sqlite'));
  const codex: WorkerFactory = async () => ({ events: new CodexTurnEvents(), fault: () => undefined, scope: { ...fakeScope(), transport: { request: async () => ({}) } } });
  const planTurns: PlanTurn[] = [];
  const agents = new DyingRunnerFactory('codex', { tokensPerTurn: 1000, respond: async (session, request) => {
    const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties?.planId) {
      planTurns.push({ sessionId: session.sessionId, request });
      const plan = planner(planTurns.length);
      return JSON.stringify({ planId: 'p', version: requestedVersion(request.prompt), goal: 'Add problem 0001', approach: 'Create c/0001_two/test.c', acceptanceCriteria: ['test compiles'], riskChanges: [], ...plan });
    }
    await mkdir(path.join(session.workspace, 'c', '0001_two'), { recursive: true });
    await writeFile(path.join(session.workspace, 'c/0001_two/test.c'), 'int main(void) { return 0; }\n'); return 'Implemented';
  } }, models);
  const runners = new RunnerRegistry([agents]);
  const run = await LocalRun.create({ projectRoot: repo, stateRoot: state, task: 'Add problem 0001', snapshot, coordinator, workerFactory: codex, runners });
  return { run, planTurns, coordinator, state, codex, runners, agents };
}

const good = { scope: ['c'], checks: ['gcc -fsyntax-only c/0001_two/test.c'] };

test('a plan with a placeholder check goes back to its planner once, in the same session, before NeoMind approves it', async () => {
  const f = await fixture(turn => turn === 1 ? { scope: ['c'], checks: ['gcc c/<id>_<slug>/test.c'] } : good);
  try {
    f.run.launch(); await f.run.settled();
    const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(f.planTurns.length, 2);
    const first = f.planTurns[0]!.request.prompt;
    // A one-writer flow learns the writer's scopes and the check and scope rules up front.
    assert.ok(first.includes('{"nodeId":"implement","writeScopes":["c"]}'), first);
    assert.ok(first.includes('A-Za-z0-9_./:=+,%@-')); assert.match(first, /placeholders such as <id>/); assert.match(first, /never a directory this run will create/);
    assert.equal((f.planTurns[0]!.request.outputSchema as { properties: { checks: { items: { pattern?: string } } } }).properties.checks.items.pattern, checkCommandPattern);
    assert.equal(f.planTurns[1]!.sessionId, f.planTurns[0]!.sessionId, 'the revision runs in the planning session');
    assert.match(f.planTurns[1]!.request.prompt, /NeoMind rejected plan version 1 before approval/);
    assert.deepEqual(report.planRevisions.map(item => [item.author, item.version]), [['neomind', 2]]);
    assert.match(report.planRevisions[0]!.feedback, /gcc c\/<id>_<slug>\/test\.c/);
    assert.deepEqual([report.approvals[0]?.plan.version, report.approvals[0]?.approval.actor], [2, 'neomind']);
    // Both planning turns count: the planning session reports 2000 cumulative tokens, the writer 1000.
    assert.equal(report.usage.totalTokens, 3000);
    const directory = path.dirname(f.run.durable.journal.file), store = new LessonProposals(directory);
    assert.deepEqual(proposalIds(directory).map(id => store.read(id).origin).filter(origin => origin === 'plan_revision' || origin === 'run_stopped'), [], 'a revision NeoMind made itself is not a memory proposal');
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('a plan scope outside the writer scopes is sent back before approval instead of failing at the writer', async () => {
  const f = await fixture(turn => turn === 1 ? { scope: ['.'], checks: good.checks } : good);
  try {
    f.run.launch(); await f.run.settled();
    const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'completed', report.runtimeState.reason);
    assert.equal(report.planRevisions.length, 1);
    assert.match(report.planRevisions[0]!.feedback, /Plan scope \. is outside the writeScopes of implement \(\["c"\]\)/);
    assert.deepEqual(report.approvals.map(item => item.plan.scope), [['c']]);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test(`a planner that keeps breaking the rules stops after ${maxPlanSelfRepairs} revisions and waits for the user with the reason`, async () => {
  const f = await fixture(() => ({ scope: ['c/0001_two'], checks: ['sh -c "gcc x.c | tee log"'] }));
  try {
    f.run.launch(); await f.run.settled();
    const report = await f.run.report();
    assert.equal(report.runtimeState.phase, 'waiting_approval');
    assert.equal(f.planTurns.length, maxPlanSelfRepairs + 1);
    assert.equal(report.planRevisions.length, maxPlanSelfRepairs);
    assert.match(report.runtimeState.reason, /^Không tự duyệt được kế hoạch: /);
    assert.match(report.runtimeState.reason, /is not a plain argv command/);
    assert.match(report.runtimeState.reason, /must be directories that already exist in the repository .*c\/0001_two/);
    assert.match(report.runtimeState.reason, new RegExp(`already sent the plan back ${maxPlanSelfRepairs} times`));
    assert.deepEqual(report.approvals, []);
    await assert.rejects(f.run.approve('local-user', 'ui', report.proposedPlanHash), /not a plain argv command/);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('with a user approval the plan is repaired first and then waits for the user; NeoMind never approves it', async () => {
  const f = await fixture(turn => turn === 1 ? { scope: ['c'], checks: ['gcc c/<id>/test.c'] } : good, 'user');
  try {
    f.run.launch(); await f.run.settled();
    const report = await f.run.report();
    assert.deepEqual([report.runtimeState.phase, report.runtimeState.reason], ['waiting_approval', 'Review the plan']);
    assert.deepEqual(report.planRevisions.map(item => item.author), ['neomind']);
    assert.deepEqual(report.approvals, []);
    await f.run.approve('local-user', 'ui', report.proposedPlanHash); await f.run.settled();
    const done = await f.run.report();
    assert.equal(done.runtimeState.phase, 'completed', done.runtimeState.reason);
    assert.deepEqual([done.approvals[0]?.approval.actor, done.approvals[0]?.plan.version], ['local-user', 2]);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('a crash during a revision resumes with the revisions already made counted from the journal', async () => {
  // NeoMind dies after journaling its first revision request, before the planner's second turn; after recovery the
  // planner still breaks the rules, so only one more revision is left.
  const f = await fixture(() => ({ scope: ['c'], checks: ['gcc c/<id>/test.c'] }));
  f.agents.dieAt = 2;
  let run = f.run;
  try {
    run.launch(); await run.settled();
    assert.equal((await run.report()).planRevisions.length, 1);
    assert.equal(f.planTurns.length, 1);
    await run.close();
    run = await LocalRun.recover(await RunStore.open(path.join(f.state, 'runs')), f.coordinator, run.runId, f.codex, undefined, f.runners);
    const recovered = (await run.report()).runtimeState; assert.equal(recovered.phase, 'recovering', recovered.reason);
    await run.resume(); await run.settled();
    const report = await run.report();
    assert.equal(report.runtimeState.phase, 'waiting_approval', report.runtimeState.reason);
    assert.deepEqual(report.planRevisions.map(item => [item.author, item.version]), [['neomind', 2], ['neomind', 3]]);
    assert.equal(f.planTurns.length, 3, 'the first plan and the two revisions');
    assert.match(report.runtimeState.reason, /already sent the plan back 2 times/);
  } finally { await run.close(); f.coordinator.close(); }
});

test('replaying a journal from before self-repair gives the same report, and prompts come from the journal', async () => {
  const f = await fixture(() => good, 'user');
  try {
    f.run.launch(); await f.run.settled();
    const report = await f.run.report();
    await f.run.revisePlan('Keep it small', report.proposedPlanHash!); await f.run.settled();
    const events = await f.run.durable.journal.read(), replayed = replayRun(events);
    // A user's request (and every older journal) carries no author, and replay adds none.
    assert.deepEqual(replayed.planRevisions, [{ planningNodeId: 'plan', planId: 'p', version: 2, feedback: 'Keep it small' }]);
    // Each planning prompt is journaled as sent; replay reads it back instead of rebuilding it with today's wording.
    const inputs = events.filter(event => event.type === 'node_input').map(event => (event.payload as { prompt: string }).prompt);
    assert.deepEqual(inputs, f.planTurns.map(turn => turn.request.prompt));
    assert.deepEqual(replayed.nodeData.map(item => item.prompt), inputs);
  } finally { await f.run.close(); f.coordinator.close(); }
});

test('the planner schema constrains checks with the same characters the runtime accepts, except for OpenCode', () => {
  const pattern = new RegExp((plannerJsonSchema(true) as { properties: { checks: { items: { pattern: string } } } }).properties.checks.items.pattern);
  for (const command of ['npm test', 'gcc -fsyntax-only c/two-pointers/0001_two/test.c', 'node --test dist/test/a.test.js', 'python -m pytest -q tests/x_test.py']) {
    assert.ok(pattern.test(command), command); assert.doesNotThrow(() => parseCheck(command));
  }
  for (const command of ['gcc c/<id>_<slug>/test.c', 'npm test | tee log', 'echo "a b"', 'test -f a > b', 'ls *.c']) {
    assert.equal(pattern.test(command), false, command); assert.throws(() => parseCheck(command), /not a plain argv command/);
  }
  assert.equal((plannerJsonSchema(false) as { properties: { checks: { items: { pattern?: string } } } }).properties.checks.items.pattern, undefined);
});
