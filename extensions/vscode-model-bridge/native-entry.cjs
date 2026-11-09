'use strict';

const { realpathSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const { createLocalRequestRunner } = require('./local-request.cjs');
const { createLocalModelPolicy } = require('./local-models.cjs');
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
      const runner = (options.createRunner ?? createLocalRequestRunner)(vscode, api, root, policy);
      const value = { api, runner, root }; runners.set(key, value); return value;
    });
    pending.set(key, operation);
    try { return await operation; }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  const labels = { request: 'WorkForce: implement, independently review and check this request',
    role: 'WorkForce: complete the selected role scope', prepare: 'WorkForce: find existing experience and qualified tools',
    control: 'WorkForce: inspect or continue the retained request',
    capabilities: 'WorkForce: find or prepare optional role skills' };
  async function capabilities(api, root, input, cancellation) {
    if (typeof api.manageNativeCapabilities !== 'function')
      return { state: 'unavailable', fallback: 'ordinary-work', reason: 'matching-runtime-required' };
    // Catalog approval belongs to User settings. A workspace cannot add trusted
    // sources by placing settings in the repository being inspected.
    const readSources = () => {
      const configured = vscode.workspace.getConfiguration?.('workforce')?.inspect?.('capabilities.sources')?.globalValue;
      return structuredClone((configured === undefined ? api.DEFAULT_NATIVE_CAPABILITY_SOURCES : configured) ?? []);
    };
    const sources = readSources(), sourceSnapshot = JSON.stringify(sources);
    const controller = new AbortController();
    const listener = cancellation?.onCancellationRequested?.(() => controller.abort());
    const settings = vscode.workspace.onDidChangeConfiguration?.(event => {
      if (event.affectsConfiguration('workforce.capabilities.sources')) controller.abort();
    });
    const operation = { root, controller, promise: undefined };
    const isCurrent = () => {
      try { return rootFor({ workspace_folder: root }) === root && JSON.stringify(readSources()) === sourceSnapshot; }
      catch { return false; }
    };
    if (cancellation?.isCancellationRequested) controller.abort();
    activeCapabilities.add(operation);
    try {
      operation.promise = Promise.resolve().then(() => api.manageNativeCapabilities(root, input, {
        sources, fetch: globalThis.fetch, signal: controller.signal, isCurrent,
      }));
      return await operation.promise;
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
        const root = rootFor(invocation.input), { api, runner } = await owner(root);
        let { workspace_folder: _selected, ...input } = invocation.input ?? {};
        if (binding.role) {
          if (typeof api.nativeRoleContentSchema?.safeParse !== 'function' || !api.nativeWorkerProfiles?.[binding.role])
            throw new EntryError('NATIVE_RUNTIME_REQUIRED', 'Install the matching native WorkForce runtime with role-bound tools and worker profiles.');
          const content = api.nativeRoleContentSchema.safeParse(input);
          if (!content.success) throw new EntryError('INVALID_ROLE_REQUEST', 'Supply professional requirement, context and output paths only; the selected entry fixes its role.');
          input = { ...content.data, role: binding.role };
        }
        result = binding.kind === 'prepare' ? await api.prepareNativeWork(root, input)
          : binding.kind === 'capabilities' ? await capabilities(api, root, input, cancellation)
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
