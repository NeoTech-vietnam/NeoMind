import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, loadRecords } from '../dist/storage.js';
import { saveAgentMarketplaceCatalog } from '../dist/agent-capability-cache.js';
import { nativeAutomationPolicy } from '../dist/manager.js';
import { manageNativeCapabilities, nativeCapabilityInputSchema, nativeCapabilityJsonSchema,
  nativeCapabilitySourceJsonSchema, DEFAULT_NATIVE_CAPABILITY_SOURCES } from '../dist/native-capabilities.js';

const repo = 'https://github.com/example/approved-guidance', commit = 'a'.repeat(40);
const catalogPath = '.github/plugin/marketplace.json', skillRoot = 'plugins/docs/skills/human-docs';
const sha = value => createHash('sha256').update(value).digest('hex');
const blob = value => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${value.length}\0`), value])).digest('hex');
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-capabilities-'));
  initialize(root, { project_id: 'WF-CAPABILITIES' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t, changes = {}) {
  const root = project(t), files = new Map([
    [catalogPath, Buffer.from(JSON.stringify({ name: 'reviewed-catalog', plugins: [
      { name: 'docs', description: 'Writing readable documentation', source: 'plugins/docs' },
      ...(changes.plugins ?? []),
    ] }))],
    ['plugins/docs/plugin.json', Buffer.from(JSON.stringify({ name: 'docs', version: '1.0.0', license: 'MIT', skills: ['skills'], ...(changes.manifest ?? {}) }))],
    [`${skillRoot}/SKILL.md`, Buffer.from(changes.skillText ?? '---\nname: human-docs\ndescription: Write readable technical documentation.\n---\nUse references/checklist.md and preserve facts.\n')],
    [`${skillRoot}/references/checklist.md`, Buffer.from('# Checklist\nPreserve facts and use concrete examples.\n')],
    [`${skillRoot}/assets/sample.bin`, Buffer.from([0, 1, 2, 3])],
    ['LICENSE', Buffer.from('MIT License\nCopyright fixture authors\n')],
  ]);
  const calls = [], policy = { name: 'reviewed', repository: repo, commit, catalog_path: catalogPath,
    catalog_sha256: sha(files.get(catalogPath)), license_path: 'LICENSE', license_sha256: sha(files.get('LICENSE')), allow_skills: true };
  const json = (value, url, status = 200) => {
    const response = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    if (changes.beforeFetch) await changes.beforeFetch(url, options);
    if (url.includes('/git/trees/')) {
      const directories = new Set();
      for (const path of files.keys()) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/')); }
      const tree = [...directories].map(path => ({ path, type: 'tree', mode: '040000', sha: 'b'.repeat(40) }));
      for (const [path, content] of files) tree.push({ path, type: 'blob', mode: changes.symlink === path ? '120000' : '100644', sha: blob(content), size: content.length });
      return json({ sha: 'b'.repeat(40), url: `https://api.github.com/repos/example/approved-guidance/git/trees/${'b'.repeat(40)}`, tree, truncated: false }, url);
    }
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1] ?? ''), content = files.get(path);
    if (!content || path === changes.missing) return json({ message: 'not found' }, url, 404);
    return json({ name: path.split('/').at(-1), path, type: 'file', sha: blob(content), size: content.length,
      url, git_url: `https://api.github.com/repos/example/approved-guidance/git/blobs/${blob(content)}`,
      encoding: 'base64', content: content.toString('base64') }, url);
  };
  const options = extra => ({ sources: [policy], fetch, readPolicy: () => ({ network_policy: 'remote-enabled' }), ...extra });
  const run = (input, extra) => manageNativeCapabilities(root, input, options(extra));
  return { root, files, calls, policy, fetch, options, run };
}
const installInput = { action: 'install', source: 'reviewed', package: 'docs', skill: 'human-docs', role: 'WF.FnD' };
const target = f => join(f.root, '.github/skills/human-docs');
function noPublication(f) { assert.equal(existsSync(target(f)), false); assert.deepEqual(loadRecords(f.root), []); }

