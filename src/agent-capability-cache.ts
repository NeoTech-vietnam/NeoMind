/** Optional discovery metadata only. Nothing here downloads, installs, loads,
 * invokes or verifies a plugin, or changes a request/record/permission. */
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { atomicWrite, hash, safePath } from './storage.js';
import { normalizeProcedureQuery } from './procedure-reuse.js';
import type { AgentMarketplaceCandidate } from './agent-marketplace.js';

const database = '.workforce/cache/agent-capabilities.sqlite';
const snapshots = '.workforce/cache/agent-capabilities';
const snapshotLimit = 2 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const repo = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    !/[\s\\@%]/.test(value) && url.pathname.split('/').slice(1).every(part => !!part && part !== '.' && part !== '..'); }
  catch { return false; }
});
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sourcePath = z.string().min(1).max(1024).refine(value => !/^[\/]|[\\:%?#\u0000-\u001f\u007f]/.test(value) &&
  value.split('/').every(part => !!part && part !== '.' && part !== '..' && part === part.trim() && !part.endsWith('.')));
const source = z.strictObject({ repository: repo, commit });
const provenance = source.extend({ path: sourcePath, sha256: digest });
const manifest = z.strictObject({ path: sourcePath, sha256: digest, bytes: z.number().int().nonnegative().max(512 * 1024) });
const component = z.strictObject({ namespace: identifier, kind: z.enum(['skills', 'agents', 'instructions', 'prompts', 'commands', 'hooks', 'mcpServers', 'lspServers']),
  paths: z.array(sourcePath).max(256), inline: z.boolean() });
const inspection = z.strictObject({
  state: z.literal('manifest-inspected'), name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i), source,
  catalog_provenance: provenance, package_pin_origin: z.enum(['catalog', 'supplied']), manifest,
  version: z.string().max(200).nullable(), description: z.string().max(2000), declared_license: z.string().max(200).nullable(),
  extensions: z.array(z.strictObject({ namespace: identifier, fields: z.array(identifier).max(100) })).max(32),
  components: z.array(component).max(128), compatibility: z.literal('unverified'), component_contents: z.literal('not-read'),
  license_verification: z.literal('not-performed'), authorization: z.literal('not-granted'), installation: z.literal('not-performed'),
});
const inputSchema = z.strictObject({ catalog_id: identifier, provenance,
  plugins: z.array(z.strictObject({ inspection, role_hints: z.array(identifier).max(20).default([]),
    keywords: z.array(identifier).max(40).default([]) })).max(1000),
}).superRefine((value, context) => {
  const names = new Set<string>();
  for (const plugin of value.plugins) {
    const name = plugin.inspection.name.toLowerCase();
    if (names.has(name) || JSON.stringify(plugin.inspection.catalog_provenance) !== JSON.stringify(value.provenance))
      context.addIssue({ code: 'custom', message: 'Duplicate plugin or inconsistent pinned catalog metadata.' });
    names.add(name);
    if (plugin.inspection.components.reduce((count, item) => count + item.paths.length, 0) > 256)
      context.addIssue({ code: 'custom', message: 'Component metadata exceeds its bound.' });
  }
});
const storedSchema = inputSchema.safeExtend({ schema_version: z.literal(1), observed_at: z.iso.datetime(), expires_at: z.iso.datetime() });
const querySchema = z.strictObject({ request: z.string().trim().min(1).max(20_000), role: identifier.optional(),
  limit: z.number().int().min(1).max(10).default(5),
  expected_sources: z.array(z.strictObject({ catalog_id: identifier, provenance })).max(32).default([]),
});
export type AgentCapabilityCatalogInput = z.input<typeof inputSchema>;
type Snapshot = z.output<typeof storedSchema>;
type Issue = { catalog_id?: string; code: 'EXPIRED' | 'SOURCE_PIN_CHANGED' | 'CATALOG_HASH_CHANGED' | 'SNAPSHOT_CHANGED' | 'SOURCE_NOT_CACHED' | 'CACHE_UNAVAILABLE' };

