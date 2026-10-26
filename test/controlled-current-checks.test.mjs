import test from 'node:test';
import assert from 'node:assert/strict';
import { latestControlledChecks, controlledCheckMatches } from '../dist/controlled-current-checks.js';
import { currentControlledChecks } from '../dist/controlled-workflow.js';

const expected = { title: 'Positive', negative: false, command: ['node', 'checks/check.cjs'], expected_exit_code: 0 };
const receipt = (id, extra = {}) => ({ id, attempt_id: 'verifier-one', title: 'Positive', negative: false,
  command: ['node', 'checks/check.cjs'], expected_exit_code: 0, passed: true, baseline: { 'checks/check.cjs': 'baseline-B' }, ...extra });

test('current checks select a later checked baseline while keeping every failed historical receipt untouched', () => {
  const failed = receipt('failed-A', { passed: false, baseline: { 'checks/check.cjs': 'baseline-A' } });
  const passed = receipt('passed-B'), checks = [failed, passed], before = structuredClone(checks);
  assert.deepEqual(latestControlledChecks(checks, 'verifier-one').map(item => item.id), ['passed-B']);
  assert.deepEqual(checks, before);
  assert.deepEqual(currentControlledChecks({ checks, attempts: [{ id: 'verifier-one', stage: 'verification' }] }), [passed]);
});

test('a newer failure, cancellation or invalid identity always shadows an older passing receipt', () => {
  for (const changed of [{ passed: false }, { passed: false, cancelled: true }, { negative: true },
    { command: ['node', 'checks/other.cjs'] }, { expected_exit_code: 1 }]) {
    const current = receipt('newer', changed), selected = latestControlledChecks([receipt('old-pass'), current], 'verifier-one');
    assert.deepEqual(selected, [current]);
    if (changed.negative || changed.command || changed.expected_exit_code)
      assert.equal(controlledCheckMatches(selected[0], expected), false);
    else assert.equal(selected[0].passed, false);
  }
});

test('selection is per attempt and frozen title, using append order rather than claimed timestamps or passed status', () => {
  const checks = [receipt('first', { at: '2099-01-01' }), receipt('negative', { title: 'Negative', negative: true }),
    receipt('other-attempt', { attempt_id: 'verifier-two', passed: false }), receipt('last', { at: '2000-01-01', passed: false })];
  assert.deepEqual(latestControlledChecks(checks, 'verifier-one').map(item => item.id), ['last', 'negative']);
  assert.deepEqual(latestControlledChecks(checks, 'verifier-two').map(item => item.id), ['other-attempt']);
  assert.deepEqual(latestControlledChecks(checks, 'unknown'), []);
});

test('planned adapter argv retains exact identity matching without making baseline freshness a selector decision', () => {
  const check = receipt('adapted', { command: [...expected.command, '--runtime-pilot', 'owned'], planned_command: expected.command });
  assert.equal(controlledCheckMatches(check, expected), true);
  assert.equal(controlledCheckMatches({ ...check, planned_command: ['node', 'different.cjs'] }, expected), false);
  const stale = receipt('stale-current', { baseline: { 'checks/check.cjs': 'no-longer-current' } });
  assert.deepEqual(latestControlledChecks([receipt('old'), stale], 'verifier-one'), [stale],
    'The fresh authority must reject this baseline; selector cannot fall through to any older receipt.');
});
