// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { hash } from '../dist/storage.js';
import { trackUpstream, cloneUpstream, readUpstreamSkillBundle } from '../dist/upstreams.js';

async function fixture(t, body = '\ufeff---\r\nname: original\r\n---\r\nRead [guide](references/guide.md).\r\n', reference = '# Original guide\r\n') {
  const base = mkdtempSync(join(tmpdir(), 'neomind-skill-bundle-'));
  t.after(() => { assert.equal(dirname(resolve(base)), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const source = join(base, 'source'), root = join(base, 'project');
  mkdirSync(join(source, '.agents/skills/original/references'), { recursive: true });
  writeFileSync(join(source, '.agents/skills/original/SKILL.md'), body);
  writeFileSync(join(source, '.agents/skills/original/references/guide.md'), reference);
  writeFileSync(join(source, 'LICENSE'), 'MIT original fixture notice\r\n');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'UNTRUSTED-RAN\',\'bad\')"' } }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=NeoMind fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: source, windowsHide: true, stdio: 'pipe' });
  git('init'); git('add', '.'); git('commit', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD').toString().trim();
  initialize(root, { project_id: 'SKILL-BUNDLE' });
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ network_policy: 'remote-enabled' }));
  const repository = 'fixture/original-skills';
  const request = async url => url.includes('/commits/') ? { sha: commit } : {
    full_name: repository, stargazers_count: 1500, forks_count: 1, license: { spdx_id: 'MIT' }, default_branch: 'main', archived: false,
  };
  const transport = (args, cwd) => execFileSync('git', args.map(arg => arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg === `https://github.com/${repository}.git` ? source : arg), { cwd, windowsHide: true, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  await trackUpstream(root, { id: 'original', repository, instructions: ['.agents/skills/original/SKILL.md'] }, { request });
  await cloneUpstream(root, 'original', { request, git: transport });
  return { root, source, commit };
}

test('Git-pinned skill bundle preserves original BOM/reference/license bytes and provenance without adopting or executing source', async t => {
  const { root, source, commit } = await fixture(t);
  const registry = readFileSync(join(root, '.neomind/upstreams.json'));
  const bundle = readUpstreamSkillBundle(root, 'original');
  assert.equal(bundle.name, 'original');
  assert.equal(bundle.provenance.commit, commit);
  for (const path of ['SKILL.md', 'references/guide.md']) {
    const file = bundle.files.find(file => file.path === path);
    assert.deepEqual(Buffer.from(file.content), readFileSync(join(source, '.agents/skills/original', path)));
    assert.equal(hash(file.content), file.sha256);
  }
  assert.deepEqual(Buffer.from(bundle.files.find(file => file.path === 'LICENSE').content), readFileSync(join(source, 'LICENSE')));
  assert.equal(JSON.parse(bundle.files.find(file => file.path === 'ORIGIN.json').content).commit, commit);
  assert.deepEqual(readFileSync(join(root, '.neomind/upstreams.json')), registry);
  assert.equal(existsSync(join(source, 'UNTRUSTED-RAN')), false);
});

test('missing, escaping and oversized Markdown references fail without changing the adopted pin', async t => {
  for (const [body, reference, pattern] of [
    ['Read [missing](references/missing.md).\n', '# Guide', /missing/],
    ['Read [outside](../../outside.md).\n', '# Guide', /escapes/],
    ['Read [large](references/guide.md).\n', 'x'.repeat(128 * 1024 + 1), /size limits/],
  ]) {
    const { root } = await fixture(t, body, reference);
    const before = readFileSync(join(root, '.neomind/upstreams.json'));
    assert.throws(() => readUpstreamSkillBundle(root, 'original'), pattern);
    assert.deepEqual(readFileSync(join(root, '.neomind/upstreams.json')), before);
  }
});
