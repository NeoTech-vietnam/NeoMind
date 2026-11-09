'use strict';

/** Native pickers manage WorkForce bindings; external MCP servers stay native. */
async function manageNativeCapabilityControls(vscode, api, root, readApprovedConnectors, isCurrent = () => true) {
  const approved = readApprovedConnectors();
  const skills = api.listWorkspaceSkillComponents(root).components;
  const connectors = Array.isArray(approved) ? approved.flatMap(connector => {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector) || typeof connector.id !== 'string' || !Array.isArray(connector.roles)) return [];
    const resolution = api.resolveNativeMcpCapabilities(approved, vscode.lm.tools, { role: connector.roles?.[0], selectIds: [connector.id] });
    if (!resolution.role || resolution.reason === 'invalid-approved-connectors') return [];
    const control = api.readNativeMcpBindingControl(root, connector.id);
    return [{ label: connector.label, description: `MCP binding · ${control.state}${control.pending_action ? ` · ${control.pending_action} pending` : ''}`,
      detail: `${resolution.state} · ${control.active_count} retained holders · external server remains managed by VS Code`, connector, control }];
  }) : [];
  const rows = [...connectors, ...skills.map(skill => ({ label: skill.name, description: `Workspace skill · ${skill.state}`,
    detail: `${skill.control?.active_count ?? 0} retained holders${skill.control?.pending_action ? ` · ${skill.control.pending_action} pending` : ''}`, skill }))];
  if (!rows.length) return vscode.window.showInformationMessage('No approved native MCP bindings or installed workspace skills. Add exact connectors in User setting workforce.capabilities.mcpConnectors, or install a pinned portable skill.');
  const selected = await vscode.window.showQuickPick(rows, { title: 'WorkForce: native capabilities', placeHolder: 'Choose an approved binding or installed skill' });
  if (!selected || !isCurrent()) return;
  const actions = selected.connector ? ['Enable', 'Disable', 'Remove WorkForce binding'] : ['Disable', 'Remove workspace skill'];
  const action = await vscode.window.showQuickPick(actions, { title: selected.label, placeHolder: 'Running holders keep their frozen resources; shutdown waits for their settled outcome' });
  if (!action || !isCurrent()) return;
  const operation = action.startsWith('Remove') ? 'remove' : action.toLowerCase();
  const result = selected.connector ? api.controlNativeMcpBinding(root, selected.connector.id, operation)
    : api.controlWorkspaceSkillComponent(root, selected.skill.id, operation);
  const control = result.control;
  return vscode.window.showInformationMessage(control?.state === 'deferred'
    ? `${operation} queued: ${control.active_count} retained holder(s). New work cannot select this capability. The active workflow keeps its frozen resources.`
    : selected.connector ? 'WorkForce binding updated. Native MCP server processes and User configuration remain managed by VS Code.'
      : 'Owned workspace skill files updated. Edited or unrelated files are preserved. Reinstall from its pinned approved catalog to enable it again.');
}
module.exports = { manageNativeCapabilityControls };
