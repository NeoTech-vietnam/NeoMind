import test from 'node:test';
import assert from 'node:assert/strict';
import { currentControlledChecks, currentControlledCornellChecks } from '../dist/controlled-workflow.js';

test('producer repairs can diagnose old checks without binding them as fresh Cornell observations', () => {
  const run = { attempts: [{ id: 'producer', stage: 'implementation', state: 'completed' },
    { id: 'verifier', stage: 'verification', state: 'completed' }],
    checks: [{ id: 'prior-positive', attempt_id: 'verifier', passed: true }] };
  assert.deepEqual(currentControlledCornellChecks(run), run.checks);
  run.attempts.push({ id: 'repair', stage: 'implementation', state: 'running' });
  const before = structuredClone(run);
  assert.deepEqual(currentControlledChecks(run), run.checks, 'Debugger retains diagnostic evidence.');
  assert.deepEqual(currentControlledCornellChecks(run), [], 'New primary notes cannot borrow a prior producer generation.');
  assert.deepEqual(run, before);
  run.attempts.push({ id: 'fresh', stage: 'verification', state: 'running' });
  assert.deepEqual(currentControlledCornellChecks(run), []);
  run.checks.push({ id: 'fresh-positive', attempt_id: 'fresh', passed: true });
  assert.deepEqual(currentControlledCornellChecks(run).map(item => item.id), ['fresh-positive']);
});

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
