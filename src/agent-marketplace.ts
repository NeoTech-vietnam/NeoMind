/** Read-only marketplace metadata. The caller supplies a trusted read transport;
 * this module has no network, installation, execution or authorization path.
 * Catalog descriptions and component declarations remain untrusted source data. */
import { createHash } from 'node:crypto';

export interface PinnedAgentSource { repository: string; commit: string }
export interface AgentMarketplaceSource extends PinnedAgentSource { catalog_path?: string }
export interface AgentSourceRead extends PinnedAgentSource { path: string; max_bytes: number; signal: AbortSignal }
export interface AgentSourceFile extends PinnedAgentSource {
  /** Decoded ordinary-file bytes, never a provider's base64 response envelope. */
  path: string; content: string | Uint8Array; complete: boolean; kind: 'file' | 'directory' | 'symlink';
}
/** The adapter establishes source identity from its pinned backend read. The
 * inspector checks that identity and hashes bytes; it is not a Git attestation. */
export type AgentMarketplaceReader = (input: AgentSourceRead) => Promise<AgentSourceFile>;
export interface AgentReadOptions { signal?: AbortSignal; timeout_ms?: number }
export type AgentMarketplaceErrorCode = 'INVALID_SOURCE' | 'UNPINNED_SOURCE' | 'UNSUPPORTED_SOURCE' |
  'TRANSPORT_REQUIRED' | 'READ_FAILED' | 'READ_INCOMPLETE' | 'READ_CANCELLED' | 'READ_TIMEOUT' |
  'SOURCE_PIN_MISMATCH' | 'UNSAFE_PATH' | 'BOUND_EXCEEDED' | 'MALFORMED_CATALOG' | 'MALFORMED_MANIFEST';
