import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHubAgentMarketplaceReader } from '../dist/agent-marketplace-github.js';
import { discoverAgentMarketplace } from '../dist/agent-marketplace.js';

const repo = 'https://github.com/github/awesome-copilot';
const commit = '797337f33f73e35d08d82f840e21c4b8c4932d88';
const treeSha = 'a'.repeat(40);
const target = '.github/plugin/marketplace.json';
const raw = Buffer.from(JSON.stringify({ name: 'fixture-market', plugins: [{ name: 'example', source: 'plugins/example' }] }));
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const reason = expected => error => error.reason === expected && !JSON.stringify({ message: error.message, stack: error.stack }).includes('PRIVATE');
const input = (extra = {}) => ({ repository: repo, commit, path: target, max_bytes: 1024 * 1024, signal: new AbortController().signal, ...extra });

function fixture({ filePath = target, bytes = raw, mutateTree = value => value, mutateFile = value => value,
  response = (value, url) => jsonResponse(value, url) } = {}) {
  const calls = [], sha = blob(bytes);
  const tree = () => ({ sha: treeSha, url: `https://api.github.com/repos/github/awesome-copilot/git/trees/${treeSha}`, truncated: false,
    tree: [...filePath.split('/').slice(0, -1).map((_part, index, parts) => ({ path: parts.slice(0, index + 1).join('/'), type: 'tree', mode: '040000', sha: treeSha })),
      { path: filePath, type: 'blob', mode: '100644', sha, size: bytes.length }] });
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/git/trees/')) return response(mutateTree(tree()), url, 'tree');
    return response(mutateFile({ name: filePath.split('/').at(-1), path: filePath, type: 'file', sha, size: bytes.length,
      url, git_url: `https://api.github.com/repos/github/awesome-copilot/git/blobs/${sha}`,
      encoding: 'base64', content: bytes.toString('base64').replace(/(.{64})/g, '$1\n') + '\n' }), url, 'contents');
  };
  const reader = createGitHubAgentMarketplaceReader({ fetch, allowed_repositories: [repo] });
  return { fetch, reader, calls, sha };
}
function jsonResponse(value, url, { status = 200, headers = {}, redirected = false, body } = {}) {
  const response = new Response(body ?? JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

test('realistic GitHub contents and pinned Git modes produce bounded ordinary bytes with no credentials', async () => {
  const work = fixture();
  const result = await work.reader(input({ apiKey: 'PRIVATE', authorization: 'PRIVATE' }));
  assert.deepEqual(Buffer.from(result.content), raw);
  assert.deepEqual({ ...result, content: undefined }, { repository: repo, commit, path: target, kind: 'file', complete: true, content: undefined });
  assert.equal(work.calls.length, 2);
  assert.equal(work.calls[0].url, `https://api.github.com/repos/github/awesome-copilot/git/trees/${commit}?recursive=1`);
  assert.equal(work.calls[1].url, `https://api.github.com/repos/github/awesome-copilot/contents/${target}?ref=${commit}`);
  for (const call of work.calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.headers.Authorization, undefined);
    assert.doesNotMatch(JSON.stringify(call), /PRIVATE/);
  }
  const discovered = await discoverAgentMarketplace({ repository: repo, commit }, work.reader);
  assert.equal(discovered.candidates[0].name, 'example');
  assert.equal(discovered.installation, 'not-performed'); assert.equal(discovered.authorization, 'not-granted');
  assert.equal(work.calls.filter(call => call.url.includes('/git/trees/')).length, 1, 'Successful immutable tree metadata is reused');
});

test('explicit repository approval, immutable pins and canonical paths are required before any fetch', async () => {
  assert.throws(() => createGitHubAgentMarketplaceReader({ allowed_repositories: [repo] }), error => error.code === 'TRANSPORT_REQUIRED');
  const work = fixture();
  for (const repository of ['https://github.com/PRIVATE@github.com/repo', 'https://github.com/owner/../repo',
    'https://github.com.evil.invalid/owner/repo', 'http://github.com/owner/repo', 'file:///PRIVATE', `${repo}?PRIVATE=key`])
    await assert.rejects(work.reader(input({ repository })), reason('invalid-source'));
  for (const path of ['../PRIVATE', '/PRIVATE', 'C:\\PRIVATE', 'plugins/%2e%2e/PRIVATE', 'plugins//file', 'plugins/./file'])
    await assert.rejects(work.reader(input({ path })), reason('unsafe-path'));
  await assert.rejects(work.reader(input({ commit: 'main' })), reason('invalid-source'));
  await assert.rejects(work.reader(input({ max_bytes: 2 * 1024 * 1024 })), reason('invalid-limit'));
  await assert.rejects(work.reader(input({ repository: 'https://github.com/other/package' })), reason('repository-not-allowed'));
  assert.equal(work.calls.length, 0);
  const allowed = [repo], read = createGitHubAgentMarketplaceReader({ fetch: work.fetch, allowed_repositories: allowed });
  allowed.push('https://github.com/other/package');
  await assert.rejects(read(input({ repository: allowed[1] })), reason('repository-not-allowed'));
  assert.equal(work.calls.length, 0, 'Mutating caller settings does not expand the reader policy');
});

test('source path segments are URL encoded while the pinned commit and raw file identity remain exact', async () => {
  const filePath = 'plugins/giới thiệu/plugin notes.json', work = fixture({ filePath });
  const result = await work.reader(input({ path: filePath }));
  assert.equal(result.path, filePath);
  assert.equal(work.calls[1].url, `https://api.github.com/repos/github/awesome-copilot/contents/plugins/gi%E1%BB%9Bi%20thi%E1%BB%87u/plugin%20notes.json?ref=${commit}`);
});

test('an external package repository is read only when independently present in the explicit allow-list', async () => {
  const external = 'https://github.com/example/document-tools';
  const work = fixture({ response(value, url, kind) {
    if (kind === 'tree') {
      const root = new URL(url); root.search = ''; root.pathname = root.pathname.replace(/[^/]+$/, treeSha);
      return jsonResponse({ ...value, url: root.href }, url);
    }
    return jsonResponse(value, url);
  } });
  const read = createGitHubAgentMarketplaceReader({ fetch: work.fetch, allowed_repositories: [repo, external] });
  const result = await read(input({ repository: external, commit: 'b'.repeat(40) }));
  assert.equal(result.repository, external); assert.equal(result.commit, 'b'.repeat(40));
  assert.ok(work.calls.every(call => call.url.startsWith('https://api.github.com/repos/example/document-tools/')));
});

test('symlinks, submodules, missing tree ancestors and truncated tree inventories cannot masquerade as ordinary files', async () => {
  for (const mode of ['120000', '160000']) {
    const work = fixture({ mutateTree(value) { value.tree.at(-1).mode = mode; value.tree.at(-1).type = mode === '160000' ? 'commit' : 'blob'; return value; } });
    await assert.rejects(work.reader(input()), reason('nonordinary-git-entry'));
    assert.equal(work.calls.length, 1, 'The potentially dereferencing Contents endpoint is never reached');
  }
  const linkedParent = fixture({ mutateTree(value) { value.tree[0].mode = '120000'; value.tree[0].type = 'blob'; return value; } });
  await assert.rejects(linkedParent.reader(input()), reason('nonordinary-git-entry'));
  const missing = fixture({ mutateTree(value) { value.tree.shift(); return value; } });
  await assert.rejects(missing.reader(input()), reason('nonordinary-git-entry'));
  for (const mutateTree of [value => ({ ...value, truncated: true }), value => ({ ...value, tree: Array(20_001).fill(value.tree[0]) }),
    value => ({ ...value, tree: [...value.tree, value.tree[0]] })])
    await assert.rejects(fixture({ mutateTree }).reader(input()), reason('incomplete-tree'));
});

test('wrong response identities and redirect responses are rejected without following untrusted URLs', async () => {
  const changedFetchUrl = fixture({ response(value, url) { return jsonResponse(value, url.replace('github/awesome-copilot', 'PRIVATE/wrong-repository')); } });
  await assert.rejects(changedFetchUrl.reader(input()), reason('identity-mismatch'));
  const redirect = fixture({ response(value, url) { return jsonResponse(value, url, { status: 302, headers: { Location: 'https://PRIVATE.invalid/token' } }); } });
  await assert.rejects(redirect.reader(input()), reason('redirect'));
  const followed = fixture({ response(value, url) { return jsonResponse(value, url, { redirected: true }); } });
  await assert.rejects(followed.reader(input()), reason('redirect'));
  for (const mutateFile of [value => ({ ...value, path: 'different/path' }), value => ({ ...value, url: value.url.replace(commit, 'b'.repeat(40)) }),
    value => ({ ...value, sha: '0'.repeat(40) })])
    await assert.rejects(fixture({ mutateFile }).reader(input()), reason('identity-mismatch'));
});

test('strict base64, content size and Git blob hash verification reject partial or corrupt file data', async () => {
  for (const content of ['PRIVATE@@@', '!!!!', 'Zh==', 'Zg=', 'Zg== trailing'])
    await assert.rejects(fixture({ mutateFile: value => ({ ...value, content }) }).reader(input()), reason('invalid-base64'));
  await assert.rejects(fixture({ mutateFile: value => ({ ...value, content: 'eA==' }) }).reader(input()), reason('incomplete-response'));
  await assert.rejects(fixture({ mutateFile: value => ({ ...value, content: Buffer.alloc(raw.length, 120).toString('base64') }) }).reader(input()), reason('blob-hash-mismatch'));
  await assert.rejects(fixture({ mutateFile: value => ({ ...value, truncated: true }) }).reader(input()), reason('incomplete-response'));
  await assert.rejects(fixture({ mutateFile: value => ({ ...value, type: 'symlink', target: 'README.md' }) }).reader(input()), reason('nonordinary-git-entry'));
  const empty = fixture({ bytes: Buffer.alloc(0) });
  assert.equal((await empty.reader(input())).content.byteLength, 0, 'An actual empty Git blob is still verifiable');
});

test('streaming JSON limits, partial streams and content length mismatches do not yield complete source files', async () => {
  let cancelled = false;
  const large = fixture({ bytes: Buffer.from('x'), response(value, url, kind) {
    if (kind === 'tree') return jsonResponse(value, url);
    return jsonResponse(value, url, { body: new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.alloc(40 * 1024, 32));
    }, cancel() { cancelled = true; } }) });
  } });
  await assert.rejects(large.reader(input({ max_bytes: 100 })), reason('response-too-large'));
  assert.equal(cancelled, true);
  const partial = fixture({ response(value, url, kind) {
    return kind === 'tree' ? jsonResponse(value, url) : jsonResponse(value, url, { headers: { 'content-length': String(JSON.stringify(value).length + 10) } });
  } });
  await assert.rejects(partial.reader(input()), reason('incomplete-response'));
  const ranged = fixture({ response(value, url) { return jsonResponse(value, url, { status: 206 }); } });
  await assert.rejects(ranged.reader(input()), reason('incomplete-response'));
  const broken = fixture({ response(value, url, kind) {
    return kind === 'tree' ? jsonResponse(value, url) : jsonResponse(value, url, { body: new ReadableStream({ start(controller) { controller.error(Error('PRIVATE network details')); } }) });
  } });
  await assert.rejects(broken.reader(input()), reason('incomplete-response'));
  const compressed = fixture({ response(value, url) { return jsonResponse(value, url, { headers: { 'content-encoding': 'gzip', 'content-length': '10' } }); } });
  assert.deepEqual(Buffer.from((await compressed.reader(input())).content), raw, 'Fetch delivers decompressed bytes; compressed Content-Length is not compared to them');
});

