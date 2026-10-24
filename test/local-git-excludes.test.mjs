import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, existsSync, symlinkSync, readlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const rules = [
  '/.neomind/',
  '/.github/agents/neomind-*.agent.md',
  '/.github/skills/neomind-*/',
  '/.github/hooks/neomind.json',
  '/.github/instructions/neomind.instructions.md',
  '/.github/agents/neomind-*.agent.md.neomind-update*',
  '/.github/hooks/neomind.json.neomind-update*',
  '/.github/instructions/neomind.instructions.md.neomind-update*',
  '/**/*.neomind-update*',
];
const generated = [
  '.neomind/config.json',
  '.github/agents/neomind-coordinator.agent.md',
  '.github/skills/neomind-manager/SKILL.md',
  '.github/hooks/neomind.json',
  '.github/instructions/neomind.instructions.md',
];
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'neomind-git-excludes-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  mkdirSync(root);
  return { base, root };
}
function git(root, args, expected = 0) {
  const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function initializeGit(root, args = []) {
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet', ...args, '.']);
}
function excludes(root) {
  const path = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  return isAbsolute(path) ? path : resolve(root, path);
}
function canonical(path) {
  const full = realpathSync.native(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
function write(path, bytes) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes); }
function createFileLink(t, target, path) {
  try { symlinkSync(target, path, 'file'); return true; }
  catch (error) {
    if ((process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) || ['ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`File symlinks are unavailable to this OS user (${error.code}).`);
      return false;
    }
    throw error;
  }
}
function run(root, args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('Windows short-path aliases install the same local exclusions as Git expanded paths', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t);
  initializeGit(root);
  const short = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$folder = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:NEOMIND_TEST_SHORT_PATH); [Console]::Write($folder.ShortPath)'],
  { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, NEOMIND_TEST_SHORT_PATH: root } });
  assert.equal(short.status, 0, short.error?.message ?? short.stderr);
  const alias = short.stdout.trim();
  if (resolve(alias).toLowerCase() === resolve(root).toLowerCase()) { t.skip('This Windows volume does not provide an 8.3 alias for the fixture.'); return; }
  assert.equal(realpathSync.native(alias).toLowerCase(), realpathSync.native(root).toLowerCase());
  const path = excludes(root), original = readFileSync(path);
  const result = run(alias, ['init', '--local', '--platforms', 'copilot']);
  assert.ok(!result.installation.warnings.some(warning => /Git exclusions could not be updated safely/.test(warning)), JSON.stringify(result.installation.warnings));
  assertIgnored(root);
  const after = readFileSync(path);
  assert.notDeepEqual(after, original);
  assert.deepEqual(after.subarray(after.length - original.length), original);
  run(root, ['update']); run(alias, ['update']);
  assert.deepEqual(readFileSync(path), after, 'Long and short names must update one exclusion file idempotently.');
});
function assertIgnored(root, project = root) {
  const prefix = project === root ? '' : relative(root, project).replaceAll('\\', '/') + '/';
  for (const path of generated) {
    assert.ok(existsSync(join(project, path)), path);
    git(root, ['check-ignore', '--no-index', '--quiet', '--', prefix + path]);
  }
  for (const path of [
    '.github/agents/neomind-coordinator.agent.md.neomind-update',
    '.github/agents/neomind-coordinator.agent.md.neomind-update.2',
    '.github/hooks/neomind.json.neomind-update',
    '.github/hooks/neomind.json.neomind-update.1',
    '.github/instructions/neomind.instructions.md.neomind-update',
    '.github/instructions/neomind.instructions.md.neomind-update.key',
    '.codex/config.toml.neomind-update-mcp',
    '.codex/config.toml.neomind-update-rea',
    '.codex/config.toml.neomind-update-codegraph',
    '.codex/hooks.json.neomind-update-hooks-SubagentStart.1',
    '.codex/agents/neomind-explorer.toml.neomind-update.2',
    '.agents/skills/neomind-manager/SKILL.md.neomind-update',
    'AGENTS.md.neomind-update-instructions',
  ]) git(root, ['check-ignore', '--no-index', '--quiet', '--', prefix + path]);
  for (const path of ['.github/agents/unrelated.agent.md', '.github/skills/unrelated/SKILL.md', 'src/value.mjs'])
    git(root, ['check-ignore', '--no-index', '--quiet', '--', prefix + path], 1);
}

