const { randomBytes } = require('node:crypto');
const { lstatSync, realpathSync } = require('node:fs');
const { basename, isAbsolute, join, relative, sep } = require('node:path');
const { openRoot, publicStatus } = require('./controlled-workflows.cjs');
const { nativeActivity, onNativeActivity } = require('./local-activity.cjs');
const { createLocalModelPolicy } = require('./local-models.cjs');

function renderPanel({ cspSource, stylesheet, renderer, script, nonce }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${stylesheet}"><title>WorkForce V-model</title></head>
<body class="v-model-view"><main>
<header><h1>WorkForce V-model</h1><p id="project" class="muted"></p>
<p class="hint">Saved WorkForce request state · Native Local activity appears only for calls owned by this editor.</p></header>
<div class="toolbar v-model-toolbar"><label for="request">Request</label><select id="request" disabled></select>
<button id="pin" type="button" aria-pressed="false" disabled>Pin request</button><button id="models" type="button">Role models…</button><button id="refresh" type="button">Refresh</button></div>
<p id="notice" class="hint" role="status">Reading saved requests…</p>
<section id="details" class="panel v-panel" aria-labelledby="title" hidden>
<div class="v-panel-heading"><div><h2 id="title"></h2><p id="action" class="hint"></p></div></div>
<p id="activity" class="hint" aria-live="polite"></p>
<div id="v-model"></div>
<div class="review-milestone" id="review"><strong>Independent Review · WF.Reviewer</strong><span id="review-state"></span></div>
<p id="stage-detail" class="stage-detail" aria-live="polite">Select a stage for details.</p>
<button id="stage-model" type="button" hidden>Choose role model…</button>
</section>
<div id="files" class="deliverables-grid" hidden>
<section class="panel" aria-labelledby="artifact-title"><h2 id="artifact-title">Artifacts</h2><div id="artifacts"></div></section>
<section class="panel" aria-labelledby="evidence-title"><h2 id="evidence-title">Check evidence</h2><div id="evidence"></div></section>
</div></main><script nonce="${nonce}" src="${renderer}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function readProjection(value) {
  const raw = Array.isArray(value?.requests) ? value.requests : [];
  return publicStatus(raw).workflows.flatMap((item, index) => {
    if (!item.workflow_id) return [];
    const evidence = raw[index]?.evidence;
    return [{
      workflow_id: item.workflow_id, request_key: item.request_key, title: item.title, status: item.status,
      revision: item.revision, current_action: item.current_action, stages: item.stages, review: item.review,
      source: raw[index]?.source === 'native-local' ? 'native-local' : 'saved-workforce',
      live: raw[index]?.source === 'native-local' && raw[index]?.live === true,
      activity: (raw[index]?.active_agents ?? []).slice(0, 20).map(agent => ({
        role: typeof agent.role === 'string' ? agent.role.slice(0, 80) : 'unknown',
        requested_model: typeof agent.requested_model === 'string' ? agent.requested_model.slice(0, 200) :
          agent.requested_model?.selection === 'explicit' ? `${String(agent.requested_model.name ?? agent.requested_model.id).slice(0, 160)} (${String(agent.requested_model.vendor).slice(0, 80)})` : 'inherit native parent',
        observed_model: typeof agent.observed_model === 'string' ? agent.observed_model.slice(0, 200) : 'unknown',
        observed_provider: typeof agent.observed_provider === 'string' ? agent.observed_provider.slice(0, 100) : 'unknown',
      })),
      artifacts: item.artifacts.filter(file => typeof file.path === 'string' && file.exists !== false),
      evidence: (Array.isArray(evidence) ? evidence : []).slice(0, 200)
        .filter(file => typeof file?.path === 'string' && file.path.length <= 4096)
        .map(file => ({ path: file.path, label: typeof file.label === 'string' ? file.label.slice(0, 256) : undefined,
          passed: typeof file.passed === 'boolean' ? file.passed : undefined,
          exit_code: Number.isInteger(file.exit_code) ? file.exit_code : undefined })),
    }];
  });
}

