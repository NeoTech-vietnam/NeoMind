// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import { getRecord } from '../dist/storage.js';
import { createRecord } from '../dist/storage.js';
import { canonicalJson, ensureRoutingPolicy, readInvocation, routingProblems } from '../dist/routing.js';
import { vscodeSelection } from '../dist/vscode-policy.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { startNative, waitNative, interruptNative, resumeNative, shutdownNative } from '../dist/native.js';
import { managedRun } from '../dist/managed.js';
import { readHost, hostRequest } from '../dist/vscode-wire.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { createHash } from 'node:crypto';

class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Cancellation {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
function fake(root, respond = ({ messages }) => messages.at(-1).content?.[0] instanceof Result
  ? [new Text('Completed deterministic fake model request.')]
  : [new Call('status', 'project_status', {})]) {
  let count = 0;
  const api = {
    version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: Text, LanguageModelToolCallPart: Call, LanguageModelToolResultPart: Result,
    LanguageModelChatToolMode: { Auto: 1, Required: 2 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ id: selector.id, vendor: selector.vendor, capabilities: { toolCalling: true },
      sendRequest: async (messages, options, token) => {
        count++;
        const parts = await respond({ messages, options, token, count });
        return { stream: (async function* () { for (const part of parts) yield part; })() };
      } }] },
  };
  return { api, get count() { return count; } };
}
async function setup(t, respond, policyPatch = {}, configureModel) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-vscode-'));
  initialize(root, { project_id: 'HOST', name: 'Host test' });
  const policy = { ...ensureRoutingPolicy(root), strong_provider: 'test-vendor', worker_provider: 'worker-vendor',
    vscode_effort_policy: 'allow-unavailable', ...policyPatch };
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  const model = fake(root, respond);
  configureModel?.(model.api);
  const host = await enableVSCodeHost(model.api, root);
  t.after(async () => { await shutdownNative(root); await host.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, model, host, policy };
}
async function ended(root, id) {
  const deadline = Date.now() + 30000;
  let receipt;
  do {
    receipt = await waitNative(root, id, Math.min(250, Math.max(0, deadline - Date.now())));
    if (!['starting', 'running'].includes(receipt.state)) return receipt;
    await new Promise(done => setImmediate(done));
  } while (Date.now() < deadline);
  assert.fail(`Fake host did not finish within 30 seconds: ${receipt.state}`);
}

test('failed owned host selection keeps private safe diagnostics and unchanged public refusal', async t => {
  const { root, model } = await setup(t);
  const events = [], request = 'host-open-diagnostic', epoch = 'diagnostic-epoch';
  const workflow = createRecord(root, { type: 'knowledge', title: 'Owned host diagnostic fixture', data: { kind: 'workflow' } }).meta.id;
  const unregister = registerControlledContext(root, request, {
    epoch_id: epoch,
    binding: { role: 'manager', stage: 'planning', workflow_id: workflow,
      implementation_paths: [], verification_paths: [], readable_paths: [] },
    bindInvocation() {},
    callbacks: { assertActive() {}, trace(event) { events.push(event); } },
  });
  t.after(unregister);
  const secret = 'Bearer hidden-host-selection-credential';
  model.api.lm.selectChatModels = async () => { throw new Error(secret); };
  const receipt = await startNative(root, { role: 'manager', prompt: 'Inspect failed selection.', workflow_id: workflow, request_id: request });
  assert.equal(receipt.state, 'blocked');
  assert.match(receipt.error, /VS Code bridge refused request/);
  assert.equal(model.count, 0);
  const failure = events.find(event => event.event === 'host-dispatch-failure');
  assert.ok(failure, 'Actual failed owned host dispatch must retain a diagnostic.');
  assert.equal(failure.tool, 'open');
  assert.equal(failure.owner, 'runtime');
  assert.equal(failure.diagnostic.phase, 'host-dispatch');
  assert.equal(failure.diagnostic.tool, 'open');
  assert.equal(failure.diagnostic.error_class, 'Error');
  assert.equal(failure.diagnostic.message_sha256, createHash('sha256').update(secret).digest('hex'));
  assert.ok(!JSON.stringify({ receipt, events }).includes(secret));
  assert.ok(!JSON.stringify(events).includes(root));
});

