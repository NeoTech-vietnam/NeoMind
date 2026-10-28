import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { initialize, createRecord, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, invocationIsActive } from '../dist/routing.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { startNative, waitNative, shutdownNative } from '../dist/native.js';
import { OpenCodeSession } from '../dist/opencode-session.js';
import { OpenCodeTurnObserver } from '../dist/opencode-turn.js';
import { reconcileOpenCodeOwner } from '../dist/opencode-engine.js';
import { localOpenAIProvider } from './helpers/local-openai-provider.mjs';

// Real pinned engine, private gateway, native signatures and model tool loop.
// The HTTP model peer is local scripted SSE: no paid provider or user workspace.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function project(t, provider) {
  const parent = resolve('artifacts/test-temp'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'wf-async-turn-'));
  initialize(root, { execution_engine: 'opencode' });
  mkdirSync(join(root, 'products')); writeFileSync(join(root, 'products/current.txt'), 'original\n');
  const catalog = join(root, 'models.json'); writeFileSync(catalog, JSON.stringify([{ name: 'fixture', vendor: 'customendpoint',
    models: [{ id: 'worker-models', url: provider.baseURL }, { id: 'top-models', url: provider.baseURL }] }]));
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify({ ...ensureRoutingPolicy(root), language_models_file: catalog }));
  const workflow = createRecord(root, { type: 'knowledge', title: 'Offline async engine protocol', data: { kind: 'manager-workflow' } });
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Retain scoped content and professional result', data: { workflow_id: workflow.meta.id } });
  const requestId = randomUUID(), traces = [], reports = [];
  const binding = { workflow_id: workflow.meta.id, task_id: task.meta.id, role: 'developer', stage: 'implementation', process_contract: 'workforce/v1',
    implementation_paths: ['products'], verification_paths: [], read_paths: ['products'], execution_steps: [], procedure_bound: false, cornell_bound: false };
  const release = registerControlledContext(root, requestId, { epoch_id: randomUUID(), binding, bindInvocation(id) { binding.invocation_id = id; },
    callbacks: { assertActive() {}, trace(event) { traces.push(event); }, saveReport(report) { reports.push(report); return { saved: true }; } } });
  t.after(async () => { await shutdownNative(root); release(); await provider.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, workflow, task, requestId, traces, reports, diagnostic: value => t.diagnostic(value) };
}
function observerPolicy(t, idle = 10000) {
  const previous = OpenCodeSession.prototype.createTurnObserver;
  OpenCodeSession.prototype.createTurnObserver = function (client, identity, options) {
    return new OpenCodeTurnObserver(client, identity, { ...options, model_idle_ms: idle, poll_ms: 25, http_timeout_ms: 1000 });
  };
  t.after(() => { OpenCodeSession.prototype.createTurnObserver = previous; });
}
async function run(fixture) {
  let receipt = await startNative(fixture.root, { role: 'developer', workflow_id: fixture.workflow.meta.id, task_id: fixture.task.meta.id,
    request_id: fixture.requestId, prompt: 'Offline scripted protocol fixture: use scoped tools and save one professional result.' });
  const deadline = Date.now() + 60000;
  while (invocationIsActive(receipt) && Date.now() < deadline) receipt = await waitNative(fixture.root, receipt.id, 100);
  if (receipt.error) fixture.diagnostic(JSON.stringify({ provider: 'loopback scripted OpenAI protocol only',
    native_session_observed: typeof receipt.native_thread_id === 'string',
    control_failures: fixture.traces.filter(event => event.event === 'engine-failure').map(event => ({
      operation: event.control_operation, error_name: event.error_name, transport_causes: event.transport_causes,
    })) }));
  return receipt;
}
const call = (name, args) => ({ toolCalls: [{ name: `wf_${name}`, arguments: args }] });

