import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { initialize } from '../dist/storage.js';
import { defaultAutomationPolicy } from '../dist/manager.js';
import {
  adoptUpstreamUpdate, checkUpstream, cloneUpstream, discoverUpstreams,
  listUpstreams, readRoleUpstreamInstructions, readUpstreamInstructions, trackUpstream, watchUpstreams,
} from '../dist/upstreams.js';

const instruction = '.agents/skills/research/SKILL.md';
const repository = 'example/agent-skills';
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-upstreams-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'UPSTREAM-TEST' });
  policy(root, 'remote-enabled');
  return root;
}
function policy(root, network_policy) {
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ ...defaultAutomationPolicy(), network_policy }));
}
function fixture(t, text = '# Upstream research\n\nFind primary sources.\n') {
  const root = mkdtempSync(join(tmpdir(), 'neomind-upstream-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=NeoMind fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  git('init');
  mkdirSync(join(root, '.agents/skills/research'), { recursive: true });
  writeFileSync(join(root, instruction), text);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { postinstall: 'node untrusted-script.cjs' } }));
  writeFileSync(join(root, 'untrusted-script.cjs'), 'require("node:fs").writeFileSync("SCRIPT-RAN", "bad");\n');
  git('add', '.');
  git('commit', '-m', 'first');
  const first = git('rev-parse', 'HEAD').toString().trim();
  writeFileSync(join(root, instruction), text + '\nUpdated guidance.\n');
  git('add', '.');
  git('commit', '-m', 'second');
  const second = git('rev-parse', 'HEAD').toString().trim();
  const commands = [];
  const transport = (args, cwd) => {
    commands.push(args);
    // Only the trusted test transport substitutes the production HTTPS remote.
    // Production code always refuses file/ext protocols and never accepts this from JSON.
    const local = args.map((arg) => arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg === `https://github.com/${repository}.git` ? root : arg);
    return execFileSync('git', local, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  };
  return { root, first, second, git, transport, commands };
}
function github(source, options = {}) {
  const state = { latest: source.first, calls: [], ...options };
  const entry = (extra = {}) => ({ full_name: repository, html_url: `https://github.com/${repository}`, description: 'Reusable agent skills', stargazers_count: 1500, forks_count: 80, license: { spdx_id: 'MIT' }, default_branch: 'main', archived: false, ...extra });
  const request = async (url) => {
    state.calls.push(url);
    if (url.includes('/search/repositories?')) return { items: [entry(), entry({ full_name: 'example/small', stargazers_count: 2 }), entry({ full_name: 'example/archived', archived: true })] };
    if (url === `https://api.github.com/repos/${repository}`) return entry(state.metadata ?? {});
    const match = url.match(/\/commits\/(.+)$/);
    if (match) {
      const ref = decodeURIComponent(match[1]);
      return { sha: ref === 'main' ? state.latest : ref };
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  return { state, request };
}
async function tracked(root, source, remote) {
  return trackUpstream(root, { id: 'research', repository, instructions: [instruction], role: 'researcher' }, { request: remote.request });
}

test('discovery uses a configured threshold and records bounded metadata, without adopting candidates', async (t) => {
  const root = project(t);
  const remote = github({ first: 'a'.repeat(40) });
  const discovered = await discoverUpstreams(root, { query: 'agent skills', min_stars: 1200, limit: 5 }, remote);
  assert.equal(discovered.repositories.length, 1);
  assert.equal(discovered.repositories[0].license, 'MIT');
  assert.match(decodeURIComponent(remote.state.calls[0]), /stars:>=1200/);
  assert.equal(listUpstreams(root).sources.length, 0);
  await assert.rejects(trackUpstream(root, { id: 'low', repository, min_stars: 2000 }, remote), /below the configured minimum/);
  await assert.rejects(trackUpstream(root, { id: 'escape', repository: 'https://evil.invalid/agent' }, remote), /GitHub/);
  await assert.rejects(trackUpstream(root, { id: 'escape', repository, instructions: ['../SKILL.md'] }, remote), /without traversal/);
});

test('real Git cache imports only hashed guidance, checks updates and adopts an explicit candidate with rollback history', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const remote = github(source);
  const deps = { request: remote.request, git: source.transport };
  const initial = await tracked(root, source, remote);
  assert.equal(initial.commit, source.first);
  assert.throws(() => readUpstreamInstructions(root, 'research'), /Clone and verify/);
  const cloned = await cloneUpstream(root, 'research', deps);
  assert.equal(cloned.instructions.length, 1);
  assert.deepEqual(cloned.available_instructions, [instruction]);
  const imported = readUpstreamInstructions(root, 'research');
  assert.match(imported.prompt, /NeoMind remains the orchestrator/);
  assert.equal(imported.provenance.commit, source.first);
  assert.match(imported.instructions[0].text, /Find primary sources/);
  assert.equal(existsSync(join(root, cloned.cache_path, 'SCRIPT-RAN')), false);
  assert.equal(existsSync(join(source.root, 'SCRIPT-RAN')), false);
  assert.equal(source.commands.some((args) => args.includes('checkout') || args.includes('submodule')), false);
  remote.state.latest = source.second;
  const check = await checkUpstream(root, 'research', remote);
  assert.equal(check.update_available, true);
  assert.equal(listUpstreams(root).sources[0].commit, source.first);
  const updated = await adoptUpstreamUpdate(root, 'research', { expected_commit: source.first, commit: source.second }, deps);
  assert.equal(updated.commit, source.second);
  assert.deepEqual(updated.previous_commits, [source.first]);
  assert.match(readUpstreamInstructions(root, 'research').instructions[0].text, /Updated guidance/);
  assert.equal(existsSync(join(root, '.neomind/cache/upstreams/research', source.first, 'repository.git')), true);
  await assert.rejects(adoptUpstreamUpdate(root, 'research', { expected_commit: source.first, commit: source.second }, deps), /expected_commit/);
});

test('local-only blocks transport while previously verified instruction reads remain available', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const remote = github(source);
  const deps = { request: remote.request, git: source.transport };
  await tracked(root, source, remote);
  policy(root, 'local-only');
  await assert.rejects(cloneUpstream(root, 'research', deps), /Local-only/);
  assert.equal(source.commands.length, 0);
  policy(root, 'remote-enabled');
  await cloneUpstream(root, 'research', deps);
  policy(root, 'local-only');
  remote.state.calls.length = 0;
  const beforeGit = source.commands.length;
  await assert.rejects(discoverUpstreams(root, { query: 'agents' }, deps), /Local-only/);
  await assert.rejects(checkUpstream(root, 'research', deps), /Local-only/);
  await assert.rejects(trackUpstream(root, { id: 'another', repository }, deps), /Local-only/);
  await assert.rejects(adoptUpstreamUpdate(root, 'research', { expected_commit: source.first, commit: source.second }, deps), /Local-only/);
  assert.equal(remote.state.calls.length, 0);
  assert.equal(source.commands.length, beforeGit);
  assert.match(readUpstreamInstructions(root, 'research').instructions[0].text, /Find primary sources/);
  assert.match(readRoleUpstreamInstructions(root, 'researcher'), /supplemental task data/);
  assert.equal(readRoleUpstreamInstructions(root, 'developer'), '');
  policy(root, null);
  await assert.rejects(checkUpstream(root, 'research', deps), /Invalid network_policy/);
});