test('local init preserves BOM, CRLF, no final newline, negations and both user gitignore files', t => {
  const { root } = fixture(t);
  initializeGit(root);
  const path = excludes(root);
  const original = Buffer.from('\ufeff# Personal exclusions\r\n*.private\r\n!keep.private\r\n!/.github/agents/neomind-personal.agent.md', 'utf8');
  write(path, original);
  const rootIgnore = Buffer.from('# Repository ignore rules\r\n*.object\r\n');
  const nestedIgnore = Buffer.from('# Existing managed-folder preferences\r\n!keep-me\r\n');
  write(join(root, '.gitignore'), rootIgnore);
  write(join(root, '.neomind/.gitignore'), nestedIgnore);
  run(root, ['init', '--local', '--platforms', 'copilot']);
  const first = readFileSync(path);
  assert.deepEqual(first.subarray(0, 3), original.subarray(0, 3));
  assert.deepEqual(first.subarray(first.length - original.length + 3), original.subarray(3));
  assertIgnored(root);
  git(root, ['check-ignore', '--no-index', '--quiet', '--', 'sample.private']);
  git(root, ['check-ignore', '--no-index', '--quiet', '--', 'keep.private'], 1);
  git(root, ['check-ignore', '--no-index', '--quiet', '--', '.github/agents/neomind-personal.agent.md'], 1);
  assert.deepEqual(readFileSync(join(root, '.gitignore')), rootIgnore);
  assert.deepEqual(readFileSync(join(root, '.neomind/.gitignore')), nestedIgnore);
  run(root, ['update']);
  run(root, ['update', '--local']);
  assert.deepEqual(readFileSync(path), first);
  assert.deepEqual(readFileSync(join(root, '.gitignore')), rootIgnore);
  assert.deepEqual(readFileSync(join(root, '.neomind/.gitignore')), nestedIgnore);
});

test('existing manual marker blocks remain byte-for-byte intact and exact positive rules are not duplicated', t => {
  const { root } = fixture(t);
  initializeGit(root);
  const path = excludes(root);
  const original = Buffer.from('# Existing personal rules\n# BEGIN NEOMIND local integration\n/.neomind/\n/.github/agents/neomind-*.agent.md\n# END NEOMIND local integration\n!/.github/agents/neomind-personal.agent.md\n');
  write(path, original);
  run(root, ['init', '--local', '--platforms', 'copilot']);
  const after = readFileSync(path);
  assert.deepEqual(after.subarray(after.length - original.length), original);
  const lines = after.toString('utf8').replace(/^\ufeff/, '').split(/\r?\n/);
  for (const rule of rules) assert.equal(lines.filter(line => line === rule).length, 1, rule);
  assertIgnored(root);
  git(root, ['check-ignore', '--no-index', '--quiet', '--', '.github/agents/neomind-personal.agent.md'], 1);
  run(root, ['update']);
  assert.deepEqual(readFileSync(path), after);
});

test('update --local opts into exclusions and persists them on ordinary subsequent updates', t => {
  const { root } = fixture(t);
  initializeGit(root);
  const path = excludes(root), original = readFileSync(path);
  run(root, ['init', '--platforms', 'copilot']);
  assert.deepEqual(readFileSync(path), original);
  run(root, ['update', '--local']);
  const local = readFileSync(path);
  assert.notDeepEqual(local, original);
  assertIgnored(root);
  run(root, ['update']);
  assert.deepEqual(readFileSync(path), local);
});

