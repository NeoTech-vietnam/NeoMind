(() => {
  'use strict';
  const vscode = acquireVsCodeApi(), byId = id => document.getElementById(id);
  const send = (action, fields = {}) => vscode.postMessage({ type: 'automation-action', action, ...fields });
  const node = (tag, value, className) => { const item = document.createElement(tag); if (value !== undefined) item.textContent = String(value); if (className) item.className = className; return item; };
  for (const action of ['refresh', 'discover', 'register']) byId(action).addEventListener('click', () => send(action));
  byId('match').addEventListener('click', () => send('match', { request: byId('request').value, parameters: byId('parameters').value, paths: byId('paths').value, client: byId('client').value }));
  window.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'automation-busy') document.querySelectorAll('button').forEach(button => { button.disabled = data.busy || button.dataset.suspended === 'true'; });
    if (data.type === 'automation-notice') { byId('notice').textContent = data.message; byId('notice').className = data.error ? 'error' : ''; }
    if (data.type === 'automation-match') byId('match-result').textContent = `${data.decision.toUpperCase()}\n${data.brief}\n\n${data.next_action}`;
    if (data.type === 'automation-discovery') byId('discovery').textContent = JSON.stringify({ scripts: data.scripts, package_commands: data.package_commands, issues: data.issues }, null, 2);
    if (data.type === 'automation-snapshot') {
      const target = byId('procedures'); target.replaceChildren();
      if (!data.procedures.length) target.append(node('p', 'No registered procedures yet. Discover existing tools, then register a procedure manifest.'));
      for (const procedure of data.procedures) {
        const card = node('article'); card.append(node('h3', procedure.title), node('span', procedure.status, `status ${procedure.status}`), node('p', `${procedure.id} · ${procedure.version} · ${procedure.task_family ?? 'unclassified'}`), node('p', procedure.script), node('p', `${procedure.successful_runs} checked runs · ${procedure.reviews} reviews${procedure.last_run ? ` · Last run: ${procedure.last_run.status}` : ''}`));
        if (procedure.reason) card.append(node('p', procedure.reason, 'error'));
        for (const [label, action] of [['Check eligibility', 'qualify'], ['Suspend automatic use', 'suspend']]) {
          const button = node('button', label); button.dataset.suspended = String(procedure.status === 'suspended'); button.disabled = procedure.status === 'suspended';
          button.addEventListener('click', () => send(action, { id: procedure.id, version: procedure.version })); card.append(button);
        }
        target.append(card);
      }
    }
  });
  send('refresh');
})();
