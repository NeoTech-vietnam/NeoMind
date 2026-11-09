import { createHash } from 'node:crypto';

/** Native MCP permissions come from User settings and the host's actual
 * lm.tools inventory. Names supplied by a model never establish approval.
 * Stable VS Code does not expose MCP server ownership to this extension, so
 * these snapshots deliberately record no ownership or connection-health claim. */
const roles = ['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'] as const;
type NativeMcpRole = typeof roles[number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
interface ApprovedTool { name: string; reference: string }
interface ApprovedConnector { id: string; label: string; tools: ApprovedTool[]; roles: NativeMcpRole[] }
export interface NativeMcpToolSnapshot {
  readonly name: string;
  readonly reference: string;
  readonly schema_sha256: string;
  readonly input_schema: JsonObject | null;
}
export interface NativeMcpCapabilitySnapshot {
  readonly connector_id: string;
  readonly label: string;
  readonly tools: readonly NativeMcpToolSnapshot[];
  readonly fingerprint: string;
  readonly provenance: 'user-approved/exact-observed';
  readonly ownership: 'not-observed';
}
export interface NativeMcpCapabilityResolution {
  /** Ready means exact tool registration was observed, not that a server was
   * started or that its tools have run successfully. */
  readonly state: 'ready' | 'partial' | 'unavailable' | 'not-selected';
  readonly role: NativeMcpRole | null;
  readonly snapshots: readonly NativeMcpCapabilitySnapshot[];
  readonly unavailable: readonly { readonly connector_id: string; readonly reason: string }[];
  readonly fallback: 'ordinary-work';
  readonly fingerprint: string;
  readonly reason?: string;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const connectorId = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const reservedTool = /workforce|neomind|runsubagent/i;
const exactTool = (value: unknown): value is string => typeof value === 'string' && identifier.test(value) && !reservedTool.test(value);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function fields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return !Object.getOwnPropertySymbols(value).length && Object.keys(value).every(key => expected.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Canonical JSON is also a defensive copy. Never stringify provider objects,
 * getters, executable values or recursive schemas supplied by an extension. */
function jsonCopy(value: unknown, depth = 0): JsonValue {
  if (depth > 64) throw new Error('Unsupported JSON depth.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Unsupported JSON array.');
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error('Unsupported JSON array accessor.');
      copy.push(jsonCopy(descriptor.value, depth + 1));
    }
    return copy;
  }
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length) throw new Error('Unsupported JSON value.');
  const copy: JsonObject = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('Unsupported JSON accessor.');
    copy[key] = jsonCopy(descriptor.value, depth + 1);
  }
  return copy;
}
function canonical(value: unknown): string {
  const result = JSON.stringify(jsonCopy(value));
  if (Buffer.byteLength(result) > 2 * 1024 * 1024) throw new Error('Unsupported JSON size.');
  return result;
}

/** This schema is for global User configuration only. Models select connector
 * ids; they cannot submit this policy or new native tool permissions. */
export const nativeMcpConnectorJsonSchema = freeze({
  type: 'object', additionalProperties: false, required: ['id', 'label', 'tools', 'roles'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,127}$' },
    label: { type: 'string', minLength: 1, maxLength: 160 },
    tools: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: {
      type: 'object', additionalProperties: false, required: ['name', 'reference'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 256 }, reference: { type: 'string', minLength: 1, maxLength: 256 } },
    } },
    roles: { type: 'array', minItems: 1, maxItems: roles.length, uniqueItems: true, items: { type: 'string', enum: [...roles] } },
  },
});
export const nativeMcpApprovedConnectorsJsonSchema = freeze({
  type: 'array', maxItems: 128, items: nativeMcpConnectorJsonSchema,
});

function approvedPolicy(value: unknown): ApprovedConnector[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const ids = new Set<string>(), output: ApprovedConnector[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !fields(raw, ['id', 'label', 'tools', 'roles'])) return null;
    const id = field(raw, 'id'), label = field(raw, 'label'), tools = field(raw, 'tools'), allowedRoles = field(raw, 'roles');
    if (typeof id !== 'string' || !connectorId.test(id) || ids.has(id) || typeof label !== 'string' ||
        !label.trim() || label.length > 160 || /[\u0000-\u001f\u007f]/.test(label) ||
        !Array.isArray(tools) || !tools.length || tools.length > 128 ||
        !Array.isArray(allowedRoles) || !allowedRoles.length || allowedRoles.length > roles.length ||
        new Set(allowedRoles).size !== allowedRoles.length || allowedRoles.some(role => !roles.includes(role))) return null;
    ids.add(id);
    const names = new Set<string>(), references = new Set<string>(), selectedTools: ApprovedTool[] = [];
    for (const tool of tools) {
      if (!isRecord(tool) || !fields(tool, ['name', 'reference'])) return null;
      const name = field(tool, 'name'), reference = field(tool, 'reference');
      if (!exactTool(name) || !exactTool(reference) || names.has(name) || references.has(reference)) return null;
      names.add(name); references.add(reference); selectedTools.push({ name, reference });
    }
    output.push({ id, label, tools: selectedTools.sort((a, b) => compare(a.name, b.name)), roles: [...allowedRoles] });
  }
  return output;
}

