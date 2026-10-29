import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphScheduler } from '../src/core/graph-scheduler.js';
import { flowSchema, type Flow } from '../src/domain/schema.js';
import { defaultProject, templates } from '../src/domain/templates.js';

function parallelFlow(optional = false): Flow {
  const flow = structuredClone(templates.research);
  const task = flow.definition.nodes.find(n => n.type === 'agent_task')!;
  if (task.type !== 'agent_task') throw new Error('invalid fixture');
  flow.definition.nodes = [
    { id: 'start', label: 'Start', type: 'start' }, { id: 'fork', label: 'Fork', type: 'fork' },
    { ...task, id: 'a', label: 'A', sessionGroup: 'research-session' },
    { ...task, id: 'b', label: 'B', sessionGroup: 'research-session-b' },
    { id: 'join', label: 'Join', type: 'join', requiredBranches: optional ? ['a'] : ['a', 'b'] },
    { id: 'finish', label: 'Finish', type: 'finish' },
  ];
  flow.definition.sessionGroups.push({ id: 'research-session-b', bindingId: 'implementer' });
  flow.definition.edges = [
    { from: 'start', to: 'fork', outcome: 'completed' }, { from: 'fork', to: 'a', outcome: 'completed' },
    { from: 'fork', to: 'b', outcome: 'completed' }, { from: 'a', to: 'join', outcome: 'completed' },
    { from: 'b', to: 'join', outcome: 'completed' }, { from: 'join', to: 'finish', outcome: 'completed' },
  ];
  return flowSchema.parse(flow);
}

function startParallel(scheduler: GraphScheduler) {
  scheduler.claim('start'); scheduler.complete('start', 'completed');
  scheduler.claim('fork'); scheduler.complete('fork', 'completed');
  assert.deepEqual(scheduler.ready(), ['a', 'b']);
}

test('fork schedules independent branches and join waits for required results', () => {
  const scheduler = new GraphScheduler(parallelFlow(), defaultProject.policy);
  startParallel(scheduler);
  scheduler.claim('a'); scheduler.claim('b');
  scheduler.complete('a', 'completed');
  assert.equal(scheduler.snapshot().nodes.join?.status, 'pending');
  scheduler.complete('b', 'completed');
  assert.deepEqual(scheduler.ready(), ['join']);
  scheduler.claim('join'); scheduler.complete('join', 'completed');
  assert.deepEqual(scheduler.ready(), ['finish']);
});

test('a failed required branch blocks join while other branches continue', () => {
  const scheduler = new GraphScheduler(parallelFlow(), defaultProject.policy);
  startParallel(scheduler);
  scheduler.claim('a'); scheduler.fail('a', 'fixture failure');
  assert.deepEqual(scheduler.ready(), ['b']);
  scheduler.claim('b'); scheduler.complete('b', 'completed');
  assert.equal(scheduler.snapshot().nodes.join?.status, 'waiting');
  assert.equal(scheduler.snapshot().nodes.finish?.status, 'pending');
});

test('join can proceed without waiting for an explicitly optional read-only branch', () => {
  const scheduler = new GraphScheduler(parallelFlow(true), defaultProject.policy);
  startParallel(scheduler);
  scheduler.claim('a'); scheduler.claim('b');
  scheduler.complete('a', 'completed');
  assert.deepEqual(scheduler.ready(), ['join']);
  assert.equal(scheduler.snapshot().nodes.b?.status, 'running');
});

test('a branch contributing code cannot be marked optional at join', () => {
  const flow = parallelFlow(true);
  const task = flow.definition.nodes.find(n => n.id === 'b')!;
  if (task.type !== 'agent_task') throw new Error('invalid fixture');
  task.permissions.write = true;
  task.writeScopes = ['src'];
  assert.throws(() => new GraphScheduler(flow, defaultProject.policy), /optional_writer_branch/);
});

test('invalid graphs cannot be passed to the graph readiness engine', () => {
  const flow = parallelFlow();
  flow.definition.edges.push({ from: 'join', to: 'fork', outcome: 'completed' });
  assert.throws(() => new GraphScheduler(flow, defaultProject.policy), /Invalid flow.*cycle/);
});
