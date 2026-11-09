/** Explicit workspace-local portable skill selection. This does not install a
 * whole plugin, grant tool permissions, execute content, or prove host loading.
 * Containment checks protect ordinary filesystem operations, not an OS sandbox. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { AgentMarketplaceReader } from './agent-marketplace.js';
import { assertNoStorageMigration, resolveManagedRoot } from './storage.js';

export interface WorkspaceSkillApproval {
  approved: true;
  repository: string;
  commit: string;
  license_path: string;
  skills: { source_path: string; target_name: string; files: string[] }[];
}
export interface WorkspaceSkillOptions { signal?: AbortSignal; timeout_ms?: number; authorize?: () => boolean }
type State = 'selected' | 'installed' | 'disabled' | 'removed' | 'partial' | 'conflict';
type Code = 'INVALID_APPROVAL' | 'INVALID_QUERY' | 'UNSAFE_PATH' | 'BOUND_EXCEEDED' | 'READ_FAILED' | 'READ_INCOMPLETE' |
  'SOURCE_PIN_MISMATCH' | 'INVALID_SKILL' | 'COLLISION' | 'LOCAL_CHANGED' | 'INVALID_RECEIPT' |
  'CANCELLED' | 'TIMEOUT' | 'FILESYSTEM_FAILED' | 'POLICY_CHANGED';
export class WorkspaceSkillError extends Error {
  readonly code: Code;
  constructor(code: Code) { super(`Workspace skill selection failed: ${code}.`); this.name = 'WorkspaceSkillError'; this.code = code; }
}
function fail(code: Code): never { throw new WorkspaceSkillError(code); }
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bytesLimit = 1024 * 1024, totalLimit = 8 * 1024 * 1024, receiptLimit = 256 * 1024;
const hostRoot = '.github/skills';
interface OwnedFile { source_path: string; relative_path: string; sha256: string; bytes: number }
export interface WorkspaceSkillReceipt {
  schema_version: 1;
  id: string;
  kind: 'selected-workspace-skill-component';
  source: { repository: string; commit: string; path: string };
  target: string;
  target_name: string;
  state: State;
  published: boolean;
  pending_action?: 'disable' | 'remove';
  files: OwnedFile[];
  license: { source_path: string; sha256: string; bytes: number; text: string };
  retained_paths: { path: string; reason: 'changed' | 'unowned-content' | 'unsafe' }[];
  history: { at: string; action: string; state: State }[];
  claims: { selection: 'exact-files-only'; package_completeness: 'not-established';
    plugin_installation: 'not-performed'; host_loading: 'unverified'; execution: 'not-performed' };
  integrity: string;
}
export interface WorkspaceSkillResult {
  components: WorkspaceSkillReceipt[];
  changed: boolean;
  installation_scope: 'workspace-skill-components-only';
  plugin_installation: 'not-performed'; host_loading: 'unverified'; execution: 'not-performed';
}
interface Prepared { receipt: WorkspaceSkillReceipt; contents: Map<string, Uint8Array> }
type LocalPath = { path: string; exists: boolean; directory: boolean };
type PathLookup = (root: string, path: string) => LocalPath;
export interface WorkspaceSkillQuery {
  request?: string; limit?: number;
  /** Exact canonical host name, filtered before inspecting assets or ranking. */
  exact_name?: string;
}
export interface WorkspaceSkillCandidate {
  id: string; name: string; description: string | null; description_truncated: boolean;
  source: WorkspaceSkillReceipt['source']; skill_path: string; skill_sha256: string;
  recorded_state: State; state: State; available: boolean;
  files: { count: number; bytes: number; state: 'current' | 'absent' | 'changed' | 'incomplete' | 'unsafe' | 'not-inspected' };
  receipt: { path: string; sha256: string }; license: { source_path: string; sha256: string };
  observations: { loaded: 'not-observed'; used: 'not-observed'; verified: 'not-observed' };
}
export interface WorkspaceSkillList {
  state: 'absent' | 'available' | 'partial' | 'unavailable'; components: WorkspaceSkillCandidate[];
  issues: { id?: string; code: 'INVALID_RECEIPT' | 'LOCAL_CHANGED' | 'MISSING_FILES' | 'UNSAFE_PATH' | 'BOUND_EXCEEDED' | 'READ_FAILED' | 'INVALID_SKILL' }[];
  results_truncated: boolean; fallback: 'ordinary-work'; authorization: 'not-granted'; execution: 'not-performed';
}