test('HTTP/provider errors, missing authorization and transport failures expose only bounded safe categories', async () => {
  for (const [status, expected, headers] of [[429, 'rate-limit', {}], [403, 'rate-limit', { 'x-ratelimit-remaining': '0' }],
    [401, 'authorization', {}], [403, 'authorization', {}], [404, 'not-found', {}], [503, 'http-error', {}]]) {
    const work = fixture({ response(_value, url) { return jsonResponse({ message: 'PRIVATE credentials/body must not escape' }, url, { status, headers }); } });
    await assert.rejects(work.reader(input()), reason(expected));
  }
  const read = createGitHubAgentMarketplaceReader({ fetch: async () => { throw Error('PRIVATE authorization token'); }, allowed_repositories: [repo] });
  await assert.rejects(read(input()), reason('transport-failed'));
  const malformed = fixture({ response(_value, url) { return jsonResponse(null, url, { body: 'PRIVATE not JSON' }); } });
  await assert.rejects(malformed.reader(input()), reason('invalid-response'));
});

test('explicit cancellation and bounded timeout abort pending reads without a default transport or retry loop', async () => {
  const already = new AbortController(); already.abort(); let count = 0;
  const preflight = createGitHubAgentMarketplaceReader({ fetch: async () => { count++; }, allowed_repositories: [repo] });
  await assert.rejects(preflight(input({ signal: already.signal })), reason('cancelled')); assert.equal(count, 0);
  let started, signal;
  const called = new Promise(resolve => { started = resolve; });
  const reader = createGitHubAgentMarketplaceReader({ fetch: async (_url, options) => { signal = options.signal; started(); return new Promise(() => {}); },
    allowed_repositories: [repo], timeout_ms: 1000 });
  const cancel = new AbortController(), pending = reader(input({ signal: cancel.signal }));
  await called; cancel.abort();
  await assert.rejects(pending, reason('cancelled')); assert.equal(signal.aborted, true);
  const timeout = createGitHubAgentMarketplaceReader({ fetch: async () => new Promise(() => {}), allowed_repositories: [repo], timeout_ms: 20 });
  await assert.rejects(timeout(input()), reason('timeout'));
});