test('model schema exposes only content selections and host source schema owns exact reviewed pins', async t => {
  const f = fixture(t);
  for (const extra of [{ approved: true }, { repository: repo }, { path: 'skills/evil' }, { assignment_id: 'forged' },
    { workflow_id: 'forged' }, { network_policy: 'remote-enabled' }, { isCurrent: true }, { fetch: 'fake' }]) {
    assert.equal(nativeCapabilityInputSchema.safeParse({ ...installInput, ...extra }).success, false);
    assert.equal((await f.run({ ...installInput, ...extra })).reason, 'INVALID_INPUT');
  }
  assert.equal(nativeCapabilityJsonSchema.additionalProperties, false);
  assert.equal(nativeCapabilitySourceJsonSchema.additionalProperties, false);
  assert.equal(nativeCapabilitySourceJsonSchema.properties.catalog_sha256.type, 'string');
  assert.equal(DEFAULT_NATIVE_CAPABILITY_SOURCES[0].commit, '02466d1eb70b841c90717b0fc2dc9457aa6f606f');
  assert.equal(f.calls.length, 0); noPublication(f);
});

test('search caches only exact approved complete catalog bytes and a fresh no-match performs zero fetches', async t => {
  const f = fixture(t);
  const first = await f.run({ action: 'search', query: 'documentation' });
  assert.equal(first.state, 'available', JSON.stringify(first)); assert.equal(first.candidates[0].name, 'docs');
  assert.ok(first.candidates.length <= 5); const count = f.calls.length;
  const cached = await f.run({ action: 'search', query: 'documentation' }, { fetch() { assert.fail('Fresh cache must not fetch'); } });
  assert.equal(cached.state, 'available'); assert.equal(cached.candidates[0].name, 'docs');
  assert.equal(cached.candidates[0].source_name, first.candidates[0].source_name);
  assert.deepEqual(cached.candidates[0].package, first.candidates[0].package);
  const absent = await f.run({ action: 'search', query: 'nonexistent-specialty' }, { fetch() { assert.fail('Fresh catalog already proves no match'); } });
  assert.deepEqual(absent.candidates, []); assert.equal(f.calls.length, count); noPublication(f);
});

test('two approved source names have identical cold/cache handoffs and ambiguity returns friendly names', async t => {
  const f = fixture(t), sources = [f.policy, { ...f.policy, name: 'also-reviewed' }];
  const cold = await f.run({ action: 'search', query: 'documentation' }, { sources });
  const warm = await f.run({ action: 'search', query: 'documentation' }, { sources, fetch() { assert.fail('Both catalogs are cached'); } });
  const selections = value => value.candidates.map(({ name, source_name, package: target }) => ({ name, source_name, target }))
    .sort((a, b) => a.source_name.localeCompare(b.source_name));
  assert.deepEqual(selections(warm), selections(cold)); assert.equal(warm.candidates.length, 2);
  const ambiguous = await f.run({ action: 'inspect', package: 'docs' }, { sources });
  assert.equal(ambiguous.reason, 'SELECT_APPROVED_SOURCE');
  assert.deepEqual(ambiguous.available_sources, ['reviewed', 'also-reviewed']); noPublication(f);
});

test('a fresh source survives an unrelated missing source failure without being fetched again', async t => {
  const f = fixture(t); await f.run({ action: 'search', query: 'documentation' }); const before = f.calls.length;
  const offline = { ...f.policy, name: 'offline-source', repository: 'https://github.com/example/offline' };
  let offlineCalls = 0;
  const result = await f.run({ action: 'search', query: 'documentation' }, { sources: [f.policy, offline], async fetch(url) {
    assert.equal(url.includes('/example/approved-guidance/'), false, 'The valid cached source must not be refreshed');
    offlineCalls++; const response = new Response('{}', { status: 503 }); Object.defineProperty(response, 'url', { value: url }); return response;
  } });
  assert.equal(result.state, 'partial', JSON.stringify(result)); assert.equal(result.candidates[0].source_name, 'reviewed');
  assert.equal(result.candidates[0].name, 'docs'); assert.equal(result.issues[0].source_name, 'offline-source');
  assert.equal(f.calls.length, before); assert.equal(offlineCalls, 1); noPublication(f);
});

test('actual project local-only policy refuses all remote fetches and local status remains usable', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.workforce/automation.json'), JSON.stringify(nativeAutomationPolicy()));
  const result = await f.run({ action: 'search', query: 'documentation' }, { readPolicy: undefined });
  assert.equal(result.reason, 'NETWORK_DISABLED'); assert.equal(result.fallback, 'ordinary-work'); assert.equal(f.calls.length, 0);
  assert.equal((await f.run({ action: 'status' }, { readPolicy: undefined })).installation, 'not-performed');
  noPublication(f);
});