function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 800 ||
      /[\\:%?#\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) || value.startsWith('/')) fail('UNSAFE_PATH');
  for (const part of value.split('/')) if (!part || part === '.' || part === '..' || part !== part.trim() || part.endsWith('.') ||
    ['.git', '.workforce', '.neomind', '.verythinker', '.taskforces'].includes(part.toLowerCase()) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail('UNSAFE_PATH');
  return value;
}
function repository(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500 || /[\s\\@%?#]/.test(value)) fail('INVALID_APPROVAL');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname ||
      value !== url.origin + url.pathname || value.endsWith('/') || url.pathname.split('/').slice(1).some(part =>
        !part || part === '.' || part === '..' || !/^[a-z0-9._-]+$/i.test(part))) fail('INVALID_APPROVAL');
  } catch { return fail('INVALID_APPROVAL'); }
  return value;
}
function selection(value: WorkspaceSkillApproval): WorkspaceSkillApproval {
  if (!object(value) || value.approved !== true || typeof value.commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.commit) ||
      !Array.isArray(value.skills) || !value.skills.length || value.skills.length > 8) fail('INVALID_APPROVAL');
  const repo = repository(value.repository), license = relativePath(value.license_path), names = new Set<string>();
  let fileCount = 0;
  const skills = value.skills.map(skill => {
    if (!object(skill) || typeof skill.target_name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.target_name) ||
      names.has(skill.target_name) || !Array.isArray(skill.files) || !skill.files.length || skill.files.length > 128) fail('INVALID_APPROVAL');
    names.add(skill.target_name);
    const root = relativePath(skill.source_path), seen = new Set<string>();
    const files = skill.files.map(value => {
      const file = relativePath(value);
      if (!file.startsWith(root + '/') || seen.has(file.toLowerCase())) fail('INVALID_APPROVAL');
      seen.add(file.toLowerCase());
      return file;
    }).sort();
    if (!files.includes(root + '/SKILL.md')) fail('INVALID_SKILL');
    if (files.some(file => files.some(other => other !== file && other.toLowerCase().startsWith(file.toLowerCase() + '/')))) fail('INVALID_APPROVAL');
    fileCount += files.length;
    return { source_path: root, target_name: skill.target_name, files };
  });
  if (fileCount > 256) fail('BOUND_EXCEEDED');
  return { approved: true, repository: repo, commit: value.commit, license_path: license, skills };
}
function identity(source: WorkspaceSkillReceipt['source'], name: string): string {
  return 'workspace-skill-' + hash(JSON.stringify({ source, target_name: name }));
}
function metadataRoot(root: string, lookup: PathLookup = local): string {
  try {
    assertNoStorageMigration(root);
    const physical = resolveManagedRoot(root), found = lookup(root, physical);
    if (found.exists && !found.directory) fail('UNSAFE_PATH');
    const metadata = `${physical}/capabilities`, directory = lookup(root, metadata);
    if (directory.exists && !directory.directory) fail('UNSAFE_PATH');
    return metadata;
  } catch (error) { if (error instanceof WorkspaceSkillError) throw error; return fail('UNSAFE_PATH'); }
}
const receiptPath = (root: string, id: string, lookup: PathLookup = local) => `${metadataRoot(root, lookup)}/${id}.json`;
function workspace(value: string): string {
  if (typeof value !== 'string' || !value) fail('UNSAFE_PATH');
  const root = resolve(value);
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('UNSAFE_PATH');
    const actual = realpathSync.native(root);
    if ((process.platform === 'win32' ? actual.toLowerCase() !== root.toLowerCase() : actual !== root)) fail('UNSAFE_PATH');
  } catch (error) { if (error instanceof WorkspaceSkillError) throw error; return fail('UNSAFE_PATH'); }
  return root;
}
/** Private relative paths are generated internally. Never pass source paths here. */
function local(root: string, path: string, budget?: { remaining: number; directory_limit?: number }): LocalPath {
  let current = root;
  for (const [index, part] of path.split('/').entries()) {
    const last = index === path.split('/').length - 1;
    try {
      if (budget) {
        const directory = opendirSync(current); let entries = 0;
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (++entries > (budget.directory_limit ?? 256) || --budget.remaining < 0) fail('BOUND_EXCEEDED');
            if (entry.name !== part && entry.name.toLowerCase() === part.toLowerCase()) fail('COLLISION');
          }
        } finally { directory.closeSync(); }
      } else if (readdirSync(current).some(name => name !== part && name.toLowerCase() === part.toLowerCase())) fail('COLLISION');
      current = resolve(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) || (last && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail('UNSAFE_PATH');
      if (last) return { path: current, exists: true, directory: stat.isDirectory() };
    } catch (error) {
      if (error instanceof WorkspaceSkillError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('FILESYSTEM_FAILED');
      return { path: resolve(root, ...path.split('/')), exists: false, directory: false };
    }
  }
  return fail('UNSAFE_PATH');
}
function ensureDirectory(root: string, path: string) {
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const selected = parts.slice(0, index).join('/'), found = local(root, selected);
    if (found.exists && !found.directory) fail('COLLISION');
    if (!found.exists) mkdirSync(found.path);
  }
}
const unsigned = (receipt: WorkspaceSkillReceipt) => { const { integrity: _integrity, ...body } = receipt; return body; };
function seal(receipt: WorkspaceSkillReceipt): WorkspaceSkillReceipt { return { ...receipt, integrity: hash(JSON.stringify(unsigned(receipt))) }; }
function save(root: string, receipt: WorkspaceSkillReceipt) {
  const metadata = metadataRoot(root);
  ensureDirectory(root, metadata);
  const target = local(root, receiptPath(root, receipt.id));
  if (target.directory) fail('COLLISION');
  const next = seal(receipt), body = JSON.stringify(next, null, 2) + '\n';
  if (Buffer.byteLength(body) > receiptLimit) fail('BOUND_EXCEEDED');
  const previous = receiptBytes(root, receiptPath(root, receipt.id));
  if (previous) {
    decodeReceipt(previous, receipt.id);
    if (!previous.equals(Buffer.from(body))) archiveReceipt(root, receipt.id, previous);
  }
  const temporaryPath = `${metadata}/${receipt.id}-${randomUUID()}.tmp`, temporary = local(root, temporaryPath);
  try {
    writeFileSync(temporary.path, body, { flag: 'wx' });
    const current = receiptBytes(root, receiptPath(root, receipt.id));
    if (previous ? !current?.equals(previous) : current !== undefined) fail('LOCAL_CHANGED');
    local(root, receiptPath(root, receipt.id)); renameSync(temporary.path, target.path);
  }
  finally { try { const remaining = local(root, temporaryPath); if (remaining.exists) unlinkSync(remaining.path); } catch { /* Never mask the durable operation error. */ } }
  Object.assign(receipt, next);
}
function load(root: string, id: string, observe?: (bytes: Buffer) => void, lookup: PathLookup = local): WorkspaceSkillReceipt | undefined {
  if (!/^workspace-skill-[a-f0-9]{64}$/.test(id)) fail('INVALID_RECEIPT');
  const bytes = receiptBytes(root, receiptPath(root, id, lookup), lookup);
  if (!bytes) return undefined;
  observe?.(bytes);
  return decodeReceipt(bytes, id);
}
function receiptBytes(root: string, path: string, lookup: PathLookup = local): Buffer | undefined {
  const found = lookup(root, path);
  if (!found.exists) return undefined;
  let bytes: Buffer;
  try {
    if (found.directory || lstatSync(found.path).size > receiptLimit) fail('INVALID_RECEIPT');
    bytes = readFileSync(found.path);
  } catch (error) { if (error instanceof WorkspaceSkillError) throw error; return fail('INVALID_RECEIPT'); }
  if (bytes.length > receiptLimit) fail('INVALID_RECEIPT');
  return bytes;
}
function decodeReceipt(bytes: Buffer, id: string): WorkspaceSkillReceipt {
  if (!/^workspace-skill-[a-f0-9]{64}$/.test(id) || bytes.length > receiptLimit) fail('INVALID_RECEIPT');
  let value: WorkspaceSkillReceipt;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return fail('INVALID_RECEIPT'); }
  try {
    if (!object(value) || value.schema_version !== 1 || value.id !== id || value.kind !== 'selected-workspace-skill-component' ||
      !object(value.source) || repository(value.source.repository) !== value.source.repository ||
      typeof value.source.commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.source.commit) ||
      relativePath(value.source.path) !== value.source.path ||
      typeof value.target_name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.target_name) || value.target !== `${hostRoot}/${value.target_name}` ||
      identity(value.source, value.target_name) !== id || !Array.isArray(value.files) || !value.files.length || value.files.length > 128 ||
      typeof value.published !== 'boolean' || (value.state === 'installed' && !value.published) ||
      (value.pending_action !== undefined && !['disable', 'remove'].includes(value.pending_action)) ||
      !['selected', 'installed', 'disabled', 'removed', 'partial', 'conflict'].includes(value.state) ||
      !Array.isArray(value.history) || value.history.length > 1000 || !Array.isArray(value.retained_paths) ||
      !object(value.claims) || value.claims.selection !== 'exact-files-only' || value.claims.package_completeness !== 'not-established' ||
      value.claims.plugin_installation !== 'not-performed' || value.claims.host_loading !== 'unverified' || value.claims.execution !== 'not-performed' ||
      value.integrity !== hash(JSON.stringify(unsigned(value)))) fail('INVALID_RECEIPT');
    const seen = new Set<string>();
    for (const file of value.files) {
      if (!object(file) || relativePath(file.relative_path) !== file.relative_path ||
        file.source_path !== `${value.source.path}/${file.relative_path}` || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > bytesLimit || seen.has(file.relative_path.toLowerCase())) fail('INVALID_RECEIPT');
      seen.add(file.relative_path.toLowerCase());
    }
    if (!seen.has('skill.md') || !object(value.license) || relativePath(value.license.source_path) !== value.license.source_path ||
      typeof value.license.text !== 'string' || Buffer.byteLength(value.license.text) !== value.license.bytes ||
      value.license.bytes > 64 * 1024 || hash(value.license.text) !== value.license.sha256) fail('INVALID_RECEIPT');
  } catch { return fail('INVALID_RECEIPT'); }
  return value;
}

