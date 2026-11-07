import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverRuntime, vscodeUserDirectories } from '../scripts/agent-plugin/runtime-discovery.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf runtime discovery '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const user = join(root, 'Code User'); mkdirSync(user);
  const options = { env: {}, userDirectories: [user] };
  return { root, user, options };
}
function runtime(root, name = 'installed runtime with spaces') {
  const path = join(root, name); mkdirSync(join(path, 'dist'), { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'workforce', version: '0.2.0-alpha.2' }));
  writeFileSync(join(path, 'dist', 'cli.js'), '// fixture: never executed\n');
  return path;
}
function settings(user, value, extra = {}) {
  mkdirSync(user, { recursive: true });
  writeFileSync(join(user, 'settings.json'), JSON.stringify({ ...extra, 'workforce.bridge.runtimePath': value }));
}

test('known user directory construction supports Windows, Linux, macOS and explicit portable/profile roots', () => {
  assert.deepEqual(vscodeUserDirectories({ platform: 'win32', env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, home: 'C:\\Users\\tester' }),
    ['C:\\Users\\tester\\AppData\\Roaming\\Code\\User', 'C:\\Users\\tester\\AppData\\Roaming\\Code - Insiders\\User']);
  assert.deepEqual(vscodeUserDirectories({ platform: 'linux', env: { XDG_CONFIG_HOME: '/tmp/xdg' }, home: '/home/tester' }),
    ['/tmp/xdg/Code/User', '/tmp/xdg/Code - Insiders/User']);
  assert.deepEqual(vscodeUserDirectories({ platform: 'linux', env: {}, home: '/home/tester' }),
    ['/home/tester/.config/Code/User', '/home/tester/.config/Code - Insiders/User']);
  assert.deepEqual(vscodeUserDirectories({ platform: 'darwin', env: {}, home: '/Users/tester' }),
    ['/Users/tester/Library/Application Support/Code/User', '/Users/tester/Library/Application Support/Code - Insiders/User']);
  assert.deepEqual(vscodeUserDirectories({ platform: 'linux', env: { VSCODE_PORTABLE: '/portable/data' }, home: '/home/tester' }), ['/portable/data/user-data/User']);
  assert.deepEqual(vscodeUserDirectories({ platform: 'linux', env: { WORKFORCE_VSCODE_USER_DIR: '/chosen/profile', VSCODE_PORTABLE: '/ignored' }, home: '/home/tester' }), ['/chosen/profile']);
});

test('JSONC settings resolve an absolute runtime without copying or modifying settings and secrets', t => {
  const { root, user, options } = fixture(t), installed = runtime(root);
  const path = join(user, 'settings.json');
  const content = '\uFEFF{\n// User comment\n"example.url":"https://host/path//quoted",\n"apiKey":"KEEP_SECRET_PRIVATE",\n"workforce.bridge.runtimePath":' + JSON.stringify(installed) + ',\n}\n';
  writeFileSync(path, content);
  assert.deepEqual(discoverRuntime(options), { state: 'ready', runtime: realpathSync.native(installed) });
  assert.equal(readFileSync(path, 'utf8'), content);
  assert.doesNotMatch(JSON.stringify(discoverRuntime(options)), /KEEP_SECRET_PRIVATE|example\.url/);
});

test('explicit runtime override takes precedence and invalid override never falls back', t => {
  const { root, user, options } = fixture(t), configured = runtime(root), explicit = runtime(root, 'explicit runtime');
  settings(user, configured);
  assert.deepEqual(discoverRuntime({ ...options, env: { WORKFORCE_RUNTIME_PATH: explicit } }), { state: 'ready', runtime: realpathSync.native(explicit) });
  for (const value of ['', 'relative/runtime', join(root, 'missing'), 'SECRET_OVERRIDE']) {
    const result = discoverRuntime({ ...options, env: { WORKFORCE_RUNTIME_PATH: value } });
    assert.equal(result.state, 'invalid'); assert.equal(result.code, 'RUNTIME_OVERRIDE_INVALID');
    assert.doesNotMatch(JSON.stringify(result), /SECRET_OVERRIDE/);
  }
});

test('explicit VS Code User directory isolates its settings instead of searching normal locations', t => {
  const { root } = fixture(t), user = join(root, 'custom profile'), installed = runtime(root);
  settings(user, installed);
  assert.deepEqual(discoverRuntime({ env: { WORKFORCE_VSCODE_USER_DIR: user }, home: join(root, 'unused home') }),
    { state: 'ready', runtime: realpathSync.native(installed) });
  assert.equal(discoverRuntime({ env: { WORKFORCE_VSCODE_USER_DIR: 'relative/profile' }, home: root }).code, 'RUNTIME_USER_DIRECTORY_INVALID');
});

