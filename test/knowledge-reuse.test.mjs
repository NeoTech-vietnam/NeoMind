import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRecord, hash, initialize, updateRecord } from '../dist/storage.js';
import {
  discoverProjectKnowledge, knowledgeResearchProblems, recordKnowledgeResearch,
  searchProjectKnowledge,
} from '../dist/knowledge-reuse.js';

const repository = 'example/shared';
const sha = 'a'.repeat(40);
const projectHash = 'b'.repeat(64);
const branch = `neomind/knowledge/${projectHash.slice(0, 16)}`;
const artifact = `knowledge/projects/${projectHash}/notes/atomic-updates/1.2.3.md`;
const manifest = `knowledge/projects/${projectHash}/manifest.json`;
const narrative = '# Durable replacements\n\n## Cue Column\n\nHow can a validated replacement remain crash safe?\n\n## Main Notes\n\nUse a write barrier and atomic replacement; the zephyr sentinel distinguishes this narrative from its title.\n\n## Summary\n\nKeep the original valid bytes until replacement succeeds.\n\n## Application\n\nReview filesystem and runtime version differences before applying.\n';
const classification = { platforms: ['Windows'], frameworks: ['Node.js'] };
const summary = 'Inspected the local configuration implementation and compared upstream patterns against the current runtime requirements.';
const applicability = 'The upstream atomic replacement pattern applies to the same Windows platform and durable configuration lifecycle.';
const differences = 'The source targets Node.js 22 while this workspace targets Node.js 24; review rename and crash recovery behavior manually.';
const noMatchReason = 'The search found no applicable upstream sources after comparing platform constraints and the inspected local configuration lifecycle.';

function project(t, required = true) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-knowledge-reuse-'));
  t.after(() => {
    const cache = join(root, '.neomind/knowledge-cache');
    if (existsSync(cache)) {
      for (const name of readdirSync(cache)) {
        try { chmodSync(join(cache, name), 0o600); } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'REUSE-TEST' });
  // The reuse module reads policy JSON directly and must not import manager.ts.
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({
    schema_version: 1, manager_enabled: true, documentation_required: true,
    automatic_pr: true, upstream: repository, max_discussion_rounds: 3,
  }));
  writeFileSync(join(root, 'configuration.ts'), 'export const version = 24;\n');
  const workflow = createRecord(root, {
    type: 'knowledge', title: 'Configuration increment', owner: 'owner',
    data: { kind: 'manager-workflow', knowledge_research_required: required },
  });
  return { root, workflowId: workflow.meta.id };
}
function github(options = {}) {
  const entry = {
    schema_version: 1, schema: 'neomind-project-knowledge-note',
    title: 'Atomic configuration replacement', ...classification,
    applicability: ['Applications with local durable configuration.'],
    provenance: ['https://nodejs.org/api/fs.html'], artifact_path: artifact, sha256: hash(narrative),
    ...options.entry,
  };
  const files = new Map([
    [artifact, narrative],
    [artifact.replace(/\.md$/, '.json'), JSON.stringify(entry)],
    [manifest, JSON.stringify({ schema_version: 1, schema: 'neomind-project-knowledge-catalog', notes: [entry] })],
  ]);
  const calls = [];
  const state = {
    pages: [[{ name: branch, commit: { sha } }]],
    truncated: false,
    tree: null,
    error: null,
    before: null,
    ...options,
  };
  function request(method, endpoint) {
    calls.push({ method, endpoint });
    assert.equal(method, 'GET', 'Discovery never mutates upstream');
    state.before?.(endpoint);
    if (state.error) throw state.error;
    const url = new URL(`https://api.github.com/${endpoint}`);
    if (url.pathname === `/repos/${repository}/branches`) {
      assert.equal(url.searchParams.get('per_page'), '100');
      return state.pages[Number(url.searchParams.get('page')) - 1] ?? [];
    }
    if (url.pathname === `/repos/${repository}/git/trees/${sha}`) {
      assert.equal(url.searchParams.get('recursive'), '1');
      return { truncated: state.truncated, tree: state.tree ?? [...files].map(([path, content]) => ({
        path, mode: '100644', type: 'blob', size: Buffer.byteLength(content),
      })) };
    }
    if (url.pathname.startsWith(`/repos/${repository}/contents/`)) {
      assert.equal(url.searchParams.get('ref'), sha, 'Every contents request is pinned, never a moving branch');
      const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
      assert.ok(files.has(path), `Known fixture path: ${path}`);
      const content = files.get(path);
      return { type: 'file', path, size: Buffer.byteLength(content), encoding: 'base64',
        content: Buffer.from(content).toString('base64') };
    }
    assert.fail(`Unexpected request ${endpoint}`);
  }
  return { request, calls, files, entry, state };
}
function fetchSource(work, remote = github()) {
  const results = discoverProjectKnowledge(work.root, classification, remote.request);
  assert.equal(results.length, 1);
  return results[0];
}
function research(source, overrides = {}) {
  return {
    ...classification, workspace_paths: ['configuration.ts'],
    queries: ['Windows Node.js atomic durable configuration'],
    selected_sources: source ? [{ source_id: source.source_id, applicability, differences }] : [],
    ...(source ? {} : { no_match_reason: noMatchReason }), summary, ...overrides,
  };
}
function rewrite(path, content) {
  chmodSync(path, 0o600);
  writeFileSync(path, content);
  chmodSync(path, 0o444);
}