test('revoked source policies cannot use a formerly valid cache or install using an unapproved name', async t => {
  const f = fixture(t); await f.run({ action: 'search', query: 'documentation' }); const count = f.calls.length;
  const revoked = await f.run({ action: 'search', query: 'documentation' }, { sources: [] });
  assert.equal(revoked.reason, 'NO_APPROVED_SOURCES'); assert.deepEqual(revoked.candidates, []);
  assert.equal((await f.run(installInput, { sources: [] })).reason, 'SOURCE_NOT_APPROVED');
  assert.equal(f.calls.length, count); noPublication(f);
});

test('catalog hash mismatch and invalid host policies never populate discovery cache or publish files', async t => {
  const f = fixture(t);
  const wrong = await f.run({ action: 'search', query: 'documentation' }, { sources: [{ ...f.policy, catalog_sha256: '0'.repeat(64) }] });
  assert.equal(wrong.reason, 'CATALOG_HASH_MISMATCH'); assert.equal(existsSync(join(f.root, '.workforce/cache/agent-capabilities.sqlite')), false);
  const calls = f.calls.length;
  for (const override of [{ repository: 'https://evil.example/x/y' }, { commit: 'main' }, { catalog_path: '../private' }, { license_sha256: 'fake' }])
    assert.equal((await f.run(installInput, { sources: [{ ...f.policy, ...override }] })).reason, 'INVALID_SOURCE_POLICY');
  assert.equal(f.calls.length, calls); noPublication(f);
});

test('corrupt optional cache falls back to verified source metadata without rewriting the corrupt bytes', async t => {
  const f = fixture(t); mkdirSync(join(f.root, '.workforce/cache'), { recursive: true });
  const path = join(f.root, '.workforce/cache/agent-capabilities.sqlite'); writeFileSync(path, 'intentionally corrupt cache');
  const result = await f.run({ action: 'search', query: 'documentation' });
  assert.equal(result.state, 'available', JSON.stringify(result)); assert.equal(result.candidates[0].name, 'docs');
  assert.equal(readFileSync(path, 'utf8'), 'intentionally corrupt cache'); noPublication(f);
});

test('external package repository declarations never cause an external fetch or inherited catalog approval', async t => {
  const f = fixture(t, { plugins: [{ name: 'external', source: { source: 'github', repo: 'evil/unapproved', sha: commit } }] });
  const result = await f.run({ action: 'inspect', source: 'reviewed', package: 'external' });
  assert.equal(result.reason, 'SOURCE_NOT_APPROVED'); assert.ok(f.calls.every(call => !call.url.includes('/evil/'))); noPublication(f);
});

test('package inspection is metadata-only; selected-skill inspection reads bounded actual content without installing', async t => {
  const f = fixture(t, { skillText: '---\nname: human-docs\ndescription: Write readable documents.\n---\n' + 'Concrete source text.\n'.repeat(600) });
  const metadata = await f.run({ action: 'inspect', source: 'reviewed', package: 'docs' });
  assert.equal(metadata.state, 'available'); assert.equal(metadata.skill_contents, 'not-read');
  assert.equal(f.calls.filter(call => call.url.includes('SKILL.md')).length, 0);
  const result = await f.run({ action: 'inspect', source: 'reviewed', package: 'docs', skill: 'human-docs' });
  assert.equal(result.state, 'available', JSON.stringify(result)); assert.equal(result.skill.preview.length, 8000);
  assert.equal(result.skill.preview_truncated, true); assert.equal(result.skill.sha256, sha(f.files.get(`${skillRoot}/SKILL.md`)));
  assert.equal(result.skill.bytes, f.files.get(`${skillRoot}/SKILL.md`).length);
  assert.equal(result.installation, 'not-performed'); noPublication(f);
});

test('install derives the full selected skill subtree, immutable source and exact license without whole-plugin claims', async t => {
  const f = fixture(t, { skillText: '---\nname: human-docs\ndescription: Write readable documents.\n---\n[Checklist](references/checklist.md#facts)\n![Asset](assets/sample.bin)\n[Remote docs](https://example.com/docs)\n[Email](mailto:authors@example.com)\n' }), result = await f.run(installInput);
  assert.equal(result.state, 'installed', JSON.stringify(result)); assert.equal(result.installation_scope, 'workspace-skill-components-only');
  assert.equal(result.plugin_installation, 'not-performed'); assert.equal(result.host_loading, 'unverified'); assert.equal(result.execution, 'not-performed');
  assert.equal(result.files.length, 3); assert.equal(result.license_sha256, f.policy.license_sha256);
  for (const file of result.files) {
    const relative = file.path.slice(skillRoot.length + 1), actual = readFileSync(join(target(f), relative));
    assert.deepEqual(actual, f.files.get(file.path)); assert.equal(file.sha256, sha(actual));
  }
  const status = await f.run({ action: 'status', skill: 'human-docs' }, { fetch() { assert.fail('Status must remain local'); } });
  assert.equal(status.components[0].available, true); assert.equal(status.components[0].observations.used, 'not-observed');
  assert.deepEqual(loadRecords(f.root), [], 'Optional skill materialization does not create workflows or fake worker reports');
});

