import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createPreviewServer, createPreviewSnapshot } from '../scripts/preview-monitor.mjs';

const universe = createRequire(import.meta.url)('../extensions/vscode-model-bridge/resources/monitor/universe.js');

test('preview fixtures retain all role and source identities without creating live attestations', () => {
  const snapshot = createPreviewSnapshot();
  assert.equal(snapshot.roles.length, 12);
  assert.ok(snapshot.roles.every(role => role.provider === '9Router' && role.models.every(id => id.startsWith('demo/'))));
  const scene = universe.buildScene(snapshot);
  assert.equal(scene.planets.length, 12);
  assert.equal(scene.counts.tasks, 12);
  assert.equal(scene.counts.recorded_agents, 12);
  assert.equal(scene.counts.running_agents, 0);
  const ids = new Set(scene.bodies.map(body => body.id));
  for (const node of snapshot.map.nodes) {
    assert.ok(ids.has(node.id));
    assert.equal(node.source, 'project-record');
    assert.equal(node.confirmed_model, null);
    assert.equal(node.provider, null);
  }
  assert.deepEqual(new Set(snapshot.map.nodes.filter(node => node.kind === 'task').map(node => node.state)),
    new Set(['running', 'completed', 'waiting', 'blocked', 'idle']));
  assert.equal(scene.edges.length, snapshot.map.edges.length);
  for (const edge of scene.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to));
    assert.equal(edge.source, 'project-record');
    assert.ok(edge.evidence_id.startsWith('fixture:'));
  }
  assert.deepEqual(createPreviewSnapshot(), snapshot, 'Refresh preserves deterministic fixture identities and observations');
  const empty = universe.buildScene(createPreviewSnapshot('empty'));
  assert.equal(empty.planets.length, 12);
  assert.equal(empty.counts.recorded_agents, 0);
  assert.equal(empty.counts.tasks, 0);
  assert.equal(empty.edges.length, 0);
});

test('preview serves the actual renderer/controller in dependency order and exposes read-only alternate fixtures', async t => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base)).text();
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['/universe.js', '/focus-space.js', '/monitor.js']);
  for (const path of [...scripts, '/monitor.css', '/focus-space.css']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), path.endsWith('.js') ? /javascript/ : /css/);
    const body = await response.text();
    assert.equal(body, readFileSync(new URL(`../extensions/vscode-model-bridge/resources/monitor${path}`, import.meta.url), 'utf8'));
  }
  const small = await (await fetch(base + '/snapshot?fixture=small')).json();
  assert.equal(small.roles.length, 4);
  const ids = new Set(small.map.nodes.map(node => node.id));
  assert.ok(small.map.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)));
  const error = await (await fetch(base + '/snapshot?fixture=error')).json();
  assert.equal(error.type, 'error');
  assert.equal(error.preview, true);
  assert.equal((await fetch(base + '/snapshot', { method: 'POST' })).status, 405);
});

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.dataset = {};
    this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.className = '';
    this.hidden = false; this.disabled = false; this._text = '';
    this.classList = { add: (...names) => this.classes(names, []), remove: (...names) => this.classes([], names),
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classes(add ? [name] : [], add ? [] : [name]); return add; } };
  }
  classes(add, remove) { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...add])].filter(name => !remove.includes(name)).join(' '); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (let child of children) { if (typeof child === 'string') child = Object.assign(new Element('#text', this.document), { textContent: child }); child.remove(); child.parentElement = this; this.children.push(child); } }
  prepend(...children) { const previous = [...this.children]; this.replaceChildren(...children, ...previous); }
  insertBefore(child, reference) { if (child === reference) return child; child.remove(); child.parentElement = this; const index = reference ? this.children.indexOf(reference) : -1; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child; }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentElement) { if (this.document.activeElement === this || descendants(this).includes(this.document.activeElement)) this.document.activeElement = null; const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, callback) { const listeners = this.listeners.get(type) ?? []; listeners.push(callback); this.listeners.set(type, listeners); }
  dispatch(type, extra = {}) { let stopped = false; const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...extra }; for (const listener of this.listeners.get(type) ?? []) listener(event); if (!stopped) this.parentElement?.dispatch(type, { ...extra, target: this }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.document.activeElement = this; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] ?? null; }
  getBoundingClientRect() { return { width: 1000, height: 640, left: 0, top: 0 }; }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function matches(node, selector) {
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  return node.tagName === selector.toUpperCase();
}
function controller(options = {}) {
  const ids = ['field', 'status', 'roles', 'nodes', 'selection', 'project-name', 'router-status', 'observed-summary',
    'focus-selection', 'reset-view', 'motion', 'empty-state', 'activity', 'live-summary', 'live-agents', 'roles-count', 'nodes-count', 'profiles-summary', 'refresh'];
  const document = { hidden: false, activeElement: null, listeners: new Map(),
    createElement: tag => new Element(tag, document), getElementById: id => elements.get(id),
    addEventListener(type, callback) { this.listeners.set(type, callback); } };
  document.body = new Element('body', document);
  const elements = new Map(ids.map(id => { const element = new Element(id === 'field' ? 'canvas' : 'div', document); element.id = id; document.body.append(element); return [id, element]; }));
  const listeners = new Map(), reducedListeners = [];
  const reduced = { matches: Boolean(options.reduced), addEventListener: (_type, callback) => reducedListeners.push(callback) };
  const calls = { create: 0, data: [], selected: [], motion: [], focus: [], reset: 0, destroyed: 0, messages: [] };
  let saved = options.saved, selectionCallback;
  const renderer = { setData: data => calls.data.push(data), setSelected: id => calls.selected.push(id),
    setMotion: enabled => calls.motion.push(enabled), focus: id => calls.focus.push(id), resetView: () => calls.reset++,
    destroy: () => calls.destroyed++, getState: () => ({}) };
  const api = { create: (_canvas, setup) => { calls.create++; if (options.rendererError) throw options.rendererError; selectionCallback = setup.onSelect; return renderer; }, buildScene: universe.buildScene };
  const window = { NeoMindUniverse: api, devicePixelRatio: 1, matchMedia: () => reduced,
    addEventListener(type, callback) { listeners.set(type, callback); } };
  runInNewContext(readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/monitor.js', import.meta.url), 'utf8'), {
    window, document, NeoMindUniverse: api, console, Date, Intl, setTimeout: () => 1, clearTimeout() {},
    acquireVsCodeApi: () => ({ getState: () => saved, setState: value => { saved = value; },
      postMessage: message => calls.messages.push(JSON.parse(JSON.stringify(message))) }),
  });
  return { calls, elements, document, renderer, get saved() { return saved; },
    message: data => listeners.get('message')?.({ data }), select: id => selectionCallback(id),
    reduce: value => { reduced.matches = value; reducedListeners.forEach(callback => callback({ matches: value })); },
    unload: () => listeners.get('pagehide')?.() };
}

