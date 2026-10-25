(() => {
  'use strict';
  const vscode = acquireVsCodeApi(), byId = id => document.getElementById(id);
  let workflows = [], selected = null, enabled = false, busy = false;
  try { selected = vscode.getState()?.selected ?? null; } catch {}
  const element = (tag, text, className) => { const value = document.createElement(tag); value.textContent = text ?? ''; if (className) value.className = className; return value; };
  const action = (name, fields = {}) => vscode.postMessage({ type: 'controlled-action', action: name, ...fields });
  const status = value => value.status ?? value.state ?? 'unknown';
  const terminal = value => ['completed', 'cancelled', 'canceled'].includes(status(value));
  function renderSelection() {
    const workflow = workflows.find(item => item.workflow_id === selected);
    byId('selection-title').textContent = workflow?.title ?? workflow?.workflow_id ?? 'Select a workflow';
    byId('selection-state').textContent = workflow ? `${workflow.workflow_id} · ${status(workflow)} · ${workflow.phase ?? 'phase unavailable'} · ${workflow.transport ?? 'transport unavailable'}` : 'Select a saved workflow to inspect or control it.';
    byId('controls').replaceChildren(); byId('agents').replaceChildren(); byId('events').replaceChildren();
    if (!workflow) return;
    for (const name of ['pause', 'resume', 'cancel']) {
      const button = element('button', name[0].toUpperCase() + name.slice(1));
      button.type = 'button'; button.disabled = !enabled || busy || terminal(workflow);
      button.addEventListener('click', () => action(name, { workflow_id: workflow.workflow_id })); byId('controls').append(button);
    }
    if (workflow.blocker) {
      const value = workflow.blocker;
      byId('controls').append(element('p', typeof value === 'string' ? value : `${value.code ?? value.kind ?? 'Blocker'} · ${value.owner ?? 'runtime'}: ${value.message ?? value.next_action ?? 'Inspect the runtime journal.'}${value.trace_id ? ` · Trace: ${value.trace_id}` : ''}`, 'blocker'));
    }
    for (const agent of workflow.active_invocations ?? []) {
      const card = element('article', '', 'agent');
      card.append(element('strong', `${agent.role ?? 'Agent'} · ${status(agent)}`),
        element('p', `Requested: ${agent.requested_model ?? 'unavailable'}`),
        element('p', `Observed by Bridge: ${agent.model_provider ?? agent.provider ?? 'unavailable'} / ${agent.confirmed_model ?? 'unavailable'}`));
      byId('agents').append(card);
    }
    if (!byId('agents').children.length) byId('agents').append(element('p', 'No currently owned agent sessions.', 'hint'));
    for (const event of workflow.events ?? []) {
      const at = event.at ?? event.timestamp ?? '';
      byId('events').append(element('li', `${at} · ${event.type ?? event.kind ?? event.status ?? 'event'}${event.role ? ` · ${event.role}` : ''}${event.summary ?? event.message ? ` — ${event.summary ?? event.message}` : ''}`));
    }
  }
  function render() {
    byId('owner').textContent = enabled ? 'Model Bridge enabled · controlled execution' : 'Model Bridge disabled · saved state only';
    byId('enable').hidden = enabled; byId('submit').disabled = busy || !enabled;
    const list = byId('workflows'); list.replaceChildren();
    for (const workflow of workflows) {
      const button = element('button', '', `workflow${workflow.workflow_id === selected ? ' selected' : ''}`);
      button.type = 'button'; button.append(element('strong', workflow.title ?? workflow.workflow_id), element('span', `${status(workflow)} · ${workflow.phase ?? 'pending'}`));
      button.addEventListener('click', () => { selected = workflow.workflow_id; try { vscode.setState({ selected }); } catch {} render(); });
      list.append(button);
    }
    if (!workflows.length) list.append(element('p', 'No saved controlled workflows.', 'hint'));
    renderSelection();
  }
  window.addEventListener('message', event => {
    const value = event.data;
    if (value?.type === 'controlled-snapshot') {
      workflows = Array.isArray(value.workflows) ? value.workflows : []; enabled = value.enabled === true;
      byId('workspace').textContent = value.workspace_folder ?? 'Workspace unavailable'; render();
    } else if (value?.type === 'controlled-receipt') {
      const workflow = value.workflows?.[0];
      if (workflow?.workflow_id) { selected = workflow.workflow_id; try { vscode.setState({ selected }); } catch {} }
      byId('notice').textContent = value.action === 'submit' ? 'Request saved. NeoMind owns the remaining workflow.' : 'Control request recorded.';
      if (value.action === 'submit') byId('requirement').value = '';
    } else if (value?.type === 'controlled-error') byId('notice').textContent = `${value.code ?? 'Operation failed'}: ${value.message ?? 'Inspect the runtime journal.'}`;
    else if (value?.type === 'controlled-busy') { busy = value.busy === true; render(); }
  });
  byId('submit').addEventListener('click', () => {
    const requirement = byId('requirement').value.trim();
    if (!requirement) { byId('notice').textContent = 'Describe the requested outcome first.'; return; }
    action('submit', { requirement });
  });
  byId('refresh').addEventListener('click', () => action('status'));
  byId('enable').addEventListener('click', () => vscode.postMessage({ type: 'controlled-enable' }));
  byId('local-coordinator').addEventListener('click', () => vscode.postMessage({ type: 'controlled-local-coordinator' }));
  byId('universe').addEventListener('click', () => vscode.postMessage({ type: 'controlled-universe' }));
  action('status');
})();
