'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const same = (a, b) => canonical(a) === canonical(b);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function failure(code) { const error = new Error(code); error.code = code; throw error; }
// A User setting is shared across open roots in this extension host. Serialize
// our own map updates; a backend synchronous lock is never held across await.
let userWrites = Promise.resolve();
function serializeUserWrite(operation) {
  const next = userWrites.catch(() => {}).then(operation); userWrites = next; return next;
}

/** Native Local full-package registration via public User configuration.
 * This is an owned absolute User registration, never a private cache install.
 * External native UI actions cannot be frozen by an extension. */
function createNativePluginPackageHost(vscode, api, workspaceRoot, options = {}) {
  const root = fs.realpathSync.native(workspaceRoot), uri = vscode.Uri.file(root), operations = new Map();
  const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  function configuration() {
    if (vscode.workspace.isTrusted !== true) failure('NATIVE_PACKAGE_WORKSPACE_UNTRUSTED');
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== 'file' || canonical(fs.realpathSync.native(folder.uri.fsPath)) !== canonical(root)) failure('NATIVE_PACKAGE_WORKSPACE_CHANGED');
    const config = vscode.workspace.getConfiguration('chat'), inspected = config.inspect('pluginLocations');
    if (!inspected) failure('NATIVE_PACKAGE_HOST_UNSUPPORTED');
    if (config.get('plugins.enabled') === false) failure('NATIVE_PACKAGE_PLUGINS_DISABLED');
    // Installed VS Code declares MACHINE scope and discovery reads getValue
    // without a resource. Workspace/folder values cannot install a plugin.
    const own = inspected.globalValue ?? {}, effective = config.get('pluginLocations') ?? {};
    if (!object(own) || !object(effective) || Object.values(own).some(value => typeof value !== 'boolean')) failure('NATIVE_PACKAGE_CONFIGURATION_INVALID');
    return { config, own: structuredClone(own), effective: structuredClone(effective),
      target: vscode.ConfigurationTarget.Global, scope: 'machine-user' };
  }
  const nativeKey = receipt => path.resolve(root, receipt.location).replaceAll('\\', '/');
  const owned = receipt => receipt.history.some(item => item.registration === 'owned-user-plugin-location' &&
    item.registration_key === nativeKey(receipt) && typeof item.configuration_sha256 === 'string');
  function row(id, requireCurrent = true) {
    const selected = api.readNativePluginPackageMetadata(root).find(value => value.id === id);
    if (!selected) failure('NATIVE_PACKAGE_CHANGED');
    if (requireCurrent) api.assertNativePluginPackageCurrent(root, id);
    return selected;
  }
  function externalRegistration(receipt, current) {
    const keyFor = nativeKey(receipt);
    if (!Object.hasOwn(current.own, keyFor) && Object.hasOwn(current.effective, keyFor)) return true;
    const selected = canonical(fs.realpathSync.native(path.join(root, receipt.location)));
    return Object.entries(current.effective).some(([key, enabled]) => {
      if (key === keyFor || enabled !== true) return false;
      try {
        const candidate = key === '~' ? os.homedir() : key.startsWith('~/') || key.startsWith('~\\') ? path.join(os.homedir(), key.slice(2)) : path.resolve(root, key);
        return fs.existsSync(candidate) && canonical(fs.realpathSync.native(candidate)) === selected;
      } catch { return false; }
    });
  }
  const desired = action => action === 'enable' ? true : action === 'disable' ? false : undefined;
  const state = action => action === 'enable' ? 'registered' : action === 'disable' ? 'disabled' : 'removed';
  const input = (receipt, action) => ({ key: `plugin:${receipt.id}`, action, target_sha256: hash({ root, key: nativeKey(receipt), scope: configuration().scope, setting: 'chat.pluginLocations' }) });
  const proof = (receipt, action) => hash({ root, key: nativeKey(receipt), value: desired(action) ?? 'absent', scope: configuration().scope });
  function matches(receipt, action, current) {
    return current.own[nativeKey(receipt)] === desired(action) && current.effective[nativeKey(receipt)] === desired(action);
  }
  function finish(receipt, action, ticket) {
    const observed = configuration();
    const pending = api.readNativeCapabilityPendingControls(root, 'plugin:').find(item => item.ticket?.operation_id === ticket.operation_id);
    if (!pending || !same(pending.input, input(receipt, action))) failure('NATIVE_PACKAGE_CONTROL_CHANGED');
    if (!matches(receipt, action, observed)) failure('NATIVE_PACKAGE_CONFIGURATION_UNCERTAIN');
    if (action === 'enable') api.assertNativePluginPackageCurrent(root, receipt.id);
    const observed_sha256 = proof(receipt, action);
    api.recordNativePluginPackageRegistration(root, receipt.id, state(action), { configuration_sha256: observed_sha256,
      registration_key: nativeKey(receipt), registration: 'owned-user-plugin-location' });
    api.completeNativeCapabilityAsyncControl(root, ticket, { observed_sha256 });
    return { state: 'configuration-observed', package: receipt.name, registration: 'owned-user-plugin-location', cache_retained: true,
      control: api.readNativeCapabilityControl(root, `plugin:${receipt.id}`), loaded: 'not-observed', used: 'not-observed', verified: 'not-observed' };
  }
  async function change(id, action) {
    if (!['enable', 'disable', 'remove'].includes(action)) failure('NATIVE_PACKAGE_ACTION_INVALID');
    const receipt = row(id, action === 'enable'), before = configuration(), key = nativeKey(receipt);
    // Never adopt an authored entry merely because its bytes happen to agree.
    if (!owned(receipt) && Object.hasOwn(before.own, key)) failure('NATIVE_PACKAGE_CONFIGURATION_NOT_OWNED');
    if (externalRegistration(receipt, before)) failure('NATIVE_PACKAGE_EXTERNAL_REGISTRATION');
    if (action === 'enable' && before.own[key] === true && receipt.state === 'registered') {
      const control = api.requestNativeCapabilityControl(root, input(receipt, 'enable'));
      return { state: control.state === 'deferred' ? 'pending-reconciliation' : 'configuration-observed', package: receipt.name, control,
        registration: 'owned-user-plugin-location', cache_retained: true };
    }
    if (action === 'enable' && api.readNativePluginPackageMetadata(root).some(other => other.id !== id && other.name === receipt.name && other.state === 'registered'))
      failure('NATIVE_PACKAGE_NAME_CONFLICT');
    const reserved = api.beginNativeCapabilityAsyncControl(root, input(receipt, action));
    if (!reserved.ticket) return { state: 'deferred', package: receipt.name, control: reserved.control, registration: 'owned-user-plugin-location', cache_retained: true };
    const fresh = configuration();
    if (!same(fresh.own, before.own)) failure('NATIVE_PACKAGE_CONFIGURATION_CHANGED');
    const next = { ...fresh.own };
    if (action === 'remove') delete next[key]; else next[key] = desired(action);
    // Only this project's absolute User-registration key is changed. Native host
    // validation/security prompts remain native; no private cache is edited.
    let timer;
    try {
      await Promise.race([fresh.config.update('pluginLocations', next, fresh.target), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('NATIVE_PACKAGE_NATIVE_UPDATE_UNCERTAIN'), { code: 'NATIVE_PACKAGE_NATIVE_UPDATE_UNCERTAIN' })), options.hostUpdateTimeoutMs ?? 15000);
      })]);
    } catch (cause) { throw Object.assign(new Error('NATIVE_PACKAGE_NATIVE_UPDATE_UNCERTAIN', { cause }), { code: 'NATIVE_PACKAGE_NATIVE_UPDATE_UNCERTAIN' }); }
    finally { clearTimeout(timer); }
    const after = configuration(), others = value => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
    if (!same(others(before.own), others(after.own))) failure('NATIVE_PACKAGE_CONFIGURATION_CHANGED');
    return finish(receipt, action, reserved.ticket);
  }
  function control(id, action) {
    const previous = operations.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => serializeUserWrite(() => change(id, action)));
    operations.set(id, operation);
    operation.finally(() => { if (operations.get(id) === operation) operations.delete(id); }).catch(() => {});
    return operation;
  }
  async function drain() {
    const results = [];
    for (const pending of api.readNativeCapabilityPendingControls(root, 'plugin:')) {
      if (pending.active_count) continue;
      const id = pending.input.key.slice(7);
      try {
        const receipt = row(id, pending.input.action === 'enable');
        if (!same(pending.input, input(receipt, pending.input.action))) failure('NATIVE_PACKAGE_CONTROL_CHANGED');
        if (pending.ticket) {
          // Lost responses are reconciled from actual configuration. A missing
          // effect is not replayed merely because a timer or process ended.
          results.push({ id, result: finish(receipt, pending.input.action, pending.ticket) });
        } else results.push({ id, result: await control(id, pending.input.action) });
      } catch { results.push({ id, state: 'pending-reconciliation' }); }
    }
    return results;
  }
  function resolvePackages(names) {
    const result = api.resolveNativePluginPackageResources(root, names), current = configuration();
    const packages = result.packages.filter(receipt => current.own[nativeKey(receipt)] === true && current.effective[nativeKey(receipt)] === true && owned(receipt));
    return { packages, resources: result.resources.filter(resource => packages.some(receipt => resource.key === `plugin:${receipt.id}`)),
      unavailable: [...new Set([...result.unavailable, ...result.packages.filter(receipt => !packages.includes(receipt)).map(receipt => receipt.name)])] };
  }
  function guardMcp(snapshots, retainedIds = [], frozen = false) {
    const rows = api.readNativePluginPackageMetadata(root), selected = new Map(), denied = [];
    let current; try { current = configuration(); } catch { current = { own: {}, effective: {} }; }
    for (const snapshot of snapshots) {
      const matches = rows.filter(receipt => (receipt.state === 'registered' || Object.hasOwn(current.own, nativeKey(receipt))) &&
        receipt.components.mcp_servers.some(server => snapshot.connector_id === server || snapshot.tools.some(tool => tool.reference.startsWith(`${server}/`))));
      const available = receipt => { try { api.assertNativePluginPackageCurrent(root, receipt.id); return true; } catch { return false; } };
      if (matches.some(receipt => !available(receipt) || !owned(receipt) || receipt.state !== 'registered' || current.own[nativeKey(receipt)] !== true ||
          current.effective[nativeKey(receipt)] !== true || (!receipt.control.new_admissions || frozen) && !retainedIds.includes(receipt.id))) {
        denied.push(snapshot.connector_id); continue;
      }
      for (const receipt of matches) {
        const { current: _current, control: _control, ...pin } = receipt; selected.set(receipt.id, pin);
      }
    }
    // Namespace association protects a possible owned dependency; it never
    // authorizes a tool or asserts native server ownership. Exact LM tool
    // references and schemas still pass the separate User-approved resolver.
    const packages = [...selected.values()];
    return { packages, denied, resources: packages.map(receipt => ({ key: `plugin:${receipt.id}`, fingerprint: receipt.approval_sha256 })) };
  }
  function status() {
    const current = configuration();
    return api.readNativePluginPackages(root).map(receipt => ({ ...receipt, registration: 'owned-user-plugin-location', observed_user_registration: current.own[nativeKey(receipt)] ?? 'absent',
      observed_effective_registration: current.effective[nativeKey(receipt)] ?? 'absent', native_component_loading: 'not-observed',
      external_native_controls_freezable: false }));
  }
  const professional = receipt => ({ name: receipt.name, version: receipt.version, source: receipt.source,
    components: receipt.components, state: receipt.state, cache_retained: true,
    ...(receipt.control ? { control: receipt.control } : {}),
    ...(receipt.current !== undefined ? { current: receipt.current } : {}),
    ...(receipt.observed_user_registration !== undefined ? { observed_user_registration: receipt.observed_user_registration,
      observed_effective_registration: receipt.observed_effective_registration } : {}),
    loaded: 'not-observed', used: 'not-observed', verified: 'not-observed' });
  async function prepare(selection, signal) {
    const readSources = () => options.readApprovedSources?.() ?? [], before = JSON.stringify(readSources());
    const receipt = await api.prepareNativePluginPackage(root, selection, { sources: readSources(), reader: options.reader,
      authorize: () => { configuration(); return JSON.stringify(readSources()) === before; }, signal });
    const retained = row(receipt.id), current = configuration();
    if (retained.control.pending_action || ['disabled', 'removed'].includes(retained.state) || retained.state === 'registered' && current.own[nativeKey(retained)] !== true)
      return { package: professional(retained), state: 'unavailable', reason: 'NATIVE_PACKAGE_USER_CONTROL_RETAINED', fallback: 'ordinary-work' };
    const result = await control(receipt.id, 'enable');
    return { package: professional(row(receipt.id)), result };
  }
  async function inspect(selection, signal) {
    const readSources = () => options.readApprovedSources?.() ?? [], before = JSON.stringify(readSources());
    const receipt = await api.prepareNativePluginPackage(root, selection, { sources: readSources(), reader: options.reader,
      authorize: () => { configuration(); return JSON.stringify(readSources()) === before; }, signal });
    return { name: receipt.name, version: receipt.version, source: receipt.source, components: receipt.components, files: receipt.files,
      license: receipt.license, state: 'pinned-source-cached', native_registration: 'not-performed', loaded: 'not-observed', used: 'not-observed', verified: 'not-observed' };
  }
  function capabilityStatus() {
    return { approved_sources: (options.readApprovedSources?.() ?? []).map(source => ({ source: source.name, package: source.package,
      repository: source.repository, commit: source.commit, files: source.files.length })),
      packages: status().map(professional), registration: 'owned-user-plugin-location', authorization: 'host-user-policy',
      next_action: 'Inspect an advertised approved source/package, then prepare it. Select package names per role; MCP tools require separate approved exact native bindings.' };
  }
  async function manage() {
    const rows = status();
    if (!rows.length) return vscode.window.showInformationMessage('No owned pinned native packages. Prepare an approved package before registration.');
    const selected = await vscode.window.showQuickPick(rows.map(receipt => ({ label: receipt.name, description: `${receipt.state} · ${receipt.version}`,
      detail: `${receipt.control.active_count} active holders · ${receipt.registration}`, receipt })), { title: 'WorkForce: native package registrations' });
    if (!selected) return;
    const action = await vscode.window.showQuickPick(['Enable', 'Disable', 'Unregister package'], { title: selected.label,
      placeHolder: 'WorkForce changes wait for active holders; external native UI actions remain native.' });
    if (!action) return;
    const result = await control(selected.receipt.id, action === 'Unregister package' ? 'remove' : action.toLowerCase());
    return vscode.window.showInformationMessage(result.control?.state === 'deferred'
      ? 'Package change queued. Active workers keep the current native registration; new selections are denied.'
      : 'Owned native package registration updated. Source/cache and history remain; native component loading requires separate observation.');
  }
  return { prepare, inspect, capabilityStatus, control, drain, resolve: resolvePackages, guardMcp, status, manage };
}
module.exports = { createNativePluginPackageHost };