function changeButton(ui, role) {
  return ui.elements.get('roles').querySelectorAll('button').find(button => button.dataset.role === role);
}
function roleOption(ui, role) { return changeButton(ui, role).parentElement.querySelector('.role-option'); }
const inspectorButton = ui => ui.elements.get('selection').querySelector('.model-change');

test('configured-only roles select exact model messages and preserve focused keyed controls across polling', () => {
  const ui = controller(), initial = createPreviewSnapshot('empty');
  ui.message(initial);
  assert.equal(ui.calls.create, 1);
  assert.equal(ui.elements.get('roles').children.length, 12);
  assert.equal(ui.calls.data.at(-1).map.nodes.length, 0);
  assert.match(ui.elements.get('selection').textContent, /Configured role policy/);
  roleOption(ui, 'developer').click();
  assert.equal(ui.saved.selectedId, 'role:developer');
  assert.equal(ui.calls.focus.at(-1), 'role:developer');
  const button = inspectorButton(ui), roleButton = changeButton(ui, 'developer');
  button.focus(); button.click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'select-model', role: 'developer' });
  const refreshed = createPreviewSnapshot('empty');
  refreshed.roles.find(role => role.role === 'developer').models = ['demo/updated-worker'];
  ui.message(refreshed);
  assert.equal(inspectorButton(ui), button);
  assert.equal(changeButton(ui, 'developer'), roleButton);
  assert.equal(ui.document.activeElement, button);
  assert.equal(ui.saved.selectedId, 'role:developer');
  assert.match(ui.elements.get('selection').textContent, /demo\/updated-worker/);
  assert.match(roleOption(ui, 'developer').textContent, /demo\/updated-worker/);
  assert.equal(ui.calls.create, 1, 'Polling reuses the renderer');
});

