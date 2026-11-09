import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { discoverAgentMarketplace, inspectAgentMarketplacePlugin } from '../dist/agent-marketplace.js';
import * as marketplace from '../dist/agent-marketplace.js';

const source = { repository: 'https://github.com/github/awesome-copilot', commit: '797337f33f73e35d08d82f840e21c4b8c4932d88' };
const externalSha = 'fbada88709c854e3ea74fb1b34dd237dea13d413';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const catalog = plugins => JSON.stringify({ name: 'awesome-copilot', plugins });
function transport(content, change = file => file) {
  const calls = [];
  const read = async input => { calls.push(input); return change({ repository: input.repository, commit: input.commit,
    path: input.path, kind: 'file', complete: true, content }); };
  return { calls, read };
}
const code = expected => error => error.code === expected && !error.message.includes('PRIVATE');

test('actual marketplace forms retain relative provenance and separate external GitHub package pins', async () => {
  const body = catalog([
    { name: 'testing-automation', description: 'Unit and integration tests', source: 'plugins/testing-automation' },
    { name: 'build-perf-cpp', source: './plugins/build-perf-cpp' },
    { name: 'dotnet-test', source: { source: 'github', repo: 'dotnet/skills', path: 'plugins/dotnet-test', sha: externalSha } },
    { name: 'cpp-language-server', source: { source: 'github', repo: 'microsoft/cpp-language-server', path: 'plugins/cpp-language-server' } },
    { name: 'other-host', source: { source: 'git', url: 'https://git.example.invalid/group/tools.git', path: 'packages/docs', sha: externalSha } },
  ]);
  const adapter = transport(body), result = await discoverAgentMarketplace({ ...source, apiKey: 'PRIVATE', authorization: 'PRIVATE' }, adapter.read);
  assert.equal(result.status, 'complete'); assert.equal(result.candidates.length, 5);
  assert.deepEqual(adapter.calls.map(call => [call.repository, call.commit, call.path, call.max_bytes]),
    [[source.repository, source.commit, '.github/plugin/marketplace.json', 1024 * 1024]]);
  assert.equal(result.provenance.sha256, digest(body));
  assert.deepEqual(Object.keys(adapter.calls[0]).sort(), ['commit', 'max_bytes', 'path', 'repository', 'signal']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.deepEqual(result.candidates[0].package, { ...source, path: 'plugins/testing-automation' });
  assert.equal(result.candidates[1].package.commit, source.commit);
  assert.equal(result.candidates[2].package.repository, 'https://github.com/dotnet/skills');
  assert.equal(result.candidates[2].package.commit, externalSha);
  assert.equal(result.candidates[3].state, 'package-pin-required');
  assert.equal(result.candidates[3].package.commit, undefined, 'A catalog SHA never pins another repository');
  assert.equal(result.candidates[4].package.repository, 'https://git.example.invalid/group/tools');
  assert.equal(result.candidates[4].package.commit, externalSha);
  assert.equal(result.authorization, 'not-granted'); assert.equal(result.installation, 'not-performed');
  assert.ok(Object.isFrozen(result.candidates[0].package));
  assert.throws(() => { result.candidates[0].package.commit = externalSha; }, TypeError);
});

test('pins, HTTPS locators and source paths are validated before any read, without a default network', async () => {
  const adapter = transport(catalog([]));
  for (const changed of [{ commit: 'main' }, { commit: '123abcd' }, { repository: 'https://PRIVATE@example.invalid/repo' },
    { repository: 'https://github.com/owner/../escape' }, { repository: 'file:///PRIVATE' },
    { repository: 'https://github.com/owner/repo?PRIVATE=key' }]) {
    await assert.rejects(discoverAgentMarketplace({ ...source, ...changed }, adapter.read), code('INVALID_SOURCE'));
  }
  for (const path of ['../catalog.json', '/catalog.json', 'C:\\PRIVATE.json', '.github/%2e%2e/catalog.json', '././catalog.json', '.github//catalog.json'])
    await assert.rejects(discoverAgentMarketplace({ ...source, catalog_path: path }, adapter.read), code('UNSAFE_PATH'));
  assert.equal(adapter.calls.length, 0);
  await assert.rejects(discoverAgentMarketplace(source), code('TRANSPORT_REQUIRED'));
});

test('mismatched, partial, linked, malformed and oversized source reads never become complete catalogs', async () => {
  for (const changed of [{ repository: 'https://github.com/other/repo' }, { commit: externalSha }, { path: 'another.json' }]) {
    const adapter = transport(catalog([]), file => ({ ...file, ...changed }));
    await assert.rejects(discoverAgentMarketplace(source, adapter.read), code('SOURCE_PIN_MISMATCH'));
  }
  for (const changed of [{ complete: false }, { kind: 'symlink' }, { kind: 'directory' }])
    await assert.rejects(discoverAgentMarketplace(source, transport(catalog([]), file => ({ ...file, ...changed })).read), code('READ_INCOMPLETE'));
  for (const body of ['PRIVATE malformed JSON', '[]', '{"name":"market","plugins":{}}', '{"plugins":[]}',
    Buffer.from(catalog([])).toString('base64')])
    await assert.rejects(discoverAgentMarketplace(source, transport(body).read), code('MALFORMED_CATALOG'));
  await assert.rejects(discoverAgentMarketplace(source, transport(' '.repeat(1024 * 1024 + 1)).read), code('BOUND_EXCEEDED'));
  await assert.rejects(discoverAgentMarketplace(source, transport(catalog(Array(1001).fill({ name: 'x', source: '.' }))).read), code('BOUND_EXCEEDED'));
});

test('unsupported sources and ambiguous names are explicit incomplete discovery rather than silent no-match', async () => {
  const result = await discoverAgentMarketplace(source, transport(catalog([
    { name: 'safe', source: './plugins/safe' }, { name: 'traversal', source: '../outside' },
    { name: 'encoded', source: 'plugins/%2e%2e/outside' }, { name: 'npm-package', source: { source: 'npm', package: 'some-package' } },
    { name: 'collision', source: 'plugins/first' }, { name: 'COLLISION', source: 'plugins/second' },
    { name: 'malformed-pin', source: { source: 'github', repo: 'owner/repo', sha: 'main' } },
  ])).read);
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.candidates.map(item => item.name), ['safe']);
  assert.deepEqual(result.issues.map(item => item.code), ['UNSAFE_PATH', 'UNSAFE_PATH', 'UNSUPPORTED_SOURCE', 'DUPLICATE_PLUGIN', 'INVALID_SOURCE']);
});

