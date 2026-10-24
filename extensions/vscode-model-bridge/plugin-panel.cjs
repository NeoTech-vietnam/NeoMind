const { realpathSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { homedir, platform } = require('node:os');
const { randomBytes } = require('node:crypto');

const IDS = ['rea', 'codegraph', 'context7', 'playwright'];
const CLIENTS = ['codex', 'copilot-vscode', 'copilot-cli'];
const connectionStates = new Set(['connected', 'disconnected', 'missing', 'conflict', 'unselected', 'unavailable', 'unmanaged', 'owned', 'blocked', 'not-configured', 'disabled']);
const availabilityStates = new Set(['disabled', 'missing', 'installed', 'ready', 'blocked']);
const text = value => typeof value === 'string' ? value.slice(0, 120) : null;
const knownFailures = new Map([
  ['Plug-in configuration cannot change while an invocation is active. Interrupt or reconcile it first.', 'Finish, interrupt or reconcile active NeoMind work before changing plug-ins.'],
  ['Enable the plug-in before installing it.', 'Enable this plug-in first, then install its pinned version.'],
  ['Enable the plug-in before probing it.', 'Enable this plug-in before running the direct MCP probe.'],
  ['Enable CodeGraph before verifying it.', 'Enable CodeGraph before verifying its conformance.'],
  ['CodeGraph native conformance currently supports Windows only.', 'CodeGraph native conformance currently supports Windows only. The other plug-ins remain available on Linux.'],
  ['Run CodeGraph verification with the supported Node CLI.', 'CodeGraph conformance needs the supported Node CLI. Run neomind plugins probe codegraph in this project, then refresh this panel.'],
  ['CodeGraph fixture conformance did not pass all twelve checks. Review the installed package and platform prerequisites.', 'CodeGraph conformance failed. Check its installed package and prerequisites before connecting it.'],
  ['Plug-in MCP verification failed. Check its pinned installation, prerequisite and required tools.', 'The direct MCP probe failed. Check the pinned installation and its runtime prerequisites, then retry.'],
  ['Local-only policy disables approved provider package downloads.', 'Project network policy is local-only. Enable downloads in your project policy before installing a missing package, then retry.'],
]);
const knownReasons = new Set([
  'Install pinned CodeGraph, then Verify to run its isolated conformance checks.',
  'Verify CodeGraph to run its isolated C/C++ conformance checks and configure the approved MCP launch.',
  'This CodeGraph native adapter requires Windows conformance. Linux native registration is not yet supported.',
  'Install the pinned plug-in and verify its dependency baseline.',
  'CodeGraph needs a current approved conformance report and configured launch for this platform.',
  'Probe the installed plug-in to verify its MCP connection and required tools.',
  'The project or plug-in configuration is invalid. Review configuration before changing connections.',
]);
function actionFailure(error) {
  let message;
  try { if (error instanceof Error) message = error.message; } catch {}
  return knownFailures.get(message) ?? 'Plug-in action could not finish. Check active work, network policy, approved setup and client configuration. No automatic policy changes were made.';
}

function renderPluginPanelHtml({ cspSource, script, style, nonce }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource}; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${style}"><title>NeoMind Plug-ins</title></head><body>
<header><div><p class="eyebrow">NEOMIND · INTEGRATIONS</p><h1>Plug-in control</h1><p>Choose the tools your agents can use.</p></div><button id="refresh" type="button">Refresh status</button></header>
<main><section class="connection-settings" aria-labelledby="connections-heading"><div><h2 id="connections-heading">Client connections</h2><p>Codex and Copilot CLI use this workspace and your home configuration. Select the MCP settings file for your active VS Code profile.</p></div><button id="select-vscode" type="button">Choose VS Code MCP file…</button><p id="vscode-target" role="status">VS Code profile file not selected</p></section>
<p id="notice" role="status" aria-live="polite">Reading project configuration…</p><div id="plugins" class="plugin-grid" aria-label="Available plug-ins"></div>
<section class="help"><h2>After changing a connection</h2><p>Enable → Install pinned version → Probe MCP → Connect. Restart the affected MCP server and start a new chat. A connected configuration is not proof that the client has started or used the server. Probe starts a direct MCP check and records its result.</p><p>Disable revokes the NeoMind provider before removing owned client registrations. Edited or conflicting entries are preserved and reported for manual review. Running client processes may retain a connection until restarted.</p><p>Installation downloads only the catalog's pinned package. Your project network policy still applies. CodeGraph verification runs isolated C/C++ conformance checks on Windows. Started installation or verification may finish after closing this panel.</p></section></main>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

/** All paths and action dispatch are native-owned. The webview only chooses catalog IDs. */
function createPluginHost({ vscode, context, runtime, root, alive, post }) {
  let busy = false;
  const storageKey = `neomind.plugins.vscodeMcp:${root}`;
  const targets = () => {
    const selected = context.workspaceState?.get(storageKey);
    return { codex: join(root, '.codex', 'config.toml'), copilotCli: join(homedir(), '.copilot', 'mcp-config.json'),
      ...(typeof selected === 'string' && isAbsolute(selected) ? { copilotVscode: selected } : {}) };
  };
  const send = async value => { if (alive()) await post(value); };
  async function snapshot() {
    if (!alive()) return;
    const state = await runtime.readPluginControlStatus(root);
    if (!alive()) return;
    const connections = await runtime.readPluginConnections(root, targets());
    if (!alive()) return;
    const rows = Array.isArray(connections) ? connections : connections.connections ?? [];
    const plugins = IDS.map(id => {
      const value = state.plugins?.find(item => item.id === id) ?? {};
      return { id, enabled: value.enabled === true, installed: value.installed === true,
        version: text(value.version), availability: availabilityStates.has(value.availability) ? value.availability : 'blocked',
        reason: knownReasons.has(value.reason) ? value.reason : null,
        last_probe: value.last_probe ? { ok: value.last_probe.ok === true || value.last_probe.status === 'passed',
          checked_at: text(value.last_probe.checked_at ?? value.last_probe.at), tool_count: Number.isSafeInteger(value.last_probe.tool_count) ? value.last_probe.tool_count : null } : null,
        connections: CLIENTS.map(client => { const row = rows.find(item => (item.plugin === id || item.id === id) && item.client === client);
          return { client, status: connectionStates.has(row?.status) ? row.status : 'unavailable' }; }) };
    });
    await send({ type: 'plugin-snapshot', plugins, vscode_selected: Boolean(targets().copilotVscode) });
  }
  async function handle(message) {
    if (!alive() || busy || !message || typeof message !== 'object' || message.type !== 'plugin-action') return;
    if (!['refresh', 'select-vscode', 'enable', 'disable', 'install', 'probe', 'connect', 'disconnect'].includes(message.action)) return;
    if (!['refresh', 'select-vscode'].includes(message.action) && !IDS.includes(message.plugin)) return;
    if (['connect', 'disconnect'].includes(message.action) && !CLIENTS.includes(message.client)) return;
    busy = true;
    await send({ type: 'plugin-busy', busy: true });
    let notice = '';
    try {
      if (!alive()) return;
      if (message.action === 'select-vscode') {
        const userDirectory = platform() === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Code', 'User')
          : platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Code', 'User') : join(homedir(), '.config', 'Code', 'User');
        const pickerOptions = { title: 'Choose existing or new MCP settings for your active VS Code profile',
          defaultUri: vscode.Uri.file(targets().copilotVscode ?? join(userDirectory, 'mcp.json')), filters: { 'MCP JSON settings': ['json'] } };
        const saved = typeof vscode.window.showSaveDialog === 'function'
          ? await vscode.window.showSaveDialog({ ...pickerOptions, saveLabel: 'Use MCP settings file' }) : undefined;
        const selected = typeof vscode.window.showSaveDialog === 'function' ? (saved ? [saved] : undefined)
          : await vscode.window.showOpenDialog({ ...pickerOptions, canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
        if (!alive()) return;
        if (selected?.length === 1 && selected[0].scheme === 'file' && isAbsolute(selected[0].fsPath)) {
          await context.workspaceState.update(storageKey, selected[0].fsPath);
          if (!alive()) return;
          notice = 'VS Code MCP file selected. Use Connect for each plug-in you want to register.';
        }
      } else if (message.action === 'disable') {
        let unresolved = 0;
        const actionTargets = targets();
        let existing = [];
        try {
          const result = await runtime.readPluginConnections(root, actionTargets);
          existing = Array.isArray(result) ? result : result.connections ?? [];
        } catch { unresolved++; }
        // Exact legacy registrations can be adopted without adding a server.
        // Capture ownership while the current approved launch is still available.
        for (const client of CLIENTS) {
          if (!alive()) return;
          const row = existing.find(item => item.plugin === message.plugin && item.client === client);
          if (row?.status !== 'connected' || row.managed !== false) continue;
          try { await runtime.setPluginConnection(root, { plugin: message.plugin, client, connected: true }, actionTargets); }
          catch { unresolved++; }
        }
        if (!alive()) return;
        // Refusal must leave client registrations intact; cleanup follows revocation.
        await runtime.setPluginEnabled(root, message.plugin, false);
        for (const client of CLIENTS) {
          if (!alive()) return;
          try {
            const result = await runtime.setPluginConnection(root, { plugin: message.plugin, client, connected: false }, actionTargets);
            if (['conflict', 'blocked', 'unmanaged', 'unavailable'].includes(result?.status)) unresolved++;
          } catch { unresolved++; }
        }
        if (!alive()) return;
        notice = unresolved ? 'NeoMind provider disabled. Some client entries could not be removed; review their status and restart affected clients.'
          : 'NeoMind provider disabled and owned registrations removed. Restart affected clients to close existing MCP processes.';
      } else if (message.action === 'enable') {
        await runtime.setPluginEnabled(root, message.plugin, true);
        notice = 'NeoMind provider enabled. Connect the clients you want to use, then restart their MCP servers.';
      } else if (message.action === 'install') {
        await runtime.installPlugin(root, message.plugin);
        notice = 'Pinned package installed. Probe the MCP server, then connect your clients when ready.';
      } else if (message.action === 'probe') {
        const result = await runtime.probePlugin(root, message.plugin);
        notice = result?.ok === false || result?.status === 'failed' ? 'Direct MCP probe failed. Check the plug-in setup and local runtime diagnostics.'
          : 'Direct MCP probe finished. Check the recorded result below; client conversation verification is separate.';
      } else if (message.action === 'connect' || message.action === 'disconnect') {
        if (message.client === 'copilot-vscode' && !targets().copilotVscode) {
          notice = 'Choose the MCP settings file for your active VS Code profile first.';
        } else {
          const result = await runtime.setPluginConnection(root, { plugin: message.plugin, client: message.client, connected: message.action === 'connect' }, targets());
          notice = ['conflict', 'blocked', 'unmanaged', 'unavailable'].includes(result?.status)
            ? 'Connection change requires review. Existing unowned or edited settings were preserved.'
            : 'Client configuration updated. Restart its MCP server and start a new chat.';
        }
      }
      if (!alive()) return;
      if (['enable', 'disable', 'install', 'probe', 'connect', 'disconnect'].includes(message.action) && typeof runtime.updateProject === 'function') {
        try {
          const refreshed = await runtime.updateProject(root);
          if (refreshed?.conflicts?.length) notice += ' Edited generated profiles were preserved; review NeoMind update candidates.';
        } catch { notice += ' Generated profiles need a manual neomind update before the next chat.'; }
      }
      if (!alive()) return;
      try { await snapshot(); }
      catch {
        await send({ type: 'plugin-notice', message: `${notice ? `${notice} ` : ''}Status refresh is unavailable. Check project and client configuration before another change.`, error: true });
        return;
      }
      if (notice) await send({ type: 'plugin-notice', message: notice });
    } catch (error) {
      await send({ type: 'plugin-notice', message: actionFailure(error), error: true });
      try { if (alive()) await snapshot(); } catch {}
    } finally { busy = false; await send({ type: 'plugin-busy', busy: false }); }
  }
  return { handle, snapshot };
}

function activatePluginPanel(vscode, context, loadRuntime) {
  let panel, generation = 0, opening = false;
  function stop() { generation++; const current = panel; panel = undefined; current?.dispose(); }
  async function open() {
    if (opening) return;
    opening = true;
    const token = generation;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('untrusted');
      if (panel) { panel.reveal(); return; }
      const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (token !== generation || !vscode.workspace.isTrusted || !folder || folder.uri.scheme !== 'file') return;
      const root = realpathSync.native(folder.uri.fsPath);
      const runtime = await loadRuntime(root);
      if (token !== generation || !vscode.workspace.isTrusted) return;
      for (const name of ['readPluginControlStatus', 'setPluginEnabled', 'installPlugin', 'probePlugin', 'readPluginConnections', 'setPluginConnection']) {
        if (typeof runtime[name] !== 'function') throw new Error('old-runtime');
      }
      const resources = vscode.Uri.file(join(__dirname, 'resources', 'monitor'));
      const current = vscode.window.createWebviewPanel('neomind.plugins', 'NeoMind Plug-ins', vscode.ViewColumn?.One ?? 1,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
      panel = current;
      const asset = name => current.webview.asWebviewUri(vscode.Uri.file(join(resources.fsPath, name)));
      current.webview.html = renderPluginPanelHtml({ cspSource: current.webview.cspSource, script: asset('plugins.js'), style: asset('plugins.css'), nonce: randomBytes(24).toString('hex') });
      const alive = () => panel === current && token === generation && vscode.workspace.isTrusted;
      const host = createPluginHost({ vscode, context, runtime, root, alive, post: message => current.webview.postMessage(message) });
      const messages = current.webview.onDidReceiveMessage(message => host.handle(message));
      current.onDidDispose(() => { messages?.dispose(); if (panel === current) { panel = undefined; generation++; } });
      await host.handle({ type: 'plugin-action', action: 'refresh' });
    } catch { if (token === generation) vscode.window.showErrorMessage('NeoMind plug-in control requires a trusted open folder and a current installed NeoMind runtime. Check the User runtimePath setting.'); }
    finally { opening = false; }
  }
  const disposable = { dispose: stop };
  context.subscriptions.push(vscode.commands.registerCommand('neomind.plugins.open', open), vscode.workspace.onDidChangeWorkspaceFolders(stop), disposable);
  return disposable;
}
module.exports = { activatePluginPanel, createPluginHost, renderPluginPanelHtml };
