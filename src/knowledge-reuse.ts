import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  atomicWrite, createRecord, getRecord, hash, loadRecords, safePath,
} from './storage.js';
import type { ProjectRecord } from './types.js';

/** GET-only, synchronous gh api seam; thrown authentication/network errors are blockers. */
export type KnowledgeReuseRequest = (method: string, endpoint: string) => unknown;
export interface KnowledgeSearchInput {
  platforms: string[];
  frameworks: string[];
  query?: string;
}
export interface ProjectKnowledgeSource {
  source_id: string;
  title: string;
  score: number;
  repo: string;
  branch: string;
  commit: string;
  path: string;
  sha256: string;
  narrative: string;
}
export interface KnowledgeResearchInput {
  platforms: string[];
  frameworks: string[];
  workspace_paths: string[];
  queries: string[];
  selected_sources: { source_id: string; applicability: string; differences: string }[];
  rejected_sources?: { source_id: string; reason: string }[];
  no_match_reason?: string;
  summary: string;
}
interface Note {
  schema_version: 1;
  schema: 'neomind-project-knowledge-note' | 'taskforces-project-knowledge-note';
  title: string;
  platforms: string[];
  frameworks: string[];
  applicability: string[];
  provenance: string[];
  artifact_path: string;
  sha256: string;
}
interface CachedSource {
  schema_version: 1;
  schema: 'neomind-project-knowledge-cache' | 'taskforces-project-knowledge-cache';
  source_id: string;
  repo: string;
  branch: string;
  commit: string;
  path: string;
  sha256: string;
  entry: Note;
}
interface VerifiedSource extends CachedSource { narrative: string }

