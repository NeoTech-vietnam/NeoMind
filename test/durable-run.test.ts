import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DurableRun } from '../src/core/durable-run.js';
import { WorkspaceCoordinator } from '../src/storage/coordination.js';
import { RunStore } from '../src/storage/run-store.js';
import { templates, defaultProject } from '../src/domain/templates.js';

test('durable run excludes a live owner and requires explicit continuation after reopening', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neomind-durable-run-'));
  const store = await RunStore.open(dir), coordinator = new WorkspaceCoordinator(path.join(dir, 'db'));
  const run = await DurableRun.create(store, coordinator, 'run-1', templates.dev, defaultProject.policy);
  await run.service.completeControl('start');
  await assert.rejects(DurableRun.recover(store, coordinator, 'run-1'), /death is not verified/);
  await run.close(); await assert.rejects(run.service.report(), /closed/);
  const recovered = await DurableRun.recover(store, coordinator, 'run-1');
  assert.equal((await recovered.service.report()).userContinueRequired, true);
  await recovered.service.continueAfterRecovery();
  assert.equal((await recovered.service.report()).graph.nodes.plan?.status, 'ready');
  await recovered.close(); coordinator.close();
});
