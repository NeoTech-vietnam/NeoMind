/** Host-only dispatch bindings. These fields are absent from model tool inputs. */
import { assertNativeCapabilityLease, type NativeCapabilityLeaseRef, type NativeCapabilityOwner } from './native-capability-leases.js';
import type { NativeMcpCapabilitySnapshot } from './native-mcp-capabilities.js';
import type { NativeSpecialist } from './native-local-contract.js';
import { assertNativePluginPackageCurrent, type NativePluginPackageReceipt } from './native-plugin-packages.js';

export interface NativeDispatchCapabilities {
  lease: NativeCapabilityLeaseRef;
  owner: NativeCapabilityOwner;
  protected_packages?: readonly NativePluginPackageReceipt[];
  roles: Partial<Record<NativeSpecialist, { fingerprint: string; snapshots: readonly NativeMcpCapabilitySnapshot[];
    packages?: readonly NativePluginPackageReceipt[];
    profile?: { name: string; path: string; sha256: string; role: string; tools: readonly string[] } }>>;
}
export function assertNativeDispatchCapabilities(root: string, input: NativeDispatchCapabilities, requestRef: string): void {
  if (!input || input.owner?.request_ref !== requestRef) throw new Error('Capability owner must be the actual host-owned request.');
  const lease = assertNativeCapabilityLease(root, input.lease, input.owner);
  if (lease.state !== 'active') throw new Error('A settled capability lease cannot admit another native call.');
  for (const pkg of input.protected_packages ?? []) {
    if (!lease.resources.some(resource => resource.key === `plugin:${pkg.id}` && resource.fingerprint === pkg.approval_sha256))
      throw new Error('Protected native package is not covered by its actual owned lease.');
    assertNativePluginPackageCurrent(root, pkg.id);
  }
  for (const [role, binding] of Object.entries(input.roles)) {
    if (!['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'].includes(role) || !binding || !/^[a-f0-9]{64}$/.test(binding.fingerprint))
      throw new Error('Use a host-prepared capability binding.');
    if (binding.profile && (binding.profile.role !== role || binding.profile.name !== `${role} Worker MCP ${binding.fingerprint.slice(0, 16)}` ||
        !/^[a-f0-9]{64}$/.test(binding.profile.sha256))) throw new Error('Capability profile must match its actual professional role and frozen fingerprint.');
    for (const snapshot of binding.snapshots) if (!lease.resources.some(resource => resource.key === `mcp:${snapshot.connector_id}` && resource.fingerprint === snapshot.fingerprint))
      throw new Error('Capability binding is not covered by its actual owned lease.');
    for (const pkg of binding.packages ?? []) {
      if (!lease.resources.some(resource => resource.key === `plugin:${pkg.id}` && resource.fingerprint === pkg.approval_sha256))
        throw new Error('Native package source is not covered by its actual owned lease.');
      assertNativePluginPackageCurrent(root, pkg.id);
    }
  }
}
