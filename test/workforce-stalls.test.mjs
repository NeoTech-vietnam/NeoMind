import test from 'node:test';
import assert from 'node:assert/strict';
import { workforceProviderStallDecision } from '../dist/workforce-stalls.js';

test('fresh transport observations cannot rearm an unchanged strong-model task forever', () => {
  let history = [];
  const input = { checkpoint: 'same-actual-products-and-checks', model: 'top-models', can_escalate: false, at: '2026-10-28T12:00:00Z' };
  const next = id => { const value = workforceProviderStallDecision(history, { ...input, invocation_id: id }); history = value.history; return value; };
  assert.equal(next('one').action, 'retry-provider');
  assert.equal(next('one').replayed, true); assert.equal(history[0].attempts.length, 1);
  assert.equal(next('two').action, 'diagnose');
  assert.equal(next('three').action, 'incident');
  assert.equal(next('four').action, 'incident');
  assert.equal(workforceProviderStallDecision(history, { ...input, checkpoint: 'new-actual-product-baseline', invocation_id: 'five' }).action, 'retry-provider');
});

test('a stalled worker gets its configured strong route before diagnosis, preserving prior decisions', () => {
  const input = { checkpoint: 'fixed-scope', invocation_id: 'worker', model: 'worker-models', can_escalate: true, at: 'now' };
  const first = workforceProviderStallDecision([], input); assert.equal(first.action, 'escalate');
  const second = workforceProviderStallDecision(first.history, { ...input, invocation_id: 'strong', model: 'top-models', can_escalate: false });
  assert.equal(second.action, 'retry-provider'); assert.equal(first.history[0].attempts.length, 1);
  const third = workforceProviderStallDecision(second.history, { ...input, invocation_id: 'strong-again', model: 'top-models', can_escalate: false });
  assert.equal(third.action, 'diagnose');
});
