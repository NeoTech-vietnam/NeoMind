import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FakeAdapter } from '../src/adapters/fake.js';
import { SimulatedRun } from '../src/core/simulated-run.js';
import { defaultProject, templates } from '../src/domain/templates.js';
import { SingleOwnerJournal } from '../src/storage/journal.js';

test('simulated plan, user approval and scoped implementation survive journal recovery', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-simulated-run-'));
  const journal = new SingleOwnerJournal(path.join(dir, 'events.jsonl'), 'run1');
  const adapter = new FakeAdapter(); adapter.createSession('implementer-session');
  const run = await SimulatedRun.create(templates.dev, defaultProject.policy, journal, adapter);
  await run.completeControl('start');
  await run.dispatchAgent('plan', 'implementer-session', 'plan-attempt', 'plan-request');
  adapter.complete('plan-attempt', { plan: 'fixture only' });
  await run.completeAgent('plan', 'plan-attempt');
  assert.equal((await run.report()).graph.nodes.approval?.status, 'ready');
  const plan = { planId: 'plan1', version: 1, goal: 'Fixture feature', scope: ['src'], approach: 'Implement small change',
    acceptanceCriteria: ['Tests pass'], checks: ['test'], riskChanges: [] };
  await run.approve('approval', plan, 'fixture-user');
  await assert.rejects(run.dispatchAgent('implement', 'implementer-session', 'bad-attempt', 'bad-request', ['docs']), /outside the approved scope/);
  await run.dispatchAgent('implement', 'implementer-session', 'implement-attempt', 'implement-request', ['src/app.ts']);
  adapter.complete('implement-attempt', { changed: ['src/app.ts'], simulated: true });
  const recovered = await SimulatedRun.recover(journal, adapter);
  await assert.rejects(recovered.continueAfterRecovery(), /Unresolved attempts/);
  await recovered.reconcileAttempt('implement-attempt');
  await assert.rejects(recovered.completeAgent('implement', 'implement-attempt'), /explicitly continue/);
  await recovered.continueAfterRecovery();
  await recovered.completeAgent('implement', 'implement-attempt');
  assert.equal((await recovered.report()).graph.nodes.repair?.status, 'ready');
  assert.equal(adapter.observe().filter(event => event.attemptId === 'implement-attempt' && event.type === 'started').length, 1);
});

test('fixture completes a reviewed flow through simulated commit without touching Git', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-simulated-full-'));
  const adapter = new FakeAdapter(); adapter.createSession('producer');
  const run = await SimulatedRun.create(templates.dev, defaultProject.policy, new SingleOwnerJournal(path.join(dir, 'events.jsonl'), 'run1'), adapter);
  await run.completeControl('start');
  await run.dispatchAgent('plan', 'producer', 'plan-a', 'plan-r'); adapter.complete('plan-a', {}); await run.completeAgent('plan', 'plan-a');
  await run.approve('approval', { planId: 'p', version: 1, goal: 'Build', scope: ['src'], approach: 'Implement', acceptanceCriteria: ['done'], checks: [], riskChanges: [] }, 'user');
  await run.dispatchAgent('implement', 'producer', 'work-a', 'work-r', ['src/file']);
  adapter.complete('work-a', { baselineHash: 'fixture-baseline' }); await run.completeAgent('implement', 'work-a');
  await run.completeControl('repair');
  const review = templates.dev.definition.nodes.find(node => node.type === 'review_group');
  assert.ok(review && review.type === 'review_group');
  const reviewer = review.reviewers[0]!;
  await run.acceptReview(review.id, 'fixture-baseline', 'producer',
    [{ reviewerId: reviewer.id, sessionId: 'independent', baselineHash: 'fixture-baseline', verdict: 'pass', findingIds: [] }],
    { [reviewer.id]: { evidenceValidated: true, criteriaCovered: true, verifiedFindingIds: [], unresolvedDisagreement: false, mandatoryCriteriaFailed: false } });
  await run.simulateCommit('commit', review.id, 'fixture-baseline', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40));
  await run.completeControl('finish');
  assert.equal((await run.report()).graph.nodes.finish?.status, 'succeeded');
});
