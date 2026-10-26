import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const universe = createRequire(import.meta.url)('../extensions/vscode-model-bridge/resources/monitor/universe.js');

const roles = ['manager', 'architect', 'developer', 'reviewer'].map(role => ({ role, models: ['top-models'], provider: '9router' }));
const node = (id, kind, role, state = 'completed') => ({ id, kind, role, label: id, state, source: 'project-record', source_id: `source:${id}` });

test('current view shows one active implementer while completed agents and saved links remain optional static history', () => {
  const historical = ['explorer', 'planner', 'reviewer'].map(role => node(role, 'agent', role, 'completed'));
  const active = { ...node('impl', 'agent', 'developer', 'running'), source: 'native-hook' };
  const session = { ...node('session', 'workflow', null, 'running'), source: 'native-hook' };
  const map = { nodes: [...historical, active, session], edges: [
    { id: 'active', from: 'session', to: 'impl', source: 'native-hook', animated: true },
    { id: 'old', from: 'explorer', to: 'planner', source: 'project-record', animated: true },
  ] };
  const current = universe.buildScene({ roles, map });
  assert.deepEqual(current.bodies.filter(body => body.kind === 'agent').map(body => body.id), ['impl']);
  assert.equal(current.edges.length, 1); assert.equal(current.edges[0].animated, true);
  const history = universe.buildScene({ roles, map, showHistory: true });
  assert.equal(history.bodies.filter(body => body.kind === 'agent').length, 4);
  assert.equal(history.edges.find(edge => edge.id === 'old').animated, false);
  const stopped = universe.buildScene({ roles, map: { ...map, nodes: [...historical, { ...active, state: 'idle' }, { ...session, state: 'idle' }] } });
  assert.equal(stopped.counts.recorded_agents, 0); assert.equal(stopped.edges.length, 0);
});

test('controlled superseded attempts stay optional static history and cannot override current role state', () => {
  const controlled = (id, role, state, current) => ({ ...node(id, 'agent', role, state), source: 'controlled-runtime', controlled_current: current });
  const old = controlled('old-blocked', 'manager', 'blocked', false), past = controlled('old-interrupted', 'developer', 'interrupted', false), live = controlled('new-running', 'developer', 'running', true);
  const unmarked = { ...node('unmarked', 'agent', 'reviewer', 'running'), source: 'controlled-runtime' };
  const workflow = { ...node('runtime-workflow', 'workflow', null, 'running'), source: 'controlled-runtime', controlled_current: true };
  const map = { nodes: [workflow, old, past, live, unmarked], edges: [
    { id: 'past', from: old.id, to: past.id, source: 'controlled-runtime', kind: 'handoff', animated: true },
    { id: 'current', from: workflow.id, to: live.id, source: 'controlled-runtime', kind: 'handoff', animated: true },
  ] };
  const current = universe.buildScene({ map, roles });
  assert.equal(current.bodies.some(body => body.id === past.id || body.id === unmarked.id), false);
  assert.deepEqual(current.bodies.filter(body => body.kind === 'agent' && body.controlled_current).map(body => body.id), ['new-running']);
  assert.equal(current.bodies.some(body => body.id === old.id), false, 'Runtime dispatch must not resurrect a failed historical Coordinator as its current parent.');
  assert.equal(current.planets.find(body => body.role === 'manager').state, 'configured');
  assert.equal(current.counts.running_agents, 1);
  const history = universe.buildScene({ map, roles, showHistory: true });
  assert.equal(history.bodies.filter(body => body.kind === 'agent').length, 4);
  assert.match(history.bodies.find(body => body.id === old.id).label, /^History · /);
  assert.equal(history.planets.find(body => body.role === 'manager').state, 'recorded');
  assert.equal(history.planets.find(body => body.role === 'reviewer').state, 'recorded');
  assert.equal(history.counts.running_agents, 1, 'Unmarked or historical running receipts are not current execution.');
  assert.equal(history.edges.find(edge => edge.id === 'past').animated, false);
  assert.equal(history.edges.find(edge => edge.id === 'current').animated, true);
  const completedContext = universe.buildScene({ roles, map: { nodes: [{ ...live, state: 'completed', controlled_workflow_state: 'blocked' }], edges: [] } });
  assert.equal(completedContext.bodies.find(body => body.id === live.id).controlled_workflow_state, 'blocked');
  assert.equal(completedContext.planets.find(body => body.role === 'developer').state, 'completed');
  assert.equal(completedContext.counts.running_agents, 0);
});

