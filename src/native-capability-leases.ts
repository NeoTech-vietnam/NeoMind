/** Host-owned capability pins. A pending control closes new admission, while
 * actual running holders retain their exact tool/skill baseline until a known
 * settled outcome. These are lifecycle records, never agent credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { safePath, withOperationLock } from './storage.js';

export interface NativeCapabilityOwner { request_ref: string; assignment_ref: string; generation: number | string }
export interface NativeCapabilityLeaseRef { id: string; owner_sha256: string }
export interface NativeCapabilitySkillPin {
  receipt_path: string; receipt_sha256: string; approval_sha256?: string;
  files: { path: string; sha256: string; bytes: number }[];
}
export interface NativeCapabilityResource { key: string; fingerprint: string; skill?: NativeCapabilitySkillPin }
export interface NativeCapabilityControlInput {
  key: string; action: 'enable' | 'disable' | 'remove' | 'connect' | 'disconnect';
  client?: string; target_sha256?: string;
  /** Generic native bindings do not own the similarly named provider/server. */
  origin?: 'native-binding';
}
export interface NativeCapabilityControl {
  state: 'apply-now' | 'deferred' | 'unchanged'; active_count: number;
  pending_action?: NativeCapabilityControlInput['action']; new_admissions: boolean;
}
interface QueuedControl extends NativeCapabilityControlInput {
  id: string; requested_at: string; holders: { id: string; fingerprint: string }[];
  async_operation?: { id: string; input_sha256: string };
}
export interface NativeCapabilityAsyncControlTicket {
  control_id: string; operation_id: string; root_sha256: string; input_sha256: string;
}
interface LeaseSnapshot extends NativeCapabilityLeaseRef {
  schema_version: 1; root_sha256: string; owner: NativeCapabilityOwner; resources: NativeCapabilityResource[];
  integrity: string;
}
interface Ledger {
  schema_version: 1; root_sha256: string;
  active: Record<string, { owner_sha256: string; resources: { key: string; fingerprint: string }[] }>;
  pending: QueuedControl[]; integrity: string;
}
interface ReleaseProof { schema_version: 1; root_sha256: string; id: string; owner_sha256: string; outcome_sha256: string; integrity: string }
interface AppliedProof { schema_version: 1; root_sha256: string; key: string; fingerprint: string; action: 'disable' | 'remove'; integrity: string }
export interface NativeCapabilityLeaseSkill extends NativeCapabilitySkillPin {
  receipt_base64: string;
  files: { path: string; sha256: string; bytes: number; content_base64: string }[];
  control?: { action: 'disable' | 'remove'; state: 'pending' | 'applied'; fingerprint: string };
}
const digest = /^[a-f0-9]{64}$/, identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const skillKey = /^skill:(workspace-skill-[a-f0-9]{64})$/;
const base = '.neomind/native/capability-leases';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => value === undefined ? 'null' : value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
function fail(code: string): never { throw new Error(code); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function seal<T extends object>(value: T): T & { integrity: string } { return { ...value, integrity: hash(stable(value)) }; }
function validSeal(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false;
  const { integrity, ...unsigned } = value;
  return typeof integrity === 'string' && digest.test(integrity) && integrity === hash(stable(unsigned));
}
function rootIdentity(root: string): string { return hash(realpathSync.native(resolve(root))); }
/** Reject in-root links too; safePath alone only prevents outside traversal. */
function ordinary(root: string, path: string, file = false): string {
  const target = safePath(root, path);
  for (let current = target; ; current = dirname(current)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current === target && file && (!stat.isFile() || stat.nlink !== 1)) ||
          (current !== target && !stat.isDirectory())) fail('CAPABILITY_UNSAFE_PATH');
    }
    if (dirname(current) === current) break;
  }
  return target;
}
function readBytes(root: string, path: string, limit: number): Buffer {
  const selected = ordinary(root, path, true), stat = lstatSync(selected);
  if (stat.size > limit) fail('CAPABILITY_BOUND_EXCEEDED');
  const bytes = readFileSync(selected);
  if (bytes.length !== stat.size || bytes.length > limit) fail('CAPABILITY_INPUT_CHANGED');
  return bytes;
}
function readJson(root: string, path: string, limit = 512 * 1024): unknown {
  try { return JSON.parse(readBytes(root, path, limit).toString('utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** Sync file data before atomic publication. Directory fsync is not portable on
 * Windows; a surviving index always references an already fsynced snapshot. */
function write(root: string, path: string, value: unknown, immutable = false): void {
  const selected = ordinary(root, path, true), bytes = Buffer.from(JSON.stringify(value) + '\n');
  mkdirSync(dirname(selected), { recursive: true });
  ordinary(root, path, true);
  if (immutable && existsSync(selected)) {
    if (!readFileSync(selected).equals(bytes)) fail('CAPABILITY_SNAPSHOT_CONFLICT');
    return;
  }
  const temporary = `${selected}.${randomUUID()}.tmp`, descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  try {
    if (immutable) {
      // The lifecycle lock serializes publication. No existing immutable file
      // is replaced, including when recovering an interrupted publication.
      if (existsSync(selected)) { if (!readFileSync(selected).equals(bytes)) fail('CAPABILITY_SNAPSHOT_CONFLICT'); }
      else renameSync(temporary, selected);
    } else renameSync(temporary, selected);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function readLedger(root: string): Ledger {
  const value = readJson(root, `${base}/index.json`);
  if (value === undefined) return seal({ schema_version: 1 as const, root_sha256: rootIdentity(root), active: {}, pending: [] });
  if (!validSeal(value) || value.schema_version !== 1 || value.root_sha256 !== rootIdentity(root) || !object(value.active) ||
      !Array.isArray(value.pending) || Object.keys(value.active).length > 128 || value.pending.length > 64) fail('CAPABILITY_LEDGER_INVALID');
  return value as unknown as Ledger;
}
function saveLedger(root: string, value: Ledger): void {
  const { integrity: _old, ...unsigned } = value;
  const sealed = seal(unsigned);
  if (Buffer.byteLength(JSON.stringify(sealed)) > 512 * 1024) fail('CAPABILITY_BOUND_EXCEEDED');
  write(root, `${base}/index.json`, sealed);
}
function key(value: string): void {
  if (typeof value !== 'string' || (!skillKey.test(value) && !/^mcp:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) &&
      !/^plugin:native-plugin-[a-f0-9]{64}$/.test(value))) fail('CAPABILITY_INVALID_RESOURCE');
}
function ownerHash(owner: NativeCapabilityOwner): string {
  if (!object(owner) || Object.keys(owner).some(name => !['request_ref', 'assignment_ref', 'generation'].includes(name)) ||
      !identifier.test(owner.request_ref) || !identifier.test(owner.assignment_ref) ||
      !(Number.isSafeInteger(owner.generation) && Number(owner.generation) >= 0 || typeof owner.generation === 'string' && identifier.test(owner.generation))) fail('LEASE_INVALID_OWNER');
  return hash(stable(owner));
}
const snapshotPath = (id: string) => `${base}/leases/${id}.json`;
const releasePath = (id: string) => `${base}/released/${id}.json`;
function assertRef(ref: NativeCapabilityLeaseRef): void {
  if (!object(ref) || typeof ref.id !== 'string' || !/^native-lease-[a-f0-9-]{36}$/.test(ref.id) || !digest.test(ref.owner_sha256)) fail('LEASE_INVALID_REF');
}
function snapshot(root: string, ref: NativeCapabilityLeaseRef, owner: NativeCapabilityOwner): LeaseSnapshot {
  assertRef(ref);
  const expected = ownerHash(owner);
  if (ref.owner_sha256 !== expected) fail('LEASE_OWNER_MISMATCH');
  const value = readJson(root, snapshotPath(ref.id));
  if (value === undefined) fail('LEASE_NOT_FOUND');
  if (!validSeal(value) || value.schema_version !== 1 || value.root_sha256 !== rootIdentity(root) || value.id !== ref.id ||
      value.owner_sha256 !== expected || stable(value.owner) !== stable(owner) || !Array.isArray(value.resources)) fail('LEASE_SNAPSHOT_INVALID');
  return value as unknown as LeaseSnapshot;
}
function released(root: string, lease: LeaseSnapshot): ReleaseProof | undefined {
  const value = readJson(root, releasePath(lease.id));
  if (value === undefined) return undefined;
  if (!validSeal(value) || value.schema_version !== 1 || value.root_sha256 !== lease.root_sha256 || value.id !== lease.id ||
      value.owner_sha256 !== lease.owner_sha256 || typeof value.outcome_sha256 !== 'string' || !digest.test(value.outcome_sha256)) fail('LEASE_RELEASE_INVALID');
  return value as unknown as ReleaseProof;
}
function holders(ledger: Ledger, resource: string) {
  return Object.entries(ledger.active).flatMap(([id, item]) => item.resources.filter(entry => entry.key === resource).map(entry => ({ id, fingerprint: entry.fingerprint })));
}
function controlStatus(ledger: Ledger, resource: string): NativeCapabilityControl {
  const pending = ledger.pending.find(item => item.key === resource);
  return { state: pending ? 'deferred' : 'unchanged', active_count: holders(ledger, resource).length,
    new_admissions: !pending, ...(pending ? { pending_action: pending.action as 'disable' | 'remove' | 'disconnect' } : {}) };
}
export function readNativeCapabilityControl(root: string, resource: string): NativeCapabilityControl {
  key(resource);
  // Legacy workspaces with no host leases need no snapshot, root-identity or
  // ancestor traversal merely to render a disabled/unselected status row.
  if (!existsSync(safePath(root, `${base}/index.json`))) return { state: 'unchanged', active_count: 0, new_admissions: true };
  return controlStatus(readLedger(root), resource);
}
function blob(root: string, bytes: Buffer): string {
  const digest = hash(bytes), path = `${base}/blobs/${digest}.json`;
  write(root, path, seal({ schema_version: 1, sha256: digest, bytes: bytes.length, content_base64: bytes.toString('base64') }), true);
  return digest;
}
function readBlob(root: string, digestValue: string, maximum: number): Buffer {
  if (!digest.test(digestValue)) fail('CAPABILITY_SNAPSHOT_INVALID');
  const value = readJson(root, `${base}/blobs/${digestValue}.json`, maximum * 2 + 1024);
  if (!validSeal(value) || value.sha256 !== digestValue || typeof value.content_base64 !== 'string') fail('CAPABILITY_SNAPSHOT_INVALID');
  const content = Buffer.from(value.content_base64, 'base64');
  if (content.length > maximum || content.length !== value.bytes || hash(content) !== digestValue || content.toString('base64') !== value.content_base64) fail('CAPABILITY_SNAPSHOT_INVALID');
  return content;
}
function approval(receipt: Record<string, unknown>): string {
  const files = receipt.files as { relative_path: string }[];
  if (!Array.isArray(files)) fail('CAPABILITY_SNAPSHOT_INVALID');
  return hash(stable({ schema_version: receipt.schema_version, kind: receipt.kind, source: receipt.source,
    target: receipt.target, target_name: receipt.target_name, files: [...files].sort((a, b) => a.relative_path.localeCompare(b.relative_path)),
    license: receipt.license, claims: receipt.claims }));
}
function pinSkill(root: string, resource: NativeCapabilityResource): NativeCapabilitySkillPin {
  const pin = resource.skill!, match = skillKey.exec(resource.key);
  if (!match || !object(pin) || typeof pin.receipt_path !== 'string' || !digest.test(pin.receipt_sha256) ||
      !Array.isArray(pin.files) || !pin.files.length || pin.files.length > 128) fail('CAPABILITY_INVALID_RESOURCE');
  const expectedReceipt = ordinary(root, `.neomind/capabilities/${match[1]}.json`, true);
  if (ordinary(root, pin.receipt_path, true) !== expectedReceipt) fail('CAPABILITY_INVALID_RESOURCE');
  const raw = readBytes(root, pin.receipt_path, 256 * 1024);
  if (hash(raw) !== pin.receipt_sha256) fail('CAPABILITY_INPUT_CHANGED');
  const receipt = JSON.parse(raw.toString('utf8'));
  if (!object(receipt) || receipt.id !== match[1] || receipt.state !== 'installed' || receipt.published !== true || receipt.pending_action !== undefined ||
      typeof receipt.target !== 'string' || !/^\.github\/skills\/[a-z0-9][a-z0-9-]{0,63}$/.test(receipt.target) ||
      approval(receipt) !== resource.fingerprint || pin.approval_sha256 !== undefined && pin.approval_sha256 !== resource.fingerprint) fail('CAPABILITY_INPUT_CHANGED');
  const expected = (receipt.files as { relative_path: string; sha256: string; bytes: number }[]).map(file => ({ path: `${receipt.target}/${file.relative_path}`, sha256: file.sha256, bytes: file.bytes }));
  const sorted = (files: typeof expected) => [...files].sort((a, b) => a.path.localeCompare(b.path));
  if (stable(sorted(pin.files)) !== stable(sorted(expected))) fail('CAPABILITY_INPUT_CHANGED');
  let total = 0;
  const files = pin.files.map(file => {
    if (!object(file) || typeof file.path !== 'string' || !file.path.startsWith(`${receipt.target}/`) ||
        !digest.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1024 * 1024 ||
        !file.path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:%?#\u0000-\u001f]/.test(part))) fail('CAPABILITY_INVALID_RESOURCE');
    const content = readBytes(root, file.path, 1024 * 1024);
    total += content.length;
    if (total > 8 * 1024 * 1024) fail('CAPABILITY_BOUND_EXCEEDED');
    if (content.length !== file.bytes || hash(content) !== file.sha256) fail('CAPABILITY_INPUT_CHANGED');
    blob(root, content);
    return { path: file.path, sha256: file.sha256, bytes: file.bytes };
  });
  blob(root, raw);
  return { receipt_path: pin.receipt_path, receipt_sha256: pin.receipt_sha256, approval_sha256: resource.fingerprint, files };
}
export function acquireNativeCapabilityLease(root: string, input: { owner: NativeCapabilityOwner; resources: readonly NativeCapabilityResource[] }): NativeCapabilityLeaseRef {
  const owner_sha256 = ownerHash(input.owner);
  if (!Array.isArray(input.resources) || input.resources.length > 64 || new Set(input.resources.map(item => item.key)).size !== input.resources.length) fail('CAPABILITY_INVALID_RESOURCE');
  let totalBytes = 0;
  for (const resource of input.resources as readonly NativeCapabilityResource[]) {
    if (resource.skill) {
      if (!Array.isArray(resource.skill.files)) fail('CAPABILITY_INVALID_RESOURCE');
      for (const file of resource.skill.files) {
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('CAPABILITY_INVALID_RESOURCE');
        totalBytes += file.bytes;
      }
    }
  }
  if (totalBytes > 8 * 1024 * 1024) fail('CAPABILITY_BOUND_EXCEEDED');
  return withOperationLock(root, 'native-capability-lifecycle', () => {
    const ledger = readLedger(root);
    if (Object.keys(ledger.active).length >= 128) fail('CAPABILITY_BOUND_EXCEEDED');
    const resources = input.resources.map(item => {
      key(item.key);
      if (!digest.test(item.fingerprint) || skillKey.test(item.key) !== !!item.skill) fail('CAPABILITY_INVALID_RESOURCE');
      if (!controlStatus(ledger, item.key).new_admissions) fail('CAPABILITY_DRAINING');
      if (holders(ledger, item.key).some(holder => holder.fingerprint !== item.fingerprint)) fail('CAPABILITY_BASELINE_IN_USE');
      return { key: item.key, fingerprint: item.fingerprint, ...(item.skill ? { skill: pinSkill(root, item) } : {}) };
    });
    const id = `native-lease-${randomUUID()}`, value = seal({ schema_version: 1 as const, root_sha256: ledger.root_sha256, id, owner_sha256, owner: input.owner, resources });
    if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) fail('CAPABILITY_BOUND_EXCEEDED');
    write(root, snapshotPath(id), value, true);
    ledger.active[id] = { owner_sha256, resources: resources.map(({ key, fingerprint }) => ({ key, fingerprint })) };
    saveLedger(root, ledger);
    return { id, owner_sha256 };
  });
}
export function assertNativeCapabilityLease(root: string, ref: NativeCapabilityLeaseRef, owner: NativeCapabilityOwner) {
  const value = snapshot(root, ref, owner), done = released(root, value), ledger = readLedger(root);
  if (!done && ledger.active[ref.id]?.owner_sha256 !== ref.owner_sha256) fail('LEASE_NOT_ACTIVE');
  return { ...value, state: done ? 'released' as const : 'active' as const };
}
export function releaseNativeCapabilityLease(root: string, ref: NativeCapabilityLeaseRef, owner: NativeCapabilityOwner, proof: { outcome_sha256: string }) {
  if (!object(proof) || Object.keys(proof).some(key => key !== 'outcome_sha256') || !digest.test(proof.outcome_sha256)) fail('LEASE_INVALID_RELEASE');
  return withOperationLock(root, 'native-capability-lifecycle', () => {
    const value = snapshot(root, ref, owner), previous = released(root, value), ledger = readLedger(root);
    if (previous && previous.outcome_sha256 !== proof.outcome_sha256) fail('LEASE_RELEASE_CONFLICT');
    if (!previous && ledger.active[ref.id]?.owner_sha256 !== ref.owner_sha256) fail('LEASE_NOT_ACTIVE');
    write(root, releasePath(ref.id), seal({ schema_version: 1, root_sha256: value.root_sha256, id: ref.id, owner_sha256: ref.owner_sha256, outcome_sha256: proof.outcome_sha256 }), true);
    delete ledger.active[ref.id]; saveLedger(root, ledger);
    return { released: !previous, ready_actions: ledger.pending.filter(item => !holders(ledger, item.key).length).map(item => ({ ...item })) };
  });
}
function validateControl(input: NativeCapabilityControlInput): void {
  key(input.key);
  if (!['enable', 'disable', 'remove', 'connect', 'disconnect'].includes(input.action) ||
      (input.action === 'connect' || input.action === 'disconnect') !== (typeof input.client === 'string') ||
      input.client !== undefined && !identifier.test(input.client) || input.target_sha256 !== undefined && !digest.test(input.target_sha256) ||
      skillKey.test(input.key) && ['connect', 'disconnect'].includes(input.action) ||
      input.origin !== undefined && (input.origin !== 'native-binding' || !input.key.startsWith('mcp:') || input.client !== undefined || input.target_sha256 !== undefined)) fail('CAPABILITY_INVALID_CONTROL');
}
function schedule(ledger: Ledger, input: NativeCapabilityControlInput): NativeCapabilityControl {
  if (input.action === 'enable' || input.action === 'connect') {
    if (ledger.pending.some(item => item.key === input.key && item.origin === input.origin && item.async_operation))
      return { ...controlStatus(ledger, input.key), state: 'deferred' };
    ledger.pending = ledger.pending.filter(item => item.key !== input.key || item.origin !== input.origin || (input.action === 'enable' ? !!item.client : item.client !== input.client));
    return { ...controlStatus(ledger, input.key), state: 'apply-now' };
  }
  const existing = ledger.pending.find(item => item.key === input.key && item.client === input.client && item.origin === input.origin);
  const active = holders(ledger, input.key);
  if (existing) {
    if (existing.async_operation) return { ...controlStatus(ledger, input.key), state: 'deferred' };
    // A later disable must not discard already-requested owned-registration
    // cleanup; the queued remove remains the operation the host must drain.
    if (existing.action === 'remove' && input.action === 'disable') return { ...controlStatus(ledger, input.key), state: 'deferred' };
    const upgrading = existing.action === 'disable' && input.action === 'remove';
    if (!upgrading && existing.target_sha256 !== input.target_sha256) fail('CAPABILITY_TARGET_CHANGED');
    if (upgrading) { existing.action = 'remove'; existing.target_sha256 = input.target_sha256; }
    return { ...controlStatus(ledger, input.key), state: active.length ? 'deferred' : 'apply-now' };
  }
  if (ledger.pending.length >= 64) fail('CAPABILITY_BOUND_EXCEEDED');
  ledger.pending.push({ ...input, id: randomUUID(), requested_at: new Date().toISOString(), holders: active });
  return { ...controlStatus(ledger, input.key), state: active.length ? 'deferred' : 'apply-now' };
}
export function requestNativeCapabilityControl(root: string, input: NativeCapabilityControlInput): NativeCapabilityControl {
  validateControl(input);
  return withOperationLock(root, 'native-capability-lifecycle', () => { const ledger = readLedger(root), result = schedule(ledger, input); saveLedger(root, ledger); return result; });
}
const controlIdentity = (input: NativeCapabilityControlInput) => ({ key: input.key, action: input.action,
  ...(input.client ? { client: input.client } : {}), ...(input.target_sha256 ? { target_sha256: input.target_sha256 } : {}), ...(input.origin ? { origin: input.origin } : {}) });
/** Reserve native host configuration work without holding a synchronous lock
 * across an await. An unknown operation remains an admission barrier until its
 * actual host state is reconciled; elapsed time and PID never settle it. */
export function beginNativeCapabilityAsyncControl(root: string, input: NativeCapabilityControlInput) {
  validateControl(input);
  return withOperationLock(root, 'native-capability-lifecycle', () => {
    const ledger = readLedger(root), control = schedule(ledger, input);
    let queued = ledger.pending.find(item => item.key === input.key && item.client === input.client && item.origin === input.origin);
    if (queued && (queued.async_operation || queued.action !== input.action) || control.state === 'deferred') {
      saveLedger(root, ledger); return { control: { ...controlStatus(ledger, input.key), state: 'deferred' as const } };
    }
    if (!queued) {
      if (ledger.pending.length >= 64) fail('CAPABILITY_BOUND_EXCEEDED');
      queued = { ...input, id: randomUUID(), requested_at: new Date().toISOString(), holders: holders(ledger, input.key) };
      ledger.pending.push(queued);
    }
    if (holders(ledger, input.key).length) {
      saveLedger(root, ledger); return { control: { ...controlStatus(ledger, input.key), state: 'deferred' as const } };
    }
    queued.async_operation = { id: randomUUID(), input_sha256: hash(stable(controlIdentity(input))) };
    saveLedger(root, ledger);
    const ticket: NativeCapabilityAsyncControlTicket = { control_id: queued.id, operation_id: queued.async_operation.id,
      root_sha256: ledger.root_sha256, input_sha256: queued.async_operation.input_sha256 };
    return { control: { ...controlStatus(ledger, input.key), state: 'apply-now' as const }, ticket };
  });
}
export function readNativeCapabilityPendingControls(root: string, prefix = '') {
  if (typeof prefix !== 'string' || !['', 'plugin:', 'mcp:', 'skill:'].includes(prefix)) fail('CAPABILITY_INVALID_RESOURCE');
  const ledger = readLedger(root);
  return ledger.pending.filter(item => item.key.startsWith(prefix)).map(item => ({ input: controlIdentity(item), active_count: holders(ledger, item.key).length,
    ...(item.async_operation ? { ticket: { control_id: item.id, operation_id: item.async_operation.id, root_sha256: ledger.root_sha256,
      input_sha256: item.async_operation.input_sha256 } satisfies NativeCapabilityAsyncControlTicket } : {}) }));
}
export function completeNativeCapabilityAsyncControl(root: string, ticket: NativeCapabilityAsyncControlTicket, proof: { observed_sha256: string }) {
  if (!object(ticket) || !/^[a-f0-9-]{36}$/.test(ticket.control_id) || !/^[a-f0-9-]{36}$/.test(ticket.operation_id) ||
      !digest.test(ticket.root_sha256) || !digest.test(ticket.input_sha256) || !object(proof) || !digest.test(proof.observed_sha256)) fail('CAPABILITY_ASYNC_CONTROL_INVALID');
  return withOperationLock(root, 'native-capability-lifecycle', () => {
    const ledger = readLedger(root);
    if (ticket.root_sha256 !== ledger.root_sha256) fail('CAPABILITY_ASYNC_CONTROL_ROOT');
    const path = `${base}/async-completed/${ticket.operation_id}.json`, expected = seal({ schema_version: 1, ticket, observed_sha256: proof.observed_sha256 });
    const previous = readJson(root, path);
    if (previous !== undefined && stable(previous) !== stable(expected)) fail('CAPABILITY_ASYNC_CONTROL_CONFLICT');
    const item = ledger.pending.find(item => item.id === ticket.control_id);
    if (item && (item.async_operation?.id !== ticket.operation_id || item.async_operation.input_sha256 !== ticket.input_sha256 ||
        hash(stable(controlIdentity(item))) !== ticket.input_sha256 || holders(ledger, item.key).length)) fail('CAPABILITY_ASYNC_CONTROL_STALE');
    if (!item && previous === undefined) fail('CAPABILITY_ASYNC_CONTROL_STALE');
    write(root, path, expected, true);
    ledger.pending = ledger.pending.filter(item => item.id !== ticket.control_id); saveLedger(root, ledger);
    return { completed: previous === undefined };
  });
}
const applying = new Map<string, NativeCapabilityControlInput>();
function appliedPath(resource: string, fingerprint: string) { return `${base}/applied/${hash(resource)}/${fingerprint}.json`; }
function recordAppliedSkill(root: string, input: NativeCapabilityControlInput): void {
  const match = skillKey.exec(input.key);
  if (!match || !['disable', 'remove'].includes(input.action)) return;
  const receipt = readJson(root, `.neomind/capabilities/${match[1]}.json`);
  if (!object(receipt) || receipt.state !== (input.action === 'disable' ? 'disabled' : 'removed') || receipt.published !== false || receipt.pending_action !== undefined ||
      !Array.isArray(receipt.retained_paths) || receipt.retained_paths.length) fail('CAPABILITY_CONTROL_INCOMPLETE');
  const fingerprint = approval(receipt);
  // Last legitimate lifecycle action for exactly this approved guidance.
  write(root, appliedPath(input.key, fingerprint), seal({ schema_version: 1, root_sha256: rootIdentity(root), key: input.key, fingerprint, action: input.action }));
}
/** Keep admission and the physical synchronous mutation in one critical section.
 * Never invoke an async callback or acquire this lock under native-dispatch. */
export function withNativeCapabilityControl<T>(root: string, input: NativeCapabilityControlInput, apply: () => T): { control: NativeCapabilityControl; value?: T } {
  validateControl(input);
  const selected = applying.get(rootIdentity(root));
  if (selected) {
    const groupedRemoval = selected.action === 'remove' && selected.key === input.key && selected.origin === undefined && input.origin === undefined &&
      (input.action === 'disable' && input.client === undefined || input.action === 'disconnect' && input.client !== undefined);
    if (stable(selected) !== stable(input) && !groupedRemoval) fail('CAPABILITY_CONTROL_REENTRANCY');
    const value = apply();
    if (value instanceof Promise) fail('CAPABILITY_ASYNC_MUTATION');
    return { control: { state: 'apply-now', active_count: 0, new_admissions: false }, value };
  }
  return withOperationLock(root, 'native-capability-lifecycle', () => {
    const ledger = readLedger(root), control = schedule(ledger, input); saveLedger(root, ledger);
    if (control.state === 'deferred') return { control };
    let value: T;
    applying.set(ledger.root_sha256, input);
    try { value = apply(); } finally { applying.delete(ledger.root_sha256); }
    if (value instanceof Promise) fail('CAPABILITY_ASYNC_MUTATION');
    try { recordAppliedSkill(root, input); }
    catch { return { control: { ...controlStatus(ledger, input.key), state: 'deferred' }, value }; }
    ledger.pending = ledger.pending.filter(item => !(item.key === input.key && item.client === input.client && item.origin === input.origin)); saveLedger(root, ledger);
    return { control: { ...controlStatus(ledger, input.key), state: 'apply-now' }, value };
  });
}
/** Hosts must not install/probe or replace a catalog beneath an active holder. */
export function assertNativeCapabilityMutable(root: string, resource: string): void {
  const control = readNativeCapabilityControl(root, resource);
  if (control.active_count || !control.new_admissions) fail('CAPABILITY_IN_USE');
}
export function drainNativeCapabilityControls(root: string, apply: (input: NativeCapabilityControlInput) => unknown): { key: string; action: string; state: 'applied' | 'pending' }[] {
  return withOperationLock(root, 'native-capability-lifecycle', () => {
    const ledger = readLedger(root), results: { key: string; action: string; state: 'applied' | 'pending' }[] = [];
    for (const item of [...ledger.pending]) {
      if (holders(ledger, item.key).length || item.async_operation || item.key.startsWith('plugin:')) continue;
      const input = { key: item.key, action: item.action, ...(item.client ? { client: item.client } : {}), ...(item.target_sha256 ? { target_sha256: item.target_sha256 } : {}),
        ...(item.origin ? { origin: item.origin } : {}) };
      try {
        applying.set(ledger.root_sha256, input);
        const outcome = apply(input);
        if (outcome instanceof Promise) fail('CAPABILITY_ASYNC_MUTATION');
        recordAppliedSkill(root, input);
        ledger.pending = ledger.pending.filter(entry => entry.id !== item.id); saveLedger(root, ledger);
        results.push({ key: item.key, action: item.action, state: 'applied' });
      } catch { results.push({ key: item.key, action: item.action, state: 'pending' }); }
      finally { applying.delete(ledger.root_sha256); }
    }
    return results;
  });
}
export function readNativeCapabilityLeaseSkill(root: string, ref: NativeCapabilityLeaseRef, owner: NativeCapabilityOwner, receiptId: string): NativeCapabilityLeaseSkill {
  const value = assertNativeCapabilityLease(root, ref, owner), resource = value.resources.find(item => item.key === `skill:${receiptId}`);
  if (!resource?.skill) fail('LEASE_SKILL_NOT_BOUND');
  const pin = resource.skill, receipt = readBlob(root, pin.receipt_sha256, 256 * 1024);
  const files = pin.files.map(file => {
    const content = readBlob(root, file.sha256, 1024 * 1024);
    if (content.length !== file.bytes) fail('CAPABILITY_SNAPSHOT_INVALID');
    return { ...file, content_base64: content.toString('base64') };
  });
  let control: NativeCapabilityLeaseSkill['control'];
  const applied = readJson(root, appliedPath(resource.key, resource.fingerprint));
  if (applied !== undefined) {
    if (!validSeal(applied) || applied.schema_version !== 1 || applied.root_sha256 !== value.root_sha256 || applied.key !== resource.key ||
        applied.fingerprint !== resource.fingerprint || !['disable', 'remove'].includes(String(applied.action))) fail('CAPABILITY_CONTROL_PROOF_INVALID');
    control = { action: applied.action as 'disable' | 'remove', state: 'applied', fingerprint: resource.fingerprint };
  } else {
    const pending = readLedger(root).pending.find(item => item.key === resource.key && item.holders.some(holder => holder.id === value.id && holder.fingerprint === resource.fingerprint));
    if (pending && ['disable', 'remove'].includes(pending.action)) control = { action: pending.action as 'disable' | 'remove', state: 'pending', fingerprint: resource.fingerprint };
  }
  return { ...pin, receipt_base64: receipt.toString('base64'), files, ...(control ? { control } : {}) };
}
