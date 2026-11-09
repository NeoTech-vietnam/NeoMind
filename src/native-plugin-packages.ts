/** Owned full Agent Plugins packages. Native VS Code reads the unchanged pinned
 * package through documented workspace registration; no private host cache or
 * global enablement database is read or edited here. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { AgentMarketplaceReader } from './agent-marketplace.js';
import { createGitHubAgentMarketplaceReader, type GitHubMarketplaceFetch } from './agent-marketplace-github.js';
import { atomicWrite, safePath, withOperationLock } from './storage.js';
import { readNativeCapabilityControl, type NativeCapabilityResource } from './native-capability-leases.js';

export interface NativePluginSourcePolicy {
  name: string; package: string; repository: string; commit: string; package_path: string;
  files: { path: string; sha256: string; bytes: number }[];
  license_path: string; allow_hooks?: boolean;
}
export const nativePluginPackageSourceJsonSchema = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['name', 'package', 'repository', 'commit', 'package_path', 'files', 'license_path'], properties: {
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }, package: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,99}$' },
    repository: { type: 'string', pattern: '^https://github\\.com/[a-z0-9_.-]+/[a-z0-9_.-]+$' },
    commit: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' }, package_path: { type: 'string', maxLength: 800 },
    license_path: { type: 'string', minLength: 1, maxLength: 800 }, allow_hooks: { type: 'boolean', default: false },
    files: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'object', additionalProperties: false, required: ['path', 'sha256', 'bytes'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 800 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 0, maximum: 1048576 } } } },
  } });
export function createNativePluginPackageSourceReader(sources: readonly NativePluginSourcePolicy[], fetch: GitHubMarketplaceFetch): AgentMarketplaceReader {
  return createGitHubAgentMarketplaceReader({ allowed_repositories: [...new Set(sources.map(source => source.repository))], fetch });
}
export interface NativePluginPackageReceipt {
  schema_version: 1; id: string; kind: 'owned-native-plugin-package'; root_sha256: string;
  name: string; version: string; approval_sha256: string;
  source: { kind: 'git'; repository: string; commit: string; path: string; policy_name: string } | { kind: 'local-fixture'; name: string };
  location: string; registration_key: string; files: { path: string; sha256: string; bytes: number }[];
  license: { path: string; sha256: string };
  components: { skills: { name: string; path: string }[]; agents: { name: string; path: string }[]; mcp_servers: string[] };
  state: 'staged' | 'registered' | 'disabled' | 'removed';
  history: { at: string; state: NativePluginPackageReceipt['state']; configuration_sha256?: string }[];
  cache_retained: true; registration: 'owned-workspace-plugin-location';
  loaded: 'not-observed'; used: 'not-observed'; verified: 'not-observed'; integrity: string;
}
const base = '.neomind/native/plugin-packages', digest = /^[a-f0-9]{64}$/, name = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const idPattern = /^native-plugin-[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function path(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 800 || /[\\:%?#\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') ||
      value.split('/').some(part => !part || part === '.' || part === '..' || part !== part.trim() || part.endsWith('.') ||
        /^(?:\.git|node_modules|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('NATIVE_PACKAGE_UNSAFE_PATH');
}
function ordinary(root: string, part: string, file = false): string {
  const selected = safePath(root, part);
  for (let current = selected; ; current = dirname(current)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current === selected && file && (!stat.isFile() || stat.nlink !== 1)) || current !== selected && !stat.isDirectory()) fail('NATIVE_PACKAGE_UNSAFE_PATH');
    }
    if (dirname(current) === current) break;
  }
  return selected;
}
const rootHash = (root: string) => sha(realpathSync.native(resolve(root)));
function sealed<T extends object>(value: T) { return { ...value, integrity: sha(stable(value)) }; }
function valid(value: unknown): value is NativePluginPackageReceipt {
  if (!object(value)) return false;
  const { integrity, ...unsigned } = value;
  return typeof integrity === 'string' && integrity === sha(stable(unsigned));
}
const receiptPath = (id: string) => { if (!idPattern.test(id)) fail('NATIVE_PACKAGE_INVALID_ID'); return `${base}/receipts/${id}.json`; };
function read(root: string, id: string): NativePluginPackageReceipt | undefined {
  const selected = ordinary(root, receiptPath(id), true);
  if (!existsSync(selected)) return undefined;
  if (lstatSync(selected).size > 512 * 1024) fail('NATIVE_PACKAGE_BOUNDS');
  const value: unknown = JSON.parse(readFileSync(selected, 'utf8'));
  if (!valid(value) || value.schema_version !== 1 || value.id !== id || value.kind !== 'owned-native-plugin-package' || value.root_sha256 !== rootHash(root) ||
      !name.test(value.name) || !digest.test(value.approval_sha256) || !Array.isArray(value.files) || !value.files.length || value.files.length > 256 ||
      !['staged', 'registered', 'disabled', 'removed'].includes(value.state) || !Array.isArray(value.history) || value.history.length > 1000 ||
      value.location !== relative(root, safePath(root, `${base}/assets/${id}`)).replaceAll('\\', '/') || value.registration_key !== `./${value.location}`)
    fail('NATIVE_PACKAGE_INVALID_RECEIPT');
  return value;
}
function save(root: string, receipt: NativePluginPackageReceipt): void {
  const { integrity: _old, ...unsigned } = receipt, value = sealed(unsigned);
  ordinary(root, receiptPath(receipt.id), true); atomicWrite(safePath(root, receiptPath(receipt.id)), JSON.stringify(value, null, 2) + '\n');
  Object.assign(receipt, value);
}
function header(content: Buffer): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content), body = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!body || body.length > 16 * 1024) fail('NATIVE_PACKAGE_COMPONENT_INVALID');
  const parsed = parseDocument(body, { uniqueKeys: true });
  if (parsed.errors.length) fail('NATIVE_PACKAGE_COMPONENT_INVALID');
  const value: unknown = parsed.toJS({ maxAliasCount: 0 });
  if (!object(value)) fail('NATIVE_PACKAGE_COMPONENT_INVALID'); return value;
}
function publish(root: string, source: NativePluginPackageReceipt['source'], contents: Map<string, Buffer>, licensePath: string, allowHooks: boolean) {
  const manifest = JSON.parse(contents.get('plugin.json')?.toString('utf8') ?? 'null');
  if (!object(manifest) || manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' || typeof manifest.name !== 'string' ||
      !name.test(manifest.name) || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) fail('NATIVE_PACKAGE_MANIFEST_INVALID');
  path(licensePath);
  const license = contents.get(licensePath);
  if (!license?.length || license.length > 64 * 1024) fail('NATIVE_PACKAGE_LICENSE_REQUIRED');
  if (!allowHooks && [...contents.keys()].some(file => /(?:^|\/)hooks(?:\/|\.)/.test(file))) fail('NATIVE_PACKAGE_HOOK_APPROVAL_REQUIRED');
  const components: NativePluginPackageReceipt['components'] = { skills: [], agents: [], mcp_servers: [] };
  for (const [file, bytes] of contents) {
    if (/^skills\/[^/]+\/SKILL\.md$/.test(file)) {
      const metadata = header(bytes), expected = file.split('/')[1];
      if (metadata.name !== expected || typeof metadata.description !== 'string' || !metadata.description.trim()) fail('NATIVE_PACKAGE_COMPONENT_INVALID');
      components.skills.push({ name: expected!, path: file });
    }
    if (/^com\.github\.copilot\/agents\/[^/]+\.md$/.test(file)) {
      const metadata = header(bytes);
      if (typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 160) fail('NATIVE_PACKAGE_COMPONENT_INVALID');
      components.agents.push({ name: metadata.name, path: file });
    }
  }
  if (contents.has('mcp.json')) {
    const mcp = JSON.parse(contents.get('mcp.json')!.toString('utf8'));
    if (!object(mcp) || mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' || !object(mcp.mcpServers) || Object.keys(mcp.mcpServers).some(id => !name.test(id))) fail('NATIVE_PACKAGE_MCP_INVALID');
    components.mcp_servers = Object.keys(mcp.mcpServers).sort();
  }
  if (!components.skills.length && !components.agents.length && !components.mcp_servers.length) fail('NATIVE_PACKAGE_COMPONENTS_REQUIRED');
  const files = [...contents].map(([path, content]) => ({ path, sha256: sha(content), bytes: content.length })).sort((a, b) => a.path.localeCompare(b.path));
  const approval_sha256 = sha(stable({ source, files, license_path: licensePath, allow_hooks: allowHooks })), id = `native-plugin-${approval_sha256}`;
  return withOperationLock(root, 'native-plugin-staging', () => {
    const previous = read(root, id);
    if (previous) { assertNativePluginPackageCurrent(root, previous); return previous; }
    const location = relative(root, safePath(root, `${base}/assets/${id}`)).replaceAll('\\', '/');
    if (existsSync(ordinary(root, location))) fail('NATIVE_PACKAGE_COLLISION');
    mkdirSync(safePath(root, location), { recursive: true });
    // The host has not registered this location. Partial publication is never
    // an install receipt or authority to adopt/delete later user content.
    for (const file of files) {
      const selected = ordinary(root, `${location}/${file.path}`, true); mkdirSync(dirname(selected), { recursive: true });
      ordinary(root, `${location}/${file.path}`, true); writeFileSync(selected, contents.get(file.path)!, { flag: 'wx' });
    }
    const receipt: NativePluginPackageReceipt = sealed({ schema_version: 1, id, kind: 'owned-native-plugin-package', root_sha256: rootHash(root),
      name: manifest.name as string, version: manifest.version as string, source, approval_sha256, location, registration_key: `./${location}`, files,
      license: { path: licensePath, sha256: sha(license) }, components, state: 'staged', history: [{ at: new Date().toISOString(), state: 'staged' }],
      cache_retained: true, registration: 'owned-workspace-plugin-location', loaded: 'not-observed', used: 'not-observed', verified: 'not-observed' });
    assertNativePluginPackageCurrent(root, receipt); save(root, receipt); return receipt;
  });
}
export function assertNativePluginPackageCurrent(root: string, receiptOrId: NativePluginPackageReceipt | string): void {
  try {
  const receipt = typeof receiptOrId === 'string' ? read(root, receiptOrId) : receiptOrId;
  if (!receipt || receipt.root_sha256 !== rootHash(root)) fail('NATIVE_PACKAGE_INVALID_RECEIPT');
  const expected = new Set(receipt.files.map(file => file.path)), directory = ordinary(root, receipt.location);
  const observed = readdirSync(directory, { recursive: true });
  if (observed.length > 2048) fail('NATIVE_PACKAGE_BOUNDS');
  for (const file of observed) {
    const part = String(file).replaceAll('\\', '/'), selected = ordinary(root, `${receipt.location}/${part}`);
    if (lstatSync(selected).isFile() && !expected.has(part)) fail('NATIVE_PACKAGE_CHANGED');
  }
  for (const file of receipt.files) {
    path(file.path);
    const selected = ordinary(root, `${receipt.location}/${file.path}`, true), bytes = readFileSync(selected);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) fail('NATIVE_PACKAGE_CHANGED');
  }
  } catch (error) {
    if ((error as { code?: string }).code === 'NATIVE_PACKAGE_INVALID_RECEIPT') throw error;
    throw Object.assign(new Error('NATIVE_PACKAGE_CHANGED', { cause: error }), { code: 'NATIVE_PACKAGE_CHANGED' });
  }
}
export function readNativePluginPackageMetadata(root: string) {
  const folder = ordinary(root, `${base}/receipts`);
  if (!existsSync(folder)) return [];
  const entries = readdirSync(folder).filter(name => /^native-plugin-[a-f0-9]{64}\.json$/.test(name));
  if (entries.length > 64) fail('NATIVE_PACKAGE_BOUNDS');
  return entries.sort().map(file => { const receipt = read(root, file.slice(0, -5))!;
    return { ...receipt, control: readNativeCapabilityControl(root, `plugin:${receipt.id}`) }; });
}
export function readNativePluginPackages(root: string) {
  return readNativePluginPackageMetadata(root).map(receipt => {
    let current = true; try { assertNativePluginPackageCurrent(root, receipt); } catch { current = false; }
    return { ...receipt, current };
  });
}
/** Production preparation reads every file through the existing qualified
 * pinned transport. Only host-approved policies supply source pins/hashes. */
