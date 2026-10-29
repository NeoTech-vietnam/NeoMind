import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RunService } from '../src/core/run-service.js';
import { CodexReadOnlyDispatch } from '../src/core/codex-readonly-dispatch.js';
import { CodexReadOnlyAdapter } from '../src/adapters/codex-readonly.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { OwnedJournal } from '../src/storage/owned-journal.js';

test('run service approves only the recorded plan and requires continuation after recovery', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-run-service-'));
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db'));
  const lease = coordinator.acquireRun('run', 'host'), journal = new OwnedJournal(path.join(dir, 'events'), coordinator, lease);
  const service = await RunService.create(journal, templates.dev, defaultProject.policy);
  await service.completeControl('start');
  await assert.rejects(service.approveProposedPlan('approval', 'plan', 'user', 'ui'), /No persisted plan/);
  const adapter = new CodexReadOnlyAdapter({ request: async () => ({ turn: { id: 'turn' } }) });
  const dispatch = new CodexReadOnlyDispatch(journal, adapter);
  await service.dispatchReadOnly(dispatch, 'plan', 'thread', 'plan the task', 'low', 'attempt', 'request');
  const plan = { planId: 'p1', version: 1, goal: 'Subtract', scope: ['src'], approach: 'Implement',
    acceptanceCriteria: ['tests pass'], checks: ['make test'], riskChanges: [] };
  await service.recordReadOnlyPlan(dispatch, 'attempt', { threadId: 'thread', turnId: 'turn', status: 'completed', messages: [JSON.stringify(plan)] });
  const recovered = await RunService.recover(journal);
  await assert.rejects(recovered.approveProposedPlan('approval', 'plan', 'user', 'ui'), /continuation/);
  await recovered.continueAfterRecovery();
  await recovered.approveProposedPlan('approval', 'plan', 'user', 'ui');
  assert.equal((await recovered.report()).graph.nodes.implement?.status, 'ready');
  await journal.close(); coordinator.releaseRun(lease, true); coordinator.close();
});

test('recovery finalizes durable planning output without rerunning the agent', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const dir = mkdtempSync(path.join(tmpdir(), 'neomind-plan-recovery-'));
  const coordinator = new WorkspaceCoordinator(path.join(dir, 'db')), lease = coordinator.acquireRun('run', 'host');
  const file = path.join(dir, 'events'), journal = new OwnedJournal(file, coordinator, lease);
  const service = await RunService.create(journal, templates.dev, defaultProject.policy); await service.completeControl('start');
  let calls = 0;
  const dispatch = new CodexReadOnlyDispatch(journal, new CodexReadOnlyAdapter({ request: async () => { calls++; return { turn: { id: 'turn' } }; } }));
  await service.dispatchReadOnly(dispatch, 'plan', 'thread', 'plan', 'low', 'attempt', 'request');
  const plan = { planId: 'p', version: 1, goal: 'test', scope: ['.'], approach: 'edit', acceptanceCriteria: ['done'], checks: [], riskChanges: [] };
  await service.recordReadOnlyPlan(dispatch, 'attempt', { threadId: 'thread', turnId: 'turn', status: 'completed', messages: [JSON.stringify(plan)] });
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n'); lines.pop();
  await writeFile(file, lines.join('\n') + '\n'); // fixture simulates crash before node_completed
  const recovered = await RunService.recover(journal); await recovered.continueAfterRecovery();
  assert.equal((await recovered.report()).graph.nodes.plan?.status, 'running');
  await recovered.finalizePersisted('plan');
  assert.equal((await recovered.report()).graph.nodes.approval?.status, 'ready'); assert.equal(calls, 1);
  await journal.close(); coordinator.releaseRun(lease, true); coordinator.close();
});
