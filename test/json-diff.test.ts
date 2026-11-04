import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonChanges } from '../src/domain/json-diff.js';

test('structural version comparison reports nested changes, additions and removals in a bounded result', () => {
  const result = jsonChanges({ a: [1, { name: 'old' }], removed: true }, { a: [1, { name: 'new' }], added: false });
  assert.deepEqual(result.changes.map(change => change.path), ['a[1].name', 'added', 'removed']);
  assert.deepEqual(result.changes[0], { path: 'a[1].name', before: 'old', after: 'new' });
  const limited = jsonChanges({ a: 1, b: 2 }, { a: 2, b: 3 }, 1);
  assert.equal(limited.changes.length, 1); assert.equal(limited.truncated, true);
});