for (const action of ['init', 'update']) test(`${action} --local hides actual Copilot and Codex review candidates from Git status`, t => {
  const { root } = fixture(t);
  initializeGit(root);
  const excludePath = excludes(root), previous = Buffer.from('# Existing local rules\n*.personal\n!keep.personal\n');
  write(excludePath, previous);
  const ignoreBytes = Buffer.from('# User repository rules\r\n*.object\r\n');
  const authored = {
    '.gitignore': ignoreBytes,
    'AGENTS.md': '# Project instructions\n<!-- BEGIN NEOMIND instructions -->\nUser-owned instructions remain unchanged.\n<!-- END NEOMIND instructions -->\n',
    '.codex/config.toml': '[mcp_servers.neomind]\ncommand = "user-owned-command"\nargs = []\n',
    '.codex/hooks.json': JSON.stringify({ hooks: { SubagentStart: [{ hooks: [{ type: 'command', command: 'user-owned-hook' }] }] } }),
    '.github/agents/neomind-coordinator.agent.md': '# User-owned Copilot agent\nPreserve these existing authored instructions.\n',
  };
  for (const [path, value] of Object.entries(authored)) write(join(root, path), value);
  git(root, ['add', '--', ...Object.keys(authored)]);
  git(root, ['-c', 'user.name=NeoMind Tests', '-c', 'user.email=tests@neomind.invalid', 'commit', '--quiet', '-m', 'Preserve authored integration fixtures']);
  let report;
  if (action === 'init') report = run(root, ['init', '--local', '--platforms', 'copilot,codex']).installation;
  else {
    run(root, ['init', '--platforms', 'copilot,codex']);
    assert.match(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), /\.neomind-update/);
    report = run(root, ['update', '--local']);
  }
  for (const path of ['AGENTS.md#instructions', '.codex/config.toml#mcp', '.codex/hooks.json#hooks.SubagentStart', '.github/agents/neomind-coordinator.agent.md'])
    assert.ok(report.conflicts.some(conflict => conflict.path === path), `${path} must produce an actual review candidate.`);
  for (const conflict of report.conflicts) {
    assert.equal(existsSync(join(root, conflict.candidate)), true, conflict.candidate);
    git(root, ['check-ignore', '--no-index', '--quiet', '--', conflict.candidate]);
  }
  assert.doesNotMatch(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), /\.neomind-update/);
  for (const [path, value] of Object.entries(authored)) {
    if (path === '.codex/hooks.json') {
      const hooks = JSON.parse(readFileSync(join(root, path), 'utf8')).hooks;
      assert.deepEqual(hooks.SubagentStart, JSON.parse(value).hooks.SubagentStart, path);
      for (const event of ['SubagentStop', 'PostToolUse', 'Stop'])
        assert.ok(Array.isArray(hooks[event]) && hooks[event].length > 0, `Generated ${event} hook remains installed.`);
    } else assert.deepEqual(readFileSync(join(root, path)), Buffer.isBuffer(value) ? value : Buffer.from(value), path);
  }
  const after = readFileSync(excludePath);
  assert.deepEqual(after.subarray(after.length - previous.length), previous);
  write(join(root, '.codex/user-authored.txt'), 'Unrelated files remain visible.\n');
  assert.match(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), /\.codex\/user-authored\.txt/);
  const originalCandidate = report.conflicts.find(conflict => conflict.path === 'AGENTS.md#instructions');
  const reviewerBytes = Buffer.from('Preserve the user review edits to this pending candidate.\n');
  write(join(root, originalCandidate.candidate), reviewerBytes);
  const repeated = run(root, ['update', '--local']);
  const numbered = repeated.conflicts.find(conflict => conflict.path === originalCandidate.path);
  assert.notEqual(numbered.candidate, originalCandidate.candidate);
  assert.match(numbered.candidate, /\.neomind-update-instructions\.\d+$/);
  assert.deepEqual(readFileSync(join(root, originalCandidate.candidate)), reviewerBytes);
  assert.doesNotMatch(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), /\.neomind-update/);
  assert.deepEqual(readFileSync(excludePath), after);
  assert.deepEqual(readFileSync(join(root, '.gitignore')), ignoreBytes);
});

test('linked worktrees use Git-resolved shared info/exclude and preserve the .git pointer file', t => {
  const { base, root } = fixture(t);
  initializeGit(root);
  write(join(root, 'README.md'), '# Temporary test repository\n');
  git(root, ['add', 'README.md']);
  git(root, ['-c', 'user.name=NeoMind Tests', '-c', 'user.email=tests@neomind.invalid', 'commit', '--quiet', '-m', 'Create isolated fixture']);
  const worktree = join(base, 'linked-worktree');
  git(root, ['worktree', 'add', '--quiet', '--detach', worktree]);
  assert.ok(lstatSync(join(worktree, '.git')).isFile());
  const pointer = readFileSync(join(worktree, '.git'));
  const path = excludes(worktree);
  assert.equal(canonical(path), canonical(excludes(root)));
  const original = readFileSync(path);
  run(worktree, ['init', '--local', '--platforms', 'copilot']);
  const after = readFileSync(path);
  assert.notDeepEqual(after, original);
  assert.deepEqual(after.subarray(after.length - original.length), original);
  assert.deepEqual(readFileSync(join(worktree, '.git')), pointer);
  assert.ok(lstatSync(join(worktree, '.git')).isFile());
  assert.equal(existsSync(join(worktree, '.git/info/exclude')), false);
  assertIgnored(worktree);
});

