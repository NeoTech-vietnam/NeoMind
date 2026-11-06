import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultProject, newFlowFromTemplate, templates } from '../src/domain/templates.js';
import { planSteps, reviewRequirements } from '../src/domain/review-requirements.js';
import { assessReviewEvidence } from '../src/core/review-evidence.js';
import { draftFlow, publishFlow } from '../src/runtime/flow-authoring.js';
import { RunManager } from '../src/runtime/run-manager.js';
import { sessionToolHandlers } from '../src/runtime/session-tools.js';
import { createEditorApi } from '../src/ui-server/server.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import type { Plan } from '../src/domain/approval.js';
import { FakeRunnerFactory } from './helpers/fake-runner.js';

const codexRole = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'medium' };
const codexModels = [{ runner: 'codex' as const, provider: 'openai', model: 'gpt-6-luna', reasoning: ['low', 'medium', 'high'] }];
const approach = '1. Create proof.txt\n2. Write ok into it';
const stepCriteria = ['Plan step 1: Create proof.txt', 'Plan step 2: Write ok into it'];

test('plan steps become review criteria only for flows that opt in', async () => {
  assert.deepEqual(planSteps('Intro\n1. First\n  2) Second\nprose'), [{ number: 1, text: 'First' }, { number: 2, text: 'Second' }]);
  const plan = { planId: 'p', version: 1, goal: 'g', scope: ['.'], approach, acceptanceCriteria: ['proof'], checks: [], riskChanges: [] } as Plan;
  const fresh = newFlowFromTemplate('dev'), review = fresh.definition.nodes.find(node => node.type === 'review_group');
  assert.ok(review?.type === 'review_group' && review.planStepCriteria);
  assert.deepEqual(reviewRequirements(fresh, review, plan).criteria, ['approved plan', 'checks', 'regressions', 'proof', ...stepCriteria]);
  const builtin = templates.dev.definition.nodes.find(node => node.type === 'review_group');
  assert.ok(builtin?.type === 'review_group' && builtin.planStepCriteria === undefined);
  assert.deepEqual(reviewRequirements(templates.dev, builtin, plan).criteria, ['approved plan', 'checks', 'regressions', 'proof']);
  // Evidence that skips a step does not cover the review's criteria, so the review cannot pass.
  const workspace = await mkdtemp(path.join(tmpdir(), 'nm-step-')); await writeFile(path.join(workspace, 'proof.txt'), 'ok\n');
  const reference = { kind: 'source' as const, path: 'proof.txt', line: 1, quote: 'ok' };
  const evidence = (criteria: string[]) => ({ findings: [], criteria: criteria.map(criterion => ({ criterion, status: 'pass' as const, references: [reference] })) });
  const required = reviewRequirements(fresh, review, plan).criteria;
  const missing = await assessReviewEvidence({ workspace, criteria: required, evidence: evidence(required.slice(0, -1)), findingIds: [], baselineHash: 'b', checks: [] });
  assert.equal(missing.criteriaCovered, false); assert.equal(missing.evidenceValidated, false);
  assert.equal((await assessReviewEvidence({ workspace, criteria: required, evidence: evidence(required), findingIds: [], baselineHash: 'b', checks: [] })).criteriaCovered, true);
});

/** A repo whose fake Codex agents write proof.txt wrong once, so the first review asks for a fix the repair makes. */
async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'nm-')), repo = path.join(root, 'r');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Fixture\n'); await mkdir(path.join(repo, 'neomind'));
  await writeFile(path.join(repo, 'neomind/project.json'), JSON.stringify({ ...structuredClone(defaultProject), roleDefaults: { implementer: codexRole, verifier: codexRole } }));
  const prompts: string[] = [];
  let writes = 0;
  const agents = new FakeRunnerFactory('codex', { respond: async (session, request) => {
    const schema = request.outputSchema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties?.planId) { prompts.push(request.prompt); return JSON.stringify({ planId: 'p', version: 1, goal: 'Add proof', scope: ['.'], approach, acceptanceCriteria: ['proof'], checks: [], riskChanges: [] }); }
    if (schema?.properties?.evidence) {
      const text = (await readFile(path.join(session.workspace, 'proof.txt'), 'utf8')).trim(), failed = text !== 'ok';
      const reference = { kind: 'source', path: 'proof.txt', line: 1, quote: text };
      return JSON.stringify({ verdict: failed ? 'needs_changes' : 'pass', findingIds: failed ? ['wrong-proof'] : [], summary: failed ? 'Proof is wrong' : 'Proof matches',
        evidence: { criteria: ['approved plan', 'checks', 'regressions', 'proof', ...stepCriteria].map(criterion => ({ criterion, status: failed && criterion === 'proof' ? 'fail' : 'pass', references: [reference] })),
          findings: failed ? [{ id: 'wrong-proof', criterion: 'proof', explanation: 'proof.txt must contain ok, not wrong', references: [reference] }] : [] } });
    }
    await writeFile(path.join(session.workspace, 'proof.txt'), ++writes === 1 ? 'wrong\n' : 'ok\n'); return 'Implemented';
  } }, codexModels);
  const created = await draftFlow(repo, { flowId: 'steps', name: 'Dev with plan steps', from: { template: 'dev' } });
  await publishFlow(repo, 'steps', { author: { kind: 'human' }, expectedRevision: created.revision });
  git('add', '.'); git('commit', '-qm', 'baseline');
  const manager = await RunManager.open(repo, path.join(root, 's'), new RunnerRegistry([agents]));
  const runs = async () => manager, started: string[] = [];
  const tools = sessionToolHandlers(runs, createEditorApi(repo, runs), { onStart: runId => { started.push(runId); } });
  return { repo, git, manager, tools, started, prompts };
}

