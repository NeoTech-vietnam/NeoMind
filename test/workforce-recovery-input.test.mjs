import test from 'node:test';
import assert from 'node:assert/strict';
import * as workflow from '../dist/controlled-workflow.js';
import { hash } from '../dist/storage.js';
import { canonicalJson } from '../dist/routing.js';

const answer = { question_id: 'issued-question', question: 'Where should the firmware bundle be delivered?',
  answer: 'Deliver a local ZIP in the workspace; no external publication and no hardware verification claim.', at: '2026-11-07T11:04:33Z' };
function retained() {
  return { contract_hash: 'frozen-contract', request_id: 'same-request',
    workforce_recovery: { strategies: [{ checkpoint: 'before-answer', strategy: 'repair_product', kind: 'implementation' },
      { checkpoint: 'before-answer', strategy: 'diagnose', kind: 'unknown' }],
      no_progress: 2, strong_implementation: true, resolved_checks: [] } };
}

test('a newly confirmed substantive answer is new input for the no-progress watchdog, not invented check progress', () => {
  const run = retained(), history = structuredClone(run.workforce_recovery.strategies);
  run.answers = [answer];
  assert.deepEqual(workflow.workforceRecoveryDecision(run, 'implementation', 'new-confirmed-input-checkpoint', [], false),
    { allowed: true, strategy: 'repair_product', strong: false });
  assert.equal(run.workforce_recovery.no_progress, 0);
  assert.deepEqual(run.workforce_recovery.resolved_checks, []);
  assert.deepEqual(run.workforce_recovery.strategies, history);
  assert.equal(run.workforce_recovery.strong_implementation, true);
});

test('confirmed answer content changes the semantic checkpoint without changing no-answer historical checkpoints', () => {
  const run = retained();
  const before = workflow.workforceRecoveryCheckpoint(run, undefined, []);
  assert.equal(before, hash(canonicalJson({ contract: 'frozen-contract', condition: null, resolved: [] })), 'No-answer historical checkpoints retain their exact identity.');
  run.answers = [answer];
  const after = workflow.workforceRecoveryCheckpoint(run, undefined, []);
  assert.notEqual(after, before);
  run.answers = [{ ...answer, question_id: 'another-issued-id', at: 'later-time' }];
  assert.equal(workflow.workforceRecoveryCheckpoint(run, undefined, []), after, 'IDs/timestamps cannot manufacture new input.');
  run.answers.push({ ...answer, question_id: 'duplicate-question-id' });
  assert.equal(workflow.workforceRecoveryCheckpoint(run, undefined, []), after, 'Duplicate semantic answers cannot renew recovery.');
});

test('the same confirmed answer cannot renew a spent strategy or clear a later no-progress finding', () => {
  const run = retained(); run.answers = [answer];
  const checkpoint = workflow.workforceRecoveryCheckpoint(run, undefined, []);
  assert.equal(workflow.workforceRecoveryDecision(run, 'implementation', checkpoint, [], false).allowed, true);
  run.workforce_recovery.strategies.push({ checkpoint, strategy: 'repair_product', kind: 'implementation' });
  run.workforce_recovery.no_progress = 2;
  run.answers = [{ ...answer, question_id: 'new-id', at: 'new-time' }];
  assert.equal(workflow.workforceRecoveryDecision(run, 'implementation', checkpoint, [], false).allowed, false);
  assert.equal(run.workforce_recovery.no_progress, 2);
});

test('without newly confirmed input, unchanged repair exhaustion remains authoritative', () => {
  const run = retained();
  assert.equal(workflow.workforceRecoveryDecision(run, 'implementation', 'before-answer', [], false).allowed, false);
  assert.equal(run.workforce_recovery.no_progress, 2);
});