test('discovery pins trees/catalogs/companions/artifacts and caches verified read-only provenance', (t) => {
  const work = project(t);
  const remote = github();
  const result = fetchSource(work, remote);
  assert.deepEqual(Object.keys(result).sort(), [
    'source_id', 'title', 'score', 'repo', 'branch', 'commit', 'path', 'sha256', 'narrative',
  ].sort());
  assert.equal(result.repo, repository);
  assert.equal(result.branch, branch);
  assert.equal(result.commit, sha);
  assert.equal(result.path, artifact);
  assert.equal(result.sha256, hash(narrative));
  assert.equal(result.narrative, narrative);
  assert.match(result.source_id, /^[a-f0-9]{64}$/);
  const stored = JSON.parse(readFileSync(join(work.root, '.neomind/knowledge-cache', `${result.source_id}.json`), 'utf8'));
  assert.equal(stored.entry.artifact_path, artifact);
  assert.equal(stored.sha256, hash(narrative));
  assert.equal(stored.commit, sha);
  assert.equal(readFileSync(join(work.root, '.neomind/knowledge-cache', `${result.source_id}.md`), 'utf8'), narrative);
  assert.equal(remote.calls.filter((call) => call.endpoint.includes('/contents/')).length, 3);
  // Idempotent discovery does not need to rewrite read-only source pairs.
  assert.equal(fetchSource(work, remote).source_id, result.source_id);
});

test('local-only discovery rejects before transport while verified cached research stays available offline', (t) => {
  const work = project(t);
  const remote = github();
  const source = fetchSource(work, remote);
  const path = join(work.root, '.neomind/automation.json');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...policy, network_policy: 'local-only', upstream: null }));
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('Offline discovery must not invoke transport.'); };
  assert.throws(() => discoverProjectKnowledge(work.root, classification, forbidden), /local-only.*remote-enabled/i);
  assert.equal(calls, 0);
  assert.equal(searchProjectKnowledge(work.root, classification)[0].source_id, source.source_id);
  const recorded = recordKnowledgeResearch(work.root, work.workflowId, research(source));
  assert.equal(recorded.meta.data.provenance_refs[0].commit, sha);
  assert.deepEqual(knowledgeResearchProblems(work.root, work.workflowId, { check_workspace: true }), []);
  writeFileSync(path, JSON.stringify({ ...policy, network_policy: 'remote-enabled' }));
  assert.equal(fetchSource(work, remote).source_id, source.source_id);
});

