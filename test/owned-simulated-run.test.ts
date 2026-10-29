import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { OwnedSimulatedRun } from '../src/core/owned-simulated-run.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { defaultProject, templates } from '../src/domain/templates.js';

test('owned simulated run excludes another host and requires explicit continuation after recovery', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-owned-run-'));
  const db = path.join(dir, 'coordination.sqlite'), journal = path.join(dir, 'run.jsonl');
  const first = new WorkspaceCoordinator(db), second = new WorkspaceCoordinator(db), adapter = new FakeAdapter();
  const run = await OwnedSimulatedRun.create(first, 'run-a', 'host-a', journal, templates.dev, defaultProject.policy, adapter);
  await assert.rejects(OwnedSimulatedRun.recover(second, 'run-a', 'host-b', journal, adapter), /already has an owner/);
  const attempts = await Promise.allSettled([run.completeControl('start'), run.completeControl('start')]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
  await run.close();
  await assert.rejects(run.report(), /closing/);
  const recovered = await OwnedSimulatedRun.recover(second, 'run-a', 'host-b', journal, adapter);
  await assert.rejects(recovered.completeControl('start'), /explicitly continue/);
  await recovered.continueAfterRecovery();
  assert.equal((await recovered.report()).graph.nodes.plan?.status, 'ready');
  await recovered.close(); first.close(); second.close();
});
