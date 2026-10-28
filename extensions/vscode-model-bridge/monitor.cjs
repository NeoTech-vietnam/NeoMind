const { realpathSync, lstatSync } = require('node:fs');
const { join, basename, relative, isAbsolute } = require('node:path');
const { randomBytes } = require('node:crypto');
const { renderFocusSpace } = require('./focus-space.cjs');
const { createFocusHost } = require('./focus-host.cjs');
const { publicStatus, createControlledPanelHost, adaptRuntime } = require('./controlled-workflows.cjs');

const genericModelChangeRefusal = 'WorkForce refused the model change. Check active invocations and role/model policy; the requested change was not accepted.';
const knownModelChangeRefusals = new Map([
  ['Custom model selection requires a configured VS Code language model catalog.',
    'Choose model catalog in Universe and select the active VS Code profile\'s chatLanguageModels.json, then connect WorkForce before changing its aliases.'],
  ['VS Code language model catalog is unavailable.',
    'The configured VS Code model catalog is unavailable. Use Choose model catalog in Universe to select the active profile\'s accessible chatLanguageModels.json.'],
  ['VS Code language model catalog must be an array.',
    'The selected file is not a VS Code model catalog. Use Choose model catalog and select the active profile\'s chatLanguageModels.json.'],
  ['Selected model must resolve to exactly one catalog vendor and ID.',
    'WorkForce refused the model change: the model is missing or ambiguous in the configured VS Code catalog. Use the exact provider group/vendor and model ID, add a missing entry or remove duplicate entries in chatLanguageModels.json, then retry.'],
  ['Configured model must resolve to one supported custom endpoint.',
    'This model is missing or ambiguous in your custom endpoint catalog. Choose a configured alias and provider, or use Choose model catalog to select the correct profile catalog.'],
  ['OpenCode requires the configured custom-endpoint catalog.',
    'Use Choose model catalog in Universe to select your active profile\'s custom endpoint catalog before connecting WorkForce.'],
  ['Model configuration cannot change while an invocation is active. Interrupt or reconcile it, then start a new invocation.',
    'WorkForce refused the model change: an invocation became active. Finish, interrupt or reconcile active work, then choose the model for a new invocation.'],
]);

/** Known policy diagnostics have fixed copy; provider text and secrets stay private. */
function modelChangeRefusal(error) {
  let message;
  try { if (error instanceof Error) message = error.message; } catch {}
  return knownModelChangeRefusals.get(message) ?? genericModelChangeRefusal;
}

