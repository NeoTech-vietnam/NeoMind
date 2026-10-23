import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const focus = require('../extensions/vscode-model-bridge/resources/monitor/focus-space.js');

test('a restored deadline credits wall-clock time and completes once across repeated ticks', () => {
  let timer = focus.createTimer(25);
  timer = focus.updateTimer(timer, 'start', 1_000);
  assert.equal(timer.deadline, 1_501_000);
  timer = focus.updateTimer(timer, 'tick', 61_000);
  assert.equal(timer.remainingMs, 1_440_000);
  timer = focus.restoreTimer(JSON.parse(JSON.stringify(timer)), 1_501_500);
  assert.equal(timer.status, 'completed');
  assert.equal(timer.completedSessions, 1);
  timer = focus.updateTimer(timer, 'tick', 9_000_000);
  assert.equal(timer.completedSessions, 1);
  assert.equal(timer.remainingMs, 0);
});

test('pause excludes the gap, duration changes preserve session totals, and invalid saved values are bounded', () => {
  let timer = focus.updateTimer(focus.createTimer(5), 'start', 1_000);
  timer = focus.updateTimer(timer, 'pause', 61_000);
  assert.equal(timer.remainingMs, 240_000);
  timer = focus.updateTimer(timer, 'start', 601_000);
  assert.equal(timer.deadline, 841_000);
  timer = focus.updateTimer(timer, 'tick', 841_000);
  timer = focus.updateTimer(timer, 'duration', 900_000, { minutes: 50 });
  assert.equal(timer.remainingMs, 3_000_000);
  assert.equal(timer.completedSessions, 1);
  assert.equal(timer.status, 'idle');
  const invalid = focus.restoreTimer({ durationMs: Infinity, remainingMs: -5, status: 'running', deadline: 'no' }, 0);
  assert.equal(invalid.status, 'paused');
  assert.ok(invalid.durationMs >= 60_000 && invalid.durationMs <= 14_400_000);
  assert.equal(invalid.remainingMs, 0);
});

test('YouTube links become allowlisted visible embeds without autoplay or unrelated query parameters', () => {
  const video = focus.parseYouTubeUrl('https://youtu.be/M7lc1UVf-VE?t=5', 'https://panel.example');
  assert.equal(video.videoId, 'M7lc1UVf-VE');
  assert.equal(video.url, 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  const embed = new URL(video.embedUrl);
  assert.equal(embed.origin, 'https://www.youtube-nocookie.com');
  assert.equal(embed.searchParams.get('origin'), 'https://panel.example');
  assert.equal(embed.searchParams.get('autoplay'), '0');
  assert.ok(focus.parseYouTubeUrl('https://youtu.be/M7lc1UVf-VE', 'null'), 'An opaque webview origin does not invalidate a valid video link');
  const playlist = focus.parseYouTubeUrl('https://www.youtube.com/playlist?list=PLabc_123456789');
  assert.equal(playlist.playlistId, 'PLabc_123456789');
  assert.match(playlist.embedUrl, /\/embed\/videoseries\?/);
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=M7lc1UVf-VE', 'https://user@youtube.com/watch?v=M7lc1UVf-VE', 'https://youtube.com/watch?v=bad', 'https://example.com/']) {
    assert.equal(focus.parseYouTubeUrl(url), null, url);
  }
});

