import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeAdapter } from '../src/adapters/fake.js';
import { CodexReadOnlyAdapter } from '../src/adapters/codex-readonly.js';
import { CodexReadOnlyDispatch } from '../src/core/codex-readonly-dispatch.js';
import { SimulatedRun } from '../src/core/simulated-run.js';
import { replayRun } from '../src/core/recovery.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { OwnedJournal } from '../src/storage/owned-journal.js';
import { materializeRun } from '../src/domain/materialize.js';
import { RunService } from '../src/core/run-service.js';

async function fixture(startTurn: () => Promise<unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-codex-dispatch-'));
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db'));
  const lease = coordinator.acquireRun('run', 'host'), journal = new OwnedJournal(path.join(dir, 'events'), coordinator, lease);
  const fixtureRun = await SimulatedRun.create(templates.dev, defaultProject.policy, journal, new FakeAdapter());
  await fixtureRun.completeControl('start');
  const adapter = new CodexReadOnlyAdapter({ request: async () => startTurn() });
  return { coordinator, lease, journal, dispatch: new CodexReadOnlyDispatch(journal, adapter) };
}
test('read-only dispatch records intent and matching turn before completion', async () => {
  const f = await fixture(async () => ({ turn: { id: 'turn-1' } }));
  assert.equal(await f.dispatch.dispatch('plan', 'thread-1', 'inspect', 'low', 'attempt-1', 'request-1', true), 'turn-1');
  const pending = replayRun(await f.journal.read());
  assert.equal(pending.attempts[0]?.runnerTurnId, 'turn-1');
  await assert.rejects(f.dispatch.recordTerminal('attempt-1', 'thread-1', 'wrong', 'completed'), /does not match/);
  await assert.rejects(f.dispatch.recordTerminal('attempt-1', 'thread-1', 'turn-1', 'completed'), /Planning output/);
  await f.dispatch.recordTerminal('attempt-1', 'thread-1', 'turn-1', 'stopped');
  assert.equal(replayRun(await f.journal.read()).attempts[0]?.status, 'stopped');
  await f.journal.close(); f.coordinator.releaseRun(f.lease, true); f.coordinator.close();
});
test('uncertain dispatch is persisted and never retried automatically', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; throw new Error('lost connection'); });
  await assert.rejects(f.dispatch.dispatch('plan', 'thread-1', 'inspect', 'low', 'attempt-1', 'request-1', true), /lost connection/);
  assert.equal(replayRun(await f.journal.read()).attempts[0]?.receipt, 'unknown');
  await assert.rejects(f.dispatch.dispatch('plan', 'thread-1', 'inspect', 'low', 'attempt-2', 'request-2', true), /Reconcile/);
  assert.equal(calls, 1);
  await f.journal.close(); f.coordinator.releaseRun(f.lease, true); f.coordinator.close();
});

test('only the matching successful turn can supply the plan presented for approval', async () => {
  const f = await fixture(async () => ({ turn: { id: 'turn-plan' } }));
  await f.dispatch.dispatch('plan', 'thread-1', 'plan the task', 'low', 'attempt-1', 'request-1', true);
  const plan = { planId: 'p1', version: 1, goal: 'Add subtraction', scope: ['src'], approach: 'Implement subtraction',
    acceptanceCriteria: ['tests pass'], checks: ['make test'], riskChanges: [] };
  await assert.rejects(f.dispatch.recordPlan('attempt-1', { threadId: 'thread-1', turnId: 'other', status: 'completed', messages: [JSON.stringify(plan)] }), /does not match/);
  await f.dispatch.recordPlan('attempt-1', { threadId: 'thread-1', turnId: 'turn-plan', status: 'completed', messages: [JSON.stringify(plan)] });
  assert.deepEqual(replayRun(await f.journal.read()).plans[0]?.plan, plan);
  const recovered = await SimulatedRun.recover(f.journal, new FakeAdapter());
  await recovered.continueAfterRecovery();
  await assert.rejects(recovered.approve('approval', { ...plan, goal: 'Unrelated change' }, 'user'), /does not match proposed plan/);
  await recovered.approve('approval', plan, 'user');
  assert.equal(replayRun(await f.journal.read()).graph.nodes.implement?.status, 'ready');
  await f.journal.close(); f.coordinator.releaseRun(f.lease, true); f.coordinator.close();
});

test('materialized planning rejects unverified or mismatched bindings before writing dispatch intent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-bound-dispatch-'));
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db'));
  const lease = coordinator.acquireRun('run', 'host'), journal = new OwnedJournal(path.join(dir, 'events'), coordinator, lease);
  const role = { runner: 'codex', provider: 'openai', model: 'gpt-6-luna', reasoning: 'low' };
  const project = { ...defaultProject, roleDefaults: { implementer: role, verifier: role } };
  const profile = (id: string, write: boolean) => ({ schemaVersion: 1, profileId: id, version: 1, name: id, instructions: '', skills: [],
    requestedPermissions: { read: true, write, checks: true, gitCommit: false }, outputDefaults: {} });
  const snapshot = await materializeRun(templates.dev, project, { 'implementer@1': profile('implementer', true), 'verifier@1': profile('verifier', false) }, dir);
  const service = await RunService.createMaterialized(journal, snapshot);
  await service.completeControl('start');
  const adapter = new CodexReadOnlyAdapter({ request: async method => method === 'thread/start'
    ? { thread: { id: 'thread' }, model: role.model, modelProvider: role.provider, cwd: dir, approvalPolicy: 'never', sandbox: { type: 'readOnly' } }
    : { turn: { id: 'turn' } } });
  const dispatcher = new CodexReadOnlyDispatch(journal, adapter);
  await assert.rejects(service.dispatchReadOnly(dispatcher, 'plan', 'thread', 'plan', 'low', 'a', 'r'), /not been verified/);
  await adapter.startVerifiedThread(dir, role.model, role.provider);
  await assert.rejects(service.dispatchReadOnly(dispatcher, 'plan', 'thread', 'plan', 'high', 'a', 'r'), /Reasoning/);
  assert.equal(replayRun(await journal.read()).attempts.length, 0);
  assert.equal(await service.dispatchReadOnly(dispatcher, 'plan', 'thread', 'plan', 'low', 'a', 'r'), 'turn');
  await service.close(); await journal.close(); coordinator.releaseRun(lease, true); coordinator.close();
});
