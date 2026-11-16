// Independent experiment: real registry, exclusively in-memory fake runners and scopes.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RunnerRegistry, assertSessionBound, verifiedSession } from '../../../dist/src/runners/registry.js';

const workspace = path.resolve('/fixture-registry-workspace');
const ids = ['codex', 'claude-code', 'opencode'];
const bindingFor = runner => ({ runner, provider: 'fixture', model: 'fake-readonly', reasoning: 'high' });

class FakeScope {
  identity = { unit: 'fake-unit', controlGroup: 'fake-group' };
  active = true;
  constructor(trace, fail) { this.trace = trace; this.fail = fail; }
  async isActive() { return this.active; }
  async stop() {
    this.trace.push('stop');
    if (this.fail === 'stop') return false;
    if (this.fail === 'stop-throws') throw Error('stop failed');
    if (this.fail === 'stop-still-active') return true;
    this.active = false;
    return true;
  }
}

class FakeRunner {
  constructor(runner, trace, fail) {
    this.runner = runner; this.trace = trace; this.fail = fail;
    this.scope = new FakeScope(trace, fail);
  }
  async openSession(request) {
    this.trace.push('open');
    if (this.fail === 'open') throw Error('open failed');
    this.session = Object.freeze({ runner: this.runner, sessionId: 'fake-session', workspace: request.workspace,
      provider: request.binding.provider, model: request.binding.model, access: request.access,
      ...(this.fail === 'session-model' ? { model: 'wrong' } : {}),
      ...(this.fail === 'session-workspace' ? { workspace: '/wrong' } : {}),
      ...(this.fail === 'session-runner' ? { runner: 'wrong' } : {}),
      ...(this.fail === 'session-provider' ? { provider: 'wrong' } : {}),
      ...(this.fail === 'session-access' ? { access: { kind: 'write', writableRoots: ['/'] } } : {}) });
    return this.session;
  }
  async verifyNoDelegation(session) {
    this.trace.push('verify');
    if (session !== this.session || this.fail === 'delegation') throw Error('delegation rejected');
  }
  async startTurn(session, request) {
    this.trace.push('startTurn');
    if (session !== this.session || request.effort !== 'high' || this.fail === 'start') throw Error('start failed');
    return 'fake-turn';
  }
  async waitForTurn(session, turnId, stopped) {
    this.trace.push('wait');
    if (session !== this.session || turnId !== 'fake-turn' || stopped() || this.fail === 'wait') throw Error('wait failed');
    return { threadId: session.sessionId, turnId, status: this.fail === 'turn-status' ? 'failed' : 'completed', messages: [`fixture:${this.runner}`] };
  }
  close() { return this.scope.stop(); }
}

class FakeFactory {
  constructor(runner, trace, fail) { this.runner = runner; this.trace = trace; this.fail = fail; }
  async models() {
    this.trace.push(`models:${this.runner}`);
    return this.fail === 'model-list' ? [] : [{ ...bindingFor(this.runner), reasoning: ['high'] }];
  }
  async verifyCapabilities() {
    this.trace.push(`capabilities:${this.runner}`);
    return { sandboxVerified: false, stopVerified: this.fail !== 'capability' };
  }
  async start(givenWorkspace) {
    this.trace.push(`factory:${this.runner}`);
    if (givenWorkspace !== workspace || this.fail === 'factory') throw Error('factory failed');
    return new FakeRunner(this.runner, this.trace, this.fail);
  }
}

function harness(fail) {
  const trace = [];
  const registry = new RunnerRegistry(ids.map(id => new FakeFactory(id, trace, fail)));
  return { trace, registry };
}

// Demonstrates sequencing only. This is not a LocalRun dispatcher or admission service.
async function dispatch(registry, binding) {
  let runner;
  let output;
  let error;
  try {
    if (!binding || !ids.includes(binding.runner) || binding.provider !== 'fixture' || binding.model !== 'fake-readonly' || binding.reasoning !== 'high') throw Error('binding rejected');
    const factory = registry.get(binding.runner);
    const models = await factory.models();
    if (!models.some(m => m.runner === binding.runner && m.provider === binding.provider && m.model === binding.model && m.reasoning.includes(binding.reasoning))) throw Error('model rejected');
    if ((await factory.verifyCapabilities()).stopVerified !== true) throw Error('stop capability rejected');
    runner = await factory.start(workspace);
    const session = await runner.openSession({ workspace, binding, access: { kind: 'read' } });
    verifiedSession(runner, session, session.sessionId);
    assertSessionBound(session, binding, workspace);
    if (session.access?.kind !== 'read') throw Error('access rejected');
    await runner.verifyNoDelegation(session);
    const turnId = await runner.startTurn(session, { prompt: 'synthetic fixture', effort: binding.reasoning });
    const result = await runner.waitForTurn(session, turnId, () => false);
    if (result.threadId !== session.sessionId || result.turnId !== turnId || result.status !== 'completed') throw Error('turn rejected');
    output = result;
  } catch { error = 'dispatch_failed'; }
  if (runner) {
    try { if (await runner.close() !== true || await runner.scope.isActive()) error = 'stop_unconfirmed'; }
    catch { error = 'stop_unconfirmed'; }
  }
  return error ? { ok: false, error } : { ok: true, result: output };
}

test('real registry selects all three fake factories with matching session and fake stop proof', async () => {
  for (const id of ids) {
    const { registry, trace } = harness();
    assert.deepEqual(registry.runners(), ids);
    assert.deepEqual(await dispatch(registry, bindingFor(id)), { ok: true, result: {
      threadId: 'fake-session', turnId: 'fake-turn', status: 'completed', messages: [`fixture:${id}`] } });
    assert.deepEqual(trace, [`models:${id}`, `capabilities:${id}`, `factory:${id}`, 'open', 'verify', 'startTurn', 'wait', 'stop']);
  }
});

test('binding mismatch fails before selecting any factory, without fallback', async () => {
  for (const binding of [{ ...bindingFor('other') }, { ...bindingFor('codex'), provider: 'other' },
    { ...bindingFor('codex'), model: 'other' }, { ...bindingFor('codex'), reasoning: 'low' }]) {
    const { registry, trace } = harness();
    assert.deepEqual(await dispatch(registry, binding), { ok: false, error: 'dispatch_failed' });
    assert.deepEqual(trace, []);
  }
});

test('real registry rejects an unregistered ID', () => {
  const { registry } = harness();
  assert.throws(() => registry.get('missing'), /Unknown runner/);
});

test('fake errors fail closed, never fall back, and stop any allocated scope', async () => {
  for (const failure of ['model-list', 'capability', 'factory', 'open', 'session-model', 'session-workspace',
    'session-runner', 'session-provider', 'session-access', 'delegation', 'start', 'wait', 'turn-status', 'stop', 'stop-throws', 'stop-still-active']) {
    const { registry, trace } = harness(failure);
    assert.deepEqual(await dispatch(registry, bindingFor('codex')), { ok: false, error: failure.startsWith('stop') ? 'stop_unconfirmed' : 'dispatch_failed' }, failure);
    assert.equal(trace.some(item => item.includes('claude-code') || item.includes('opencode')), false, failure);
    const allocated = trace.includes('open');
    assert.equal(trace.includes('stop'), allocated, failure);
    if (failure.startsWith('session-') || failure === 'delegation') assert.equal(trace.includes('startTurn'), false, failure);
  }
});
