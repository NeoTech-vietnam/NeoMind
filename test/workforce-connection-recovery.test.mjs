import test from 'node:test';
import assert from 'node:assert/strict';
import { workForceConnectionProofSatisfies } from '../dist/workforce-connection.js';

test('cached model success is reused for setup but cannot establish restoration after a newer provider incident', () => {
  const prior = { valid: true, checked_at: '2026-10-28T10:00:00.000Z', models: ['top-models', 'worker-models'] };
  assert.equal(workForceConnectionProofSatisfies(prior), true);
  const options = { not_before: '2026-10-28T10:01:00.000Z' };
  assert.equal(workForceConnectionProofSatisfies(prior, options), false);
  assert.equal(workForceConnectionProofSatisfies({ ...prior, checked_at: options.not_before }, options), false);
  assert.equal(workForceConnectionProofSatisfies({ ...prior, checked_at: '2026-10-28T10:02:00.000Z' }, options), true);
  assert.equal(workForceConnectionProofSatisfies({ valid: false }, options), false);
  assert.equal(workForceConnectionProofSatisfies({ valid: true }, options), false);
  assert.throws(() => workForceConnectionProofSatisfies(prior, { not_before: 'invented' }), /incident timestamp/);
});