test('separate Git directories resolve their own info/exclude without creating a project .git directory', t => {
  const { base, root } = fixture(t);
  const gitDirectory = join(base, 'separate.git');
  initializeGit(root, [`--separate-git-dir=${gitDirectory}`]);
  const pointer = readFileSync(join(root, '.git'));
  assert.ok(lstatSync(join(root, '.git')).isFile());
  const path = excludes(root);
  assert.equal(canonical(path), canonical(resolve(gitDirectory, 'info/exclude')));
  run(root, ['init', '--local', '--platforms', 'copilot']);
  assertIgnored(root);
  assert.deepEqual(readFileSync(join(root, '.git')), pointer);
  assert.ok(lstatSync(join(root, '.git')).isFile());
});

test('nested local projects scope exclusions literally through spaces and brackets in their Git path', t => {
  const { root } = fixture(t);
  initializeGit(root);
  const project = join(root, 'packages/local [draft] study');
  mkdirSync(project, { recursive: true });
  run(project, ['init', '--local', '--platforms', 'copilot']);
  assertIgnored(root, project);
  for (const path of generated) git(root, ['check-ignore', '--no-index', '--quiet', '--', path], 1);
  for (const path of ['AGENTS.md.neomind-update-instructions', '.codex/hooks.json.neomind-update-hooks-SubagentStart.1'])
    git(root, ['check-ignore', '--no-index', '--quiet', '--', path], 1);
  git(root, ['check-ignore', '--no-index', '--quiet', '--', 'packages/local d study/.neomind/config.json'], 1);
});

test('non-Git local installs succeed with an explicit warning and never fabricate .git metadata', t => {
  const { root } = fixture(t);
  const result = run(root, ['init', '--local', '--platforms', 'copilot']);
  assert.ok(result.installation.warnings.some(warning => /(?:not.*git|git.*(?:not|skip|unavailable)|no.*repository)/i.test(warning)), JSON.stringify(result.installation.warnings));
  assert.equal(existsSync(join(root, '.git')), false);
  assert.ok(existsSync(join(root, '.neomind/config.json')));
});

test('a dangling user-owned Git exclude link is preserved and local installation reports its exclusion warning', t => {
  const { base, root } = fixture(t);
  initializeGit(root);
  const path = excludes(root), missingTarget = join(base, 'absent-personal-exclusions');
  unlinkSync(path);
  if (!createFileLink(t, missingTarget, path)) return;
  const destination = readlinkSync(path);
  assert.equal(existsSync(path), false);
  assert.ok(lstatSync(path).isSymbolicLink());
  const result = run(root, ['init', '--local', '--platforms', 'copilot']);
  assert.ok(lstatSync(path).isSymbolicLink(), 'A dangling Git exclude link must never be replaced with a generated file.');
  assert.equal(readlinkSync(path), destination);
  assert.equal(existsSync(missingTarget), false);
  assert.ok(result.installation.warnings.some(warning => /exclu.*(?:not|safe|preserv|skip)/i.test(warning)), JSON.stringify(result.installation.warnings));
});

test('local initialization retains a preexisting dangling inner gitignore link and its missing target', t => {
  const { base, root } = fixture(t);
  initializeGit(root);
  const path = join(root, '.neomind/.gitignore'), missingTarget = join(base, 'absent-inner-ignore');
  mkdirSync(join(root, '.neomind'));
  if (!createFileLink(t, missingTarget, path)) return;
  const destination = readlinkSync(path);
  assert.equal(existsSync(path), false);
  const result = run(root, ['init', '--local', '--platforms', 'copilot']);
  assert.ok(result.config.copilot_integration === 'local');
  assert.ok(lstatSync(path).isSymbolicLink(), 'Initializing a local project must preserve a dangling user gitignore link.');
  assert.equal(readlinkSync(path), destination);
  assert.equal(existsSync(missingTarget), false);
});
