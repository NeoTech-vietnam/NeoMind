import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRun } from '../src/core/recovery.js';
import { templates, defaultProject } from '../src/domain/templates.js';
import type { RunEvent } from '../src/storage/journal.js';
import { z } from 'zod';
import { recordApproval } from '../src/domain/approval.js';

function event(sequence: number, type: string, payload: RunEvent['payload'], requestId = `r${sequence}`): RunEvent {
  return { schemaVersion: 1, eventId: `e${sequence}`, runId: 'run1', sequence, requestId,
    type, timestamp: '2026-10-28T00:00:00Z', payload };
}

const initial = () => [event(1, 'run_created', z.json().parse(JSON.parse(JSON.stringify({ flow: templates.dev, policy: defaultProject.policy })))),
  event(2, 'node_claimed', { nodeId: 'start' }), event(3, 'node_completed', { nodeId: 'start', outcome: 'completed' }),
  event(4, 'node_claimed', { nodeId: 'plan' })];

test('recovery reports missing dispatch receipt without replaying a request', () => {
  const events = [...initial(), event(5, 'dispatch_intent', { nodeId: 'plan', attemptId: 'a1', sessionId: 's1' }, 'request1')];
  const result = replayRun(events);
  assert.deepEqual(result.unresolvedAttemptIds, ['a1']);
  assert.equal(result.attempts[0]?.receipt, 'missing');
  assert.equal(result.graph.nodes.plan?.status, 'running');
  assert.equal(result.requiresUserContinue, true);
  assert.deepEqual(replayRun(events), result);
  assert.throws(() => replayRun([...events, event(6, 'node_completed', { nodeId: 'plan', outcome: 'completed' })]), /unresolved attempts/);
});

test('accepted dispatch remains unresolved until a verified attempt result is recorded', () => {
  const events = [...initial(), event(5, 'dispatch_intent', { nodeId: 'plan', attemptId: 'a1', sessionId: 's1' }, 'request1'),
    event(6, 'dispatch_receipt', { attemptId: 'a1', status: 'accepted' }, 'request1')];
  assert.deepEqual(replayRun(events).unresolvedAttemptIds, ['a1']);
  const completed = [...events, event(7, 'attempt_finished', { attemptId: 'a1', status: 'completed' }),
    event(8, 'node_completed', { nodeId: 'plan', outcome: 'completed' })];
  const recovered = replayRun(completed);
  assert.deepEqual(recovered.unresolvedAttemptIds, []);
  assert.equal(recovered.graph.nodes.approval?.status, 'ready');
  assert.equal(recovered.requiresUserContinue, true);
});

test('recovery rejects duplicate requests and unknown event types', () => {
  const events = [...initial(), event(5, 'dispatch_intent', { nodeId: 'plan', attemptId: 'a1', sessionId: 's1' }, 'request1')];
  assert.throws(() => replayRun([...events, event(6, 'dispatch_intent', { nodeId: 'plan', attemptId: 'a2', sessionId: 's1' }, 'request1')]), /Duplicate/);
  assert.throws(() => replayRun([...events, event(6, 'future_event', {})]), /Unknown run event/);
});

test('recovery rejects tampered sequences and fabricated agent completion', () => {
  const events = initial();
  assert.throws(() => replayRun([...events, event(7, 'node_completed', { nodeId: 'plan', outcome: 'completed' })]), /sequence/);
  assert.throws(() => replayRun([...events, event(5, 'node_completed', { nodeId: 'plan', outcome: 'completed' })]), /without a completed attempt/);
});