test('real saved IDs and secondary role policies retain distinct provenance and routing guidance', () => {
  const ui = controller(); ui.message(createPreviewSnapshot());
  assert.match(ui.elements.get('profiles-summary').textContent, /9 native expert profiles · 12 stable core role policies/);
  ui.select('fixture:reported:developer');
  assert.equal(ui.saved.selectedId, 'fixture:reported:developer');
  assert.equal(ui.calls.selected.at(-1), 'fixture:reported:developer');
  const detail = ui.elements.get('selection').textContent;
  assert.match(detail, /Reported native contribution/);
  assert.match(detail, /fixture:report:developer/);
  assert.match(detail, /Not attested by this project record/);
  const button = inspectorButton(ui);
  button.click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'select-model', role: 'developer' });
  ui.select('unknown-id');
  assert.equal(ui.saved.selectedId, 'fixture:reported:developer');
  ui.select('role:component-owner');
  assert.equal(inspectorButton(ui), button);
  assert.match(ui.elements.get('selection').textContent, /uses the architect model policy/);
  assert.match(button.textContent, /strict bridge/);
  button.click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'select-model', role: 'component-owner' });
  ui.select('role:researcher');
  assert.match(ui.elements.get('selection').textContent, /NeoMind Researcher Agent/);
  assert.doesNotMatch(button.textContent, /strict bridge/);
  ui.select('role:developer');
  assert.match(ui.elements.get('selection').textContent, /NeoMind Implementer Agent \/ NeoMind Debugger Agent/);
  ui.message({ ...createPreviewSnapshot(), agent_profiles: undefined });
  assert.match(ui.elements.get('profiles-summary').textContent, /metadata unavailable/);
  assert.doesNotMatch(ui.elements.get('selection').textContent, /NeoMind Implementer Agent/);
});

test('profile names reach visible role labels, accessibility names and the renderer without changing role identities', () => {
  const ui = controller(); ui.message(createPreviewSnapshot());
  for (const [role, label] of [['codebase-analyst', 'Explorer'], ['requirements', 'Planner'],
    ['manager', 'Coordinator'], ['developer', 'Implementer / Debugger']]) {
    assert.match(roleOption(ui, role).textContent, new RegExp(label));
    assert.match(roleOption(ui, role).getAttribute('aria-label'), new RegExp(label));
    ui.select(`role:${role}`);
    assert.equal(ui.elements.get('selection').querySelector('h2').textContent, label);
    const data = ui.calls.data.at(-1);
    assert.equal(data.roles.find(item => item.role === role).display_name, label);
    const planet = universe.buildScene(data).planets.find(item => item.role === role);
    assert.equal(planet.label, label);
    assert.equal(planet.id, `role:${role}`);
  }
});

test('interactions show reported running work, dispatch attempts, direction and expired updates without signed claims', () => {
  const ui = controller(), snapshot = createPreviewSnapshot('activity'); ui.message(snapshot);
  assert.match(ui.elements.get('status').textContent, /2 reported running/);
  assert.match(ui.elements.get('live-summary').textContent, /2 active assignments/);
  const live = ui.elements.get('live-agents').textContent;
  assert.match(live, /NeoMind Explorer Agent/);
  assert.match(live, /Reported running/);
  assert.match(live, /dispatch attempted/);
  assert.match(live, /unsigned/);
  assert.match(ui.elements.get('activity').textContent, /NeoMind Coordinator Agent → NeoMind Planner Agent/);
  const scene = universe.buildScene(ui.calls.data.at(-1));
  assert.equal(scene.planets.find(planet => planet.role === 'codebase-analyst').state, 'running');
  const explorer = snapshot.map.nodes.find(node => node.profile_id === 'explorer');
  explorer.state = 'unknown'; explorer.expired = true;
  ui.message(snapshot);
  assert.match(ui.elements.get('live-agents').textContent, /unknown · update expired/);
  assert.match(ui.elements.get('status').textContent, /1 reported running/);
  ui.select(explorer.id);
  assert.match(ui.elements.get('selection').textContent, /Unsigned assignment progress/);
  assert.match(ui.elements.get('selection').textContent, /Expired · current state unknown/);
  ui.message({ type: 'error', message: 'Unavailable' });
  assert.match(ui.elements.get('live-summary').textContent, /last known reports/);
});

