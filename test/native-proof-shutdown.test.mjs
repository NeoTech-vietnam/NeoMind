import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);

test('the owned native proof extension deactivation awaits production entry disposal instead of abandoning active work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-proof-shutdown-')), subscriptions = [];
  t.after(() => { for (const disposable of subscriptions) disposable.dispose?.();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  let release, closing = false, ended = false;
  const drain = new Promise(done => { release = done; });
  const entry = { async dispose() { closing = true; await drain; ended = true; } };
  const fixture = { evidence: root, workspace: root, coordinator: 'WF.PM', nativePilot: true };
  const vscode = { ExtensionMode: { Test: 3 }, workspace: { isTrusted: false,
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], onDidGrantWorkspaceTrust: () => ({ dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }) } };
  const module = { exports: {} };
  runInNewContext(readFileSync(new URL('./vscode-client-driver/native-local/extension.cjs', import.meta.url), 'utf8'), {
    module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout,
    require(name) { if (name === 'vscode') return vscode; if (name === './fixture.json') return fixture;
      if (name === './native-pilot.cjs') return { activateNativePilot: async () => entry }; return require(name); },
  });
  assert.equal(typeof module.exports.deactivate, 'function');
  module.exports.activate({ subscriptions, extensionMode: 2 });
  const shutdown = module.exports.deactivate();
  await new Promise(done => setImmediate(done));
  assert.equal(closing, true); assert.equal(ended, false);
  let returned = false; shutdown.then(() => { returned = true; });
  await new Promise(done => setImmediate(done)); assert.equal(returned, false);
  release(); await shutdown; assert.equal(ended, true);
  assert.equal(module.exports.deactivate(), shutdown, 'Repeated deactivation joins the same drain');
});
