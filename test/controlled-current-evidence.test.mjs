import test from 'node:test';
import assert from 'node:assert/strict';
import { currentControlledChecks } from '../dist/controlled-workflow.js';

test('current evidence excludes identical-title historical failures before any title or display limit', () => {
  const run = { attempts: [{ id: 'old', stage: 'verification', state: 'completed' },
    { id: 'producer-repair', stage: 'implementation', state: 'completed' }, { id: 'current', stage: 'verification', state: 'completed' }],
  checks: [...Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}`, attempt_id: 'old', title: 'Identical check title', passed: false })),
    ...Array.from({ length: 10 }, (_, index) => ({ id: `current-${index}`, attempt_id: 'current', title: 'Identical check title', passed: true }))] };
  const before = structuredClone(run), current = currentControlledChecks(run);
  assert.equal(current.length, 10); assert.ok(current.every(check => check.passed));
  assert.equal(current.some(check => check.id.startsWith('old-')), false);
  assert.deepEqual(run, before, 'Selecting current results cannot rewrite the thirty saved observations.');
});

test('a new Verifier with no evidence never falls back to older completed receipts, regardless of attempt state', () => {
  for (const state of ['starting', 'running', 'completed', 'interrupted']) {
    const run = { attempts: [{ id: 'old', stage: 'verification', state: 'completed' }, { id: 'new', stage: 'verification', state },
      { id: 'review', stage: 'review', state: 'running', purpose: 'check-review' }],
    checks: [{ id: 'old-pass', attempt_id: 'old', passed: true }] };
    assert.deepEqual(currentControlledChecks(run), [], state);
    run.checks.push({ id: 'new-failure', attempt_id: 'new', passed: false });
    assert.deepEqual(currentControlledChecks(run).map(check => check.id), ['new-failure'], 'Diagnosis sees the newest failed check, not an older success.');
  }
  assert.deepEqual(currentControlledChecks({ attempts: [], checks: [] }), []);
});