const cache = '.neomind/knowledge-cache';
const digest = /^[a-f0-9]{64}$/;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const notePattern = /^knowledge\/projects\/([a-f0-9]{64})\/notes\/[a-z][a-z0-9-]{0,63}\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\.md$/;
const manifestPattern = /^knowledge\/projects\/[a-f0-9]{64}\/manifest\.json$/;
const maxFile = 512 * 1024;
const maxResponse = 8 * 1024 * 1024;
const maxSources = 100;
const maxCached = 1000;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, minimum = 1, maximum = 20000): string {
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(value))
    throw new Error(`${label} must contain ${minimum}-${maximum} characters of text.`);
  return value.trim();
}
function rationale(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (/\b(?:TODO|TBD|placeholder|lorem ipsum)\b/i.test(result) ||
    new Set(result.toLowerCase().match(/\p{L}+/gu) ?? []).size < 6)
    throw new Error(`${label} needs a substantive rationale.`);
  return result;
}
function list(value: unknown, label: string, required = false): string[] {
  if (!Array.isArray(value) || value.length > 50 || (required && !value.length))
    throw new Error(`${label} must be a bounded${required ? ' nonempty' : ''} string array.`);
  const values = value.map((item) => text(item, label, 1, 500));
  if (new Set(values.map((item) => item.toLowerCase())).size !== values.length)
    throw new Error(`${label} contains duplicate strings.`);
  return values;
}
function searchInput(value: KnowledgeSearchInput): KnowledgeSearchInput {
  const input = object(value, 'Knowledge search');
  return {
    platforms: list(input.platforms, 'platforms', true),
    frameworks: list(input.frameworks, 'frameworks'),
    ...(input.query === undefined ? {} : { query: text(input.query, 'query', 1, 2000) }),
  };
}
function repository(value: unknown): string {
  if (typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..'))
    throw new Error('Knowledge upstream must be a safe owner/repository name, without credentials.');
  return value;
}
function branch(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 ||
    !/^(?:neomind|taskforces)\/knowledge\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) ||
    value.includes('..') || value.includes('//'))
    throw new Error('Unsafe project knowledge branch.');
  return value;
}
function commit(value: unknown): string {
  if (typeof value !== 'string' || !commitPattern.test(value))
    throw new Error('Knowledge branch must pin a full commit SHA.');
  return value;
}
export function projectKnowledgeArtifactPath(value: unknown): string { return artifactPath(value); }
function artifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 400 || !notePattern.test(value) ||
    /\/(?:private|secrets?|credentials?|passwords?|tokens?)(?:\/|-)/i.test(value))
    throw new Error('Unsafe project knowledge artifact path.');
  return value;
}
/** safePath rejects escape; additionally reject even in-workspace symbolic links. */
function localPath(root: string, path: string): string {
  if (!path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\x00-\x1f\x7f:]/.test(path)) throw new Error('Unsafe project-relative path.');
  const target = safePath(root, path);
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const ancestor = safePath(root, parts.slice(0, index).join('/'));
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Symbolic links are not allowed in knowledge inputs.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
function readBounded(root: string, path: string, maximum = maxFile): Buffer {
  const target = localPath(root, path);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > maximum) throw new Error(`Knowledge file exceeds bounds or is not a file: ${path}`);
  const bytes = readFileSync(target);
  if (bytes.length > maximum) throw new Error(`Knowledge file exceeds bounds: ${path}`);
  return bytes;
}
function publicContent(value: string): void {
  if (/(?:file:\/\/|\b[a-z]:[\\/]|\.(?:neomind|taskforces|verythinker)[\\/]|(?:^|[\s"'/(])\.env(?:\b|\.)|~\/[.]ssh\/|\/(?:home|Users)\/[^\s/]+\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b|\b(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S+)/i.test(value))
    throw new Error('Remote knowledge contains secret or private content.');
}
function note(value: unknown): Note {
  const input = object(value, 'Remote knowledge note');
  if (input.schema_version !== 1 ||
    !['neomind-project-knowledge-note', 'taskforces-project-knowledge-note'].includes(String(input.schema)))
    throw new Error('Unsupported project knowledge note schema.');
  const result: Note = {
    // Preserve a historical source's discriminator so existing provenance hashes stay valid.
    schema_version: 1, schema: input.schema as Note['schema'],
    title: text(input.title, 'title', 1, 500),
    platforms: list(input.platforms, 'platforms'), frameworks: list(input.frameworks, 'frameworks'),
    applicability: list(input.applicability, 'applicability', true),
    provenance: list(input.provenance, 'provenance', true),
    artifact_path: artifactPath(input.artifact_path),
    sha256: typeof input.sha256 === 'string' && digest.test(input.sha256) ? input.sha256 : '',
  };
  if (!result.sha256 || result.title.includes('\n')) throw new Error('Invalid note hash or title.');
  publicContent(JSON.stringify(result));
  return result;
}
function configuredRepository(root: string): string {
  const policyPath = '.neomind/automation.json';
  if (existsSync(localPath(root, policyPath))) {
    const policy = object(JSON.parse(readBounded(root, policyPath).toString('utf8')), 'Automation policy');
    if (policy.schema_version !== 1) throw new Error('Unsupported automation policy schema.');
    if (policy.network_policy !== undefined &&
      !['local-only', 'remote-enabled'].includes(policy.network_policy as string))
      throw new Error('Invalid automation network_policy.');
    if (policy.network_policy === 'local-only')
      throw new Error('Local-only policy disables remote knowledge discovery. Use local knowledge search, or set network_policy to "remote-enabled" in .neomind/automation.json to opt in.');
    return repository(policy.upstream);
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const upstream = typeof url === 'string'
    ? /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url)?.[1] : undefined;
  return repository(upstream);
}
function githubRequest(method: string, endpoint: string): unknown {
  if (method !== 'GET') throw new Error('Knowledge discovery permits GET requests only.');
  const result = spawnSync('gh', ['api', '--method', 'GET', endpoint], {
    shell: false, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: maxResponse,
  });
  // Do not persist/echo potentially credential-bearing stderr or headers.
  if (result.error || result.status !== 0)
    throw new Error(`Remote knowledge discovery failed (gh api exit ${result.status ?? 'unavailable'}); check authentication and connectivity.`);
  return JSON.parse(result.stdout);
}
function response(request: KnowledgeReuseRequest, endpoint: string): unknown {
  const value = request('GET', endpoint);
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > maxResponse)
    throw new Error('Remote knowledge response exceeds bounds.');
  return value;
}
function remoteFile(request: KnowledgeReuseRequest, repo: string, sha: string, path: string): string {
  const value = object(response(request, `repos/${repo}/contents/${path}?ref=${sha}`), 'Remote contents');
  if (value.encoding !== 'base64' || typeof value.content !== 'string' ||
    (value.type !== undefined && value.type !== 'file') ||
    (value.path !== undefined && value.path !== path) ||
    (value.size !== undefined && (typeof value.size !== 'number' || value.size < 0 || value.size > maxFile)))
    throw new Error('Remote knowledge must be a bounded base64 file.');
  const encoded = value.content.replace(/[\r\n]/g, '');
  if (encoded.length > Math.ceil(maxFile / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error('Remote knowledge base64 exceeds bounds or is malformed.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maxFile || bytes.toString('base64') !== encoded ||
    (value.size !== undefined && value.size !== bytes.length)) throw new Error('Remote knowledge file size/encoding mismatch.');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content).equals(bytes)) throw new Error('Remote knowledge must be valid UTF-8.');
  return content;
}
const sourceId = (repo: string, sha: string, path: string) => hash(JSON.stringify([repo, sha, path]));
const fingerprint = (source: CachedSource) => hash(JSON.stringify(source));
function verifyCache(root: string, id: string): VerifiedSource {
  if (!digest.test(id)) throw new Error('Invalid knowledge source_id.');
  const data = object(JSON.parse(readBounded(root, `${cache}/${id}.json`).toString('utf8')), 'Knowledge cache');
  const entry = note(data.entry);
  if (!['neomind-project-knowledge-cache', 'taskforces-project-knowledge-cache'].includes(String(data.schema)))
    throw new Error(`Knowledge cache provenance mismatch: ${id}`);
  const source: CachedSource = {
    schema_version: 1, schema: data.schema as CachedSource['schema'], source_id: id,
    repo: repository(data.repo), branch: branch(data.branch), commit: commit(data.commit),
    path: artifactPath(data.path), sha256: entry.sha256, entry,
  };
  if (data.schema_version !== 1 || data.schema !== source.schema || data.source_id !== id ||
    data.sha256 !== entry.sha256 || source.path !== entry.artifact_path ||
    sourceId(source.repo, source.commit, source.path) !== id)
    throw new Error(`Knowledge cache provenance mismatch: ${id}`);
  const bytes = readBounded(root, `${cache}/${id}.md`);
  if (hash(bytes) !== source.sha256) throw new Error(`Knowledge source artifact hash mismatch: ${id}`);
  const narrative = bytes.toString('utf8');
  if (!Buffer.from(narrative).equals(bytes)) throw new Error('Cached knowledge must be valid UTF-8.');
  text(narrative, 'Knowledge narrative', 1, maxFile);
  publicContent(narrative);
  return { ...source, narrative };
}
function persistSource(root: string, source: CachedSource, narrative: string): void {
  const metadata = localPath(root, `${cache}/${source.source_id}.json`);
  if (existsSync(metadata)) {
    const existing = verifyCache(root, source.source_id);
    if (existing.sha256 !== source.sha256 || JSON.stringify(existing.entry) !== JSON.stringify(source.entry))
      throw new Error('Immutable knowledge source already has different content.');
    return;
  }
  const artifact = localPath(root, `${cache}/${source.source_id}.md`);
  if (existsSync(artifact)) {
    if (hash(readBounded(root, `${cache}/${source.source_id}.md`)) !== source.sha256)
      throw new Error('Existing knowledge artifact has different content.');
  } else atomicWrite(artifact, narrative);
  chmodSync(artifact, 0o444);
  atomicWrite(metadata, json(source));
  chmodSync(metadata, 0o444);
}
function cachedSources(root: string): VerifiedSource[] {
  const directory = localPath(root, cache);
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > maxCached * 2) throw new Error('Knowledge cache exceeds source bounds.');
  for (const item of entries) {
    if (!item.isFile() || !/^[a-f0-9]{64}\.(?:json|md)$/.test(item.name))
      throw new Error('Unexpected or symbolic-link entry in knowledge cache.');
  }
  // Detect incomplete/tampered pairs rather than silently treating them as no matches.
  const names = new Set(entries.map((item) => item.name));
  for (const name of names) {
    const companion = name.endsWith('.json') ? name.replace(/\.json$/, '.md') : name.replace(/\.md$/, '.json');
    if (!names.has(companion)) throw new Error('Knowledge cache contains an incomplete source pair.');
  }
  return [...names].filter((name) => name.endsWith('.json')).sort()
    .map((name) => verifyCache(root, name.slice(0, -5)));
}

/** Fetch sanitized notes at immutable commits; never interpret remote text as instructions. */
export function discoverProjectKnowledge(root: string,
  input: KnowledgeSearchInput & { repository?: string },
  request: KnowledgeReuseRequest = githubRequest): ProjectKnowledgeSource[] {
  const filter = searchInput(input);
  const repo = configuredRepository(root);
  if (input.repository !== undefined && repository(input.repository) !== repo)
    throw new Error('Discovery repository must match the configured automation upstream.');
  const branches: { name: string; sha: string }[] = [];
  let finished = false;
  const seen = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const values = response(request, `repos/${repo}/branches?per_page=100&page=${page}`);
    if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid bounded branch listing.');
    for (const value of values) {
      const item = object(value, 'Remote branch');
      if (typeof item.name !== 'string') throw new Error('Remote branch name is missing.');
      if (!/^(?:neomind|taskforces)\/knowledge\//.test(item.name)) continue;
      const name = branch(item.name);
      if (seen.has(name)) throw new Error('Branch pagination repeated a knowledge branch.');
      seen.add(name);
      branches.push({ name, sha: commit(object(item.commit, 'Branch commit').sha) });
      if (branches.length > 100) throw new Error('Knowledge discovery exceeds 100 branches.');
    }
    if (values.length < 100) { finished = true; break; }
  }
  if (!finished) throw new Error('Branch discovery exceeded ten pages; results would be incomplete.');
  // Stage all responses before durable writes so auth/truncation errors cannot become no-match success.
  const pending: { source: CachedSource; narrative: string }[] = [];
  let catalogCount = 0;
  for (const head of branches) {
    const tree = object(response(request, `repos/${repo}/git/trees/${head.sha}?recursive=1`), 'Remote knowledge tree');
    if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 20000)
      throw new Error('Remote knowledge tree is truncated, missing completeness, or exceeds bounds.');
    const files = new Set<string>();
    const companions: string[] = [];
    const manifests: string[] = [];
    for (const raw of tree.tree) {
      const item = object(raw, 'Tree entry');
      if (typeof item.path !== 'string') throw new Error('Tree entry path is missing.');
      const path = item.path;
      if (!path.startsWith('knowledge/projects/')) continue;
      if (item.type === 'tree') {
        if (!/^knowledge\/projects\/[a-f0-9]{64}(?:\/notes(?:\/[a-z][a-z0-9-]{0,63})?)?$/.test(path))
          throw new Error('Unsafe remote knowledge directory path.');
        continue;
      }
      if (item.type !== 'blob' || item.mode !== '100644' || files.has(path))
        throw new Error('Remote knowledge paths must be unique regular read-only inputs.');
      if (manifestPattern.test(path)) manifests.push(path);
      else if (path.endsWith('.json')) { artifactPath(path.replace(/\.json$/, '.md')); companions.push(path); }
      else artifactPath(path);
      if (typeof item.size === 'number' && item.size > maxFile) throw new Error('Remote knowledge file exceeds bounds.');
      files.add(path);
    }
    catalogCount += manifests.length;
    if (pending.length + companions.length > maxSources || catalogCount > maxSources)
      throw new Error('Knowledge discovery exceeds 100 sources/catalogs.');
    for (const path of files) {
      if (path.endsWith('.md') && !files.has(path.replace(/\.md$/, '.json')))
        throw new Error('Knowledge Markdown is missing its companion note schema.');
    }
    const catalogEntries = new Map<string, Note>();
    for (const path of manifests) {
      const catalog = object(JSON.parse(remoteFile(request, repo, head.sha, path)), 'Project knowledge catalog');
      if (catalog.schema_version !== 1 ||
        !['neomind-project-knowledge-catalog', 'taskforces-project-knowledge-catalog'].includes(String(catalog.schema)) ||
        !Array.isArray(catalog.notes) || catalog.notes.length > maxSources)
        throw new Error('Invalid project knowledge catalog schema/bounds.');
      for (const raw of catalog.notes) {
        const entry = note(raw);
        if (!entry.artifact_path.startsWith(path.slice(0, -'manifest.json'.length)) ||
          catalogEntries.has(entry.artifact_path) || !files.has(entry.artifact_path.replace(/\.md$/, '.json')))
          throw new Error('Catalog source path is inconsistent or missing its companion.');
        catalogEntries.set(entry.artifact_path, entry);
      }
    }
    for (const path of companions) {
      const entry = note(JSON.parse(remoteFile(request, repo, head.sha, path)));
      if (entry.artifact_path !== path.replace(/\.json$/, '.md') || !files.has(entry.artifact_path))
        throw new Error('Knowledge companion does not match its Markdown artifact.');
      const manifest = entry.artifact_path.split('/').slice(0, 3).join('/') + '/manifest.json';
      if (files.has(manifest) && JSON.stringify(catalogEntries.get(entry.artifact_path)) !== JSON.stringify(entry))
        throw new Error('Knowledge catalog and companion disagree.');
      const narrative = remoteFile(request, repo, head.sha, entry.artifact_path);
      text(narrative, 'Knowledge narrative', 1, maxFile);
      publicContent(narrative);
      if (hash(narrative) !== entry.sha256) throw new Error('Remote knowledge artifact hash mismatch.');
      pending.push({ narrative, source: {
        schema_version: 1, schema: 'neomind-project-knowledge-cache',
        source_id: sourceId(repo, head.sha, entry.artifact_path), repo, branch: head.name,
        commit: head.sha, path: entry.artifact_path, sha256: entry.sha256, entry,
      } });
    }
  }
  // Enforce the durable bound before adding files (including accumulated historical commits).
  const previous = cachedSources(root);
  if (new Set([...previous.map((item) => item.source_id), ...pending.map((item) => item.source.source_id)]).size > maxCached)
    throw new Error('Durable knowledge cache exceeds 1000 sources; archive it before discovery.');
  for (const item of pending) persistSource(root, item.source, item.narrative);
  const ids = new Set(pending.map((item) => item.source.source_id));
  // Return only this successful remote discovery, not stale cache matches from earlier calls.
  return indexedSearch(root, filter, maxSources, ids);
}

/** Rebuilt from verified durable bytes on every search: SQLite is disposable, never authoritative. */
function indexedSearch(root: string, input: KnowledgeSearchInput, limit: number,
  allowedIds?: ReadonlySet<string>): ProjectKnowledgeSource[] {
  const sources = cachedSources(root);
  const path = localPath(root, '.neomind/cache/knowledge.sqlite');
  // SQLite also opens these paths; reject pre-existing symlinks before opening the database.
  localPath(root, '.neomind/cache/knowledge.sqlite-wal');
  localPath(root, '.neomind/cache/knowledge.sqlite-shm');
  localPath(root, '.neomind/cache/knowledge.sqlite-journal');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sources(source_id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS narrative_search USING fts5(source_id UNINDEXED,title,narrative);
      BEGIN IMMEDIATE; DELETE FROM sources; DELETE FROM narrative_search;`);
    const insert = db.prepare('INSERT INTO sources VALUES(?,?)');
    const fts = db.prepare('INSERT INTO narrative_search VALUES(?,?,?)');
    for (const source of sources) {
      const { narrative, ...metadata } = source;
      insert.run(source.source_id, JSON.stringify(metadata));
      fts.run(source.source_id, source.entry.title, narrative);
    }
    db.exec('COMMIT;');
    const words = input.query?.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 30) ?? [];
    const matches = new Map<string, number>();
    if (words.length) {
      const expression = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' OR ');
      for (const row of db.prepare('SELECT source_id, bm25(narrative_search) AS rank FROM narrative_search WHERE narrative_search MATCH ?').all(expression))
        matches.set(String(row.source_id), Math.max(0, -Number(row.rank)));
    }
    const platforms = new Set(input.platforms.map((item) => item.toLowerCase()));
    const frameworks = new Set(input.frameworks.map((item) => item.toLowerCase()));
    return sources.flatMap((source): ProjectKnowledgeSource[] => {
      if (allowedIds && !allowedIds.has(source.source_id)) return [];
      const platform = source.entry.platforms.filter((item) => platforms.has(item.toLowerCase())).length;
      const framework = source.entry.frameworks.filter((item) => frameworks.has(item.toLowerCase())).length;
      const queryMatch = matches.has(source.source_id);
      if (!platform && !framework && !queryMatch) return [];
      const score = platform * 100 + framework * 50 + (queryMatch ? 10 + Math.min(9, matches.get(source.source_id)!) : 0);
      return [{ source_id: source.source_id, title: source.entry.title, score, repo: source.repo,
        branch: source.branch, commit: source.commit, path: source.path, sha256: source.sha256,
        narrative: source.narrative }];
    }).sort((a, b) => b.score - a.score || a.source_id.localeCompare(b.source_id)).slice(0, limit);
  } finally { db.close(); }
}

/** Similarity is a hint, not version compatibility or automatic applicability approval. */
export function searchProjectKnowledge(root: string, input: KnowledgeSearchInput, limit = 10): ProjectKnowledgeSource[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Knowledge search limit must be 1-100.');
  return indexedSearch(root, searchInput(input), limit);
}

function workflow(root: string, id: string): ProjectRecord {
  const record = getRecord(root, id);
  if (record.meta.type !== 'knowledge' || record.meta.data.kind !== 'manager-workflow')
    throw new Error('Knowledge research must belong to a manager-workflow knowledge record.');
  return record;
}
function workspacePath(root: string, value: unknown): string {
  const path = text(value, 'workspace path', 1, 500);
  if (path.split('/').some((part) => /^(?:\..*|node_modules|vendor|dist|build|coverage|secrets?|private|credentials?|certificates?|locks?)$/i.test(part)) ||
    /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*(?:credential|password|secret|token).*|.*(?:\.lock|\.lockb|\.lock\.json|\.sqlite(?:-wal|-shm)?|\.db|\.pem|\.key|\.p12|\.pfx|\.keystore)|(?:package-lock|npm-shrinkwrap)\.json|go\.sum|yarn\.lock|pnpm-lock\.yaml|.*\.env(?:\..*)?|.*\.tfstate(?:\..*)?)$/i.test(path))
    throw new Error('Sensitive, lock, generated, or managed workspace paths cannot be research inputs.');
  localPath(root, path);
  return path;
}
function researchInput(root: string, value: KnowledgeResearchInput): KnowledgeResearchInput {
  const input = object(value, 'Knowledge research');
  const classification = searchInput({ platforms: input.platforms as string[], frameworks: input.frameworks as string[] });
  const paths = list(input.workspace_paths, 'workspace_paths', true).map((path) => workspacePath(root, path));
  const queries = list(input.queries, 'research search queries', true);
  if (!Array.isArray(input.selected_sources) || input.selected_sources.length > maxSources ||
    (input.rejected_sources !== undefined && (!Array.isArray(input.rejected_sources) || input.rejected_sources.length > maxSources)))
    throw new Error('Selected/rejected sources must be bounded arrays.');
  const selected = input.selected_sources.map((value) => {
    const source = object(value, 'Selected source');
    return { source_id: text(source.source_id, 'source_id', 64, 64),
      applicability: rationale(source.applicability, 'Selected source applicability'),
      differences: rationale(source.differences, 'Selected source differences and version review') };
  });
  const rejected = (input.rejected_sources ?? []).map((value: unknown) => {
    const source = object(value, 'Rejected source');
    return { source_id: text(source.source_id, 'source_id', 64, 64), reason: rationale(source.reason, 'Rejected source reason') };
  });
  const ids = [...selected, ...rejected].map((source) => source.source_id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !digest.test(id)))
    throw new Error('Research sources must have unique valid source_ids.');
  if (selected.length && input.no_match_reason !== undefined)
    throw new Error('Selected sources cannot also claim no matching knowledge.');
  return { platforms: classification.platforms, frameworks: classification.frameworks,
    workspace_paths: paths, queries, selected_sources: selected, rejected_sources: rejected,
    ...(selected.length ? {} : { no_match_reason: rationale(input.no_match_reason, 'No-match reason') }),
    summary: rationale(input.summary, 'Research summary') };
}
function sourceReferences(root: string, input: KnowledgeResearchInput): Record<string, unknown>[] {
  return [...input.selected_sources, ...(input.rejected_sources ?? [])].map(({ source_id }) => {
    const { narrative: _narrative, ...source } = verifyCache(root, source_id);
    return { source_id, repo: source.repo, branch: source.branch, commit: source.commit,
      path: source.path, sha256: source.sha256, fingerprint: fingerprint(source) };
  });
}
/** Local record only. Applicability/differences (including versions) require explicit human/agent review. */
export function recordKnowledgeResearch(root: string, workflowId: string, input: KnowledgeResearchInput): ProjectRecord {
  const owner = workflow(root, workflowId);
  const validated = researchInput(root, input);
  const references = sourceReferences(root, validated);
  const workspace_hashes = Object.fromEntries(validated.workspace_paths.map((path) => [path, hash(readBounded(root, path, 2 * 1024 * 1024))]));
  return createRecord(root, {
    type: 'knowledge', owner: owner.meta.owner, title: `Preimplementation knowledge research: ${owner.meta.title}`,
    links: [{ type: 'documents', target: owner.meta.id }],
    body: `# Knowledge research\n\n${validated.summary}\n\nSimilarity is advisory; applicability, versions, and differences require manual review.\n`,
    data: { kind: 'knowledge-research', workflow_id: owner.meta.id, schema_version: 1,
      complete: true, ...validated, provenance_refs: references,
      source_fingerprints: Object.fromEntries(references.map((ref) => [String(ref.source_id), ref.fingerprint])),
      workspace_hashes },
  });
}

