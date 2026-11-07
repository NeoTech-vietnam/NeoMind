import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionCheckBudget } from '../dist/workforce-connection-budget.js';

test('local preparation time does not consume the actual model tool-call deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createConnectionCheckBudget();
  t.after(() => budget.dispose());
  t.mock.timers.tick(110000);
  assert.equal(budget.signal.aborted, false);
  budget.beginModelCheck();
  t.mock.timers.tick(119999);
  assert.equal(budget.signal.aborted, false, 'A prepared engine retains the full existing model-check budget.');
  t.mock.timers.tick(1);
  assert.equal(budget.signal.aborted, true);
  assert.match(budget.signal.reason.message, /^WORKFORCE_MODEL_CHECK_TIMEOUT:/);
});

test('a preparation timeout identifies the local phase before any provider call', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createConnectionCheckBudget();
  t.after(() => budget.dispose());
  t.mock.timers.tick(120000);
  assert.equal(budget.signal.aborted, true);
  assert.match(budget.signal.reason.message, /^WORKFORCE_ENGINE_PREPARATION_TIMEOUT:.*no model request/);
  assert.throws(() => budget.beginModelCheck(), /PREPARATION_TIMEOUT/);
});

test('repeated phase entry cannot renew a failing model-check deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createConnectionCheckBudget();
  t.after(() => budget.dispose());
  budget.beginModelCheck();
  t.mock.timers.tick(119999);
  assert.throws(() => budget.beginModelCheck(), /cannot restart/);
  t.mock.timers.tick(1);
  assert.equal(budget.signal.aborted, true);
});

for (const stage of ['preparation', 'model']) test(`explicit cancellation stops the ${stage} phase with its original reason`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new AbortController(), reason = new Error('User cancelled the connection');
  const budget = createConnectionCheckBudget(owner.signal);
  if (stage === 'model') budget.beginModelCheck();
  owner.abort(reason);
  t.mock.timers.tick(240000);
  assert.equal(budget.signal.reason, reason);
  budget.dispose();
});

test('disposal prevents a completed connection being aborted by a late phase timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createConnectionCheckBudget();
  budget.beginModelCheck(); budget.dispose(); budget.dispose();
  t.mock.timers.tick(240000);
  assert.equal(budget.signal.aborted, false);
  assert.throws(() => budget.beginModelCheck(), /cannot restart/);
});
