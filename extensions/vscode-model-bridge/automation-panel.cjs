'use strict';
const { randomBytes } = require('node:crypto');
const { realpathSync, readFileSync, lstatSync } = require('node:fs');
const { join, relative, isAbsolute } = require('node:path');
function renderAutomationPanelHtml({ cspSource, script, style, nonce }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${style}"><title>WorkForce Automation Library</title></head><body>
<header><p class="eyebrow">WORKFORCE · AUTOMATION</p><h1>Automation Library</h1><p>Discover scripts and reuse reviewed procedures that fit your request.</p>
<nav><button id="refresh">Refresh</button><button id="discover">Discover scripts</button><button id="register">Register manifest…</button></nav></header>
<p id="notice" role="status" aria-live="polite"></p><section><h2>Registered procedures</h2><div id="procedures"></div></section>
<section><h2>Find a reusable procedure</h2><label>Your request<textarea id="request" rows="3"></textarea></label><label>Parameters (JSON)<textarea id="parameters" rows="3">{}</textarea></label>
<label>Authorized output folders (one per line)<textarea id="paths" rows="2"></textarea></label><label>Client<select id="client"><option value="codex">Codex</option><option value="copilot">Copilot</option><option value="cli">CLI</option></select></label>
<button id="match">Find procedure</button><pre id="match-result" aria-live="polite"></pre></section><section><h2>Discovered tools</h2><pre id="discovery">Choose Discover scripts to inspect this project.</pre></section>
<footer>Qualification requires independent review and successful checked runs. Script execution is separate from agent activity and workflow acceptance.</footer>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}
function createAutomationHost({ vscode, runtime, root, post, alive = () => true }) {
  let busy = false;
  const send = async value => { if (alive()) await post(value); };
  async function snapshot() {
    const procedures = await runtime.listProcedures(root);
    await send({ type: 'automation-snapshot', procedures: procedures.map(item => ({ id: item.id, version: item.version,
      title: item.title, status: item.status, reason: item.reason, script: item.script, task_family: item.task_family,
      reviews: item.reviews.length, successful_runs: item.runs.filter(run => run.status === 'succeeded' && run.observation !== 'fixture').length,
      last_run: item.runs.length ? { status: item.runs.at(-1).status, at: item.runs.at(-1).finished_at ?? item.runs.at(-1).started_at } : null })) });
  }
  async function handle(message) {
    if (!alive() || busy || !message || message.type !== 'automation-action' || !['refresh', 'discover', 'register', 'suspend', 'qualify', 'match'].includes(message.action)) return;
    busy = true; await send({ type: 'automation-busy', busy: true });
    try {
      if (message.action === 'discover') {
        const result = await runtime.discoverProcedureScripts(root);
        await send({ type: 'automation-discovery', scripts: result.scripts, package_commands: result.package_commands, issues: result.issues });
      } else if (message.action === 'register') {
        const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          defaultUri: vscode.Uri.file(root), filters: { 'Procedure manifest': ['json'] }, openLabel: 'Register candidate' });
        if (!alive() || !selected?.length || selected[0].scheme !== 'file') return;
        // Windows may spell the same workspace through an 8.3 alias (RUNNER~1)
        // while the selected file resolves to its long name. Compare both
        // physical identities, retaining the original runtime project binding.
        const file = selected[0].fsPath, child = relative(realpathSync.native(root), realpathSync.native(file));
        if (!child || isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\') || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).size > 256 * 1024) throw new Error('invalid-selection');
        await runtime.registerProcedure(root, JSON.parse(readFileSync(file, 'utf8')));
        await send({ type: 'automation-notice', message: 'Candidate registered. Independent review and checked pilots are required before automatic use.' });
      } else if (message.action === 'suspend' || message.action === 'qualify') {
        const known = (await runtime.listProcedures(root)).find(item => item.id === message.id && item.version === message.version);
        if (!known || !alive()) return;
        if (message.action === 'suspend') await runtime.suspendProcedure(root, { procedure_id: known.id, version: known.version, actor: 'vscode-local-user', reason: 'Automatic reuse disabled from the Automation Library by the local user.' });
        else await runtime.qualifyProcedure(root, { procedure_id: known.id, version: known.version, actor: 'vscode-local-user' });
        await send({ type: 'automation-notice', message: message.action === 'suspend' ? 'Automatic reuse suspended; historical runs preserved.' : 'Qualification checked against the current scripts, reviews and run evidence.' });
      } else if (message.action === 'match') {
        if (typeof message.request !== 'string' || message.request.length > 20000 || !['codex', 'copilot', 'cli'].includes(message.client)) return;
        const parameters = JSON.parse(typeof message.parameters === 'string' ? message.parameters : '{}');
        const paths = typeof message.paths === 'string' ? message.paths.split(/\r?\n/).map(item => item.trim()).filter(Boolean) : [];
        const result = await runtime.prepareWork(root, { request: message.request, parameters, environment: { client: message.client }, scope: { allowed_paths: paths, network: false, publication: false } });
        await send({ type: 'automation-match', decision: result.decision, brief: result.manager_brief, next_action: result.next_action });
      }
      if (alive()) await snapshot();
    } catch { await send({ type: 'automation-notice', error: true, message: 'Operation could not complete. Check the manifest, independent review and checked pilot evidence with the WorkForce procedure CLI. Existing files were preserved.' }); }
    finally { busy = false; await send({ type: 'automation-busy', busy: false }); }
  }
  return { handle, snapshot };
}
function activateAutomationPanel(vscode, context, loadRuntime) {
  let panel, generation = 0, opening = false;
  function stop() { generation++; const previous = panel; panel = undefined; previous?.dispose(); }
  async function open() {
    if (opening) return; opening = true; const token = generation;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('untrusted');
      if (panel) { panel.reveal(); return; }
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder || token !== generation || !vscode.workspace.isTrusted) return;
      const root = realpathSync.native(folder.uri.fsPath), runtime = await loadRuntime(root);
      if (token !== generation || !vscode.workspace.isTrusted) return;
      for (const name of ['listProcedures', 'discoverProcedureScripts', 'registerProcedure', 'qualifyProcedure', 'suspendProcedure', 'prepareWork']) if (typeof runtime[name] !== 'function') throw new Error('old-runtime');
      const resources = vscode.Uri.file(join(__dirname, 'resources', 'monitor'));
      const current = vscode.window.createWebviewPanel('workforce.automation', 'WorkForce Automation Library', vscode.ViewColumn?.One ?? 1, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
      panel = current;
      const asset = name => current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, name)));
      current.webview.html = renderAutomationPanelHtml({ cspSource: current.webview.cspSource, script: asset('automation.js'), style: asset('automation.css'), nonce: randomBytes(24).toString('hex') });
      const alive = () => panel === current && token === generation && vscode.workspace.isTrusted;
      const host = createAutomationHost({ vscode, runtime, root, alive, post: value => current.webview.postMessage(value) });
      const messages = current.webview.onDidReceiveMessage(message => host.handle(message));
      current.onDidDispose(() => { messages?.dispose(); if (panel === current) { panel = undefined; generation++; } });
      await host.handle({ type: 'automation-action', action: 'refresh' });
    } catch { if (token === generation) vscode.window.showErrorMessage('Automation Library requires a trusted open project and a current WorkForce runtime.'); }
    finally { opening = false; }
  }
  const disposable = { dispose: stop };
  context.subscriptions.push(vscode.commands.registerCommand('workforce.automation.open', open), vscode.workspace.onDidChangeWorkspaceFolders(stop), disposable);
  return disposable;
}
module.exports = { renderAutomationPanelHtml, createAutomationHost, activateAutomationPanel };