const snapshotDirectory = (root: string, id: string, digest: string, lookup: PathLookup = local) =>
  `${metadataRoot(root, lookup)}/receipt-snapshots/${id}/${digest}`;
/** Exact immutable receipt provenance, not current installation/host-use authority.
 * Older raw pins are bridged only when their actual original bytes were retained. */
export function readWorkspaceSkillReceiptSnapshot(rootPath: string, id: string, expectedSha: string): WorkspaceSkillReceipt | undefined {
  if (typeof id !== 'string' || !/^workspace-skill-[a-f0-9]{64}$/.test(id) || typeof expectedSha !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha))
    fail('INVALID_RECEIPT');
  const root = workspace(rootPath), budget = { remaining: 8192, directory_limit: 1024 };
  const lookup: PathLookup = (base, path) => local(base, path, budget);
  const current = receiptBytes(root, receiptPath(root, id, lookup), lookup);
  if (current && hash(current) === expectedSha) return decodeReceipt(current, id);
  const archived = receiptBytes(root, `${snapshotDirectory(root, id, expectedSha, lookup)}/receipt.json`, lookup);
  if (!archived) return undefined;
  if (hash(archived) !== expectedSha) fail('INVALID_RECEIPT');
  return decodeReceipt(archived, id);
}

/** Publish an fsynced ordinary file by renaming a nonempty directory. A racing
 * existing snapshot cannot be overwritten as an ordinary file rename could. */
