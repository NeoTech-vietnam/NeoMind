import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { request as httpRequest } from 'node:http';

const require = createRequire(import.meta.url);
const { requestBrowserLocation } = require('../extensions/vscode-model-bridge/focus-location.cjs');
const hostSource = readFileSync(new URL('../extensions/vscode-model-bridge/focus-host.cjs', import.meta.url), 'utf8');
const calendarSecret = 'https://calendar.example/private-fixture-secret.ics';
const youtubeSecret = 'fixture-only-youtube-secret-value';
const clone = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(t, overrides = {}) {
  const sent = [], calls = [], prompts = [], opened = [], storage = new Map(), timers = new Set();
  let active = true;
  const secrets = {
    async get(key) { return storage.get(key); },
    async store(key, value) {
      if (overrides.secretStore) return overrides.secretStore(key, value, storage);
      storage.set(key, value);
    },
    async delete(key) {
      if (overrides.secretDelete) return overrides.secretDelete(key, storage);
      storage.delete(key);
    },
  };
  const calendar = { events: [{ id: 'meeting-1', title: 'Fixture meeting' }], slots: [], warnings: [] };
  const runtime = {
    async focusWeather(latitude, longitude, options) { calls.push(['weather', latitude, longitude, options]); return { temperature: 28 }; },
    async focusPlaceSearch(query, options) { calls.push(['place-search', query, options]); return { places: [{ name: 'Fixture city' }] }; },
    focusCalendar(ics, message) { calls.push(['calendar-import', ics, message]); return clone(calendar); },
    async focusCalendarFeed(feed, message, options) { calls.push(['calendar-feed', feed, message, options]); return clone(calendar); },
    async focusYouTubeSearch(query, key, options) { calls.push(['youtube-search', query, key, options]); return { videos: [{ id: 'M7lc1UVf-VE', title: 'Fixture music' }] }; },
    ...overrides,
  };
  const module = { exports: {} };
  runInNewContext(hostSource, {
    module, URL, AbortController, Error,
    require(name) {
      assert.equal(name, './focus-location.cjs');
      return { async requestBrowserLocation(options) {
        calls.push(['location', options]);
        if (overrides.location) return overrides.location(options);
        return { latitude: 10.77, longitude: 106.69 };
      } };
    },
    setTimeout(fn, delay) { const timer = { fn, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  }, { filename: 'focus-host.cjs' });
  const host = module.exports.createFocusHost({
    vscode: { Uri: { parse: value => value }, CancellationTokenSource: overrides.CancellationTokenSource,
      env: { async openExternal(value) { opened.push(value); return true; } },
      window: { async showInputBox(options, token) {
        calls.push(['input', options]);
        return overrides.showInputBox ? overrides.showInputBox(options, token) : prompts.shift();
      } } },
    context: { secrets }, runtime, alive: () => active, post: async value => sent.push(clone(value)),
  });
  t.after(() => host.dispose());
  return { host, sent, calls, prompts, opened, storage, timers, setAlive(value) { active = value; },
    send(action, data = {}, request_id = 'request') { return host.handle({ type: 'focus-space', request_id, action, ...data }); } };
}

function noSecrets(values) {
  const serialized = JSON.stringify(values);
  assert.equal(serialized.includes(calendarSecret), false);
  assert.equal(serialized.includes(youtubeSecret), false);
}

test('focus host keeps calendar and YouTube credentials in SecretStorage and returns only service data', async t => {
  const app = harness(t);
  await app.send('status');
  assert.deepEqual(app.sent.at(-1).data, { calendarConfigured: false, youtubeConfigured: false });
  app.prompts.push(calendarSecret);
  await app.send('calendar-connect', { windowStart: '2030-01-01T00:00:00Z' });
  assert.equal(app.storage.get('neomind.focus.calendarFeed'), calendarSecret);
  assert.equal(app.calls.find(call => call[0] === 'calendar-feed')[1], calendarSecret);
  assert.equal(app.sent.at(-1).data.configured, true);
  await app.send('calendar-refresh');
  assert.equal(app.calls.filter(call => call[0] === 'calendar-feed').length, 2);
  app.prompts.push(youtubeSecret);
  await app.send('youtube-configure');
  assert.equal(app.storage.get('neomind.focus.youtubeApiKey'), youtubeSecret);
  await app.send('youtube-search', { query: 'instrumental' });
  const search = app.calls.find(call => call[0] === 'youtube-search');
  assert.equal(search[1], 'instrumental');
  assert.equal(search[2], youtubeSecret);
  assert.equal(search[3].signal instanceof AbortSignal, true);
  assert.equal(app.sent.at(-1).data.videos[0].id, 'M7lc1UVf-VE');
  assert.ok(app.calls.filter(call => call[0] === 'input').every(call => call[1].password === true));
  await app.send('calendar-disconnect');
  assert.equal(app.storage.has('neomind.focus.calendarFeed'), false);
  assert.equal(app.sent.at(-1).data.configured, false);
  noSecrets(app.sent);
});

test('focus host rejects unknown actions and malformed envelopes without running services or opening links', async t => {
  const app = harness(t);
  for (const action of ['weather-admin', 'calendar-connect-extra', 'youtube-open-extra', 'constructor', '__proto__'])
    await app.send(action, { url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' });
  for (const value of [null, {}, { type: 'other', action: 'weather', request_id: 'ok' },
    { type: 'focus-space', action: 'weather', request_id: '' },
    { type: 'focus-space', action: 'weather', request_id: 'x'.repeat(81) },
    { type: 'focus-space', action: 'weather', request_id: 'has space' }]) await app.host.handle(value);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.sent, []);
  assert.deepEqual(app.opened, []);
});

test('focus host never reflects private provider errors even when they begin with a familiar service prefix', async t => {
  const app = harness(t, {
    async focusWeather() { throw new Error(`Weather upstream failed: ${calendarSecret}`); },
    async focusYouTubeSearch() { throw new Error(`YouTube upstream failed with key ${youtubeSecret}`); },
  });
  app.storage.set('neomind.focus.youtubeApiKey', youtubeSecret);
  await app.send('weather', { latitude: 0, longitude: 0 });
  await app.send('youtube-search', { query: 'ambient' });
  assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(result => result.ok === false));
  noSecrets(app.sent);
});

test('focus host opens only HTTPS YouTube hosts and rejects credentials, alternate ports and lookalikes', async t => {
  const app = harness(t);
  for (const url of ['javascript:alert(1)', 'http://youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com.evil.example/', 'https://user:password@youtube.com/',
    'https://www.youtube.com:444/watch?v=M7lc1UVf-VE', 'https://youtube.com@evil.example/', 'not a URL']) {
    await app.send('youtube-open', { url });
    assert.equal(app.sent.at(-1).ok, false, url);
  }
  assert.deepEqual(app.opened, []);
  for (const url of ['https://www.youtube.com/watch?v=M7lc1UVf-VE', 'https://youtu.be/M7lc1UVf-VE',
    'https://music.youtube.com/playlist?list=PL_fixture']) {
    await app.send('youtube-open', { url });
    assert.equal(app.sent.at(-1).data.opened, true);
  }
  assert.equal(app.opened.length, 3);
});

test('focus host cancels exact pending requests, bounds concurrency and suppresses late results after disposal', async t => {
  const operations = [];
  const app = harness(t, { focusWeather(latitude, longitude, { signal }) {
    const value = deferred(); operations.push({ signal, ...value });
    signal.addEventListener('abort', () => value.reject(new Error('fixture request cancelled')), { once: true });
    return value.promise;
  } });
  const pending = Array.from({ length: 8 }, (_, i) => app.send('weather', { latitude: i, longitude: 0 }, `work-${i}`));
  await app.send('weather', {}, 'work-0');
  await app.send('weather', {}, 'overflow');
  assert.equal(operations.length, 8, 'Duplicate IDs and a ninth pending request cannot add work.');
  await app.send('cancel', {}, 'work-0');
  await pending[0];
  assert.equal(operations[0].signal.aborted, true);
  assert.match(app.sent[0].error, /cancelled|timed out/);
  assert.equal(app.sent[0].request_id, 'work-0');
  app.host.dispose();
  await Promise.all(pending.slice(1));
  assert.ok(operations.every(operation => operation.signal.aborted));
  assert.equal(app.sent.length, 1, 'Disposed panels receive no further results.');
  await app.send('status', {}, 'after-disposal');
  assert.equal(app.sent.length, 1);
});

test('focus host deadlines abort services and browser-location requests use the longer interactive deadline', async t => {
  const signals = [];
  function waiting({ signal }) { signals.push(signal); return new Promise((resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('fixture timeout')), { once: true })); }
  const app = harness(t, { focusWeather(latitude, longitude, options) { return waiting(options); }, location: waiting });
  const weather = app.send('weather', { latitude: 1, longitude: 2 }, 'weather');
  const weatherTimer = [...app.timers].find(timer => timer.delay === 25000);
  assert.ok(weatherTimer);
  weatherTimer.fn(); await weather;
  assert.equal(signals[0].aborted, true);
  const location = app.send('weather-location', {}, 'location');
  const locationTimer = [...app.timers].find(timer => timer.delay === 125000);
  assert.ok(locationTimer, 'The browser permission interaction has its own bounded deadline.');
  locationTimer.fn(); await location;
  assert.equal(signals[1].aborted, true);
  assert.ok(app.sent.every(result => result.ok === false && /cancelled or timed out/.test(result.error)));
});

test('focus host imports calendar data, searches places and obtains location through the injected browser boundary', async t => {
  const app = harness(t);
  await app.send('calendar-import', { ics: 'BEGIN:VCALENDAR\nEND:VCALENDAR' });
  assert.equal(app.sent.at(-1).data.configured, false);
  assert.equal(app.sent.at(-1).data.events.length, 1);
  await app.send('place-search', { query: 'Fixture city' });
  assert.equal(app.sent.at(-1).data.places[0].name, 'Fixture city');
  await app.send('weather-location');
  const weather = app.calls.find(call => call[0] === 'weather');
  assert.deepEqual(weather.slice(1, 3), [10.77, 106.69]);
  assert.equal(app.sent.at(-1).data.temperature, 28);
  app.setAlive(false);
  const count = app.sent.length;
  await app.send('status');
  assert.equal(app.sent.length, count);
  assert.equal(app.storage.size, 0, 'Imported calendar and approximate location are not saved as credentials.');
});

test('calendar disconnect revokes a delayed connection fetch and suppresses its stale reply', async t => {
  const entered = deferred(), release = deferred(); let signal;
  const app = harness(t, { focusCalendarFeed(feed, message, options) {
    signal = options.signal; entered.resolve(); return release.promise;
  } });
  app.prompts.push(calendarSecret);
  const connect = app.send('calendar-connect', {}, 'connect'); await entered.promise;
  await app.send('calendar-disconnect', {}, 'disconnect');
  release.resolve({ events: [{ id: 'stale' }], warnings: [], slots: [] }); await connect;
  assert.equal(signal.aborted, true);
  assert.equal(app.storage.has('neomind.focus.calendarFeed'), false);
  assert.deepEqual(app.sent.map(message => message.action), ['calendar-disconnect']);
  assert.equal(app.sent[0].data.configured, false);
});

test('new calendar imports cancel older refreshes and prevent old agendas from replacing the current source', async t => {
  const entered = deferred(), release = deferred(); let signal;
  const app = harness(t, { focusCalendarFeed(feed, message, options) {
    signal = options.signal; entered.resolve(); return release.promise;
  } });
  app.storage.set('neomind.focus.calendarFeed', calendarSecret);
  const refresh = app.send('calendar-refresh', {}, 'refresh'); await entered.promise;
  await app.send('calendar-import', { ics: 'BEGIN:VCALENDAR\nEND:VCALENDAR' }, 'import');
  release.resolve({ events: [{ id: 'outdated-feed' }], warnings: [], slots: [] }); await refresh;
  assert.equal(signal.aborted, true);
  assert.deepEqual(app.sent.map(message => message.action), ['calendar-import']);
  assert.equal(app.sent[0].data.configured, false);
});

test('calendar disconnect cancels the native credential prompt and ignores a late prompt value', async t => {
  const prompt = deferred(), entered = deferred(); let token, cancelled = 0, disposed = 0;
  class CancellationTokenSource {
    constructor() { this.token = { isCancellationRequested: false }; }
    cancel() { this.token.isCancellationRequested = true; cancelled++; }
    dispose() { disposed++; }
  }
  const app = harness(t, { CancellationTokenSource, showInputBox(options, value) {
    token = value; entered.resolve(); return prompt.promise;
  } });
  app.storage.set('neomind.focus.calendarFeed', calendarSecret);
  const connect = app.send('calendar-connect', {}, 'connect'); await entered.promise;
  await app.send('calendar-disconnect', {}, 'disconnect');
  prompt.resolve(calendarSecret); await connect;
  assert.equal(cancelled, 1);
  assert.equal(token.isCancellationRequested, true);
  assert.equal(disposed, 1);
  assert.equal(app.calls.some(call => call[0] === 'calendar-feed'), false);
  assert.equal(app.storage.has('neomind.focus.calendarFeed'), false);
  assert.deepEqual(app.sent.map(message => message.action), ['calendar-disconnect']);
});

test('calendar unlink waits for an in-flight SecretStorage write and deletes the final value', async t => {
  const entered = deferred(), release = deferred(), order = [];
  const app = harness(t, {
    async secretStore(key, value, storage) {
      order.push('store-start'); entered.resolve(); await release.promise;
      storage.set(key, value); order.push('store-end');
    },
    async secretDelete(key, storage) { storage.delete(key); order.push('delete'); },
  });
  app.prompts.push(calendarSecret);
  const connect = app.send('calendar-connect', {}, 'connect'); await entered.promise;
  let unlinked = false;
  const disconnect = app.send('calendar-disconnect', {}, 'disconnect').then(() => { unlinked = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(unlinked, false, 'Unlink cannot complete before an earlier storage write settles.');
  release.resolve(); await Promise.all([connect, disconnect]);
  assert.deepEqual(order, ['store-start', 'store-end', 'delete']);
  assert.equal(app.storage.has('neomind.focus.calendarFeed'), false);
  assert.deepEqual(app.sent.map(message => message.action), ['calendar-disconnect']);
});

function localRequest(value, { method = 'GET', headers = {}, body = '' } = {}) {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1', 'Tests must never contact external services.');
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', value => chunks.push(value));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.setTimeout(1500, () => request.destroy(new Error('Fixture HTTP deadline exceeded.')));
    request.on('error', reject); request.end(body);
  });
}

async function locationServer(t) {
  const controller = new AbortController(), ready = deferred();
  const result = requestBrowserLocation({ signal: controller.signal, timeoutMs: 5000,
    onReady: ready.resolve, open: async () => true });
  result.catch(() => {});
  t.after(() => controller.abort());
  const url = await ready.promise;
  return { controller, result, url, origin: new URL(url).origin };
}

test('location helper binds loopback and requires the one-shot token, exact host and same-origin JSON', async t => {
  const app = await locationServer(t), url = new URL(app.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/[a-f0-9]{48}$/);
  const page = await localRequest(app.url);
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(page.body, /navigator\.geolocation\.getCurrentPosition/);
  assert.equal((await localRequest(`${app.origin}/wrong-token`)).status, 404);
  assert.equal((await localRequest(app.url, { headers: { Host: 'localhost' } })).status, 404);
  const body = JSON.stringify({ latitude: 10.77, longitude: 106.69 });
  for (const headers of [{ 'Content-Type': 'application/json' },
    { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    { Origin: app.origin, 'Content-Type': 'text/plain' }])
    assert.equal((await localRequest(app.url, { method: 'POST', headers, body })).status, 405);
  const posted = await localRequest(app.url, { method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body });
  assert.equal(posted.status, 200);
  assert.deepEqual(await app.result, { latitude: 10.77, longitude: 106.69 });
  await assert.rejects(localRequest(app.url), /ECONNREFUSED|ECONNRESET|socket hang up/);
});

test('location helper rejects malformed, nonfinite, out-of-range and oversized coordinates without settling successfully', async t => {
  const app = await locationServer(t), headers = { Origin: app.origin, 'Content-Type': 'application/json' };
  for (const body of ['not JSON', 'null', '{}', JSON.stringify({ latitude: '10', longitude: 20 }),
    JSON.stringify({ latitude: null, longitude: 20 }), JSON.stringify({ latitude: 91, longitude: 20 }),
    JSON.stringify({ latitude: 10, longitude: -181 })])
    assert.equal((await localRequest(app.url, { method: 'POST', headers, body })).status, 400);
  try {
    const excessive = await localRequest(app.url, { method: 'POST', headers,
      body: JSON.stringify({ latitude: 10, longitude: 20, padding: 'x'.repeat(1100) }) });
    assert.equal(excessive.status, 413);
  } catch (error) { assert.match(error.message, /ECONNRESET|socket hang up/); }
  const valid = await localRequest(app.url, { method: 'POST', headers, body: JSON.stringify({ latitude: -90, longitude: 180 }) });
  assert.equal(valid.status, 200);
  assert.deepEqual(await app.result, { latitude: -90, longitude: 180 });
});

test('location helper cancels before and after opening, times out, and sanitizes browser-open failures', async t => {
  const before = new AbortController(); before.abort(); let opened = 0;
  await assert.rejects(requestBrowserLocation({ signal: before.signal, open() { opened++; } }), /cancelled/);
  assert.equal(opened, 0);
  const app = await locationServer(t); app.controller.abort();
  await assert.rejects(app.result, /cancelled/);
  await assert.rejects(localRequest(app.url), /ECONNREFUSED|ECONNRESET|socket hang up/);
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(requestBrowserLocation({ timeoutMs: 25, open: async () => true }), /timed out/);
    await assert.rejects(requestBrowserLocation({ timeoutMs: 1000, open: async () => false }), /Browser could not open/);
    await assert.rejects(requestBrowserLocation({ timeoutMs: 1000, open: async () => { throw new Error(calendarSecret); } }),
      error => /Browser could not open/.test(error.message) && !error.message.includes(calendarSecret));
  } finally { clearTimeout(keepAlive); }
});
