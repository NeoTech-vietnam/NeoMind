import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('monitor motion styles honor the VS Code body preference independently of the preserved OS preference', () => {
  const css = readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/monitor.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const editor = blocks.find(block => block[1].split(',').some(selector => selector.trim() === 'body.vscode-reduce-motion'));
  assert.ok(editor, 'VS Code workbench.reduceMotion uses its injected body class, independently of the OS media query.');
  const depth = [...css.slice(0, editor.index)].reduce((value, char) => value + (char === '{' ? 1 : char === '}' ? -1 : 0), 0);
  assert.equal(depth, 0, 'The editor preference must not remain gated behind an OS media query.');
  const editorSelectors = editor[1].split(',').map(selector => selector.trim());
  for (const selector of ['body.vscode-reduce-motion', 'body.vscode-reduce-motion *',
    'body.vscode-reduce-motion::before', 'body.vscode-reduce-motion::after',
    'body.vscode-reduce-motion *::before', 'body.vscode-reduce-motion *::after']) assert.ok(editorSelectors.includes(selector), selector);
  const system = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*([^{}]+)\{([^{}]+)\}\s*\}/.exec(css);
  assert.ok(system, 'Keep the ordinary operating-system preference fallback.');
  assert.deepEqual(system[1].split(',').map(selector => selector.trim()), ['*', '*::before', '*::after']);
  for (const block of [editor[2], system[2]]) {
    const declarations = new Map(block.split(';').filter(value => value.trim()).map(value => value.split(':').map(part => part.trim())));
    for (const [property, value] of [['animation', 'none'], ['transition', 'none'], ['scroll-behavior', 'auto']])
      assert.match(declarations.get(property), new RegExp(`^${value}\\s*!important$`), property);
  }
});

test('implementation rework is visible only from an explicit backend repairing milestone', () => {
  const { elements } = documentFixture(['diagram']);
  const renderer = universe.create(elements.get('diagram'));
  const rework = descendants(elements.get('diagram')).find(node => node.classList.contains('v-rework'));
  assert.ok(rework, 'The V-model includes an explicit implementation repair route');
  for (const request of [{ status: 'repairing' }, { stages: [{ id: 'coding', state: 'running' }] },
    { stages: [{ id: 'coding', state: 'completed' }], review: { state: 'failed' } }]) {
    renderer.setData(request);
    assert.equal(rework.dataset.state, 'pending', 'A phase label or finding does not invent an active repair');
    assert.equal(rework.getAttribute('aria-hidden'), 'true');
  }
  renderer.setData({ stages: [{ id: 'coding', state: 'repairing' }], review: { state: 'failed' } });
  assert.equal(rework.dataset.state, 'repairing');
  assert.equal(rework.getAttribute('aria-hidden'), 'false');
  assert.match(rework.textContent, /implementation repair/i);
  renderer.setData({ stages: [{ id: 'coding', state: 'completed' }] });
  assert.equal(rework.dataset.state, 'pending');
});