function activateVModelPanel(vscode, context, loadRuntime) {
  let active, opening = false, generation = 0;
  function close() { generation++; active?.panel.dispose(); active = undefined; }

  async function open(preferredRoot) {
    if (active && preferredRoot === undefined) { active.panel.reveal(); await active.refresh(); return; }
    if (opening) return;
    let token = generation;
    opening = true;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before opening WorkForce V-model.');
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      const physical = path => { const full = realpathSync.native(path); return process.platform === 'win32' ? full.toLowerCase() : full; };
      const folder = typeof preferredRoot === 'string' ? folders.find(item => physical(item.uri.fsPath) === physical(preferredRoot))
        : folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (typeof preferredRoot === 'string' && !folder) throw new Error('Select an exact open workspace folder for WorkForce V-model.');
      if (token !== generation || !folder) return;
      const root = openRoot(vscode, folder.uri.fsPath);
      if (active?.root === root) { active.panel.reveal(); await active.refresh(); return; }
      if (active) { close(); token = generation; }
      const policy = createLocalModelPolicy(vscode, context, root);
      const runtime = await loadRuntime(root);
      if (token !== generation || !vscode.workspace.isTrusted) return;
      if (typeof runtime.requestListForMonitor !== 'function')
        throw new Error('Install the matching WorkForce runtime to read V-model snapshots.');

      const resources = vscode.Uri.file(join(__dirname, 'resources', 'monitor'));
      const panel = vscode.window.createWebviewPanel('workforce.vModel', 'WorkForce V-model', vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [resources] });
      const pinKey = `workforce.vModel.pin:${root}`;
      const alive = () => active?.panel === panel && vscode.workspace.isTrusted;
      let requests = [], pending, dirty = false;
      function refresh() {
        if (!alive()) return Promise.resolve();
        if (pending) { dirty = true; return pending; }
        pending = Promise.resolve().then(async () => {
          try {
            do {
              dirty = false;
              const snapshot = await runtime.requestListForMonitor(root, nativeActivity(root));
              if (!alive()) return;
              requests = readProjection(snapshot);
              await panel.webview.postMessage({ type: 'snapshot', project: basename(root), pinned: context.workspaceState.get(pinKey), requests });
            } while (dirty && alive());
          } catch {
            if (alive()) await panel.webview.postMessage({ type: 'error' });
          }
        }).finally(() => { pending = undefined; });
        return pending;
      }
      active = { panel, refresh, root };
      // Event-driven snapshots; opening a view never polls a model, dispatches
      // work or writes the execution state. Watchers only read saved state.
      const activity = onNativeActivity(root, () => { void refresh(); });
      const watcher = vscode.workspace.createFileSystemWatcher?.(new vscode.RelativePattern(root, '.workforce/{requests,controlled}/**/*.json'));
      const changes = watcher ? ['onDidCreate', 'onDidChange', 'onDidDelete'].map(event => watcher[event](() => { void refresh(); })) : [];

      const listener = panel.webview.onDidReceiveMessage(async message => {
        if (!alive()) return;
        if (message?.type === 'refresh') { await refresh(); return; }
        if (message?.type === 'choose-models') {
          try {
            const result = await policy.choose(message.role);
            if (result && alive()) await panel.webview.postMessage({ type: 'model-policy', ...result });
          }
          catch { if (alive()) vscode.window.showWarningMessage('The current native model inventory could not be read. Existing role preferences are unchanged.'); }
          return;
        }
        const request = requests.find(item => item.workflow_id === message?.workflow_id);
        if (message?.type === 'pin') {
          if (!request && message.workflow_id !== null) return;
          try {
            await context.workspaceState.update(pinKey, request?.workflow_id);
            if (alive()) await panel.webview.postMessage({ type: 'pinned', workflow_id: context.workspaceState.get(pinKey) });
          } catch { if (alive()) vscode.window.showWarningMessage('WorkForce could not save this V-model pin.'); }
          return;
        }
        if (message?.type !== 'open-file' || !request) return;
        const path = [...request.artifacts, ...request.evidence].find(file => file.path === message.path)?.path;
        if (!path || isAbsolute(path) || /[:\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return;
        try {
          openRoot(vscode, root);
          const local = runtime.safePath(root, path), info = lstatSync(local);
          const full = realpathSync.native(local), child = relative(root, full);
          if (!info.isFile() || info.isSymbolicLink() || !child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error();
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(full));
        } catch { if (alive()) vscode.window.showWarningMessage('This file is unavailable in the selected WorkForce request. Refresh the saved state.'); }
      });
      panel.onDidDispose(() => {
        listener.dispose(); activity.dispose(); for (const change of changes) change.dispose(); watcher?.dispose();
        if (active?.panel === panel) active = undefined;
      });
      const uri = path => panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, path));
      panel.webview.html = renderPanel({ cspSource: panel.webview.cspSource, stylesheet: uri('monitor.css'),
        renderer: uri('universe.js'), script: uri('v-model-panel.js'), nonce: randomBytes(24).toString('hex') });
    } catch (error) {
      if (token === generation) vscode.window.showErrorMessage(error instanceof Error ? error.message : 'WorkForce V-model could not open.');
    } finally { opening = false; }
  }

  context.subscriptions.push(vscode.commands.registerCommand('workforce.vModel.open', open),
    vscode.workspace.onDidChangeWorkspaceFolders(close), { dispose: close });
}

module.exports = { activateVModelPanel };
