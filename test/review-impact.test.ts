import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReviewersForChanges } from '../src/core/review-impact.js';
const reviewers = [{ id: 'ui', required: true, scopes: ['ui'] }, { id: 'core', required: true, scopes: ['src/core'] },
  { id: 'advisor', required: false, scopes: ['docs'] }];
test('reverification targets affected scopes and earlier finding owners', () => {
  assert.deepEqual(selectReviewersForChanges(reviewers, ['ui/form.ts'], ['advisor'], true), { reviewerIds: ['ui', 'advisor'], reason: 'scoped' });
});
test('uncertain impact reruns every required reviewer and prior finding owners', () => {
  assert.deepEqual(selectReviewersForChanges(reviewers, null, ['advisor'], false), { reviewerIds: ['ui', 'core', 'advisor'], reason: 'unknown-impact' });
  assert.deepEqual(selectReviewersForChanges(reviewers, ['ui/file'], [], false), { reviewerIds: ['ui', 'core'], reason: 'unknown-impact' });
  assert.deepEqual(selectReviewersForChanges(reviewers, ['other/file'], [], true), { reviewerIds: ['ui', 'core'], reason: 'unknown-impact' });
  assert.deepEqual(selectReviewersForChanges(reviewers, ['../escape'], [], true), { reviewerIds: ['ui', 'core'], reason: 'unknown-impact' });
});
test('dependency, build, CI and NeoMind files make impact shared', async () => {
  const { sharedImpactPaths } = await import('../src/core/review-impact.js');
  assert.deepEqual(sharedImpactPaths(['src/a.ts', 'package.json', 'web/pnpm-lock.yaml', 'tsconfig.build.json', 'vite.config.ts', '.github/workflows/ci.yml', '.neomind/project.json', 'docs/guide.md']),
    ['package.json', 'web/pnpm-lock.yaml', 'tsconfig.build.json', 'vite.config.ts', '.github/workflows/ci.yml', '.neomind/project.json']);
  assert.deepEqual(sharedImpactPaths(['src/config.ts', 'README.md']), []);
});