test('external packages require a separate immutable pin and conflicting pins are refused before inspection', async () => {
  const [candidate] = (await discoverAgentMarketplace(source, transport(catalog([
    { name: 'external', source: { source: 'github', repo: 'owner/external', ref: 'stable', path: 'plugins/external' } },
  ])).read)).candidates;
  const adapter = transport(JSON.stringify({ name: 'external', version: '1.0.0', skills: ['./skills/use/'] }));
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, adapter.read), code('UNPINNED_SOURCE'));
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, adapter.read, { package_pin: { ...source, commit: externalSha } }), code('SOURCE_PIN_MISMATCH'));
  assert.equal(adapter.calls.length, 0);
  const inspected = await inspectAgentMarketplacePlugin(candidate, adapter.read,
    { package_pin: { repository: candidate.package.repository, commit: externalSha } });
  assert.equal(inspected.source.commit, externalSha); assert.equal(inspected.catalog_provenance.commit, source.commit);
  assert.equal(inspected.package_pin_origin, 'supplied');
  assert.equal(adapter.calls[0].path, 'plugins/external/plugin.json');
  const [pinned] = (await discoverAgentMarketplace(source, transport(catalog([
    { name: 'fixed', source: { source: 'github', repo: 'owner/external', sha: externalSha } },
  ])).read)).candidates;
  await assert.rejects(inspectAgentMarketplacePlugin(pinned, adapter.read,
    { package_pin: { repository: pinned.package.repository, commit: source.commit } }), code('SOURCE_PIN_MISMATCH'));
});

