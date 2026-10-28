import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../extensions/vscode-model-bridge/extension.cjs', import.meta.url), 'utf8');
// Stub only dynamic import: custom VM import hooks otherwise need experimental Node flags.
assert.equal([...source.matchAll(/\bimport\(/g)].length, 2);
const executable = source.replaceAll('import(', 'importRuntime(');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup(blocked, { trusted = true, globalRuntime = true, packageName = 'workforce', controlled = true, controlledFailure = false,
  closeAt, closeFailure = false, savedConnection, fingerprint = 'fixture-build', approval = 'Connect', stateUpdate, probeValid = true,
  catalogPath = resolve('fixture-catalog.json'), discoveredCatalog = null, nativeCatalog, rejectAbortedProbe = false } = {}) {
  const entered = deferred(), release = deferred();
  const closeEntered = deferred(), closeRelease = deferred();
  let closeHeld = false, controlledCloses = 0;
  const calls = { folder: 0, consent: 0, import: 0, startup: 0, close: 0, runtime: 0, probe: 0, catalog: 0 };
  const info = [], errors = [], commands = new Map(), subscriptions = [];
  const lifecycle = [], state = new Map(savedConnection ? [['workforce.connection', savedConnection === true ? { root: resolve('workspace'), runtime: resolve('trusted-runtime'), fingerprint } : savedConnection]] : []), connections = [], catalogs = [];
  const workspaceState = { get: key => state.get(key), async update(key, value) { if (stateUpdate) await stateUpdate(key, value); value === undefined ? state.delete(key) : state.set(key, value); } };
  const flush = async () => { for(let i=0;i<12;i++) await new Promise(resolve => setImmediate(resolve)); };
  const runtime = resolve('trusted-runtime'), root = resolve('workspace');
  const folder = { uri: { scheme: 'file', fsPath: root } };
  async function closingStep(stage) {
    if (closeAt !== stage || closeHeld) return;
    closeHeld = true; closeEntered.resolve(); await closeRelease.promise;
    if (closeFailure) throw new Error('Fixture owner close did not finish safely.');
  }
  const host = { async close() { calls.close++; lifecycle.push('bridge-close'); await closingStep('bridge'); } };
  function step(name, value) {
    calls[name]++;
    if (name !== blocked || calls[name] > 1) return Promise.resolve(value);
    entered.resolve();
    return release.promise.then(() => value);
  }
  let foldersChanged;
  const vscode = {
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; },
    },
    workspace: {
      isTrusted: trusted,
      workspaceFolders: blocked === 'folder' ? [] : [folder],
      getConfiguration(name) {
        assert.equal(name, 'workforce.bridge');
        return { inspect(key) {
          assert.equal(key, 'runtimePath');
          return { globalValue: globalRuntime ? runtime : undefined, workspaceValue: resolve('untrusted-runtime') };
        } };
      },
      onDidChangeWorkspaceFolders(callback) { foldersChanged = callback; return { dispose() {} }; },
    },
    window: {
      showWorkspaceFolderPick: async () => { const selected = await step('folder', folder); vscode.workspace.workspaceFolders = [folder]; return selected; },
      showWarningMessage: () => step('consent', approval),
      showOpenDialog: () => step('catalog', nativeCatalog ? [{ scheme: 'file', fsPath: nativeCatalog }] : undefined),
      showInformationMessage: message => info.push(message),
      showErrorMessage: message => errors.push(message),
    },
  };
  const module = { exports: {} };
  runInNewContext(executable, {
    module,
    AbortController,
    require(name) {
      if (name === './monitor.cjs') return { activateMonitor(_vscode, _context, _loader, connection) { connections.push(connection); } };
      if (name === './plugin-panel.cjs') return require('../extensions/vscode-model-bridge/plugin-panel.cjs');
      if (name === './automation-panel.cjs') return require('../extensions/vscode-model-bridge/automation-panel.cjs');
      if (name === './native-validation.cjs') return require('../extensions/vscode-model-bridge/native-validation.cjs');
      if (name === './native-dispatch.cjs') return require('../extensions/vscode-model-bridge/native-dispatch.cjs');
      if (name === './controlled-workflows.cjs') return require('../extensions/vscode-model-bridge/controlled-workflows.cjs');
      if (name === 'vscode') return vscode;
      if (name === 'node:fs') return {
        realpathSync: { native: path => path },
        readFileSync(path) {
          assert.equal(path, resolve(runtime, 'package.json'));
          return JSON.stringify({ name: packageName });
        },
      };
      return require(name);
    },
    importRuntime(url) {
      if (url === pathToFileURL(resolve(runtime, 'dist/index.js')).href) return step('runtime', controlled || controlledFailure ? {
        readRoutingPolicy() { return { language_models_file: catalogPath }; },
        discoverWorkForceModelCatalog() { return { path: discoveredCatalog, candidates: [] }; },
        configureWorkForceModelCatalog(selectedRoot, input) { assert.equal(selectedRoot, root); catalogs.push(input.path); catalogPath = input.path; return { path: input.path }; },
        async probeWorkForceConnection(selectedRoot, signal) {
          assert.equal(selectedRoot, root); assert.ok(signal instanceof AbortSignal);
          if (rejectAbortedProbe) return new Promise((_resolve, reject) => { entered.resolve(); signal.addEventListener('abort', () => reject(new Error('Fixture probe was canceled')), { once: true }); });
          await step('probe'); return { valid: probeValid };
        },
        async startControlledHost(selectedRoot) {
          assert.equal(selectedRoot, root); lifecycle.push('controlled-start');
          if (controlledFailure) throw new Error('Controller startup failed.');
          return { async close() { controlledCloses++; lifecycle.push('controlled-close'); await closingStep('controlled'); } };
        },
        createRuntimeInfo() { return { build_fingerprint: fingerprint }; },
      } : {});
      assert.equal(url, pathToFileURL(resolve(runtime, 'dist/workforce-host.js')).href);
      return step('import', { enableWorkForceHost(api, selectedRoot) {
        assert.equal(api, vscode);
        assert.equal(selectedRoot, root);
        return step('startup', host);
      } });
    },
  }, { filename: 'extension.cjs' });
  vscode.lm = { selectChatModels() { throw new Error('WorkForce must not select VS Code models for OpenCode execution.'); }, sendRequest() { throw new Error('No custom model loop is permitted.'); } };
  module.exports.activate({ subscriptions, workspaceState });
  return {
    calls, info, errors, lifecycle, root, runtime, state, connections, catalogs, vscode, flush, entered: entered.promise, release: release.resolve,
    closeEntered: closeEntered.promise, releaseClose: closeRelease.resolve,
    get controlledCloses() { return controlledCloses; },
    enable: commands.get('workforce.bridge.enable'),
    disable: commands.get('workforce.bridge.disable'),
    deactivate: module.exports.deactivate,
    foldersChanged: () => foldersChanged(),
    dispose: () => subscriptions.at(-1).dispose(),
  };
}

