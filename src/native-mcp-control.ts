/** WorkForce-only MCP bindings. External servers and User secrets are not owned. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { atomicWrite, safePath } from './storage.js';
import { readNativeCapabilityControl, withNativeCapabilityControl, type NativeCapabilityControlInput } from './native-capability-leases.js';
const location = '.neomind/native/mcp-bindings.json';
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
function read(root: string): Record<string, 'disabled' | 'removed'> {
  const path = safePath(root, location);
  if (!existsSync(path)) return {};
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024) throw new Error('Invalid native MCP binding preferences.');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schema_version !== 1 || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings) ||
      Object.entries(value.bindings).some(([id, state]) => !idPattern.test(id) || !['disabled', 'removed'].includes(String(state))))
    throw new Error('Invalid native MCP binding preferences.');
  return value.bindings;
}
export function readNativeMcpBindingControl(root: string, id: string) {
  if (!idPattern.test(id)) throw new Error('Select an approved connector ID.');
  const bindings = read(root), saved = Object.hasOwn(bindings, id) ? bindings[id] : undefined;
  const control = readNativeCapabilityControl(root, `mcp:${id}`);
  return { ...control, state: saved ?? 'enabled', new_admissions: !saved && control.new_admissions, external_server_owned: false };
}
export function controlNativeMcpBinding(root: string, id: string, action: 'enable' | 'disable' | 'remove') {
  if (!idPattern.test(id) || !['enable', 'disable', 'remove'].includes(action)) throw new Error('Select a supported binding control.');
  return withNativeCapabilityControl(root, { key: `mcp:${id}`, action, origin: 'native-binding' }, () => {
    const bindings = read(root);
    if (action === 'enable') delete bindings[id]; else bindings[id] = action === 'remove' ? 'removed' : 'disabled';
    atomicWrite(safePath(root, location), JSON.stringify({ schema_version: 1, bindings }, null, 2) + '\n');
    return { id, state: Object.hasOwn(bindings, id) ? bindings[id] : 'enabled', external_server_owned: false, cache_retained: true };
  });
}
export function applyNativeMcpBindingControl(root: string, input: NativeCapabilityControlInput) {
  if (!input.key.startsWith('mcp:') || input.origin !== 'native-binding' || input.client || input.target_sha256 || !['enable', 'disable', 'remove'].includes(input.action))
    throw new Error('This control requires its exact owned client target.');
  return controlNativeMcpBinding(root, input.key.slice(4), input.action as 'enable' | 'disable' | 'remove');
}