const messages: Record<AgentMarketplaceErrorCode, string> = {
  INVALID_SOURCE: 'Use a canonical HTTPS Git repository locator and immutable commit.',
  UNPINNED_SOURCE: 'The package has no immutable source commit; supply a separately resolved package pin before inspection.',
  UNSUPPORTED_SOURCE: 'This catalog source format is not supported by this read-only adapter.',
  TRANSPORT_REQUIRED: 'Supply an explicit read-only source transport; no network transport is enabled by default.',
  READ_FAILED: 'The source transport could not read the requested pinned file.',
  READ_INCOMPLETE: 'The source response is incomplete or is not an ordinary file; no complete inspection was established.',
  READ_CANCELLED: 'The read-only inspection was cancelled.',
  READ_TIMEOUT: 'The read-only source inspection exceeded its bounded deadline.',
  SOURCE_PIN_MISMATCH: 'The returned repository, commit or path does not match the requested immutable source.',
  UNSAFE_PATH: 'Use a canonical relative source path without traversal, encoded separators or platform aliases.',
  BOUND_EXCEEDED: 'The source metadata exceeds the supported inspection limits.',
  MALFORMED_CATALOG: 'The pinned file is not a supported complete marketplace catalog.',
  MALFORMED_MANIFEST: 'The pinned package manifest is malformed or does not match its catalog identity.',
};
export class AgentMarketplaceError extends Error {
  constructor(public readonly code: AgentMarketplaceErrorCode) { super(messages[code]); this.name = 'AgentMarketplaceError'; }
}
function fail(code: AgentMarketplaceErrorCode): never { throw new AgentMarketplaceError(code); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const namePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function repository(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value) || /[\s\\?#@%]/.test(value)) fail('INVALID_SOURCE');
  const rawPath = value.slice(value.indexOf('://') + 3).replace(/^[^/]+/, '').replace(/\/$/, '');
  if (!rawPath || rawPath.split('/').slice(1).some(part => !part || part === '.' || part === '..' || !/^[a-z0-9._-]+$/i.test(part))) fail('INVALID_SOURCE');
  let url: URL;
  try { url = new URL(value); } catch { return fail('INVALID_SOURCE'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) fail('INVALID_SOURCE');
  const canonicalPath = rawPath.replace(/\.git$/i, '');
  if (canonicalPath.endsWith('/')) fail('INVALID_SOURCE');
  const result = `${url.origin}${canonicalPath}`;
  return url.hostname.toLowerCase() === 'github.com' ? result.toLowerCase() : result;
}
function pin(value: PinnedAgentSource): PinnedAgentSource {
  if (!object(value) || typeof value.commit !== 'string' || !commitPattern.test(value.commit)) fail('INVALID_SOURCE');
  return Object.freeze({ repository: repository(value.repository), commit: value.commit.toLowerCase() });
}
function sourcePath(value: unknown, rootAllowed = false): string {
  if (typeof value !== 'string' || value.length > 1024) fail('UNSAFE_PATH');
  let path = value;
  if (path.startsWith('./')) path = path.slice(2);
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (rootAllowed && (path === '' || path === '.')) return '';
  if (!path || /[\\:%?#\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || path.split('/').some(part =>
    !part || part === '.' || part === '..' || part !== part.trim() || part.endsWith('.'))) fail('UNSAFE_PATH');
  return path;
}
const joinSource = (root: string, path: string) => root ? `${root}/${sourcePath(path)}` : sourcePath(path);
function text(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('MALFORMED_MANIFEST');
  return value;
}
async function readJson(source: PinnedAgentSource, path: string, reader: AgentMarketplaceReader | undefined,
  maxBytes: number, malformed: 'MALFORMED_CATALOG' | 'MALFORMED_MANIFEST', options: AgentReadOptions) {
  if (typeof reader !== 'function') fail('TRANSPORT_REQUIRED');
  const timeout = options.timeout_ms ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30_000) fail('BOUND_EXCEEDED');
  if (options.signal?.aborted) fail('READ_CANCELLED');
  const controller = new AbortController();
  let stop!: (error: AgentMarketplaceError) => void;
  const stopped = new Promise<never>((_resolve, reject) => { stop = reject; });
  const cancel = () => { stop(new AgentMarketplaceError('READ_CANCELLED')); controller.abort(); };
  const timer = setTimeout(() => { stop(new AgentMarketplaceError('READ_TIMEOUT')); controller.abort(); }, timeout);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const file = await Promise.race([Promise.resolve().then(() => reader({ ...source, path, max_bytes: maxBytes, signal: controller.signal })), stopped]);
    if (!object(file) || repository(file.repository) !== source.repository || file.commit !== source.commit || file.path !== path) fail('SOURCE_PIN_MISMATCH');
    if (file.complete !== true || file.kind !== 'file') fail('READ_INCOMPLETE');
    if (typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) fail(malformed);
    const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
    if (bytes.byteLength > maxBytes) fail('BOUND_EXCEEDED');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
    catch { return fail(malformed); }
    return { value, sha256: hash(bytes), bytes: bytes.byteLength };
  } catch (error) {
    if (error instanceof AgentMarketplaceError) throw error;
    return fail('READ_FAILED');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}

export interface AgentMarketplaceCandidate {
  readonly name: string; readonly description: string;
  readonly package: Readonly<{ repository: string; path: string; commit?: string; declared_ref?: string }>;
  readonly provenance: Readonly<{ repository: string; commit: string; path: string; sha256: string }>;
  readonly state: 'source-pinned' | 'package-pin-required';
}
function packageSource(value: unknown, catalog: PinnedAgentSource): AgentMarketplaceCandidate['package'] {
  if (typeof value === 'string') {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) fail('UNSUPPORTED_SOURCE');
    if (!value.trim()) fail('UNSAFE_PATH');
    return Object.freeze({ ...catalog, path: sourcePath(value, true) });
  }
  if (!object(value) || !['github', 'git'].includes(String(value.source))) fail('UNSUPPORTED_SOURCE');
  const repo = value.source === 'github'
    ? typeof value.repo === 'string' && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value.repo) && !value.repo.split('/').some(part => part === '.' || part === '..')
      ? repository(`https://github.com/${value.repo}`) : fail('INVALID_SOURCE')
    : repository(value.url);
  if (value.sha !== undefined && (typeof value.sha !== 'string' || !commitPattern.test(value.sha))) fail('INVALID_SOURCE');
  if (value.ref !== undefined && (typeof value.ref !== 'string' || !value.ref.trim() || value.ref.length > 200)) fail('INVALID_SOURCE');
  const ref = value.ref as string | undefined;
  return Object.freeze({ repository: repo, path: value.path === undefined ? '' : sourcePath(value.path, true),
    ...(typeof value.sha === 'string' ? { commit: value.sha.toLowerCase() } : {}), ...(ref ? { declared_ref: ref } : {}) });
}

/** A catalog pin covers relative packages only. External package references
 * keep their own pin, or remain explicitly unresolved; never inherit its SHA. */