function archiveReceipt(root: string, id: string, bytes: Buffer): void {
  const digest = hash(bytes), destination = snapshotDirectory(root, id, digest);
  const matches = () => {
    const archived = receiptBytes(root, `${destination}/receipt.json`);
    if (!archived || !archived.equals(bytes)) fail('INVALID_RECEIPT');
    decodeReceipt(archived, id);
  };
  const existing = local(root, destination);
  if (existing.exists) { if (!existing.directory) fail('INVALID_RECEIPT'); matches(); return; }
  const parent = destination.split('/').slice(0, -1).join('/'); ensureDirectory(root, parent);
  const stage = `${parent}/${digest}-${randomUUID()}.tmp`; ensureDirectory(root, stage);
  try {
    const file = local(root, `${stage}/receipt.json`);
    if (file.exists) fail('COLLISION');
    const descriptor = openSync(file.path, 'wx');
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    try { renameSync(local(root, stage).path, local(root, destination).path); }
    catch (error) { if (!local(root, destination).exists) throw error; matches(); }
    matches();
  } finally {
    // Clean only our exact unchanged staging file, never unknown/user content.
    try {
      const file = local(root, `${stage}/receipt.json`);
      if (file.exists && !file.directory && readFileSync(file.path).equals(bytes)) unlinkSync(file.path);
      const directory = local(root, stage); if (directory.exists && directory.directory) rmdirSync(directory.path);
    } catch { /* Retained partial staging is not installation or snapshot proof. */ }
  }
}
function event(receipt: WorkspaceSkillReceipt, action: string, state: State) {
  if (receipt.history.length >= 1000) fail('BOUND_EXCEEDED');
  receipt.state = state; receipt.history.push({ at: new Date().toISOString(), action, state });
}
function current(root: string, receipt: WorkspaceSkillReceipt): boolean {
  for (const file of receipt.files) {
    const found = local(root, `${receipt.target}/${file.relative_path}`);
    if (!found.exists || found.directory || lstatSync(found.path).size !== file.bytes || hash(readFileSync(found.path)) !== file.sha256) return false;
  }
  return true;
}
function cleanStage(root: string, stage: string, files: OwnedFile[]): WorkspaceSkillReceipt['retained_paths'] {
  const retained: WorkspaceSkillReceipt['retained_paths'] = [], directories = new Set<string>([stage]);
  for (const file of files) {
    const selected = `${stage}/${file.relative_path}`, parts = file.relative_path.split('/');
    for (let index = 1; index < parts.length; index++) directories.add(`${stage}/${parts.slice(0, index).join('/')}`);
    try {
      const found = local(root, selected);
      if (!found.exists) continue;
      if (found.directory || lstatSync(found.path).size !== file.bytes || hash(readFileSync(found.path)) !== file.sha256)
        retained.push({ path: selected, reason: 'changed' });
      else unlinkSync(found.path);
    } catch { retained.push({ path: selected, reason: 'unsafe' }); }
  }
  for (const path of [...directories].sort((a, b) => b.length - a.length)) {
    try { const found = local(root, path); if (found.exists && found.directory) rmdirSync(found.path); }
    catch { if (path === stage && !retained.length) retained.push({ path, reason: 'unowned-content' }); }
  }
  return retained;
}
function skillMetadata(bytes: Uint8Array, expected: string): { name: string; description: string; description_truncated: boolean } {
  let body: string;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('INVALID_SKILL'); }
  const header = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header || header.length > 16 * 1024) fail('INVALID_SKILL');
  try {
    const document = parseDocument(header, { uniqueKeys: true });
    if (document.errors.length) fail('INVALID_SKILL');
    const value = document.toJS({ maxAliasCount: 0 });
    if (!object(value) || value.name !== expected || typeof value.description !== 'string' || !value.description.trim()) fail('INVALID_SKILL');
    const description = value.description.trim();
    return { name: expected, description: description.slice(0, 600), description_truncated: description.length > 600 };
  } catch { return fail('INVALID_SKILL'); }
}
async function prepare(approval: WorkspaceSkillApproval, reader: AgentMarketplaceReader, signal: AbortSignal): Promise<Prepared[]> {
  let total = 0;
  const read = async (path: string, limit: number) => {
    if (signal.aborted) fail('CANCELLED');
    let file;
    try { file = await reader({ repository: approval.repository, commit: approval.commit, path, max_bytes: limit, signal }); }
    catch { return fail('READ_FAILED'); }
    if (signal.aborted) fail('CANCELLED');
    if (!object(file) || file.repository !== approval.repository || file.commit !== approval.commit || file.path !== path) fail('SOURCE_PIN_MISMATCH');
    if (file.kind !== 'file' || file.complete !== true) fail('READ_INCOMPLETE');
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) fail('READ_INCOMPLETE');
    const length = typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength;
    if (length > limit || total + length > totalLimit) fail('BOUND_EXCEEDED');
    const bytes = Buffer.from(file.content); total += length;
    return bytes;
  };
  const licenseBytes = await read(approval.license_path, 64 * 1024);
  let licenseText: string;
  try { licenseText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(licenseBytes); } catch { return fail('READ_INCOMPLETE'); }
  if (!licenseText.trim()) fail('READ_INCOMPLETE');
  const prepared: Prepared[] = [];
  for (const skill of approval.skills) {
    const contents = new Map<string, Uint8Array>(), files: OwnedFile[] = [];
    for (const path of skill.files) {
      const content = await read(path, bytesLimit), relative = path.slice(skill.source_path.length + 1);
      if (relative === 'SKILL.md') skillMetadata(content, skill.target_name);
      contents.set(relative, content); files.push({ source_path: path, relative_path: relative, sha256: hash(content), bytes: content.byteLength });
    }
    const source = { repository: approval.repository, commit: approval.commit, path: skill.source_path };
    prepared.push({ contents, receipt: { schema_version: 1, id: identity(source, skill.target_name), kind: 'selected-workspace-skill-component', source,
      target_name: skill.target_name, target: `${hostRoot}/${skill.target_name}`, state: 'selected', published: false, files,
      license: { source_path: approval.license_path, sha256: hash(licenseBytes), bytes: licenseBytes.byteLength, text: licenseText },
      retained_paths: [], history: [], integrity: '', claims: { selection: 'exact-files-only', package_completeness: 'not-established',
        plugin_installation: 'not-performed', host_loading: 'unverified', execution: 'not-performed' } } });
  }
  return prepared;
}