test('only explicitly superseded unsigned activity becomes history while other workflows and signed activity stay current', () => {
  const old = { ...node('old-native', 'agent', 'developer', 'blocked'), source: 'native-activity', controlled_superseded: true };
  const current = { ...node('current-context', 'agent', 'developer', 'completed'), source: 'controlled-runtime', controlled_current: true, controlled_workflow_state: 'blocked' };
  const workflow = { ...node('workflow', 'workflow', null, 'blocked'), source: 'controlled-runtime', controlled_current: true };
  const foreign = { ...node('foreign-native', 'agent', 'architect', 'running'), source: 'native-activity' };
  const signed = { ...node('foreign-signed', 'agent', 'reviewer', 'running'), source: 'signed-receipt' };
  const map = { nodes: [old, current, workflow, foreign, signed], edges: [{ id: 'old-pulse', from: old.id, to: workflow.id, source: 'native-activity', kind: 'report', animated: true }] };
  const live = universe.buildScene({ map, roles });
  assert.equal(live.bodies.some(body => body.id === old.id), false);
  assert.deepEqual(live.bodies.filter(body => body.kind === 'agent').map(body => body.id), [current.id, foreign.id, signed.id]);
  assert.equal(live.planets.find(body => body.role === 'developer').state, 'completed');
  const history = universe.buildScene({ map, roles, showHistory: true });
  assert.match(history.bodies.find(body => body.id === old.id).label, /^History · /);
  assert.equal(history.bodies.find(body => body.id === old.id).state, 'blocked');
  assert.equal(history.planets.find(body => body.role === 'developer').state, 'completed');
  assert.equal(history.edges.find(edge => edge.id === 'old-pulse').animated, false);
  assert.equal(history.counts.running_agents, 1);
});

test('configured planets never fabricate recorded identities or active agents', () => {
  const scene = universe.buildScene({ roles, showHistory: true, map: { nodes: [], edges: [] } });
  assert.deepEqual(scene.planets.map(body => body.id).sort(), roles.map(role => `role:${role.role}`).sort());
  assert.ok(scene.planets.every(body => body.state === 'configured' && body.evidence_count === 0));
  assert.deepEqual(scene.counts, { configured_roles: 4, recorded_agents: 0, running_agents: 0, tasks: 0, workflows: 0 });
  assert.equal(scene.edges.length, 0);
});

test('a stopped actual parent remains static context for its still-running hook child', () => {
  const parent = { ...node('coordinator', 'agent', 'manager', 'idle'), source: 'native-hook' };
  const child = { ...node('child', 'agent', 'developer', 'running'), source: 'native-hook' };
  const scene = universe.buildScene({ roles, map: { nodes: [parent, child], edges: [
    { id: 'actual-parent', from: parent.id, to: child.id, source: 'native-hook', kind: 'coordinates', animated: true },
  ] } });
  assert.ok(scene.bodies.some(body => body.id === parent.id && body.state === 'idle'));
  assert.ok(scene.edges.some(edge => edge.id === 'actual-parent'));
  assert.equal(scene.planets.find(body => body.role === 'manager').state, 'idle');
});

test('saved identities and task moons retain IDs/provenance and attach to their actual role', () => {
  const scene = universe.buildScene({ roles, showHistory: true, map: { nodes: [node('WF-1', 'workflow', 'manager', 'running'), { ...node('agent:one', 'agent', 'developer', 'running'), source: 'signed-receipt' }, node('TASK-1', 'task', 'developer')], edges: [] } });
  const agent = scene.bodies.find(body => body.id === 'agent:one');
  assert.equal(agent.parentId, 'role:developer');
  assert.equal(agent.source, 'signed-receipt');
  assert.equal(agent.source_id, 'source:agent:one');
  assert.equal(scene.bodies.find(body => body.id === 'TASK-1').parentId, 'role:developer');
  assert.equal(scene.bodies.find(body => body.id === 'WF-1').parentId, null);
  assert.equal(scene.counts.recorded_agents, 1);
  assert.equal(scene.counts.running_agents, 1);
  assert.equal(scene.planets.find(body => body.role === 'manager').state, 'recorded');
});

test('unsigned contribution planets summarize saved evidence without claiming active or finished work', () => {
  const scene = universe.buildScene({ roles, showHistory: true, map: { nodes: [node('reported:A', 'agent', 'developer', 'completed'), node('TASK-1', 'task', 'developer', 'running')], edges: [] } });
  assert.equal(scene.planets.find(body => body.role === 'developer').state, 'recorded');
  assert.equal(scene.bodies.find(body => body.id === 'reported:A').state, 'completed');
  assert.equal(scene.counts.running_agents, 0);
});