test('FocusSpace fragment exposes accessible controls without network resources or inline scripts', () => {
  const { renderFocusSpace } = require('../extensions/vscode-model-bridge/focus-space.cjs');
  const html = renderFocusSpace();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Every control has a unique identity');
  for (const id of ['focus-space', 'fs-back', 'fs-start', 'fs-reset', 'fs-clock', 'fs-task', 'fs-place-query', 'fs-weather-location', 'fs-calendar-file', 'fs-calendar-connect', 'fs-youtube-url', 'fs-audio-toggle', 'fs-volume']) assert.ok(ids.includes(id), id);
  assert.doesNotMatch(html, /<script|<iframe|\bonclick=|\bsrc="https?:/i);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /accept="\.ics,text\/calendar"/);
});

function harness(saved = {}, options = {}) {
  const { renderFocusSpace } = require('../extensions/vscode-model-bridge/focus-space.cjs');
  const ids = [...renderFocusSpace().matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const elements = new Map(), messages = [], viewChanges = [], timeouts = new Map(), intervals = new Map();
  let state = structuredClone(saved), now = 1_000, timerId = 0;
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this.hidden = false; this.disabled = false; this.files = []; this.className = ''; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent ?? '').join(''); }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, listener) { const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, extra = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this, preventDefault() {}, ...extra }); }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 400, top: 180, width: 220, height: 155 }; }
  }
  const document = { hidden: false, activeElement: null, createElement: tag => new Element(tag),
    getElementById: id => elements.get(id) ?? null, body: new Element('body'), head: new Element('head') };
  document.addEventListener = document.body.addEventListener.bind(document.body);
  document.removeEventListener = document.body.removeEventListener.bind(document.body);
  for (const id of [...ids, 'enter-focus-space']) { const node = new Element(); node.id = id; elements.set(id, node); document.body.append(node); }
  for (const [id, value] of Object.entries({ 'fs-agenda-range': '1', 'fs-playlist': 'orbital', 'fs-volume': '35', 'fs-duration': '25' })) elements.get(id).value = value;
  const window = new Element('window');
  Object.assign(window, { document, navigator: {}, innerWidth: 1280, innerHeight: 800, location: { origin: 'https://panel.example' }, matchMedia: () => ({ matches: options.reduced !== false }),
    setTimeout: (fn, delay) => { const id = ++timerId; timeouts.set(id, { fn, at: now + delay }); return id; }, clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, delay) => { const id = ++timerId; intervals.set(id, { fn, delay }); return id; }, clearInterval: id => intervals.delete(id) });
  const vscode = { getState: () => structuredClone(state), setState: value => { state = structuredClone(value); }, postMessage: value => messages.push(structuredClone(value)) };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const source = readFileSync(new URL('../extensions/vscode-model-bridge/resources/monitor/focus-space.js', import.meta.url), 'utf8');
  runInNewContext(source, { window, document, navigator: window.navigator, URL, Date: Clock, console, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, setInterval: window.setInterval, clearInterval: window.clearInterval });
  const ui = window.NeoMindFocusSpace.create({ vscode, onViewChange: view => viewChanges.push(view), getTransitionOrigin: options.getTransitionOrigin });
  const answer = (request, data, ok = true) => window.emit('message', { data: { type: 'focus-space-result', action: request.action, request_id: request.request_id, ok, ...(ok ? { data } : { error: data }) } });
  async function flush() { for (let count = 0; count < 8; count++) await Promise.resolve(); }
  async function advance(ms) { now += ms; for (const [id, task] of [...timeouts]) if (task.at <= now) { timeouts.delete(id); task.fn(); } for (const task of [...intervals.values()]) task.fn(); await flush(); }
  return { ui, document, window, elements, messages, viewChanges, timeouts, intervals, answer, flush, advance, state: () => state, mutateState: value => { state = value; } };
}