export async function prepareNativePluginPackage(root: string, selection: { source: string; package: string }, options: {
  sources: readonly NativePluginSourcePolicy[]; reader: AgentMarketplaceReader; authorize: () => boolean; signal?: AbortSignal; timeout_ms?: number;
}) {
  const policy = options.sources.find(source => source.name === selection.source);
  if (!policy || !name.test(policy.name) || policy.package !== selection.package || !/^https:\/\/[a-z0-9.-]+\/[a-z0-9._/-]+$/i.test(policy.repository) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(policy.commit) ||
      !name.test(selection.package) || !Array.isArray(policy.files) || !policy.files.length || policy.files.length > 256) fail('NATIVE_PACKAGE_SOURCE_NOT_APPROVED');
  if (policy.package_path) path(policy.package_path);
  const authorize = () => { if (options.signal?.aborted) fail('NATIVE_PACKAGE_CANCELLED'); if (options.authorize() !== true) fail('NATIVE_PACKAGE_POLICY_CHANGED'); };
  authorize();
  const source = { kind: 'git' as const, repository: policy.repository, commit: policy.commit, path: policy.package_path, policy_name: policy.name };
  const expectedFiles = [...policy.files].sort((a, b) => a.path.localeCompare(b.path));
  const expectedApproval = sha(stable({ source, files: expectedFiles, license_path: policy.license_path, allow_hooks: policy.allow_hooks === true }));
  const cached = readNativePluginPackageMetadata(root).find(receipt => receipt.name === selection.package && receipt.approval_sha256 === expectedApproval);
  if (cached) { assertNativePluginPackageCurrent(root, cached.id); const { control: _control, ...receipt } = cached; return receipt; }
  const timeout = options.timeout_ms ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30000) fail('NATIVE_PACKAGE_BOUNDS');
  const contents = new Map<string, Buffer>(), folded = new Set<string>(), controller = new AbortController(), stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  const stopped = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () =>
    reject(Object.assign(new Error(options.signal?.aborted ? 'NATIVE_PACKAGE_CANCELLED' : 'NATIVE_PACKAGE_TIMEOUT'),
      { code: options.signal?.aborted ? 'NATIVE_PACKAGE_CANCELLED' : 'NATIVE_PACKAGE_TIMEOUT' })), { once: true }));
  const timer = setTimeout(() => controller.abort(), timeout); let total = 0;
  try {
    for (const file of policy.files) {
      authorize(); path(file.path);
      if (!digest.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1024 * 1024 || folded.has(file.path.toLowerCase())) fail('NATIVE_PACKAGE_SOURCE_NOT_APPROVED');
      folded.add(file.path.toLowerCase());
      const sourcePath = policy.package_path ? `${policy.package_path}/${file.path}` : file.path;
      const result = await Promise.race([options.reader({ repository: policy.repository, commit: policy.commit, path: sourcePath, max_bytes: 1024 * 1024, signal: controller.signal }), stopped]);
      authorize(); if (controller.signal.aborted) fail('NATIVE_PACKAGE_TIMEOUT');
      if (result.repository !== policy.repository || result.commit !== policy.commit || result.path !== sourcePath || result.kind !== 'file' || result.complete !== true) fail('NATIVE_PACKAGE_SOURCE_PIN_MISMATCH');
      const bytes = Buffer.from(result.content); total += bytes.length;
      if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) fail('NATIVE_PACKAGE_SOURCE_PIN_MISMATCH');
      if (total > 8 * 1024 * 1024) fail('NATIVE_PACKAGE_BOUNDS'); contents.set(file.path, bytes);
    }
    authorize();
    const manifest = JSON.parse(contents.get('plugin.json')?.toString('utf8') ?? 'null');
    if (manifest?.name !== selection.package) fail('NATIVE_PACKAGE_MANIFEST_INVALID');
    return publish(root, source, contents, policy.license_path, policy.allow_hooks === true);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
}
/** Explicit local fixture seam. Never claims a GitHub commit or exposes itself
 * as a model tool. The caller supplies the independently computed tree pin. */
