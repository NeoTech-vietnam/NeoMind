import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlledObservationLoop } from '../dist/controlled-observation-loop.js';

const success = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const evidence = extra => [{ title: 'Independent scalar', passed: true, exit_code: 0,
  baseline: { 'src/value.txt': 'hash-one' }, finished_at: '2026-10-26T00:00:00Z', ...extra }];

test('a second unchanged successful evidence read gets a notice and a third gets reconciliation', () => {
  const guard = new ControlledObservationLoop(), result = success(evidence());
  assert.equal(guard.observe('check_evidence', {}, result, 'state-one'), undefined);
  const repeat = guard.observe('check_evidence', { kind: 'execution' }, result, 'state-one');
  assert.equal(repeat.kind, 'notice'); assert.equal(repeat.code, 'CONTROLLED_OBSERVATION_REPEAT');
  assert.equal(repeat.unchanged_observations, 2);
  assert.match(repeat.next_action, /explicit supported pass\/fail verdict/);
  assert.match(repeat.next_action, /blocked\/failed/);
  const third = guard.observe('check_evidence', {}, result, 'state-one');
  assert.equal(third.kind, 'reconcile'); assert.equal(third.code, 'CONTROLLED_OBSERVATION_LOOP');
  assert.match(third.next_action, /existing protocol recovery/);
  assert.deepEqual(result, success(evidence()), 'Observation never edits actual returned evidence.');
});

test('alternating already-read selectors cannot evade the successful observation guard', () => {
  const guard = new ControlledObservationLoop(), result = success(evidence());
  for (const title of ['check-A', 'check-B']) assert.equal(guard.observe('check_evidence', { title }, result, 'same'), undefined);
  for (const title of ['check-A', 'check-B']) assert.equal(guard.observe('check_evidence', { title }, result, 'same').kind, 'notice');
  const stop = guard.observe('check_evidence', { title: 'check-A' }, result, 'same');
  assert.equal(stop.kind, 'reconcile');
  assert.deepEqual(stop.already_read_selectors.map(selector => selector.title), ['check-A', 'check-B']);
});

test('execution selector trimming and ignored workflow/registration titles match the actual backend', () => {
  const result = success(evidence()), execution = new ControlledObservationLoop();
  assert.equal(execution.observe('check_evidence', { title: 'Independent scalar' }, result, 'same'), undefined);
  const notice = execution.observe('check_evidence', { kind: 'execution', title: '  Independent scalar  ' }, result, 'same');
  assert.equal(notice.kind, 'notice'); assert.deepEqual(notice.selector, { kind: 'execution', title: 'Independent scalar' });
  assert.equal(execution.observe('check_evidence', { title: 'Independent scalar ' }, result, 'same').kind, 'reconcile');
  for (const kind of ['workflow', 'registration']) {
    const guard = new ControlledObservationLoop();
    assert.equal(guard.observe('check_evidence', { kind, title: 'ignored-first-title' }, result, 'same'), undefined);
    const repeat = guard.observe('check_evidence', { kind, title: 'ignored-second-title' }, result, 'same');
    assert.equal(repeat.kind, 'notice'); assert.deepEqual(repeat.selector, { kind });
    assert.deepEqual(repeat.already_read_selectors, [{ kind }]);
    assert.equal(guard.observe('check_evidence', { kind }, result, 'same').kind, 'reconcile');
  }
});

test('new evidence, durable state and different selectors stay readable without treating changed facts as repeats', () => {
  const guard = new ControlledObservationLoop(), args = { title: 'Independent scalar' };
  assert.equal(guard.observe('check_evidence', args, success(evidence()), 'same'), undefined);
  assert.equal(guard.observe('check_evidence', args, success(evidence({ passed: false, exit_code: 1 })), 'same'), undefined);
  assert.equal(guard.observe('check_evidence', args, success(evidence({ baseline: { 'src/value.txt': 'hash-two' } })), 'same'), undefined);
  assert.equal(guard.observe('check_evidence', args, success(evidence()), 'new-durable-state'), undefined);
  assert.equal(guard.observe('check_evidence', { title: 'New intended-use check' }, success(evidence()), 'new-durable-state'), undefined);
  assert.equal(guard.observe('check_evidence', args, success(evidence()), 'new-durable-state').kind, 'notice');
  assert.equal(guard.observe('check_evidence', args, success(evidence({ finished_at: '2026-10-26T00:01:00Z' })), 'new-durable-state'), undefined,
    'A new real execution timestamp remains evidence, not volatile observation metadata.');
});