test('discovery rejects invalid network policy before transport instead of treating it as remote opt-in', (t) => {
  const work = project(t);
  const path = join(work.root, '.neomind/automation.json');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  for (const network_policy of [null, '', 'offline', true, 1, [], {}]) {
    writeFileSync(path, JSON.stringify({ ...policy, network_policy }));
    const remote = github();
    assert.throws(() => discoverProjectKnowledge(work.root, classification, remote.request), /network_policy/);
    assert.deepEqual(remote.calls, []);
  }
});

test('same-platform results are advisory across frameworks and require explicit version/difference review', (t) => {
  const work = project(t);
  const source = fetchSource(work);
  const similar = searchProjectKnowledge(work.root, { platforms: ['windows'], frameworks: ['Different framework'] });
  assert.equal(similar[0].source_id, source.source_id);
  assert.equal(similar[0].score, 100);
  assert.equal(searchProjectKnowledge(work.root, classification)[0].score, 150);
  assert.throws(() => recordKnowledgeResearch(work.root, work.workflowId,
    research(source, { selected_sources: [{ source_id: source.source_id, applicability, differences: 'same' }] })), /differences/);
  const record = recordKnowledgeResearch(work.root, work.workflowId, research(source));
  assert.equal(record.meta.data.workflow_id, work.workflowId);
  assert.equal(record.meta.data.kind, 'knowledge-research');
  assert.equal(record.meta.owner, 'owner');
  assert.ok(record.meta.links.some((link) => link.type === 'documents' && link.target === work.workflowId));
  assert.match(record.meta.data.source_fingerprints[source.source_id], /^[a-f0-9]{64}$/);
  assert.equal(record.meta.data.provenance_refs[0].commit, sha);
  assert.deepEqual(knowledgeResearchProblems(work.root, work.workflowId, { check_workspace: true }), []);
});

test('FTS5 indexes narrative content, safely tokenizes query punctuation, and rebuilds after SQLite deletion', (t) => {
  const work = project(t);
  const source = fetchSource(work);
  const query = { platforms: ['Unrelated platform'], frameworks: [], query: 'zephyr' };
  assert.equal(searchProjectKnowledge(work.root, query)[0].source_id, source.source_id);
  const database = join(work.root, '.neomind/cache/knowledge.sqlite');
  const db = new DatabaseSync(database);
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM narrative_search WHERE narrative_search MATCH 'zephyr'").get().count, 1);
  } finally { db.close(); }
  rmSync(database);
  assert.equal(searchProjectKnowledge(work.root, query)[0].source_id, source.source_id);
  assert.ok(existsSync(database));
  assert.doesNotThrow(() => searchProjectKnowledge(work.root, { ...query, query: '" OR * ( ) : zephyr' }));
  assert.throws(() => searchProjectKnowledge(work.root, query, 101), /limit/);
});

test('no-match research is explicit, substantive, workflow-owned, and requires inspected paths and queries', (t) => {
  const work = project(t);
  assert.match(knowledgeResearchProblems(work.root, work.workflowId).join(' '), /research is required/);
  assert.deepEqual(discoverProjectKnowledge(work.root, classification, github({ pages: [[]] }).request), []);
  for (const patch of [
    { no_match_reason: undefined }, { no_match_reason: 'No matches' },
    { no_match_reason: 'placeholder '.repeat(8) }, { queries: [] }, { workspace_paths: [] },
    { platforms: [] }, { frameworks: undefined }, { summary: 'Done' },
  ]) assert.throws(() => recordKnowledgeResearch(work.root, work.workflowId, research(null, patch)));
  const record = recordKnowledgeResearch(work.root, work.workflowId, research(null));
  assert.equal(record.meta.data.no_match_reason, noMatchReason);
  assert.deepEqual(record.meta.data.selected_sources, []);
  assert.deepEqual(knowledgeResearchProblems(work.root, work.workflowId), []);
  const nonWorkflow = createRecord(work.root, { type: 'knowledge', title: 'Not a workflow' });
  assert.throws(() => recordKnowledgeResearch(work.root, nonWorkflow.meta.id, research(null)), /manager-workflow/);
});