function renderMonitorHtml({ cspSource, script, style, universe = 'universe.js', focusScript = 'focus-space.js', focusStyle = 'focus-space.css', nonce }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} https://i.ytimg.com data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com http://127.0.0.1:*; connect-src https://www.youtube.com https://www.youtube-nocookie.com; media-src blob:; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${style}"><link rel="stylesheet" href="${focusStyle}"><title>WorkForce Universe</title></head><body><div id="universe-view">
<header class="app-header"><div class="brand"><h1>WorkForce <span>UNIVERSE</span></h1><p>Engineering from request to verified product.</p></div><div class="project-heading"><span class="eyebrow">PROJECT</span><strong id="project-name">Connecting…</strong></div><nav class="header-actions" aria-label="WorkForce tools"><button id="open-local" type="button">Open Local WF.PM</button><button id="manage-plugins" type="button">Plug-ins</button><button id="open-automation" type="button">Reusable tools</button><button id="enter-focus-space" type="button">Focus Space</button><button id="refresh" type="button">Refresh</button></nav></header>
<section class="setup-card" aria-labelledby="setup-title"><div><span class="eyebrow">WORKSPACE CONNECTION</span><h2 id="setup-title">Checking WorkForce</h2><p id="setup-summary" class="hint">Reading the runtime and engine connection.</p><p id="setup-build" class="hint"></p><div id="setup-checks"></div></div><div class="toolbar"><button id="select-model-catalog" type="button">Choose model catalog</button><button id="setup-connect" type="button" class="primary">Connect WorkForce</button></div></section>
<main class="workspace"><aside class="request-sidebar panel" aria-label="Requests"><div class="toolbar"><h2>Your requests</h2><button id="new-request" type="button">+ New</button></div><div id="requests"><p class="empty">No requests yet. Describe a useful outcome to begin.</p></div></aside>
<div class="request-main"><section class="compose panel" id="compose"><h2>What would you like to create?</h2><label for="requirement" class="hint">Use your own words. WorkForce owns planning, implementation and independent checks.</label><textarea id="requirement" rows="3" maxlength="20000" placeholder="Describe the result you want and the files or folder to work with."></textarea><div class="toolbar"><button id="submit" type="button" class="primary" disabled>Start request</button><span class="hint">Continues while VS Code stays open.</span></div><p id="notice" role="status" aria-live="polite"></p></section>
<section class="panel" aria-labelledby="request-title"><div class="request-heading"><div><span id="request-key" class="eyebrow">YOUR NEXT PRODUCT</span><h2 id="request-title">Give WorkForce a request</h2><p id="request-action" class="muted">The V-model will show the real engineering progress.</p></div><span id="request-status" class="status-pill">No request selected</span></div><div id="request-controls" class="toolbar"></div></section>
<section class="v-panel panel" aria-labelledby="v-model-title"><div class="v-panel-heading"><div><span class="eyebrow">SPECIFICATION ↔ VERIFICATION</span><h2 id="v-model-title">Engineering V-model</h2></div><button id="motion" type="button" aria-pressed="false">Pause motion</button></div><div class="pm-strip"><strong>WF.PM</strong><span id="pm-action">Coordinates requirements, implementation and evidence.</span></div><div id="v-model"></div><div id="review-milestone" class="review-milestone"><strong>WF.Reviewer</strong><span id="review-state">Independent review pending</span></div><p id="stage-detail" class="stage-detail">Select a stage to inspect its result or applicability.</p></section>
<section id="question-panel" class="question panel" hidden><span class="eyebrow">YOUR INPUT IS NEEDED</span><h2 id="question-text"></h2><p id="question-reason" class="muted"></p><label for="answer" class="hint">Your answer</label><textarea id="answer" rows="2" maxlength="20000"></textarea><div class="toolbar"><button id="answer-submit" type="button" class="primary">Send answer and continue</button></div></section>
<div class="deliverables-grid"><section class="panel"><div class="toolbar"><h2>Your products</h2><button id="open-request-folder" type="button" hidden>Open folder</button></div><div id="products"></div><p id="handoff" class="hint"></p></section><section class="panel"><h2>Acceptance and checks</h2><div id="criteria"></div><div id="findings"></div></section></div></div></main>
<section class="role-section"><span class="eyebrow">WF.PM + FIVE SPECIALISTS</span><h2>Agent model controls</h2><p>Configured aliases apply to the next invocation. Running work keeps its selected model. An alias does not attest the upstream model.</p><div id="roles"></div></section><p class="footer-note">WorkForce keeps artifacts, review and verification together for each request. Draft outputs remain available as the work progresses.</p>
</div>${renderFocusSpace()}<script nonce="${nonce}" src="${universe}"></script><script nonce="${nonce}" src="${focusScript}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