for (const reference of ['references/missing.md', '../outside.md'])
test(`missing or escaping relative skill references cannot be advertised as installable: ${reference}`, async t => {
  const f = fixture(t, { skillText: `---\nname: human-docs\ndescription: Write readable documents.\n---\n[Required guide](${reference})\n` });
  const result = await f.run(installInput);
  assert.equal(result.reason, 'UNSUPPORTED_SKILL_REFERENCE', JSON.stringify(result)); noPublication(f);
});

test('required dependencies and MCP/hook declarations are ordinary fallback rather than partial plugin installation', async t => {
  for (const manifest of [{ dependencies: ['npm:unapproved'] }, { mcpServers: { external: { command: 'unsafe' } } }, { hooks: ['hooks/run.json'] }]) {
    const f = fixture(t, { manifest }), result = await f.run(installInput);
    assert.equal(result.reason, 'UNSUPPORTED_REQUIRED_COMPONENTS', JSON.stringify(result)); assert.equal(result.fallback, 'ordinary-work'); noPublication(f);
  }
  const f = fixture(t, { skillText: '---\nname: human-docs\ndescription: Uses an unavailable dependency.\nrequires: [pandoc]\n---\nWrite a document.\n' });
  const inspected = await f.run({ action: 'inspect', source: 'reviewed', package: 'docs', skill: 'human-docs' });
  assert.equal(inspected.skill.declared_dependencies.unsupported_required, true); assert.equal(inspected.skill_installation, 'unsupported');
  assert.equal((await f.run(installInput)).reason, 'UNSUPPORTED_REQUIRED_COMPONENTS'); noPublication(f);
});

test('wrong license, missing selected assets, symlink inventories and incorrect frontmatter names cannot publish', async t => {
  const wrongLicense = fixture(t);
  assert.equal((await wrongLicense.run(installInput, { sources: [{ ...wrongLicense.policy, license_sha256: '0'.repeat(64) }] })).reason, 'LICENSE_HASH_MISMATCH'); noPublication(wrongLicense);
  for (const change of [{ missing: `${skillRoot}/references/checklist.md` }, { symlink: `${skillRoot}/assets/sample.bin` }]) {
    const f = fixture(t, change), result = await f.run(installInput); assert.equal(result.state, 'unavailable'); noPublication(f);
  }
  const f = fixture(t); assert.equal((await f.run({ ...installInput, skill: 'invented-name' })).reason, 'SKILL_NOT_FOUND'); noPublication(f);
});

test('explicit skill installation opt-out and unqualified package names do not infer alternate sources', async t => {
  const f = fixture(t);
  assert.equal((await f.run(installInput, { sources: [{ ...f.policy, allow_skills: false }] })).reason, 'SKILL_INSTALLATION_NOT_APPROVED');
  assert.equal((await f.run({ ...installInput, package: 'docs-other' })).reason, 'PACKAGE_NOT_FOUND'); noPublication(f);
});

test('cancellation and host-policy revocation during a deferred source read cannot cache or install', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  assert.equal((await f.run(installInput, { signal: controller.signal })).state, 'cancelled'); assert.equal(f.calls.length, 0);
  let current = true, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const slow = fixture(t, { async beforeFetch(url) { if (url.includes('/contents/')) { entered(); await blocked; } } });
  const pending = slow.run(installInput, { isCurrent: () => current });
  await waiting; current = false; release();
  const result = await pending; assert.equal(result.reason, 'CAPABILITY_POLICY_CHANGED');
  assert.equal(existsSync(join(slow.root, '.workforce/cache/agent-capabilities.sqlite')), false); noPublication(slow);
  const throwing = await f.run(installInput, { isCurrent() { throw new Error('PRIVATE host disposed'); } });
  assert.equal(throwing.reason, 'CAPABILITY_POLICY_CHANGED'); assert.equal(JSON.stringify(throwing).includes('PRIVATE'), false);
});