for (const closeAt of ['controlled', 'bridge']) {
  test(`concurrent disable, disposal and deactivation wait for the same ${closeAt} shutdown`, async () => {
    const app = setup(undefined, { controlled: true, closeAt });
    await app.enable();
    const first = app.disable(); await app.closeEntered;
    const repeated = [app.disable(), app.dispose(), app.deactivate()];
    const settled = repeated.map(() => false);
    repeated.forEach((promise, index) => Promise.resolve(promise).then(() => { settled[index] = true; }));
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(settled, [false, false, false], 'Editor disposal/deactivation must not finish while the owner is still draining.');
      assert.equal(repeated[1], repeated[2], 'Disposal and deactivation retain the same in-flight shutdown.');
      assert.equal(app.controlledCloses, 1);
      assert.equal(app.calls.close, closeAt === 'controlled' ? 0 : 1);
    } finally { app.releaseClose(); await Promise.all([first, ...repeated]); }
    assert.equal(app.controlledCloses, 1); assert.equal(app.calls.close, 1);
  });
}

test('enable waits for the prior owner to finish closing before consent or replacement startup', async () => {
  const app = setup(undefined, { controlled: true, closeAt: 'controlled' });
  await app.enable();
  const close = app.disable(); await app.closeEntered;
  const enable = app.enable();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.calls.consent, 1, 'No replacement consent or host startup while the previous owner drains.');
    assert.equal(app.calls.startup, 1);
  } finally { app.releaseClose(); await Promise.all([close, enable]); }
  assert.equal(app.calls.startup, 2); assert.equal(app.info.length, 2);
  await app.disable(); assert.equal(app.calls.close, 2); assert.equal(app.controlledCloses, 2);
});

