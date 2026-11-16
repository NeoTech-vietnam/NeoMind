import { createHash } from 'node:crypto';
import { fixtureRegistryDispatcher, StopUnconfirmed } from './fixture-registry.mjs';

const ids = new Set(['codex', 'claude-code', 'opencode']);
const keys = ['version', 'taskId', 'idempotencyKey', 'binding', 'access', 'prompt'];
const bindingKeys = ['runner', 'provider', 'model', 'reasoning'];
const exact = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

function validate(request) {
  if (!exact(request, keys) || request.version !== 1 || !identifier(request.taskId) || !identifier(request.idempotencyKey)
    || !exact(request.binding, bindingKeys) || !ids.has(request.binding.runner)
    || request.binding.provider !== 'fixture' || request.binding.model !== 'fake-readonly'
    || request.binding.reasoning !== 'high' || request.access !== 'read'
    || typeof request.prompt !== 'string' || request.prompt.length < 1 || request.prompt.length > 4096) {
    throw new Error('invalid_request');
  }
  return request;
}

export class FixtureBroker {
  #entries = new Map();
  #dispatch;
  constructor(onDispatch, testOptions = {}) { this.#dispatch = fixtureRegistryDispatcher({ ...testOptions, onDispatch }); }

  async execute(input) {
    let request;
    try { request = validate(input); } catch { return { ok: false, error: 'invalid_request' }; }
    // Copy before yielding so callers cannot change the authorized payload during dispatch.
    request = structuredClone(request);
    const { version, taskId, idempotencyKey, binding, access, prompt } = request;
    const hash = createHash('sha256').update(JSON.stringify([version, taskId, idempotencyKey,
      binding.runner, binding.provider, binding.model, binding.reasoning, access, prompt])).digest('hex');
    const key = JSON.stringify([taskId, idempotencyKey]);
    const previous = this.#entries.get(key);
    if (previous) return previous.hash === hash ? structuredClone(await previous.result) : { ok: false, error: 'idempotency_conflict' };
    const entry = { hash, result: undefined };
    // Reserve synchronously, before invoking even an asynchronous fake runner.
    entry.result = Promise.resolve().then(async () => {
      try {
        const result = await this.#dispatch(request);
        return { ok: true, result };
      } catch (error) {
        // The outcome is deliberately sticky: never dispatch again automatically.
        return { ok: false, error: error instanceof StopUnconfirmed ? 'stop_unconfirmed' : 'dispatch_failed' };
      }
    });
    this.#entries.set(key, entry);
    return structuredClone(await entry.result);
  }
}
