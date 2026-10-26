import test from 'node:test';
import assert from 'node:assert/strict';
import { VSCodeModelSelection } from '../dist/vscode-model-selection.js';

const selector = { vendor: 'customendpoint', id: 'top-models' };
const handle = (id = selector.id, vendor = selector.vendor) => ({ id, vendor, sendRequest() {} });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function fixture(t, events = true) {
  const listeners = new Set(), calls = [];
  let active = true, respond = requested => [handle(requested.id, requested.vendor)], disposed = 0;
  const lm = { selectChatModels(requested) { calls.push(requested); return respond(requested); } };
  if (events) lm.onDidChangeChatModels = listener => { listeners.add(listener); return { dispose() { listeners.delete(listener); disposed++; } }; };
  const owner = new VSCodeModelSelection(lm, () => active);
  t.after(() => owner.close());
  return { owner, calls, listeners, setReply(value) { respond = value; }, setActive(value) { active = value; },
    change() { for (const listener of listeners) listener(); }, get disposed() { return disposed; } };
}

test('a successful same-owner exact handle avoids a later provider selection hang', async t => {
  const f = fixture(t), model = handle(); f.setReply(() => [model]);
  assert.deepEqual(await f.owner.select(selector), [model]);
  f.setReply(() => new Promise(() => {}));
  assert.deepEqual(await f.owner.select(selector), [model]);
  assert.equal(f.calls.length, 1, 'The second role uses the already selected exact SDK handle, not another hanging lookup.');
});

test('exact model/vendor changes select independently while returning to a valid known handle is allowed', async t => {
  const f = fixture(t), first = (await f.owner.select(selector))[0];
  assert.equal((await f.owner.select({ ...selector, id: 'worker-models' }))[0].id, 'worker-models');
  assert.equal((await f.owner.select({ ...selector, vendor: 'other-provider' }))[0].vendor, 'other-provider');
  assert.equal((await f.owner.select(selector))[0], first); assert.equal(f.calls.length, 3);
});

test('concurrent identical selections share one SDK query within the same catalog generation', async t => {
  const f = fixture(t); let resolve;
  f.setReply(() => new Promise(done => { resolve = done; }));
  const a = f.owner.select(selector), b = f.owner.select(selector); await flush();
  assert.equal(f.calls.length, 1);
  const model = handle(); resolve([model]);
  assert.deepEqual(await Promise.all([a, b]), [[model], [model]]);
});

test('catalog change invalidates handles and rejects old pending work without caching its late completion', async t => {
  const f = fixture(t); await f.owner.select(selector); f.change();
  let resolve;
  f.setReply(() => new Promise(done => { resolve = done; }));
  const pending = f.owner.select(selector), rejected = assert.rejects(pending, /catalog changed/); await flush();
  f.change(); await rejected; resolve([handle()]); await flush();
  const next = handle(); f.setReply(() => [next]);
  assert.equal((await f.owner.select(selector))[0], next); assert.equal(f.calls.length, 3);
});

test('close disposes catalog subscription and rejects pending selection before any late response can be reused', async t => {
  const f = fixture(t); let resolve;
  f.setReply(() => new Promise(done => { resolve = done; }));
  const pending = f.owner.select(selector), rejected = assert.rejects(pending, /Host closed/); await flush();
  f.owner.close(); await rejected;
  assert.equal(f.disposed, 1); assert.equal(f.listeners.size, 0);
  resolve([handle()]); await flush();
  await assert.rejects(f.owner.select(selector), /Host closed/); assert.equal(f.calls.length, 1);
});

test('without catalog events, selection remains fresh and workspace revocation cannot use a cached handle', async t => {
  const noEvents = fixture(t, false); await noEvents.owner.select(selector); await noEvents.owner.select(selector);
  assert.equal(noEvents.calls.length, 2);
  const withEvents = fixture(t); await withEvents.owner.select(selector); withEvents.setActive(false);
  await assert.rejects(withEvents.owner.select(selector), /Host closed/); assert.equal(withEvents.calls.length, 1);
});

test('empty, ambiguous or mismatched results never become a selected handle', async t => {
  for (const result of [[], [handle(), handle()], [handle(selector.id, 'wrong-vendor')]]) {
    const f = fixture(t); f.setReply(() => result);
    if (!result.length) assert.deepEqual(await f.owner.select(selector), []);
    else await assert.rejects(f.owner.select(selector), /ambiguous or mismatched/);
    f.setReply(() => [handle()]); assert.equal((await f.owner.select(selector)).length, 1); assert.equal(f.calls.length, 2);
  }
});

test('a cold SDK lookup still has the unchanged ten-second timeout and a failed lookup is not cached', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.setReply(() => new Promise(() => {}));
  const pending = f.owner.select(selector), rejected = assert.rejects(pending, /model selection timed out/); await flush();
  t.mock.timers.tick(10000); await rejected;
  f.setReply(() => [handle()]); assert.equal((await f.owner.select(selector)).length, 1); assert.equal(f.calls.length, 2);
});