function aliasesFixture({ links = { 'plugins/docs/skills/render/SKILL.md': '../../../../skills/docs/SKILL.md' },
  mutateTree = value => value, mutateBlob = value => value, response = (value, url) => jsonResponse(value, url) } = {}) {
  const finalPath = 'skills/docs/SKILL.md', contents = Buffer.from('# Fixture skill\n\nExplain the supplied content.\n');
  const entries = new Map(), targets = new Map(), calls = [];
  function parents(selectedPath) {
    const parts = selectedPath.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (!entries.has(prefix)) entries.set(prefix, { path: prefix, mode: '040000', type: 'tree', sha: treeSha });
    }
  }
  parents(finalPath); entries.set(finalPath, { path: finalPath, mode: '100644', type: 'blob', sha: blob(contents), size: contents.length });
  for (const [selectedPath, target] of Object.entries(links)) {
    parents(selectedPath);
    const bytes = Buffer.isBuffer(target) ? target : Buffer.from(target), sha = blob(bytes);
    targets.set(sha, bytes); entries.set(selectedPath, { path: selectedPath, mode: '120000', type: 'blob', sha, size: bytes.length });
  }
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/git/trees/')) return response(mutateTree({ sha: treeSha,
      url: `https://api.github.com/repos/github/awesome-copilot/git/trees/${treeSha}`, truncated: false, tree: [...entries.values()] }), url, 'tree');
    if (url.includes('/git/blobs/')) {
      const sha = url.split('/').at(-1), bytes = targets.get(sha);
      assert.ok(bytes, 'Only an exact pinned symlink blob is requested');
      return response(mutateBlob({ sha, size: bytes.length, url, encoding: 'base64', content: bytes.toString('base64') }), url, 'blob');
    }
    assert.equal(decodeURIComponent(new URL(url).pathname.split('/contents/')[1]), finalPath, 'Only the explicit resolved ordinary path is read');
    return response({ type: 'file', path: finalPath, size: contents.length, sha: blob(contents), url,
      encoding: 'base64', content: contents.toString('base64') }, url, 'contents');
  };
  const reader = createGitHubAgentMarketplaceReader({ fetch, allowed_repositories: [repo] });
  return { reader, fetch, calls, links, finalPath, contents };
}

