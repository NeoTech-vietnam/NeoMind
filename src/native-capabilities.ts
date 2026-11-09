/** Optional, host-approved skill discovery/materialization. Model input selects
 * names only; it never supplies source pins, paths, approval or tool authority. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { discoverAgentMarketplace, inspectAgentMarketplacePlugin, inspectPortableAgentPluginLayout, type AgentMarketplaceCandidate,
  type AgentMarketplaceReader, type AgentSourceFile } from './agent-marketplace.js';
import { createGitHubAgentMarketplaceReader, type GitHubMarketplaceFetch } from './agent-marketplace-github.js';
import { findAgentMarketplaceCandidates, readAgentMarketplaceCandidate, saveAgentMarketplaceCatalog,
  saveAgentCapabilityCatalog } from './agent-capability-cache.js';
import { installWorkspaceSkillComponents, listWorkspaceSkillComponents } from './workspace-skill-components.js';
import { readAutomationPolicy } from './manager.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z.string().min(1).max(800).refine(value => !/[\\:%?#\u0000-\u001f\u007f]/.test(value) &&
  !value.startsWith('/') && value.split('/').every(part => !!part && part !== '.' && part !== '..' &&
    part === part.trim() && !part.endsWith('.')));
const sourceSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  repository: z.string().regex(/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/).refine(value =>
    !value.endsWith('.git') && value.split('/').slice(3).every(part => part !== '.' && part !== '..')),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), catalog_path: relativePath,
  catalog_sha256: digest, license_path: relativePath, license_sha256: digest, allow_skills: z.boolean(),
});
export type NativeCapabilitySource = z.output<typeof sourceSchema>;
export const nativeCapabilitySourceJsonSchema = z.toJSONSchema(sourceSchema, { io: 'input', target: 'draft-7' });
export const DEFAULT_NATIVE_CAPABILITY_SOURCES: readonly NativeCapabilitySource[] = Object.freeze([Object.freeze({
  name: 'github-awesome-copilot', repository: 'https://github.com/github/awesome-copilot',
  commit: '02466d1eb70b841c90717b0fc2dc9457aa6f606f', catalog_path: '.github/plugin/marketplace.json',
  catalog_sha256: '3509977f5245298a16ff2747fc37a9579a00488c3f542800609918037cc11709', license_path: 'LICENSE',
  license_sha256: 'e32449d23085399adc1222f7a17408b730550258e51627c153cb108ca9955823', allow_skills: true,
})]);
const packageName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const nativeCapabilityInputSchema = z.strictObject({
  action: z.enum(['search', 'inspect', 'install', 'status']), query: z.string().trim().min(1).max(2000).describe('Required for search.').optional(),
  source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe('An approved source_name returned by discovery/status; never a URL.').optional(),
  package: packageName.describe('Exact catalog candidate name; required for inspect/install.').optional(),
  skill: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe('Exact SKILL.md frontmatter name; required for install or actual-content inspection.').optional(),
  role: z.enum(['WF.PM', 'WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']).optional(),
}).superRefine((value, ctx) => {
  if (value.action === 'search' && !value.query) ctx.addIssue({ code: 'custom', message: 'Search requires a query.' });
  if (['inspect', 'install'].includes(value.action) && !value.package) ctx.addIssue({ code: 'custom', message: 'Select an exact catalog package name.' });
  if (value.action === 'install' && !value.skill) ctx.addIssue({ code: 'custom', message: 'Select the exact SKILL.md frontmatter name.' });
});
export const nativeCapabilityJsonSchema = z.toJSONSchema(nativeCapabilityInputSchema, { io: 'input', target: 'draft-7' });
export interface NativeCapabilityOptions {
  sources: readonly NativeCapabilitySource[]; fetch: GitHubMarketplaceFetch; signal?: AbortSignal;
  /** Host/test seam only; absent means the actual project automation policy. */
  readPolicy?: (root: string) => { network_policy?: 'local-only' | 'remote-enabled' };
  /** Host checks its current User policy, workspace ownership and disposal. */
  isCurrent?: () => boolean;
}
class CapabilityRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}
function deny(code: string): never { throw new CapabilityRefusal(code); }
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fallback = (action: string, reason: string) => ({ action, state: reason === 'CANCELLED' ? 'cancelled' : 'unavailable', reason,
  fallback: 'ordinary-work' as const, candidates: [], authorization: 'not-granted' as const, installation: 'not-performed' as const,
  retryable: false as const,
  next_action: 'Continue the user request with ordinary project tools. Do not repeat this unchanged optional capability call; select another advertised capability only when its supported source/package/skill differs.',
  ...(reason === 'UNSUPPORTED_SKILL_LAYOUT' ? { diagnostic: 'The pinned manifest has neither supported explicit skill roots nor a recognized portable default layout. Do not guess source paths.' } : {}),
  loaded: 'not-observed' as const, used: 'not-observed' as const, verified: 'not-observed' as const });