for (const lost of [false, true]) test(`real async native turn ${lost ? 'reconciles lost ACK and closed SSE' : 'completes only after the actual terminal assistant and saved report'}`, { timeout: 90000 }, async t => {
  observerPolicy(t);
  const provider = await localOpenAIProvider(index => [
    call('project_read', { path: 'products/current.txt', max_chars: 64000, start_line: 1, start_char: 0 }),
    call('task_file_write', { path: 'products/current.txt', content: 'verified 42\n' }),
    call('assignment_report', { summary: 'Saved the actual scoped output.', product_findings: [] }),
    { text: 'complete' },
  ][index] ?? { text: 'unexpected extra request' }, 6);
  const fixture = project(t, provider), originalFetch = globalThis.fetch;
  let submissions = 0, synchronous = 0, injected = 0;
  globalThis.fetch = async function (request, options) {
    const url = new URL(typeof request === 'string' ? request : request.url), method = request.method ?? options?.method;
    const response = await originalFetch(request, options);
    if (method === 'POST' && /\/prompt_async$/.test(url.pathname)) {
      submissions++;
      if (lost && !injected++) throw new TypeError('fetch failed', { cause: Object.assign(new Error('Injected lost admission response.'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) });
    }
    if (method === 'POST' && /\/message$/.test(url.pathname)) synchronous++;
    return response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  if (lost) {
    const previous = OpenCodeSession.prototype.observeEvents;
    OpenCodeSession.prototype.observeEvents = async function (stream) {
      await stream.next(); await stream.return(); // close an actual connected SSE iterator
    };
    t.after(() => { OpenCodeSession.prototype.observeEvents = previous; });
  }
  const receipt = await run(fixture);
  assert.equal(receipt.state, 'completed', receipt.error); assert.equal(receipt.inference_completed, true);
  assert.equal(submissions, 1); assert.equal(synchronous, 0); assert.equal(provider.requests.length, 4);
  assert.equal(fixture.reports.length, 1); assert.equal(readFileSync(join(fixture.root, 'products/current.txt'), 'utf8'), 'verified 42\n');
  assert.match(receipt.opencode.response_message_id, /^msg_/);
  assert.ok(fixture.traces.some(event => event.event === 'engine-prompt-admission' && event.inference_completed === false) || lost);
  if (lost) assert.ok(fixture.traces.some(event => event.event === 'engine-prompt-admission-unknown' && event.dispatch_replayed === false));
});

test('canonical saved tool parts enforce the same two-error circuit after actual SSE delivery closes', { timeout: 90000 }, async t => {
  observerPolicy(t);
  const previous = OpenCodeSession.prototype.observeEvents;
  OpenCodeSession.prototype.observeEvents = async function (stream) { await stream.next(); await stream.return(); };
  t.after(() => { OpenCodeSession.prototype.observeEvents = previous; });
  const provider = await localOpenAIProvider(async () => { await delay(150); return call('project_read', { path: 'products/current.txt', start_line: 2, start_char: 5 }); }, 8);
  const fixture = project(t, provider), receipt = await run(fixture);
  assert.equal(receipt.state, 'blocked'); assert.match(receipt.error, /^MCP_DELIVERY_PROTOCOL:/);
  assert.ok(fixture.traces.some(event => event.event === 'engine-tool' && event.source === 'message-reconciliation' && event.halt === true && event.event_id === undefined));
  assert.ok(provider.requests.length >= 2 && provider.requests.length <= 4);
  assert.equal(fixture.reports.length, 0); assert.equal(readFileSync(join(fixture.root, 'products/current.txt'), 'utf8'), 'original\n');
});

test('three semantically identical successful reads stop redundant model observation without accepting a missing report', { timeout: 90000 }, async t => {
  observerPolicy(t);
  const provider = await localOpenAIProvider(async () => { await delay(150); return call('project_read', { path: 'products/current.txt' }); }, 8);
  const fixture = project(t, provider), receipt = await run(fixture);
  assert.equal(receipt.state, 'blocked'); assert.equal(receipt.inference_completed, false);
  assert.match(receipt.error, /^CONTROLLED_OBSERVATION_LOOP:/);
  assert.ok(provider.requests.length >= 3 && provider.requests.length <= 5);
  assert.ok(fixture.traces.some(event => event.event === 'engine-tool' && event.repeated_observations === 3 && event.halt_reason === 'repeated-observation'));
  assert.equal(fixture.reports.length, 0);
});

async function stalledProvider() {
  const responses = new Set(), requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body); responses.add(response);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl_stalled', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_partial', type: 'function', function: { name: 'wf_project_read', arguments: '' } }] }, finish_reason: null }] })}\n\n`);
    const timer = setInterval(() => response.write(': heartbeat is not model progress\n\n'), 50);
    response.once('close', () => { clearInterval(timer); responses.delete(response); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests,
    close: async () => { for (const response of responses) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
test('partial tool name and SSE heartbeats cannot create completion or defeat the owned model-progress deadline', { timeout: 90000 }, async t => {
  observerPolicy(t, 5000);
  const provider = await stalledProvider(), fixture = project(t, provider), receipt = await run(fixture);
  assert.equal(receipt.state, 'blocked'); assert.equal(receipt.inference_completed, false);
  assert.match(receipt.error, /^OPENCODE_PROVIDER_STALLED:/);
  assert.equal(provider.requests.length, 1); assert.equal(fixture.reports.length, 0);
  assert.ok(fixture.traces.some(event => event.event === 'model-progress-stalled' && event.abort_acknowledged === true && event.session_idle_observed === true));
  assert.equal(readFileSync(join(fixture.root, 'products/current.txt'), 'utf8'), 'original\n');
});

for (const operation of ['session-create', 'tool-list']) test(`a lost local ${operation} connection is a bounded pre-prompt failure, not a provider request or blind replay`, { timeout: 90000 }, async t => {
  const provider = await localOpenAIProvider(() => { throw new Error('No model prompt is authorized by this control-setup fault fixture.'); }, 1);
  const fixture = project(t, provider), originalFetch = globalThis.fetch;
  let faults = 0, submissions = 0, sessionCreates = 0;
  globalThis.fetch = async function (request, options) {
    const url = new URL(typeof request === 'string' ? request : request.url), method = request.method ?? options?.method;
    if (method === 'POST' && /\/prompt_async$/.test(url.pathname)) submissions++;
    if (method === 'POST' && /\/session$/.test(url.pathname)) sessionCreates++;
    const target = operation === 'session-create' ? method === 'POST' && /\/session$/.test(url.pathname)
      : method === 'GET' && /\/tool\/ids$/.test(url.pathname);
    if (target && faults++ === 0) {
      // The POST may already have created one empty engine session. Its lost
      // acknowledgment never authorizes another POST or a model prompt.
      await originalFetch(request, options);
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('Loopback control reply was lost.'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) });
    }
    return originalFetch(request, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const receipt = await run(fixture);
  assert.equal(receipt.state, 'blocked'); assert.equal(receipt.inference_completed, false);
  assert.match(receipt.error, /^OPENCODE_CONTROL_SETUP_FAILED:/);
  assert.equal(faults, 1); assert.equal(sessionCreates, 1, 'No control POST is blindly replayed.');
  assert.equal(submissions, 0); assert.equal(provider.requests.length, 0);
  const stopped = await reconcileOpenCodeOwner(fixture.root, receipt.opencode.supervision);
  assert.equal(stopped.state, 'stopped'); assert.match(stopped.proof_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.reports.length, 0); assert.deepEqual(provider.failures, []);
  assert.equal(readFileSync(join(fixture.root, 'products/current.txt'), 'utf8'), 'original\n');
  const failure = fixture.traces.find(event => event.event === 'engine-failure' && event.control_operation === operation);
  assert.ok(failure); assert.equal(failure.transport_causes[1].code, 'UND_ERR_SOCKET');
  assert.doesNotMatch(JSON.stringify(failure), /Loopback control reply was lost|local-fixture|Authorization|apiKey/);
});