test('actual pinned portable manifest without component fields inspects and installs the real java-docs golden bytes', async t => {
  const vector = JSON.parse(readFileSync(new URL('./fixtures/native-capabilities/java-development-02466.json', import.meta.url), 'utf8'));
  const root = project(t), source = DEFAULT_NATIVE_CAPABILITY_SOURCES[0], calls = [];
  const files = new Map(vector.files.map(file => {
    const bytes = Buffer.from(file.content_base64, 'base64'); assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256);
    return [file.path, bytes];
  }));
  assert.equal(saveAgentMarketplaceCatalog(root, { catalog_id: 'native-approved/' + source.name, provenance: vector.catalog_provenance,
    candidates: [{ name: vector.candidate.name, description: vector.candidate.description,
      package: { repository: source.repository, commit: source.commit, path: vector.candidate.source_path },
      provenance: vector.catalog_provenance, state: 'source-pinned' }] }).state, 'stored');
  const options = { sources: [source], readPolicy: () => ({ network_policy: 'remote-enabled' }), async fetch(url, init) {
    assert.equal(init.credentials, 'omit'); calls.push(url);
    const response = value => { const result = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(result, 'url', { value: url }); return result; };
    if (url.includes('/git/trees/')) return response({ sha: source.commit,
      url: `https://api.github.com/repos/github/awesome-copilot/git/trees/${source.commit}`, tree: vector.tree, truncated: false });
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]), bytes = files.get(path);
    assert.ok(bytes, `Unexpected source read outside retained actual vectors: ${path}`);
    const entry = vector.tree.find(item => item.path === path); assert.equal(entry.mode, '100644'); assert.equal(blob(bytes), entry.sha);
    return response({ name: path.split('/').at(-1), path, type: 'file', sha: entry.sha, size: bytes.length, url,
      git_url: `https://api.github.com/repos/github/awesome-copilot/git/blobs/${entry.sha}`, encoding: 'base64', content: bytes.toString('base64') });
  } };
  const input = { action: 'inspect', source: source.name, package: 'java-development', skill: 'java-docs' };
  const inspected = await manageNativeCapabilities(root, input, options);
  assert.equal(inspected.state, 'available', JSON.stringify(inspected)); assert.equal(inspected.skill.bytes, 2087);
  assert.equal(inspected.skill.sha256, 'efc6ef95b4af71c8cf1a4f127c06e9f260e314dda81ba1862f140eef09956cec');
  assert.equal(calls.filter(url => url.includes('/SKILL.md')).length, 1, 'Normative name/directory binding avoids reading unrelated sibling skill headers');
  const installed = await manageNativeCapabilities(root, { ...input, action: 'install' }, options);
  assert.equal(installed.state, 'installed', JSON.stringify(installed)); assert.equal(installed.files.length, 1);
  assert.deepEqual(readFileSync(join(root, '.github/skills/java-docs/SKILL.md')), files.get('plugins/java-development/skills/java-docs/SKILL.md'));
  assert.equal(installed.license_sha256, source.license_sha256); assert.deepEqual(loadRecords(root), []);
});

test('portable fixed layout ignores nested non-skill SKILL.md files and refuses actual fixed MCP configuration', async t => {
  const manifest = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', skills: undefined };
  const f = fixture(t, { manifest });
  f.files.set('plugins/docs/skills/templates/ghost/SKILL.md', Buffer.from('---\nname: ghost\ndescription: A nested template, not an immediate skill.\n---\nTemplate.\n'));
  const nested = await f.run({ action: 'inspect', source: 'reviewed', package: 'docs', skill: 'ghost' });
  assert.equal(nested.reason, 'SKILL_NOT_FOUND', JSON.stringify(nested)); assert.equal(nested.retryable, false);
  assert.match(nested.next_action, /Do not repeat/); assert.equal(f.calls.some(call => call.url.includes('templates/ghost/SKILL.md')), false);
  const mcp = fixture(t, { manifest }); mcp.files.set('plugins/docs/mcp.json', Buffer.from('{}'));
  assert.equal((await mcp.run(installInput)).reason, 'UNSUPPORTED_REQUIRED_COMPONENTS'); noPublication(mcp);
});

test('schema-less explicit empty or inline declarations never invent a portable default directory', async t => {
  for (const skills of [[], {}]) {
    const f = fixture(t, { manifest: { skills } }), result = await f.run(installInput);
    assert.equal(result.reason, 'UNSUPPORTED_SKILL_LAYOUT', JSON.stringify(result));
    assert.equal(result.retryable, false); assert.match(result.diagnostic, /Do not guess/); noPublication(f);
  }
});
