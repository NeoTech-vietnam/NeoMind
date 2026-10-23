const { realpathSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

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

function renderMonitorHtml({ cspSource, script, style, nonce }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>NeoMind Agent Map</title></head><body>
<header><div><h1>NeoMind</h1><p>Agents, assignments, and recorded handoffs</p></div><button id="refresh">Refresh</button></header>
<p id="status" role="status">Loading local project state…</p>
<div class="map"><canvas id="field" aria-label="NeoMind pixel farm agent map"></canvas></div>
<p class="legend">Yellow dashed: recorded relationship · Blue moving dots: replay of recorded reports or handoffs · Signed receipts identify agents; project records describe work.</p>
<section id="selection" aria-live="polite">Select a character or work item to inspect its source.</section>
<section><h2>Role models</h2><p>Changes apply to the next invocation. Active invocations must finish or stop first. Native Copilot shares six agent files; each card names its group's controlling role. Strict bridge mode can select every role independently.</p><div id="roles"></div></section>
<section><h2>Observed agents and work</h2><div id="nodes"></div></section>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
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
      const current = vscode.window.createWebviewPanel('neomind.monitor', 'NeoMind Agent Map', vscode.ViewColumn?.One ?? 1,
        { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [resources] });
      panel = current;
      const nonce = randomBytes(24).toString('hex');
      const script = current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, 'monitor.js')));
      const style = current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, 'monitor.css')));
      current.webview.html = renderMonitorHtml({ cspSource: current.webview.cspSource, script, style, nonce });
      const alive = () => panel === current && token === generation && vscode.workspace.isTrusted;
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
            router_configured: Boolean(control.router), active_count: controlUnavailable ? null : control.active_invocations.length,
            control_unavailable: controlUnavailable });
        } catch {
          if (alive()) await current.webview.postMessage({ type: 'error', message: 'Local NeoMind state is unavailable. Initialize this workspace and check its configuration and receipt trust.' });
        } finally { refreshBusy = false; }
      }
      let selecting = false;
      current.webview.onDidReceiveMessage(async message => {
        if (!alive() || !message || typeof message !== 'object') return;
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
