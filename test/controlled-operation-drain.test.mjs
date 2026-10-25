import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlledOperationDrain } from '../dist/controlled-operation-drain.js';

test('shutdown waits for domain persistence even after its transport delivery has already cancelled', async () => {
  const drain = new ControlledOperationDrain();
  let release, persisted = false, closed = false;
  const cancelledDelivery = Promise.reject(new Error('Transport request aborted.')).catch(() => {});
  const actual = drain.run('workflow', async () => {
    await new Promise(resolve => { release = resolve; });
    persisted = true; return { cancelled: true, evidence: 'durable-failed-check' };
  });
  await cancelledDelivery;
  const closing = drain.drain('workflow').then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(persisted, false);
  assert.deepEqual(drain.workflows(), ['workflow']);
  release();
  assert.deepEqual(await actual, { cancelled: true, evidence: 'durable-failed-check' });
  await closing; assert.equal(persisted, true); assert.equal(closed, true); assert.deepEqual(drain.workflows(), []);
});

test('workflow drains remain isolated and failed domain operations settle without leaking pending ownership', async () => {
  const drain = new ControlledOperationDrain(); let release;
  const held = drain.run('other-workflow', () => new Promise(resolve => { release = resolve; }));
  const failure = drain.run('failed-workflow', async () => { throw new Error('Persistence failed; no success is claimed.'); });
  await assert.rejects(failure, /Persistence failed/);
  await drain.drain('failed-workflow');
  assert.deepEqual(drain.workflows(), ['other-workflow']);
  release(); await held; await drain.drain('other-workflow'); assert.deepEqual(drain.workflows(), []);
});