test('the controller switches views and merges fresh persisted monitor state while the deadline runs in the background', async () => {
  const app = harness({ selectedId: 'role:manager', motionEnabled: true });
  assert.equal(app.document.body.dataset.view, 'universe');
  assert.equal(app.messages[0].action, 'status');
  app.answer(app.messages[0], { calendarConfigured: false, youtubeConfigured: false });
  await app.flush();
  app.elements.get('enter-focus-space').click();
  assert.equal(app.document.body.dataset.view, 'focus');
  app.mutateState({ ...app.state(), selectedId: 'role:developer', extraMonitorPreference: 7 });
  app.elements.get('fs-start').click();
  assert.equal(app.state().selectedId, 'role:developer');
  assert.equal(app.state().extraMonitorPreference, 7);
  assert.equal(app.state().focusSpace.timer.deadline, 1_501_000);
  app.elements.get('fs-back').click();
  assert.equal(app.document.body.dataset.view, 'universe');
  assert.deepEqual(app.viewChanges, ['universe', 'focus', 'universe']);
  await app.advance(1_500_000);
  assert.equal(app.state().focusSpace.timer.completedSessions, 1, 'Timer completes while outside FocusSpace');
  await app.advance(5_000);
  assert.equal(app.state().focusSpace.timer.completedSessions, 1);
  app.ui.destroy();
  assert.equal(app.intervals.size, 0);
});

test('calendar events and free gaps choose a focus duration while private agenda content stays out of persistence', async () => {
  const app = harness(); app.ui.open();
  app.answer(app.messages[0], { calendarConfigured: false, youtubeConfigured: false }); await app.flush();
  app.elements.get('fs-calendar-connect').click();
  const request = app.messages.at(-1);
  assert.equal(request.action, 'calendar-connect');
  app.answer(request, { configured: true, events: [{ id: 'private-1', title: '<script>Private appointment</script>', start: '1970-01-01T10:00:00Z', end: '1970-01-01T10:30:00Z', allDay: false, busy: true }],
    warnings: [], slots: [{ start: '1970-01-01T12:00:00Z', end: '1970-01-01T12:45:00Z' }] });
  await app.flush();
  const events = app.elements.get('fs-agenda-list');
  assert.match(events.textContent, /Private appointment/);
  assert.equal(events.children[0].children[0].tagName, 'SPAN');
  events.children[0].click();
  assert.equal(app.ui.getState().timer.durationMs, 1_800_000);
  assert.equal(app.elements.get('fs-task').value, '<script>Private appointment</script>');
  app.elements.get('fs-slots').children[0].click();
  assert.equal(app.ui.getState().timer.durationMs, 2_700_000);
  assert.doesNotMatch(JSON.stringify(app.state()), /Private appointment|private-1|events|slots/);
  app.elements.get('fs-agenda-range').value = '7'; app.elements.get('fs-agenda-range').emit('change');
  const refresh = app.messages.at(-1);
  assert.equal(refresh.action, 'calendar-refresh');
  assert.equal(Date.parse(refresh.from), 1_000, 'Free windows begin now, never earlier today');
  assert.ok(Date.parse(refresh.to) > 518_400_000 && Date.parse(refresh.to) <= 604_800_000, 'The window ends at local midnight after the seventh day');
  assert.equal(typeof refresh.timeZone, 'string');
  app.ui.destroy(); await app.flush();
});

test('unlink cancels older calendar work and a delayed connection cannot restore private agenda content', async () => {
  const app = harness(); app.ui.open(); app.answer(app.messages[0], {}); await app.flush();
  app.elements.get('fs-calendar-connect').click(); const connect = app.messages.at(-1);
  app.elements.get('fs-calendar-disconnect').click(); const disconnect = app.messages.at(-1);
  assert.equal(disconnect.action, 'calendar-disconnect');
  assert.ok(app.messages.some(item => item.action === 'cancel' && item.request_id === connect.request_id));
  app.answer(disconnect, {}); await app.flush();
  app.answer(connect, { configured: true, events: [{ id: 'late', title: 'Must not return', start: '1970-01-01T01:00:00Z', end: '1970-01-01T02:00:00Z' }] }); await app.flush();
  assert.equal(app.elements.get('fs-agenda-list').children.length, 0);
  assert.equal(app.elements.get('fs-calendar-disconnect').hidden, true);
  assert.doesNotMatch(app.elements.get('fs-agenda-status').textContent, /Connected/);
  app.ui.destroy();
});