test('communication curves use only represented recorded edges and keep saved history static', () => {
  const edge = { id: 'recorded', from: 'A', to: 'B', kind: 'report', source: 'project-record', evidence_id: 'KNW-1', at: '2026-10-23', animated: true };
  const still = { ...edge, id: 'still', animated: false };
  const scene = universe.buildScene({ roles, showHistory: true, map: { nodes: [node('A', 'agent', 'developer'), node('B', 'task', 'developer')], edges: [edge, still, { ...edge, id: 'missing', to: 'absent' }] } });
  assert.deepEqual(scene.edges, [{ ...edge, animated: false }, still]);
  assert.equal(scene.edges.filter(value => value.animated).length, 0);
  assert.equal(scene.edges.some(value => value.from.startsWith('role:')), false);
});

test('poll order and unrelated additions do not change existing orbital positions', () => {
  const original = { roles, showHistory: true, map: { nodes: [node('A', 'agent', 'developer')], edges: [] } };
  const changed = { roles: [...roles].reverse(), showHistory: true, map: { nodes: [node('EXTRA', 'task', 'reviewer'), ...original.map.nodes], edges: [] } };
  const first = universe.projectScene(universe.buildScene(original), { width: 1000, height: 700, time: 31 });
  const second = universe.projectScene(universe.buildScene(changed), { width: 1000, height: 700, time: 31 });
  for (const body of first) {
    const other = second.find(item => item.id === body.id);
    assert.equal(other.x, body.x, body.id);
    assert.equal(other.y, body.y, body.id);
  }
});

test('projection supports zoom/pan and hit testing chooses the visible small moon', () => {
  const scene = universe.buildScene({ roles, showHistory: true, map: { nodes: [node('A', 'agent', 'developer')], edges: [] } });
  const regular = universe.projectScene(scene, { width: 1000, height: 700, time: 0 });
  const zoomed = universe.projectScene(scene, { width: 1000, height: 700, time: 0, zoom: 2, panX: 10, panY: -20 });
  const moon = regular.find(body => body.id === 'A');
  const larger = zoomed.find(body => body.id === 'A');
  assert.ok(Math.abs(larger.x - ((moon.x - 500) * 2 + 510)) < 1e-9);
  assert.ok(Math.abs(larger.y - ((moon.y - 350) * 2 + 330)) < 1e-9);
  assert.equal(universe.hitTest(regular, moon.x, moon.y)?.id, 'A');
  assert.equal(universe.hitTest(regular, -500, -500), null);
});

test('default constellation fills wide stages with substantial planets while narrow stages retain all roles', () => {
  const allRoles = ['manager', 'requirements', 'architect', 'component-owner', 'reviewer', 'verifier', 'researcher', 'codebase-analyst', 'curator', 'developer', 'check-executor', 'release'];
  const scene = universe.buildScene({ roles: allRoles, map: { nodes: [], edges: [] } });
  const wide = universe.projectScene(scene, { width: 1450, height: 650 });
  assert.equal(wide.length, 12);
  assert.ok(wide.every(body => body.radius >= 36 && body.radius <= 48));
  const extent = Math.max(...wide.map(body => body.x + body.radius)) - Math.min(...wide.map(body => body.x - body.radius));
  assert.ok(extent > 1450 * .8, 'The universe should use the available desktop width.');
  for (const [width, height] of [[1450, 650], [350, 580]]) {
    for (const body of universe.projectScene(scene, { width, height })) {
      assert.ok(body.x - body.radius > 6 && body.x + body.radius < width - 6, body.id);
      assert.ok(body.y - body.radius > 64 && body.y + body.radius < height - 51, body.id);
    }
  }
});

test('hidden pages and reduced-motion preference always suppress animation', () => {
  assert.equal(universe.shouldAnimate(true, false, false), true);
  for (const input of [[false, false, false], [true, true, false], [true, false, true], [true, true, true]]) assert.equal(universe.shouldAnimate(...input), false);
});

test('curved trails join exact endpoints and retain a bowed midpoint', () => {
  const from = { x: 10, y: 20 }, to = { x: 200, y: 180 };
  assert.deepEqual(universe.curvePoint(from, to, 0), from);
  assert.deepEqual(universe.curvePoint(from, to, 1), to);
  assert.notDeepEqual(universe.curvePoint(from, to, .5), { x: 105, y: 100 });
});

test('scene bounds hostile oversized inputs without inventing omitted relationships', () => {
  const nodes = Array.from({ length: 800 }, (_, index) => node(`A${index}`, 'task', 'developer'));
  const edges = Array.from({ length: 2000 }, (_, index) => ({ id: `E${index}`, from: 'A0', to: 'A1', animated: index % 2 === 0, source: 'project-record', evidence_id: `R${index}` }));
  const scene = universe.buildScene({ roles, showHistory: true, map: { nodes, edges } });
  assert.ok(scene.bodies.length <= 256 + 64);
  assert.ok(scene.edges.length <= 512);
  assert.equal(scene.omitted.nodes, 544);
});