test('disposal revokes a replacement enable that is still awaiting the prior shutdown', async () => {
  const app = setup(undefined, { controlled: true, closeAt: 'controlled' });
  await app.enable();
  const close = app.disable(); await app.closeEntered;
  const enable = app.enable();
  const dispose = app.dispose();
  app.releaseClose(); await Promise.all([close, dispose, enable]);
  assert.equal(app.calls.consent, 1); assert.equal(app.calls.startup, 1);
  assert.equal(app.info.length, 1); assert.deepEqual(app.errors, []);
});

test('a failed owner close remains observable and prevents an unsafe replacement enable', async () => {
  const app = setup(undefined, { controlled: true, closeAt: 'controlled', closeFailure: true });
  await app.enable();
  const close = app.disable(); await app.closeEntered;
  app.releaseClose(); await assert.rejects(close, /Fixture owner close/);
  await app.enable();
  assert.equal(app.calls.startup, 1); assert.equal(app.calls.consent, 1);
  assert.equal(app.errors.length, 1, 'A replacement attempt surfaces the prior shutdown failure.');
  await assert.rejects(app.deactivate(), /Fixture owner close/);
  assert.equal(app.calls.close, 1, 'The model host close still runs after a controlled-owner close failure.');
});

test('OpenCode controller starts only after workspace connection consent and drains before the control owner', async () => {
  const app = setup(undefined, { controlled: true });
  assert.deepEqual(app.lifecycle, []);
  await app.enable();
  assert.deepEqual(app.lifecycle, ['controlled-start']);
  assert.match(app.info[0], /OpenCode owns worker sessions/);
  await app.disable();
  assert.deepEqual(app.lifecycle, ['controlled-start', 'controlled-close', 'bridge-close']);
});

test('controller startup failure closes the already-created model Bridge', async () => {
  const app = setup(undefined, { controlledFailure: true });
  await app.enable();
  assert.deepEqual(app.lifecycle, ['controlled-start', 'bridge-close']);
  assert.equal(app.info.length, 0); assert.equal(app.errors.length, 1);
  await app.disable(); assert.equal(app.calls.close, 1);
});

test('panel can enable its exact bound project without choosing another workspace', async () => {
  const app = setup(undefined, { controlled: true });
  await app.enable(app.root);
  assert.equal(app.calls.folder, 0); assert.equal(app.calls.consent, 1);
  assert.deepEqual(app.lifecycle, ['controlled-start']);
  await app.disable();
});

test('an explicit foreign project is rejected before consent or host creation', async () => {
  const app = setup(undefined, { controlled: true });
  await app.enable(resolve('not-open-project'));
  assert.equal(app.calls.folder, 0); assert.equal(app.calls.consent, 0); assert.equal(app.calls.startup, 0);
  assert.equal(app.errors.length, 1); assert.match(app.errors[0], /exact open workspace folder/);
});

for (const stage of ['folder', 'runtime', 'consent', 'import', 'startup']) {
  test(`disable revokes enable awaiting ${stage}; explicit retry works`, async () => {
    const app = setup(stage);
    const pending = app.enable();
    await app.entered;
    await app.enable(); // Concurrent enable remains suppressed.
    assert.equal(app.calls[stage], 1);
    await app.disable();
    app.release();
    await pending;
    assert.equal(app.calls.startup, stage === 'startup' ? 1 : 0);
    assert.equal(app.calls.close, stage === 'startup' ? 1 : 0);
    if (stage === 'folder') assert.equal(app.calls.consent, 0);
    if (stage === 'consent') assert.equal(app.calls.import, 0);
    assert.deepEqual(app.info, []);
    assert.deepEqual(app.errors, []);
    await app.disable();
    assert.equal(app.calls.close, stage === 'startup' ? 1 : 0);
    await app.enable();
    assert.equal(app.info.length, 1);
    await app.disable();
    assert.equal(app.calls.close, stage === 'startup' ? 2 : 1);
  });
}