type Status = { progress: { delivered: number; total: number }; nextReady: string | null; phases: { id: string; status: string; runId?: string; commits?: string[] }[] };
const phases = (status: Status) => Object.fromEntries(status.phases.map(phase => [phase.id, phase.status]));

test('a program starts phases in dependency order and hands lessons from a repaired review to the next phase', async () => {
  const f = await project();
  try {
    const spec = { schemaVersion: 1, programId: 'proof', name: 'Proof program', goal: 'Deliver proof in steps', phases: [
      { id: 'one', title: 'Write proof', task: 'Add proof.txt', flowId: 'steps', dependsOn: [] },
      { id: 'two', title: 'Extend proof', task: 'Extend proof.txt', flowId: 'steps', dependsOn: ['one'] },
      { id: 'three', title: 'Report', task: 'Summarise proof', flowId: 'research', dependsOn: ['two'] }] };
    await assert.rejects(f.tools.program_create!({ program: { ...spec, programId: 'bad', phases: [{ ...spec.phases[0]!, flowId: 'missing' }] } }), /does not exist/);
    await assert.rejects(f.tools.program_create!({ program: { ...spec, programId: 'cycle', phases: [{ ...spec.phases[0]!, dependsOn: ['two'] }, spec.phases[1]!] } }), /cycle/);
    await f.tools.program_create!({ program: spec });
    await assert.rejects(f.tools.program_create!({ program: spec }), /already exists/);
    f.git('add', '.'); f.git('commit', '-qm', 'program');
    let status = await f.tools.program_status!({ programId: 'proof' }) as Status;
    assert.deepEqual(phases(status), { one: 'ready', two: 'blocked_by_dependency', three: 'blocked_by_dependency' });

    const first = await f.tools.program_next!({ programId: 'proof' }) as { started: boolean; runId: string; phaseId: string };
    assert.equal(first.phaseId, 'one'); assert.deepEqual(f.started, [first.runId]);
    await f.manager.settle(first.runId);
    assert.equal((await f.manager.get(first.runId)).runtimeState?.phase, 'waiting_approval');
    // Nothing else is ready while the user decides on the plan; program_next reports that instead of starting a phase.
    assert.equal((await f.tools.program_next!({ programId: 'proof' }) as { started: boolean }).started, false);
    await f.manager.action(first.runId, 'approve', 'cli'); const done = await f.manager.settle(first.runId);
    assert.equal(done.runtimeState?.phase, 'completed', done.runtimeState?.reason); assert.equal(done.repairRounds.length, 1);
    status = await f.tools.program_status!({ programId: 'proof' }) as Status;
    assert.deepEqual(phases(status), { one: 'waiting_user', two: 'blocked_by_dependency', three: 'blocked_by_dependency' });

    // The phase is delivered once its commit is in the checkout's HEAD.
    f.git('merge', '--ff-only', '-q', status.phases[0]!.commits![0]!);
    status = await f.tools.program_status!({ programId: 'proof' }) as Status;
    assert.deepEqual(phases(status), { one: 'delivered', two: 'ready', three: 'blocked_by_dependency' });
    assert.deepEqual(status.progress, { delivered: 1, total: 3 }); assert.equal(status.nextReady, 'two');

    const second = await f.tools.program_next!({ programId: 'proof' }) as { started: boolean; runId: string; phaseId: string; task: string };
    assert.equal(second.phaseId, 'two');
    assert.match(second.task, /^Extend proof\.txt\n/);
    assert.match(second.task, /Bài học từ các giai đoạn trước:\n- \[one\] Review đã yêu cầu sửa \(proof\): proof\.txt must contain ok, not wrong/);
    assert.equal((await f.manager.get(second.runId)).runtimeContext?.phaseId, 'two');
    await f.manager.settle(second.runId);
    assert.match(f.prompts.at(-1)!, /Bài học từ các giai đoạn trước/);
    await assert.rejects(f.tools.program_deliver!({ programId: 'proof', phaseId: 'two', note: 'x' }), /ask them in this session first/);
    await assert.rejects(f.tools.program_deliver!({ programId: 'proof', phaseId: 'two', note: 'x', confirmed: true }), /đã hoàn tất/);
    await f.manager.action(second.runId, 'cancel', 'cli');
    status = await f.tools.program_status!({ programId: 'proof' }) as Status;
    assert.equal(phases(status).two, 'failed'); assert.equal(status.nextReady, 'two');
    const list = await f.tools.program_list!({}) as { programs: { programId: string }[] };
    assert.deepEqual(list.programs.map(item => item.programId), ['proof']);
  } finally { await f.manager.close(); }
});

test('CLI reads program status through the shared core', async () => {
  const f = await project();
  try {
    const spec = path.join(path.dirname(f.repo), 'program.json');
    await writeFile(spec, JSON.stringify({ schemaVersion: 1, programId: 'cli', name: 'CLI', goal: 'g', phases: [{ id: 'a', title: 'A', task: 'Do A', flowId: 'dev', dependsOn: [] }] }));
    const script = path.resolve('dist/src/cli/main.js');
    const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: path.join(path.dirname(f.repo), 'x'), LOCALAPPDATA: path.join(path.dirname(f.repo), 'x') } })) as Record<string, unknown>;
    assert.equal((cli('program', 'create', f.repo, spec).program as { programId: string }).programId, 'cli');
    assert.equal(((cli('program', 'status', f.repo, 'cli') as unknown as Status).phases[0]?.status), 'ready');
  } finally { await f.manager.close(); }
});
