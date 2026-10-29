import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReviews, type ReviewAssessment, type ReviewerResult } from '../src/core/review.js';

const specs = [{ id: 'one', required: true }, { id: 'two', required: true }, { id: 'advice', required: false }];
const assessment: ReviewAssessment = { evidenceValidated: true, criteriaCovered: true, verifiedFindingIds: [],
  unresolvedDisagreement: false, mandatoryCriteriaFailed: false };
const result = (reviewerId: string, verdict: ReviewerResult['verdict'] = 'pass'): ReviewerResult =>
  ({ reviewerId, sessionId: `session-${reviewerId}`, baselineHash: 'baseline1', verdict, findingIds: [] });
const checks = () => ({ one: { ...assessment }, two: { ...assessment }, advice: { ...assessment } });

test('all required reviewers need independently verified results against the same baseline', () => {
  assert.equal(evaluateReviews(specs, [result('one')], checks(), 'baseline1', 'producer').decision, 'waiting');
  const stale = { ...result('two'), baselineHash: 'old' };
  assert.equal(evaluateReviews(specs, [result('one'), stale], checks(), 'baseline1', 'producer').decision, 'waiting');
  const c = checks(); c.two.evidenceValidated = false;
  assert.equal(evaluateReviews(specs, [result('one'), result('two')], c, 'baseline1', 'producer').decision, 'waiting');
  assert.deepEqual(evaluateReviews(specs, [result('one'), result('two')], checks(), 'baseline1', 'producer'), { decision: 'pass', advisoryFindingIds: [] });
  assert.throws(() => evaluateReviews(specs, [{ ...result('one'), sessionId: 'producer' }], checks(), 'baseline1', 'producer'), /different session/);
});

test('verified required findings request repair; unverified findings or disagreement wait', () => {
  const changed = { ...result('two', 'needs_changes'), findingIds: ['bug1'] };
  const c = checks(); c.two.verifiedFindingIds = ['bug1'];
  assert.deepEqual(evaluateReviews(specs, [result('one'), changed], c, 'baseline1', 'producer'), { decision: 'needs_changes', findingIds: ['bug1'] });
  c.two.unresolvedDisagreement = true;
  assert.equal(evaluateReviews(specs, [result('one'), changed], c, 'baseline1', 'producer').decision, 'waiting');
  c.two.unresolvedDisagreement = false; c.two.verifiedFindingIds = [];
  assert.equal(evaluateReviews(specs, [result('one'), changed], c, 'baseline1', 'producer').decision, 'waiting');
});

test('advisory findings are retained without silently bypassing mandatory criteria', () => {
  const advice = { ...result('advice', 'needs_changes'), findingIds: ['style'] };
  const c = checks(); c.advice.verifiedFindingIds = ['style'];
  assert.deepEqual(evaluateReviews(specs, [result('one'), result('two'), advice], c, 'baseline1', 'producer'),
    { decision: 'pass', advisoryFindingIds: ['style'] });
  c.advice.mandatoryCriteriaFailed = true;
  assert.deepEqual(evaluateReviews(specs, [result('one'), result('two'), advice], c, 'baseline1', 'producer'),
    { decision: 'needs_changes', findingIds: ['style'] });
});