test('actual portable extension namespace declarations are inspected without claiming license or Local execution', async () => {
  const [candidate] = (await discoverAgentMarketplace(source, transport(catalog([
    { name: 'project-documenter', source: 'plugins/project-documenter' },
  ])).read)).candidates;
  const manifest = JSON.stringify({ name: 'project-documenter', version: '1.0.0', license: 'MIT',
    description: 'Project documents', extensions: { 'com.github.awesome-copilot': {
      agents: ['./agents/project-documenter.md'], skills: ['./skills/drawio/', './skills/md-to-docx/'],
      hooks: { SessionStart: [{ command: 'PRIVATE SOURCE COMMAND MUST NOT EXECUTE' }] },
    } } });
  const result = await inspectAgentMarketplacePlugin(candidate, transport(manifest).read);
  assert.equal(result.state, 'manifest-inspected'); assert.equal(result.manifest.sha256, digest(manifest));
  assert.equal(result.manifest.path, 'plugins/project-documenter/plugin.json');
  assert.equal(result.declared_license, 'MIT'); assert.equal(result.license_verification, 'not-performed');
  assert.deepEqual(result.components[1].paths, ['plugins/project-documenter/skills/drawio', 'plugins/project-documenter/skills/md-to-docx']);
  assert.equal(result.components[2].inline, true); assert.deepEqual(result.components[2].paths, []);
  assert.equal(result.compatibility, 'unverified'); assert.equal(result.component_contents, 'not-read');
  assert.equal(result.authorization, 'not-granted'); assert.equal(result.installation, 'not-performed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE SOURCE COMMAND/);
});

test('manifest identities, unsafe declarations and invalid bytes are rejected; legacy manifest location is explicit', async () => {
  const [candidate] = (await discoverAgentMarketplace(source, transport(catalog([{ name: 'reader', source: '.' }])).read)).candidates;
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, transport('{"name":"different"}').read), code('MALFORMED_MANIFEST'));
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, transport('{"name":"reader","skills":["../PRIVATE"]}').read), code('UNSAFE_PATH'));
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, transport(new Uint8Array([0xff, 0xfe])).read), code('MALFORMED_MANIFEST'));
  const adapter = transport('{"name":"reader","commands":["./commands/explain.md"]}');
  const result = await inspectAgentMarketplacePlugin(candidate, adapter.read, { manifest_path: '.claude-plugin/plugin.json' });
  assert.equal(result.manifest.path, '.claude-plugin/plugin.json');
  assert.deepEqual(result.components[0].paths, ['commands/explain.md']);
  const excessive = { name: 'reader', extensions: {
    'com.example.first': { skills: Array(150).fill('./skills/first') },
    'com.example.second': { skills: Array(150).fill('./skills/second') },
  } };
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, transport(JSON.stringify(excessive)).read), code('BOUND_EXCEEDED'));
});

test('source failures and bounded cancellation retain honest failure categories without private transport messages', async () => {
  await assert.rejects(discoverAgentMarketplace(source, async () => { throw Error('PRIVATE token URL backend details'); }), code('READ_FAILED'));
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(discoverAgentMarketplace(source, async () => { calls++; }, { signal: controller.signal }), code('READ_CANCELLED'));
  assert.equal(calls, 0);
  let readSignal;
  await assert.rejects(discoverAgentMarketplace(source, async input => { readSignal = input.signal; return new Promise(() => {}); },
    { timeout_ms: 20 }), code('READ_TIMEOUT'));
  assert.equal(readSignal.aborted, true);
});

// Exact ordinary bytes retained in java-development-manifest-pinned-20261109.json,
// github/awesome-copilot@02466d1eb70b841c90717b0fc2dc9457aa6f606f.
const publishedJavaManifest = Buffer.from('ewogICIkc2NoZW1hIjogImh0dHBzOi8vYWdlbnQtcGx1Z2lucy5vcmcvc2NoZW1hcy8xLjAuMC9wbHVnaW4uc2NoZW1hLmpzb24iLAogICJuYW1lIjogImphdmEtZGV2ZWxvcG1lbnQiLAogICJkZXNjcmlwdGlvbiI6ICJDb21wcmVoZW5zaXZlIGNvbGxlY3Rpb24gb2YgcHJvbXB0cyBhbmQgaW5zdHJ1Y3Rpb25zIGZvciBKYXZhIGRldmVsb3BtZW50IGluY2x1ZGluZyBTcHJpbmcgQm9vdCwgUXVhcmt1cywgdGVzdGluZywgZG9jdW1lbnRhdGlvbiwgYW5kIGJlc3QgcHJhY3RpY2VzLiIsCiAgInZlcnNpb24iOiAiMS4wLjAiLAogICJhdXRob3IiOiB7CiAgICAibmFtZSI6ICJBd2Vzb21lIENvcGlsb3QgQ29tbXVuaXR5IgogIH0sCiAgInJlcG9zaXRvcnkiOiAiaHR0cHM6Ly9naXRodWIuY29tL2dpdGh1Yi9hd2Vzb21lLWNvcGlsb3QiLAogICJsaWNlbnNlIjogIk1JVCIsCiAgImtleXdvcmRzIjogWwogICAgImphdmEiLAogICAgInNwcmluZ2Jvb3QiLAogICAgInF1YXJrdXMiLAogICAgImpwYSIsCiAgICAianVuaXQiLAogICAgImphdmFkb2MiCiAgXQp9Cg==', 'base64');