test('same-owner manager and developer reuse an exact live catalog handle when repeated SDK selection would hang', async t => {
  let selections = 0, disposed = 0;
  const env = await setup(t, undefined, {}, api => {
    const select = api.lm.selectChatModels;
    api.lm.onDidChangeChatModels = () => ({ dispose() { disposed++; } });
    api.lm.selectChatModels = selector => {
      selections++;
      return selections === 1 ? select(selector) : new Promise(() => {});
    };
  });
  writeFileSync(join(env.root, '.neomind/routing.json'), JSON.stringify({ ...env.policy,
    worker_provider: env.policy.strong_provider, worker_models: [env.policy.strong_model] }));
  const manager = await startNative(env.root, { role: 'manager', prompt: 'Inspect the project through the first live handle.' });
  assert.equal((await ended(env.root, manager.id)).state, 'completed');
  const worker = await startNative(env.root, { role: 'developer', prompt: 'Inspect through the same exact configured model.' });
  assert.equal((await ended(env.root, worker.id)).state, 'completed');
  assert.equal(selections, 1); assert.equal(env.model.count, 4);
  assert.equal(readInvocation(env.root, worker.id).confirmed_model, env.policy.strong_model);
  await env.host.close(); assert.equal(disposed, 1);
});
test('VS Code host selects exact vendor/ID, signs truthful provenance, resumes and rejects tampering', async t => {
  const { root, model } = await setup(t);
  const first = await startNative(root, { role: 'reviewer', prompt: 'Review bounded material.' });
  const done = await ended(root, first.id);
  assert.equal(done.state, 'completed');
  assert.equal(model.count, 2);
  assert.equal(done.execution_mode, 'vscode-extension-host');
  assert.equal(done.identity_provenance, 'local-vscode-extension-host');
  assert.equal(done.confirmed_reasoning_effort, null);
  assert.equal(done.native_sandbox, null);
  assert.equal(done.model_provider, 'test-vendor');
  assert.equal(done.runtime_integrity, '');
  assert.match(done.native_thread_id, /^vscode-host:conversation:/);
  assert.deepEqual(routingProblems(root, 'reviewer', done.id), []);
  const descriptor = readHost(root);
  assert.ok(!JSON.stringify(done).includes(descriptor.token));
  const resumed = await resumeNative(root, done.id, { prompt: 'Continue bounded review.' });
  assert.equal(resumed.native_thread_id, done.native_thread_id);
  assert.notEqual(resumed.native_turn_id, done.native_turn_id);
  const resumedDone = await ended(root, resumed.id);
  const publicBlocker = /VS Code bridge connection timed out/.test(resumedDone.error ?? '') ? 'bridge-connection-timeout'
    : /VS Code bridge request timed out/.test(resumedDone.error ?? '') ? 'bridge-request-timeout'
    : /VS Code model request blocked during/.test(resumedDone.error ?? '') ? 'model-request-blocked'
    : 'other-redacted-blocker';
  assert.equal(resumedDone.state, 'completed', `Resumed host receipt diagnostic: ${publicBlocker}.`);
  const path = join(root, done.receipt_path), original = readFileSync(path, 'utf8');
  writeFileSync(path, JSON.stringify({ ...done, model_provider: 'forged-provider' }));
  assert.throws(() => readInvocation(root, done.id), /signature/);
  writeFileSync(path, original);
  writeFileSync(join(root, '.neomind/tools.json'), '{}');
  assert.match(routingProblems(root, 'reviewer', done.id).join(' '), /configuration changed/);
  await assert.rejects(resumeNative(root, done.id), /configuration changed/);
});
test('manager_run binds running receipt before scoped MCP mutation and worker dispatch; no startup deadlock', async t => {
  const rounds = new Map();
  let root, manager, worker;
  const prepared = await setup(t, ({ messages, options }) => {
    assert.ok(options.tools.every(tool => !['manager_run', 'manager_begin', 'run_in_terminal', 'read_file'].includes(tool.name)));
    const instructions = messages[0].content;
    const id = /invocation ([a-f0-9-]{36})/.exec(instructions)[1];
    const receipt = readInvocation(root, id);
    const round = (rounds.get(id) ?? 0) + 1; rounds.set(id, round);
    if (receipt.role !== 'manager') {
      worker = receipt;
      return round === 1 ? [new Call('status', 'project_status', {})] : [new Text('Worker complete.')];
    }
    manager = receipt;
    assert.equal(getRecord(root, receipt.workflow_id).meta.data.invocation_id, receipt.id);
    assert.equal(receipt.state, 'running');
    assert.deepEqual(routingProblems(root, 'manager', id, { require_completed: false }), []);
    if (round === 1) return [new Call('discuss', 'manager_discuss', {
      workflow_id: receipt.workflow_id, role: 'manager', summary: 'Scoped actual discussion', rationale: 'Deterministic integration check.',
    })];
    if (round === 2) {
      assert.ok(JSON.stringify(messages).includes('Scoped actual discussion'));
      return [new Call('worker', 'native_dispatch', { role: 'researcher', prompt: 'Inspect bounded sources.' })];
    }
    if (round === 3) {
      const response = JSON.parse(messages.at(-1).content[0].content[0].value);
      const invoked = JSON.parse(response.content[0].text);
      assert.equal(invoked.state, 'running');
      return [new Call('wait', 'native_wait', { invocation_id: invoked.id, wait_ms: 1000 })];
    }
    assert.ok(JSON.stringify(messages).includes('Worker complete.'));
    return [new Text('Manager completed bounded test, not full engineering acceptance.')];
  });
  root = prepared.root;
  const result = await managedRun(root, { requirement: 'Inspect this bounded fake requirement.', request_id: 'host-manager' });
  assert.equal(result.blocker, undefined);
  const done = await ended(root, result.invocation.id);
  assert.equal(done.state, 'completed', done.error);
  assert.equal(manager.id, done.id);
  assert.equal(worker.model_provider, 'worker-vendor');
});
test('manager cannot resume itself through its invocation-bound gateway', async t => {
  let root;
  const prepared = await setup(t, ({ messages, count }) => {
    const id = /invocation ([a-f0-9-]{36})/.exec(messages[0].content)[1];
    if (count === 1) return [new Call('resume-self', 'native_resume', { invocation_id: id })];
    const response = JSON.parse(messages.at(-1).content[0].content[0].value);
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response), /Coordinator resumption requires external managed intake/);
    assert.equal(readInvocation(root, id).state, 'running');
    return [new Text('Recursive resumption denied.')];
  });
  root = prepared.root;
  const result = await managedRun(root, { requirement: 'Do not replace this coordinator recursively.' });
  assert.equal((await ended(root, result.invocation.id)).state, 'completed');
});
test('late stream end cannot complete canceled turn or mutate resumed history', async t => {
  const { root, model } = await setup(t);
  let release, entered, drained, count = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const finished = new Promise(resolve => { drained = resolve; });
  model.api.lm.selectChatModels = async selector => [{ ...selector, sendRequest: async messages => {
    count++;
    const round = count;
    return { stream: (async function* () {
      if (round === 1) { yield new Call('status', 'project_status', {}); return; }
      if (round === 2) {
        yield new Text('Discard canceled response.');
        await new Promise(resolve => { release = resolve; entered(); });
        drained();
        return;
      }
      assert.ok(!JSON.stringify(messages).includes('Discard canceled response.'));
      if (round === 3) yield new Call('resumed-status', 'project_status', {});
      else yield new Text('Resumed safely.');
    })() };
  } }];
  const receipt = await startNative(root, { role: 'reviewer', prompt: 'Cancel after tool round.' });
  await waiting;
  await interruptNative(root, receipt.id);
  await shutdownNative(root);
  release();
  await finished;
  await new Promise(resolve => setImmediate(resolve));
  const state = await hostRequest(readHost(root), 'poll', { invocation_id: receipt.id, turn_id: receipt.native_turn_id });
  assert.equal(state.state, 'interrupted');
  assert.equal(readInvocation(root, receipt.id).inference_completed, false);
  const resumed = await resumeNative(root, receipt.id, { prompt: 'Reinspect durable state.' });
  assert.equal((await ended(root, resumed.id)).state, 'completed');
});
test('workspace trust, disabled/stale host, effort ceiling, consent refusal, unavailable model and unsupported tools block', async t => {
  const { root, model, host, policy } = await setup(t);
  model.api.workspace.isTrusted = false;
  await assert.rejects(enableVSCodeHost(model.api, root), /Trust/);
  let receipt = await startNative(root, { role: 'architect', prompt: 'Bounded design.' });
  assert.equal(receipt.state, 'blocked'); assert.equal(model.count, 0);
  model.api.workspace.isTrusted = true;
  delete policy.vscode_effort_policy;
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  receipt = await startNative(root, { role: 'architect', prompt: 'Require effort.' });
  assert.equal(receipt.state, 'blocked'); assert.equal(model.count, 0);
  policy.vscode_effort_policy = 'allow-unavailable';
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  model.api.lm.selectChatModels = async () => [];
  receipt = await startNative(root, { role: 'architect', prompt: 'Unavailable model.' });
  assert.equal(receipt.state, 'blocked'); assert.match(receipt.error, /unavailable from live model discovery/);
  assert.ok(receipt.error.includes(`test-vendor/${policy.strong_model}`));
  assert.match(receipt.error, /no replacement model was selected/);
  model.api.lm.selectChatModels = async selector => [{ ...selector, capabilities: { toolCalling: false } }];
  receipt = await startNative(root, { role: 'architect', prompt: 'Tools unsupported.' });
  assert.equal(receipt.state, 'blocked');
  model.api.lm.selectChatModels = async selector => [{ ...selector, capabilities: { toolCalling: true },
    sendRequest: async () => { throw new Error('NoPermissions: consent refused secret-should-not-leak'); } }];
  receipt = await startNative(root, { role: 'architect', prompt: 'Consent refused.' });
  receipt = await ended(root, receipt.id);
  assert.equal(receipt.state, 'blocked'); assert.equal(receipt.inference_completed, false);
  assert.ok(!JSON.stringify(receipt).includes('secret-should-not-leak'));
  const descriptor = readHost(root);
  await assert.rejects(hostRequest({ ...descriptor, token: '0'.repeat(64) }, 'poll', {}), /refused/);
  await assert.rejects(hostRequest(descriptor, 'open', { invocation_id: receipt.id, owner_pid: process.pid,
    model: 'fake', vendor: 'fake', tools: [] }), /refused/);
  await host.close();
  receipt = await startNative(root, { role: 'architect', prompt: 'Disabled bridge.' });
  assert.equal(receipt.state, 'blocked'); assert.match(receipt.error, /disabled|stale/);
});
test('model mismatch, forged tools, routing change, cancellation and host shutdown cannot succeed', async t => {
  const { root, model, host, policy } = await setup(t, () => [new Call('shell', 'run_in_terminal', { command: 'whoami' })]);
  let receipt = await startNative(root, { role: 'reviewer', prompt: 'Disallow shell.' });
  receipt = await ended(root, receipt.id);
  assert.equal(receipt.state, 'blocked');
  model.api.lm.selectChatModels = async selector => [{ ...selector, vendor: 'wrong', capabilities: { toolCalling: true } }];
  receipt = await startNative(root, { role: 'reviewer', prompt: 'Mismatched vendor.' });
  assert.equal(receipt.state, 'blocked'); assert.equal(receipt.native_thread_id, null);
  // Open-time exceptions stay sanitized by the transport; mismatched models never get a turn.
  assert.match(receipt.error, /VS Code bridge refused request/);
  model.api.lm.selectChatModels = async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async () =>
    ({ stream: (async function* () { await new Promise(() => {}); })() }) }];
  receipt = await startNative(root, { role: 'reviewer', prompt: 'Interrupt running request.' });
  assert.equal(receipt.state, 'running');
  assert.equal((await interruptNative(root, receipt.id)).state, 'interrupted');
  receipt = await startNative(root, { role: 'reviewer', prompt: 'Block changed routing.' });
  policy.strong_provider = 'changed'; writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  assert.equal((await ended(root, receipt.id)).state, 'blocked');
  receipt = await startNative(root, { role: 'reviewer', prompt: 'Host shutdown.' });
  await host.close();
  assert.equal((await ended(root, receipt.id)).state, 'blocked');
});
test('stable API without capabilities works; ignored required tools and recursive manager tools block', async t => {
  const { root, model } = await setup(t);
  const select = model.api.lm.selectChatModels;
  model.api.lm.selectChatModels = async selector => (await select(selector)).map(({ capabilities, ...stable }) => stable);
  let receipt = await startNative(root, { role: 'reviewer', prompt: 'Use stable API.' });
  assert.equal((await ended(root, receipt.id)).state, 'completed');
  let observedMode;
  model.api.lm.selectChatModels = async selector => [{ ...selector, sendRequest: async (_messages, options) => {
    observedMode = options.toolMode;
    return { stream: (async function* () { yield new Text('Ignored tools.'); })() };
  } }];
  receipt = await startNative(root, { role: 'reviewer', prompt: 'Must call scoped tool.' });
  const ignored = await ended(root, receipt.id);
  assert.equal(ignored.state, 'blocked');
  assert.equal(observedMode, model.api.LanguageModelChatToolMode.Auto);
  assert.match(ignored.error, /Model did not demonstrate required tool calling/);
  model.api.lm.selectChatModels = async selector => [{ ...selector, sendRequest: async () => ({ stream:
    (async function* () { yield new Call('recursive', 'manager_run', { requirement: 'Escape scope.' }); })() }) }];
  receipt = await startNative(root, { role: 'reviewer', prompt: 'Never recurse.' });
  assert.equal((await ended(root, receipt.id)).state, 'blocked');
});
test('catalog labels resolve exact vendor; workers fall back only on unavailable selection', async t => {
  const { root, model, policy } = await setup(t, undefined,
    { worker_models: ['First (customendpoint)', 'available-id (customendpoint)'] });
  const catalog = join(root, 'models.json');
  writeFileSync(catalog, JSON.stringify([{ name: 'Worker display group', vendor: 'customendpoint',
    models: [{ id: 'available-id', name: 'Second' }, { id: 'unavailable-id', name: 'First' }] }]));
  policy.worker_provider = 'Worker display group'; policy.language_models_file = catalog;
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  const selectors = [], select = model.api.lm.selectChatModels;
  model.api.lm.selectChatModels = async selector => {
    selectors.push(selector);
    return selector.id === 'unavailable-id' ? [] : select(selector);
  };
  const receipt = await startNative(root, { role: 'researcher', prompt: 'Bounded fallback.' });
  const done = await ended(root, receipt.id);
  assert.equal(done.state, 'completed', done.error);
  assert.equal(done.requested_model, 'available-id (customendpoint)');
  assert.equal(done.confirmed_model, 'available-id');
  assert.equal(done.model_provider, 'customendpoint');
  assert.equal(done.fallback_evidence.model, 'First (customendpoint)');
  assert.deepEqual(selectors, [{ vendor: 'customendpoint', id: 'unavailable-id' }, { vendor: 'customendpoint', id: 'available-id' }]);
  assert.deepEqual(routingProblems(root, 'researcher', done.id), []);
  writeFileSync(catalog, JSON.stringify([]));
  assert.ok(routingProblems(root, 'researcher', done.id).length);
});

