'use strict';

const { realpathSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const { createLocalRequestRunner } = require('./local-request.cjs');
const { createLocalModelPolicy } = require('./local-models.cjs');
const { createNativeCapabilitySession } = require('./native-capability-session.cjs');
const { createNativePluginPackageHost } = require('./native-plugin-packages.cjs');
const { manageNativeCapabilityControls } = require('./native-capability-controls.cjs');
const { nativeProfessionalRoles, validNativeWorkerProfiles } = require('./local-delegation.cjs');

const nativeToolNames = Object.freeze({ request: 'workforce_native_request', role: 'workforce_native_role',
  prepare: 'workforce_native_prepare', control: 'workforce_native_control', capabilities: 'workforce_native_capabilities' });
const nativeRoleToolNames = Object.freeze(Object.fromEntries(nativeProfessionalRoles.map(role =>
  [role, `workforce_native_role_${role.slice(3).toLowerCase().replaceAll('-', '_')}`])));
const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
class EntryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Native entry has no connection probe, provider session or engine process.
 * Runtime loading and owned runners are lazy and scoped to exact open roots. */
function activateNativeEntry(vscode, context, loadRuntime, options = {}) {
  const runners = new Map(), pending = new Map(), activeCapabilities = new Set();
  let disposed = false, closing;
  const readNativePackageSources = root => structuredClone(options.readApprovedNativePackageSources?.(root) ??
    vscode.workspace.getConfiguration?.('workforce')?.inspect?.('capabilities.nativePackageSources')?.globalValue ?? []);
  function rootFor(input) {
    if (disposed) throw new EntryError('NATIVE_ENTRY_DISPOSED', 'The native WorkForce host has closed. Existing results remain saved.');
    if (!vscode.workspace.isTrusted) throw new EntryError('WORKSPACE_UNTRUSTED', 'Open and trust the project before using WorkForce.');
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => realpathSync.native(folder.uri.fsPath));
    const selected = input?.workspace_folder;
    let root;
    if (selected === undefined && folders.length === 1) root = folders[0];
    else if (typeof selected === 'string' && isAbsolute(selected)) {
      try { root = folders.find(folder => canonical(folder) === canonical(realpathSync.native(selected))); } catch { /* Unselected path. */ }
    }
    if (!root) throw new EntryError('PROJECT_REQUIRED', 'Select the exact open workspace folder; multiple projects require workspace_folder.');
    return root;
  }
  async function owner(root) {
    const key = canonical(root);
    const operation = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const api = await loadRuntime(root);
      rootFor({ workspace_folder: root });
      if (api?.nativeLocalContractVersion !== 'vscode-native/v1' || !validNativeWorkerProfiles(api.nativeWorkerProfiles) ||
          typeof api.nativeRoleContentSchema?.safeParse !== 'function')
        throw new EntryError('NATIVE_RUNTIME_REQUIRED', 'Install the matching native WorkForce runtime with role-bound tools and hidden worker profiles, then select it in User setting workforce.bridge.runtimePath.');
      const previous = runners.get(key);
      if (previous?.api === api) return previous;
      if (previous) { await previous.runner.dispose(); runners.delete(key); }
      rootFor({ workspace_folder: root });
      const policy = createLocalModelPolicy(vscode, context, root);
      let packageHost;
      if (typeof api.prepareNativePluginPackage === 'function' && typeof api.createNativePluginPackageSourceReader === 'function' &&
          vscode.Uri?.file && vscode.workspace.getWorkspaceFolder && vscode.workspace.getConfiguration) {
        let reader, readerPolicy;
        const read = query => {
          const sources = readNativePackageSources(root), snapshot = JSON.stringify(sources);
          if (!reader || snapshot !== readerPolicy) {
            readerPolicy = snapshot;
            reader = api.createNativePluginPackageSourceReader(sources, async (url, init) => {
              const current = () => rootFor({ workspace_folder: root }) === root && JSON.stringify(readNativePackageSources(root)) === snapshot;
              if (!current()) throw new Error('NATIVE_PACKAGE_POLICY_CHANGED');
              if (api.readAutomationPolicy?.(root)?.network_policy !== 'remote-enabled') throw new Error('NATIVE_PACKAGE_DOWNLOADS_DISABLED');
              const result = await (options.nativePackageFetch ?? globalThis.fetch)(url, init);
              if (!current()) throw new Error('NATIVE_PACKAGE_POLICY_CHANGED');
              return result;
            });
          }
          return reader(query);
        };
        packageHost = createNativePluginPackageHost(vscode, api, root, { readApprovedSources: () => readNativePackageSources(root), reader: read });
      }
      const capabilities = typeof api.resolveNativeMcpCapabilities === 'function' && typeof api.acquireNativeCapabilityLease === 'function'
        ? createNativeCapabilitySession(vscode, api, root, { readApprovedConnectors: () => structuredClone(
          options.readApprovedMcpConnectors?.() ?? vscode.workspace.getConfiguration?.('workforce')?.inspect?.('capabilities.mcpConnectors')?.globalValue ?? []),
          readPluginTargets: () => { const selected = context.workspaceState?.get(`workforce.plugins.vscodeMcp:${root}`);
            return typeof selected === 'string' && isAbsolute(selected) ? { copilotVscode: selected } : {}; },
          ...(packageHost ? { pluginPackages: packageHost } : {}),
        }) : undefined;
      const runner = (options.createRunner ?? createLocalRequestRunner)(vscode, api, root, { ...policy, ...(capabilities ? { capabilities } : {}) });
      const value = { api, runner, root, packageHost }; runners.set(key, value); return value;
    });
    pending.set(key, operation);
    try { return await operation; }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  const labels = { request: 'WorkForce: implement, independently review and check this request',
    role: 'WorkForce: complete the selected role scope', prepare: 'WorkForce: find existing experience and qualified tools',
    control: 'WorkForce: inspect or continue the retained request',
    capabilities: 'WorkForce: find or prepare optional role skills' };
  const approvedMcp = () => structuredClone(options.readApprovedMcpConnectors?.() ??
    vscode.workspace.getConfiguration?.('workforce')?.inspect?.('capabilities.mcpConnectors')?.globalValue ?? []);
  if (vscode.commands?.registerCommand) context.subscriptions.push(vscode.commands.registerCommand('workforce.capabilities.manage', async () => {
    const root = rootFor(), { api } = await owner(root);
    return manageNativeCapabilityControls(vscode, api, root, approvedMcp, () => {
      try { return rootFor({ workspace_folder: root }) === root; } catch { return false; }
    });
  }));
  if (vscode.commands?.registerCommand) context.subscriptions.push(vscode.commands.registerCommand('workforce.nativePackages.manage', async input => {
    const root = rootFor(input), { packageHost } = await owner(root);
    if (!packageHost) return vscode.window.showInformationMessage('The matching native runtime does not support owned full-package registration. Ordinary project work remains available.');
    return packageHost.manage();
  }));
  async function capabilities(api, root, input, cancellation, packageHost) {
    if (typeof api.manageNativeCapabilities !== 'function')
      return { state: 'unavailable', fallback: 'ordinary-work', reason: 'matching-runtime-required' };
    // Catalog approval belongs to User settings. A workspace cannot add trusted
    // sources by placing settings in the repository being inspected.
    const readSources = () => {
      const configured = vscode.workspace.getConfiguration?.('workforce')?.inspect?.('capabilities.sources')?.globalValue;
      return structuredClone((configured === undefined ? api.DEFAULT_NATIVE_CAPABILITY_SOURCES : configured) ?? []);
    };
    const packageAction = String(input.action).startsWith('package-');
    const sources = packageAction ? [] : readSources(), sourceSnapshot = JSON.stringify(packageAction ? readNativePackageSources(root) : sources);
    const controller = new AbortController();
    const listener = cancellation?.onCancellationRequested?.(() => controller.abort());
    const settings = vscode.workspace.onDidChangeConfiguration?.(event => {
      if (event.affectsConfiguration(packageAction ? 'workforce.capabilities.nativePackageSources' : 'workforce.capabilities.sources')) controller.abort();
    });
    const operation = { root, controller, promise: undefined };
    const isCurrent = () => {
      try { return rootFor({ workspace_folder: root }) === root && JSON.stringify(packageAction ? readNativePackageSources(root) : readSources()) === sourceSnapshot; }
      catch { return false; }
    };
    if (cancellation?.isCancellationRequested) controller.abort();
    activeCapabilities.add(operation);
    try {
      operation.promise = Promise.resolve().then(() => api.manageNativeCapabilities(root, input, {
        sources, fetch: globalThis.fetch, signal: controller.signal, isCurrent,
        ...(packageHost ? { nativePackages: { status: packageHost.capabilityStatus, inspect: packageHost.inspect, prepare: packageHost.prepare } } : {}),
      }));
      const result = await operation.promise;
      if (input.action === 'status' && typeof api.resolveNativeMcpCapabilities === 'function') {
        const policy = approvedMcp();
        return { ...result, mcp_connectors: (Array.isArray(policy) ? policy : []).map(connector => ({ id: connector.id, label: connector.label,
          roles: (Array.isArray(connector.roles) ? connector.roles : []).map(role => ({ role,
            resolution: api.resolveNativeMcpCapabilities(policy, vscode.lm.tools, { role, selectIds: [connector.id] }) })),
          control: api.readNativeMcpBindingControl(root, connector.id), server_ownership: 'not-observed' })) };
      }
      return result;
    } catch {
      return { state: 'unavailable', fallback: 'ordinary-work', reason: controller.signal.aborted ? 'cancelled' : 'capability-operation-failed' };
    } finally { activeCapabilities.delete(operation); listener?.dispose(); settings?.dispose(); }
  }
  const bindings = [...Object.entries(nativeToolNames).map(([kind, name]) => ({ kind, name })),
    ...Object.entries(nativeRoleToolNames).map(([role, name]) => ({ kind: 'role', name, role }))];
  for (const binding of bindings) context.subscriptions.push(vscode.lm.registerTool(binding.name, {
    prepareInvocation: () => ({ invocationMessage: binding.role ? `WorkForce: complete the ${binding.role} scope` : labels[binding.kind] }),
    async invoke(invocation, cancellation) {
      let result;
      try {
        const root = rootFor(invocation.input), { api, runner, packageHost } = await owner(root);
        let { workspace_folder: _selected, ...input } = invocation.input ?? {};
        if (binding.role) {
          if (typeof api.nativeRoleContentSchema?.safeParse !== 'function' || !api.nativeWorkerProfiles?.[binding.role])
            throw new EntryError('NATIVE_RUNTIME_REQUIRED', 'Install the matching native WorkForce runtime with role-bound tools and worker profiles.');
          const content = api.nativeRoleContentSchema.safeParse(input);
          if (!content.success) throw new EntryError('INVALID_ROLE_REQUEST', 'Supply professional requirement, context and output paths only; the selected entry fixes its role.');
          input = { ...content.data, role: binding.role };
        }
        result = binding.kind === 'prepare' ? await api.prepareNativeWork(root, input)
          : binding.kind === 'capabilities' ? await capabilities(api, root, input, cancellation, packageHost)
          : await runner[binding.kind === 'request' ? 'run' : binding.kind](input, invocation.toolInvocationToken, cancellation);
      } catch (error) {
        result = { status: 'rejected', error: error instanceof EntryError ? { code: error.code, message: error.message }
          : { code: 'NATIVE_RUNTIME_UNAVAILABLE', message: 'The trusted WorkForce runtime could not be loaded. Check User setting workforce.bridge.runtimePath and its matching installed version; no provider or engine was started.' } };
      }
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
    },
  }));
  async function prune() {
    const roots = new Set((vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => canonical(realpathSync.native(folder.uri.fsPath))));
    for (const operation of activeCapabilities) if (!roots.has(canonical(operation.root))) operation.controller.abort();
    for (const [key, value] of runners) if (!roots.has(key)) { runners.delete(key); await value.runner.dispose(); }
  }
  if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void prune().catch(() => {}); }));
  function dispose() {
    if (closing) return closing;
    disposed = true;
    for (const operation of activeCapabilities) operation.controller.abort();
    closing = Promise.allSettled([...pending.values(), ...[...activeCapabilities].map(operation => operation.promise),
      ...[...runners.values()].map(value => value.runner.dispose())]).then(() => { runners.clear(); });
    return closing;
  }
  context.subscriptions.push({ dispose });
  return { dispose };
}

module.exports = { activateNativeEntry, nativeToolNames, nativeRoleToolNames };
