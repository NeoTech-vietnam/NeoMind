import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { createYouTubePlayer } = require('../extensions/vscode-model-bridge/focus-youtube.cjs');
function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('YouTube loopback wrapper provides real browser origin, no autoplay and origin-only referrer policy', async t => {
  const session = await createYouTubePlayer({ url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' });
  t.after(() => session.close());
  const url = new URL(session.url);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  assert.match(url.pathname, /^\/neomind-youtube\/[A-Za-z0-9_-]{43}$/);
  const response = await get(session.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.match(response.body, /origin:window\.location\.origin/);
  assert.match(response.body, /history\.replaceState\(null,'','\/neomind-youtube\/player'\)/);
  assert.match(response.body, /autoplay:0/);
  assert.match(response.body, /"video":"M7lc1UVf-VE"/);
  assert.match(response.body, /neomind-youtube',event,code/);
  assert.doesNotMatch(response.body, /setRequestHeader|api[_-]?key|Authorization|github\.com|example\.com/);
  assert.doesNotMatch(response.body, new RegExp(url.pathname.slice(1)));
  await session.close(); await session.close();
  await assert.rejects(get(session.url));
});

test('wrapper rejects unknown routes, methods and forged Host without serving a general proxy', async t => {
  const session = await createYouTubePlayer({ url: 'https://youtu.be/M7lc1UVf-VE' }); t.after(() => session.close());
  assert.equal((await get(new URL('/https://youtube.com/', session.url))).status, 404);
  assert.equal((await get(`${session.url}?target=https://example.com`)).status, 404);
  assert.equal((await get(session.url, { method: 'POST' })).status, 405);
  assert.equal((await get(session.url, { method: 'HEAD' })).status, 405);
  assert.equal((await get(session.url, { headers: { Host: 'attacker.invalid' } })).status, 421);
});

test('only explicit allowlisted YouTube video and playlist identifiers are accepted', async t => {
  for (const url of ['http://youtube.com/watch?v=M7lc1UVf-VE', 'https://attacker.invalid/watch?v=M7lc1UVf-VE',
    'https://youtube.com.evil.invalid/watch?v=M7lc1UVf-VE', 'https://name:password@youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com:20128/watch?v=M7lc1UVf-VE', 'https://youtube.com/watch?v=<script>', 'file:///private/file',
    'https://youtube.com/playlist?list=too-short', 'https://youtube.com/watch?v=M7lc1UVf-VE&list=bad'])
    await assert.rejects(createYouTubePlayer({ url }), /valid HTTPS YouTube/);
  const session = await createYouTubePlayer({ url: 'https://music.youtube.com/playlist?list=PL1234567890123' }); t.after(() => session.close());
  assert.match((await get(session.url)).body, /"list":"PL1234567890123"/);
  const embedded = await createYouTubePlayer({ url: 'https://www.youtube.com/embed/videoseries?list=PL1234567890123' }); t.after(() => embedded.close());
  assert.doesNotMatch((await get(embedded.url)).body, /"video":"videoseries"/);
});

test('abort closes a session and unsupported remote origins fail with browser fallback', async () => {
  const controller = new AbortController();
  const session = await createYouTubePlayer({ url: 'https://youtu.be/M7lc1UVf-VE', signal: controller.signal });
  controller.abort(); await session.close(); await assert.rejects(get(session.url));
  await assert.rejects(createYouTubePlayer({ url: 'https://youtu.be/M7lc1UVf-VE', signal: controller.signal }), /cancelled/);
  let local;
  await assert.rejects(createYouTubePlayer({ url: 'https://youtu.be/M7lc1UVf-VE', asExternalUri: value => {
    local = value; const rewritten = new URL(value); rewritten.protocol = 'https:'; rewritten.hostname = 'forwarded.invalid'; return rewritten.href;
  } }), /remote connection.*Open on YouTube/);
  await assert.rejects(get(local));
});

function documentController(html) {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'The actual served player document has one executable controller.');
  const status = { textContent: '' }, messages = [], timers = new Map(), scripts = [], facts = { created: 0, destroyed: 0, played: 0, events: undefined, options: undefined };
  let sequence = 0;
  const window = { location: { origin: 'http://127.0.0.1:12345' } };
  const scope = { window, history: { replaceState() {} }, parent: { postMessage: message => messages.push(message) },
    document: { getElementById: () => status, createElement: () => ({}), head: { appendChild: script => scripts.push(script) } },
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    YT: { Player: function (_id, options) { facts.created++; facts.events = options.events; facts.options = options; return { destroy() { facts.destroyed++; }, playVideo() { facts.played++; } }; } } };
  runInNewContext(script, scope);
  const deadline = () => { const timer = [...timers.values()].find(timer => timer.delay === 30000); assert.ok(timer); timer.callback(); };
  return { status, messages, timers, scripts, facts, window, deadline };
}

test('actual player controller bounds API loading and ignores late readiness after failure without playback or retry', async t => {
  const session = await createYouTubePlayer({ url: 'https://youtu.be/M7lc1UVf-VE' }); t.after(() => session.close());
  const html = (await get(session.url)).body;
  const missingApi = documentController(html);
  missingApi.deadline(); missingApi.window.onYouTubeIframeAPIReady();
  assert.match(missingApi.status.textContent, /did not become ready.*Open on YouTube/);
  assert.equal(missingApi.facts.created, 0); assert.equal(missingApi.messages.length, 1); assert.equal(missingApi.scripts.length, 1);
  const latePlayer = documentController(html);
  latePlayer.window.onYouTubeIframeAPIReady(); latePlayer.deadline(); latePlayer.facts.events.onReady();
  latePlayer.facts.events.onStateChange({ data: 1 });
  assert.match(latePlayer.status.textContent, /did not become ready/);
  assert.equal(latePlayer.messages.length, 1); assert.equal(latePlayer.messages[0].event, 'error');
  assert.ok(latePlayer.facts.destroyed >= 1); assert.equal(latePlayer.facts.played, 0); assert.equal(latePlayer.scripts.length, 1);
  const networkError = documentController(html);
  networkError.scripts[0].onerror(); networkError.window.onYouTubeIframeAPIReady();
  assert.match(networkError.status.textContent, /could not load.*Open on YouTube/);
  assert.equal(networkError.facts.created, 0); assert.equal(networkError.messages[0].event, 'error');
  const ready = documentController(html);
  ready.window.onYouTubeIframeAPIReady(); ready.facts.events.onReady();
  assert.equal(ready.status.textContent, 'Press Play to listen.');
  assert.ok(![...ready.timers.values()].some(timer => timer.delay === 30000));
  assert.equal(ready.facts.options.playerVars.autoplay, 0); assert.equal(ready.facts.played, 0);
});
