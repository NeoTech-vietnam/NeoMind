/** Explicit public-source GitHub reader for marketplace metadata. No global
 * fetch, credential lookup, filesystem, installation or execution is used.
 * Git modes are verified because Contents may dereference in-repo symlinks.
 * See https://docs.github.com/en/rest/repos/contents and /en/rest/git/trees. */
import { createHash } from 'node:crypto';
import { AgentMarketplaceError, type AgentMarketplaceErrorCode, type AgentMarketplaceReader,
  type AgentSourceRead, type AgentSourceFile } from './agent-marketplace.js';

export type GitHubMarketplaceFetch = (url: string, options: RequestInit) => Promise<Response>;
export interface GitHubMarketplaceReaderOptions {
  fetch: GitHubMarketplaceFetch;
  allowed_repositories: readonly string[];
  timeout_ms?: number;
}
export interface GitHubAgentPathResolution {
  repository: string; commit: string; requested_path: string; resolved_path: string;
  kind: 'ordinary-git-path'; ordinary_blob_sha: string;
  links: { link_path: string; target: string; resolved_prefix: string; blob_sha: string }[];
  complete: true; component_contents: 'not-read'; installation: 'not-performed';
}
export interface GitHubAgentFileInventory {
  repository: string; commit: string; path: string;
  files: { path: string; blob_sha: string; size: number }[];
  complete: true; component_contents: 'not-read'; installation: 'not-performed';
}
export type GitHubAgentMarketplaceReader = AgentMarketplaceReader & {
  readonly resolvePath: (input: AgentSourceRead) => Promise<GitHubAgentPathResolution>;
  readonly listFiles: (input: AgentSourceRead) => Promise<GitHubAgentFileInventory>;
};
export type GitHubMarketplaceReadReason = 'invalid-policy' | 'repository-not-allowed' | 'invalid-source' | 'unsafe-path' |
  'invalid-limit' | 'redirect' | 'http-error' | 'authorization' | 'rate-limit' | 'not-found' | 'invalid-response' |
  'identity-mismatch' | 'incomplete-response' | 'response-too-large' | 'invalid-base64' | 'blob-hash-mismatch' |
  'nonordinary-git-entry' | 'incomplete-tree' | 'unsafe-alias-target' | 'alias-loop' | 'alias-limit' |
  'cancelled' | 'timeout' | 'transport-failed';