/** Connection enablement is an explicit user action, independent of opening the view. */
function activateMonitor(vscode, context, loadRuntime, { enabled = () => false } = {}) {
  let panel, timer, generation = 0, refreshBusy = false, opening = false;
  function stop() {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
    const current = panel; panel = undefined;
    current?.dispose();
  }
  async function open() {
    if (opening) return;
    opening = true;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust is required for the WorkForce monitor.');
      if (panel) { panel.reveal(); return; }
      const token = generation;
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (token !== generation || !folder || folder.uri.scheme !== 'file') return;
      const root = realpathSync.native(folder.uri.fsPath);
      const runtime = await loadRuntime(root), requestRuntime = adaptRuntime(runtime);
      if (token !== generation || !vscode.workspace.isTrusted) return;
      const resources = vscode.Uri.file(join(__dirname, 'resources', 'monitor'));
      const current = vscode.window.createWebviewPanel('workforce.monitor', 'WorkForce Universe', vscode.ViewColumn?.One ?? 1,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
      panel = current;
      const nonce = randomBytes(24).toString('hex');
      const script = current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, 'monitor.js')));
      const style = current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, 'monitor.css')));
      const universe = current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, 'universe.js')));
      const focusScript = current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, 'focus-space.js')));
      const focusStyle = current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, 'focus-space.css')));
      current.webview.html = renderMonitorHtml({ cspSource: current.webview.cspSource, script, style, universe, focusScript, focusStyle, nonce });
      const alive = () => panel === current && token === generation && vscode.workspace.isTrusted;
      const closeIfUntrusted = () => {
        if (panel === current && token === generation && !vscode.workspace.isTrusted) { stop(); return true; }
        return false;
      };
      const focusHost = createFocusHost({ vscode, context, runtime, alive, post: message => current.webview.postMessage(message) });
      const requestHost = createControlledPanelHost({ runtime, root, alive, enabled: () => enabled(root),
        post: message => current.webview.postMessage(message), beforeDispatch: () => {
          if (!vscode.workspace.workspaceFolders?.some(item => item.uri.scheme === 'file' && realpathSync.native(item.uri.fsPath) === root))
            throw new Error('The request must use its exact open workspace.');
        } });
      async function refresh() {
        if (closeIfUntrusted()) return;
        if (!alive() || refreshBusy || current.visible === false) return;
        refreshBusy = true;
        try {
          let control, controlUnavailable = false;
          try { control = await runtime.modelControlStatus(root); }
          catch { controlUnavailable = true; control = { roles: [], active_invocations: [], router: null }; }
          if (!alive()) return;
          const roles = control.roles.map(role => ({ role: role.role, models: role.models,
            provider: role.provider, reasoning_effort: role.reasoning_effort, strong: role.strong }));
          let permissions;
          try { permissions = vscode.workspace.getConfiguration('chat', folder.uri).get('permissions.default'); } catch {}
          let observedSetup;
          if (typeof runtime.requestSetupStatus === 'function') try { observedSetup = await runtime.requestSetupStatus(root); } catch {}
          const setup = { ready: observedSetup?.ready === true, summary: observedSetup?.summary,
            version: observedSetup?.version, engine_version: observedSetup?.engine_version, build_fingerprint: observedSetup?.build_fingerprint,
            checks: Array.isArray(observedSetup?.checks) ? observedSetup.checks.map(item => ({ label: item.label, state: item.state, summary: item.summary })) : [
              { label: 'Workspace', state: 'ready', summary: basename(root) },
              { label: 'Runtime', state: 'ready', summary: 'Loaded from the configured trusted package' },
              { label: 'Engine', state: enabled(root) ? 'connected' : 'attention', summary: enabled(root) ? 'Enabled; model capability is checked on execution' : 'Not connected' },
              { label: 'Local permissions', state: permissions === 'autoApprove' ? 'ready' : 'attention', summary: permissions === 'autoApprove' ? 'Allow all is the workspace default' : 'Open Local WF.PM to set the workspace default' },
              { label: 'Role aliases', state: roles.length ? 'configured' : 'attention', summary: roles.length ? 'Configured; upstream models are not attested by an alias' : 'Routing is unavailable' },
            ] };
          if (!alive()) return;
          await current.webview.postMessage({ type: 'snapshot', project: { name: basename(root), root }, roles, setup,
            enabled: enabled(root),
            agent_profiles: control.agent_profiles ?? [],
            native_routing: control.native_routing ?? null,
            router_configured: Boolean(control.router), active_count: controlUnavailable ? null : control.active_invocations.length,
            controlled_model_changes: !controlUnavailable && control.active_invocations.every(item => item.controlled === true),
            control_unavailable: controlUnavailable });
        } catch {
          if (alive()) await current.webview.postMessage({ type: 'error', message: 'WorkForce could not refresh this workspace. Saved products and requests have been preserved.' });
        } finally { refreshBusy = false; }
        try { await requestHost.snapshot(); }
        catch { if (alive()) await current.webview.postMessage({ type: 'error', message: 'Saved request state is unavailable. WorkForce has preserved the request checkpoint.' }); }
      }
      let selecting = false, selectingCatalog = false;
      current.webview.onDidReceiveMessage(async message => {
        if (closeIfUntrusted()) return;
        if (!alive() || !message || typeof message !== 'object') return;
        if (message.type === 'open-plugins') { await vscode.commands.executeCommand('workforce.plugins.open'); return; }
        if (message.type === 'open-automation') { await vscode.commands.executeCommand('workforce.automation.open'); return; }
        if (message.type === 'open-local') { await vscode.commands.executeCommand('workforce.pm.openLocal'); return; }
        if (message.type === 'connect' || message.type === 'disconnect') {
          await current.webview.postMessage({ type: 'connection-busy', busy: true });
          try { await vscode.commands.executeCommand(message.type === 'connect' ? 'workforce.bridge.enable' : 'workforce.bridge.disable', root); }
          finally { if (alive()) { await current.webview.postMessage({ type: 'connection-busy', busy: false }); await refresh(); } }
          return;
        }
        if (message.type === 'select-model-catalog') {
          if (selectingCatalog) return;
          selectingCatalog = true;
          try {
            if (typeof runtime.configureWorkForceModelCatalog !== 'function') throw new Error();
            const selected = await vscode.window.showOpenDialog({ title: 'WorkForce: choose the active VS Code model catalog', openLabel: 'Use model catalog',
              canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Model catalog JSON': ['json'] } });
            if (!alive() || selected?.length !== 1 || selected[0].scheme !== 'file') return;
            const configured = runtime.configureWorkForceModelCatalog(root, { path: selected[0].fsPath });
            if (alive()) {
              const names = { manager: 'WF.PM', requirements: 'WF.SWSD', architect: 'WF.P-RES', developer: 'WF.FnD', reviewer: 'WF.Reviewer', verifier: 'WF.Tester' };
              const unresolved = [...new Set((configured?.unresolved_roles ?? []).map(item => names[typeof item === 'string' ? item : item?.role]).filter(Boolean))];
              if (configured?.selections_valid === false && unresolved.length)
                await vscode.window.showWarningMessage(`WorkForce model catalog saved. Use Change model for ${unresolved.join(', ')} to choose supported aliases before connecting.`);
              else await vscode.window.showInformationMessage('WorkForce model catalog saved. Connect the workspace to verify its configured aliases.');
            }
            await refresh();
          } catch { if (alive()) await vscode.window.showWarningMessage('WorkForce could not use this model catalog. Select the active profile catalog containing all configured role aliases and valid endpoints.'); }
          finally { selectingCatalog = false; }
          return;
        }
        if (['controlled-action', 'controlled-receipt-ack'].includes(message.type)) { await requestHost.handle(message); return; }
        if (message.type === 'open-product' || message.type === 'open-request-folder') {
          try {
            if (typeof message.workflow_id !== 'string') return;
            const value = publicStatus(await requestRuntime.controlledStatus(root, message.workflow_id)).workflows
              .find(item => item.workflow_id === message.workflow_id);
            const path = message.type === 'open-request-folder' ? value?.folder
              : value?.artifacts.find(item => item.path === message.path && item.exists !== false)?.path;
            if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.'))
              throw new Error();
            const full = realpathSync.native(runtime.safePath(root, path)), rel = relative(root, full);
            if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${require('node:path').sep}`)) throw new Error();
            const info = lstatSync(full);
            if (!alive()) return;
            if (message.type === 'open-request-folder' && info.isDirectory())
              await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(full));
            else if (message.type === 'open-product' && info.isFile())
              await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full));
            else throw new Error();
          } catch { if (alive()) await vscode.window.showWarningMessage('This product is no longer available in the selected request. Refresh to inspect its current outputs.'); }
          return;
        }
        if (message.type === 'focus-space') { await focusHost.handle(message); return; }
        if (message.type === 'refresh') { await refresh(); return; }
        if (message.type !== 'select-model' || selecting || typeof message.role !== 'string') return;
        selecting = true;
        try {
          const control = await runtime.modelControlStatus(root);
          const role = control.roles.find(item => item.role === message.role);
          if (!role || !alive()) return;
          if (control.active_invocations.length && control.active_invocations.some(item => item.controlled !== true)) {
            await vscode.window.showWarningMessage('Model changes are blocked while WorkForce invocations are active. Finish or stop them, then choose a model.');
            return;
          }
          let catalog = [], registered = [];
          if (control.router) {
            try { catalog = await runtime.routerModels(root); }
            catch { await vscode.window.showWarningMessage('9router catalog is unavailable. Configured model IDs remain selectable.'); }
          }
          if (typeof vscode.lm?.selectChatModels === 'function') {
            try { registered = await vscode.lm.selectChatModels({}); }
            catch { await vscode.window.showWarningMessage('Registered VS Code model metadata is unavailable. Configured models remain selectable.'); }
          }
          if (!alive()) return;
          const choices = [
            ...role.models.map(id => ({ label: id, model: id, provider: role.provider, description: `Configured · ${role.provider ?? 'copilot'}` })),
            ...catalog.map(item => ({ label: item.id, model: item.id, provider: control.router.catalog_provider,
              description: `9router catalog · ${control.router.catalog_provider}` })),
            ...registered.filter(item => typeof item.id === 'string' && typeof item.vendor === 'string')
              .map(item => ({ label: item.id, model: item.id, provider: item.vendor, description: `VS Code registered · ${item.vendor}` })),
          ];
          const seen = new Set();
          const picked = await vscode.window.showQuickPick([
            ...choices.filter(choice => { const key = `${choice.model}\0${choice.provider ?? 'copilot'}`; if (seen.has(key)) return false; seen.add(key); return true; }),
            { label: 'Enter model ID…', custom: true },
          ], { title: `WorkForce: model for ${role.role}`, placeHolder: 'Applies to the next invocation' });
          if (!picked || !alive()) return;
          const model = picked.custom ? await vscode.window.showInputBox({ title: `WorkForce: ${role.role} model ID`,
            prompt: 'Enter an exact model ID registered with your provider.', value: role.models[0] ?? '' }) : picked.model;
          if (!model || !alive()) return;
          let provider = picked.provider;
          if (picked.custom) {
            const providers = [...new Set([role.provider ?? 'copilot', control.router?.catalog_provider,
              ...registered.map(item => item.vendor)].filter(value => typeof value === 'string' && value))];
            const choice = await vscode.window.showQuickPick(providers.map(value => ({ label: value, provider: value,
              description: value === (role.provider ?? 'copilot') ? 'Current provider' : 'Configured or registered provider' })),
            { title: `WorkForce: provider for ${model}`, placeHolder: 'Provider and exact model ID are validated together' });
            if (!choice || !alive()) return;
            provider = choice.provider;
          }
          const result = await runtime.setRoleModel(root, { role: role.role, model, ...(provider ? { provider } : {}) });
          if (!alive()) return;
          try {
            if (typeof runtime.updateProject !== 'function') throw new Error('Generated-agent update unavailable.');
            const update = await runtime.updateProject(root);
            if (!alive()) return;
            if (update.conflicts?.length) {
              const paths = update.conflicts.slice(0, 5).map(conflict => `${conflict.path} → ${conflict.candidate}`).join('; ');
              await vscode.window.showWarningMessage(`WorkForce model policy saved (${result.applies_to}). Edited generated files were preserved; review update candidates before native agents use this selection: ${paths}`);
            } else await vscode.window.showInformationMessage(`WorkForce ${role.role}: ${model} (${result.applies_to}); generated native agents refreshed.`);
          } catch {
            if (alive()) await vscode.window.showWarningMessage('WorkForce model policy was saved, but generated native agents could not be refreshed. Run workforce update and resolve its reported candidates before starting the next native agent.');
          }
          await refresh();
        } catch (error) {
          if (alive()) await vscode.window.showErrorMessage(modelChangeRefusal(error));
        } finally { selecting = false; }
      });
      current.onDidDispose(() => {
        focusHost.dispose();
        if (panel === current) { panel = undefined; generation++; if (timer) clearInterval(timer); timer = undefined; }
      });
      current.onDidChangeViewState?.(() => { if (current.visible) void refresh(); });
      timer = setInterval(() => { void refresh(); }, 2500);
      timer.unref?.();
      await refresh();
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'WorkForce monitor could not open.');
    } finally { opening = false; }
  }
  const disposable = { dispose: stop };
  context.subscriptions.push(vscode.commands.registerCommand('workforce.monitor.open', open),
    vscode.commands.registerCommand('neomind.monitor.open', open),
    vscode.workspace.onDidChangeWorkspaceFolders(stop), disposable);
  return disposable;
}
module.exports = { activateMonitor, _test: { renderMonitorHtml } };
