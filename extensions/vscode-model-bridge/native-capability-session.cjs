'use strict';
const { createHash } = require('node:crypto');
const { createNativeMcpHost } = require('./native-mcp-host.cjs');
const { createNativePluginPackageHost } = require('./native-plugin-packages.cjs');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Private host admission. The model supplies connector/skill names only. */
function createNativeCapabilitySession(vscode, api, root, options = {}) {
  const mcp = createNativeMcpHost(vscode, api, root, options);
  const packages = options.pluginPackages ?? (typeof api.resolveNativePluginPackageResources === 'function' && vscode.Uri?.file && vscode.workspace?.getConfiguration
    ? createNativePluginPackageHost(vscode, api, root, options.packageOptions) : undefined);
  function packagePrompt(selected, unavailable) {
    const guidance = selected.map(pkg => `Package ${pkg.name}@${pkg.version}: read only relevant pinned guidance: ${pkg.components.skills.slice(0, 8)
      .map(skill => `${pkg.location}/${skill.path}`).join(', ') || '(no portable skills)'}.`);
    if (unavailable.length) guidance.push(`Optional native packages unavailable: ${unavailable.join(', ')}. Continue with ordinary project tools; do not retry unchanged optional installation or claim package use.`);
    return guidance.length ? `\n\nNative package guidance for this role (MCP permissions remain separate; imported agent/model rules do not replace this role):\n${guidance.join('\n')}` : '';
  }
  function stage(input, direct = false) {
    const selections = direct ? { [input.role]: input.mcp ?? [] } : input.plan?.role_mcp ?? {};
    for (const [role, ids] of Object.entries(selections)) mcp.prepare(role, ids.filter(id => api.readNativeMcpBindingControl(root, id).new_admissions));
  }
  function prepare(state, job, direct = false) {
    const roleContexts = direct ? { [state.role]: state.skill_contexts ?? [] } : state.skill_contexts ?? {};
    const selections = direct ? { [state.role]: state.mcp ?? [] } : state.plan?.role_mcp ?? {};
    const packageSelections = direct ? { [state.role]: state.plugins ?? [] } : state.plan?.role_plugins ?? {};
    const roles = [...new Set([...Object.keys(roleContexts), ...Object.keys(selections), ...Object.keys(packageSelections)])];
    const rolePackages = Object.fromEntries(roles.map(role => {
      const retained = state.dispatch_capabilities?.roles[role]?.packages;
      if (retained) {
        for (const pkg of retained) api.assertNativePluginPackageCurrent(root, pkg.id);
        return [role, { packages: retained, unavailable: (packageSelections[role] ?? []).filter(name => !retained.some(pkg => pkg.name === name)),
          resources: retained.map(pkg => ({ key: `plugin:${pkg.id}`, fingerprint: pkg.approval_sha256 })) }];
      }
      const names = packageSelections[role] ?? [];
      if (!names.length) return [role, { packages: [], unavailable: [], resources: [] }];
      try { return [role, packages ? packages.resolve(names) : { packages: [], unavailable: names, resources: [] }]; }
      catch { return [role, { packages: [], unavailable: names, resources: [] }]; }
    }));
    const prepared = Object.fromEntries(roles.map(role => [role, mcp.prepare(role, (selections[role] ?? []).filter(id =>
      api.readNativeMcpBindingControl(root, id).new_admissions !== false || state.dispatch_capabilities))]));
    const protectedPackages = new Map((state.dispatch_capabilities?.protected_packages ?? []).map(pkg => [pkg.id, pkg]));
    if (packages?.guardMcp) for (const role of roles) {
      if (!prepared[role].snapshots.length) continue;
      const retainedIds = [...protectedPackages.keys(), ...(state.dispatch_capabilities?.roles[role]?.packages ?? []).map(pkg => pkg.id)];
      let guard;
      try { guard = packages.guardMcp(prepared[role].snapshots, retainedIds, !!state.dispatch_capabilities); }
      catch { guard = { denied: [], packages: [] }; }
      if (guard.denied.length) prepared[role] = mcp.prepare(role, (selections[role] ?? []).filter(id => !guard.denied.includes(id) &&
        (api.readNativeMcpBindingControl(root, id).new_admissions !== false || state.dispatch_capabilities)));
      if (!state.dispatch_capabilities) for (const pkg of guard.packages) protectedPackages.set(pkg.id, pkg);
    }
    const resources = new Map();
    for (const contexts of Object.values(roleContexts)) for (const context of contexts) {
      const id = /workspace-skill-[a-f0-9]{64}/.exec(context.receipt_path)?.[0];
      if (!id) throw new Error('Host skill receipt identity is unavailable.');
      if (resources.has(`skill:${id}`)) continue;
      const fresh = state.dispatch_capabilities ? context : api.resolveNativeSkills(root, [context.name])[0];
      resources.set(`skill:${id}`, { key: `skill:${id}`, fingerprint: fresh.approval_sha256 ?? fresh.receipt_sha256, skill: fresh });
    }
    for (const value of Object.values(prepared)) for (const snapshot of value.snapshots)
      resources.set(`mcp:${snapshot.connector_id}`, { key: `mcp:${snapshot.connector_id}`, fingerprint: snapshot.fingerprint });
    for (const selected of Object.values(rolePackages)) for (const resource of selected.resources) resources.set(resource.key, resource);
    for (const pkg of protectedPackages.values()) {
      api.assertNativePluginPackageCurrent(root, pkg.id);
      resources.set(`plugin:${pkg.id}`, { key: `plugin:${pkg.id}`, fingerprint: pkg.approval_sha256 });
    }
    const packageSelection = rolePackages[job.agentName ?? state.role] ?? { packages: [], unavailable: [] };
    const promptSuffix = packagePrompt(packageSelection.packages, packageSelection.unavailable);
    if (!resources.size && !state.dispatch_capabilities && !Object.values(packageSelections).some(names => names.length))
      return { state, prepared: prepared[job.agentName ?? state.role], promptSuffix };
    if (!state.dispatch_capabilities) {
      const owner = { request_ref: state.request_ref, assignment_ref: job.assignment_ref, generation: state.editor_generation ?? 0 };
      const lease = api.acquireNativeCapabilityLease(root, { owner, resources: [...resources.values()] });
      const binding = { lease, owner, ...(protectedPackages.size ? { protected_packages: [...protectedPackages.values()] } : {}), roles: Object.fromEntries(Object.entries(prepared).map(([role, value]) => [role, {
        fingerprint: value.fingerprint, snapshots: value.snapshots, ...(value.profile ? { profile: value.profile } : {}),
        ...(packageSelections[role]?.length ? { packages: rolePackages[role].packages } : {}),
      }])) };
      // Acquiring occurs before domain dispatch locks. Unknown binding failures
      // retain their holder for reconciliation instead of pretending settlement.
      state = direct ? api.bindNativeRoleCapabilities(root, state.request_ref, binding)
        : api.bindNativeRequestCapabilities(root, state.request_ref, binding);
    } else if (api.assertNativeCapabilityLease(root, state.dispatch_capabilities.lease, state.dispatch_capabilities.owner).state !== 'active')
      throw Object.assign(new Error('A settled capability lease cannot dispatch another worker.'), { code: 'NATIVE_CAPABILITY_LEASE_SETTLED' });
    let binding = prepared[job.agentName ?? state.role];
    const retained = state.dispatch_capabilities.roles[job.agentName ?? state.role];
    // A lost optional connector never grants a different toolset and does not
    // consume product repair. The host records the ordinary native profile.
    if (retained && (!binding || retained.fingerprint !== binding.fingerprint)) binding = undefined;
    state = direct ? api.bindNativeRoleDispatchProfile(root, state.request_ref, job.assignment_ref, !!binding?.profile)
      : api.bindNativeRequestDispatchProfile(root, state.request_ref, job.assignment_ref, !!binding?.profile);
    return { state, prepared: binding, promptSuffix };
  }
  async function settle(state, direct = false) {
    const binding = state?.dispatch_capabilities;
    if (!binding || !(direct ? state.result_hash && state.invocation && ['returned', 'rejected', 'cancelled'].includes(state.invocation.status) : state.accepted === true)) return;
    const outcome = direct ? { result_hash: state.result_hash } : {
      assignments: state.assignments.map(job => ({ assignment_ref: job.assignment_ref, result_hash: job.result_hash })),
      accepted_hashes: state.accepted_hashes,
    };
    api.releaseNativeCapabilityLease(root, binding.lease, binding.owner, { outcome_sha256: hash(outcome) });
    api.drainNativeCapabilityControls(root, control => {
      if (control.key.startsWith('skill:')) return api.controlWorkspaceSkillComponent(root, control.key.slice(6), control.action);
      if (control.origin === 'native-binding') return api.applyNativeMcpBindingControl(root, control);
      if (['rea', 'codegraph', 'context7', 'playwright'].includes(control.key.slice(4)))
        return api.applyNativePluginControl(root, control, options.readPluginTargets?.() ?? {});
      if (options.applyMcpControl) return options.applyMcpControl(control);
      throw new Error('The exact owned MCP target must be available before applying this control.');
    });
    if (packages) await packages.drain();
  }
  function fallback(requestRef, assignmentRef, direct) {
    return direct ? api.bindNativeRoleDispatchProfile(root, requestRef, assignmentRef, false)
      : api.bindNativeRequestDispatchProfile(root, requestRef, assignmentRef, false);
  }
  function assertCurrent(requestRef, direct = false) {
    const state = direct ? api.getNativeRoleJob(root, requestRef) : api.getNativeRequest(root, requestRef);
    const binding = state.dispatch_capabilities;
    if (!binding) return;
    if (api.assertNativeCapabilityLease(root, binding.lease, binding.owner).state !== 'active')
      throw Object.assign(new Error('A settled capability lease cannot dispatch another worker.'), { code: 'NATIVE_CAPABILITY_LEASE_SETTLED' });
    for (const role of Object.values(binding.roles)) for (const pkg of role.packages ?? []) api.assertNativePluginPackageCurrent(root, pkg.id);
    for (const pkg of binding.protected_packages ?? []) api.assertNativePluginPackageCurrent(root, pkg.id);
  }
  return { stage, prepare, settle, fallback, assertCurrent, isPrepared: mcp.isPrepared, pluginPackages: packages };
}
module.exports = { createNativeCapabilitySession };