test('decorated policy invokes canonical VS Code vendor/ID and routing rejects signed wrong model or vendor', async t => {
  const { root, model, policy } = await setup(t);
  Object.assign(policy, { strong_provider: 'Endpoint group', language_models_file: 'models.json' });
  writeFileSync(join(root, 'models.json'), JSON.stringify([{ name: 'Endpoint group', vendor: 'customendpoint',
    apiKey: 'never-copy-this', models: [{ id: 'canonical-id', name: 'Display Name' }] }]));
  const selectors = [], select = model.api.lm.selectChatModels;
  model.api.lm.selectChatModels = async selector => { selectors.push(selector); return select(selector); };
  let done;
  for (const requested of ['canonical-id', 'canonical-id (customendpoint)', 'Display Name (customendpoint)']) {
    policy.strong_model = requested;
    writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
    const receipt = await startNative(root, { role: 'reviewer', prompt: 'Review through decorated policy.' });
    done = await ended(root, receipt.id);
    assert.equal(done.state, 'completed', done.error);
    assert.equal(done.requested_model, requested);
    assert.equal(done.confirmed_model, 'canonical-id');
    assert.equal(done.model_provider, 'customendpoint');
    assert.deepEqual(routingProblems(root, 'reviewer', done.id), []);
    assert.doesNotMatch(JSON.stringify(done), /never-copy-this|apiKey/);
  }
  assert.equal(model.count, 6);
  assert.deepEqual(selectors, Array.from({ length: 3 }, () => ({ vendor: 'customendpoint', id: 'canonical-id' })));
  const path = join(root, done.receipt_path), original = readFileSync(path, 'utf8');
  // Re-sign only the fixture receipt to exercise semantic routing checks, not signature rejection.
  const key = readFileSync(join(root, '.neomind/cache/native/private-key.pem'), 'utf8');
  try {
    for (const [patch, problem] of [
      [{ confirmed_model: policy.strong_model }, /did not acknowledge the permitted requested model/],
      [{ confirmed_model: 'wrong-id' }, /did not acknowledge the permitted requested model/],
      [{ model_provider: 'wrong-vendor' }, /VS Code host selected a different provider/],
    ]) {
      const { signature, ...unsigned } = { ...done, ...patch };
      writeFileSync(path, JSON.stringify({ ...unsigned,
        signature: sign(null, Buffer.from(canonicalJson(unsigned)), key).toString('base64') }));
      assert.equal(readInvocation(root, done.id).id, done.id);
      assert.match(routingProblems(root, 'reviewer', done.id).join(' '), problem);
    }
  } finally { writeFileSync(path, original); }
  assert.deepEqual(routingProblems(root, 'reviewer', done.id), []);
  for (const patch of [{ id: policy.strong_model }, { id: 'wrong-id' }, { vendor: 'wrong-vendor' }]) {
    model.api.lm.selectChatModels = async selector => [{ ...selector, ...patch, capabilities: { toolCalling: true } }];
    const blocked = await startNative(root, { role: 'reviewer', prompt: 'Reject mismatched live selection.' });
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.native_thread_id, null);
    assert.equal(blocked.inference_completed, false);
    assert.match(blocked.error, /VS Code bridge refused request/);
    assert.notDeepEqual(routingProblems(root, 'reviewer', blocked.id), []);
  }
  assert.equal(model.count, 6);
});