test('recovery cannot pass an approval node without a matching user approval record', () => {
  const events = [...initial(), event(5, 'dispatch_intent', { nodeId: 'plan', attemptId: 'a1', sessionId: 's1' }, 'request1'),
    event(6, 'dispatch_receipt', { attemptId: 'a1', status: 'accepted' }, 'request1'),
    event(7, 'attempt_finished', { attemptId: 'a1', status: 'completed' }),
    event(8, 'node_completed', { nodeId: 'plan', outcome: 'completed' }),
    event(9, 'node_claimed', { nodeId: 'approval' })];
  assert.throws(() => replayRun([...events, event(10, 'node_completed', { nodeId: 'approval', outcome: 'pass' })]), /without a matching user approval/);
  const plan = { planId: 'p1', version: 1, goal: 'Implement', scope: ['src'], approach: 'Add feature',
    acceptanceCriteria: ['Checks pass'], checks: ['npm test'], riskChanges: [] };
  const approval = recordApproval(plan, defaultProject.policy, { approvalId: 'approval1', actor: 'user', source: 'ui',
    decision: 'approved', timestamp: '2026-10-28T00:00:00Z' });
  const record = z.json().parse(JSON.parse(JSON.stringify({ nodeId: 'approval', plan, approval })));
  const approved = [...events, event(10, 'approval_recorded', record), event(11, 'node_completed', { nodeId: 'approval', outcome: 'pass' })];
  const recovered = replayRun(approved);
  assert.equal(recovered.graph.nodes.implement?.status, 'ready');
  assert.throws(() => replayRun([...approved, event(12, 'node_claimed', { nodeId: 'implement', writeScopes: ['docs'] })]), /outside the approved scope/);
  assert.throws(() => replayRun([...approved, event(12, 'node_claimed', { nodeId: 'implement', writeScopes: ['../src'] })]), /valid declared scope/);
  const implemented = [...approved, event(12, 'node_claimed', { nodeId: 'implement', writeScopes: ['src/app.ts'] }),
    event(13, 'dispatch_intent', { nodeId: 'implement', attemptId: 'a2', sessionId: 's1' }, 'request2'),
    event(14, 'dispatch_receipt', { attemptId: 'a2', status: 'accepted' }, 'request2'),
    event(15, 'attempt_finished', { attemptId: 'a2', status: 'completed', baselineHash: 'baseline' }),
    event(16, 'node_completed', { nodeId: 'implement', outcome: 'completed' }),
    event(17, 'node_claimed', { nodeId: 'repair' }), event(18, 'node_completed', { nodeId: 'repair', outcome: 'completed' }),
    event(19, 'node_claimed', { nodeId: 'verify' })];
  assert.throws(() => replayRun([...implemented, event(20, 'node_completed', { nodeId: 'verify', outcome: 'pass' })]), /without accepted review evidence/);
  const review = { nodeId: 'verify', baselineHash: 'baseline', producerSessionId: 's1',
    results: [{ reviewerId: 'required-reviewer', sessionId: 's2', baselineHash: 'baseline', verdict: 'pass', findingIds: [] }],
    assessments: { 'required-reviewer': { evidenceValidated: true, criteriaCovered: true, verifiedFindingIds: [],
      unresolvedDisagreement: false, mandatoryCriteriaFailed: false } } };
  const reviewEvent = z.json().parse(JSON.parse(JSON.stringify(review)));
  const verified = replayRun([...implemented, event(20, 'review_accepted', reviewEvent), event(21, 'node_completed', { nodeId: 'verify', outcome: 'pass' })]);
  assert.equal(verified.graph.nodes.commit?.status, 'ready');
  const committed = [...implemented, event(20, 'review_accepted', reviewEvent), event(21, 'node_completed', { nodeId: 'verify', outcome: 'pass' }),
    event(22, 'node_claimed', { nodeId: 'commit' })];
  assert.throws(() => replayRun([...committed, event(23, 'node_completed', { nodeId: 'commit', outcome: 'completed' })]), /without a matching commit receipt/);
  const oid = 'a'.repeat(40), tree = 'b'.repeat(40), commit = 'c'.repeat(40);
  const intent = event(23, 'git_commit_intent', { nodeId: 'commit', reviewNodeId: 'verify', baselineHash: 'baseline', expectedParent: oid, expectedTree: tree }, 'git-request');
  assert.deepEqual(replayRun([...committed, intent]).unresolvedCommitNodeIds, ['commit']);
  const receipt = event(24, 'git_commit_receipt', { nodeId: 'commit', baselineHash: 'baseline', parent: oid, tree, commit }, 'git-request');
  const done = replayRun([...committed, intent, receipt, event(25, 'node_completed', { nodeId: 'commit', outcome: 'completed' })]);
  assert.deepEqual(done.unresolvedCommitNodeIds, []);
  assert.equal(done.graph.nodes.finish?.status, 'ready');
});