test('procedural surfaces are deterministic detailed materials rather than flat colors', () => {
  const samples = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) samples.push(universe.surfaceSample(0, 1234, x / 9, y / 9).map(Math.round));
  assert.ok(new Set(samples.map(sample => sample.join(','))).size > 60);
  assert.deepEqual(universe.surfaceSample(3, 77, .31, .62), universe.surfaceSample(3, 77, .31, .62));
  assert.notDeepEqual(universe.surfaceSample(0, 77, .31, .62), universe.surfaceSample(3, 77, .31, .62));
});

function environment() {
  const target = () => {
    const callbacks = new Map();
    return { callbacks, addEventListener(event, callback) { callbacks.set(event, callback); }, removeEventListener(event, callback) { if (callbacks.get(event) === callback) callbacks.delete(event); } };
  };
  const labels = [];
  const context = new Proxy({ fillText(value) { labels.push(value); } }, { get(object, name) {
    if (name in object) return object[name];
    if (name === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (name === 'createImageData') return (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) });
    if (name === 'measureText') return value => ({ width: value.length * 6 });
    return () => {};
  } });
  const preference = { ...target(), matches: false }, pending = new Map();
  let nextFrame = 0, disconnected = false;
  const view = { ...target(), devicePixelRatio: 5, matchMedia: () => preference,
    requestAnimationFrame(callback) { pending.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { pending.delete(id); }, ResizeObserver: class { observe() {} disconnect() { disconnected = true; } } };
  const doc = { ...target(), defaultView: view, hidden: false, createElement: () => ({ getContext: () => context }) };
  const canvas = { ...target(), ownerDocument: doc, style: {}, getContext: () => context,
    getBoundingClientRect: () => ({ left: 13, top: 27, width: 1000, height: 680 }) };
  function advance(stamp) { const item = pending.entries().next().value; if (!item) return; pending.delete(item[0]); item[1](stamp); }
  return { canvas, doc, preference, pending, advance, labels, get disconnected() { return disconnected; } };
}

test('selecting a role draws its stationary label once rather than duplicating it', () => {
  const env = environment(), renderer = universe.create(env.canvas);
  renderer.setData({ roles: roles.slice(0, 1), map: { nodes: [], edges: [] } });
  env.labels.length = 0;
  renderer.setSelected('role:manager');
  assert.equal(env.labels.filter(label => label === 'Manager').length, 1);
  const role = renderer.getState().positions.find(body => body.id === 'role:manager');
  assert.ok(role.labelBounds.y >= 64);
  assert.ok(role.labelBounds.y + role.labelBounds.height <= 680 - 51);
  renderer.destroy();
});

test('renderer polling retains focus, selection and clock while hidden/reduced modes pause and destroy cleans up', () => {
  const env = environment(), selected = [];
  const renderer = universe.create(env.canvas, { onSelect: id => selected.push(id) });
  const data = { roles: roles.slice(0, 1), showHistory: true, map: { nodes: [node('A', 'task', 'manager')], edges: [] } };
  renderer.setData(data);
  env.advance(1000); env.advance(1030);
  renderer.focus('role:manager');
  const focused = renderer.getState();
  assert.ok(focused.elapsed > 0);
  assert.equal(focused.dpr, 2);
  renderer.setData(data);
  assert.equal(renderer.getState().zoom, focused.zoom);
  assert.equal(renderer.getState().panX, focused.panX);
  assert.equal(renderer.getState().selected, 'role:manager');
  assert.equal(renderer.getState().elapsed, focused.elapsed);
  env.preference.matches = true; env.preference.callbacks.get('change')();
  renderer.setMotion(true);
  assert.equal(renderer.getState().motion, false);
  assert.equal(env.pending.size, 0);
  env.preference.matches = false; env.doc.hidden = true; env.doc.callbacks.get('visibilitychange')();
  assert.equal(renderer.getState().motion, false);
  env.doc.hidden = false; env.doc.callbacks.get('visibilitychange')();
  assert.equal(env.pending.size, 1);
  renderer.resetView();
  const moon = renderer.getState().positions.find(body => body.id === 'A');
  env.canvas.callbacks.get('pointerdown')({ clientX: moon.x + 13, clientY: moon.y + 27, button: 0, pointerId: 1 });
  env.canvas.callbacks.get('pointerup')({ clientX: moon.x + 13, clientY: moon.y + 27, pointerId: 1 });
  assert.deepEqual(selected, ['A']);
  renderer.destroy(); renderer.destroy();
  assert.equal(env.pending.size, 0);
  assert.equal(env.canvas.callbacks.size, 0);
  assert.equal(env.doc.callbacks.size, 0);
  assert.equal(env.preference.callbacks.size, 0);
  assert.equal(env.disconnected, true);
  assert.equal(renderer.getState().destroyed, true);
});