function clock(options: { now?: Date }): number {
  const now = options.now?.getTime() ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Use bounded capability cache time options.');
  return now;
}
function ordinary(path: string, directory: boolean, maxBytes = 128 * 1024 * 1024): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile() && info.nlink === 1 && info.size <= maxBytes))
      throw new Error('Capability cache paths must be bounded ordinary unlinked paths.');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function location(root: string, path: string, maxBytes?: number) {
  const target = safePath(root, path);
  let parent = resolve(root);
  for (const part of relative(parent, dirname(target)).split(/[\\/]/)) { parent = resolve(parent, part); ordinary(parent, true); }
  return { path: target, exists: ordinary(target, false, maxBytes) };
}
function indexLocation(root: string) {
  const found = location(root, database);
  for (const suffix of ['-journal', '-wal', '-shm']) location(root, database + suffix);
  return found;
}
const snapshotPath = (id: string) => `${snapshots}/${hash(id)}.json`;
function readSnapshot(root: string, id: string) {
  const found = location(root, snapshotPath(id), snapshotLimit);
  if (!found.exists) throw new Error('Missing capability snapshot.');
  const bytes = readFileSync(found.path), value = storedSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (value.catalog_id !== id) throw new Error('Snapshot identity differs.');
  return { value, sha256: hash(bytes) };
}
function narrative(value: string): string {
  return normalizeProcedureQuery(value)
    .replace(/\b(?:docs?|document(?:ation|ing)?|writing|readme|write-up|tai lieu)\b/g, 'documentation')
    .replace(/\b(?:tests?|testing|verification|checks?|kiem thu)\b/g, 'testing');
}
const stopWords = new Set('a an the of to in on and or for with from please i me my want prepare create make new add use'.split(' '));
function words(value: string) { return [...new Set((narrative(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !stopWords.has(word)))].slice(0, 40); }
function pluginNarrative(plugin: Snapshot['plugins'][number]) {
  return [plugin.inspection.name, plugin.inspection.description, ...plugin.keywords, ...plugin.inspection.components.map(item => item.kind)].join(' ');
}
const samePin = (a: z.output<typeof provenance>, b: z.output<typeof provenance>) => a.repository === b.repository && a.commit === b.commit && a.path === b.path;
const sameProvenance = (a: z.output<typeof provenance>, b: z.output<typeof provenance>) => samePin(a, b) && a.sha256 === b.sha256;
function beginCacheWrite(db: DatabaseSync) {
  db.exec(`PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS capability_catalogs(catalog_id TEXT PRIMARY KEY,snapshot_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capabilities(id INTEGER PRIMARY KEY,catalog_id TEXT NOT NULL,plugin_index INTEGER NOT NULL,roles TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS capability_search USING fts5(narrative);
    CREATE TABLE IF NOT EXISTS marketplace_catalogs(catalog_id TEXT PRIMARY KEY,snapshot_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS marketplace_entries(id INTEGER PRIMARY KEY,catalog_id TEXT NOT NULL,entry_index INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS marketplace_search USING fts5(narrative);`);
}
function checkSourceBound(db: DatabaseSync, id: string) {
  const rows = db.prepare('SELECT catalog_id FROM capability_catalogs UNION SELECT catalog_id FROM marketplace_catalogs LIMIT 33').all();
  if (rows.length > 32 || rows.length === 32 && !rows.some(row => row.catalog_id === id)) throw new Error('Optional cache catalog bound reached.');
}

/** Writes current metadata and its derived index. Immutable-pin conflicts are
 * diagnostics; they never authorize replacing plugin code or project products. */
export function saveAgentCapabilityCatalog(root: string, input: AgentCapabilityCatalogInput, options: { now?: Date; ttl_ms?: number } = {}) {
  const parsed = inputSchema.safeParse(input), now = clock(options), ttl = options.ttl_ms ?? 86_400_000;
  if (!parsed.success) throw new Error('Use bounded pinned capability metadata without execution claims.');
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 30 * 86_400_000) throw new Error('Use bounded capability cache time options.');
  let saved = storedSchema.parse({ ...parsed.data, schema_version: 1, observed_at: new Date(now).toISOString(), expires_at: new Date(now + ttl).toISOString() });
  let payload = JSON.stringify(saved) + '\n';
  if (Buffer.byteLength(payload) > snapshotLimit) throw new Error('Use bounded pinned capability metadata.');
  let db: DatabaseSync | undefined;
  try {
    const target = indexLocation(root); mkdirSync(dirname(target.path), { recursive: true }); indexLocation(root);
    db = new DatabaseSync(target.path);
    beginCacheWrite(db);
    const prior = db.prepare('SELECT snapshot_hash FROM capability_catalogs WHERE catalog_id=?').get(saved.catalog_id);
    if (prior) {
      const previous = readSnapshot(root, saved.catalog_id);
      if (previous.sha256 !== prior.snapshot_hash) throw new Error('Optional source metadata changed.');
      const conflict = samePin(previous.value.provenance, saved.provenance) && previous.value.provenance.sha256 !== saved.provenance.sha256 ||
        saved.plugins.some(plugin => previous.value.plugins.some(old => old.inspection.source.repository === plugin.inspection.source.repository &&
          old.inspection.source.commit === plugin.inspection.source.commit && old.inspection.manifest.path === plugin.inspection.manifest.path &&
          old.inspection.manifest.sha256 !== plugin.inspection.manifest.sha256));
      if (conflict) return { state: 'unavailable' as const, issue: 'IMMUTABLE_SOURCE_CONFLICT' as const };
      if (sameProvenance(previous.value.provenance, saved.provenance)) {
        const plugins = new Map(previous.value.plugins.map(plugin => [plugin.inspection.name.toLowerCase(), plugin]));
        for (const plugin of saved.plugins) plugins.set(plugin.inspection.name.toLowerCase(), plugin);
        saved = storedSchema.parse({ ...saved, plugins: [...plugins.values()] });
        payload = JSON.stringify(saved) + '\n';
        if (Buffer.byteLength(payload) > snapshotLimit) throw new Error('Optional source metadata exceeds its bound.');
      }
    }
    checkSourceBound(db, saved.catalog_id);
    db.prepare('DELETE FROM capability_search WHERE rowid IN (SELECT id FROM capabilities WHERE catalog_id=?)').run(saved.catalog_id);
    db.prepare('DELETE FROM capabilities WHERE catalog_id=?').run(saved.catalog_id);
    for (const [index, plugin] of saved.plugins.entries()) {
      const row = db.prepare('INSERT INTO capabilities(catalog_id,plugin_index,roles) VALUES(?,?,?)').run(saved.catalog_id, index, JSON.stringify(plugin.role_hints));
      db.prepare('INSERT INTO capability_search(rowid,narrative) VALUES(?,?)').run(row.lastInsertRowid, narrative(pluginNarrative(plugin)));
    }
    const file = location(root, snapshotPath(saved.catalog_id), snapshotLimit);
    atomicWrite(file.path, payload);
    db.prepare('INSERT INTO capability_catalogs(catalog_id,snapshot_hash) VALUES(?,?) ON CONFLICT(catalog_id) DO UPDATE SET snapshot_hash=excluded.snapshot_hash')
      .run(saved.catalog_id, hash(payload));
    db.exec('COMMIT');
    return { state: 'stored' as const, catalog_id: saved.catalog_id, snapshot_hash: hash(payload) };
  } catch { return { state: 'unavailable' as const, issue: 'CACHE_UNAVAILABLE' as const }; }
  finally { if (db) { try { db.exec('ROLLBACK'); } catch { /* Already committed or unopened transaction. */ } db.close(); } }
}