test('error and uncertain invocation state disable model changes while preserving inspectable last selection', () => {
  const ui = controller(); ui.message(createPreviewSnapshot()); ui.select('role:developer');
  const button = inspectorButton(ui), count = ui.calls.messages.length;
  ui.message({ type: 'error', message: 'Fixture state unavailable' });
  assert.equal(ui.saved.selectedId, 'role:developer');
  assert.equal(inspectorButton(ui), button);
  assert.ok(ui.elements.get('roles').querySelectorAll('.role-change').every(item => item.disabled));
  assert.equal(button.disabled, true);
  button.click(); assert.equal(ui.calls.messages.length, count);
  assert.equal(ui.calls.data.at(-1).map.stale, true);
  assert.equal(ui.calls.motion.at(-1), false);
  assert.match(ui.elements.get('status').textContent, /displaying the last snapshot/);
  assert.match(ui.elements.get('selection').textContent, /Last known role policy/);
  assert.equal(ui.calls.data.at(-1).map.nodes.length, 25, 'Error retains saved evidence rather than inventing a new state');
  for (const patch of [{ control_unavailable: true, roles: [] }, { active_count: null }, { active_count: 1 }]) {
    ui.message({ ...createPreviewSnapshot(), ...patch });
    assert.equal(button.disabled, true);
    button.click(); assert.equal(ui.calls.messages.length, count);
    assert.equal(ui.elements.get('roles').children.length, 12);
    assert.equal(ui.saved.selectedId, 'role:developer');
  }
  ui.message(createPreviewSnapshot());
  assert.equal(button.disabled, false);
  assert.equal(ui.calls.data.at(-1).map.stale, false);
  button.click(); assert.equal(ui.calls.messages.length, count + 1);
});

test('pause, reduced motion and renderer lifecycle remain independent from agent execution', () => {
  const ui = controller({ saved: { selectedId: 'role:reviewer', motionEnabled: false } });
  ui.message(createPreviewSnapshot());
  assert.equal(ui.saved.selectedId, 'role:reviewer');
  assert.equal(ui.calls.motion.at(-1), false);
  assert.equal(ui.elements.get('motion').getAttribute('aria-pressed'), 'true');
  const messageCount = ui.calls.messages.length;
  ui.elements.get('motion').click();
  assert.equal(ui.saved.motionEnabled, true);
  assert.equal(ui.calls.motion.at(-1), true);
  ui.message(createPreviewSnapshot());
  assert.equal(ui.calls.motion.at(-1), true);
  ui.reduce(true);
  assert.equal(ui.calls.motion.at(-1), false);
  assert.equal(ui.elements.get('motion').disabled, true);
  ui.reduce(false);
  assert.equal(ui.calls.motion.at(-1), true);
  ui.elements.get('reset-view').click();
  ui.elements.get('focus-selection').click();
  assert.equal(ui.calls.reset, 1);
  assert.equal(ui.calls.focus.at(-1), 'role:reviewer');
  assert.equal(ui.calls.messages.length, messageCount, 'Presentation controls send no model or execution request');
  ui.unload(); assert.equal(ui.calls.destroyed, 1);
  const reduced = controller({ reduced: true }); reduced.message(createPreviewSnapshot('empty'));
  assert.equal(reduced.calls.motion.at(-1), false);
  assert.equal(reduced.elements.get('motion').disabled, true);
});

test('canvas creation failure keeps policy and saved evidence controls usable without retrying graphics', () => {
  const ui = controller({ rendererError: new Error('Canvas unavailable SECRET_RENDERER_DETAIL') });
  assert.deepEqual(ui.calls.messages, [{ type: 'refresh' }]);
  ui.message(createPreviewSnapshot());
  assert.equal(ui.elements.get('roles').children.length, 12);
  assert.equal(ui.elements.get('nodes').children.length, 25);
  assert.equal(ui.elements.get('empty-state').hidden, false);
  assert.match(ui.elements.get('empty-state').textContent, /graphics.*unavailable/i);
  assert.match(ui.elements.get('status').textContent, /graphics.*unavailable/i);
  assert.doesNotMatch(ui.elements.get('status').textContent, /saved state unavailable|SECRET_RENDERER_DETAIL/i);
  assert.doesNotMatch(ui.elements.get('router-status').textContent, /unavailable/i);
  roleOption(ui, 'developer').click();
  const change = inspectorButton(ui);
  assert.equal(change.disabled, false);
  change.click();
  assert.deepEqual(ui.calls.messages.at(-1), { type: 'select-model', role: 'developer' });
  ui.elements.get('nodes').children[0].click();
  assert.match(ui.elements.get('selection').textContent, /Saved project record|Reported native contribution/);
  ui.message(createPreviewSnapshot());
  assert.equal(ui.calls.create, 1, 'Polling never retries failed canvas creation');
  assert.equal(ui.elements.get('empty-state').hidden, false, 'Graphics notice persists with real saved evidence');
  assert.equal(ui.elements.get('motion').disabled, true);
  assert.equal(ui.elements.get('reset-view').disabled, true);
  assert.equal(ui.elements.get('focus-selection').disabled, true);
});
