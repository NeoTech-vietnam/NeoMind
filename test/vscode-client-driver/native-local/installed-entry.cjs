'use strict';
// Acceptance observer only. It never registers product tools, imports a source
// checkout backend, reads VS Code private storage or changes User settings.
const { createHash, randomUUID } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const productId = 'workforce.workforce-model-bridge';
const nativeTools = ['request', 'role', 'prepare', 'control', 'role_swsd', 'role_p_res', 'role_fnd', 'role_reviewer', 'role_tester', 'capabilities']
  .map(name => `workforce_native_${name}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, path) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\'); };
const fail = code => { throw Object.assign(new Error(code), { code }); };
function regular(root, selected) {
  if (typeof selected !== 'string' || !selected || isAbsolute(selected) || selected.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) fail('INSTALLED_PIN_PATH_INVALID');
  const file = resolve(root, selected);
  if (!inside(root, file)) fail('INSTALLED_PIN_PATH_INVALID');
  for (let current = file; !same(current, root); current = dirname(current)) if (lstatSync(current).isSymbolicLink()) fail('INSTALLED_PIN_PATH_LINKED');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) fail('INSTALLED_PIN_FILE_INVALID');
  return { file, bytes: stat.size, sha256: sha(readFileSync(file)) };
}
function codeFiles(root, folders) {
  const names = ['package.json'];
  const visit = selected => {
    const path = join(root, selected), stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail('INSTALLED_PIN_PATH_LINKED');
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(`${selected}/${child}`);
    else if (stat.isFile()) names.push(selected);
    else fail('INSTALLED_PIN_FILE_INVALID');
    if (names.length > 2000) fail('INSTALLED_PIN_LIMIT');
  };
  for (const folder of folders) visit(folder);
  return names.map(path => ({ path, sha256: regular(root, path).sha256 }));
}
function validateRoots(repository, runtimeRoot, extensionRoot) {
  const source = realpathSync.native(repository), runtime = realpathSync.native(runtimeRoot), extension = realpathSync.native(extensionRoot);
  if (inside(source, runtime) || inside(source, extension)) fail('INSTALLED_SOURCE_FALLBACK_FORBIDDEN');
  if (!lstatSync(runtime).isDirectory() || !lstatSync(extension).isDirectory()) fail('INSTALLED_PACKAGE_DIRECTORY_REQUIRED');
  return { runtime, extension };
}
function captureInstalledDescriptor({ repository, runtimeRoot, extensionRoot }) {
  const roots = validateRoots(repository, runtimeRoot, extensionRoot);
  const runtime = JSON.parse(readFileSync(join(roots.runtime, 'package.json'), 'utf8'));
  const extension = JSON.parse(readFileSync(join(roots.extension, 'package.json'), 'utf8'));
  if (runtime.name !== 'workforce' || `${extension.publisher}.${extension.name}` !== productId || typeof runtime.version !== 'string' ||
      typeof extension.version !== 'string' || !Array.isArray(extension.files)) fail('INSTALLED_PACKAGE_IDENTITY_INVALID');
  const tools = extension.contributes?.languageModelTools?.map(tool => tool.name) ?? [];
  if (!nativeTools.every(name => tools.filter(value => value === name).length === 1)) fail('INSTALLED_TOOL_MANIFEST_INVALID');
  return { schema_version: 1,
    runtime: { root: roots.runtime, version: runtime.version, files: codeFiles(roots.runtime, ['dist', 'resources']) },
    extension: { id: productId, root: roots.extension, version: extension.version,
      files: [...new Set(['package.json', ...extension.files])].map(path => ({ path, sha256: regular(roots.extension, path).sha256 })) },
  };
}
function createInstalledEntryObserver(vscode, fixture, { requireTrustedFixture, write, importRuntime = url => import(url) }) {
  let loaded;
  async function inspect() {
    requireTrustedFixture();
    const expected = fixture.installedProduct;
    if (fixture.nativeInstalledEntry !== true || expected?.schema_version !== 1 || expected.extension?.id !== productId) fail('INSTALLED_ENTRY_DESCRIPTOR_REQUIRED');
    const roots = validateRoots(fixture.repository, expected.runtime.root, expected.extension.root);
    const entry = vscode.extensions.getExtension(productId);
    if (!entry) fail('INSTALLED_EXTENSION_UNAVAILABLE');
    const actualRoot = entry.extensionUri?.fsPath ?? entry.extensionPath;
    if (typeof actualRoot !== 'string' || !same(realpathSync.native(actualRoot), roots.extension) || entry.packageJSON?.version !== expected.extension.version)
      fail('INSTALLED_EXTENSION_MISMATCH');
    const setting = vscode.workspace.getConfiguration('workforce.bridge').inspect('runtimePath');
    if (typeof setting?.globalValue !== 'string' || !isAbsolute(setting.globalValue) || !same(realpathSync.native(setting.globalValue), roots.runtime))
      fail('INSTALLED_USER_RUNTIME_MISMATCH');
    for (const [root, pins] of [[roots.runtime, expected.runtime.files], [roots.extension, expected.extension.files]]) {
      if (!Array.isArray(pins) || !pins.length || pins.length > 2000) fail('INSTALLED_PIN_LIMIT');
      for (const pin of pins) if (!/^[a-f0-9]{64}$/.test(pin?.sha256 ?? '') || regular(root, pin.path).sha256 !== pin.sha256) fail('INSTALLED_PACKAGE_BYTES_CHANGED');
    }
    if (!entry.isActive) await entry.activate();
    if (entry.isActive !== true) fail('INSTALLED_EXTENSION_NOT_ACTIVE');
    const inventory = Array.isArray(vscode.lm?.tools) ? vscode.lm.tools : [];
    if (nativeTools.some(name => inventory.filter(tool => tool.name === name).length !== 1)) fail('INSTALLED_NATIVE_TOOL_INVENTORY_MISMATCH');
    loaded ??= await importRuntime(pathToFileURL(join(roots.runtime, 'dist/index.js')).href);
    if (typeof loaded.createRuntimeInfo !== 'function' || typeof loaded.requestListForMonitor !== 'function') fail('INSTALLED_RUNTIME_READ_API_MISSING');
    const info = loaded.createRuntimeInfo(fixture.workspace);
    if (info.package_version !== expected.runtime.version || typeof info.runtime_root !== 'string' || !same(realpathSync.native(info.runtime_root), roots.runtime))
      fail('INSTALLED_RUNTIME_VERSION_MISMATCH');
    return { entry: 'installed-vsix', active: true, runtime: { root: roots.runtime, version: info.package_version, build_fingerprint: info.build_fingerprint },
      extension: { id: productId, root: roots.extension, version: entry.packageJSON.version },
      pins_sha256: sha(JSON.stringify(expected)), product_tools: nativeTools.map(name => ({ name, count: 1, ownership: 'not-observed-by-public-inventory' })),
      workspace_runtime_override_present: setting.workspaceValue !== undefined || setting.workspaceFolderValue !== undefined,
      backend_registration: false, model_calls: 0, source_fallback: false };
  }
  async function snapshot(label = 'explicit-installed-snapshot', directory = fixture.evidence) {
    const installed = await inspect(), root = realpathSync.native(fixture.workspace), value = loaded.requestListForMonitor(root);
    if (!Array.isArray(value?.requests) || value.requests.length > 100) fail('INSTALLED_SNAPSHOT_LIMIT');
    const selected = [...new Set(value.requests.flatMap(row => [...(row.artifacts ?? []), ...(row.evidence ?? [])]
      .map(item => item.path ?? item.log_path).filter(path => typeof path === 'string')))];
    const files = selected.slice(0, 100).map(path => {
      try { const pin = regular(root, path); return { path, bytes: pin.bytes, sha256: pin.sha256 }; }
      catch { return { path, observed: false }; }
    });
    const result = { schema_version: 1, observed_at: new Date().toISOString(), label: typeof label === 'string' ? label.slice(0, 100) : 'installed-snapshot',
      installed, source: 'public-installed-runtime-read-only-projection', snapshot: value, files, files_truncated: selected.length > files.length,
      model_calls: 0, dispatch_performed: false };
    const name = `native-installed-snapshot-${randomUUID()}.json`; write(name, result, 'wx', directory); return { observed: true, file: name };
  }
  return { inspect, snapshot };
}
module.exports = { captureInstalledDescriptor, createInstalledEntryObserver, nativeTools };