test('VS Code policy resolves literal parentheses and settings but rejects scoped ambiguity and wrong suffixes', async t => {
  const { root, model, policy } = await setup(t);
  Object.assign(policy, { strong_provider: 'Endpoint group', language_models_file: 'models.json' });
  const entry = { id: 'canonical-id', name: 'Display Name' };
  const group = { name: 'Endpoint group', vendor: 'customendpoint', models: [entry] };
  function run(requested, catalog, provider = 'Endpoint group') {
    policy.strong_model = requested; policy.strong_provider = provider;
    writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
    writeFileSync(join(root, 'models.json'), JSON.stringify(catalog));
    return vscodeSelection(root, 'reviewer', requested);
  }
  const literal = { id: 'canonical-id (customendpoint)', name: 'Literal Winner' };
  assert.deepEqual(run(literal.id, [{ ...group, models: [entry, literal] }]),
    { vendor: 'customendpoint', id: literal.id });
  assert.deepEqual(run('settings-id (customendpoint)', [{ name: group.name, vendor: group.vendor,
    settings: { 'settings-id': { apiKey: 'private-key' } } }]), { vendor: 'customendpoint', id: 'settings-id' });
  const other = { ...group, name: 'Other group' };
  assert.deepEqual(run('Display Name (customendpoint)', [group, other]), { vendor: 'customendpoint', id: entry.id });
  for (const [catalog, provider] of [
    [[group, group], group.name],
    [[{ ...group, models: [entry, entry] }], group.name],
    [[{ ...group, settings: { [entry.id]: {} } }], group.name],
    [[group, other], group.vendor],
    [[group], 'missing-provider'],
  ]) {
    assert.throws(() => run('canonical-id (customendpoint)', catalog, provider), /exactly one catalog vendor/);
  }
  for (const requested of ['canonical-id (wrong-vendor)', 'Display Name (wrong-vendor)']) {
    assert.throws(() => run(requested, [group]), /exactly one catalog vendor/);
  }
  run('canonical-id (customendpoint)', [group]);
  assert.throws(() => vscodeSelection(root, 'reviewer', 'canonical-id'), /outside the role policy/);
  assert.equal(model.count, 0);
});
test('different workspace root and lost host history cannot resume conversation', async t => {
  const { root, model, host } = await setup(t);
  model.api.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: tmpdir() } }];
  await assert.rejects(enableVSCodeHost(model.api, root), /exact open workspace/);
  model.api.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: root } }];
  const receipt = await startNative(root, { role: 'reviewer', prompt: 'Bounded review.' });
  const done = await ended(root, receipt.id);
  assert.equal(done.state, 'completed');
  await host.close();
  const replacement = await enableVSCodeHost(model.api, root);
  t.after(() => replacement.close());
  const resumed = await resumeNative(root, done.id);
  assert.equal(resumed.state, 'blocked');
  assert.equal(resumed.inference_completed, false);
});