test('an explicit resolver traces a legitimate pinned alias and requires a separate strict ordinary read', async () => {
  const work = aliasesFixture(), requested = Object.keys(work.links)[0];
  await assert.rejects(work.reader(input({ path: requested })), reason('nonordinary-git-entry'));
  assert.equal(work.calls.length, 1, 'Default reader still rejects symlinks before dereferencing Contents');
  const resolved = await work.reader.resolvePath(input({ path: requested }));
  assert.equal(resolved.requested_path, requested); assert.equal(resolved.resolved_path, work.finalPath);
  assert.equal(resolved.repository, repo); assert.equal(resolved.commit, commit);
  assert.equal(resolved.kind, 'ordinary-git-path'); assert.equal(resolved.complete, true);
  assert.equal(resolved.component_contents, 'not-read'); assert.equal(resolved.installation, 'not-performed');
  assert.deepEqual(resolved.links, [{ link_path: requested, target: work.links[requested], resolved_prefix: work.finalPath,
    blob_sha: blob(Buffer.from(work.links[requested])) }]);
  assert.equal(resolved.ordinary_blob_sha, blob(work.contents));
  assert.equal(work.calls.filter(call => call.url.includes('/contents/')).length, 0, 'Resolution is not a disguised content load');
  const actual = await work.reader(input({ path: resolved.resolved_path }));
  assert.deepEqual(Buffer.from(actual.content), work.contents); assert.equal(actual.path, work.finalPath);
  assert.ok(Object.isFrozen(work.reader));
});