/** Advisory view over existing owned receipts only. Hash-current installed
 * bytes are not evidence that VS Code discovered, loaded or used the skill. */
export function listWorkspaceSkillComponents(rootPath: string, query: WorkspaceSkillQuery = {}): WorkspaceSkillList {
  if (!object(query) || Object.keys(query).some(key => !['request', 'limit', 'exact_name'].includes(key)) ||
    (query.request !== undefined && (typeof query.request !== 'string' || query.request.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query.request))) ||
    (query.exact_name !== undefined && (typeof query.exact_name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(query.exact_name))) ||
    (query.limit !== undefined && (typeof query.limit !== 'number' || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10))) fail('INVALID_QUERY');
  const limit = query.limit ?? 5, words = (text: string) => [...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 80);
  const tokens = words(query.request ?? ''), issues: WorkspaceSkillList['issues'] = [], candidates: WorkspaceSkillCandidate[] = [];
  const pathBudget = { remaining: 4096 }, lookup: PathLookup = (root, path) => local(root, path, pathBudget);
  let truncated = false, metadataBytes = 0, inspectedBytes = 0;
  const finish = (state: WorkspaceSkillList['state'], components: WorkspaceSkillCandidate[] = []): WorkspaceSkillList => ({ state, components, issues,
    results_truncated: truncated, fallback: 'ordinary-work', authorization: 'not-granted', execution: 'not-performed' });
  const code = (error: unknown): WorkspaceSkillList['issues'][number]['code'] => error instanceof WorkspaceSkillError
    ? error.code === 'BOUND_EXCEEDED' ? 'BOUND_EXCEEDED' : ['UNSAFE_PATH', 'COLLISION'].includes(error.code) ? 'UNSAFE_PATH'
      : error.code === 'INVALID_RECEIPT' ? 'INVALID_RECEIPT' : 'READ_FAILED' : 'READ_FAILED';
  try {
    const root = workspace(rootPath), metadata = metadataRoot(root, lookup), directory = lookup(root, metadata);
    if (!directory.exists) return finish('absent');
    const names: string[] = [], opened = opendirSync(directory.path);
    try {
      let entries = 0;
      for (let item = opened.readSync(); item; item = opened.readSync()) {
        if (++entries > 256 || --pathBudget.remaining < 0) { truncated = true; issues.push({ code: 'BOUND_EXCEEDED' }); break; }
        if (!/^workspace-skill-[a-f0-9]{64}\.json$/.test(item.name)) continue;
        if (names.length === 32) { truncated = true; break; }
        names.push(item.name.slice(0, -5));
      }
    } finally { opened.closeSync(); }
    // Beyond this directory bound we cannot prove that a later case alias does
    // not exist. Do not accept early receipts or enumerate the whole folder.
    if (issues.some(issue => issue.code === 'BOUND_EXCEEDED')) return finish('partial');
    const observe = (bytes: Buffer) => {
      metadataBytes += bytes.length;
      if (metadataBytes > 2 * 1024 * 1024) fail('BOUND_EXCEEDED');
    };
    for (const id of names.sort()) {
      try {
        let receiptHash = '';
        const receipt = load(root, id, bytes => { observe(bytes); receiptHash = hash(bytes); }, lookup);
        if (!receipt) { issues.push({ id, code: 'INVALID_RECEIPT' }); continue; }
        if (query.exact_name !== undefined && receipt.target_name !== query.exact_name) continue;
        const entry = receipt.files.find(file => file.relative_path === 'SKILL.md');
        if (!entry) { issues.push({ id, code: 'INVALID_RECEIPT' }); continue; }
        let state = receipt.state, fileState: WorkspaceSkillCandidate['files']['state'] = 'absent';
        let description: string | null = null, descriptionTruncated = false;
        try {
          const target = lookup(root, receipt.target);
          if (target.exists && !receipt.published) { state = 'conflict'; fileState = 'not-inspected'; issues.push({ id, code: 'LOCAL_CHANGED' }); }
          else if (target.exists && receipt.published) {
            fileState = 'current';
            for (const file of receipt.files) {
              const found = lookup(root, `${receipt.target}/${file.relative_path}`);
              if (!found.exists) { if (fileState === 'current') fileState = 'incomplete'; continue; }
              if (found.directory || lstatSync(found.path).size !== file.bytes) { fileState = 'changed'; continue; }
              if (inspectedBytes + file.bytes > totalLimit) { truncated = true; fileState = 'not-inspected'; break; }
              const bytes = readFileSync(found.path); inspectedBytes += bytes.length;
              if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) { fileState = 'changed'; continue; }
              if (file.relative_path === 'SKILL.md') {
                const header = skillMetadata(bytes, receipt.target_name);
                description = header.description; descriptionTruncated = header.description_truncated;
              }
            }
            if (fileState === 'not-inspected') issues.push({ id, code: 'BOUND_EXCEEDED' });
            else if (fileState === 'changed') issues.push({ id, code: 'LOCAL_CHANGED' });
            else if (fileState === 'incomplete' && !receipt.pending_action) issues.push({ id, code: 'MISSING_FILES' });
          }
          if (receipt.state === 'installed' && fileState !== 'current') {
            state = fileState === 'not-inspected' ? 'partial' : 'conflict';
            if (fileState === 'absent') issues.push({ id, code: 'MISSING_FILES' });
          }
          if (['disabled', 'removed'].includes(receipt.state) && target.exists) { state = 'conflict'; issues.push({ id, code: 'LOCAL_CHANGED' }); }
        } catch (error) {
          const bounded = error instanceof WorkspaceSkillError && error.code === 'BOUND_EXCEEDED';
          if (bounded) truncated = true;
          state = bounded ? 'partial' : 'conflict'; fileState = bounded ? 'not-inspected' : error instanceof WorkspaceSkillError && error.code === 'INVALID_SKILL' ? 'changed' : 'unsafe';
          issues.push({ id, code: error instanceof WorkspaceSkillError && error.code === 'INVALID_SKILL' ? 'INVALID_SKILL' : code(error) });
        }
        // Recheck the same receipt after inspecting its files. A concurrent local
        // metadata edit cannot inherit an earlier current-content observation.
        const fresh = lookup(root, receiptPath(root, id, lookup));
        if (!fresh.exists || fresh.directory || lstatSync(fresh.path).size > receiptLimit) fail('INVALID_RECEIPT');
        const freshBytes = readFileSync(fresh.path); observe(freshBytes);
        if (freshBytes.length > receiptLimit || hash(freshBytes) !== receiptHash) fail('INVALID_RECEIPT');
        candidates.push({ id, name: receipt.target_name, description, description_truncated: descriptionTruncated,
          source: receipt.source, skill_path: `${receipt.target}/SKILL.md`, skill_sha256: entry.sha256,
          recorded_state: receipt.state, state, available: state === 'installed' && fileState === 'current',
          files: { count: receipt.files.length, bytes: receipt.files.reduce((sum, file) => sum + file.bytes, 0), state: fileState },
          receipt: { path: `${metadata}/${id}.json`, sha256: receiptHash },
          license: { source_path: receipt.license.source_path, sha256: receipt.license.sha256 },
          observations: { loaded: 'not-observed', used: 'not-observed', verified: 'not-observed' } });
        if (truncated && fileState === 'not-inspected') break;
      } catch (error) {
        const issue = code(error); issues.push({ id, code: issue });
        if (issue === 'BOUND_EXCEEDED') { truncated = true; break; }
      }
    }
    const scored = candidates.map(candidate => {
      const content = new Set(words(candidate.name + ' ' + (candidate.description ?? '')));
      return { candidate, score: tokens.reduce((score, word) => score + Number(content.has(word)), 0) };
    }).filter(item => !tokens.length || item.score > 0).sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name) || a.candidate.id.localeCompare(b.candidate.id));
    if (scored.length > limit) truncated = true;
    const result = scored.slice(0, limit).map(item => item.candidate);
    return finish(issues.length || truncated || result.some(item => ['partial', 'conflict', 'selected'].includes(item.state)) ? 'partial' : names.length ? 'available' : 'absent', result);
  } catch (error) { const issue = code(error); if (issue === 'BOUND_EXCEEDED') truncated = true; issues.push({ code: issue }); return finish('unavailable'); }
}
const result = (components: WorkspaceSkillReceipt[], changed: boolean): WorkspaceSkillResult => ({ components, changed,
  installation_scope: 'workspace-skill-components-only', plugin_installation: 'not-performed', host_loading: 'unverified', execution: 'not-performed' });