test('opaque provider data survives tool history; raw and serialized data budgets block excess', async t => {
  class Data { constructor(data, mimeType = 'application/test') { Object.assign(this, { data, mimeType }); } }
  const opaque = new Data(new Uint8Array([1, 2, 3]));
  const { root, model } = await setup(t, ({ messages, options, count }) => {
    assert.equal(options.toolMode, 1);
    if (count === 1) return [opaque, new Call('status', 'project_status', {})];
    assert.ok(messages.some(message => Array.isArray(message.content) && message.content.includes(opaque)));
    return [new Text('Data retained.')];
  });
  model.api.LanguageModelDataPart = Data;
  const receipt = await startNative(root, { role: 'reviewer', prompt: 'Preserve provider data.' });
  assert.equal((await ended(root, receipt.id)).state, 'completed');
  for (const bytes of [768001, 390000]) {
    model.api.lm.selectChatModels = async selector => [{ ...selector, sendRequest: async () => ({
      stream: (async function* () { yield new Data(new Uint8Array(bytes)); })(),
    }) }];
    const oversized = await startNative(root, { role: 'reviewer', prompt: 'Bound data.' });
    const blocked = await ended(root, oversized.id);
    assert.equal(blocked.state, 'blocked');
    assert.match(blocked.error, /response-stream: Response data limit reached/);
  }
});

