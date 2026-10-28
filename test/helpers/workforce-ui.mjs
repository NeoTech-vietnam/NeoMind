import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

export const universe = createRequire(import.meta.url)('../../extensions/vscode-model-bridge/resources/monitor/universe.js');
export class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {};
    this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.className = '';
    this.hidden = false; this.disabled = false; this.value = ''; this._text = '';
    this.classList = { add: (...names) => this.classes(names, []), remove: (...names) => this.classes([], names),
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classes(add ? [name] : [], add ? [] : [name]); return add; } };
  }
  classes(add, remove) { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...add])].filter(name => !remove.includes(name)).join(' '); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (let child of children) { if (typeof child === 'string') child = Object.assign(new Element('#text', this.ownerDocument), { textContent: child }); child.remove(); child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentElement) { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase())] = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, callback) { const listeners = this.listeners.get(type) ?? []; listeners.push(callback); this.listeners.set(type, listeners); }
  dispatch(type, extra = {}) { const event = { type, target: this, currentTarget: this, preventDefault() {}, ...extra }; for (const listener of this.listeners.get(type) ?? []) listener(event); }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
export const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
function matches(node, selector) {
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  return node.tagName === selector.toUpperCase();
}
export function documentFixture(ids = []) {
  const elements = new Map(), document = { hidden: false, activeElement: null, listeners: new Map(),
    createElement: tag => new Element(tag, document), createElementNS: (_namespace, tag) => new Element(tag, document),
    getElementById: id => elements.get(id), addEventListener(type, callback) { this.listeners.set(type, callback); } };
  document.body = new Element('body', document);
  for (const id of ids) { const element = new Element('div', document); element.id = id; elements.set(id, element); document.body.append(element); }
  return { document, elements };
}
export function controller(options = {}) {
  const source = readFileSync(new URL('../../extensions/vscode-model-bridge/resources/monitor/monitor.js', import.meta.url), 'utf8');
  const ids = [...new Set([...source.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]))];
  const { document, elements } = documentFixture(ids), listeners = new Map(), reducedListeners = [];
  const reduced = { matches: Boolean(options.reduced), addEventListener: (_type, callback) => reducedListeners.push(callback) };
  const calls = { data: [], selected: [], motion: [], destroyed: 0, focusCreated: 0, focusDestroyed: 0, messages: [] };
  let saved = options.saved ?? {}, selectionCallback;
  const renderer = { setData: data => calls.data.push(data), setSelected: id => calls.selected.push(id),
    setMotion: enabled => calls.motion.push(enabled), destroy: () => calls.destroyed++ };
  const api = { ...universe, create: (_container, setup) => { if (options.rendererError) throw options.rendererError; selectionCallback = setup.onSelect; return renderer; } };
  const window = { ...(options.noRenderer ? {} : { WorkForceUniverse: api }),
    WorkForceFocusSpace: { create() { calls.focusCreated++; return { destroy() { calls.focusDestroyed++; } }; } },
    matchMedia: () => reduced, addEventListener(type, callback) { listeners.set(type, callback); } };
  runInNewContext(source, { window, document, console, Date, Intl,
    acquireVsCodeApi: () => ({ getState: () => saved, setState: value => { saved = value; }, postMessage: message => calls.messages.push(structuredClone(message)) }) });
  return { calls, elements, document, get saved() { return saved; },
    message: data => listeners.get('message')?.({ data }), select: id => selectionCallback?.(id),
    reduce: value => { reduced.matches = value; reducedListeners.forEach(callback => callback({ matches: value })); },
    visibility: hidden => { document.hidden = hidden; document.listeners.get('visibilitychange')?.(); },
    unload: () => listeners.get('pagehide')?.() };
}
