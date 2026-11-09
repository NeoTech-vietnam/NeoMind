import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { captureInstalledDescriptor, createInstalledEntryObserver, nativeTools } = require('./vscode-client-driver/native-local/installed-entry.cjs');
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'wf-installed-observer-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const repository = join(base, 'source'), runtimeRoot = join(base, 'installed-runtime'), extensionRoot = join(base, 'installed-extension'), workspace = join(base, 'project');
  for (const path of [repository, workspace, join(runtimeRoot, 'dist'), join(runtimeRoot, 'resources'), extensionRoot]) mkdirSync(path, { recursive: true });
  writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'workforce', version: '0.3.0-alpha.1' }));
  writeFileSync(join(runtimeRoot, 'dist/index.js'), '// Test fixture pin only; the observer must never require a source runner.\n');
  writeFileSync(join(runtimeRoot, 'resources/native.md'), 'Native product guidance\n');
  const metadata = { name: 'workforce-model-bridge', publisher: 'workforce', version: '0.13.0', files: ['extension.cjs'],
    contributes: { languageModelTools: nativeTools.map(name => ({ name })) } };
  writeFileSync(join(extensionRoot, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(extensionRoot, 'extension.cjs'), "throw Error('The observer must use public extension.activate, never require product entry');\n");
  writeFileSync(join(workspace, 'product.c'), 'int result = 1;\n');
  const installedProduct = captureInstalledDescriptor({ repository, runtimeRoot, extensionRoot });
  const settings = { globalValue: runtimeRoot }, outputs = [], imported = [], calls = { activation: 0, snapshot: 0, trust: 0 };
  const info = { package_version: '0.3.0-alpha.1', runtime_root: runtimeRoot, build_fingerprint: 'a'.repeat(64) };
  const entry = { extensionUri: { fsPath: extensionRoot }, packageJSON: metadata, isActive: false, async activate() { calls.activation++; this.isActive = true; } };
  const vscode = { extensions: { getExtension(id) { assert.equal(id, 'workforce.workforce-model-bridge'); return entry; } },
    workspace: { getConfiguration(section) { assert.equal(section, 'workforce.bridge'); return { inspect(name) { assert.equal(name, 'runtimePath'); return settings; } }; } },
    lm: { tools: nativeTools.map(name => ({ name })) } };
  const observer = createInstalledEntryObserver(vscode, { nativeInstalledEntry: true, repository, workspace, installedProduct, evidence: base }, {
    requireTrustedFixture() { calls.trust++; }, write(file, value) { outputs.push({ file, value }); }, async importRuntime(url) { imported.push(url); return {
      createRuntimeInfo() { return info; },
      requestListForMonitor(root) { assert.equal(realpathSync.native(root), realpathSync.native(workspace)); calls.snapshot++; return { requests: [{ workflow_id: 'real-reader-fixture', accepted: false,
        artifacts: [{ path: 'product.c' }], evidence: [], stages: [{ id: 'coding', state: 'pending' }] }] }; },
    }; } });
  return { ...calls, calls, base, repository, runtimeRoot, extensionRoot, workspace, installedProduct, settings, outputs, imported, entry, vscode, observer, info };
}
test('installed observer uses the exact active product and global runtime, imports only installed code, and snapshots read-only artifacts', async t => {
  const f = fixture(t), value = await f.observer.inspect();
  assert.equal(value.active, true); assert.equal(value.entry, 'installed-vsix'); assert.equal(value.backend_registration, false); assert.equal(value.model_calls, 0);
  assert.equal(f.calls.activation, 1); assert.deepEqual(f.imported, [pathToFileURL(join(realpathSync.native(f.runtimeRoot), 'dist/index.js')).href]);
  const result = await f.observer.snapshot('final'); assert.equal(result.observed, true);
  assert.equal(f.calls.activation, 1); assert.equal(f.calls.snapshot, 1); assert.equal(f.outputs[0].value.snapshot.requests[0].accepted, false);
  assert.equal(f.outputs[0].value.files[0].bytes, readFileSync(join(f.workspace, 'product.c')).length);
  assert.match(f.outputs[0].value.files[0].sha256, /^[a-f0-9]{64}$/); assert.equal(f.outputs[0].value.dispatch_performed, false);
});
test('workspace runtime settings cannot substitute for an unconfigured or different User runtime', async t => {
  const f = fixture(t); f.settings.workspaceValue = f.runtimeRoot; delete f.settings.globalValue;
  await assert.rejects(f.observer.inspect(), { code: 'INSTALLED_USER_RUNTIME_MISMATCH' });
  assert.equal(f.calls.activation, 0); assert.equal(f.imported.length, 0);
});
test('source checkout, changed installed bytes and wrong product path never fall back to a development backend', async t => {
  const f = fixture(t);
  assert.throws(() => captureInstalledDescriptor({ repository: f.repository, runtimeRoot: f.repository, extensionRoot: f.extensionRoot }), { code: 'INSTALLED_SOURCE_FALLBACK_FORBIDDEN' });
  writeFileSync(join(f.extensionRoot, 'extension.cjs'), '// changed after descriptor\n');
  await assert.rejects(f.observer.inspect(), { code: 'INSTALLED_PACKAGE_BYTES_CHANGED' });
  assert.equal(f.calls.activation, 0); assert.equal(f.imported.length, 0);
  f.entry.extensionUri.fsPath = f.repository;
  await assert.rejects(f.observer.inspect(), { code: 'INSTALLED_EXTENSION_MISMATCH' });
});
test('missing or duplicate public native tool references keep installed readiness unproven', async t => {
  const f = fixture(t); f.vscode.lm.tools.push({ name: nativeTools[0] });
  await assert.rejects(f.observer.inspect(), { code: 'INSTALLED_NATIVE_TOOL_INVENTORY_MISMATCH' }); assert.equal(f.imported.length, 0);
  f.vscode.lm.tools = f.vscode.lm.tools.slice(1, -1);
  await assert.rejects(f.observer.inspect(), { code: 'INSTALLED_NATIVE_TOOL_INVENTORY_MISMATCH' });
});
test('an imported API reporting a different loaded runtime root cannot be certified as the installed package', async t => {
  const f = fixture(t); f.info.runtime_root = f.repository;
  await assert.rejects(f.observer.inspect(), { code: 'INSTALLED_RUNTIME_VERSION_MISMATCH' }); assert.equal(f.calls.snapshot, 0);
});
