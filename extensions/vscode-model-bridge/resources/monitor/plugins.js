(() => {
  const vscode = acquireVsCodeApi();
  const cards = new Map();
  const ids = ['rea', 'codegraph', 'context7', 'playwright'];
  const catalog = {
    rea: ['REA', 'Reverse engineering and evidence from application artifacts.'],
    codegraph: ['CodeGraph', 'Code symbols, relationships and dependency exploration.'],
    context7: ['Context7', 'Current library and framework documentation.'],
    playwright: ['Playwright', 'Browser interaction, inspection and screenshots.'],
  };
  const clients = { codex: 'Codex', 'copilot-vscode': 'Copilot · VS Code', 'copilot-cli': 'Copilot CLI' };
  let busy = true, loaded = false, vscodeSelected = false;
  const node = (tag, text, className) => { const value = document.createElement(tag); value.textContent = text ?? ''; if (className) value.className = className; return value; };
  function request(action, plugin, client) { if (!busy) vscode.postMessage({ type: 'plugin-action', action, ...(plugin ? { plugin } : {}), ...(client ? { client } : {}) }); }
  function button(label, action, plugin, client) {
    const value = node('button', label); value.type = 'button'; value.addEventListener('click', () => request(action(), plugin, client)); return value;
  }
  for (const id of ids) {
    const card = node('article', '', 'plugin-card'); card.setAttribute('aria-label', catalog[id][0]);
    const heading = node('div', '', 'card-heading'), name = node('h2', catalog[id][0]), state = node('span', 'Reading…', 'badge'); heading.append(name, state);
    const description = node('p', catalog[id][1], 'description');
    const version = node('p', 'Pinned version: reading…', 'metadata'), probe = node('p', 'No direct MCP probe recorded.', 'metadata'), reason = node('p', '', 'metadata');
    const actions = node('div', '', 'actions');
    const toggle = button('Enable', () => cards.get(id).value?.enabled ? 'disable' : 'enable', id);
    const install = button('Install pinned version', () => 'install', id), check = button('Probe MCP', () => 'probe', id);
    actions.append(toggle, install, check);
    const connectionList = node('div', '', 'connections'), connectionRows = new Map();
    for (const [client, label] of Object.entries(clients)) {
      const row = node('div', '', 'connection'), status = node('span', 'Reading…', 'connection-state');
      const control = button('Connect', () => connectionRows.get(client).status === 'connected' ? 'disconnect' : 'connect', id, client);
      control.setAttribute('aria-label', `Connect ${catalog[id][0]} to ${label}`);
      row.append(node('strong', label), status, control); connectionList.append(row);
      connectionRows.set(client, { status: 'unavailable', statusNode: status, control });
    }
    card.append(heading, description, version, probe, actions, connectionList, reason); document.getElementById('plugins').append(card);
    cards.set(id, { value: null, state, version, probe, reason, toggle, install, check, connectionRows });
  }
  function controls() {
    document.getElementById('refresh').disabled = busy;
    document.getElementById('select-vscode').disabled = busy;
    document.getElementById('plugins').setAttribute('aria-busy', String(busy));
    for (const card of cards.values()) {
      card.toggle.disabled = busy || !loaded; card.install.disabled = busy || !loaded || card.value?.installed || !card.value?.enabled;
      card.check.disabled = busy || !loaded || !card.value?.enabled || !card.value?.installed;
      for (const [client, row] of card.connectionRows) row.control.disabled = busy || !loaded || (row.status !== 'connected' && (!card.value?.enabled || card.value?.availability !== 'ready')) || (client === 'copilot-vscode' && !vscodeSelected);
    }
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'plugin-busy') { busy = message.busy === true; controls(); }
    if (message.type === 'plugin-notice' && typeof message.message === 'string') {
      const notice = document.getElementById('notice'); notice.textContent = message.message; notice.className = message.error ? 'error' : '';
    }
    if (message.type !== 'plugin-snapshot' || !Array.isArray(message.plugins)) return;
    loaded = true; vscodeSelected = message.vscode_selected === true;
    if (document.getElementById('notice').textContent === 'Reading project configuration…') document.getElementById('notice').textContent = 'Configured state loaded. Connect clients and restart their MCP servers to apply changes.';
    document.getElementById('vscode-target').textContent = vscodeSelected ? 'VS Code profile MCP file selected' : 'VS Code profile MCP file not selected';
    for (const value of message.plugins) {
      const card = cards.get(value.id); if (!card) continue;
      card.value = value; card.state.textContent = `${value.enabled ? 'Enabled' : 'Disabled'} · ${value.availability}`;
      card.state.className = `badge ${value.availability === 'ready' ? 'ready' : ''}`;
      card.version.textContent = `Pinned version: ${value.version || 'Approved external setup'} · ${value.installed ? 'Installed' : 'Not installed'}`;
      card.reason.textContent = value.reason || '';
      card.probe.textContent = value.last_probe ? `Saved MCP verification: ${value.last_probe.ok ? 'Passed' : 'Failed'}${value.last_probe.checked_at ? ` · ${value.last_probe.checked_at}` : ''}${value.last_probe.tool_count !== null ? ` · ${value.last_probe.tool_count} tools` : ''}` : 'No direct MCP probe recorded.';
      card.toggle.textContent = value.enabled ? 'Disable' : 'Enable';
      card.install.textContent = value.installed ? 'Pinned version installed' : 'Install pinned version';
      card.check.textContent = value.id === 'codegraph' ? 'Verify setup & MCP' : 'Probe MCP';
      for (const item of value.connections ?? []) {
        const row = card.connectionRows.get(item.client); if (!row) continue;
        row.status = item.status; row.statusNode.textContent = item.status;
        row.control.textContent = item.status === 'connected' ? 'Disconnect' : 'Connect';
        row.control.setAttribute('aria-label', `${item.status === 'connected' ? 'Disconnect' : 'Connect'} ${catalog[value.id][0]} ${item.status === 'connected' ? 'from' : 'to'} ${clients[item.client]}`);
      }
    }
    controls();
  });
  document.getElementById('refresh').addEventListener('click', () => request('refresh'));
  document.getElementById('select-vscode').addEventListener('click', () => request('select-vscode'));
  controls();
  // The initial native snapshot may arrive before this document loads.
  vscode.postMessage({ type: 'plugin-action', action: 'refresh' });
})();