test('two concurrent adoptions compare the adopted pin again after network observation', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const remote = github(source);
  await tracked(root, source, remote);
  let release;
  let observed;
  const waiting = new Promise((resolve) => { observed = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const slow = adoptUpstreamUpdate(root, 'research', { expected_commit: source.first, commit: source.second }, {
    git: source.transport,
    request: async (url) => { observed(); await hold; return remote.request(url); },
  });
  await waiting;
  await adoptUpstreamUpdate(root, 'research', { expected_commit: source.first, commit: source.second }, { request: remote.request, git: source.transport });
  release();
  await assert.rejects(slow, /pin changed during adoption/);
  assert.equal(listUpstreams(root).sources[0].commit, source.second);
});

test('candidate missing regular instruction files cannot replace a working adopted pin', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const remote = github(source);
  const deps = { request: remote.request, git: source.transport };
  await tracked(root, source, remote);
  await cloneUpstream(root, 'research', deps);
  const registryBefore = readFileSync(join(root, '.neomind/upstreams.json'), 'utf8');
  await assert.rejects(adoptUpstreamUpdate(root, 'research', { expected_commit: source.first, commit: source.second, instructions: ['missing/SKILL.md'] }, deps), /missing or is not a regular file/);
  assert.equal(readFileSync(join(root, '.neomind/upstreams.json'), 'utf8'), registryBefore);
  assert.equal(readUpstreamInstructions(root, 'research').provenance.commit, source.first);
});