export async function discoverAgentMarketplace(input: AgentMarketplaceSource, reader?: AgentMarketplaceReader, options: AgentReadOptions = {}) {
  const source = pin(input), path = sourcePath(input.catalog_path ?? '.github/plugin/marketplace.json');
  const file = await readJson(source, path, reader, 1024 * 1024, 'MALFORMED_CATALOG', options);
  const catalog = file.value;
  if (!object(catalog) || typeof catalog.name !== 'string' || !namePattern.test(catalog.name) || !Array.isArray(catalog.plugins)) fail('MALFORMED_CATALOG');
  if (catalog.plugins.length > 1000) fail('BOUND_EXCEEDED');
  const candidates: AgentMarketplaceCandidate[] = [], issues: { index: number; code: AgentMarketplaceErrorCode | 'DUPLICATE_PLUGIN' }[] = [];
  const seen = new Set<string>(), duplicate = new Set<string>();
  const provenance = Object.freeze({ ...source, path, sha256: file.sha256 });
  for (const [index, entry] of catalog.plugins.entries()) {
    try {
      if (!object(entry) || typeof entry.name !== 'string' || !namePattern.test(entry.name) ||
          entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > 2000)) fail('MALFORMED_CATALOG');
      const key = entry.name.toLowerCase();
      if (seen.has(key)) { duplicate.add(key); issues.push({ index, code: 'DUPLICATE_PLUGIN' }); continue; }
      seen.add(key);
      const target = packageSource(entry.source, source);
      candidates.push(Object.freeze({ name: entry.name, description: entry.description as string ?? '', package: target, provenance,
        state: target.commit ? 'source-pinned' : 'package-pin-required' }));
    } catch (error) {
      if (!(error instanceof AgentMarketplaceError)) throw error;
      issues.push({ index, code: error.code });
    }
  }
  return { name: catalog.name, provenance, status: issues.length ? 'incomplete' as const : 'complete' as const,
    candidates: candidates.filter(candidate => !duplicate.has(candidate.name.toLowerCase())), issues,
    authorization: 'not-granted' as const, installation: 'not-performed' as const };
}

const componentKinds = new Set(['skills', 'agents', 'instructions', 'prompts', 'commands', 'hooks', 'mcpServers', 'lspServers']);
const portableSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
/** Recognizes only the locally implemented portable layout contract. The fixed
 * paths are discovery locations, not evidence that any component exists. This
 * is neither a full client conformance claim nor an installation permission. */
export function inspectPortableAgentPluginLayout(manifest: unknown, packageRoot: string) {
  if (!object(manifest)) fail('MALFORMED_MANIFEST');
  if (manifest.$schema !== portableSchema) return undefined;
  const root = sourcePath(packageRoot, true), fields = Object.keys(manifest);
  if (fields.length > 100 || fields.some(field => field.length > 160)) fail('BOUND_EXCEEDED');
  if (typeof manifest.name !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(manifest.name) ||
      /--|\.\./.test(manifest.name)) fail('MALFORMED_MANIFEST');
  for (const [field, max] of [['version', 200], ['description', 2000], ['homepage', 2048],
    ['repository', 2048], ['license', 200]] as const) {
    if (manifest[field] !== undefined) text(manifest[field], max);
  }
  if (manifest.author !== undefined) {
    if (!object(manifest.author) || Object.keys(manifest.author).some(field => !['name', 'email', 'url'].includes(field)))
      fail('MALFORMED_MANIFEST');
    for (const value of Object.values(manifest.author)) {
      if (typeof value !== 'string') fail('MALFORMED_MANIFEST');
      text(value, 2048);
    }
  }
  if (manifest.keywords !== undefined) {
    if (!Array.isArray(manifest.keywords)) fail('MALFORMED_MANIFEST');
    if (manifest.keywords.length > 100) fail('BOUND_EXCEEDED');
    for (const keyword of manifest.keywords) {
      if (typeof keyword !== 'string') fail('MALFORMED_MANIFEST');
      text(keyword, 200);
    }
  }
  const permitted = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  const ignored = fields.filter(field => !permitted.has(field));
  // The v1 specification explicitly makes a non-object extensions field nonfatal.
  if (manifest.extensions !== undefined && !object(manifest.extensions)) ignored.push('extensions');
  return { format: 'agent-plugins/1.0.0' as const, skills_directory: joinSource(root, 'skills'),
    skill_discovery: 'immediate-child/SKILL.md' as const, mcp_configuration: joinSource(root, 'mcp.json'),
    existence: 'not-inspected' as const, ignored_top_level_fields: ignored };
}
/** Inspects declarations, not skill contents or Local compatibility. An explicit
 * package pin is required for external references that the catalog did not pin. */