interface ObservedTool { name: string; reference: string | null; snapshot: NativeMcpToolSnapshot | null }
function inventory(value: unknown): ObservedTool[] {
  if (!Array.isArray(value)) return [];
  const result: ObservedTool[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = field(raw, 'name'), reference = field(raw, 'fullReferenceName');
    if (!exactTool(name)) continue;
    const observed: ObservedTool = { name, reference: exactTool(reference) ? reference : null, snapshot: null };
    try {
      const sourceSchema = field(raw, 'inputSchema');
      if (sourceSchema !== undefined && !isRecord(sourceSchema)) throw new Error('Unsupported tool schema.');
      const input_schema = sourceSchema === undefined ? null : jsonCopy(sourceSchema) as JsonObject;
      const serialized = canonical(input_schema);
      if (observed.reference) observed.snapshot = { name, reference: observed.reference, schema_sha256: digest(serialized), input_schema };
    } catch { /* An invalid optional tool never becomes a workflow gate. */ }
    result.push(observed);
  }
  return result;
}
function exactObserved(tools: ObservedTool[], selected: ApprovedTool): NativeMcpToolSnapshot | null {
  const byName = tools.filter(tool => tool.name === selected.name), byReference = tools.filter(tool => tool.reference === selected.reference);
  const match = byName[0];
  return match && byName.length === 1 && byReference.length === 1 && match === byReference[0] ? match.snapshot : null;
}
function resolution(role: NativeMcpRole | null, snapshots: NativeMcpCapabilitySnapshot[],
  unavailable: { connector_id: string; reason: string }[], reason?: string): NativeMcpCapabilityResolution {
  snapshots.sort((a, b) => compare(a.connector_id, b.connector_id));
  unavailable.sort((a, b) => compare(a.connector_id, b.connector_id));
  const state: NativeMcpCapabilityResolution['state'] = reason ? 'unavailable' : !snapshots.length && !unavailable.length ? 'not-selected' :
    !snapshots.length ? 'unavailable' : unavailable.length ? 'partial' : 'ready';
  const body = { state, role, snapshots, unavailable, fallback: 'ordinary-work' as const, ...(reason ? { reason } : {}) };
  return freeze({ ...body, fingerprint: digest(canonical(body)) });
}

export function resolveNativeMcpCapabilities(approvedConnectors: unknown, actualInventory: unknown,
  options: { role: string; selectIds?: readonly string[] }): NativeMcpCapabilityResolution {
  try {
    if (!isRecord(options) || !fields(options, ['role', 'selectIds'])) return resolution(null, [], [], 'invalid-selection');
    const role = field(options, 'role'), selected = field(options, 'selectIds') ?? [];
    if (!roles.includes(role as NativeMcpRole) || !Array.isArray(selected) || selected.length > 128 ||
        new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !connectorId.test(id)))
      return resolution(null, [], [], 'invalid-selection');
    const policy = approvedPolicy(approvedConnectors);
    if (!policy) return resolution(role as NativeMcpRole, [], [], 'invalid-approved-connectors');
    const observed = inventory(actualInventory), snapshots: NativeMcpCapabilitySnapshot[] = [], unavailable: { connector_id: string; reason: string }[] = [];
    for (const id of selected) {
      const connector = policy.find(item => item.id === id);
      const reject = (reason: string) => unavailable.push({ connector_id: id, reason });
      if (!connector) { reject('connector-not-approved'); continue; }
      if (!connector.roles.includes(role as NativeMcpRole)) { reject('role-not-approved'); continue; }
      const tools = connector.tools.map(tool => exactObserved(observed, tool));
      if (tools.some(tool => !tool)) { reject('native-tool-unavailable'); continue; }
      const body = { connector_id: id, label: connector.label, tools: tools as NativeMcpToolSnapshot[],
        provenance: 'user-approved/exact-observed' as const, ownership: 'not-observed' as const };
      snapshots.push({ ...body, fingerprint: digest(canonical(body)) });
    }
    return resolution(role as NativeMcpRole, snapshots, unavailable);
  } catch { return resolution(null, [], [], 'native-inventory-unavailable'); }
}

/** Re-read lm.tools at admission/reconciliation. This checks registration and
 * schemas only; stable VS Code offers no event or ownership proof for all MCP
 * servers, and a registration still does not prove a successful invocation. */
export function nativeMcpCapabilitiesMatchInventory(snapshots: readonly NativeMcpCapabilitySnapshot[], actualInventory: unknown): boolean {
  try {
    if (!Array.isArray(snapshots)) return false;
    const observed = inventory(actualInventory), ids = new Set<string>();
    for (const snapshot of snapshots) {
      if (!isRecord(snapshot) || !fields(snapshot, ['connector_id', 'label', 'tools', 'fingerprint', 'provenance', 'ownership'])) return false;
      const id = field(snapshot, 'connector_id'), label = field(snapshot, 'label'), tools = field(snapshot, 'tools'),
        provenance = field(snapshot, 'provenance'), ownership = field(snapshot, 'ownership'), fingerprint = field(snapshot, 'fingerprint');
      const body = { connector_id: id, label, tools, provenance, ownership };
      if (typeof id !== 'string' || !connectorId.test(id) || ids.has(id) || typeof label !== 'string' || provenance !== 'user-approved/exact-observed' ||
          ownership !== 'not-observed' || fingerprint !== digest(canonical(body)) || !Array.isArray(tools) || !tools.length) return false;
      ids.add(id);
      for (const tool of tools) {
        if (!isRecord(tool) || !fields(tool, ['name', 'reference', 'schema_sha256', 'input_schema']) || !exactTool(tool.name) || !exactTool(tool.reference)) return false;
        if (tool.schema_sha256 !== digest(canonical(tool.input_schema))) return false;
        const current = exactObserved(observed, { name: tool.name, reference: tool.reference });
        if (!current || current.schema_sha256 !== tool.schema_sha256) return false;
      }
    }
    return true;
  } catch { return false; }
}
