import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, type ConditionFacts } from '../src/core/condition.js';
const facts: ConditionFacts = { nodes: { producer: { status: 'succeeded', outcome: 'completed' } }, incomingIds: ['producer'], checks: [{ command: 'make test', status: 'failed' }, { command: 'make test', status: 'passed' }], acceptedReviewCount: 1, repairRounds: 1 };
const node = { id: 'condition', label: 'Condition', type: 'condition' as const, field: 'result', operator: 'eq' as const, value: 'completed' };
test('conditions use durable allowlisted facts and latest check results', () => {
  assert.equal(evaluateCondition(node, facts), true);
  assert.equal(evaluateCondition({ ...node, field: 'checks.passed', value: true }, facts), true);
  assert.equal(evaluateCondition({ ...node, field: 'checks.results', operator: 'all' }, facts), true);
  assert.equal(evaluateCondition({ ...node, field: 'node.producer.outcome' }, facts), true);
  assert.equal(evaluateCondition({ ...node, field: 'result', operator: 'in', value: ['pass', 'completed'] }, facts), true);
  assert.throws(() => evaluateCondition({ ...node, field: '__proto__.status' }, facts), /Unsupported/);
  assert.throws(() => evaluateCondition({ ...node, operator: 'all' }, facts), /boolean array/);
});