/** Workspace snapshots are a pre-planning baseline, not an implementation freeze. */
export function knowledgeResearchProblems(root: string, workflowId: string,
  options: { check_workspace?: boolean } = {}): string[] {
  try {
    const owner = workflow(root, workflowId);
    if (owner.meta.data.knowledge_research_required !== true) return [];
    const latest = loadRecords(root).filter((record) => record.meta.type === 'knowledge' &&
      record.meta.data.kind === 'knowledge-research' && record.meta.data.workflow_id === owner.meta.id)
      .sort((a, b) => b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id))[0];
    if (!latest) return ['Preimplementation knowledge research is required: inspect workspace paths, search, and record source applicability or a substantive no-match reason.'];
    const data = latest.meta.data;
    if (data.complete !== true || data.schema_version !== 1 || latest.meta.status === 'superseded' ||
      !latest.meta.links.some((link) => link.type === 'documents' && link.target === owner.meta.id))
      return ['Latest knowledge research is incomplete, superseded, or not linked to its workflow.'];
    const input = researchInput(root, data as unknown as KnowledgeResearchInput);
    const expected = sourceReferences(root, input);
    if (JSON.stringify(data.provenance_refs) !== JSON.stringify(expected) ||
      JSON.stringify(data.source_fingerprints) !== JSON.stringify(Object.fromEntries(expected.map((ref) => [String(ref.source_id), ref.fingerprint]))))
      return ['Knowledge research has stale source references or fingerprints; verify the durable sources and record research again.'];
    const hashes = object(data.workspace_hashes, 'Research workspace_hashes');
    if (Object.keys(hashes).length !== input.workspace_paths.length ||
      input.workspace_paths.some((path) => typeof hashes[path] !== 'string' || !digest.test(hashes[path] as string)))
      return ['Knowledge research workspace baseline is incomplete.'];
    if (options.check_workspace === true) {
      const changed = input.workspace_paths.filter((path) => hash(readBounded(root, path, 2 * 1024 * 1024)) !== hashes[path]);
      if (changed.length) return [`Knowledge research workspace baseline changed before planning: ${changed.join(', ')}. Inspect and record research again.`];
    }
    return [];
  } catch (error) {
    return [`Knowledge research validation failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}
