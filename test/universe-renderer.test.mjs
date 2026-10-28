import test from 'node:test';
import assert from 'node:assert/strict';
import { universe, documentFixture, descendants } from './helpers/workforce-ui.mjs';

test('V-model has the nine supplied engineering stages with specification-test pairs', () => {
  assert.deepEqual(universe.stages.map(stage => stage.id), ['requirements', 'analysis', 'architecture', 'module-design', 'coding', 'unit', 'integration', 'system', 'acceptance']);
  assert.equal(universe.stages[4].role, 'WF.FnD');
  assert.equal(universe.stages[8].role, 'WF.Tester');
  const positions = universe.stages.map(stage => [stage.x, stage.y]);
  assert.ok(positions[0][0] < positions[3][0] && positions[3][1] < positions[4][1]);
  assert.ok(positions[5][0] < positions[8][0] && positions[5][1] > positions[8][1]);
});

test('phase, request completion and historical records cannot invent stage evidence', () => {
  for (const request of [undefined, { status: 'completed', phase: 'acceptance' }, { events: [{ type: 'report', phase: 'coding' }], map: { nodes: [{ state: 'running' }] } }]) {
    const scene = universe.buildScene(request);
    assert.ok(scene.stages.every(stage => stage.state === 'pending'));
    assert.equal(scene.review, null);
    assert.equal('planets' in scene, false);
    assert.equal('edges' in scene, false);
  }
});

test('explicit backend milestones preserve applicability, uncertainty and independent review', () => {
  const request = { workflow_id: 'first', stages: [
    { id: 'requirement-gathering', state: 'completed', summary: 'Accepted scope' },
    { id: 'module_design', status: 'not_applicable', rationale: 'No module boundary changed' },
    { id: 'implementation', state: 'repairing', agent: 'WF.FnD' },
    { id: 'unit-testing', state: 'uncertain' },
    { id: 'system-testing', state: 'unknown-invalid' },
    { id: 'review', state: 'failed', summary: 'Interface mismatch' },
  ] };
  const scene = universe.buildScene(request), states = Object.fromEntries(scene.stages.map(stage => [stage.id, stage.state]));
  assert.equal(states.requirements, 'completed'); assert.equal(states['module-design'], 'not-applicable');
  assert.equal(states.coding, 'repairing'); assert.equal(states.unit, 'uncertain'); assert.equal(states.system, 'pending');
  assert.equal(scene.review.state, 'failed'); assert.equal(scene.request_id, 'first');
  assert.ok(universe.buildScene({ workflow_id: 'second' }).stages.every(stage => stage.state === 'pending'), 'Switching requests must not carry over stage completion.');
});

test('renderer exposes actual milestone state with keyboard interaction and reduced motion controls', () => {
  const { document, elements } = documentFixture(['diagram']), selected = [];
  const renderer = universe.create(elements.get('diagram'), { onSelect: id => selected.push(id) });
  const nodes = descendants(elements.get('diagram')).filter(node => node.getAttribute('data-stage'));
  assert.equal(nodes.length, 9); assert.ok(nodes.every(node => node.getAttribute('role') === 'button' && node.getAttribute('tabindex') === '0'));
  renderer.setData({ stages: [{ id: 'coding', state: 'running', summary: '<unsafe>' }] });
  const coding = nodes.find(node => node.dataset.stage === 'coding');
  assert.equal(coding.dataset.state, 'running'); assert.match(coding.getAttribute('aria-label'), /Coding: running/);
  assert.equal(descendants(coding).some(node => node.tagName === 'UNSAFE'), false);
  coding.dispatch('keydown', { key: 'Enter' }); coding.dispatch('keydown', { key: ' ' });
  assert.deepEqual(selected, ['coding', 'coding']); assert.equal(coding.getAttribute('aria-pressed'), 'true');
  renderer.setMotion(false); assert.equal(elements.get('diagram').children[0].getAttribute('data-motion'), 'false');
  renderer.focus('coding'); assert.equal(document.activeElement, coding);
  renderer.resetView(); assert.equal(coding.getAttribute('aria-pressed'), 'false');
  renderer.destroy(); assert.equal(elements.get('diagram').children.length, 0);
});