export async function inspectAgentMarketplacePlugin(candidate: AgentMarketplaceCandidate, reader?: AgentMarketplaceReader,
  options: AgentReadOptions & { package_pin?: PinnedAgentSource; manifest_path?: string } = {}) {
  const target = candidate.package, supplied = options.package_pin ? pin(options.package_pin) : undefined;
  const expectedRepo = repository(target.repository);
  if (supplied && (supplied.repository !== expectedRepo || target.commit && supplied.commit !== target.commit)) fail('SOURCE_PIN_MISMATCH');
  if (!target.commit && !supplied) fail('UNPINNED_SOURCE');
  const source = pin({ repository: expectedRepo, commit: target.commit ?? supplied!.commit });
  const packageRoot = sourcePath(target.path, true);
  const path = joinSource(packageRoot, options.manifest_path ?? 'plugin.json');
  const file = await readJson(source, path, reader, 512 * 1024, 'MALFORMED_MANIFEST', options);
  const manifest = file.value;
  if (!object(manifest) || manifest.name !== candidate.name || !namePattern.test(String(manifest.name))) fail('MALFORMED_MANIFEST');
  const portable = inspectPortableAgentPluginLayout(manifest, packageRoot);
  if (manifest.$schema !== undefined && !portable) fail('UNSUPPORTED_SOURCE');
  if (portable && path !== joinSource(packageRoot, 'plugin.json')) fail('UNSUPPORTED_SOURCE');
  const components: { namespace: string; kind: string; paths: string[]; inline: boolean }[] = [];
  const extensions: { namespace: string; fields: string[] }[] = [];
  let pathCount = 0;
  const collect = (namespace: string, fields: Record<string, unknown>) => {
    if (Object.keys(fields).length > 100 || Object.keys(fields).some(field => field.length > 160)) fail('BOUND_EXCEEDED');
    for (const [kind, declaration] of Object.entries(fields)) if (componentKinds.has(kind)) {
      if (components.length >= 128) fail('BOUND_EXCEEDED');
      if (Array.isArray(declaration) || typeof declaration === 'string') {
        const paths = Array.isArray(declaration) ? declaration : [declaration];
        pathCount += paths.length;
        if (pathCount > 256) fail('BOUND_EXCEEDED');
        components.push({ namespace, kind, paths: paths.map(item => joinSource(packageRoot, sourcePath(item))), inline: false });
      } else if (object(declaration)) components.push({ namespace, kind, paths: [], inline: true });
      else fail('MALFORMED_MANIFEST');
    }
  };
  // Historical declaration formats remain explicit compatibility handling. A
  // portable v1 manifest cannot override fixed paths with unknown top-level keys.
  if (!portable) collect('portable', manifest);
  if (manifest.extensions !== undefined) {
    if (!object(manifest.extensions)) { if (!portable) fail('MALFORMED_MANIFEST'); }
    else {
      if (Object.keys(manifest.extensions).length > 32) fail('BOUND_EXCEEDED');
      for (const [namespace, fields] of Object.entries(manifest.extensions)) {
        if (!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(namespace) || !portable && !object(fields)) fail('MALFORMED_MANIFEST');
        const names = object(fields) ? Object.keys(fields) : [];
        if (names.length > 100 || names.some(field => field.length > 160)) fail('BOUND_EXCEEDED');
        extensions.push({ namespace, fields: names });
        if (!portable) collect(namespace, fields as Record<string, unknown>);
      }
    }
  }
  return { state: 'manifest-inspected' as const, name: candidate.name, source,
    catalog_provenance: candidate.provenance, package_pin_origin: target.commit ? 'catalog' as const : 'supplied' as const,
    manifest: { path, sha256: file.sha256, bytes: file.bytes },
    version: text(manifest.version, 200) || null, description: text(manifest.description, 2000),
    declared_license: text(manifest.license, 200) || null, extensions, components,
    compatibility: 'unverified' as const, component_contents: 'not-read' as const, license_verification: 'not-performed' as const,
    authorization: 'not-granted' as const, installation: 'not-performed' as const };
}
