import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, linkSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { initialize, loadRecords, readConfig } from '../dist/storage.js';
import { prepareNativeWork } from '../dist/native-work.js';
import { discoverAgentMarketplace, inspectAgentMarketplacePlugin } from '../dist/agent-marketplace.js';
import * as cache from '../dist/agent-capability-cache.js';
const { saveAgentCapabilityCatalog, findAgentCapabilityCandidates, saveAgentMarketplaceCatalog,
  findAgentMarketplaceCandidates, readAgentMarketplaceCandidate } = cache;

const instant = new Date('2026-11-09T00:00:00.000Z');
const database = '.workforce/cache/agent-capabilities.sqlite';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-capability-cache-'));
  initialize(root, { project_id: 'WF-CAP-CACHE' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
// Read-only fixture transports exercise the real catalog inspector. They do
// not represent downloads, plugin installation, compatibility or execution.
async function snapshot(name = 'documentation-kit', commit = 'a'.repeat(40)) {
  const repo = 'https://github.com/example/any-catalog';
  const descriptions = {
    'documentation-kit': 'Technical documentation, readable explanations and research articles.',
    'test-workbench': 'Unit testing, test automation and independent behavior verification.',
  };
  const catalogText = JSON.stringify({ name: 'team-catalog', plugins: [{ name, description: descriptions[name], source: `plugins/${name}` }] });
  const manifestText = JSON.stringify({ name, version: '1.0.0', description: descriptions[name], license: 'MIT',
    skills: [`skills/${name}`] });
  const reader = async input => ({ ...input, kind: 'file', complete: true,
    content: input.path.endsWith('marketplace.json') ? catalogText : manifestText });
  const catalog = await discoverAgentMarketplace({ repository: repo, commit }, reader);
  const inspection = await inspectAgentMarketplacePlugin(catalog.candidates[0], reader);
  return { catalog_id: `arbitrary-publisher/${name}`, provenance: catalog.provenance,
    plugins: [{ inspection, role_hints: [name === 'documentation-kit' ? 'WF.FnD' : 'WF.Tester'], keywords: [] }] };
}

test('absent capability cache creates nothing and cannot block ordinary work', t => {
  const root = project(t), before = loadRecords(root);
  const result = findAgentCapabilityCandidates(root, { request: 'Write documentation' }, { now: instant });
  assert.equal(result.state, 'absent'); assert.equal(result.fallback, 'ordinary-work');
  assert.deepEqual(result.candidates, []);
  assert.equal(existsSync(join(root, database)), false);
  assert.deepEqual(loadRecords(root), before);
});

test('capability cache reads, saves and native preparation preserve historical managed storage namespaces', async t => {
  for (const alias of ['.neomind', '.verythinker', '.taskforces']) {
    const root = project(t);
    renameSync(join(root, '.workforce'), join(root, alias));
    const before = loadRecords(root);
    assert.equal(readConfig(root).project_id, 'WF-CAP-CACHE');
    assert.equal(findAgentCapabilityCandidates(root, { request: 'Documentation' }).state, 'absent');
    assert.equal(existsSync(join(root, alias, 'cache')), false, 'Absent-cache reads create no index or directories');
    assert.equal(saveAgentCapabilityCatalog(root, await snapshot(), { now: instant }).state, 'stored');
    assert.ok(existsSync(join(root, alias, 'cache/agent-capabilities.sqlite')));
    assert.ok(existsSync(join(root, alias, 'cache/agent-capabilities')));
    const retrieved = findAgentCapabilityCandidates(root, { request: 'Documentation' }, { now: instant });
    assert.equal(retrieved.state, 'available'); assert.equal(retrieved.candidates[0].name, 'documentation-kit');
    assert.equal(prepareNativeWork(root, { requirement: 'Documentation', outputs: ['notes/new.md'] }).strategy, 'ordinary');
    assert.equal(readConfig(root).project_id, 'WF-CAP-CACHE', 'Preparation keeps the existing backend configuration readable');
    assert.equal(existsSync(join(root, '.workforce')), false, 'A derived cache never creates a competing storage namespace');
    assert.deepEqual(loadRecords(root), before);
  }
});

test('real SQLite FTS5 finds different role capabilities by paraphrase without granting lifecycle claims', async t => {
  const root = project(t), before = loadRecords(root);
  for (const name of ['documentation-kit', 'test-workbench']) {
    assert.equal(saveAgentCapabilityCatalog(root, await snapshot(name), { now: instant }).state, 'stored');
  }
  const query = (request, role) => findAgentCapabilityCandidates(root, { request, role }, { now: instant });
  const docs = query('Prepare readable docs and a clear write-up', 'WF.FnD');
  assert.equal(docs.state, 'available'); assert.equal(docs.candidates[0].name, 'documentation-kit');
  const tests = query('Kiểm thử độc lập với unit tests', 'WF.Tester');
  assert.equal(tests.candidates[0].name, 'test-workbench');
  assert.deepEqual(query('Write documentation', 'WF.Tester').candidates, []);
  assert.deepEqual(query('Calibrate a barometric sensor', 'WF.FnD').candidates, []);
  assert.deepEqual(query('"; DROP TABLE capabilities; --', 'WF.FnD').candidates, []);
  const candidate = docs.candidates[0];
  assert.equal(candidate.declared_license, 'MIT');
  assert.equal(candidate.source.commit, 'a'.repeat(40));
  assert.match(candidate.manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(candidate.components[0].kind, 'skills');
  assert.deepEqual(candidate.states, { selected: 'not-observed', installed: 'not-observed', loaded: 'not-observed',
    used: 'not-observed', verified: 'not-observed' });
  assert.equal(docs.authorization, 'not-granted');
  const db = new DatabaseSync(join(root, database), { readOnly: true });
  try { assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='capability_search'").get().sql, /fts5/i); }
  finally { db.close(); }
  assert.deepEqual(loadRecords(root), before, 'Discovery does not create requests, records or permissions');
});

test('expiration, source pins and source hashes are distinct from a valid no-match', async t => {
  const root = project(t), data = await snapshot();
  saveAgentCapabilityCatalog(root, data, { now: instant, ttl_ms: 1000 });
  const query = { request: 'Documentation', expected_sources: [{ catalog_id: data.catalog_id, provenance: data.provenance }] };
  const expired = findAgentCapabilityCandidates(root, query, { now: new Date(instant.getTime() + 1001) });
  assert.equal(expired.state, 'expired'); assert.deepEqual(expired.candidates, []);
  const changed = findAgentCapabilityCandidates(root, { ...query, expected_sources: [{ catalog_id: data.catalog_id,
    provenance: { ...data.provenance, commit: 'b'.repeat(40) } }] }, { now: instant });
  assert.equal(changed.state, 'source-changed'); assert.equal(changed.issues[0].code, 'SOURCE_PIN_CHANGED');
  const hashChanged = findAgentCapabilityCandidates(root, { ...query, expected_sources: [{ catalog_id: data.catalog_id,
    provenance: { ...data.provenance, sha256: 'c'.repeat(64) } }] }, { now: instant });
  assert.equal(hashChanged.state, 'source-changed'); assert.equal(hashChanged.issues[0].code, 'CATALOG_HASH_CHANGED');
  saveAgentCapabilityCatalog(root, await snapshot('documentation-kit', 'b'.repeat(40)), { now: instant });
  assert.equal(findAgentCapabilityCandidates(root, query, { now: instant }).state, 'source-changed');
});

test('corrupt derived SQLite or changed metadata returns an honest optional-cache fallback', async t => {
  const root = project(t), data = await snapshot();
  saveAgentCapabilityCatalog(root, data, { now: instant });
  const folder = join(root, '.workforce/cache/agent-capabilities');
  const file = join(folder, readdirSync(folder).find(path => path.endsWith('.json')));
  const canonical = readFileSync(file);
  writeFileSync(file, canonical.toString().replace('Technical documentation', 'Altered source metadata'));
  const changed = findAgentCapabilityCandidates(root, { request: 'Documentation' }, { now: instant });
  assert.equal(changed.state, 'source-changed'); assert.deepEqual(changed.candidates, []);
  writeFileSync(file, canonical);
  writeFileSync(join(root, database), 'Invalid optional SQLite data');
  const corrupt = findAgentCapabilityCandidates(root, { request: 'Documentation' }, { now: instant });
  assert.equal(corrupt.state, 'unavailable'); assert.equal(corrupt.fallback, 'ordinary-work');
  assert.equal(readFileSync(join(root, database), 'utf8'), 'Invalid optional SQLite data', 'A query does not silently replace corruption');
});

test('metadata bounds and immutable-pin conflicts are rejected without rewriting source snapshots', async t => {
  const root = project(t), data = await snapshot();
  saveAgentCapabilityCatalog(root, data, { now: instant });
  const changed = structuredClone(data);
  changed.plugins[0].inspection.manifest.sha256 = 'd'.repeat(64);
  const result = saveAgentCapabilityCatalog(root, changed, { now: instant });
  assert.equal(result.state, 'unavailable'); assert.equal(result.issue, 'IMMUTABLE_SOURCE_CONFLICT');
  assert.equal(findAgentCapabilityCandidates(root, { request: 'Documentation' }, { now: instant }).candidates[0].manifest.sha256,
    data.plugins[0].inspection.manifest.sha256);
  assert.throws(() => findAgentCapabilityCandidates(root, { request: 'x'.repeat(20001) }), /bounded/);
  assert.throws(() => findAgentCapabilityCandidates(root, { request: 'docs', limit: 11 }), /bounded/);
  const claimed = structuredClone(data); claimed.plugins[0].inspection.authorization = 'granted';
  assert.throws(() => saveAgentCapabilityCatalog(root, claimed), /metadata/);
});

test('hard-linked SQLite files and sidecars are refused before opening or modifying another file', async t => {
  for (const suffix of ['', '-wal', '-journal', '-shm']) {
    const root = project(t), target = join(root, 'authored-file.txt'), db = join(root, database);
    mkdirSync(join(root, '.workforce/cache'), { recursive: true });
    writeFileSync(target, 'Preserve authored file'); linkSync(target, db + suffix);
    const result = findAgentCapabilityCandidates(root, { request: 'Documentation' });
    assert.equal(result.state, 'unavailable');
    assert.equal(saveAgentCapabilityCatalog(root, await snapshot()).state, 'unavailable');
    assert.equal(readFileSync(target, 'utf8'), 'Preserve authored file');
  }
});

test('linked cache parents are not followed even when they resolve inside the workspace', t => {
  const root = project(t), target = join(root, 'authored-cache'); mkdirSync(target);
  const link = join(root, '.workforce/cache');
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS did not permit a directory-link fixture'); return; } throw error; }
  assert.equal(findAgentCapabilityCandidates(root, { request: 'Documentation' }).state, 'unavailable');
  assert.deepEqual(readdirSync(target), []);
});

test('fresh catalogs remain candidates when an unrelated optional catalog expires or is missing', async t => {
  const root = project(t), docs = await snapshot(), tests = await snapshot('test-workbench');
  saveAgentCapabilityCatalog(root, docs, { now: instant, ttl_ms: 1000 });
  saveAgentCapabilityCatalog(root, tests, { now: instant });
  const result = findAgentCapabilityCandidates(root, { request: 'Independent testing', role: 'WF.Tester',
    expected_sources: [{ catalog_id: 'another-catalog/not-cached', provenance: tests.provenance }] },
  { now: new Date(instant.getTime() + 1001) });
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.candidates.map(item => item.name), ['test-workbench']);
  assert.deepEqual(new Set(result.issues.map(issue => issue.code)), new Set(['EXPIRED', 'SOURCE_NOT_CACHED']));
  assert.equal(result.fallback, 'ordinary-work');
});

test('candidate and component truncation is explicit, and modified FTS rows cannot invent relevance', async t => {
  const root = project(t), data = await snapshot();
  const base = data.plugins[0];
  base.inspection.components = Array.from({ length: 20 }, (_, index) => ({ namespace: `namespace-${index}`,
    kind: 'skills', paths: [`skills/part-${index}`], inline: false }));
  data.plugins = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(base),
    inspection: { ...structuredClone(base.inspection), name: `documentation-kit-${index}` } }));
  assert.equal(saveAgentCapabilityCatalog(root, data, { now: instant }).state, 'stored');
  const result = findAgentCapabilityCandidates(root, { request: 'Readable documentation', limit: 10 }, { now: instant });
  assert.equal(result.candidates.length, 10); assert.equal(result.results_truncated, true);
  assert.equal(result.candidates[0].component_count, 20);
  assert.equal(result.candidates[0].components.length, 16);
  assert.equal(result.candidates[0].components_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
  const db = new DatabaseSync(join(root, database));
  try { db.exec("UPDATE capability_search SET narrative='barometric sensor calibration'"); }
  finally { db.close(); }
  const redirected = findAgentCapabilityCandidates(root, { request: 'Calibrate a barometric sensor' }, { now: instant });
  assert.equal(redirected.state, 'available'); assert.deepEqual(redirected.candidates, []);
});

async function completeCatalog() {
  const repository = 'https://github.com/example/complete-catalog', commit = 'a'.repeat(40);
  const reader = async input => ({ ...input, kind: 'file', complete: true, content: JSON.stringify(input.path.endsWith('marketplace.json')
    ? { name: 'complete', plugins: [{ name: 'docs', description: 'Readable documentation', source: 'plugins/docs' },
      { name: 'tests', description: 'Independent testing', source: 'plugins/tests' }] }
    : { name: input.path.split('/')[1], description: input.path.includes('/docs/') ? 'Readable documentation' : 'Independent testing',
      license: 'MIT', skills: ['skills/guidance'] }) });
  const discovered = await discoverAgentMarketplace({ repository, commit }, reader);
  const plugins = await Promise.all(discovered.candidates.map(async candidate => ({ inspection: await inspectAgentMarketplacePlugin(candidate, reader), role_hints: [], keywords: [] })));
  return { catalog_id: 'approved/complete', provenance: discovered.provenance, candidates: discovered.candidates, plugins };
}

test('complete raw catalogs answer different fresh queries and exact package lookups without a network or record write', async t => {
  const root = project(t), data = await completeCatalog(), before = loadRecords(root);
  assert.equal(findAgentMarketplaceCandidates(root, { request: 'docs' }).state, 'absent');
  assert.equal(existsSync(join(root, database)), false);
  assert.equal(saveAgentMarketplaceCatalog(root, { catalog_id: data.catalog_id, provenance: data.provenance, candidates: data.candidates }, { now: instant }).state, 'stored');
  const expected_sources = [{ catalog_id: data.catalog_id, provenance: data.provenance }], fetch = globalThis.fetch;
  globalThis.fetch = () => { assert.fail('Fresh catalog retrieval must not acquire the catalog again'); };
  try {
    assert.equal(findAgentMarketplaceCandidates(root, { request: 'documentation', expected_sources }, { now: instant }).candidates[0].name, 'docs');
    assert.equal(findAgentMarketplaceCandidates(root, { request: 'testing', expected_sources }, { now: instant }).candidates[0].name, 'tests');
    const missing = findAgentMarketplaceCandidates(root, { request: 'barometric', expected_sources }, { now: instant });
    assert.equal(missing.state, 'available'); assert.deepEqual(missing.candidates, []);
    const exact = readAgentMarketplaceCandidate(root, { catalog_id: data.catalog_id, name: 'tests', provenance: data.provenance }, { now: instant });
    assert.equal(exact.state, 'available'); assert.equal(exact.candidate.package.commit, data.provenance.commit);
    assert.equal(exact.authorization, 'not-granted');
  } finally { globalThis.fetch = fetch; }
  assert.deepEqual(loadRecords(root), before);
});

test('partial inspected-plugin saves upsert the same source and retain unrelated inspection metadata', async t => {
  const root = project(t), data = await completeCatalog();
  for (const plugin of data.plugins) assert.equal(saveAgentCapabilityCatalog(root, { catalog_id: data.catalog_id, provenance: data.provenance,
    plugins: [plugin] }, { now: instant }).state, 'stored');
  assert.equal(findAgentCapabilityCandidates(root, { request: 'documentation' }, { now: instant }).candidates[0].name, 'docs');
  assert.equal(findAgentCapabilityCandidates(root, { request: 'testing' }, { now: instant }).candidates[0].name, 'tests');
  const conflict = structuredClone(data.plugins[1]); conflict.inspection.manifest.sha256 = 'b'.repeat(64);
  assert.equal(saveAgentCapabilityCatalog(root, { catalog_id: data.catalog_id, provenance: data.provenance, plugins: [conflict] }, { now: instant }).issue, 'IMMUTABLE_SOURCE_CONFLICT');
  assert.equal(findAgentCapabilityCandidates(root, { request: 'documentation' }, { now: instant }).candidates.length, 1);
});

test('raw catalog expiry, source pin/hash changes and corrupt optional snapshots never become current candidates', async t => {
  const root = project(t), data = await completeCatalog(), raw = { catalog_id: data.catalog_id, provenance: data.provenance, candidates: data.candidates };
  saveAgentMarketplaceCatalog(root, raw, { now: instant, ttl_ms: 1000 });
  const query = { request: 'documentation', expected_sources: [{ catalog_id: data.catalog_id, provenance: data.provenance }] };
  assert.equal(findAgentMarketplaceCandidates(root, query, { now: new Date(+instant + 1001) }).state, 'expired');
  const changed = { ...data.provenance, sha256: 'b'.repeat(64) };
  assert.equal(readAgentMarketplaceCandidate(root, { catalog_id: data.catalog_id, name: 'docs', provenance: changed }, { now: instant }).state, 'source-changed');
  const folder = join(root, '.workforce/cache/agent-capabilities'), file = readdirSync(folder).find(name => name.startsWith('catalog-'));
  writeFileSync(join(folder, file), '{PRIVATE corrupt catalog');
  const result = findAgentMarketplaceCandidates(root, query, { now: instant });
  assert.deepEqual(result.candidates, []); assert.equal(result.fallback, 'ordinary-work'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('raw catalog FTS relevance, exact lookups and top-five bounds are checked against the complete pinned snapshot', async t => {
  const root = project(t), data = await completeCatalog();
  const candidates = Array.from({ length: 12 }, (_, index) => ({ ...data.candidates[0], name: `docs-${index}` }));
  saveAgentMarketplaceCatalog(root, { catalog_id: data.catalog_id, provenance: data.provenance, candidates }, { now: instant });
  const top = findAgentMarketplaceCandidates(root, { request: 'documentation', limit: 5 }, { now: instant });
  assert.equal(top.candidates.length, 5); assert.equal(top.results_truncated, true);
  assert.equal(readAgentMarketplaceCandidate(root, { catalog_id: data.catalog_id, name: 'docs-11', provenance: data.provenance }, { now: instant }).candidate.name, 'docs-11');
  assert.throws(() => findAgentMarketplaceCandidates(root, { request: 'docs', limit: 6 }), /bounded/);
  const db = new DatabaseSync(join(root, database));
  try { db.exec("UPDATE marketplace_search SET narrative='barometric sensor'"); } finally { db.close(); }
  assert.deepEqual(findAgentMarketplaceCandidates(root, { request: 'barometric sensor' }, { now: instant }).candidates, []);
});

test('raw catalogs enforce candidate/schema bounds and refuse immutable discovery changes without rewriting the old snapshot', async t => {
  const root = project(t), data = await completeCatalog(), raw = { catalog_id: data.catalog_id, provenance: data.provenance, candidates: data.candidates };
  for (const candidates of [Array.from({ length: 1001 }, (_, index) => ({ ...data.candidates[0], name: `package-${index}` })), [data.candidates[0], data.candidates[0]],
    [{ ...data.candidates[0], provenance: { ...data.provenance, sha256: 'b'.repeat(64) } }]])
    assert.throws(() => saveAgentMarketplaceCatalog(root, { ...raw, candidates }, { now: instant }), /metadata/);
  assert.equal(existsSync(join(root, database)), false);
  assert.equal(saveAgentMarketplaceCatalog(root, raw, { now: instant }).state, 'stored');
  const altered = structuredClone(raw); altered.candidates[0].description = 'Changed immutable metadata';
  assert.equal(saveAgentMarketplaceCatalog(root, altered, { now: instant }).issue, 'IMMUTABLE_SOURCE_CONFLICT');
  assert.equal(readAgentMarketplaceCandidate(root, { catalog_id: data.catalog_id, name: 'docs', provenance: data.provenance }, { now: instant }).candidate.description,
    data.candidates[0].description);
});

test('raw and inspected catalogs share one thirty-two-source bound in the existing cache namespace', async t => {
  const root = project(t), data = await completeCatalog();
  for (let index = 0; index < 32; index++) assert.equal(saveAgentMarketplaceCatalog(root, { catalog_id: `source-${index}`, provenance: data.provenance,
    candidates: data.candidates }, { now: instant }).state, 'stored');
  assert.equal(saveAgentMarketplaceCatalog(root, { catalog_id: 'source-32', provenance: data.provenance, candidates: data.candidates }, { now: instant }).state, 'unavailable');
  assert.equal(saveAgentCapabilityCatalog(root, { catalog_id: 'source-32', provenance: data.provenance, plugins: data.plugins }, { now: instant }).state, 'unavailable');
  assert.equal(saveAgentCapabilityCatalog(root, { catalog_id: 'source-0', provenance: data.provenance, plugins: data.plugins }, { now: instant }).state, 'stored',
    'An inspection of an already cached source consumes no second source slot');
});

test('unapproved cached source rows cannot starve a requested pinned source before the top-five limit', async t => {
  const root = project(t), data = await completeCatalog();
  const approved = { ...data.candidates[0], name: 'approved', description: 'documentation' };
  saveAgentMarketplaceCatalog(root, { catalog_id: 'z/approved', provenance: data.provenance, candidates: [approved] }, { now: instant });
  const otherProvenance = { ...data.provenance, repository: 'https://github.com/example/unapproved' };
  saveAgentMarketplaceCatalog(root, { catalog_id: 'a/unapproved', provenance: otherProvenance,
    candidates: Array.from({ length: 101 }, (_, index) => ({ ...approved, name: `pkg${index}`, provenance: otherProvenance })) }, { now: instant });
  const selected = findAgentMarketplaceCandidates(root, { request: 'documentation', expected_sources: [
    { catalog_id: 'z/approved', provenance: data.provenance }] }, { now: instant });
  assert.equal(selected.state, 'available'); assert.deepEqual(selected.candidates.map(candidate => candidate.name), ['approved']);
});