test('directory aliases and bounded multi-hop aliases preserve their exact link-chain provenance', async () => {
  const directory = aliasesFixture({ links: { 'plugins/docs': '../skills/docs' } });
  const result = await directory.reader.resolvePath(input({ path: 'plugins/docs/SKILL.md' }));
  assert.equal(result.resolved_path, directory.finalPath);
  assert.equal(result.links[0].resolved_prefix, 'skills/docs');
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_item, index) =>
    [`aliases/l${index}`, index === 7 ? '../skills/docs/SKILL.md' : `./l${index + 1}`]));
  const many = aliasesFixture({ links: eight });
  const traced = await many.reader.resolvePath(input({ path: 'aliases/l0' }));
  assert.equal(traced.links.length, 8); assert.equal(traced.resolved_path, many.finalPath);
  assert.ok(many.calls.every(call => call.url.startsWith('https://api.github.com/repos/github/awesome-copilot/')));
  const ordinary = await many.reader.resolvePath(input({ path: many.finalPath }));
  assert.deepEqual(ordinary.links, []); assert.equal(ordinary.resolved_path, ordinary.requested_path);
});

test('alias targets cannot escape the pinned repository, select external resources or hide malformed bytes', async () => {
  for (const target of ['../../skills/docs/SKILL.md', '/skills/docs/SKILL.md', 'https://PRIVATE.invalid/file',
    '//PRIVATE.invalid/file', 'git@PRIVATE.invalid:repo', 'C:\\PRIVATE', '../skills/docs/SKILL.md\n',
    '../skills/docs/SKILL.md\0', '../skills/docs/SKILL.md ', '%2e%2e/PRIVATE', '', Buffer.from([0xff])]) {
    const work = aliasesFixture({ links: { 'aliases/skill': target } });
    await assert.rejects(work.reader.resolvePath(input({ path: 'aliases/skill' })), reason('unsafe-alias-target'));
    assert.equal(work.calls.filter(call => call.url.includes('/contents/')).length, 0);
  }
});