type Candidate = {
  catalog_id: string; name: string; description: string; version: string | null;
  source: z.output<typeof source>; manifest: z.output<typeof manifest>; catalog_provenance: z.output<typeof provenance>;
  declared_license: string | null; components: { namespace: string; kind: string; paths: number; inline: boolean }[];
  component_count: number; components_truncated: boolean;
  states: { selected: 'not-observed'; installed: 'not-observed'; loaded: 'not-observed'; used: 'not-observed'; verified: 'not-observed' };
};
type Result = { state: 'absent' | 'available' | 'partial' | 'expired' | 'source-changed' | 'unavailable'; candidates: Candidate[];
  issues: Issue[]; fallback: 'ordinary-work'; authorization: 'not-granted'; results_truncated: boolean };

/** Actual FTS5 discovery over pinned metadata. A result is a compact candidate,
 * never an installation decision, runtime observation or proof of compatibility. */
export function findAgentCapabilityCandidates(root: string, input: z.input<typeof querySchema>, options: { now?: Date } = {}): Result {
  const parsed = querySchema.safeParse(input), now = clock(options);
  if (!parsed.success) throw new Error('Use a bounded capability request, role, source pins and result limit.');
  const result = (state: Result['state'], candidates: Candidate[] = [], issues: Issue[] = [], truncated = false): Result =>
    ({ state, candidates, issues, fallback: 'ordinary-work', authorization: 'not-granted', results_truncated: truncated });
  let db: DatabaseSync | undefined;
  try {
    const found = indexLocation(root); if (!found.exists) return result('absent');
    db = new DatabaseSync(found.path, { readOnly: true });
    const rows = db.prepare('SELECT catalog_id,snapshot_hash FROM capability_catalogs LIMIT 33').all();
    if (rows.length > 32) throw new Error('Optional cache catalog bound exceeded.');
    const issues: Issue[] = [], valid = new Map<string, Snapshot>();
    for (const row of rows) {
      const id = identifier.parse(row.catalog_id), snapshot = readSnapshot(root, id);
      if (snapshot.sha256 !== row.snapshot_hash) { issues.push({ catalog_id: id, code: 'SNAPSHOT_CHANGED' }); continue; }
      const expected = parsed.data.expected_sources.find(item => item.catalog_id === id);
      if (expected && !samePin(expected.provenance, snapshot.value.provenance)) { issues.push({ catalog_id: id, code: 'SOURCE_PIN_CHANGED' }); continue; }
      if (expected && expected.provenance.sha256 !== snapshot.value.provenance.sha256) { issues.push({ catalog_id: id, code: 'CATALOG_HASH_CHANGED' }); continue; }
      if (Date.parse(snapshot.value.expires_at) <= now || Date.parse(snapshot.value.observed_at) > now) { issues.push({ catalog_id: id, code: 'EXPIRED' }); continue; }
      valid.set(id, snapshot.value);
    }
    for (const expected of parsed.data.expected_sources) if (!rows.some(row => row.catalog_id === expected.catalog_id))
      issues.push({ catalog_id: expected.catalog_id, code: 'SOURCE_NOT_CACHED' });
    if (!valid.size) return result(issues.some(issue => /CHANGED/.test(issue.code)) ? 'source-changed' : issues.some(issue => issue.code === 'EXPIRED') ? 'expired' : 'absent', [], issues);
    const tokens = words(parsed.data.request);
    const matches = tokens.length ? db.prepare(`SELECT c.catalog_id,c.plugin_index FROM capability_search JOIN capabilities c ON c.id=capability_search.rowid
      WHERE capability_search MATCH ? AND (? IS NULL OR c.roles='[]' OR EXISTS(SELECT 1 FROM json_each(c.roles) WHERE value=?))
      ORDER BY bm25(capability_search),c.catalog_id,c.plugin_index LIMIT 100`).all(tokens.map(word => `"${word}"`).join(' OR '), parsed.data.role ?? null, parsed.data.role ?? null) : [];
    const candidates: Candidate[] = [], seen = new Set<string>();
    let responseBytes = 0, truncated = false;
    for (const match of matches) {
      const saved = valid.get(String(match.catalog_id)), index = Number(match.plugin_index);
      if (!saved || !Number.isSafeInteger(index)) continue;
      const plugin = saved.plugins[index];
      if (!plugin || parsed.data.role && plugin.role_hints.length && !plugin.role_hints.includes(parsed.data.role)) continue;
      const key = `${saved.catalog_id}\0${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const actualWords = new Set(words(pluginNarrative(plugin)));
      if (!tokens.some(word => actualWords.has(word))) continue;
      const item = plugin.inspection;
      const candidate: Candidate = { catalog_id: saved.catalog_id, name: item.name, description: item.description.slice(0, 600), version: item.version,
        source: item.source, manifest: item.manifest, catalog_provenance: item.catalog_provenance, declared_license: item.declared_license,
        components: item.components.slice(0, 16).map(component => ({ namespace: component.namespace, kind: component.kind, paths: component.paths.length, inline: component.inline })),
        component_count: item.components.length, components_truncated: item.components.length > 16,
        states: { selected: 'not-observed', installed: 'not-observed', loaded: 'not-observed', used: 'not-observed', verified: 'not-observed' } };
      const bytes = Buffer.byteLength(JSON.stringify(candidate));
      if (responseBytes + bytes > 48 * 1024 || candidates.length === parsed.data.limit) { truncated = true; break; }
      candidates.push(candidate); responseBytes += bytes;
    }
    return result(issues.length ? 'partial' : 'available', candidates, issues, truncated || matches.length === 100);
  } catch { return result('unavailable', [], [{ code: 'CACHE_UNAVAILABLE' }]); }
  finally { db?.close(); }
}

const marketplaceCandidateSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i), description: z.string().max(2000),
  package: z.strictObject({ repository: repo, commit: commit.optional(), path: z.union([sourcePath, z.literal('')]),
    declared_ref: z.string().trim().min(1).max(200).optional() }),
  provenance, state: z.enum(['source-pinned', 'package-pin-required']),
}).refine(candidate => (candidate.state === 'source-pinned') === !!candidate.package.commit);
const marketplaceInputSchema = z.strictObject({ catalog_id: identifier, provenance,
  candidates: z.array(marketplaceCandidateSchema).max(1000),
}).superRefine((value, context) => {
  const names = new Set<string>();
  for (const candidate of value.candidates) {
    const name = candidate.name.toLowerCase();
    if (names.has(name) || !sameProvenance(candidate.provenance, value.provenance))
      context.addIssue({ code: 'custom', message: 'Duplicate candidate or inconsistent pinned catalog metadata.' });
    names.add(name);
  }
});
const marketplaceStoredSchema = marketplaceInputSchema.safeExtend({ schema_version: z.literal(1),
  observed_at: z.iso.datetime(), expires_at: z.iso.datetime() });
type MarketplaceSnapshot = z.output<typeof marketplaceStoredSchema>;
export interface AgentMarketplaceCatalogInput {
  catalog_id: string; provenance: AgentMarketplaceCandidate['provenance']; candidates: readonly AgentMarketplaceCandidate[];
}
const expectedMarketplaces = z.array(z.strictObject({ catalog_id: identifier, provenance })).max(32)
  .refine(values => new Set(values.map(value => value.catalog_id)).size === values.length);
const marketplaceQuerySchema = z.strictObject({ request: z.string().trim().min(1).max(20_000),
  expected_sources: expectedMarketplaces.default([]), limit: z.number().int().min(1).max(5).default(5) });
const marketplaceExactSchema = z.strictObject({ catalog_id: identifier, name: marketplaceCandidateSchema.shape.name, provenance });
export interface AgentMarketplaceSearchInput {
  request: string; expected_sources?: { catalog_id: string; provenance: AgentMarketplaceCandidate['provenance'] }[]; limit?: number;
}
export interface AgentMarketplaceSearchResult {
  state: Result['state']; candidates: (AgentMarketplaceCandidate & { catalog_id: string })[]; issues: Issue[];
  fallback: 'ordinary-work'; authorization: 'not-granted'; results_truncated: boolean;
}
export interface AgentMarketplaceExactResult {
  state: Result['state']; candidate?: AgentMarketplaceCandidate; issues: Issue[];
  fallback: 'ordinary-work'; authorization: 'not-granted';
}
const marketplaceSnapshotPath = (id: string) => `${snapshots}/catalog-${hash(id)}.json`;
function readMarketplaceSnapshot(root: string, id: string) {
  const found = location(root, marketplaceSnapshotPath(id), snapshotLimit);
  if (!found.exists) throw new Error('Missing optional catalog snapshot.');
  const bytes = readFileSync(found.path);
  if (bytes.length > snapshotLimit) throw new Error('Optional catalog snapshot exceeds its bound.');
  const value = marketplaceStoredSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (value.catalog_id !== id) throw new Error('Optional catalog identity differs.');
  return { value, sha256: hash(bytes) };
}
const marketplaceNarrative = (candidate: AgentMarketplaceCandidate) => `${candidate.name} ${candidate.description}`;

/** Full bounded discovery metadata, separate from inspected manifests. This is
 * neither package installation nor source/execution authorization. */
export function saveAgentMarketplaceCatalog(root: string, input: AgentMarketplaceCatalogInput, options: { now?: Date; ttl_ms?: number } = {}) {
  const parsed = marketplaceInputSchema.safeParse(input), now = clock(options), ttl = options.ttl_ms ?? 86_400_000;
  if (!parsed.success) throw new Error('Use bounded pinned marketplace metadata without execution claims.');
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 30 * 86_400_000) throw new Error('Use bounded capability cache time options.');
  const saved = marketplaceStoredSchema.parse({ ...parsed.data, schema_version: 1,
    observed_at: new Date(now).toISOString(), expires_at: new Date(now + ttl).toISOString() });
  const payload = JSON.stringify(saved) + '\n';
  if (Buffer.byteLength(payload) > snapshotLimit) throw new Error('Use bounded pinned marketplace metadata.');
  let db: DatabaseSync | undefined;
  try {
    const target = indexLocation(root); mkdirSync(dirname(target.path), { recursive: true }); indexLocation(root);
    db = new DatabaseSync(target.path); beginCacheWrite(db); checkSourceBound(db, saved.catalog_id);
    const prior = db.prepare('SELECT snapshot_hash FROM marketplace_catalogs WHERE catalog_id=?').get(saved.catalog_id);
    if (prior) {
      const previous = readMarketplaceSnapshot(root, saved.catalog_id);
      if (previous.sha256 !== prior.snapshot_hash) throw new Error('Optional source metadata changed.');
      if (samePin(previous.value.provenance, saved.provenance) &&
        (!sameProvenance(previous.value.provenance, saved.provenance) || JSON.stringify(previous.value.candidates) !== JSON.stringify(saved.candidates)))
        return { state: 'unavailable' as const, issue: 'IMMUTABLE_SOURCE_CONFLICT' as const };
    }
    db.prepare('DELETE FROM marketplace_search WHERE rowid IN (SELECT id FROM marketplace_entries WHERE catalog_id=?)').run(saved.catalog_id);
    db.prepare('DELETE FROM marketplace_entries WHERE catalog_id=?').run(saved.catalog_id);
    for (const [index, candidate] of saved.candidates.entries()) {
      const row = db.prepare('INSERT INTO marketplace_entries(catalog_id,entry_index) VALUES(?,?)').run(saved.catalog_id, index);
      db.prepare('INSERT INTO marketplace_search(rowid,narrative) VALUES(?,?)').run(row.lastInsertRowid, narrative(marketplaceNarrative(candidate)));
    }
    const file = location(root, marketplaceSnapshotPath(saved.catalog_id), snapshotLimit); atomicWrite(file.path, payload);
    db.prepare('INSERT INTO marketplace_catalogs(catalog_id,snapshot_hash) VALUES(?,?) ON CONFLICT(catalog_id) DO UPDATE SET snapshot_hash=excluded.snapshot_hash')
      .run(saved.catalog_id, hash(payload));
    db.exec('COMMIT'); return { state: 'stored' as const, catalog_id: saved.catalog_id, snapshot_hash: hash(payload) };
  } catch { return { state: 'unavailable' as const, issue: 'CACHE_UNAVAILABLE' as const }; }
  finally { if (db) { try { db.exec('ROLLBACK'); } catch { /* Read/write transaction already settled. */ } db.close(); } }
}

function marketplaceSources(root: string, expected: z.output<typeof expectedMarketplaces>, now: number) {
  let db: DatabaseSync | undefined;
  const issues: Issue[] = [], valid = new Map<string, MarketplaceSnapshot>();
  try {
    const file = indexLocation(root);
    if (file.exists) {
      db = new DatabaseSync(file.path, { readOnly: true });
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='marketplace_catalogs'").get()) {
        const rows = db.prepare('SELECT catalog_id,snapshot_hash FROM marketplace_catalogs LIMIT 33').all();
        if (rows.length > 32) throw new Error('Optional catalog bound exceeded.');
        for (const row of rows) {
          const id = identifier.parse(row.catalog_id), wanted = expected.find(value => value.catalog_id === id);
          if (expected.length && !wanted) continue;
          try {
            const saved = readMarketplaceSnapshot(root, id);
            if (saved.sha256 !== row.snapshot_hash) { issues.push({ catalog_id: id, code: 'SNAPSHOT_CHANGED' }); continue; }
            if (wanted && !samePin(wanted.provenance, saved.value.provenance)) { issues.push({ catalog_id: id, code: 'SOURCE_PIN_CHANGED' }); continue; }
            if (wanted && wanted.provenance.sha256 !== saved.value.provenance.sha256) { issues.push({ catalog_id: id, code: 'CATALOG_HASH_CHANGED' }); continue; }
            if (Date.parse(saved.value.expires_at) <= now || Date.parse(saved.value.observed_at) > now) { issues.push({ catalog_id: id, code: 'EXPIRED' }); continue; }
            valid.set(id, saved.value);
          } catch { issues.push({ catalog_id: id, code: 'SNAPSHOT_CHANGED' }); }
        }
        for (const wanted of expected) if (!rows.some(row => row.catalog_id === wanted.catalog_id)) issues.push({ catalog_id: wanted.catalog_id, code: 'SOURCE_NOT_CACHED' });
      } else for (const wanted of expected) issues.push({ catalog_id: wanted.catalog_id, code: 'SOURCE_NOT_CACHED' });
    } else for (const wanted of expected) issues.push({ catalog_id: wanted.catalog_id, code: 'SOURCE_NOT_CACHED' });
    const state: Result['state'] = valid.size ? issues.length ? 'partial' : 'available'
      : issues.some(issue => /CHANGED/.test(issue.code)) ? 'source-changed' : issues.some(issue => issue.code === 'EXPIRED') ? 'expired' : 'absent';
    return { db, valid, issues, state };
  } catch (error) { db?.close(); throw error; }
}

/** Actual FTS5 over the complete discovery snapshot, not only the few inspected
 * manifests. A fresh no-match remains available and never requests a download. */
export function findAgentMarketplaceCandidates(root: string, input: AgentMarketplaceSearchInput, options: { now?: Date } = {}): AgentMarketplaceSearchResult {
  const parsed = marketplaceQuerySchema.safeParse(input), now = clock(options);
  if (!parsed.success) throw new Error('Use a bounded marketplace request, exact source pins and result limit.');
  const result = (state: Result['state'], candidates: AgentMarketplaceSearchResult['candidates'] = [], issues: Issue[] = [], truncated = false): AgentMarketplaceSearchResult =>
    ({ state, candidates, issues, results_truncated: truncated, fallback: 'ordinary-work', authorization: 'not-granted' });
  let db: DatabaseSync | undefined;
  try {
    const sources = marketplaceSources(root, parsed.data.expected_sources, now); db = sources.db;
    if (!db || !sources.valid.size) return result(sources.state, [], sources.issues);
    const tokens = words(parsed.data.request), candidates: AgentMarketplaceSearchResult['candidates'] = [], seen = new Set<string>();
    const allowed = [...sources.valid.keys()];
    const rows = tokens.length ? db.prepare(`SELECT e.catalog_id,e.entry_index FROM marketplace_search JOIN marketplace_entries e ON e.id=marketplace_search.rowid
      WHERE marketplace_search MATCH ? AND e.catalog_id IN (${allowed.map(() => '?').join(',')})
      ORDER BY bm25(marketplace_search),e.catalog_id,e.entry_index LIMIT 100`)
      .all(tokens.map(word => `"${word}"`).join(' OR '), ...allowed) : [];
    let bytes = 0, truncated = false;
    for (const row of rows) {
      const id = String(row.catalog_id), saved = sources.valid.get(id), index = Number(row.entry_index), key = `${id}\0${index}`;
      if (!saved || !Number.isSafeInteger(index) || !saved.candidates[index] || seen.has(key)) continue;
      seen.add(key); const candidate = saved.candidates[index];
      const actualWords = new Set(words(marketplaceNarrative(candidate)));
      if (!tokens.some(word => actualWords.has(word))) continue;
      const item = { ...candidate, catalog_id: id }, length = Buffer.byteLength(JSON.stringify(item));
      if (candidates.length === parsed.data.limit || bytes + length > 48 * 1024) { truncated = true; break; }
      candidates.push(item); bytes += length;
    }
    return result(sources.state, candidates, sources.issues, truncated || rows.length === 100);
  } catch { return result('unavailable', [], [{ code: 'CACHE_UNAVAILABLE' }]); }
  finally { db?.close(); }
}

/** Direct exact-name lookup, independent of FTS ranking/top-five truncation. */
export function readAgentMarketplaceCandidate(root: string, input: { catalog_id: string; name: string; provenance: AgentMarketplaceCandidate['provenance'] },
  options: { now?: Date } = {}): AgentMarketplaceExactResult {
  const parsed = marketplaceExactSchema.safeParse(input), now = clock(options);
  if (!parsed.success) throw new Error('Use a bounded exact package name and immutable catalog provenance.');
  let db: DatabaseSync | undefined;
  try {
    const sources = marketplaceSources(root, [{ catalog_id: parsed.data.catalog_id, provenance: parsed.data.provenance }], now); db = sources.db;
    const candidate = sources.valid.get(parsed.data.catalog_id)?.candidates.find(value => value.name.toLowerCase() === parsed.data.name.toLowerCase());
    return { state: sources.state, ...(candidate ? { candidate } : {}), issues: sources.issues, fallback: 'ordinary-work', authorization: 'not-granted' };
  } catch { return { state: 'unavailable', issues: [{ code: 'CACHE_UNAVAILABLE' }], fallback: 'ordinary-work', authorization: 'not-granted' }; }
  finally { db?.close(); }
}