test('only workflow observation timestamps are normalized; actual evidence remains untouched', () => {
  const guard = new ControlledObservationLoop();
  const workflow = at => ({ kind: 'workflow', available: true, observed_at: at,
    preservation: { checked_at: at, baseline_captured_at: 'original', all_unchanged: true },
    state: { stage: 'review', workflow_status: 'running', revision: at }, checks: { positive_count: 1, negative_count: 1 } });
  const first = success(workflow('observation-one')), second = success(workflow('observation-two'));
  assert.equal(guard.observe('check_evidence', { kind: 'workflow' }, first, 'same'), undefined);
  assert.equal(guard.observe('check_evidence', { kind: 'workflow' }, second, 'same').kind, 'notice');
  const changed = workflow('observation-three'); changed.preservation.all_unchanged = false;
  assert.equal(guard.observe('check_evidence', { kind: 'workflow' }, success(changed), 'same'), undefined);
  assert.equal(JSON.parse(second.content[0].text).observed_at, 'observation-two');
  const other = new ControlledObservationLoop();
  assert.equal(other.observe('check_evidence', {}, success({ kind: 'execution', observed_at: 'real-first' }), 'same'), undefined);
  assert.equal(other.observe('check_evidence', {}, success({ kind: 'execution', observed_at: 'real-second' }), 'same'), undefined);
});

test('reads already requested in one model response cannot be stopped before its notice was delivered', () => {
  const guard = new ControlledObservationLoop(), result = success(evidence());
  assert.equal(guard.observe('check_evidence', {}, result, 'same', 1), undefined);
  assert.equal(guard.observe('check_evidence', {}, result, 'same', 1).kind, 'notice');
  assert.equal(guard.observe('check_evidence', {}, result, 'same', 1), undefined);
  assert.equal(guard.observe('check_evidence', {}, result, 'same', 2).kind, 'reconcile');
});

test('nested workflow-shaped receipt data keeps its timestamps and revisions as real new evidence', () => {
  const changedFields = [
    value => { value.observed_at = 'new-real-observation'; },
    value => { value.preservation.checked_at = 'new-real-check'; },
    value => { value.state.revision = 2; },
  ];
  for (const mutate of changedFields) for (const wrap of [value => [{ receipt: value }], value => ({ receipt: value }), value => [value]]) {
    const guard = new ControlledObservationLoop(), original = { kind: 'workflow', observed_at: 'original',
      preservation: { checked_at: 'original' }, state: { revision: 1 } };
    const changed = structuredClone(original); mutate(changed);
    assert.equal(guard.observe('check_evidence', {}, success(wrap(original)), 'same'), undefined);
    assert.equal(guard.observe('check_evidence', {}, success(wrap(changed)), 'same'), undefined,
      'Only the actual top-level workflow context has volatile observation fields.');
  }
});

test('failed reads and mutation tools retain their existing behavior and do not become successful observations', () => {
  const guard = new ControlledObservationLoop(), result = success(evidence());
  for (const tool of ['task_run', 'task_file_write', 'check_run', 'assignment_report', 'runtime_context', 'project_read'])
    for (let count = 0; count < 4; count++) assert.equal(guard.observe(tool, {}, result, 'same'), undefined);
  const failed = { isError: true, content: [{ type: 'text', text: '{"code":"NO_CHECK_EVIDENCE"}' }] };
  for (let count = 0; count < 4; count++) assert.equal(guard.observe('check_evidence', {}, failed, 'same'), undefined);
  assert.equal(guard.observe('check_evidence', {}, result, 'same'), undefined);
  assert.equal(guard.observe('check_evidence', {}, result, 'same').kind, 'notice');
});

test('diagnostic selector summaries remain bounded and redact obvious credentials', () => {
  const guard = new ControlledObservationLoop(), args = { title: 'Credentials Bearer SECRET_OBSERVATION', kind: 'execution' };
  const result = success(evidence());
  guard.observe('check_evidence', args, result, 'same');
  const notice = guard.observe('check_evidence', args, result, 'same');
  assert.doesNotMatch(JSON.stringify(notice), /SECRET_OBSERVATION/);
  for (let index = 0; index < 20; index++) guard.observe('check_evidence', { title: `check-${index}` }, result, 'same');
  assert.ok(guard.observe('check_evidence', args, result, 'same').already_read_selectors.length <= 8);
});
