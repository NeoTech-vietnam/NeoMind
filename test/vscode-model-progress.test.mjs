import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { initialize } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { exactRoot, hostRequest, readHost } from '../dist/vscode-wire.js';
import { startNative, waitNative, interruptNative, shutdownNative } from '../dist/native.js';

class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function progressPath(root, id) {
  const key = createHash('sha256').update(`${userInfo().username}\0${exactRoot(root)}`).digest('hex');
  return join(tmpdir(), `neomind-vscode-${key}`, 'progress', `${id}.json`);
}
async function fixture(t, sendRequest) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-model-progress-'));
  initialize(root, { project_id: 'PROGRESS' });
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify({ ...ensureRoutingPolicy(root),
    strong_provider: 'fixture-vendor', vscode_effort_policy: 'allow-unavailable' }));
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest }] } };
  const host = await enableVSCodeHost(api, root);
  const privateDirectory = join(progressPath(root, 'unused'), '..', '..');
  t.after(async () => { await shutdownNative(root); await host.close(); rmSync(root, { recursive: true, force: true });
    assert.equal(privateDirectory.startsWith(join(tmpdir(), 'neomind-vscode-')), true);
    rmSync(privateDirectory, { recursive: true, force: true }); });
  return { root, host, read: id => JSON.parse(readFileSync(progressPath(root, id), 'utf8')) };
}
async function ended(root, id) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const receipt = await waitNative(root, id, 100);
    if (!['starting', 'running'].includes(receipt.state)) return receipt;
  }
  assert.fail('Fixture invocation did not finish.');
}

test('private Bridge diagnostics distinguish awaiting SDK handle from tool part waiting for stream end', async t => {
  const entered = deferred(), handle = deferred(), partSeen = deferred(), streamEnd = deferred();
  let rounds = 0;
  const { root, read } = await fixture(t, async () => {
    if (++rounds > 1) return { stream: (async function* () { yield new Text('SECRET_MODEL_TEXT'); })() };
    entered.resolve(); await handle.promise;
    return { stream: (async function* () {
      yield new Call('SECRET_CALL_ID', 'project_status', {});
      partSeen.resolve(); await streamEnd.promise;
    })() };
  });
  t.after(() => { handle.resolve(); streamEnd.resolve(); });
  const receipt = await startNative(root, { role: 'reviewer', prompt: 'SECRET_REQUEST_TEXT' });
  await entered.promise;
  let status = read(receipt.id);
  assert.equal(status.trust, 'diagnostic-only');
  assert.equal(status.phase, 'awaiting-sdk-handle');
  assert.equal(status.sdk_handle_received_at, null);
  assert.equal(status.first_stream_chunk_at, null);
  handle.resolve(); await partSeen.promise;
  status = read(receipt.id);
  assert.equal(status.phase, 'response-stream');
  assert.ok(status.sdk_handle_received_at);
  assert.ok(status.first_stream_chunk_at);
  assert.equal(status.round_counts.tool_calls, 1);
  assert.equal(status.tool_calls_pending, 1);
  assert.equal(status.round_counts.tool_results, 0, 'A tool part is observed, but not yet dispatched before stream end.');
  streamEnd.resolve();
  const done = await ended(root, receipt.id);
  assert.equal(done.state, 'completed');
  status = read(receipt.id);
  assert.equal(status.phase, 'completed');
  assert.ok(status.ended_at);
  assert.equal(status.totals.tool_calls, 1);
  assert.equal(status.totals.tool_results, 1);
  assert.equal(status.totals.text_bytes, Buffer.byteLength('SECRET_MODEL_TEXT'));
  assert.doesNotMatch(JSON.stringify(status), /SECRET_|authorization|endpoint|input_text|output_text/i);
});

test('cancel while awaiting SDK handle remains terminal even if an ignored cancellation returns a late handle', async t => {
  const entered = deferred(), handle = deferred();
  const { root, read } = await fixture(t, async () => { entered.resolve(); await handle.promise;
    return { stream: (async function* () { yield new Text('SECRET_LATE_TEXT'); })() }; });
  t.after(() => handle.resolve());
  const receipt = await startNative(root, { role: 'reviewer', prompt: 'Cancel pending request.' });
  await entered.promise;
  assert.equal(read(receipt.id).phase, 'awaiting-sdk-handle');
  // interruptNative returns its signed interrupted receipt before asynchronous
  // transport cleanup. Assert the actual acknowledged host-cancel boundary.
  await hostRequest(readHost(root), 'cancel', { invocation_id: receipt.id, turn_id: receipt.native_turn_id });
  const canceled = read(receipt.id);
  assert.equal(canceled.phase, 'cancelled');
  assert.equal(canceled.terminal_reason, 'owner-cancel');
  handle.resolve();
  // An ignored cancellation may produce a late handle, but it must not reopen diagnostics or dispatch tools.
  await new Promise(done => setTimeout(done, 25));
  assert.deepEqual(read(receipt.id), canceled);
  await interruptNative(root, receipt.id);
});

test('host persists fixed ordinary Error and nested transport classification without raw provider secrets', async t => {
  const { root, read } = await fixture(t, async () => {
    const error = new Error('SECRET_RAW_PROVIDER https://secret.invalid/?token=SECRET_HEADER');
    error.cause = Object.assign(new Error('SECRET_CAUSE_STACK'), { code: 'UND_ERR_SOCKET' });
    throw error;
  });
  const receipt = await startNative(root, { role: 'reviewer', prompt: 'Observe fixed transport diagnostic metadata.' });
  const done = await ended(root, receipt.id);
  assert.equal(done.state, 'blocked');
  assert.match(done.error, /SDK Error/);
  assert.match(done.error, /transport UND_ERR_SOCKET/);
  assert.doesNotMatch(done.error, /SECRET|secret\.invalid|https:|token=/);
  const progress = read(receipt.id);
  assert.equal(progress.phase, 'error');
  assert.equal(progress.failure_phase, 'awaiting-sdk-handle');
  assert.doesNotMatch(JSON.stringify(progress), /SECRET|https:/);
});

test('host classifies observed router upstream connection lost response without changing failure lifecycle or leaking content', async t => {
  const { root, read } = await fixture(t, async () => ({ stream: (async function* () {
    throw new Error('upstream connection lost SECRET_RAW_PROVIDER https://secret.invalid/?token=SECRET');
  })() }));
  const receipt = await startNative(root, { role: 'reviewer', prompt: 'Observe the fixed router response error.' });
  const done = await ended(root, receipt.id);
  assert.equal(done.state, 'blocked');
  assert.equal(done.inference_completed, false);
  assert.match(done.error, /blocked during response-stream: PROVIDER_UNAVAILABLE:/);
  assert.doesNotMatch(done.error, /SECRET|secret\.invalid|https:|token=/);
  const progress = read(receipt.id);
  assert.equal(progress.phase, 'error');
  assert.equal(progress.failure_phase, 'response-stream');
  assert.ok(progress.sdk_handle_received_at);
  assert.equal(progress.first_stream_chunk_at, null);
  assert.equal(progress.round_counts.parts, 0);
  assert.equal(progress.terminal_reason, 'model-or-host-error');
});