test('alias loops, more than eight links and submodule destinations remain incomplete rather than ordinary', async () => {
  const cycle = aliasesFixture({ links: { 'aliases/a': './b', 'aliases/b': './a' } });
  await assert.rejects(cycle.reader.resolvePath(input({ path: 'aliases/a' })), reason('alias-loop'));
  assert.equal(cycle.calls.filter(call => call.url.includes('/git/blobs/')).length, 2);
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_item, index) =>
    [`aliases/l${index}`, index === 8 ? '../skills/docs/SKILL.md' : `./l${index + 1}`]));
  const long = aliasesFixture({ links: nine });
  await assert.rejects(long.reader.resolvePath(input({ path: 'aliases/l0' })), reason('alias-limit'));
  assert.equal(long.calls.filter(call => call.url.includes('/git/blobs/')).length, 8);
  const submodule = aliasesFixture({ links: { 'aliases/a': '../skills/docs/SKILL.md' }, mutateTree(value) {
    const leaf = value.tree.find(item => item.path === 'skills/docs/SKILL.md'); leaf.mode = '160000'; leaf.type = 'commit'; return value;
  } });
  await assert.rejects(submodule.reader.resolvePath(input({ path: 'aliases/a' })), reason('nonordinary-git-entry'));
});

test('symlink target blobs require exact identity, Git hash, ordinary response size and strict base64', async () => {
  for (const [mutateBlob, expected] of [
    [value => ({ ...value, sha: '0'.repeat(40) }), 'identity-mismatch'],
    [value => ({ ...value, url: value.url.replace('github/awesome-copilot', 'PRIVATE/wrong') }), 'identity-mismatch'],
    [value => ({ ...value, content: Buffer.alloc(value.size, 120).toString('base64') }), 'blob-hash-mismatch'],
    [value => ({ ...value, size: value.size + 1 }), 'incomplete-response'],
    [value => ({ ...value, content: 'PRIVATE@@' }), 'invalid-base64'],
  ]) {
    const work = aliasesFixture({ mutateBlob });
    await assert.rejects(work.reader.resolvePath(input({ path: Object.keys(work.links)[0] })), reason(expected));
  }
  const large = aliasesFixture({ links: { 'aliases/a': 'x'.repeat(4097) } });
  await assert.rejects(large.reader.resolvePath(input({ path: 'aliases/a' })), reason('response-too-large'));
  assert.equal(large.calls.filter(call => call.url.includes('/git/blobs/')).length, 0);
});

test('resolution cancellation and deadline cover target-blob reads without further network calls', async () => {
  const work = aliasesFixture(); let started;
  const began = new Promise(resolve => { started = resolve; });
  const read = createGitHubAgentMarketplaceReader({ allowed_repositories: [repo], fetch: async (url, options) => {
    if (url.includes('/git/blobs/')) { started(); return new Promise(() => {}); }
    return work.fetch(url, options);
  } });
  const controller = new AbortController(), pending = read.resolvePath(input({ path: Object.keys(work.links)[0], signal: controller.signal }));
  await began; controller.abort();
  await assert.rejects(pending, reason('cancelled'));
  const timeout = createGitHubAgentMarketplaceReader({ allowed_repositories: [repo], timeout_ms: 20, fetch: async (url, options) =>
    url.includes('/git/blobs/') ? new Promise(() => {}) : work.fetch(url, options) });
  await assert.rejects(timeout.resolvePath(input({ path: Object.keys(work.links)[0] })), reason('timeout'));
});

test('a late tree response after timeout cannot issue a new Contents request', async () => {
  const work = fixture(); let release, count = 0;
  const held = new Promise(resolve => { release = resolve; });
  const read = createGitHubAgentMarketplaceReader({ allowed_repositories: [repo], timeout_ms: 20, fetch: async (url, options) => {
    count++; const response = await work.fetch(url, options); await held; return response;
  } });
  await assert.rejects(read(input()), reason('timeout'));
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1);
});