const reasonCode: Record<GitHubMarketplaceReadReason, AgentMarketplaceErrorCode> = {
  'invalid-policy': 'INVALID_SOURCE', 'repository-not-allowed': 'INVALID_SOURCE', 'invalid-source': 'INVALID_SOURCE',
  'unsafe-path': 'UNSAFE_PATH', 'invalid-limit': 'BOUND_EXCEEDED', redirect: 'READ_FAILED', 'http-error': 'READ_FAILED',
  authorization: 'READ_FAILED', 'rate-limit': 'READ_FAILED', 'not-found': 'READ_FAILED', 'invalid-response': 'READ_FAILED',
  'identity-mismatch': 'SOURCE_PIN_MISMATCH', 'incomplete-response': 'READ_INCOMPLETE', 'response-too-large': 'BOUND_EXCEEDED',
  'invalid-base64': 'READ_FAILED', 'blob-hash-mismatch': 'SOURCE_PIN_MISMATCH', 'nonordinary-git-entry': 'READ_INCOMPLETE',
  'incomplete-tree': 'READ_INCOMPLETE', 'unsafe-alias-target': 'UNSAFE_PATH', 'alias-loop': 'READ_INCOMPLETE', 'alias-limit': 'BOUND_EXCEEDED',
  cancelled: 'READ_CANCELLED', timeout: 'READ_TIMEOUT', 'transport-failed': 'READ_FAILED',
};
export class GitHubMarketplaceReadError extends AgentMarketplaceError {
  constructor(public readonly reason: GitHubMarketplaceReadReason) { super(reasonCode[reason]); this.name = 'GitHubMarketplaceReadError'; }
}
function reject(reason: GitHubMarketplaceReadReason): never { throw new GitHubMarketplaceReadError(reason); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const objectId = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
const jsonTreeLimit = 6 * 1024 * 1024;
const entryLimit = 20_000;
type GitEntry = { mode: string; type: string; sha: string; size?: number };
interface ReadScope {
  source: { repository: string; slug: string }; commit: string; requestedPath: string; maxBytes: number;
  inventory: ReadonlyMap<string, GitEntry>; signal: AbortSignal;
  getJson: (url: string, budget: number) => Promise<unknown>;
}

function repository(value: unknown): { repository: string; slug: string } {
  if (typeof value !== 'string' || value.length > 300 || !/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/?$/i.test(value)) reject('invalid-source');
  const slug = value.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '').toLowerCase();
  if (slug.split('/').some(part => !part || part === '.' || part === '..')) reject('invalid-source');
  return { repository: `https://github.com/${slug}`, slug };
}
function path(value: unknown, metadata = false): string {
  if (typeof value !== 'string' || !value || value.length > (metadata ? 4096 : 1024) ||
      /[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) reject('unsafe-path');
  if (!metadata && (/[\u202a-\u202e\u2066-\u2069:%?#]/.test(value) || value.split('/').some(part => part !== part.trim() || part.endsWith('.')))) reject('unsafe-path');
  return value;
}
const api = (slug: string, suffix: string) => `https://api.github.com/repos/${slug}/${suffix}`;
function sameApiUrl(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length > 5000) return false;
  try {
    const a = new URL(actual), b = new URL(expected);
    if (a.origin !== b.origin || a.username || a.password || a.hash || a.search !== b.search) return false;
    const parts = a.pathname.split('/').map(part => decodeURIComponent(part));
    const wanted = b.pathname.split('/').map(part => decodeURIComponent(part));
    return parts.length === wanted.length && parts.every((part, index) => !part.includes('/') &&
      (index === 2 || index === 3 ? part.toLowerCase() === wanted[index]?.toLowerCase() : part === wanted[index]));
  } catch { return false; }
}
function blobHash(bytes: Uint8Array, id: string): string {
  return createHash(id.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
function base64(value: unknown, size: number, limit: number): Uint8Array {
  if (typeof value !== 'string') reject('invalid-base64');
  const clean = value.replace(/[\r\n]/g, '');
  if (clean.length > 4 * Math.ceil(limit / 3)) reject('response-too-large');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) reject('invalid-base64');
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.toString('base64') !== clean) reject('invalid-base64');
  if (bytes.byteLength !== size) reject('incomplete-response');
  return bytes;
}
function ordinaryEntry(scope: ReadScope, selectedPath: string): GitEntry {
  const parts = selectedPath.split('/');
  for (let index = 1; index < parts.length; index++) {
    const ancestor = scope.inventory.get(parts.slice(0, index).join('/'));
    if (!ancestor || ancestor.mode !== '040000' || ancestor.type !== 'tree') reject('nonordinary-git-entry');
  }
  const entry = scope.inventory.get(selectedPath);
  if (!entry) reject('not-found');
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) reject('nonordinary-git-entry');
  if (entry.size !== undefined && entry.size > scope.maxBytes) reject('response-too-large');
  return entry;
}
async function readOrdinary(scope: ReadScope): Promise<AgentSourceFile> {
  const entry = ordinaryEntry(scope, scope.requestedPath);
  const url = api(scope.source.slug, `contents/${scope.requestedPath.split('/').map(part => encodeURIComponent(part)).join('/')}?ref=${encodeURIComponent(scope.commit)}`);
  const value = await scope.getJson(url, Math.ceil(scope.maxBytes * 1.5) + 32 * 1024);
  if (!object(value) || value.type !== 'file' || value.encoding !== 'base64' || value.target !== undefined || value.submodule_git_url !== undefined) reject('nonordinary-git-entry');
  if (value.path !== scope.requestedPath || !sameApiUrl(value.url, url) || !objectId(value.sha) || value.sha.toLowerCase() !== entry.sha) reject('identity-mismatch');
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) reject('invalid-response');
  if (value.size > scope.maxBytes) reject('response-too-large');
  if (value.truncated === true || entry.size !== undefined && value.size !== entry.size) reject('incomplete-response');
  const bytes = base64(value.content, value.size, scope.maxBytes);
  if (blobHash(bytes, entry.sha) !== entry.sha) reject('blob-hash-mismatch');
  return { repository: scope.source.repository, commit: scope.commit, path: scope.requestedPath, kind: 'file', complete: true, content: bytes };
}
function listOrdinaryFiles(scope: ReadScope): GitHubAgentFileInventory {
  const parts = scope.requestedPath.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const entry = scope.inventory.get(parts.slice(0, index).join('/'));
    if (!entry) reject('not-found');
    if (entry.type !== 'tree' || entry.mode !== '040000') reject('nonordinary-git-entry');
  }
  const files: GitHubAgentFileInventory['files'] = []; let total = 0;
  for (const [selected, entry] of scope.inventory) {
    if (scope.signal.aborted) reject('cancelled');
    if (!selected.startsWith(scope.requestedPath + '/')) continue;
    path(selected);
    if (entry.type === 'tree' && entry.mode === '040000') continue;
    const ordinary = ordinaryEntry(scope, selected);
    if (ordinary.size === undefined) reject('incomplete-tree');
    total += ordinary.size;
    if (files.length >= 256 || ordinary.size > 1024 * 1024 || total > scope.maxBytes) reject('response-too-large');
    files.push({ path: selected, blob_sha: ordinary.sha, size: ordinary.size });
  }
  return { repository: scope.source.repository, commit: scope.commit, path: scope.requestedPath,
    files: files.sort((a, b) => a.path.localeCompare(b.path)), complete: true, component_contents: 'not-read', installation: 'not-performed' };
}
function aliasTarget(linkPath: string, target: string): string {
  if (!target || target.length > 4096 || target.startsWith('/') || /[\\\u0000-\u001f\u007f:%?#\u202a-\u202e\u2066-\u2069]/.test(target)) reject('unsafe-alias-target');
  const parts = linkPath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '.') continue;
    if (part === '..') { if (!parts.length) reject('unsafe-alias-target'); parts.pop(); }
    else {
      if (!part || part !== part.trim() || part.endsWith('.')) reject('unsafe-alias-target');
      parts.push(part);
    }
  }
  if (!parts.length) reject('unsafe-alias-target');
  return path(parts.join('/'));
}
async function resolvePinnedPath(scope: ReadScope): Promise<GitHubAgentPathResolution> {
  let current = scope.requestedPath;
  const visited = new Set<string>(), links: GitHubAgentPathResolution['links'] = [];
  for (;;) {
    if (scope.signal.aborted) reject('cancelled');
    if (visited.has(current)) reject('alias-loop');
    visited.add(current);
    const parts = current.split('/');
    let rewritten = false;
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/'), entry = scope.inventory.get(prefix);
      if (!entry) reject('not-found');
      if (entry.mode === '120000' && entry.type === 'blob') {
        if (links.length >= 8) reject('alias-limit');
        if (entry.size !== undefined && entry.size > 4096) reject('response-too-large');
        const url = api(scope.source.slug, `git/blobs/${encodeURIComponent(entry.sha)}`), value = await scope.getJson(url, 40 * 1024);
        if (!object(value) || value.encoding !== 'base64' || !objectId(value.sha) || value.sha.toLowerCase() !== entry.sha || !sameApiUrl(value.url, url)) reject('identity-mismatch');
        if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) reject('invalid-response');
        if (value.size > 4096) reject('response-too-large');
        if (entry.size !== undefined && value.size !== entry.size) reject('incomplete-response');
        const bytes = base64(value.content, value.size, 4096);
        if (blobHash(bytes, entry.sha) !== entry.sha) reject('blob-hash-mismatch');
        let target: string;
        try { target = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return reject('unsafe-alias-target'); }
        const resolvedPrefix = aliasTarget(prefix, target);
        current = path([...resolvedPrefix.split('/'), ...parts.slice(index)].join('/'));
        links.push({ link_path: prefix, target, resolved_prefix: resolvedPrefix, blob_sha: entry.sha });
        rewritten = true; break;
      }
      if (index < parts.length && (entry.mode !== '040000' || entry.type !== 'tree')) reject('nonordinary-git-entry');
    }
    if (rewritten) continue;
    const ordinary = ordinaryEntry(scope, current);
    return { repository: scope.source.repository, commit: scope.commit, requested_path: scope.requestedPath, resolved_path: current,
      kind: 'ordinary-git-path', ordinary_blob_sha: ordinary.sha, links, complete: true, component_contents: 'not-read', installation: 'not-performed' };
  }
}

