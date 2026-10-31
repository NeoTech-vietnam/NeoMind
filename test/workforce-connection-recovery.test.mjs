import test from 'node:test';
import assert from 'node:assert/strict';
import { workForceConnectionProofSatisfies, groupWorkForceConnectionEndpoints } from '../dist/workforce-connection.js';

test('connection preparation shares only identical provider, endpoint and credentials while retaining every alias', () => {
  const top = { provider: 'fixture', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key-one', model: 'top-models' };
  const endpoints = [top, { ...top, model: 'worker-models' }, { ...top, apiKey: 'fixture-key-two' },
    { ...top, baseURL: 'http://127.0.0.1:2/v1' }, { ...top, provider: 'another-provider' }, { ...top, apiKey: undefined },
    { ...top, apiKey: undefined, model: 'worker-models' }, { ...top, apiKey: '' }];
  const before = structuredClone(endpoints), groups = groupWorkForceConnectionEndpoints(endpoints);
  assert.deepEqual(groups.map(group => group.map(endpoint => endpoints.indexOf(endpoint))), [[0, 1], [2], [3], [4], [5, 6], [7]]);
  assert.deepEqual(endpoints, before, 'Grouping preserves original route definitions.');
  assert.equal(groups.flat().length, endpoints.length);
  assert.deepEqual(groupWorkForceConnectionEndpoints([]), []);
});

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