/** Caller supplies an explicit approved exact-file selection and ordinary pinned
 * reader. Files are read/validated before any host-visible publication occurs. */
export async function installWorkspaceSkillComponents(rootPath: string, input: WorkspaceSkillApproval, reader: AgentMarketplaceReader,
  options: WorkspaceSkillOptions = {}): Promise<WorkspaceSkillResult> {
  const root = workspace(rootPath), approval = selection(input), timeout = options.timeout_ms ?? 30_000;
  // Resolve existing managed aliases and migration/conflict state before any
  // injected transport can run. Never create a competing managed-data root.
  metadataRoot(root);
  if (typeof reader !== 'function') fail('INVALID_APPROVAL');
  if (options.authorize !== undefined && typeof options.authorize !== 'function') fail('INVALID_APPROVAL');
  const authorize = () => {
    if (options.authorize) {
      let allowed = false;
      try {
        const decision: unknown = options.authorize();
        // An untyped asynchronous callback is never an authorization grant.
        if (decision instanceof Promise) void decision.catch(() => {});
        allowed = decision === true;
      } catch { /* Policy details are private; retain a bounded denial label. */ }
      if (!allowed) fail('POLICY_CHANGED');
    }
    if (options.signal?.aborted) fail('CANCELLED');
  };
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 60_000) fail('BOUND_EXCEEDED');
  if (options.signal?.aborted) fail('CANCELLED');
  authorize();
  const controller = new AbortController();
  let stop!: (error: WorkspaceSkillError) => void;
  const stopped = new Promise<never>((_resolve, reject) => { stop = reject; });
  const cancel = () => { stop(new WorkspaceSkillError('CANCELLED')); controller.abort(); };
  const timer = setTimeout(() => { stop(new WorkspaceSkillError('TIMEOUT')); controller.abort(); }, timeout);
  options.signal?.addEventListener('abort', cancel, { once: true });
  let prepared: Prepared[];
  try { prepared = await Promise.race([prepare(approval, reader, controller.signal), stopped]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
  if (controller.signal.aborted) fail('CANCELLED');
  // Source approval can be revoked during the last awaited read. Recheck before
  // any receipt/stage write, not only before starting the asynchronous prepare.
  authorize();
  // Synchronous preflight/publication keeps module calls from interleaving while
  // mutating. External OS writers can still race; this is not a filesystem sandbox.
  for (const item of prepared) {
    const saved = load(root, item.receipt.id), target = local(root, item.receipt.target);
    if (saved) {
      if (JSON.stringify(saved.files) !== JSON.stringify(item.receipt.files) || JSON.stringify(saved.license) !== JSON.stringify(item.receipt.license)) fail('SOURCE_PIN_MISMATCH');
      item.receipt.history = saved.history;
      if (saved.state === 'installed') { if (!current(root, saved)) fail('LOCAL_CHANGED'); item.receipt = saved; continue; }
      if (target.exists) fail('COLLISION');
    } else if (target.exists) fail('COLLISION');
  }
  const completed: WorkspaceSkillReceipt[] = [];
  let changed = false;
  for (const item of prepared) {
    authorize();
    const receipt = item.receipt;
    if (receipt.state === 'installed') { completed.push(receipt); continue; }
    const stage = `${metadataRoot(root)}/staging/${receipt.id}-${randomUUID()}`;
    try {
      event(receipt, 'select', 'selected'); save(root, receipt);
      ensureDirectory(root, stage);
      for (const [relative, bytes] of item.contents) {
        const selected = `${stage}/${relative}`, parent = selected.split('/').slice(0, -1).join('/');
        ensureDirectory(root, parent); const destination = local(root, selected);
        if (destination.exists) fail('COLLISION');
        writeFileSync(destination.path, bytes, { flag: 'wx' });
      }
      authorize();
      ensureDirectory(root, hostRoot);
      const target = local(root, receipt.target);
      if (target.exists) fail('COLLISION');
      renameSync(local(root, stage).path, target.path);
      receipt.published = true;
      event(receipt, 'publish', 'installed'); save(root, receipt);
      completed.push(receipt); changed = true;
    } catch (error) {
      receipt.retained_paths = cleanStage(root, stage, receipt.files);
      event(receipt, 'publication-failed', 'partial');
      // A complete renamed component may remain if its final receipt write failed;
      // retain that honest state. Never remove user content to make rollback pass.
      try { save(root, receipt); } catch { /* Original failure remains meaningful. */ }
      throw error instanceof WorkspaceSkillError ? error : new WorkspaceSkillError('FILESYSTEM_FAILED');
    }
  }
  return result(completed, changed);
}

/** Removes only selected unchanged component bytes. Receipts, license and event
 * history remain; products and unrelated user files are never removed. */
export function controlWorkspaceSkillComponent(rootPath: string, id: string, action: 'disable' | 'remove'): WorkspaceSkillResult {
  const root = workspace(rootPath);
  if (!['disable', 'remove'].includes(action)) fail('INVALID_APPROVAL');
  const receipt = load(root, id);
  if (!receipt) fail('INVALID_RECEIPT');
  const desired = action === 'disable' ? 'disabled' : 'removed';
  if (receipt.state === desired && !local(root, receipt.target).exists) return result([receipt], false);
  const retained: WorkspaceSkillReceipt['retained_paths'] = [];
  let changed = false;
  // Publish removal intent before its first side effect. A process exit, failed
  // directory cleanup, or unavailable final metadata write then leaves a durable
  // partial receipt rather than falsely advertising a fully installed component.
  receipt.pending_action = action;
  event(receipt, `${action}-started`, 'partial');
  try { save(root, receipt); } catch { return fail('FILESYSTEM_FAILED'); }
  try {
    if (!receipt.published && local(root, receipt.target).exists) retained.push({ path: receipt.target, reason: 'unowned-content' });
    for (const file of receipt.published ? receipt.files : []) {
      const relative = `${receipt.target}/${file.relative_path}`;
      try {
        const found = local(root, relative);
        if (!found.exists) continue;
        if (found.directory || lstatSync(found.path).size !== file.bytes || hash(readFileSync(found.path)) !== file.sha256) {
          retained.push({ path: relative, reason: 'changed' }); continue;
        }
        unlinkSync(found.path); changed = true;
      } catch (error) {
        if (error instanceof WorkspaceSkillError && ['UNSAFE_PATH', 'COLLISION'].includes(error.code)) retained.push({ path: relative, reason: 'unsafe' });
        else throw error;
      }
    }
    const directories = new Set<string>([receipt.target]);
    for (const file of receipt.files) {
      const parts = file.relative_path.split('/');
      for (let index = 1; index < parts.length; index++) directories.add(`${receipt.target}/${parts.slice(0, index).join('/')}`);
    }
    for (const directory of receipt.published ? [...directories].sort((a, b) => b.length - a.length) : []) {
      try { const found = local(root, directory); if (found.exists && found.directory) rmdirSync(found.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
          if (directory === receipt.target && !retained.length) retained.push({ path: directory, reason: 'unowned-content' });
        } else if (error instanceof WorkspaceSkillError && ['UNSAFE_PATH', 'COLLISION'].includes(error.code)) retained.push({ path: directory, reason: 'unsafe' });
        else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!retained.length) receipt.published = false;
    receipt.retained_paths = retained; delete receipt.pending_action;
    event(receipt, action, retained.length ? 'conflict' : desired); save(root, receipt);
    return result([receipt], changed);
  } catch {
    receipt.retained_paths = retained; receipt.pending_action = action;
    // Best effort records observed partial progress. If storage is unavailable,
    // the already saved *-started intent still truthfully survives a crash.
    try { event(receipt, `${action}-failed`, 'partial'); save(root, receipt); } catch { /* Keep the durable intent. */ }
    return fail('FILESYSTEM_FAILED');
  }
}