test('gate is opt-in and validates only the latest owned research record', (t) => {
  const work = project(t, false);
  assert.deepEqual(knowledgeResearchProblems(work.root, work.workflowId), []);
  updateRecord(work.root, work.workflowId, { data: { knowledge_research_required: true } });
  recordKnowledgeResearch(work.root, work.workflowId, research(null));
  const latest = recordKnowledgeResearch(work.root, work.workflowId, research(null));
  updateRecord(work.root, latest.meta.id, { data: { complete: false } });
  assert.match(knowledgeResearchProblems(work.root, work.workflowId).join(' '), /incomplete/);
});

test('workspace hashes gate pre-planning freshness only, not expected implementation changes', (t) => {
  const work = project(t);
  const record = recordKnowledgeResearch(work.root, work.workflowId, research(null));
  assert.equal(record.meta.data.workspace_hashes['configuration.ts'], hash('export const version = 24;\n'));
  writeFileSync(join(work.root, 'configuration.ts'), 'export const version = 25;\n');
  assert.deepEqual(knowledgeResearchProblems(work.root, work.workflowId), []);
  assert.match(knowledgeResearchProblems(work.root, work.workflowId, { check_workspace: true }).join(' '), /baseline changed before planning/);
  rmSync(join(work.root, 'configuration.ts'));
  assert.deepEqual(knowledgeResearchProblems(work.root, work.workflowId), [], 'Implementation may remove an inspected source');
  assert.match(knowledgeResearchProblems(work.root, work.workflowId, { check_workspace: true }).join(' '), /validation failed/);
});

test('source artifact tampering blocks searches and research even without workspace checking', (t) => {
  const work = project(t);
  const source = fetchSource(work);
  recordKnowledgeResearch(work.root, work.workflowId, research(source));
  rewrite(join(work.root, '.neomind/knowledge-cache', `${source.source_id}.md`), 'Changed upstream artifact');
  assert.throws(() => searchProjectKnowledge(work.root, classification), /hash mismatch/);
  assert.match(knowledgeResearchProblems(work.root, work.workflowId).join(' '), /artifact hash mismatch/);
  assert.throws(() => recordKnowledgeResearch(work.root, work.workflowId, research(source)), /hash mismatch/);
});

test('metadata fingerprints bind selected provenance and detect source removal', (t) => {
  const work = project(t);
  const source = fetchSource(work);
  recordKnowledgeResearch(work.root, work.workflowId, research(source));
  const metadataPath = join(work.root, '.neomind/knowledge-cache', `${source.source_id}.json`);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  rewrite(metadataPath, JSON.stringify({ ...metadata, branch: 'neomind/knowledge/changed' }));
  assert.match(knowledgeResearchProblems(work.root, work.workflowId).join(' '), /stale source references/);
  chmodSync(metadataPath, 0o600);
  rmSync(metadataPath);
  assert.match(knowledgeResearchProblems(work.root, work.workflowId).join(' '), /validation failed/);
});

test('rejected sources carry verified provenance and cannot overlap selected sources', (t) => {
  const work = project(t);
  const source = fetchSource(work);
  const rejected = { source_id: source.source_id,
    reason: 'The upstream implementation assumes a different transaction lifecycle and cannot safely replace this configuration mechanism.' };
  const record = recordKnowledgeResearch(work.root, work.workflowId, research(null, { rejected_sources: [rejected] }));
  assert.equal(record.meta.data.provenance_refs[0].source_id, source.source_id);
  assert.deepEqual(knowledgeResearchProblems(work.root, work.workflowId), []);
  assert.throws(() => recordKnowledgeResearch(work.root, work.workflowId,
    research(source, { rejected_sources: [rejected] })), /unique/);
  assert.throws(() => recordKnowledgeResearch(work.root, work.workflowId,
    research({ source_id: 'f'.repeat(64) })), /ENOENT/);
});