test('host errors expose phase and allowlisted codes without raw provider secrets', async t => {
  const { root, model } = await setup(t);
  for (const code of ['NoPermissions', 'unknown-secret-code']) {
    model.api.lm.selectChatModels = async selector => [{ ...selector, sendRequest: async () => {
      throw Object.assign(new Error('secret-provider-url-token'), { code });
    } }];
    const receipt = await startNative(root, { role: 'reviewer', prompt: 'Check sanitized diagnostics.' });
    const blocked = await ended(root, receipt.id);
    assert.equal(blocked.state, 'blocked');
    assert.match(blocked.error, /blocked during request:/);
    assert.ok(!JSON.stringify(blocked).includes('secret-provider-url-token'));
    assert.ok(!JSON.stringify(blocked).includes('unknown-secret-code'));
    if (code === 'NoPermissions') assert.match(blocked.error, /NoPermissions: model access denied/);
  }
});

test('nested provider model_not_supported stream failure preserves a fixed actionable diagnostic without secrets', async t => {
  const { root, model } = await setup(t);
  const secret = 'PRIVATE_CUSTOM_ENDPOINT_TOKEN';
  model.api.lm.selectChatModels = async selector => [{ ...selector, capabilities: { toolCalling: true },
    sendRequest: async () => ({ stream: (async function* () {
      throw new Error(`HTTP 400: ${JSON.stringify(JSON.stringify({ error: { code: 'model_not_supported',
        message: `https://private-endpoint.invalid/?api_key=${secret}`, token: secret } }))}`);
    })() }) }];
  const started = await startNative(root, { role: 'manager', prompt: 'Inspect a bounded provider failure.' });
  const blocked = await ended(root, started.id);
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.inference_completed, false);
  assert.match(blocked.error, /blocked during response-stream: MODEL_NOT_SUPPORTED:/);
  assert.match(blocked.error, /9router alias.*upstream model target/);
  assert.match(blocked.error, /No substitute model was selected/);
  assert.equal(JSON.stringify(blocked).includes(secret), false);
  const stored = readFileSync(join(root, blocked.receipt_path), 'utf8');
  assert.equal(stored.includes(secret), false); assert.equal(stored.includes('private-endpoint.invalid'), false);
  assert.match(readInvocation(root, blocked.id).error, /MODEL_NOT_SUPPORTED/);
});