/** A fresh allow-list is copied when constructing the adapter. Catalog trust
 * grants no read access to external package repositories and no execution right.
 * Only successful bounded Git trees are cached in memory, at most eight pins. */
export function createGitHubAgentMarketplaceReader(options: GitHubMarketplaceReaderOptions): GitHubAgentMarketplaceReader {
  if (!options || typeof options.fetch !== 'function') throw new AgentMarketplaceError('TRANSPORT_REQUIRED');
  if (!Array.isArray(options.allowed_repositories) || options.allowed_repositories.length > 100) reject('invalid-policy');
  const allowed = new Set(options.allowed_repositories.map(value => repository(value).repository));
  const fetcher = options.fetch, timeout = options.timeout_ms ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30_000) reject('invalid-limit');
  const trees = new Map<string, Map<string, GitEntry>>();
  const transaction = async <T>(input: AgentSourceRead, action: (scope: ReadScope) => T | Promise<T>, byteLimit = 1024 * 1024): Promise<T> => {
    const selected = repository(input?.repository), requestedPath = path(input?.path);
    if (!allowed.has(selected.repository)) reject('repository-not-allowed');
    if (!objectId(input.commit)) reject('invalid-source');
    const commit = input.commit.toLowerCase();
    if (!Number.isSafeInteger(input.max_bytes) || input.max_bytes < 1 || input.max_bytes > byteLimit) reject('invalid-limit');
    if (input.signal?.aborted) reject('cancelled');
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stop!: (error: GitHubMarketplaceReadError) => void;
    const stopped = new Promise<never>((_resolve, rejectPromise) => { stop = rejectPromise; });
    const cancel = (reason: 'cancelled' | 'timeout') => {
      stop(new GitHubMarketplaceReadError(reason)); controller.abort();
      void activeReader?.cancel().catch(() => {});
    };
    const onAbort = () => cancel('cancelled');
    const timer = setTimeout(() => cancel('timeout'), timeout);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const getJson = async (url: string, budget: number): Promise<unknown> => {
      if (controller.signal.aborted) reject('cancelled');
      const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (!response || typeof response.status !== 'number' || !response.headers || typeof response.headers.get !== 'function') reject('invalid-response');
      const discard = () => { void response.body?.cancel().catch(() => {}); };
      if (controller.signal.aborted) { discard(); reject('cancelled'); }
      if (response.redirected || response.status >= 300 && response.status < 400) { discard(); reject('redirect'); }
      if (!sameApiUrl(response.url, url)) { discard(); reject('identity-mismatch'); }
      if (response.status === 206 || response.headers.has('content-range')) { discard(); reject('incomplete-response'); }
      if (response.status < 200 || response.status >= 300) {
        discard();
        reject(response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0' ? 'rate-limit'
          : response.status === 401 || response.status === 403 ? 'authorization' : response.status === 404 ? 'not-found' : 'http-error');
      }
      if (!/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) { discard(); reject('invalid-response'); }
      const encoded = response.headers.get('content-encoding');
      const declared = response.headers.get('content-length');
      const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined;
      const identity = !encoded || encoded.toLowerCase() === 'identity';
      if (identity && length !== undefined && length > budget) { discard(); reject('response-too-large'); }
      activeReader = response.body.getReader();
      const reader = activeReader, chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          let item: ReadableStreamReadResult<Uint8Array>;
          try { item = await reader.read(); } catch { return reject('incomplete-response'); }
          if (item.done) break;
          if (!(item.value instanceof Uint8Array)) reject('invalid-response');
          total += item.value.byteLength;
          if (total > budget) { void reader.cancel().catch(() => {}); reject('response-too-large'); }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); activeReader = undefined; }
      if (identity && length !== undefined && length !== total) reject('incomplete-response');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); }
      catch { return reject('invalid-response'); }
    };
    const operation = async () => {
      const key = `${selected.repository}@${commit}`;
      let inventory = trees.get(key);
      if (!inventory) {
        const treeUrl = api(selected.slug, `git/trees/${encodeURIComponent(commit)}?recursive=1`);
        const tree = await getJson(treeUrl, jsonTreeLimit);
        if (!object(tree) || tree.truncated !== false || !objectId(tree.sha) || !Array.isArray(tree.tree) || tree.tree.length > entryLimit) reject('incomplete-tree');
        if (tree.url !== undefined && !sameApiUrl(tree.url, api(selected.slug, `git/trees/${tree.sha}`)) &&
            !sameApiUrl(tree.url, api(selected.slug, `trees/${tree.sha}`))) reject('identity-mismatch');
        inventory = new Map();
        for (const entry of tree.tree) {
          if (!object(entry) || typeof entry.path !== 'string' || !objectId(entry.sha) || typeof entry.mode !== 'string' || typeof entry.type !== 'string') reject('incomplete-tree');
          const entryPath = path(entry.path, true);
          if (inventory.has(entryPath) || !['040000:tree', '100644:blob', '100755:blob', '120000:blob', '160000:commit'].includes(`${entry.mode}:${entry.type}`)) reject('incomplete-tree');
          if (entry.size !== undefined && (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0)) reject('incomplete-tree');
          inventory.set(entryPath, { mode: entry.mode, type: entry.type, sha: entry.sha.toLowerCase(),
            ...(typeof entry.size === 'number' ? { size: entry.size } : {}) });
        }
        if (trees.size >= 8) trees.delete(trees.keys().next().value!);
        trees.set(key, inventory);
      }
      if (controller.signal.aborted) reject('cancelled');
      return action({ source: selected, commit, requestedPath, maxBytes: input.max_bytes, inventory, signal: controller.signal, getJson });
    };
    try {
      return await Promise.race([operation(), stopped]);
    } catch (error) {
      if (error instanceof AgentMarketplaceError) throw error;
      return reject('transport-failed');
    } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', onAbort); controller.abort(); }
  };
  const reader: AgentMarketplaceReader = input => transaction(input, readOrdinary);
  return Object.freeze(Object.assign(reader, { resolvePath: (input: AgentSourceRead) => transaction(input, resolvePinnedPath),
    listFiles: (input: AgentSourceRead) => transaction(input, listOrdinaryFiles, 8 * 1024 * 1024) }));
}
