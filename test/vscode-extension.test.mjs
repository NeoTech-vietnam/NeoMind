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
assert.equal(source.split('await import(').length, 3);
const executable = source.replaceAll('await import(', 'await importRuntime(');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup(blocked, { trusted = true, globalRuntime = true, packageName = 'neomind', controlled = false, controlledFailure = false,
  closeAt, closeFailure = false } = {}) {
  const entered = deferred(), release = deferred();
  const closeEntered = deferred(), closeRelease = deferred();
  let closeHeld = false, controlledCloses = 0;
  const calls = { folder: 0, consent: 0, import: 0, startup: 0, close: 0 };
  const info = [], errors = [], commands = new Map(), subscriptions = [];
  const lifecycle = [];
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
        assert.equal(name, 'neomind.bridge');
        return { inspect(key) {
          assert.equal(key, 'runtimePath');
          return { globalValue: globalRuntime ? runtime : undefined, workspaceValue: resolve('untrusted-runtime') };
        } };
      },
      onDidChangeWorkspaceFolders(callback) { foldersChanged = callback; return { dispose() {} }; },
    },
    window: {
      showWorkspaceFolderPick: async () => { const selected = await step('folder', folder); vscode.workspace.workspaceFolders = [folder]; return selected; },
      showWarningMessage: () => step('consent', 'Enable'),
      showInformationMessage: message => info.push(message),
      showErrorMessage: message => errors.push(message),
    },
  };
  const module = { exports: {} };
  runInNewContext(executable, {
    module,
    require(name) {
      if (name === './monitor.cjs') return { activateMonitor() {} };
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
      if (url === pathToFileURL(resolve(runtime, 'dist/index.js')).href) return Promise.resolve(controlled || controlledFailure ? {
        async startControlledHost(selectedRoot) {
          assert.equal(selectedRoot, root); lifecycle.push('controlled-start');
          if (controlledFailure) throw new Error('Controller startup failed.');
          return { async close() { controlledCloses++; lifecycle.push('controlled-close'); await closingStep('controlled'); } };
        },
      } : {});
      assert.equal(url, pathToFileURL(resolve(runtime, 'dist/vscode-host.js')).href);
      return step('import', { enableVSCodeHost(api, selectedRoot) {
        assert.equal(api, vscode);
        assert.equal(selectedRoot, root);
        return step('startup', host);
      } });
    },
  }, { filename: 'extension.cjs' });
  module.exports.activate({ subscriptions });
  return {
    calls, info, errors, lifecycle, root, entered: entered.promise, release: release.resolve,
    closeEntered: closeEntered.promise, releaseClose: closeRelease.resolve,
    get controlledCloses() { return controlledCloses; },
    enable: commands.get('neomind.bridge.enable'),
    disable: commands.get('neomind.bridge.disable'),
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
      repeated.forEach(promise => assert.equal(promise, first, 'All lifecycle entry points retain the same in-flight close promise.'));
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

test('controlled runtime starts only after consented Bridge and shuts down before model host', async () => {
  const app = setup(undefined, { controlled: true });
  assert.deepEqual(app.lifecycle, []);
  await app.enable();
  assert.deepEqual(app.lifecycle, ['controlled-start']);
  assert.match(app.info[0], /Controlled workflows are ready/);
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

for (const stage of ['folder', 'consent', 'import', 'startup']) {
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
  assert.deepEqual(app.calls, { folder: 0, consent: 0, import: 0, startup: 0, close: 0 });
  await app.enable();
  assert.equal(app.calls.startup, 1);
  assert.equal(app.info.length, 1);
  assert.deepEqual(app.errors, []);
  await app.disable();
  await app.disable();
  assert.equal(app.calls.close, 1);
});

for (const [options, message] of [
  [{ trusted: false }, /Workspace Trust required/],
  [{ globalRuntime: false }, /Workspace overrides are ignored/],
  [{ packageName: 'untrusted-package' }, /not a NeoMind package/],
  [{ packageName: 'verythinker' }, /Reinstall the renamed runtime/],
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