test('actual portable 1.0.0 manifest supplies fixed discovery locations without inventing declared components or reading files', async () => {
  assert.equal(publishedJavaManifest.length, 544);
  assert.equal(digest(publishedJavaManifest), '476b728618cdaacd639a8d3d764261ee7f6325d6895621c122b5c7ebc549e4d6');
  const pinned = { ...source, commit: '02466d1eb70b841c90717b0fc2dc9457aa6f606f' };
  const [candidate] = (await discoverAgentMarketplace(pinned, transport(catalog([
    { name: 'java-development', source: 'plugins/java-development' },
  ])).read)).candidates;
  const adapter = transport(publishedJavaManifest);
  const inspected = await inspectAgentMarketplacePlugin(candidate, adapter.read);
  assert.deepEqual(inspected.components, [], 'No explicit declarations exist in these real manifest bytes');
  assert.equal(adapter.calls.length, 1, 'Layout discovery does not read components or introduce network calls');
  assert.deepEqual(marketplace.inspectPortableAgentPluginLayout(JSON.parse(publishedJavaManifest), candidate.package.path), {
    format: 'agent-plugins/1.0.0', skills_directory: 'plugins/java-development/skills',
    skill_discovery: 'immediate-child/SKILL.md', mcp_configuration: 'plugins/java-development/mcp.json',
    existence: 'not-inspected', ignored_top_level_fields: [],
  });
});

test('portable fixed layouts require the recognized schema and valid metadata without changing legacy declaration semantics', () => {
  const manifest = JSON.parse(publishedJavaManifest);
  for (const schema of [undefined, 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json', 'https://PRIVATE.invalid/schema'])
    assert.equal(marketplace.inspectPortableAgentPluginLayout({ ...manifest, $schema: schema }, 'plugins/java-development'), undefined);
  for (const change of [{ name: 'UPPER' }, { name: 'bad--name' }, { author: { token: 'PRIVATE' } },
    { keywords: ['java', 42] }, { repository: 42 }, { license: false }, { description: [] }])
    assert.throws(() => marketplace.inspectPortableAgentPluginLayout({ ...manifest, ...change }, 'plugins/java-development'), code('MALFORMED_MANIFEST'));
  for (const root of ['../PRIVATE', '/absolute', 'C:\\PRIVATE', 'plugins/%2e%2e/PRIVATE'])
    assert.throws(() => marketplace.inspectPortableAgentPluginLayout(manifest, root), code('UNSAFE_PATH'));
  const ignored = marketplace.inspectPortableAgentPluginLayout({ ...manifest, skills: [], unexpected: { arbitrary: true } }, '');
  assert.equal(ignored.skills_directory, 'skills');
  assert.deepEqual(ignored.ignored_top_level_fields, ['skills', 'unexpected']);
  assert.equal(ignored.existence, 'not-inspected');
  assert.equal(marketplace.inspectPortableAgentPluginLayout({ ...manifest, author: { name: '' }, version: 'informal',
    repository: 'not a URL', license: 'custom license', extensions: false }, '').skills_directory, 'skills',
  'Portable metadata syntax and a non-object extensions value do not invent a fatal schema error');
});

test('canonical portable unknown declarations do not override fixed locations while explicit unsupported schemas never enter legacy handling', async () => {
  const manifest = JSON.parse(publishedJavaManifest), [candidate] = (await discoverAgentMarketplace(source, transport(catalog([
    { name: manifest.name, source: 'plugins/java-development' },
  ])).read)).candidates;
  const declared = { ...manifest, skills: ['../PRIVATE'], extensions: { 'com.unknown.client': { skills: ['../PRIVATE'], hooks: {} } } };
  const inspected = await inspectAgentMarketplacePlugin(candidate, transport(JSON.stringify(declared)).read);
  assert.deepEqual(inspected.components, [], 'Unknown canonical keys and namespaces do not gain legacy execution semantics');
  assert.deepEqual(inspected.extensions, [{ namespace: 'com.unknown.client', fields: ['skills', 'hooks'] }]);
  assert.deepEqual(marketplace.inspectPortableAgentPluginLayout(declared, candidate.package.path).ignored_top_level_fields, ['skills']);
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, transport(JSON.stringify({ ...manifest,
    $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json' })).read), code('UNSUPPORTED_SOURCE'));
  const alternate = transport(publishedJavaManifest);
  await assert.rejects(inspectAgentMarketplacePlugin(candidate, alternate.read, { manifest_path: '.claude-plugin/plugin.json' }), code('UNSUPPORTED_SOURCE'));
  assert.equal(alternate.calls.length, 1);
});