for (const revoke of ['deactivate', 'foldersChanged', 'dispose']) {
  test(`${revoke} closes host returned after revocation`, async () => {
    const app = setup('startup');
    const pending = app.enable();
    await app.entered;
    await app[revoke]();
    app.release();
    await pending;
    assert.equal(app.calls.close, 1);
    assert.deepEqual(app.info, []);
    assert.deepEqual(app.errors, []);
    await app.disable();
    assert.equal(app.calls.close, 1);
  });
}

test('activation stays idle; explicit enable uses User runtime; disable closes once', async () => {
  const app = setup();
  assert.deepEqual(app.calls, { folder: 0, consent: 0, import: 0, startup: 0, close: 0, runtime: 0, probe: 0, catalog: 0 });
  await app.enable();
  assert.equal(app.calls.startup, 1);
  assert.equal(app.info.length, 1);
  assert.deepEqual(app.errors, []);
  await app.disable();
  await app.disable();
  assert.equal(app.calls.close, 1);
});

test('approved exact workspace/runtime/build restores after reload without another consent or any VS Code model loop', async () => {
  const app = setup(undefined, { savedConnection: true });
  await app.flush();
  assert.equal(app.calls.consent, 0); assert.equal(app.calls.startup, 1);
  assert.equal(app.connections[0].enabled(app.root), true);
  assert.deepEqual(app.info, []); assert.deepEqual(app.errors, []);
  await app.enable(app.root); assert.equal(app.calls.startup, 1, 'Repeated Connect shares the existing owner.');
  await app.disable(); assert.equal(app.connections[0].enabled(app.root), false);
  assert.equal(app.state.has('workforce.connection'), false); assert.equal(app.calls.close, 1);
});

for (const changed of ['root', 'runtime', 'fingerprint']) {
  test(`saved approval is not reused after ${changed} changes`, async () => {
    const saved = { root: resolve('workspace'), runtime: resolve('trusted-runtime'), fingerprint: 'fixture-build', [changed]: 'changed' };
    const app = setup(undefined, { savedConnection: saved });
    await app.flush();
    assert.equal(app.calls.startup, 0); assert.equal(app.calls.consent, 0, 'Automatic restore never asks for a replacement approval.');
    await app.enable(app.root); assert.equal(app.calls.consent, 1); assert.equal(app.calls.startup, 1);
    assert.equal(app.state.get('workforce.connection').fingerprint, 'fixture-build'); await app.disable();
  });
}

test('declining workspace connection consent leaves execution disabled', async () => {
  const dismissed = setup(undefined, { approval: 'Cancel' });
  await dismissed.enable(); assert.equal(dismissed.calls.startup, 0);
  assert.equal(dismissed.connections[0].enabled(dismissed.root), false);
  assert.equal(dismissed.state.has('workforce.connection'), false); assert.deepEqual(dismissed.info, []);
  await dismissed.deactivate();
});

test('disconnect revokes pending connection immediately even while saving its approval removal', async () => {
  const persisted = deferred(), writeEntered = deferred();
  const app = setup('consent', { async stateUpdate(_key, value) { if (value === undefined) { writeEntered.resolve(); await persisted.promise; } } });
  const pending = app.enable(); await app.entered;
  const disconnect = app.disable(); await writeEntered.promise;
  app.release(); await pending;
  assert.equal(app.calls.startup, 0, 'Pending consent cannot create an owner while the settings update drains.');
  assert.equal(app.connections[0].enabled(app.root), false);
  persisted.resolve(); await disconnect;
});

test('trust revoked while consent is pending prevents owner and controller startup', async () => {
  const app = setup('consent'), pending = app.enable(); await app.entered;
  app.vscode.workspace.isTrusted = false; app.release(); await pending;
  assert.equal(app.calls.startup, 0); assert.equal(app.controlledCloses, 0);
  assert.equal(app.connections[0].enabled(app.root), false); await app.disable();
});