test('manager resumes unchanged configuration but starts fresh in same workflow after policy change', async t => {
  const { root, policy } = await setup(t);
  const first = await managedRun(root, { requirement: 'Keep same workflow across model policy updates.', request_id: 'config-refresh' });
  const original = await ended(root, first.invocation.id);
  assert.equal(original.state, 'completed');
  const resumed = await managedRun(root, { workflow_id: original.workflow_id });
  const unchanged = await ended(root, resumed.invocation.id);
  assert.equal(unchanged.native_thread_id, original.native_thread_id);
  policy.strong_provider = 'new-exact-vendor';
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  const refresh = { workflow_id: original.workflow_id, request_id: 'config-refresh' };
  const fresh = await managedRun(root, refresh);
  assert.equal(fresh.blocker, undefined);
  const changed = await ended(root, fresh.invocation.id);
  assert.equal(changed.state, 'completed', changed.error);
  assert.equal(changed.workflow_id, original.workflow_id);
  assert.notEqual(changed.id, original.id);
  assert.notEqual(changed.request_id, original.request_id);
  assert.notEqual(changed.native_thread_id, unchanged.native_thread_id);
  assert.equal(changed.model_provider, 'new-exact-vendor');
  assert.equal(getRecord(root, original.workflow_id).meta.data.request_id, 'config-refresh');
  assert.equal(getRecord(root, original.workflow_id).meta.data.invocation_id, changed.id);
  const repeated = await managedRun(root, refresh);
  assert.equal(repeated.blocker, undefined);
  assert.equal(repeated.invocation.id, changed.id);
  assert.deepEqual(routingProblems(root, 'manager', changed.id, { workflow_id: original.workflow_id }), []);
  await assert.rejects(managedRun(root, { workflow_id: original.workflow_id, execution_mode: 'lightweight' }), /mode cannot be changed/);
});
