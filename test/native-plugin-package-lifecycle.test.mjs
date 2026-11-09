// Real package bytes, policy, durable leases and domain operations. The public
// VS Code configuration API is simulated here; desktop loading is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const base = process.env.WF_NATIVE_PACKAGE_MODULE_BASE ?? new URL('../dist/', import.meta.url).href;
const api = { ...await import(new URL('index.js', base)), ...await import(new URL('native-plugin-packages.js', base)), ...await import(new URL('native-capability-leases.js', base)) };
const require = createRequire(import.meta.url);
const { createNativePluginPackageHost } = require('../extensions/vscode-model-bridge/native-plugin-packages.cjs');
const { createNativeCapabilitySession } = require('../extensions/vscode-model-bridge/native-capability-session.cjs');
const { createLocalRequestRunner } = require('../extensions/vscode-model-bridge/local-request.cjs');
const fixtureRoot = fileURLToPath(new URL('./fixtures/native-agent-plugin/', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
const files = fs.readdirSync(fixtureRoot, { recursive: true }).filter(path => fs.statSync(join(fixtureRoot, path)).isFile()).map(path => {
  const content = fs.readFileSync(join(fixtureRoot, path)); return { path: path.replaceAll('\\', '/'), content, bytes: content.length, sha256: sha(content) };
}).sort((a, b) => a.path.localeCompare(b.path));
const treeHash = sha(stable(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));
const owner = { request_ref: 'WF-R-PACKAGE', assignment_ref: 'package-actual-assignment', generation: 0 };
const outcome = { outcome_sha256: sha('actual ended professional result') };
function fixture(t, options = {}) {
  const parent = fs.realpathSync.native(tmpdir()), root = fs.mkdtempSync(join(parent, 'wf-native-package-'));
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); fs.rmSync(root, { recursive: true, force: true }); });
  api.initialize(root, { project_id: 'WF-NATIVE-PACKAGE' });
  let own = { './authored-package': true, '/user/authored-package': true }, writes = 0, update;
  const folder = { uri: { scheme: 'file', fsPath: root, toString: () => `file:///${root.replaceAll('\\', '/')}` } };
  const config = { inspect: () => ({ workspaceFolderValue: { './ignored-folder': true }, globalValue: structuredClone(own) }),
    get: key => key === 'plugins.enabled' ? options.pluginsEnabled !== false : structuredClone(own),
    async update(key, next, target) { assert.equal(key, 'pluginLocations'); assert.equal(target, 1); writes++;
      if (update) return update(next, () => { own = structuredClone(next); }); own = structuredClone(next); },
  };
  const vscode = { Uri: { file: () => folder.uri }, ConfigurationTarget: { Global: 1, WorkspaceFolder: 3, Workspace: 2 },
    workspace: { isTrusted: true, workspaceFile: { scheme: 'file' }, workspaceFolders: [folder], getWorkspaceFolder: () => folder,
      getConfiguration: (section, resource) => { assert.equal(section, 'chat'); assert.equal(resource, undefined, 'Native machine-scoped discovery reads without resource.'); return config; } } };
  const host = createNativePluginPackageHost(vscode, api, root);
  const receipt = api.prepareNativePluginPackageFixture(root, fixtureRoot, treeHash, { allow_fixture: true });
  return { root, host, receipt, vscode, get own() { return own; }, get writes() { return writes; },
    setOwn: value => { own = value; }, setGlobal: value => { own = value; }, setUpdate: value => { update = value; } };
}
test('production full-package preparation verifies every approved source file pin before native registration', async t => {
  const f = fixture(t), policy = { name: 'approved-git-source', package: 'wf-native-package-fixture', repository: 'https://github.com/example/native-package', commit: 'a'.repeat(40),
    package_path: 'plugins/fixture', license_path: 'LICENSE', files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  let reads = 0;
  const reader = async input => { reads++; return { ...input, kind: 'file', complete: true, content: files.find(file => `${policy.package_path}/${file.path}` === input.path).content }; };
  const selection = { source: policy.name, package: 'wf-native-package-fixture' };
  await assert.rejects(api.prepareNativePluginPackage(f.root, selection, { sources: [], reader, authorize: () => true }), /SOURCE_NOT_APPROVED/);
  assert.equal(reads, 0);
  const receipt = await api.prepareNativePluginPackage(f.root, selection, { sources: [policy], reader, authorize: () => true });
  assert.equal(receipt.source.kind, 'git'); assert.equal(receipt.source.commit, policy.commit); assert.equal(receipt.state, 'staged');
  assert.equal(reads, files.length); assert.equal(f.writes, 0); assert.deepEqual(receipt.components.mcp_servers, ['wf-native-package-fixture']);
  const cached = await api.prepareNativePluginPackage(f.root, selection, { sources: [policy], reader: () => assert.fail('An unchanged qualified package is reused without fetching.'), authorize: () => true });
  assert.equal(cached.id, receipt.id);
  await assert.rejects(api.prepareNativePluginPackage(f.root, selection, { sources: [{ ...policy, commit: 'b'.repeat(40) }], reader: async input => ({ ...await reader(input), commit: 'c'.repeat(40) }), authorize: () => true }), /SOURCE_PIN_MISMATCH/);
  await assert.rejects(api.prepareNativePluginPackage(f.root, selection, { sources: [{ ...policy, commit: 'c'.repeat(40) }], reader: () => new Promise(() => {}), authorize: () => true, timeout_ms: 20 }), /TIMEOUT/);
});
test('native machine scope uses one absolute User key and ignores workspace and folder overrides', async t => {
  const f = fixture(t); delete f.vscode.workspace.workspaceFile;
  let own = { './authored-single-folder': true };
  f.vscode.workspace.getConfiguration = (section, resource) => ({ inspect: () => { assert.equal(section, 'chat'); assert.equal(resource, undefined);
    return { workspaceValue: { './ignored-workspace': true }, workspaceFolderValue: { './ignored-folder': true }, globalValue: own }; },
    get: key => key === 'plugins.enabled' ? true : own,
    async update(key, value, target) { assert.equal(key, 'pluginLocations'); assert.equal(target, 1); own = value; } });
  const host = createNativePluginPackageHost(f.vscode, api, f.root);
  await host.control(f.receipt.id, 'enable'); assert.equal(own[f.receipt.registration_key], true); assert.equal(own['./authored-single-folder'], true);
  await host.control(f.receipt.id, 'remove'); assert.equal(Object.hasOwn(own, f.receipt.registration_key), false); assert.equal(own['./authored-single-folder'], true);
});

test('actual-style noncloneable configuration proxies support Manage status and owned registration through validated plain boolean maps', async t => {
  const f = fixture(t); let writes = 0;
  const proxy = map => new Proxy(map, {});
  assert.throws(() => structuredClone(proxy(f.own)), { name: 'DataCloneError' });
  f.vscode.workspace.getConfiguration = (section, resource) => {
    assert.equal(section, 'chat'); assert.equal(resource, undefined);
    return { inspect: () => ({ globalValue: proxy(f.own) }), get: key => key === 'plugins.enabled' ? true : proxy(f.own),
      async update(key, next, target) { assert.equal(key, 'pluginLocations'); assert.equal(target, 1);
        assert.doesNotThrow(() => structuredClone(next)); f.setOwn(next); writes++; } };
  };
  let picks = 0;
  f.vscode.window = { async showQuickPick(rows) { picks++; return typeof rows[0] === 'string' ? 'Enable' : rows[0]; }, showInformationMessage() {} };
  await f.host.manage(); assert.equal(picks, 2); assert.equal(writes, 1);
  assert.equal(f.host.status()[0].observed_user_registration, true);
  assert.equal(f.own[f.receipt.registration_key], true); assert.equal(f.own['./authored-package'], true);
});

test('configuration proxy values must still be booleans and malformed settings are rejected without copying their content', async t => {
  const f = fixture(t);
  f.vscode.workspace.getConfiguration = () => ({ inspect: () => ({ globalValue: f.own }),
    get: key => key === 'plugins.enabled' ? true : new Proxy({ '/invalid': { secret: 'PRIVATE_PROXY_VALUE' } }, {}) });
  await assert.rejects(f.host.control(f.receipt.id, 'enable'), error => {
    assert.equal(error.code, 'NATIVE_PACKAGE_CONFIGURATION_INVALID'); assert.doesNotMatch(error.message, /PRIVATE_PROXY_VALUE/); return true;
  });
  assert.equal(f.writes, 0); assert.deepEqual(api.readNativeCapabilityPendingControls(f.root, 'plugin:'), []);
});
test('native registration owns only its absolute machine User key, preserves external entries and never claims native loading from configuration', async t => {
  const f = fixture(t), result = await f.host.control(f.receipt.id, 'enable');
  assert.equal(result.state, 'configuration-observed'); assert.equal(result.loaded, 'not-observed'); assert.equal(result.registration, 'owned-user-plugin-location');
  assert.equal(f.receipt.registration_key, fs.realpathSync.native(join(f.root, f.receipt.location)).replaceAll('\\', '/'));
  assert.equal(f.own['./authored-package'], true); assert.equal(f.own[f.receipt.registration_key], true); assert.equal(f.writes, 1);
  assert.equal(f.host.resolve([f.receipt.name]).resources[0].key, `plugin:${f.receipt.id}`);
  assert.equal(f.receipt.source.kind, 'local-fixture'); assert.equal('commit' in f.receipt.source, false);
  const professional = JSON.stringify(f.host.capabilityStatus());
  assert.doesNotMatch(professional, /native-plugin-[a-f0-9]{64}|root_sha256|approval_sha256|registration_key|owner_sha256|assignment_ref/);
  assert.match(professional, /wf-native-package-fixture/);
  assert.equal(f.host.status()[0].external_native_controls_freezable, false);
});
test('active full-package disable/enable/unregister waits for exact holder settlement and keeps source/cache immutable', async t => {
  const f = fixture(t); await f.host.control(f.receipt.id, 'enable');
  const resource = f.host.resolve([f.receipt.name]).resources[0], ref = api.acquireNativeCapabilityLease(f.root, { owner, resources: [resource] });
  assert.equal((await f.host.control(f.receipt.id, 'disable')).state, 'deferred'); assert.equal(f.writes, 1);
  assert.equal(f.own[f.receipt.registration_key], true); assert.deepEqual(f.host.resolve([f.receipt.name]).unavailable, [f.receipt.name]);
  assert.equal((await f.host.control(f.receipt.id, 'enable')).state, 'configuration-observed'); assert.equal(f.writes, 1);
  assert.equal((await f.host.control(f.receipt.id, 'remove')).state, 'deferred'); assert.equal(f.writes, 1);
  api.releaseNativeCapabilityLease(f.root, ref, owner, outcome);
  const drained = await f.host.drain(); assert.equal(drained[0].result.state, 'configuration-observed');
  assert.equal(Object.hasOwn(f.own, f.receipt.registration_key), false); assert.equal(f.own['./authored-package'], true); assert.equal(f.writes, 2);
  api.assertNativePluginPackageCurrent(f.root, f.receipt.id);
  const current = api.readNativePluginPackages(f.root).find(row => row.id === f.receipt.id);
  assert.equal(current.state, 'removed'); assert.equal(current.cache_retained, true);
  assert.equal(api.readNativeCapabilityControl(f.root, resource.key).active_count, 0);
});
test('awaited native config mutation closes admission durably without holding a synchronous backend lock', async t => {
  const f = fixture(t); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  f.setUpdate(async (_next, apply) => { started(); await new Promise(resolve => { release = resolve; }); apply(); });
  const pending = f.host.control(f.receipt.id, 'enable'); await waiting;
  const records = api.readNativeCapabilityPendingControls(f.root, 'plugin:'); assert.equal(records.length, 1); assert.ok(records[0].ticket);
  assert.throws(() => api.acquireNativeCapabilityLease(f.root, { owner, resources: [{ key: `plugin:${f.receipt.id}`, fingerprint: f.receipt.approval_sha256 }] }), /DRAINING/);
  const other = api.acquireNativeCapabilityLease(f.root, { owner, resources: [{ key: 'mcp:independent', fingerprint: sha('independent') }] });
  api.releaseNativeCapabilityLease(f.root, other, owner, outcome);
  assert.deepEqual(api.drainNativeCapabilityControls(f.root, () => assert.fail('Sync drain cannot acknowledge an async native host operation.')), []);
  release(); assert.equal((await pending).state, 'configuration-observed');
  const ticket = records[0].ticket, completed = fs.readdirSync(api.safePath(f.root, '.neomind/native/capability-leases/async-completed'));
  assert.equal(completed.length, 1);
  assert.throws(() => api.completeNativeCapabilityAsyncControl(f.root, ticket, { observed_sha256: sha('different') }), /CONFLICT/);
});

test('owned User map updates from two workspace hosts merge serially without losing either absolute key', async t => {
  const a = fixture(t), b = fixture(t); let map = { '/user/authored-package': true }, writes = 0, release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const config = { inspect: () => ({ globalValue: structuredClone(map) }), get: key => key === 'plugins.enabled' ? true : structuredClone(map),
    async update(key, next, target) { assert.equal(key, 'pluginLocations'); assert.equal(target, 1);
      if (++writes === 1) { started(); await new Promise(resolve => { release = resolve; }); } map = structuredClone(next); } };
  a.vscode.workspace.getConfiguration = b.vscode.workspace.getConfiguration = () => config;
  const first = a.host.control(a.receipt.id, 'enable'); await waiting;
  const second = b.host.control(b.receipt.id, 'enable'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1); release(); await Promise.all([first, second]);
  assert.equal(writes, 2); assert.equal(map[a.receipt.registration_key], true); assert.equal(map[b.receipt.registration_key], true);
  assert.equal(map['/user/authored-package'], true); assert.notEqual(a.receipt.registration_key, b.receipt.registration_key);
});

test('an observed concurrent User map edit is retained and leaves the owned mutation uncertain rather than replaying it', async t => {
  const f = fixture(t);
  f.setUpdate((_next, apply) => { apply(); f.setOwn({ ...f.own, '/user/added-during-write': false }); });
  await assert.rejects(f.host.control(f.receipt.id, 'enable'), /CONFIGURATION_CHANGED/);
  assert.equal(f.own['/user/added-during-write'], false); assert.equal(f.writes, 1);
  assert.equal(api.readNativeCapabilityControl(f.root, `plugin:${f.receipt.id}`).new_admissions, false);
});

test('historical relative registration receipts remain byte-identical until explicit User registration appends its actual scope', async t => {
  const f = fixture(t), path = api.safePath(f.root, `.neomind/native/plugin-packages/receipts/${f.receipt.id}.json`);
  const { integrity: _integrity, ...legacy } = JSON.parse(fs.readFileSync(path, 'utf8'));
  legacy.registration_key = `./${legacy.location}`; legacy.registration = 'owned-workspace-plugin-location';
  fs.writeFileSync(path, JSON.stringify({ ...legacy, integrity: sha(stable(legacy)) }, null, 2) + '\n'); const before = fs.readFileSync(path);
  assert.equal(api.readNativePluginPackages(f.root)[0].registration_key, legacy.registration_key);
  assert.deepEqual(fs.readFileSync(path), before);
  await f.host.control(f.receipt.id, 'enable'); const current = api.readNativePluginPackages(f.root)[0];
  assert.equal(current.registration_key, legacy.registration_key, 'The historical receipt key is not silently rewritten.');
  assert.equal(current.history.at(-1).registration, 'owned-user-plugin-location');
  assert.equal(current.history.at(-1).registration_key, f.receipt.registration_key);
  assert.equal(f.own[f.receipt.registration_key], true); assert.equal(Object.hasOwn(f.own, legacy.registration_key), false);
});
test('an outstanding asynchronous ticket cannot be replaced, replayed or acknowledged from another workspace', async t => {
  const f = fixture(t), other = fixture(t); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  f.setUpdate(async (_next, apply) => { started(); await new Promise(resolve => { release = resolve; }); apply(); });
  const action = f.host.control(f.receipt.id, 'enable'); await waiting;
  const first = api.readNativeCapabilityPendingControls(f.root, 'plugin:')[0];
  const duplicate = api.beginNativeCapabilityAsyncControl(f.root, first.input);
  assert.equal(duplicate.ticket, undefined); assert.equal(duplicate.control.state, 'deferred');
  api.requestNativeCapabilityControl(f.root, { ...first.input, action: 'remove' });
  assert.deepEqual(api.readNativeCapabilityPendingControls(f.root, 'plugin:')[0].ticket, first.ticket, 'An in-flight native mutation remains bound to its original operation.');
  assert.throws(() => api.completeNativeCapabilityAsyncControl(other.root, first.ticket, { observed_sha256: sha('unknown') }), /ROOT/);
  release(); await action; assert.equal(f.writes, 1);
});
test('lost native response reconciles observed configuration without repeating its side effect, while absent effects stay uncertain', async t => {
  for (const applyFirst of [true, false]) await t.test(applyFirst ? 'effect retained' : 'effect absent', async t => {
    const f = fixture(t); f.setUpdate((_next, apply) => { if (applyFirst) apply(); throw new Error('PRIVATE native response lost'); });
    await assert.rejects(f.host.control(f.receipt.id, 'enable'));
    const another = createNativePluginPackageHost(f.vscode, api, f.root), before = f.writes, result = await another.drain();
    assert.equal(f.writes, before, 'Reconciliation must not replay a possibly completed native update.');
    if (applyFirst) assert.equal(result[0].result.state, 'configuration-observed');
    else { assert.equal(result[0].state, 'pending-reconciliation'); assert.equal(api.readNativeCapabilityControl(f.root, `plugin:${f.receipt.id}`).new_admissions, false); }
  });
});
test('authored registration, global ownership and disabled native support are preserved instead of silently overridden', async t => {
  const authored = fixture(t); authored.setOwn({ [authored.receipt.registration_key]: true });
  await assert.rejects(authored.host.control(authored.receipt.id, 'enable'), /NOT_OWNED/); assert.equal(authored.writes, 0);
  const global = fixture(t); global.setGlobal({ [global.receipt.registration_key]: true });
  await assert.rejects(global.host.control(global.receipt.id, 'enable'), /NOT_OWNED/); assert.equal(global.writes, 0);
  const alias = fixture(t); alias.setGlobal({ [`./${alias.receipt.location}`]: true });
  await assert.rejects(alias.host.control(alias.receipt.id, 'enable'), /EXTERNAL_REGISTRATION/); assert.equal(alias.writes, 0);
  const disabled = fixture(t, { pluginsEnabled: false });
  await assert.rejects(disabled.host.control(disabled.receipt.id, 'enable'), /PLUGINS_DISABLED/); assert.equal(disabled.writes, 0);
});
test('changed full-package bytes cannot be admitted but can still be safely unregistered without deleting user edits', async t => {
  const f = fixture(t); await f.host.control(f.receipt.id, 'enable');
  const selected = join(f.root, f.receipt.location, 'skills/package-evidence/SKILL.md'); fs.appendFileSync(selected, '\nUser edit to retain.\n');
  assert.deepEqual(f.host.resolve([f.receipt.name]).unavailable, [f.receipt.name]);
  await f.host.control(f.receipt.id, 'remove');
  assert.equal(Object.hasOwn(f.own, f.receipt.registration_key), false); assert.match(fs.readFileSync(selected, 'utf8'), /User edit to retain/);
});
test('a package unavailable at admission stays frozen as ordinary work even if installed before the unstarted call', async t => {
  const f = fixture(t), session = createNativeCapabilitySession(f.vscode, api, f.root, { pluginPackages: f.host });
  const opened = api.openNativeRoleJob(f.root, { role: 'WF.P-RES', requirement: 'Inspect bounded facts.', plugins: [f.receipt.name] });
  const job = { agentName: opened.role, assignment_ref: opened.assignment_ref }, first = session.prepare(opened, job, true);
  assert.deepEqual(first.state.dispatch_capabilities.roles[opened.role].packages, []); assert.match(first.promptSuffix, /unavailable/);
  await f.host.control(f.receipt.id, 'enable');
  const again = session.prepare(first.state, job, true);
  assert.deepEqual(again.state.dispatch_capabilities.roles[opened.role].packages, []);
  assert.match(again.promptSuffix, /unavailable/); assert.doesNotMatch(again.promptSuffix, /skills\/package-evidence\/SKILL\.md/);
  assert.equal(api.readNativeCapabilityControl(f.root, `plugin:${f.receipt.id}`).active_count, 0, 'No new package authority is smuggled into an existing ordinary call.');
});
test('exact possible owned MCP namespaces add protective pins without granting tools, while unrelated MCP survives disabled plugin support', async t => {
  const f = fixture(t); await f.host.control(f.receipt.id, 'enable');
  const snapshot = { connector_id: 'approved-other-id', tools: [{ reference: 'wf-native-package-fixture/echo_package_nonce' }] };
  const guarded = f.host.guardMcp([snapshot]); assert.equal(guarded.resources.length, 1); assert.deepEqual(guarded.denied, []);
  const ref = api.acquireNativeCapabilityLease(f.root, { owner, resources: guarded.resources });
  await f.host.control(f.receipt.id, 'remove');
  assert.deepEqual(f.host.guardMcp([snapshot]).denied, ['approved-other-id']);
  assert.deepEqual(f.host.guardMcp([snapshot], [f.receipt.id], true).denied, [], 'Existing holders retain the same native registration.');
  api.releaseNativeCapabilityLease(f.root, ref, owner, outcome); await f.host.drain();
  const disabled = fixture(t, { pluginsEnabled: false });
  assert.deepEqual(disabled.host.guardMcp([{ connector_id: 'independent', tools: [{ reference: 'independent/lookup' }] }]).denied, []);
});
test('MCP-only role selection protects its possible owning package even when the professional package-name field is omitted', async t => {
  const f = fixture(t); await f.host.control(f.receipt.id, 'enable');
  const opaque = Object.freeze({ native: Symbol('MCP host context') }), calls = [];
  f.vscode.CancellationTokenSource = class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} };
  f.vscode.lm = { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
    properties: Object.fromEntries(['prompt', 'description', 'agentName', 'model'].map(key => [key, { type: 'string' }])) } },
    { name: 'mcp_package_echo', fullReferenceName: 'wf-native-package-fixture/echo_package_nonce', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } } } }],
    async invokeTool(_name, invocation) {
      assert.equal(invocation.toolInvocationToken, opaque); calls.push(invocation.input);
      assert.doesNotMatch(invocation.input.prompt, /skills\/package-evidence\/SKILL\.md/, 'Protective dependency association does not auto-load guidance or grant permissions.');
      assert.equal(api.readNativeCapabilityControl(f.root, `plugin:${f.receipt.id}`).active_count, 1);
      assert.equal((await f.host.control(f.receipt.id, 'remove')).state, 'deferred');
      return { content: [{ value: JSON.stringify({ summary: 'Completed bounded MCP inspection.', verdict: 'pass', findings: [] }) }] };
    } };
  const connector = { id: 'package-connector', label: 'Explicitly approved package MCP fixture', roles: ['WF.P-RES'],
    tools: [{ name: 'mcp_package_echo', reference: 'wf-native-package-fixture/echo_package_nonce' }] };
  const session = createNativeCapabilitySession(f.vscode, api, f.root, { pluginPackages: f.host, readApprovedConnectors: () => [connector] });
  const runner = createLocalRequestRunner(f.vscode, api, f.root, { capabilities: session }); t.after(() => runner.dispose());
  const result = await runner.role({ role: 'WF.P-RES', requirement: 'Inspect only the approved MCP capability.', mcp: [connector.id] }, opaque);
  assert.equal(result.status, 'role-completed', JSON.stringify(result)); assert.equal(calls.length, 1); assert.match(calls[0].agentName, /^WF\.P-RES Worker MCP /);
  assert.equal(Object.hasOwn(f.own, f.receipt.registration_key), false);
});
test('role package content selection is names only and the real role result is saved before deferred native unregister', async t => {
  const f = fixture(t); await f.host.control(f.receipt.id, 'enable');
  const opaque = Object.freeze({ native: Symbol('actual context') }), calls = [], listeners = new Set();
  f.vscode.CancellationTokenSource = class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested(listener) { listeners.add(listener); return { dispose() {} }; } }; } cancel() { this.token.isCancellationRequested = true; for (const listener of listeners) listener(); } dispose() {} };
  f.vscode.lm = { tools: [{ name: 'runSubagent', inputSchema: { type: 'object', required: ['prompt', 'description'],
    properties: Object.fromEntries(['prompt', 'description', 'agentName', 'model'].map(key => [key, { type: 'string' }])) } }],
    async invokeTool(_name, invocation) {
      assert.equal(invocation.toolInvocationToken, opaque); calls.push(invocation.input);
      assert.match(invocation.input.prompt, /skills\/package-evidence\/SKILL\.md/); assert.doesNotMatch(invocation.input.prompt, /owner_sha256|operation_id|native-lease-/);
      assert.match(fs.readFileSync(join(f.root, f.receipt.location, 'skills/package-evidence/SKILL.md'), 'utf8'), /WF_NATIVE_PACKAGE_GUIDANCE_V1/);
      assert.equal((await f.host.control(f.receipt.id, 'remove')).state, 'deferred');
      return { content: [{ value: JSON.stringify({ summary: 'Read exact package evidence guidance.', verdict: 'pass', findings: [],
        report_artifacts: [{ path: 'reports/package.md', content: '# Native package\nWF_NATIVE_PACKAGE_GUIDANCE_V1\n' }] }) }] };
    } };
  const session = createNativeCapabilitySession(f.vscode, api, f.root, { pluginPackages: f.host });
  const runner = createLocalRequestRunner(f.vscode, api, f.root, { capabilities: session }); t.after(() => runner.dispose());
  assert.equal(api.nativeRoleJobSchema.safeParse({ role: 'WF.P-RES', requirement: 'Inspect', plugins: [{ id: f.receipt.id }] }).success, false);
  const result = await runner.role({ role: 'WF.P-RES', requirement: 'Inspect package guidance and publish the bounded evidence report.', plugins: [f.receipt.name], outputs: ['reports/package.md'] }, opaque);
  assert.equal(result.status, 'role-completed', JSON.stringify(result)); assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(join(f.root, 'reports/package.md'), 'utf8'), /WF_NATIVE_PACKAGE_GUIDANCE_V1/);
  assert.equal(Object.hasOwn(f.own, f.receipt.registration_key), false);
  assert.equal(api.readNativeCapabilityControl(f.root, `plugin:${f.receipt.id}`).active_count, 0);
});