test('remote authentication, missing paths, and network errors remain blockers even with cached matches', (t) => {
  const work = project(t);
  fetchSource(work);
  for (const error of [
    Object.assign(new Error('HTTP 401: authentication required'), { status: 401 }),
    Object.assign(new Error('HTTP 404: repository not accessible'), { status: 404 }),
    new Error('Network unavailable'),
  ]) assert.throws(() => discoverProjectKnowledge(work.root, classification, github({ error }).request),
    (caught) => caught === error);
  const remote = github();
  remote.state.before = (endpoint) => {
    if (endpoint.includes('/contents/')) throw new Error('HTTP 403: token lacks permissions');
  };
  assert.throws(() => discoverProjectKnowledge(work.root, classification, remote.request), /403/);
  assert.deepEqual(discoverProjectKnowledge(work.root, classification, github({ pages: [[]] }).request), [],
    'Successful empty discovery must not return old cached matches');
  assert.equal(searchProjectKnowledge(work.root, classification).length, 1, 'Offline local search still works');
});

test('reject unsafe repository overrides, branches, commit identities, paths and symlink blobs before caching', (t) => {
  for (const invalid of ['../other', 'https://token@github.com/example/shared', 'example/shared?token=x']) {
    const work = project(t);
    assert.throws(() => discoverProjectKnowledge(work.root, { ...classification, repository: invalid }, github().request), /repository|upstream/);
  }
  const work = project(t);
  assert.throws(() => discoverProjectKnowledge(work.root, { ...classification, repository: 'other/repository' }, github().request), /configured/);
  for (const name of ['neomind/knowledge/../private', 'neomind/knowledge/.hidden', 'neomind/knowledge/bad.lock']) {
    assert.throws(() => discoverProjectKnowledge(work.root, classification,
      github({ pages: [[{ name, commit: { sha } }]] }).request), /branch/);
  }
  assert.throws(() => discoverProjectKnowledge(work.root, classification,
    github({ pages: [[{ name: branch, commit: { sha: 'main' } }]] }).request), /commit SHA/);
  for (const path of [
    'knowledge/projects/../../.env',
    `knowledge/projects/${projectHash}/notes/../private.json`,
    `knowledge/projects/${projectHash}/notes/credentials/1.0.0.json`,
    `knowledge/projects/${projectHash}/notes/valid/01.0.0.json`,
  ]) assert.throws(() => discoverProjectKnowledge(work.root, classification,
    github({ tree: [{ path, type: 'blob', mode: '100644' }] }).request), /path/);
  assert.throws(() => discoverProjectKnowledge(work.root, classification,
    github({ tree: [{ path: artifact, type: 'blob', mode: '120000' }] }).request), /regular/);
  assert.ok(!existsSync(join(work.root, '.neomind/knowledge-cache')));
});

test('reject wrong hashes, companion/catalog disagreement, schemas and private remote content', (t) => {
  for (const patch of [
    { sha256: '0'.repeat(64) }, { schema: 'untrusted-schema' },
    { artifact_path: artifact.replace('1.2.3', '2.0.0') },
    { title: 'file:///C:/private/configuration' }, { provenance: ['api_key=confidential-value'] },
    { applicability: [] }, { platforms: 'Windows' },
  ]) {
    const work = project(t);
    assert.throws(() => discoverProjectKnowledge(work.root, classification, github({ entry: patch }).request));
    assert.ok(!existsSync(join(work.root, '.neomind/knowledge-cache')));
  }
  const work = project(t);
  const disagreement = github();
  disagreement.files.set(artifact.replace(/\.md$/, '.json'), JSON.stringify({ ...disagreement.entry, title: 'Changed title' }));
  assert.throws(() => discoverProjectKnowledge(work.root, classification, disagreement.request), /disagree/);
  const privateArtifact = github();
  privateArtifact.files.set(artifact, narrative + '\npassword=private-password\n');
  assert.throws(() => discoverProjectKnowledge(work.root, classification, privateArtifact.request), /private content/);
});

