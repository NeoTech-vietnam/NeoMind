'use strict';
const { existsSync, realpathSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { createGatewayChatProvider } = require('./managed-gateway-provider.cjs');

function gatewayNodeCommand(vscode) {
  const explicit = vscode.workspace.getConfiguration('workforce.gateway').inspect('nodePath')?.globalValue;
  if (explicit !== undefined && explicit !== '' && (typeof explicit !== 'string' || !isAbsolute(explicit))) throw Error('GATEWAY_NODE_REQUIRED: choose an absolute Node.js executable in User settings.');
  const candidates = explicit ? [explicit] : [process.versions.electron ? undefined : process.execPath,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs/node.exe') : undefined, '/usr/bin/node', '/usr/local/bin/node'];
  const selected = candidates.find(path => path && existsSync(path));
  if (!selected) throw Error('GATEWAY_NODE_REQUIRED: install supported Node.js or set workforce.gateway.nodePath.');
  return realpathSync.native(selected);
}

function activateManagedGateway(vscode, context, loadRuntime, installedRuntime) {
  if (typeof vscode.lm?.registerLanguageModelChatProvider !== 'function') return { dispose: async () => {} };
  const changed = new vscode.EventEmitter();
  const admissions = new Set();
  let service, initializing, currentApi, lastTokenSavingControl, closed = false;
  const enabled = () => !closed && vscode.workspace.isTrusted && context.globalState.get('workforce.gateway.enabled') === true;
  const root = () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    if (!vscode.workspace.isTrusted || folders.length !== 1) throw Error('Open one trusted local project to manage the WorkForce gateway.');
    return realpathSync.native(folders[0].uri.fsPath);
  };
  async function ensure() {
    if (closed) throw Error('GATEWAY_CLOSED');
    if (service) return service;
    return initializing ??= (async () => {
      const api = await loadRuntime(root());
      if (typeof api.installManagedGateway !== 'function' || typeof api.createManagedGatewayService !== 'function')
        throw Error('GATEWAY_RUNTIME_REQUIRED: install the matching WorkForce native runtime.');
      const privateRoot = join(context.globalStorageUri.fsPath, 'managed-gateway');
      const archivePath = join(installedRuntime(), 'resources/managed-gateway/9router-0.5.116.tgz');
      if (!existsSync(archivePath)) throw Error('GATEWAY_ARTIFACT_REQUIRED: the selected runtime is missing its verified offline gateway archive.');
      const nodeCommand = gatewayNodeCommand(vscode);
      if (existsSync(join(privateRoot, 'active-artifact.json'))) {
        const active = api.readManagedGatewayJson(privateRoot, 'active-artifact.json');
        // A changed installed artifact is an integrity finding, not permission
        // to overwrite it or repeatedly materialize another full copy.
        api.verifyManagedGatewayArtifact(privateRoot, active.id);
      } else await api.installManagedGateway(privateRoot, { allowDownload: false, archivePath, nodeCommand });
      currentApi = api;
      service = api.createManagedGatewayService({ privateRoot, nodeCommand, secretStore: context.secrets });
      return service;
    })().finally(() => { initializing = undefined; });
  }
  const lazyService = { acquire(signal) {
    const operation = (async () => {
    const live = () => { if (closed || signal?.aborted) { const error = new Error('GATEWAY_CANCELLED'); error.code = 'GATEWAY_CANCELLED'; error.name = 'CancellationError'; throw error; } };
    live();
    // Read User policy once. A setting changed while this call is preparing
    // belongs to the next invocation, never the currently selected lease.
    const configured = vscode.workspace.getConfiguration('workforce.gateway').inspect('tokenSaving')?.globalValue ?? 'off';
    const requested = configured === 'upstream-rtk' ? 'upstream-rtk' : 'off';
    const active = await ensure();
    live();
    let control = { requested, effective: 'off', deferred: true,
      reason: configured === 'off' || configured === 'upstream-rtk' ? 'runtime-control-unavailable' : 'invalid-user-policy', fingerprint: null, scope: 'routine-progress-only' };
    if ((configured === 'off' || configured === 'upstream-rtk') && typeof active.configureTokenSaving === 'function') {
      try {
        const result = await active.configureTokenSaving(requested);
        const effective = requested === 'upstream-rtk' && result?.effective === 'upstream-rtk' && result.deferred === false ? 'upstream-rtk' : 'off';
        control = { requested, effective, deferred: result?.deferred !== false,
          reason: typeof result?.reason === 'string' && /^[a-z-]{1,80}$/.test(result.reason) ? result.reason : 'optional-configuration-unavailable',
          fingerprint: typeof result?.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(result.fingerprint) ? result.fingerprint : null, scope: 'routine-progress-only' };
      } catch { control.reason = 'optional-configuration-unavailable'; }
    }
    live();
    const lease = await active.acquire(signal);
    if (closed || signal?.aborted) { try { await lease.release(); } catch {} live(); }
    lastTokenSavingControl = Object.freeze(control);
    return Object.freeze({ ...lease, tokenSaving: control.effective, tokenSavingPolicy: lastTokenSavingControl });
    })();
    admissions.add(operation);
    return operation.finally(() => admissions.delete(operation));
  } };
  const client = endpoint => currentApi.createManagedGatewayClient(endpoint, {
    getApiKey: () => service.getApiKey(), getAdminCookie: () => service.getAdminCookie(),
    prepareCombo: (name, members, signal) => service.prepareCombo(name, members, signal),
    validateCombo: name => service.validateCombo(name),
    modelDeclarations: vscode.workspace.getConfiguration('workforce.gateway').inspect('modelDeclarations')?.globalValue,
    tokenSaving: endpoint.tokenSaving === 'upstream-rtk' ? 'upstream-rtk' : 'off',
    // Only the selected route is admitted. More complex fallback pools require
    // the explicit managed routing policy, never guessed top/worker aliases.
    policy: vscode.workspace.getConfiguration('workforce.gateway').inspect('routingPolicy')?.globalValue,
  });
  const provider = createGatewayChatProvider(vscode, { service: lazyService, client, enabled,
    onDidChangeLanguageModelChatInformation: changed.event });
  context.subscriptions.push(changed, vscode.lm.registerLanguageModelChatProvider('workforce', provider));
  context.subscriptions.push(vscode.commands.registerCommand('workforce.gateway.manage', async () => {
    try {
      const choice = await vscode.window.showQuickPick([
        { label: 'Connect providers / configure combos', action: 'dashboard', detail: 'Open the managed upstream dashboard; account login stays with the provider.' },
        { label: 'Refresh available models', action: 'refresh' },
        { label: 'Show gateway usage and quota', action: 'usage', detail: 'Only requests sent through this managed gateway are counted.' },
        { label: 'Copy owned dashboard sign-in password', action: 'password', detail: 'Copies this gateway secret to your clipboard, never into chat or logs.' },
        { label: 'Stop managed gateway', action: 'stop', detail: 'Stop after current calls finish; no running request is silently discarded.' },
      ], { title: 'WorkForce managed provider gateway' });
      if (!choice) return;
      if (choice.action === 'stop') { await service?.stop(); await context.globalState.update('workforce.gateway.enabled', false); changed.fire(); return; }
      const active = await ensure();
      await active.ensureStarted();
      if (choice.action === 'password') {
        const access = await active.dashboardAccess();
        await vscode.env.clipboard.writeText(access.password);
        await vscode.window.showInformationMessage('Owned dashboard password copied. Paste it only into the local WorkForce gateway login.');
        return;
      }
      await context.globalState.update('workforce.gateway.enabled', true); changed.fire();
      if (choice.action === 'dashboard') {
        const access = await active.dashboardAccess(); await vscode.env.openExternal(vscode.Uri.parse(access.url));
      } else if (choice.action === 'usage') {
        const endpoint = await active.ensureStarted();
        const view = { ...await client(endpoint).status(), ...(lastTokenSavingControl ? { token_saving_control: lastTokenSavingControl } : {}) };
        const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(view, null, 2) });
        await vscode.window.showTextDocument(document, { preview: true });
      } else {
        const models = await provider.provideLanguageModelChatInformation({ silent: true });
        await vscode.window.showInformationMessage(`WorkForce gateway: ${models.length} declared models available in the native picker.`);
      }
    } catch (error) { await vscode.window.showErrorMessage(error.code ? `${error.code}: ${error.message}` : 'WorkForce gateway could not complete this operation. Existing accounts and request results remain saved.'); }
  }));
  return { async dispose() { if (closed) return; closed = true; await initializing?.catch(() => {});
    await Promise.allSettled([...admissions]); await service?.dispose(); } };
}
module.exports = { activateManagedGateway, gatewayNodeCommand };