test('profiles deduplicate canonical runtime aliases and omit built-in nested profile directories', t => {
  const { root, user, options } = fixture(t), installed = runtime(root), other = runtime(root, 'other runtime');
  const alias = join(root, 'runtime alias');
  symlinkSync(installed, alias, process.platform === 'win32' ? 'junction' : 'dir');
  settings(user, installed);
  settings(join(user, 'profiles', '-profile'), alias);
  settings(join(user, 'profiles', 'builtin', 'agents'), other);
  assert.deepEqual(discoverRuntime(options), { state: 'ready', runtime: realpathSync.native(installed) });
  if (process.platform === 'win32') {
    settings(join(user, 'profiles', 'uppercase'), installed.toUpperCase());
    assert.deepEqual(discoverRuntime(options), { state: 'ready', runtime: realpathSync.native(installed) });
  }
});

test('different valid per-profile selections are reported as ambiguous', t => {
  const { root, user, options } = fixture(t), first = runtime(root, 'one'), second = runtime(root, 'two');
  settings(user, first); settings(join(user, 'profiles', 'second'), second);
  const result = discoverRuntime(options);
  assert.equal(result.state, 'ambiguous'); assert.equal(result.code, 'RUNTIME_AMBIGUOUS');
  assert.deepEqual(result.candidates, [realpathSync.native(first), realpathSync.native(second)].sort());
});

test('workspace-only runtime pointers and ambient working directory do not select executable code', t => {
  const { root, options } = fixture(t), project = join(root, 'project'), installed = runtime(root);
  settings(join(project, '.vscode'), installed);
  const previous = process.cwd();
  try { process.chdir(project); assert.equal(discoverRuntime(options).state, 'missing'); }
  finally { process.chdir(previous); }
});

test('malformed, oversized and wrongly typed settings return bounded diagnostics without raw secret contents', t => {
  const { root, user, options } = fixture(t);
  const file = join(user, 'settings.json');
  for (const content of ['{"apiKey":"SECRET_UNFINISHED",', '{"apiKey":"' + 'S'.repeat(1024 * 1024) + '"}',
    JSON.stringify({ 'workforce.bridge.runtimePath': true, apiKey: 'SECRET_BOOLEAN' }),
    JSON.stringify({ 'workforce.bridge.runtimePath': join(root, 'SECRET_MISSING_RUNTIME') })]) {
    writeFileSync(file, content);
    const result = discoverRuntime(options);
    assert.equal(result.state, 'invalid');
    assert.doesNotMatch(JSON.stringify(result), /SECRET_|SSSSSSSS/);
    assert.ok(JSON.stringify(result).length < 512);
  }
});

test('invalid inactive profile settings do not override a unique valid User selection', t => {
  const { root, user, options } = fixture(t), installed = runtime(root);
  settings(user, installed); settings(join(user, 'profiles', 'old'), false);
  assert.deepEqual(discoverRuntime(options), { state: 'ready', runtime: realpathSync.native(installed) });
});

test('profile junctions escaping the User directory are skipped', t => {
  const { root, user, options } = fixture(t), outside = join(root, 'outside profile'), installed = runtime(root);
  settings(outside, installed); mkdirSync(join(user, 'profiles'));
  symlinkSync(outside, join(user, 'profiles', 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(discoverRuntime(options).state, 'missing');
});

test('runtime selection validates package identity and CLI containment without executing it', t => {
  const { root, options } = fixture(t), installed = runtime(root);
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'not-workforce', apiKey: 'SECRET_MANIFEST' }));
  const result = discoverRuntime({ ...options, env: { WORKFORCE_RUNTIME_PATH: installed } });
  assert.equal(result.state, 'invalid'); assert.doesNotMatch(JSON.stringify(result), /SECRET_MANIFEST/);
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'workforce' }));
  rmSync(join(installed, 'dist', 'cli.js'));
  assert.equal(discoverRuntime({ ...options, env: { WORKFORCE_RUNTIME_PATH: installed } }).state, 'invalid');
  const outside = join(root, 'outside-cli.js');
  writeFileSync(outside, '// never execute external CLI\n');
  try {
    symlinkSync(outside, join(installed, 'dist', 'cli.js'), 'file');
  } catch (error) {
    // Windows directory junctions are available without symlink privilege, so
    // exercise the same containment condition through the dist directory there.
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    rmdirSync(join(installed, 'dist'));
    const externalDist = join(root, 'outside-dist'); mkdirSync(externalDist);
    writeFileSync(join(externalDist, 'cli.js'), '// never execute external CLI\n');
    symlinkSync(externalDist, join(installed, 'dist'), 'junction');
  }
  assert.equal(discoverRuntime({ ...options, env: { WORKFORCE_RUNTIME_PATH: installed } }).state, 'invalid');
});

test('bounded profile discovery refuses to guess when profiles exceed the limit', t => {
  const { root, user, options } = fixture(t), installed = runtime(root);
  settings(user, installed);
  for (let i = 0; i < 65; i++) mkdirSync(join(user, 'profiles', `profile-${i}`), { recursive: true });
  const result = discoverRuntime(options);
  assert.equal(result.state, 'invalid'); assert.equal(result.code, 'RUNTIME_PROFILE_LIMIT');
});
