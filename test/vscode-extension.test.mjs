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

function setup(blocked, { trusted = true, globalRuntime = true, packageName = 'neomind' } = {}) {
  const entered = deferred(), release = deferred();
  const calls = { folder: 0, consent: 0, import: 0, startup: 0, close: 0 };
  const info = [], errors = [], commands = new Map(), subscriptions = [];
  const runtime = resolve('trusted-runtime'), root = resolve('workspace');
  const folder = { uri: { scheme: 'file', fsPath: root } };
  const host = { async close() { calls.close++; } };
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
      showWorkspaceFolderPick: () => step('folder', folder),
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
    calls, info, errors, entered: entered.promise, release: release.resolve,
    enable: commands.get('neomind.bridge.enable'),
    disable: commands.get('neomind.bridge.disable'),
    deactivate: module.exports.deactivate,
    foldersChanged: () => foldersChanged(),
    dispose: () => subscriptions.at(-1).dispose(),
  };
}

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
