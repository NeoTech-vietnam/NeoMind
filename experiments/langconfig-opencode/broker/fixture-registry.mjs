// Registry integration for fixtures only. No process, filesystem or model is launched.
import path from 'node:path';
import { RunnerRegistry, assertSessionBound, verifiedSession } from '../../../dist/src/runners/registry.js';

const workspace = path.resolve('/fixture-registry-workspace');
const ids = ['codex', 'claude-code', 'opencode'];

class FakeScope {
  active = true;
  identity = Object.freeze({ unit: 'fixture-unit', controlGroup: 'fixture-group' });
  constructor(fault, trace) { this.fault = fault; this.trace = trace; }
  async isActive() { return this.active; }
  async stop() {
    this.trace('stop');
    if (this.fault === 'stop') return false;
    if (this.fault === 'stop-throws') throw Error('fixture stop failure');
    if (this.fault === 'stop-active') return true;
    this.active = false;
    return true;
  }
}

class FakeRunner {
  constructor(id, options) {
    this.runner = id; this.options = options;
    this.scope = new FakeScope(options.fault, options.trace);
  }
  async openSession(request) {
    this.options.trace('open');
    if (this.options.fault === 'open') throw Error('fixture open failure');
    this.session = Object.freeze({ runner: this.runner, sessionId: 'fixture-session', workspace: request.workspace,
      provider: request.binding.provider, model: this.options.fault === 'session' ? 'wrong' : request.binding.model,
      access: Object.freeze({ kind: 'read' }) });
    return this.session;
  }
  async verifyNoDelegation(session) {
    this.options.trace('verify');
    if (session !== this.session || this.options.fault === 'delegation') throw Error('fixture delegation failure');
  }
  async startTurn(session, request) {
    this.options.trace('startTurn');
    if (session !== this.session || request.effort !== 'high' || this.options.fault === 'start') throw Error('fixture turn failure');
    await this.options.onDispatch(this.runner, this.options.request);
    return 'fixture-turn';
  }
  async waitForTurn(session, turnId, stopped) {
    this.options.trace('wait');
    if (session !== this.session || turnId !== 'fixture-turn' || stopped() || this.options.fault === 'wait') throw Error('fixture wait failure');
    return { threadId: session.sessionId, turnId, status: 'completed', messages: [`fixture:${this.runner}`] };
  }
  close() { return this.scope.stop(); }
}

class FakeRunnerFactory {
  constructor(runner, options) { this.runner = runner; this.options = options; }
  async models() {
    this.options.trace(`models:${this.runner}`);
    return [{ runner: this.runner, provider: 'fixture', model: 'fake-readonly', reasoning: ['high'] }];
  }
  async verifyCapabilities() {
    this.options.trace(`capabilities:${this.runner}`);
    return { sandboxVerified: false, stopVerified: this.options.fault !== 'capability' };
  }
  async start(givenWorkspace) {
    this.options.trace(`factory:${this.runner}`);
    if (givenWorkspace !== workspace || this.options.fault === 'factory') throw Error('fixture factory failure');
    return new FakeRunner(this.runner, this.options);
  }
}

export class StopUnconfirmed extends Error {}

// Hooks are supplied only by local tests, never by broker requests or the stdio server.
export function fixtureRegistryDispatcher({ onDispatch = () => {}, trace = () => {}, fault } = {}) {
  return async request => {
    const binding = request.binding;
    const options = { onDispatch, trace, fault, request };
    const registry = new RunnerRegistry(ids.map(id => new FakeRunnerFactory(id, options)));
    let runner, result, error;
    try {
      const factory = registry.get(binding.runner);
      const models = await factory.models();
      if (!models.some(model => model.runner === binding.runner && model.provider === binding.provider && model.model === binding.model && model.reasoning.includes(binding.reasoning))) throw Error('fixture binding rejected');
      if ((await factory.verifyCapabilities()).stopVerified !== true) throw Error('fixture capability rejected');
      runner = await factory.start(workspace);
      const session = await runner.openSession({ workspace, binding, access: { kind: 'read' } });
      verifiedSession(runner, session, session.sessionId);
      assertSessionBound(session, binding, workspace);
      if (session.access?.kind !== 'read') throw Error('fixture access rejected');
      await runner.verifyNoDelegation(session);
      const turnId = await runner.startTurn(session, { prompt: request.prompt, effort: binding.reasoning });
      const turn = await runner.waitForTurn(session, turnId, () => false);
      if (turn.threadId !== session.sessionId || turn.turnId !== turnId || turn.status !== 'completed') throw Error('fixture result rejected');
      result = { runner: binding.runner, status: turn.status, messages: turn.messages };
    } catch (cause) { error = cause; }
    if (runner) {
      try { if (await runner.close() !== true || await runner.scope.isActive()) error = new StopUnconfirmed(); }
      catch { error = new StopUnconfirmed(); }
    }
    if (error) throw error;
    return result;
  };
}
