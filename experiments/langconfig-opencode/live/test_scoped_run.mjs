import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runScoped } from './scoped_run.mjs';

for (const signal of ['SIGINT', 'SIGTERM']) {
  const signals = new EventEmitter();
  let stopped = 0, aborted = false;
  const scope = { start: async () => ({}), stop: async () => { stopped++; return true; } };
  const promise = runScoped({ scope, signals, launch: {}, runChild: async (_, abort) => {
    abort.addEventListener('abort', () => { aborted = true; });
    signals.emit(signal);
    return await new Promise(() => {});
  } });
  const result = await promise;
  assert.deepEqual(result, { outcome: 'interrupted', signal });
  assert.equal(stopped, 1);
  assert.equal(aborted, true);
  assert.equal(signals.listenerCount(signal), 0);
}

{
  class EarlySignal extends EventEmitter {
    on(name, listener) {
      super.on(name, listener);
      if (name === 'SIGINT') this.emit('SIGINT');
      return this;
    }
  }
  let started = false, stopped = 0;
  const scope = { start: async () => { started = true; }, stop: async () => { stopped++; return true; } };
  const result = await runScoped({ scope, signals: new EarlySignal(), launch: {}, runChild: async () => 'completed' });
  assert.deepEqual(result, { outcome: 'interrupted', signal: 'SIGINT' });
  assert.equal(started, false);
  assert.equal(stopped, 1);
}

{
  const signals = new EventEmitter();
  let release, ran = false, stopped = 0;
  const scope = { start: () => new Promise(resolve => { release = resolve; }), stop: async () => { stopped++; return true; } };
  const promise = runScoped({ scope, signals, launch: {}, runChild: async () => { ran = true; } });
  signals.emit('SIGTERM');
  release({});
  assert.deepEqual(await promise, { outcome: 'interrupted', signal: 'SIGTERM' });
  assert.equal(ran, false);
  assert.equal(stopped, 1);
}

{
  const signals = new EventEmitter();
  const scope = { start: async () => ({}), stop: async () => { signals.emit('SIGTERM'); return true; } };
  const result = await runScoped({ scope, signals, launch: {}, runChild: async () => 'completed' });
  assert.deepEqual(result, { outcome: 'interrupted', signal: 'SIGTERM' });
}

{
  const signals = new EventEmitter();
  let called = false;
  const scope = { start: async () => ({}), stop: async () => false };
  await assert.rejects(runScoped({ scope, signals, launch: {}, runChild: async () => 'completed', onStop: stopped => { called = !stopped; } }), /stop unconfirmed/);
  assert.equal(called, true);
}
console.log('PASS scoped cancellation and stop verification');