test('city search requests host weather, renders 3 or 7 real forecast days, and location has a cancellable browser fallback', async () => {
  const app = harness(); app.ui.open(); app.answer(app.messages[0], {}); await app.flush();
  app.elements.get('fs-place-query').value = '  Da Lat  '; app.elements.get('fs-place-form').emit('submit');
  const search = app.messages.at(-1); assert.equal(search.action, 'place-search'); assert.equal(search.query, 'Da Lat');
  app.answer(search, [{ name: 'Da Lat', country: 'Vietnam', latitude: 11.94, longitude: 108.44 }]); await app.flush();
  app.elements.get('fs-place-results').children[0].click();
  const weather = app.messages.at(-1); assert.equal(weather.action, 'weather'); assert.equal(weather.latitude, 11.94);
  app.answer(weather, { location: { latitude: 11.94, longitude: 108.44, timezone: 'Asia/Ho_Chi_Minh' }, current: { temperature: 19.5, apparent: 19, weatherCode: 3, windSpeed: 9 },
    daily: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${23 + i}`, minimum: 15, maximum: 23, rainProbability: 60, weatherCode: 61 })), attribution: 'Open-Meteo · CC BY 4.0' }); await app.flush();
  assert.match(app.elements.get('fs-weather-current').textContent, /20°/);
  assert.match(app.elements.get('fs-weather-current').textContent, /Da Lat/);
  assert.equal(app.elements.get('fs-forecast').children.length, 3);
  app.elements.get('fs-forecast-7').click(); assert.equal(app.elements.get('fs-forecast').children.length, 7);
  app.elements.get('fs-weather-location').click();
  const location = app.messages.at(-1); assert.equal(location.action, 'weather-location');
  await app.advance(21_000); assert.equal(app.ui.getState().pending, 1, 'Browser permission has 120 seconds, not 20');
  app.elements.get('fs-cancel').click(); await app.flush();
  assert.ok(app.messages.some(item => item.action === 'cancel' && item.request_id === location.request_id));
  assert.match(app.elements.get('fs-status').textContent, /cancelled/i);
  assert.doesNotMatch(JSON.stringify(app.state()), /11\.94|108\.44|Da Lat/);
  app.ui.destroy();
});

test('ordinary requests time out and cancel at 20 seconds while interactive prompts last 120 seconds; late responses are ignored', async () => {
  const app = harness(); app.ui.open(); app.answer(app.messages[0], {}); await app.flush();
  app.elements.get('fs-place-query').value = 'Hanoi'; app.elements.get('fs-place-form').emit('submit');
  const search = app.messages.at(-1); await app.advance(20_001);
  assert.match(app.elements.get('fs-status').textContent, /timed out/i);
  app.answer(search, [{ name: 'Late result', latitude: 1, longitude: 2 }]); await app.flush();
  assert.equal(app.elements.get('fs-place-results').children.length, 0);
  app.elements.get('fs-calendar-connect').click(); const calendar = app.messages.at(-1);
  await app.advance(21_000); assert.equal(app.ui.getState().pending, 1);
  await app.advance(100_000); assert.equal(app.ui.getState().pending, 0);
  assert.ok(app.messages.some(item => item.action === 'cancel' && item.request_id === calendar.request_id));
  app.ui.destroy(); assert.equal(app.timeouts.size, 0);
});

test('YouTube stays unloaded until explicit selection, reports embed errors, and stops when the view closes', async () => {
  const app = harness({ focusSpace: { youtubeUrl: 'https://youtu.be/M7lc1UVf-VE' } }); app.ui.open();
  app.answer(app.messages[0], { youtubeConfigured: true }); await app.flush();
  assert.equal(app.document.head.children.length, 0);
  assert.equal(app.elements.get('fs-youtube-player').children.length, 0, 'Restoring preferences never loads remote media');
  let callbacks, destroyed = 0;
  app.window.YT = { Player: class { constructor(_frame, options) { callbacks = options.events; } destroy() { destroyed++; } } };
  app.elements.get('fs-youtube-form').emit('submit'); await app.flush();
  const frame = app.elements.get('fs-youtube-player').children[0];
  assert.equal(frame.tagName, 'IFRAME');
  assert.match(frame.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\//);
  assert.equal(new URL(frame.src).searchParams.get('autoplay'), '0');
  callbacks.onError({ data: 153 });
  assert.match(app.elements.get('fs-youtube-status').textContent, /Open on YouTube/);
  app.elements.get('fs-youtube-open').click();
  const open = app.messages.at(-1); assert.equal(open.action, 'youtube-open'); assert.equal(open.url, 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  app.answer(open, {}); await app.flush();
  app.ui.back(); assert.equal(destroyed, 1); assert.equal(app.elements.get('fs-youtube-player').children.length, 0);
  app.ui.destroy();
});

test('original ambience starts only by user action, persists volume, and releases audio when hidden or destroyed', async () => {
  const app = harness(); app.ui.open(); app.answer(app.messages[0], {}); await app.flush();
  let opened = 0, closed = 0;
  const audioNode = () => ({ connect() {}, start() {}, stop() {}, frequency: { value: 0 }, gain: { value: 0, setTargetAtTime() {} }, Q: { value: 0 } });
  app.window.AudioContext = class {
    constructor() { opened++; this.sampleRate = 8_000; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    close() { closed++; return Promise.resolve(); }
    createGain() { return audioNode(); }
    createOscillator() { return audioNode(); }
    createBufferSource() { return audioNode(); }
    createBiquadFilter() { return audioNode(); }
    createBuffer(_channels, size) { return { getChannelData: () => new Float32Array(size) }; }
  };
  assert.equal(opened, 0);
  app.elements.get('fs-audio-toggle').click(); await app.flush();
  assert.equal(opened, 1); assert.equal(app.elements.get('fs-audio-toggle').getAttribute('aria-pressed'), 'true');
  app.elements.get('fs-volume').value = '63'; app.elements.get('fs-volume').emit('input');
  assert.equal(app.state().focusSpace.volume, .63);
  app.document.hidden = true; app.document.body.emit('visibilitychange'); await app.flush();
  assert.equal(closed, 1); assert.equal(app.elements.get('fs-audio-toggle').getAttribute('aria-pressed'), 'false');
  app.document.hidden = false; app.elements.get('fs-playlist').value = 'shore'; app.elements.get('fs-playlist').emit('change');
  app.elements.get('fs-audio-toggle').click(); await app.flush();
  assert.equal(opened, 2); assert.equal(app.state().focusSpace.playlist, 'shore');
  app.ui.destroy(); await app.flush(); assert.equal(closed, 2);
  assert.equal(app.timeouts.size, 0);
});

test('Earth covers the current scene before revealing FocusSpace and returns without changing the monitor camera', async () => {
  const app = harness({ selectedId: 'role:manager', camera: { zoom: 2.4 } }, { reduced: false, getTransitionOrigin: () => ({ x: 300, y: 220, radius: 42 }) });
  app.answer(app.messages[0], {}); await app.flush(); app.ui.open();
  assert.equal(app.document.body.dataset.view, 'universe', 'The universe remains visible during the approach');
  assert.equal(app.elements.get('fs-transition').hidden, false);
  await app.advance(650);
  assert.equal(app.document.body.dataset.view, 'focus');
  assert.equal(app.viewChanges.at(-1), 'focus');
  await app.advance(800); assert.equal(app.elements.get('fs-transition').hidden, true);
  app.ui.back(); assert.equal(app.document.body.dataset.view, 'focus');
  await app.advance(650); assert.equal(app.document.body.dataset.view, 'universe');
  assert.deepEqual(app.state().camera, { zoom: 2.4 }); assert.equal(app.state().selectedId, 'role:manager');
  app.ui.destroy(); assert.equal(app.timeouts.size, 0); assert.equal(app.elements.get('fs-transition').hidden, true);
});