const provenance = (source: NativeCapabilitySource) => ({ repository: source.repository, commit: source.commit,
  path: source.catalog_path, sha256: source.catalog_sha256 });
const catalogId = (source: NativeCapabilitySource) => `native-approved/${source.name}`;
function fileBytes(file: AgentSourceFile, repository: string, commit: string, path: string, limit: number): Buffer {
  if (file.repository !== repository || file.commit !== commit || file.path !== path) deny('SOURCE_PIN_MISMATCH');
  if (file.kind !== 'file' || file.complete !== true || typeof file.content !== 'string' && !(file.content instanceof Uint8Array)) deny('SOURCE_INCOMPLETE');
  const bytes = Buffer.from(file.content);
  if (bytes.length > limit) deny('BOUND_EXCEEDED');
  return bytes;
}
function requiredDependencies(value: unknown, depth = 0): boolean {
  if (!object(value) || depth > 3) return false;
  for (const [name, entry] of Object.entries(value)) {
    const key = name.replace(/[-_]/g, '').toLowerCase();
    const present = entry !== undefined && entry !== null && entry !== false &&
      (typeof entry !== 'string' || !!entry.trim()) && (!Array.isArray(entry) || entry.length > 0) &&
      (!object(entry) || Object.keys(entry).length > 0);
    if (present && ['dependencies', 'requireddependencies', 'requires', 'requiredtools', 'requiredmcpservers',
      'mcpservers', 'lspservers', 'npm', 'installcommands', 'setupcommands'].includes(key)) return true;
    if (object(entry) && requiredDependencies(entry, depth + 1)) return true;
  }
  return false;
}
function skillHeader(bytes: Buffer) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return deny('INVALID_SKILL'); }
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!header || header.length > 16 * 1024) deny('INVALID_SKILL');
  try {
    const parsed = parseDocument(header, { uniqueKeys: true });
    if (parsed.errors.length) deny('INVALID_SKILL');
    const value: unknown = parsed.toJS({ maxAliasCount: 0 });
    if (!object(value) || typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.name) ||
        typeof value.description !== 'string' || !value.description.trim()) deny('INVALID_SKILL');
    return { name: value.name, requires: requiredDependencies(value), metadata: value };
  } catch (error) { if (error instanceof CapabilityRefusal) throw error; return deny('INVALID_SKILL'); }
}
/** A bounded local-reference check, not whole-plugin dependency qualification. */
function markdownReferences(bytes: Buffer, path: string, root: string, inventory: ReadonlySet<string>): void {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return deny('UNSUPPORTED_SKILL_REFERENCE'); }
  text = text.replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\2[ \t]*(?=\n|$)/g, '$1')
    .replace(/`[^`\n]*`/g, '');
  const references: string[] = [];
  text = text.replace(/!?\[[^\]\n]*\]\(\s*(?:<([^<>\n]+)>|([^\s)\n]+))(?:[ \t]+["'][^"'\n]*["'])?\s*\)/g,
    (_all, angle: string | undefined, plain: string | undefined) => { references.push(angle ?? plain!); return ''; });
  text = text.replace(/^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:\s*(?:<([^<>\n]+)>|(\S+))/gm,
    (_all, angle: string | undefined, plain: string | undefined) => { references.push(angle ?? plain!); return ''; });
  if (/\]\s*\(|<[^>]+\b(?:href|src)\s*=/i.test(text) || references.length > 256) deny('UNSUPPORTED_SKILL_REFERENCE');
  for (const reference of references) {
    if (/^(?:https?:|mailto:|#)/i.test(reference)) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(reference.split(/[?#]/)[0]!); } catch { return deny('UNSUPPORTED_SKILL_REFERENCE'); }
    if (!decoded || /[\\:{}\u0000-\u001f]/.test(decoded) || decoded.startsWith('/')) deny('UNSUPPORTED_SKILL_REFERENCE');
    const target = posix.normalize(posix.join(posix.dirname(path), decoded));
    if (!target.startsWith(root + '/') || !inventory.has(target)) deny('UNSUPPORTED_SKILL_REFERENCE');
  }
}

/** Optional service: failures return ordinary-work fallback, never a workflow gate. */
export async function manageNativeCapabilities(root: string, input: unknown, options: NativeCapabilityOptions) {
  const parsed = nativeCapabilityInputSchema.safeParse(input);
  if (!parsed.success) return fallback('unknown', 'INVALID_INPUT');
  const request = parsed.data;
  const policies = z.array(sourceSchema).max(32).safeParse(options?.sources);
  if (!policies.success || new Set(policies.data.map(source => source.name)).size !== policies.data.length)
    return fallback(request.action, 'INVALID_SOURCE_POLICY');
  if (typeof options.fetch !== 'function') return fallback(request.action, 'TRANSPORT_REQUIRED');
  const controller = new AbortController(), cancel = () => controller.abort();
  let timedOut = false, refusal: string | undefined;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000); timer.unref();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const refuse = (code: string): never => { refusal = code; return deny(code); };
  const current = () => {
    if (options.signal?.aborted || controller.signal.aborted) refuse(timedOut ? 'TIMEOUT' : 'CANCELLED');
    if (options.isCurrent) {
      let allowed = false;
      try { allowed = options.isCurrent() === true; } catch { /* Changed or unavailable host authority is not approval. */ }
      if (!allowed) refuse('CAPABILITY_POLICY_CHANGED');
    }
  };
  const network = () => {
    current();
    if ((options.readPolicy ?? readAutomationPolicy)(root).network_policy !== 'remote-enabled') refuse('NETWORK_DISABLED');
  };
  try {
    current();
    const sources = request.source ? policies.data.filter(source => source.name === request.source) : policies.data;
    if (request.source && !sources.length) deny('SOURCE_NOT_APPROVED');
    if (request.action === 'status') {
      const status = listWorkspaceSkillComponents(root, { ...(request.skill ? { exact_name: request.skill } : {}), limit: 10 });
      return { action: request.action, state: status.state, fallback: 'ordinary-work' as const,
        approved_sources: policies.data.map(source => ({ name: source.name, allow_skills: source.allow_skills })),
        components: status.components.filter(component => !request.source || sources.some(source =>
          source.repository === component.source.repository && source.commit === component.source.commit)).map(component => ({ ...component, source_policy: policies.data.find(source =>
          source.repository === component.source.repository && source.commit === component.source.commit)?.name ?? null })),
        issues: status.issues, installation: 'not-performed' as const, authorization: 'not-granted' as const };
    }
    if (!sources.length) deny('NO_APPROVED_SOURCES');
    const expected = sources.map(source => ({ catalog_id: catalogId(source), provenance: provenance(source) }));
    const readers = new Map<string, ReturnType<typeof createGitHubAgentMarketplaceReader>>();
    const read = (source: NativeCapabilitySource) => {
      let reader = readers.get(source.name);
      if (!reader) {
        reader = createGitHubAgentMarketplaceReader({ allowed_repositories: [source.repository], fetch: async (url, init) => {
          network(); const result = await options.fetch(url, init); current(); return result;
        } }); readers.set(source.name, reader);
      }
      return reader;
    };
    const checkedReader = (source: NativeCapabilitySource, captures?: Map<string, Buffer>): AgentMarketplaceReader => async item => {
      try {
        current();
        if (item.repository !== source.repository || item.commit !== source.commit) refuse('SOURCE_NOT_APPROVED');
        const file = await read(source)(item), bytes = fileBytes(file, source.repository, source.commit, item.path, item.max_bytes);
        current();
        if (item.path === source.catalog_path && sha(bytes) !== source.catalog_sha256) refuse('CATALOG_HASH_MISMATCH');
        captures?.set(item.path, bytes);
        return { ...file, content: bytes };
      } catch (error) { if (error instanceof CapabilityRefusal) refusal = error.code; throw error; }
    };
    const discover = async (source: NativeCapabilitySource) => {
      const discovered = await discoverAgentMarketplace({ ...source, catalog_path: source.catalog_path }, checkedReader(source), { signal: controller.signal });
      if (discovered.status !== 'complete' || discovered.provenance.sha256 !== source.catalog_sha256) deny('INCOMPLETE_CATALOG');
      current(); saveAgentMarketplaceCatalog(root, { catalog_id: catalogId(source), provenance: provenance(source), candidates: discovered.candidates });
      return discovered.candidates;
    };
    if (request.action === 'search') {
      const cached = findAgentMarketplaceCandidates(root, { request: request.query!, expected_sources: expected, limit: 5 });
      const supportedCached = cached.candidates.flatMap(candidate => {
          const source = sources.find(source => catalogId(source) === candidate.catalog_id);
          return source && candidate.package.repository === source.repository && candidate.package.commit === source.commit
            ? [{ ...candidate, source_name: source.name }] : [];
        });
      if (cached.state === 'available') return { action: request.action, ...cached, origin: 'verified-local-cache' as const, candidates: supportedCached };
      const candidates: (AgentMarketplaceCandidate & { source_name: string })[] = [...supportedCached];
      const issues: { source_name: string; code: string }[] = [];
      const refresh = sources.filter(source => cached.issues.some(issue => !issue.catalog_id || issue.catalog_id === catalogId(source)));
      for (const source of refresh.length ? refresh : sources) {
        try {
          for (const candidate of await discover(source)) if (candidate.package.repository === source.repository && candidate.package.commit === source.commit)
            candidates.push({ ...candidate, source_name: source.name });
        } catch (error) {
          current();
          const code = refusal ?? (error instanceof CapabilityRefusal ? error.code : 'OPTIONAL_SOURCE_UNAVAILABLE');
          issues.push({ source_name: source.name, code }); refusal = undefined;
        }
      }
      if (!candidates.length && issues.length) return { ...fallback(request.action, issues[0]!.code), issues };
      const tokens = request.query!.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const ranked = candidates.map(candidate => ({ candidate, score: tokens.filter(token =>
        `${candidate.name} ${candidate.description}`.toLowerCase().includes(token)).length }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name)).slice(0, 5);
      current();
      return { action: request.action, state: issues.length ? 'partial' : ranked.length ? 'available' : 'no-match', candidates: ranked.map(item => item.candidate), issues,
        fallback: 'ordinary-work' as const, authorization: 'not-granted' as const, installation: 'not-performed' as const };
    }
    if (sources.length !== 1) return { ...fallback(request.action, 'SELECT_APPROVED_SOURCE'), available_sources: sources.map(source => source.name) };
    const source = sources[0]!;
    const cached = readAgentMarketplaceCandidate(root, { catalog_id: catalogId(source), name: request.package!, provenance: provenance(source) });
    let candidate = cached.state === 'available' ? cached.candidate : undefined;
    if (!candidate && cached.state !== 'available') candidate = (await discover(source)).find(item => item.name === request.package);
    if (!candidate) deny('PACKAGE_NOT_FOUND');
    if (candidate.name !== request.package || candidate.package.repository !== source.repository || candidate.package.commit !== source.commit)
      deny('SOURCE_NOT_APPROVED');
    const captures = new Map<string, Buffer>();
    const inspected = await inspectAgentMarketplacePlugin(candidate, checkedReader(source, captures), { signal: controller.signal });
    current();
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captures.get(inspected.manifest.path)!));
    const portable = inspectPortableAgentPluginLayout(manifest, candidate.package.path);
    const unsupported = requiredDependencies(manifest) || inspected.components.some(component => ['mcpServers', 'lspServers', 'hooks'].includes(component.kind));
    const cacheInspection = { ...inspected, components: inspected.components.map(component => ({ ...component,
      kind: z.enum(['skills', 'agents', 'instructions', 'prompts', 'commands', 'hooks', 'mcpServers', 'lspServers']).parse(component.kind) })) };
    current(); saveAgentCapabilityCatalog(root, { catalog_id: catalogId(source), provenance: provenance(source),
      plugins: [{ inspection: cacheInspection, role_hints: request.role ? [request.role] : [] }] });
    if (request.action === 'inspect' && !request.skill) return { action: request.action, state: 'available', source: source.name, inspection: inspected,
      ...(portable ? { portable_layout: portable } : {}),
      skill_installation: source.allow_skills && !unsupported ? 'eligible-for-explicit-selection' : 'unsupported',
      skill_contents: 'not-read' as const, fallback: 'ordinary-work' as const,
      authorization: 'not-granted' as const, installation: 'not-performed' as const };
    if (request.action === 'install' && !source.allow_skills) deny('SKILL_INSTALLATION_NOT_APPROVED');
    if (unsupported) deny('UNSUPPORTED_REQUIRED_COMPONENTS');
    if (portable) {
      current();
      try {
        await read(source).resolvePath({ repository: source.repository, commit: source.commit, path: portable.mcp_configuration,
          max_bytes: 1024 * 1024, signal: controller.signal });
        deny('UNSUPPORTED_REQUIRED_COMPONENTS');
      } catch (error) { if (!object(error) || error.reason !== 'not-found') throw error; }
      current();
    }
    const roots = portable ? [portable.skills_directory] : [...new Set(inspected.components.filter(component => component.kind === 'skills' && !component.inline)
      .flatMap(component => component.paths).map(path => path.endsWith('/SKILL.md') ? path.slice(0, -9) : path))];
    if (!roots.length || roots.length > 32) deny('UNSUPPORTED_SKILL_LAYOUT');
    const inventory = new Map<string, { path: string; blob_sha: string; size: number }>();
    for (const path of roots) {
      current();
      const files = await read(source).listFiles({ repository: source.repository, commit: source.commit, path,
        max_bytes: 8 * 1024 * 1024, signal: controller.signal });
      if (!files.complete || files.repository !== source.repository || files.commit !== source.commit || files.path !== path) deny('SOURCE_PIN_MISMATCH');
      for (const file of files.files) inventory.set(file.path, file);
      if (inventory.size > 256 || [...inventory.values()].reduce((total, file) => total + file.size, 0) > 8 * 1024 * 1024) deny('BOUND_EXCEEDED');
    }
    // The portable standards require immediate children and name===directory.
    // The model selects a name; the host constructs and verifies this one path.
    const documents = portable ? [`${portable.skills_directory}/${request.skill}/SKILL.md`].filter(path => inventory.has(path))
      : [...inventory.keys()].filter(path => path.endsWith('/SKILL.md'));
    if (documents.length > 32) deny('BOUND_EXCEEDED');
    const matches: { path: string; requires: boolean; metadata: Record<string, unknown> }[] = [], contents = new Map<string, Buffer>();
    for (const path of documents) {
      const file = await checkedReader(source)({ repository: source.repository, commit: source.commit, path,
        max_bytes: 1024 * 1024, signal: controller.signal });
      const bytes = fileBytes(file, source.repository, source.commit, path, 1024 * 1024); contents.set(path, bytes);
      const header = skillHeader(bytes);
      if (header.name === request.skill) matches.push({ path, requires: header.requires, metadata: header.metadata });
    }
    if (matches.length !== 1) deny(matches.length ? 'AMBIGUOUS_SKILL' : 'SKILL_NOT_FOUND');
    const skillRoot = matches[0]!.path.slice(0, -9), selected = [...inventory.values()].filter(file => file.path.startsWith(skillRoot + '/'));
    const selectedPaths = new Set(selected.map(file => file.path));
    markdownReferences(contents.get(matches[0]!.path)!, matches[0]!.path, skillRoot, selectedPaths);
    if (request.action === 'inspect') {
      const selected = matches[0]!, bytes = contents.get(selected.path)!, text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { action: request.action, state: 'available', source: source.name, inspection: inspected,
        skill: { name: request.skill, source_path: selected.path, sha256: sha(bytes), bytes: bytes.length,
          preview: text.slice(0, 8000), preview_truncated: text.length > 8000,
          declared_dependencies: { unsupported_required: selected.requires, frontmatter: selected.metadata },
          content: 'read-at-approved-pin' as const, reference_check: 'bounded-relative-markdown-inventory' as const },
        skill_installation: source.allow_skills && !selected.requires ? 'eligible-for-explicit-selection' : 'unsupported',
        fallback: 'ordinary-work' as const, authorization: 'not-granted' as const, installation: 'not-performed' as const };
    }
    if (matches[0]!.requires) deny('UNSUPPORTED_REQUIRED_COMPONENTS');
    if (!selected.length || selected.length > 128 || selected.some(file => file.path.endsWith('/SKILL.md') && file.path !== matches[0]!.path))
      deny('UNSUPPORTED_SKILL_LAYOUT');
    const license = await checkedReader(source)({ repository: source.repository, commit: source.commit, path: source.license_path,
      max_bytes: 64 * 1024, signal: controller.signal });
    const licenseBytes = fileBytes(license, source.repository, source.commit, source.license_path, 64 * 1024);
    if (sha(licenseBytes) !== source.license_sha256) deny('LICENSE_HASH_MISMATCH');
    contents.set(source.license_path, licenseBytes);
    for (const file of selected) {
      const bytes = contents.get(file.path) ?? fileBytes(await checkedReader(source)({ repository: source.repository, commit: source.commit,
        path: file.path, max_bytes: 1024 * 1024, signal: controller.signal }), source.repository, source.commit, file.path, 1024 * 1024);
      if (bytes.length !== file.size) deny('SOURCE_INCOMPLETE');
      contents.set(file.path, bytes);
    }
    for (const file of selected) if (/\.md$/i.test(file.path)) markdownReferences(contents.get(file.path)!, file.path, skillRoot, selectedPaths);
    network();
    const installed = await installWorkspaceSkillComponents(root, { approved: true, repository: source.repository, commit: source.commit,
      license_path: source.license_path, skills: [{ source_path: skillRoot, target_name: request.skill!, files: selected.map(file => file.path) }] }, async item => {
      current();
      if (item.repository !== source.repository || item.commit !== source.commit || !contents.has(item.path)) deny('SOURCE_PIN_MISMATCH');
      return { ...item, kind: 'file', complete: true, content: contents.get(item.path)! };
    }, { signal: controller.signal, authorize: options.isCurrent });
    return { action: request.action, state: 'installed', source: source.name, name: request.skill,
      changed: installed.changed, installation_scope: installed.installation_scope, plugin_installation: 'not-performed' as const,
      package_completeness: 'not-established' as const, dependency_scope: 'declared-metadata-and-relative-markdown-references' as const,
      host_loading: 'unverified' as const, execution: 'not-performed' as const, fallback: 'ordinary-work' as const,
      files: selected.map(file => ({ path: file.path, sha256: sha(contents.get(file.path)!) })), license_sha256: sha(licenseBytes) };
  } catch (error) {
    const code = refusal ?? (error instanceof CapabilityRefusal ? error.code : object(error) && typeof error.code === 'string' ? error.code : 'OPTIONAL_CAPABILITY_UNAVAILABLE');
    return fallback(request.action, timedOut ? 'TIMEOUT' : options.signal?.aborted ? 'CANCELLED' : code === 'POLICY_CHANGED' ? 'CAPABILITY_POLICY_CHANGED' : code);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
