const { realpathSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { renderFocusSpace } = require('./focus-space.cjs');
const { createFocusHost } = require('./focus-host.cjs');

const genericModelChangeRefusal = 'NeoMind refused the model change. Check active invocations and role/model policy; the requested change was not accepted.';
const knownModelChangeRefusals = new Map([
  ['Custom model selection requires a configured VS Code language model catalog.',
    'NeoMind refused the model change: custom providers require a VS Code model catalog. Set language_models_file in .neomind/routing.json to your VS Code chatLanguageModels.json, then retry.'],
  ['VS Code language model catalog is unavailable.',
    'NeoMind refused the model change: the configured VS Code model catalog is unavailable. Check that language_models_file in .neomind/routing.json points to an accessible chatLanguageModels.json, then retry.'],
  ['VS Code language model catalog must be an array.',
    'NeoMind refused the model change: the VS Code model catalog must contain an array of provider groups. Check language_models_file in .neomind/routing.json points to your actual chatLanguageModels.json, then retry.'],
  ['Selected model must resolve to exactly one catalog vendor and ID.',
    'NeoMind refused the model change: the model is missing or ambiguous in the configured VS Code catalog. Use the exact provider group/vendor and model ID, add a missing entry or remove duplicate entries in chatLanguageModels.json, then retry.'],
  ['Model configuration cannot change while an invocation is active. Interrupt or reconcile it, then start a new invocation.',
    'NeoMind refused the model change: an invocation became active. Finish, interrupt or reconcile active work, then choose the model for a new invocation.'],
]);

/** Known policy diagnostics have fixed copy; provider text and secrets stay private. */
function modelChangeRefusal(error) {
  let message;
  try { if (error instanceof Error) message = error.message; } catch {}
  return knownModelChangeRefusals.get(message) ?? genericModelChangeRefusal;
}

function renderMonitorHtml({ cspSource, script, style, universe = 'universe.js', focusScript = 'focus-space.js', focusStyle = 'focus-space.css', nonce }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}' https://www.youtube.com; img-src ${cspSource} https://i.ytimg.com data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src https://www.youtube.com https://www.youtube-nocookie.com; media-src blob:; base-uri 'none';">
<link rel="stylesheet" href="${style}"><link rel="stylesheet" href="${focusStyle}"><title>NeoMind Universe</title></head><body><div id="universe-view">
<header class="app-header">
  <div class="brand"><span class="brand-orbit" aria-hidden="true"></span><div><h1>NeoMind <span>UNIVERSE</span></h1><p>Agent observatory</p></div></div>
  <div class="project-heading"><span class="eyebrow">PROJECT SYSTEM</span><strong id="project-name">Connecting…</strong></div>
  <div class="header-actions"><button id="enter-focus-space" class="button secondary" type="button">◉ Enter Earth <span>· Focus Space</span></button><span id="router-status" class="pill">Reading routing</span><button id="refresh" class="button secondary" type="button">↻ <span>Refresh</span></button></div>
</header>
<div class="telemetry"><p id="status" role="status">Loading local project state…</p><span id="observed-summary"></span></div>
<main class="observatory">
  <section class="universe-stage" aria-label="Agent universe">
    <div class="stage-toolbar"><span class="eyebrow"><span class="tiny-orbit" aria-hidden="true">◎</span> ORBITAL VIEW</span><div class="view-actions"><button id="focus-selection" type="button" class="button subtle">Focus</button><button id="reset-view" type="button" class="button subtle">Reset view</button><button id="show-history" type="button" class="button subtle" aria-pressed="false">Show history</button><button id="motion" type="button" class="button subtle" aria-pressed="false">Pause orbits</button></div></div>
    <canvas id="field" role="img" aria-label="Universe of configured role planets, saved task moons and recorded communication. Select items using the lists below."></canvas>
    <div id="empty-state" class="scene-notice" hidden></div>
    <div class="scene-footer"><div class="state-legend"><span><i class="state-dot running"></i>Working</span><span><i class="state-dot waiting"></i>Waiting</span><span><i class="state-dot blocked"></i>Blocked</span><span><i class="state-dot completed"></i>Complete</span><span><i class="state-dot configured"></i>Configured</span></div><span class="scene-hint">Scroll to zoom · Drag to explore</span></div>
  </section>
  <aside class="mission-control" aria-label="Selection and recorded activity">
    <section class="inspector panel"><div class="panel-heading"><span class="eyebrow">MISSION CONTROL</span><span class="local-label">LOCAL STATE</span></div><div id="selection" aria-live="polite"><div class="selection-placeholder"><span class="placeholder-orbit" aria-hidden="true">◎</span><h2>Select a planet</h2><p>Inspect a role, its model policy and its saved activity.</p></div></div></section>
    <section class="activity-panel panel"><div class="panel-heading"><h2>Agent interactions</h2><span class="replay-label">LOCAL REPORTS</span></div><p id="live-summary" class="activity-summary">Waiting for assignment activity.</p><div id="live-agents"></div><h3 class="timeline-heading">Dispatch and report history</h3><div id="activity"><p class="empty">Reported dispatches and saved handoffs will appear here.</p></div></section>
  </aside>
</main>
<p class="provenance-note">Planets show configured roles. Current view shows fresh native lifecycle hooks, assignment reports and signed sessions; these sources may describe the same agent. Pulses indicate observed activity, not individual messages. Show history reveals static saved links. Unsigned observations expire after five minutes; a stopped turn does not mean accepted work. Native hooks require client support and trust.</p>
<section class="role-section"><div class="section-heading"><div><span class="eyebrow">MODEL ROUTING</span><h2>Role constellation <span id="roles-count" class="count"></span></h2></div><p>Choose a role to inspect its 9router or VS Code model policy.</p></div><p id="profiles-summary" class="routing-note">Reading native expert profiles.</p><div id="roles" class="role-grid"></div><p class="routing-note">Model changes apply to new invocations. Native profiles can share core roles; the inspector identifies each profile's controlling model policy. The strict bridge selects each core role independently.</p></section>
<details class="saved-records panel"><summary>Saved agents &amp; work <span id="nodes-count" class="count"></span><span class="summary-hint">Inspect source records</span></summary><div id="nodes"></div></details>
</div>${renderFocusSpace()}<script nonce="${nonce}" src="${universe}"></script><script nonce="${nonce}" src="${focusScript}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

/** The monitor observes project state; it never enables the model bridge. */
function activateMonitor(vscode, context, loadRuntime) {
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
      if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust is required for the NeoMind monitor.');
      if (panel) { panel.reveal(); return; }
      const token = generation;
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (token !== generation || !folder || folder.uri.scheme !== 'file') return;
      const root = realpathSync.native(folder.uri.fsPath);
      const runtime = await loadRuntime(root);
      if (token !== generation || !vscode.workspace.isTrusted) return;
      const resources = vscode.Uri.file(join(__dirname, 'resources', 'monitor'));
      const current = vscode.window.createWebviewPanel('neomind.monitor', 'NeoMind Universe', vscode.ViewColumn?.One ?? 1,
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
      const focusHost = createFocusHost({ vscode, context, runtime, alive, post: message => current.webview.postMessage(message) });
      async function refresh() {
        if (!alive() || refreshBusy || current.visible === false) return;
        refreshBusy = true;
        try {
          const map = await runtime.readAgentMap(root);
          let control, controlUnavailable = false;
          try { control = await runtime.modelControlStatus(root); }
          catch { controlUnavailable = true; control = { roles: [], active_invocations: [], router: null }; }
          if (!alive()) return;
          const roles = control.roles.map(role => ({ role: role.role, models: role.models,
            provider: role.provider, reasoning_effort: role.reasoning_effort, strong: role.strong }));
          await current.webview.postMessage({ type: 'snapshot', map, roles,
            agent_profiles: control.agent_profiles ?? [],
            native_routing: control.native_routing ?? null,
            router_configured: Boolean(control.router), active_count: controlUnavailable ? null : control.active_invocations.length,
            control_unavailable: controlUnavailable });
        } catch {
          if (alive()) await current.webview.postMessage({ type: 'error', message: 'Local NeoMind state is unavailable. Initialize this workspace and check its configuration and receipt trust.' });
        } finally { refreshBusy = false; }
      }
      let selecting = false;
      current.webview.onDidReceiveMessage(async message => {
        if (!alive() || !message || typeof message !== 'object') return;
        if (message.type === 'focus-space') { await focusHost.handle(message); return; }
        if (message.type === 'refresh') { await refresh(); return; }
        if (message.type !== 'select-model' || selecting || typeof message.role !== 'string') return;
        selecting = true;
        try {
          const control = await runtime.modelControlStatus(root);
          const role = control.roles.find(item => item.role === message.role);
          if (!role || !alive()) return;
          if (control.active_invocations.length) {
            await vscode.window.showWarningMessage('Model changes are blocked while NeoMind invocations are active. Finish or stop them, then choose a model.');
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
          ], { title: `NeoMind: model for ${role.role}`, placeHolder: 'Applies to the next invocation' });
          if (!picked || !alive()) return;
          const model = picked.custom ? await vscode.window.showInputBox({ title: `NeoMind: ${role.role} model ID`,
            prompt: 'Enter an exact model ID registered with your provider.', value: role.models[0] ?? '' }) : picked.model;
          if (!model || !alive()) return;
          let provider = picked.provider;
          if (picked.custom) {
            const providers = [...new Set([role.provider ?? 'copilot', control.router?.catalog_provider,
              ...registered.map(item => item.vendor)].filter(value => typeof value === 'string' && value))];
            const choice = await vscode.window.showQuickPick(providers.map(value => ({ label: value, provider: value,
              description: value === (role.provider ?? 'copilot') ? 'Current provider' : 'Configured or registered provider' })),
            { title: `NeoMind: provider for ${model}`, placeHolder: 'Provider and exact model ID are validated together' });
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
              await vscode.window.showWarningMessage(`NeoMind model policy saved (${result.applies_to}). Edited generated files were preserved; review update candidates before native agents use this selection: ${paths}`);
            } else await vscode.window.showInformationMessage(`NeoMind ${role.role}: ${model} (${result.applies_to}); generated native agents refreshed.`);
          } catch {
            if (alive()) await vscode.window.showWarningMessage('NeoMind model policy was saved, but generated native agents could not be refreshed. Run neomind update and resolve its reported candidates before starting the next native agent.');
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
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'NeoMind monitor could not open.');
    } finally { opening = false; }
  }
  const disposable = { dispose: stop };
  context.subscriptions.push(vscode.commands.registerCommand('neomind.monitor.open', open),
    vscode.workspace.onDidChangeWorkspaceFolders(stop), disposable);
  return disposable;
}
module.exports = { activateMonitor, _test: { renderMonitorHtml } };