test('cached blob tampering fails hash verification and cannot refresh the adopted hash', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const remote = github(source);
  const deps = { request: remote.request, git: source.transport };
  await tracked(root, source, remote);
  const cached = await cloneUpstream(root, 'research', deps);
  const pin = cached.instructions[0];
  const replacement = Buffer.from('X'.repeat(pin.bytes));
  const loose = join(root, cached.cache_path, 'repository.git/objects', pin.git_blob_sha.slice(0, 2), pin.git_blob_sha.slice(2));
  mkdirSync(join(root, cached.cache_path, 'repository.git/objects', pin.git_blob_sha.slice(0, 2)), { recursive: true });
  if (existsSync(loose)) chmodSync(loose, 0o600);
  writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${replacement.length}\0`), replacement])));
  assert.throws(() => readUpstreamInstructions(root, 'research'), /integrity mismatch/);
  await assert.rejects(cloneUpstream(root, 'research', deps), /integrity mismatch/);
  assert.equal(listUpstreams(root).sources[0].instructions[0].sha256, pin.sha256);
});

test('active native invocations prevent instruction mutations but permit update observations', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const remote = github(source);
  const deps = { request: remote.request, git: source.transport };
  await tracked(root, source, remote);
  await cloneUpstream(root, 'research', deps);
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, '.neomind/native/receipts/active.json'), JSON.stringify({ state: 'running' }));
  await assert.rejects(trackUpstream(root, { id: 'another', repository }, deps), /Active native invocations/);
  await assert.rejects(cloneUpstream(root, 'research', deps), /Active native invocations/);
  await assert.rejects(adoptUpstreamUpdate(root, 'research', { expected_commit: source.first, commit: source.second }, deps), /Active native invocations/);
  remote.state.latest = source.second;
  assert.equal((await checkUpstream(root, 'research', remote)).update_available, true);
  assert.equal(listUpstreams(root).sources[0].commit, source.first);
});

test('role guidance is UTF-8 bounded with explicit provenance and excerpt reporting', async (t) => {
  const root = project(t);
  const source = fixture(t, '# Research\n' + 'Vietnamese guidance: tiếng Việt. '.repeat(2500));
  const remote = github(source);
  await tracked(root, source, remote);
  await cloneUpstream(root, 'research', { request: remote.request, git: source.transport });
  const prompt = readRoleUpstreamInstructions(root, 'researcher');
  assert.ok(Buffer.byteLength(prompt) <= 16 * 1024);
  assert.match(prompt, new RegExp(source.first));
  assert.match(prompt, /Excerpt/);
  assert.equal(prompt.includes('\ufffd'), false);
});

test('Git symlink entries are rejected as instruction files without changing adopted hashes', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const linkBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: source.root, input: 'outside/SKILL.md' }).toString().trim();
  source.git('update-index', '--add', '--cacheinfo', `120000,${linkBlob},${instruction}`);
  source.git('commit', '-m', 'symlink instruction');
  const symlinkCommit = source.git('rev-parse', 'HEAD').toString().trim();
  const remote = github(source, { latest: symlinkCommit });
  await tracked(root, source, remote);
  await assert.rejects(cloneUpstream(root, 'research', { request: remote.request, git: source.transport }), /not a regular file/);
  assert.deepEqual(listUpstreams(root).sources[0].instructions, []);
});

test('cache directory links are rejected before writing a staging clone', async (t) => {
  const root = project(t);
  const source = fixture(t);
  const remote = github(source);
  await tracked(root, source, remote);
  const parent = join(root, '.neomind/cache/upstreams');
  const unrelated = join(root, 'unrelated');
  mkdirSync(parent, { recursive: true });
  mkdirSync(unrelated);
  try { symlinkSync(unrelated, join(parent, 'research'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('OS cannot create test directory links'); throw error; }
  await assert.rejects(cloneUpstream(root, 'research', { request: remote.request, git: source.transport }), /symbolic links/);
  assert.equal(source.commands.length, 0);
});

test('persistent watcher checks first immediately, preserves adoption and aborts its long interval promptly', async (t) => {
  const root = project(t);
  const source = { first: 'a'.repeat(40) };
  const remote = github(source);
  await tracked(root, source, remote);
  remote.state.latest = 'b'.repeat(40);
  const controller = new AbortController();
  const watcher = watchUpstreams(root, { interval_ms: 60_000, signal: controller.signal }, remote);
  const first = await watcher.next();
  assert.equal(first.done, false);
  assert.equal(first.value.status, 'checked');
  assert.equal(first.value.update_available, true);
  assert.equal(first.value.commit, source.first);
  assert.equal(listUpstreams(root).sources[0].commit, source.first);
  const waiting = watcher.next();
  controller.abort();
  assert.equal((await waiting).done, true);
  await assert.rejects(watchUpstreams(root, { interval_ms: 5 }, remote).next(), /watch interval/);
  policy(root, 'local-only');
  remote.state.calls.length = 0;
  await assert.rejects(watchUpstreams(root, {}, remote).next(), /Local-only/);
  assert.equal(remote.state.calls.length, 0);
});

test('watch failures are bounded and sanitized, and cancellation interrupts a pending injected request', async (t) => {
  const root = project(t);
  const source = { first: 'a'.repeat(40) };
  const remote = github(source);
  await tracked(root, source, remote);
  const controller = new AbortController();
  const watcher = watchUpstreams(root, { signal: controller.signal }, {
    request: async () => { throw new Error('failed\n token=secret-value ' + 'x'.repeat(1000)); },
  });
  const event = (await watcher.next()).value;
  assert.equal(event.status, 'failed');
  assert.equal(event.error.includes('secret-value'), false);
  assert.equal(event.error.includes('\n'), false);
  assert.ok(event.error.length <= 400);
  controller.abort();
  assert.equal((await watcher.next()).done, true);
  const abort = new AbortController();
  const blocked = watchUpstreams(root, { signal: abort.signal }, { request: () => new Promise(() => {}) });
  const pending = blocked.next();
  abort.abort();
  assert.equal((await pending).done, true);
});
