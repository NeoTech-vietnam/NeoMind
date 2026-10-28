// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRecord, getRecord, hash, readConfig, updateRecord } from '../dist/storage.js';
import { recordFingerprint, reviewRecord } from '../dist/engineering.js';
import { createCornellNote } from '../dist/notes.js';
import { ensureAutomationPolicy } from '../dist/manager.js';
import { discoverProjectKnowledge, knowledgeResearchProblems, recordKnowledgeResearch, searchProjectKnowledge } from '../dist/knowledge-reuse.js';
import { prepareProjectKnowledge, publishProjectKnowledge } from '../dist/project-knowledge.js';
import { restoreArchive } from '../dist/archives.js';
import { cornellFixture } from './cornell-fixture.mjs';

const repository = 'example/shared';
const sha = 'a'.repeat(40), projectHash = 'b'.repeat(64);
const artifact = `knowledge/projects/${projectHash}/notes/atomic-updates/1.2.3.md`;
const manifest = `knowledge/projects/${projectHash}/manifest.json`;
const narrative = '# Atomic replacement\n\nValidate replacement bytes before atomic publication on Windows.\n';
const classification = { platforms: ['Windows'], frameworks: ['Node.js'] };

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-history-schema-'));
  initialize(root);
  const policy = ensureAutomationPolicy(root);
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ ...policy,
    upstream: repository, network_policy: 'remote-enabled' }));
  t.after(() => {
    const cache = join(root, '.neomind/knowledge-cache');
    if (existsSync(cache)) for (const name of readdirSync(cache)) chmodSync(join(cache, name), 0o600);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function oldEntry(path = artifact) {
  return { schema_version: 1, schema: 'taskforces-project-knowledge-note', title: 'Atomic replacement',
    ...classification, applicability: ['Durable local configuration applications.'],
    provenance: ['https://nodejs.org/api/fs.html'], artifact_path: path, sha256: hash(narrative) };
}
function oldSource() {
  const entry = oldEntry();
  return { schema_version: 1, schema: 'taskforces-project-knowledge-cache',
    source_id: hash(JSON.stringify([repository, sha, artifact])), repo: repository,
    branch: `taskforces/knowledge/${projectHash.slice(0, 16)}`, commit: sha,
    path: artifact, sha256: entry.sha256, entry };
}

test('historical cache bytes and research provenance fingerprints remain unchanged when read', t => {
  const root = project(t), source = oldSource();
  mkdirSync(join(root, '.neomind/knowledge-cache'));
  const metadata = join(root, `.neomind/knowledge-cache/${source.source_id}.json`);
  const bytes = JSON.stringify(source, null, 2) + '\n';
  writeFileSync(metadata, bytes);
  writeFileSync(join(root, `.neomind/knowledge-cache/${source.source_id}.md`), narrative);
  assert.equal(searchProjectKnowledge(root, classification)[0].branch, source.branch);
  const workflow = createRecord(root, { type: 'knowledge', title: 'Reuse original provenance', owner: 'manager',
    data: { kind: 'manager-workflow', knowledge_research_required: true } });
  writeFileSync(join(root, 'config.ts'), 'export const runtimeVersion = 24;\n');
  const research = recordKnowledgeResearch(root, workflow.meta.id, {
    ...classification, workspace_paths: ['config.ts'], queries: ['Atomic replacement on Windows'],
    selected_sources: [{ source_id: source.source_id,
      applicability: 'The historical note covers the same durable configuration lifecycle and Windows filesystem behavior.',
      differences: 'The recorded source predates this runtime; verify atomic rename behavior against the present Node release.' }],
    summary: 'Inspected current configuration storage and compared the historical replacement pattern with present platform constraints.',
  });
  assert.equal(research.meta.data.provenance_refs[0].fingerprint, hash(JSON.stringify(source)));
  assert.deepEqual(knowledgeResearchProblems(root, workflow.meta.id, { check_workspace: true }), []);
  assert.equal(readFileSync(metadata, 'utf8'), bytes);
  writeFileSync(metadata, JSON.stringify({ ...source, schema: 'foreign-project-knowledge-cache' }));
  assert.throws(() => searchProjectKnowledge(root, classification), /provenance mismatch/);
});

test('historical branches, catalogs and companions are discoverable while new cache envelopes use NeoMind', t => {
  const root = project(t), source = oldSource();
  const files = new Map([[artifact, narrative], [artifact.replace(/\.md$/, '.json'), JSON.stringify(source.entry)],
    [manifest, JSON.stringify({ schema_version: 1, schema: 'taskforces-project-knowledge-catalog', notes: [source.entry] })]]);
  const request = (method, endpoint) => {
    assert.equal(method, 'GET');
    const url = new URL(`https://api.github.com/${endpoint}`);
    if (url.pathname.endsWith('/branches')) return [{ name: source.branch, commit: { sha } }];
    if (url.pathname.endsWith(`/git/trees/${sha}`)) return { truncated: false,
      tree: [...files].map(([path, content]) => ({ path, type: 'blob', mode: '100644', size: Buffer.byteLength(content) })) };
    const path = url.pathname.split('/contents/')[1];
    assert.equal(url.searchParams.get('ref'), sha);
    assert.ok(files.has(path));
    const content = files.get(path);
    return { type: 'file', path, encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
  };
  const [found] = discoverProjectKnowledge(root, classification, request);
  assert.equal(found.branch, source.branch);
  const path = join(root, `.neomind/knowledge-cache/${found.source_id}.json`);
  const saved = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(saved).schema, 'neomind-project-knowledge-cache');
  assert.deepEqual(JSON.parse(saved).entry, source.entry, 'Upstream source identity is preserved');
  discoverProjectKnowledge(root, classification, request);
  assert.equal(readFileSync(path, 'utf8'), saved, 'Discovery does not rewrite immutable source metadata');
});

function publicCandidate(root) {
  const workflow = createRecord(root, { type: 'knowledge', title: 'Current publication', owner: 'manager',
    data: { kind: 'manager-workflow' } });
  const requirement = createRecord(root, { type: 'requirement', title: 'Document durable replacement', owner: 'owner',
    body: 'Document the verified durable replacement lifecycle and its applicability.' });
  const note = createCornellNote(root, cornellFixture(workflow.meta.id, requirement.meta.id));
  const candidate = createRecord(root, { type: 'knowledge', title: 'Durable replacement pattern', owner: 'curator',
    data: { invocation_id: 'curation-current', workflow_id: workflow.meta.id,
      generalization: 'A reusable public description of validated durable replacement.', public_safe: true,
      public_cornell: {
        cues: 'How can configuration updates preserve a valid representation when validation fails?',
        notes: 'Validate the complete replacement representation before writing it to durable storage. Keep the previous valid bytes available until the replacement passes validation, and use atomic replacement to avoid exposing partial writes to readers.',
        summary: 'Validate first and replace atomically so failed updates preserve a usable configuration.',
        application: 'Apply this pattern to applications that maintain local configuration and need crash-safe updates.',
      }, cornell_note_ids: [note.meta.id], cornell_note_fingerprints: { [note.meta.id]: recordFingerprint(note) },
      pack_id: 'current-pattern', pack_version: '1.0.0', ...classification,
      applicability: ['Applications with durable local configuration.'], provenance: ['https://nodejs.org/api/fs.html'] } });
  const review = reviewRecord(root, candidate.meta.id, 'reviewer', 'pass', [], 'review-current', true);
  updateRecord(root, review.meta.id, { data: { public_safe: true } });
  return candidate.meta.id;
}

test('new publication merges a historical catalog without changing old entry provenance', t => {
  const root = project(t), id = publicCandidate(root), prepared = prepareProjectKnowledge(root, id);
  const previous = oldEntry(`knowledge/projects/${prepared.project_hash}/notes/atomic-updates/1.2.3.md`);
  let treeFiles;
  const stop = new Error('Stopped after inspecting the proposed tree');
  const request = (method, endpoint, body) => {
    if (method === 'GET' && endpoint.includes('/git/ref/heads/')) return { object: { sha } };
    if (method === 'GET' && endpoint.endsWith(`/git/commits/${sha}`)) return { sha, tree: { sha: 'base-tree' } };
    if (method === 'GET' && endpoint.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(JSON.stringify({
      schema_version: 1, schema: 'taskforces-project-knowledge-catalog', notes: [previous],
    })).toString('base64') };
    if (method === 'POST' && endpoint.endsWith('/git/trees')) { treeFiles = body.tree; throw stop; }
    assert.fail(`Unexpected mock request ${method} ${endpoint}`);
  };
  assert.throws(() => publishProjectKnowledge(root, id, repository, request), error => error === stop);
  const catalog = JSON.parse(treeFiles.find(file => file.path === prepared.manifest_path).content);
  assert.equal(catalog.schema, 'neomind-project-knowledge-catalog');
  assert.deepEqual(catalog.notes.find(note => note.artifact_path === previous.artifact_path), previous);
  assert.equal(catalog.notes.find(note => note.artifact_path === prepared.path).schema, 'neomind-project-knowledge-note');
  assert.equal(JSON.parse(treeFiles.find(file => file.path === prepared.path.replace(/\.md$/, '.json')).content).schema,
    'neomind-project-knowledge-note');
});

test('historical archive record paths restore with identical manifest and record bytes', t => {
  const root = project(t);
  const record = createRecord(root, { type: 'knowledge', title: 'Frozen source history', owner: 'curator',
    body: 'Historical artifact content remains exactly as captured.' });
  const id = randomUUID(), directory = `.neomind/archives/${id}`;
  const inputs = [
    { path: '.taskforces/config.json', content: readFileSync(join(root, '.neomind/config.json')) },
    { path: `.taskforces/records/${record.meta.id}.md`, content: readFileSync(join(root, record.path)) },
  ];
  for (const input of inputs) {
    const path = join(root, directory, 'workspace', input.path);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, input.content);
  }
  const manifest = { schema_version: 1, snapshot_id: id, project_id: readConfig(root).project_id,
    workflow_id: record.meta.id, increment_id: 'history', disposition: 'working', assurance: 'unsigned-legacy',
    release: null, change_type: 'fix', created_at: '2026-10-11T00:00:00Z', captured_baseline: null,
    source_revision: null, namespace: 'historical', repository,
    files: inputs.map(input => ({ path: input.path, hash: hash(input.content), mode: '100644', bytes: input.content.length })),
    records: [{ id: record.meta.id, path: inputs[1].path, fingerprint: recordFingerprint(record), revision: record.meta.revision }],
    deleted_paths: [], omissions: [], submodules: [], reproduction: [] };
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(root, directory, 'manifest.json'), manifestBytes);
  writeFileSync(join(root, directory, 'identity.json'), JSON.stringify({ schema_version: 1, manifest_hash: hash(manifestBytes) }));
  const destination = mkdtempSync(join(tmpdir(), 'neomind-history-restore-'));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  assert.equal(restoreArchive(root, id, destination).records, 1);
  const restored = getRecord(destination, record.meta.id);
  assert.equal(recordFingerprint(restored), recordFingerprint(record));
  assert.match(restored.path, /^\.workforce\//);
  assert.equal(existsSync(join(destination, '.neomind')), false);
  assert.equal(readFileSync(join(destination, restored.path), 'utf8'), inputs[1].content.toString());
  assert.equal(readFileSync(join(root, directory, 'manifest.json'), 'utf8'), manifestBytes);
});