test('a failed capability probe closes the control owner and never starts the request controller', async () => {
  const app = setup(undefined, { probeValid: false }); await app.enable();
  assert.equal(app.calls.probe, 1); assert.equal(app.calls.close, 1); assert.deepEqual(app.lifecycle, ['bridge-close']);
  assert.equal(app.connections[0].enabled(app.root), false); assert.equal(app.state.has('workforce.connection'), false);
  assert.match(app.errors[0], /capability check did not pass/); assert.deepEqual(app.info, []);
});

test('disconnect during the actual capability check closes its late owner without starting requests', async () => {
  const app = setup('probe'), pending = app.enable(); await app.entered;
  await app.disable(); app.release(); await pending;
  assert.equal(app.calls.probe, 1); assert.equal(app.calls.close, 1);
  assert.deepEqual(app.lifecycle, ['bridge-close']); assert.equal(app.connections[0].enabled(app.root), false);
});

test('late approval persistence cannot restore an explicitly disconnected connection or show a stale success', async () => {
  const saving = deferred(), saveEntered = deferred();
  const app = setup(undefined, { async stateUpdate(_key, value) { if (value !== undefined) { saveEntered.resolve(); await saving.promise; } } });
  const connect = app.enable(); await saveEntered.promise;
  const stop = app.disable(); await app.flush();
  assert.equal(app.calls.close, 1, 'Shutdown does not wait for settings persistence.');
  saving.resolve(); await Promise.all([connect, stop]);
  assert.equal(app.state.has('workforce.connection'), false); assert.deepEqual(app.info, []);
  assert.equal(app.connections[0].enabled(app.root), false);
});

test('an aborted capability probe closes the owner without presenting cancellation as a connection failure', async () => {
  const app = setup(undefined, { rejectAbortedProbe: true }), connect = app.enable(); await app.entered;
  await app.disable(); await connect;
  assert.equal(app.calls.close, 1); assert.deepEqual(app.errors, []); assert.deepEqual(app.info, []);
});

test('a unique validated catalog is configured automatically only when no authored pointer exists', async () => {
  const app = setup(undefined, { catalogPath: null, discoveredCatalog: resolve('Code/User/chatLanguageModels.json') });
  await app.enable(); assert.deepEqual(app.catalogs, [resolve('Code/User/chatLanguageModels.json')]);
  assert.equal(app.calls.catalog, 0); assert.equal(app.calls.probe, 1); await app.disable();
  const existing = setup(undefined, { discoveredCatalog: resolve('other-catalog.json') });
  await existing.enable(); assert.deepEqual(existing.catalogs, []); assert.equal(existing.calls.catalog, 0); await existing.disable();
});

test('an unresolved catalog uses a native picker and cancellation never launches an owner', async () => {
  const app = setup(undefined, { catalogPath: null, nativeCatalog: resolve('chosen-catalog.json') });
  await app.enable(); assert.deepEqual(app.catalogs, [resolve('chosen-catalog.json')]); assert.equal(app.calls.catalog, 1); await app.disable();
  const canceled = setup(undefined, { catalogPath: null }); await canceled.enable();
  assert.equal(canceled.calls.startup, 0); assert.equal(canceled.calls.probe, 0); assert.equal(canceled.state.has('workforce.connection'), false);
  const late = setup('catalog', { catalogPath: null, nativeCatalog: resolve('chosen-catalog.json') }), pending = late.enable(); await late.entered;
  await late.disable(); late.release(); await pending; assert.deepEqual(late.catalogs, []); assert.equal(late.calls.startup, 0);
});

for (const [options, message] of [
  [{ trusted: false }, /Workspace Trust/],
  [{ globalRuntime: false }, /Workspace overrides are ignored/],
  [{ packageName: 'untrusted-package' }, /not a WorkForce package/],
  [{ packageName: 'verythinker' }, /not a WorkForce package/],
]) {
  test(`enable rejects ${JSON.stringify(options)}`, async () => {
    const app = setup(undefined, options);
    await app.enable();
    assert.equal(app.errors.length, 1);
    assert.match(app.errors[0], message);
    assert.equal(app.calls.consent, 0);
    assert.equal(app.calls.import, 0);
    assert.equal(app.calls.startup, 0);
  });
}
