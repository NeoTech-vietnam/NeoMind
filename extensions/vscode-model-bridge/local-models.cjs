'use strict';

const { resolve } = require('node:path');
const roles = ['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'];
const canonical = root => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
const setting = root => `workforce.native.roleModels:${canonical(root)}`;
const identity = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const selectable = model => model && identity(model.id, 1000) && identity(model.vendor, 160) && identity(model.name, 1000);

function createLocalModelPolicy(vscode, context, root) {
  function modelForRole(role) {
    const value = context.workspaceState.get(setting(root), {})?.[role];
    return roles.includes(role) && typeof value?.id === 'string' && typeof value.vendor === 'string'
      ? { id: value.id, vendor: value.vendor } : undefined;
  }
  async function choose(selectedRole) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before choosing WorkForce role models.');
    const role = roles.includes(selectedRole) ? { label: selectedRole } : await vscode.window.showQuickPick(roles.map(role => {
      const current = modelForRole(role);
      return { label: role, description: current ? `${current.id} (${current.vendor})` : 'Inherit native parent model' };
    }), { placeHolder: 'Worker model for the next delegation. The intake chat keeps its native model picker selection.' });
    if (!role) return;
    const inventory = await vscode.lm.selectChatModels({});
    const seen = new Map();
    for (const model of Array.isArray(inventory) ? inventory : []) {
      if (!selectable(model)) continue;
      const key = JSON.stringify([model.id, model.vendor]);
      seen.set(key, seen.has(key) ? null : model);
    }
    const choices = [{ label: 'Inherit native parent model', description: 'Default; no alias or external catalog required' },
      ...[...seen.values()].filter(model => model && model.capabilities?.toolCalling !== false).map(model => ({
        label: model.name, description: model.vendor, detail: model.id, model: { id: model.id, vendor: model.vendor },
      }))];
    const choice = await vscode.window.showQuickPick(choices, { placeHolder: `${role.label}: applies to its next delegation; running calls keep their current model.` });
    if (!choice || !vscode.workspace.isTrusted) return;
    if (choice.model) {
      // Provider registrations can change while the native picker is open.
      // Save only a still-unique tool-capable choice; a rejected save keeps the
      // previous preference instead of silently switching the next worker.
      const latest = await vscode.lm.selectChatModels({});
      const matches = (Array.isArray(latest) ? latest : []).filter(model => selectable(model) &&
        model.id === choice.model.id && model.vendor === choice.model.vendor);
      if (matches.length !== 1 || matches[0].capabilities?.toolCalling === false)
        throw new Error('The selected model is no longer uniquely available for tool use. The previous role preference was kept.');
      if (!vscode.workspace.isTrusted) return;
    }
    // Read the latest policy after both picks. Other role selections are not
    // overwritten by an earlier, still-open picker.
    const current = { ...context.workspaceState.get(setting(root), {}) };
    if (choice.model) current[role.label] = { ...choice.model };
    else delete current[role.label];
    await context.workspaceState.update(setting(root), current);
    return { role: role.label, selection: choice.model ? 'explicit' : 'inherit', applies: 'next-invocation' };
  }
  return { modelForRole, choose };
}

module.exports = { createLocalModelPolicy };