test('pagination is bounded and incomplete/truncated remote results are explicit blockers', (t) => {
  const work = project(t);
  const unrelated = Array.from({ length: 100 }, (_, index) => ({ name: `feature-${index}`, commit: { sha } }));
  const paged = github({ pages: [unrelated, [{ name: branch, commit: { sha } }]] });
  assert.equal(fetchSource(work, paged).commit, sha);
  assert.equal(paged.calls.filter((call) => call.endpoint.includes('/branches?')).length, 2);
  const endless = github({ pages: Array.from({ length: 10 }, () => unrelated) });
  assert.throws(() => discoverProjectKnowledge(work.root, classification, endless.request), /ten pages/);
  assert.equal(endless.calls.length, 10);
  assert.throws(() => discoverProjectKnowledge(work.root, classification, github({ truncated: true }).request), /truncated/);
  const huge = github({ tree: Array.from({ length: 20001 }, () => ({ path: 'README.md' })) });
  assert.throws(() => discoverProjectKnowledge(work.root, classification, huge.request), /bounds/);
});

test('oversize, malformed base64 and missing companion pairs never become successful no-match discovery', (t) => {
  const work = project(t);
  const remote = github();
  remote.files.set(artifact, 'x'.repeat(512 * 1024 + 1));
  assert.throws(() => discoverProjectKnowledge(work.root, classification, remote.request), /bounds/);
  const missing = github();
  missing.files.delete(artifact.replace(/\.md$/, '.json'));
  assert.throws(() => discoverProjectKnowledge(work.root, classification, missing.request), /companion/);
  const good = github();
  assert.throws(() => discoverProjectKnowledge(work.root, classification, (method, endpoint) =>
    endpoint.includes('/contents/') ? { type: 'file', encoding: 'base64', content: 'not!base64' } : good.request(method, endpoint)), /base64/);
});

test('reject sensitive, managed, lock, outside and generated workspace snapshots', (t) => {
  const work = project(t);
  for (const path of [
    '../outside.ts', 'D:/private.ts', '.env', '.env.production', '.neomind/config.json',
    '.verythinker/config.json', '.git/config', 'credentials.json', 'config/private/settings.json',
    'package-lock.json', 'pnpm-lock.yaml', 'Cargo.lock', 'config/key.pem', 'node_modules/source.js',
    'dist/output.js', 'folder\\source.ts',
  ]) assert.throws(() => recordKnowledgeResearch(work.root, work.workflowId,
    research(null, { workspace_paths: [path] })), /path|Sensitive/);
});

test('reject in-workspace symlink snapshots and cache-directory links', (t) => {
  const work = project(t);
  try { symlinkSync(join(work.root, 'configuration.ts'), join(work.root, 'linked.ts'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Creating symlinks requires OS permission'); return; }
    throw error;
  }
  assert.throws(() => recordKnowledgeResearch(work.root, work.workflowId,
    research(null, { workspace_paths: ['linked.ts'] })), /links/);
  const target = join(work.root, 'external-cache');
  mkdirSync(target);
  symlinkSync(target, join(work.root, '.neomind/knowledge-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => searchProjectKnowledge(work.root, classification), /links/);
});

test('native record ownership is inherited without manager imports or remote mutations', (t) => {
  const work = project(t);
  const native = createRecord(work.root, {
    type: 'knowledge', title: 'Native increment', owner: 'native-owner',
    data: { kind: 'manager-workflow', execution_mode: 'copilot-native', routing_required: false,
      knowledge_research_required: true },
  });
  const record = recordKnowledgeResearch(work.root, native.meta.id, research(null));
  assert.equal(record.meta.data.workflow_id, native.meta.id);
  assert.equal(record.meta.data.assurance, 'unsigned-native-report');
  assert.equal(record.meta.data.routing_required, false);
  assert.deepEqual(knowledgeResearchProblems(work.root, native.meta.id), []);
});