export function prepareNativePluginPackageFixture(root: string, directory: string, expectedTreeSha256: string, options: { allow_fixture: true }) {
  if (options?.allow_fixture !== true || !digest.test(expectedTreeSha256)) fail('NATIVE_PACKAGE_FIXTURE_NOT_APPROVED');
  const folder = realpathSync.native(directory), contents = new Map<string, Buffer>(); let total = 0;
  for (const entry of readdirSync(folder, { recursive: true }).sort()) {
    const file = String(entry).replaceAll('\\', '/'); path(file);
    const selected = ordinary(folder, file), stat = lstatSync(selected);
    if (stat.isDirectory()) continue;
    const bytes = readFileSync(ordinary(folder, file, true)); total += bytes.length;
    if (bytes.length > 1024 * 1024 || total > 8 * 1024 * 1024 || contents.size >= 256) fail('NATIVE_PACKAGE_BOUNDS'); contents.set(file, bytes);
  }
  const inventory = [...contents].map(([path, bytes]) => ({ path, sha256: sha(bytes), bytes: bytes.length })).sort((a, b) => a.path.localeCompare(b.path));
  if (sha(stable(inventory)) !== expectedTreeSha256) fail('NATIVE_PACKAGE_SOURCE_PIN_MISMATCH');
  return publish(root, { kind: 'local-fixture', name: 'explicitly-approved-native-package-fixture' }, contents, 'LICENSE', false);
}
export function recordNativePluginPackageRegistration(root: string, id: string, state: 'registered' | 'disabled' | 'removed', proof: { configuration_sha256: string }) {
  if (!['registered', 'disabled', 'removed'].includes(state) || !digest.test(proof.configuration_sha256)) fail('NATIVE_PACKAGE_REGISTRATION_INVALID');
  return withOperationLock(root, 'native-plugin-staging', () => {
    const receipt = read(root, id); if (!receipt) fail('NATIVE_PACKAGE_NOT_FOUND');
    if (state === 'registered') assertNativePluginPackageCurrent(root, receipt);
    if (receipt.history.length >= 1000) fail('NATIVE_PACKAGE_BOUNDS');
    if (receipt.state !== state || receipt.history.at(-1)?.configuration_sha256 !== proof.configuration_sha256) {
      receipt.state = state; receipt.history.push({ at: new Date().toISOString(), state, ...proof }); save(root, receipt);
    }
    return receipt;
  });
}
export function resolveNativePluginPackageResources(root: string, names: readonly string[]): { resources: NativeCapabilityResource[]; packages: NativePluginPackageReceipt[]; unavailable: string[] } {
  if (!Array.isArray(names) || names.length > 8 || new Set(names).size !== names.length || names.some(item => !name.test(item))) fail('NATIVE_PACKAGE_SELECTION_INVALID');
  const rows = readNativePluginPackageMetadata(root), packages: NativePluginPackageReceipt[] = [], unavailable: string[] = [];
  for (const selected of names) {
    const exact = rows.filter(row => row.name === selected && row.state === 'registered' && row.control.new_admissions);
    if (exact.length !== 1) unavailable.push(selected); else {
      const { control: _control, ...receipt } = exact[0]!;
      try { assertNativePluginPackageCurrent(root, receipt); packages.push(receipt); } catch { unavailable.push(selected); }
    }
  }
  return { packages, unavailable, resources: packages.map(item => ({ key: `plugin:${item.id}`, fingerprint: item.approval_sha256 })) };
}