test('subtree inventory lists all ordinary assets from one pinned complete tree without reading their bodies', async () => {
  const root = 'plugins/guide', work = fixture({ filePath: `${root}/SKILL.md`, mutateTree: tree => ({ ...tree,
    tree: [...tree.tree, { path: `${root}/references`, mode: '040000', type: 'tree', sha: treeSha },
      { path: `${root}/references/example.md`, mode: '100644', type: 'blob', sha: blob(Buffer.from('reference')), size: 9 },
      { path: 'unrelated.md', mode: '100644', type: 'blob', sha: blob(Buffer.from('other')), size: 5 }] }) });
  const listed = await work.reader.listFiles(input({ path: root, max_bytes: 8 * 1024 * 1024 }));
  assert.equal(listed.complete, true); assert.equal(listed.path, root);
  assert.deepEqual(new Set(listed.files.map(file => file.path)), new Set([`${root}/SKILL.md`, `${root}/references/example.md`]));
  assert.ok(listed.files.every(file => /^[a-f0-9]{40}$/.test(file.blob_sha) && Number.isSafeInteger(file.size)));
  assert.equal(listed.component_contents, 'not-read'); assert.equal(listed.installation, 'not-performed');
  await work.reader.listFiles(input({ path: root }));
  assert.equal(work.calls.length, 1, 'The existing complete tree cache is shared by inventory calls');
  await work.reader(input({ path: `${root}/SKILL.md` }));
  assert.equal(work.calls.length, 2, 'Reading an ordinary blob needs only its Contents request after inventory');
});

test('subtree inventory refuses links, submodules, unsafe names, missing sizes and incomplete or oversized trees', async () => {
  const root = 'plugins/guide';
  for (const [entry, error] of [
    [{ path: `${root}/link`, type: 'blob', mode: '120000', sha: treeSha, size: 3 }, 'nonordinary-git-entry'],
    [{ path: `${root}/module`, type: 'commit', mode: '160000', sha: treeSha }, 'nonordinary-git-entry'],
    [{ path: `${root}/%2e%2e/file`, type: 'blob', mode: '100644', sha: treeSha, size: 1 }, 'unsafe-path'],
    [{ path: `${root}/unknown.md`, type: 'blob', mode: '100644', sha: treeSha }, 'incomplete-tree'],
  ]) {
    const work = fixture({ filePath: `${root}/SKILL.md`, mutateTree: value => ({ ...value, tree: [...value.tree, entry] }) });
    await assert.rejects(work.reader.listFiles(input({ path: root })), reason(error));
    assert.equal(work.calls.length, 1);
  }
  const work = fixture({ filePath: `${root}/SKILL.md` });
  await assert.rejects(work.reader.listFiles(input({ path: root, max_bytes: raw.length - 1 })), reason('response-too-large'));
  await assert.rejects(work.reader.listFiles(input({ path: `${root}/SKILL.md` })), reason('nonordinary-git-entry'));
  const partial = fixture({ filePath: `${root}/SKILL.md`, mutateTree: value => ({ ...value, truncated: true }) });
  await assert.rejects(partial.reader.listFiles(input({ path: root })), reason('incomplete-tree'));
});

test('subtree inventory enforces approval, cancellation and file-count bounds without Contents fallback', async () => {
  const work = fixture({ filePath: 'plugins/guide/SKILL.md' }), controller = new AbortController(); controller.abort();
  await assert.rejects(work.reader.listFiles(input({ path: 'plugins/guide', signal: controller.signal })), reason('cancelled'));
  await assert.rejects(work.reader.listFiles(input({ path: '../guide' })), reason('unsafe-path'));
  await assert.rejects(work.reader.listFiles(input({ path: 'plugins/guide', repository: 'https://github.com/other/repo' })), reason('repository-not-allowed'));
  assert.equal(work.calls.length, 0);
  const many = fixture({ filePath: 'plugins/guide/SKILL.md', mutateTree: tree => ({ ...tree, tree: [...tree.tree,
    ...Array.from({ length: 256 }, (_, index) => ({ path: `plugins/guide/file-${index}`, type: 'blob', mode: '100644', sha: treeSha, size: 1 }))] }) });
  await assert.rejects(many.reader.listFiles(input({ path: 'plugins/guide' })), reason('response-too-large'));
  assert.equal(many.calls.length, 1);
});
