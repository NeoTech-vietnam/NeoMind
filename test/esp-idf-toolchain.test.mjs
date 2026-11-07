import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { espIdfCommand, espIdfToolchain } from '../dist/esp-idf-toolchain.js';
import { commandLaunch } from '../dist/command-runner.js';

function fixture(t, platform = 'win32') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wf-idf-toolchain-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, 'Espressif'), sdk = join(tools, 'frameworks', 'esp-idf-v5.5.2');
  const python = join(tools, 'python_env', 'idf5.5_py3.11_env');
  const manifest = { tools: [
    { name: 'cmake', export_paths: [['bin']], versions: [{ name: '3.30.2', status: 'recommended' }] },
    { name: 'ninja', export_paths: [['']], versions: [{ name: '1.12.1', status: 'recommended' }] },
    { name: 'uninstalled-optional', export_paths: [['bin']], versions: [{ name: '1.0', status: 'recommended' }] },
  ] };
  const file = (path, body = '') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
  file(join(sdk, 'tools/idf.py'), '# Existing CLI fixture; never execute.\n');
  file(join(sdk, 'tools/cmake/version.cmake'), 'set(IDF_VERSION_MAJOR 5)\nset(IDF_VERSION_MINOR 5)\nset(IDF_VERSION_PATCH 2)\n');
  file(join(sdk, 'tools/tools.json'), JSON.stringify(manifest));
  file(join(python, 'pyvenv.cfg'), 'version = 3.11.2\n');
  file(join(python, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), 'existing interpreter fixture');
  mkdirSync(join(tools, 'tools/cmake/3.30.2/bin'), { recursive: true });
  mkdirSync(join(tools, 'tools/ninja/1.12.1'), { recursive: true });
  return { root, tools, sdk, python, manifest, file, env: { IDF_TOOLS_PATH: tools, IDF_PATH: join(root, 'wrong inherited SDK'), PATH: 'existing-PATH', API_KEY: 'MUST_NOT_COPY' } };
}

test('only idf.py command basenames select the installed ESP-IDF launcher', () => {
  assert.equal(espIdfCommand(['idf.py', '--version']), true);
  assert.equal(espIdfCommand(['C:\\existing SDK\\tools\\idf.py', 'build']), true);
  assert.equal(espIdfCommand('/existing/sdk/tools/IDF.PY'), true);
  for (const command of [[], ['python', 'idf.py'], ['other.py'], ['idf.py.exe'], ['idf.py --version']]) assert.equal(espIdfCommand(command), false);
});

test('ESP-IDF launch uses the verified venv and SDK script with literal arguments preserved', t => {
  const { env, sdk, python } = fixture(t, process.platform);
  const script = join(sdk, 'tools/idf.py');
  const args = ['-C', 'project with spaces', '-B', 'build', '-DIDF_TARGET=esp32s3', 'build', 'literal;$()&value'];
  const expected = { executable: join(python, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), args: [script, ...args] };
  assert.deepEqual(commandLaunch(['idf.py', ...args], env), expected);
  assert.deepEqual(commandLaunch([script, ...args], env), expected);
});

test('qualified relative and foreign absolute idf.py paths cannot silently select another script', t => {
  const { root, env, file } = fixture(t, process.platform);
  for (const path of ['scripts/idf.py', 'scripts\\idf.py', './idf.py', '.\\idf.py'])
    assert.throws(() => commandLaunch([path, 'build'], env), /bare idf\.py alias|exact installed SDK path/);
  const foreign = join(root, 'foreign SDK/tools/idf.py');
  file(foreign, '# A distinct script; never execute.\n');
  assert.throws(() => commandLaunch([foreign, '--version'], env), /different ESP-IDF installation/);
});

test('absolute ESP-IDF script identity respects the host filesystem case rules', t => {
  const { env, sdk, file } = fixture(t, process.platform);
  const script = join(sdk, 'tools/idf.py');
  if (process.platform === 'win32') {
    assert.deepEqual(commandLaunch([script.toUpperCase(), '--version'], env), commandLaunch([script, '--version'], env));
  } else {
    const distinct = join(sdk, 'tools/IDF.PY');
    file(distinct, '# A distinct case-sensitive script; never execute.\n');
    assert.throws(() => commandLaunch([distinct, '--version'], env), /different ESP-IDF installation/);
  }
});

for (const platform of ['win32', 'linux']) test(`existing unique ${platform} SDK and matching venv produce only a task-local environment patch`, t => {
  const fixtureValue = fixture(t, platform), { env, sdk, tools, python } = fixtureValue;
  const before = JSON.stringify(env), source = readFileSync(join(sdk, 'tools/tools.json'));
  const resolved = espIdfToolchain(env, platform);
  assert.ok(resolved);
  assert.equal(resolved.sdk, sdk); assert.equal(resolved.tools, tools); assert.equal(resolved.version, '5.5.2');
  assert.equal(resolved.python, join(python, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  assert.deepEqual(Object.keys(resolved.env).sort(), ['IDF_PATH', 'IDF_PYTHON_ENV_PATH', 'IDF_TOOLS_PATH', 'PATH'].sort());
  assert.match(resolved.env.PATH, /cmake/); assert.match(resolved.env.PATH, /ninja/);
  assert.ok(resolved.env.PATH.endsWith('existing-PATH'));
  assert.equal(JSON.stringify(env), before); assert.deepEqual(readFileSync(join(sdk, 'tools/tools.json')), source);
  assert.doesNotMatch(JSON.stringify(resolved), /MUST_NOT_COPY/);
});

test('a valid explicit SDK wins; multiple fallback SDKs or matching Python environments do not guess', t => {
  const { root, tools, sdk, python, file, env } = fixture(t);
  const second = join(tools, 'frameworks/other-sdk');
  file(join(second, 'tools/idf.py')); file(join(second, 'tools/cmake/version.cmake'), readFileSync(join(sdk, 'tools/cmake/version.cmake')));
  file(join(second, 'tools/tools.json'), readFileSync(join(sdk, 'tools/tools.json')));
  assert.equal(espIdfToolchain(env, 'win32'), undefined);
  assert.equal(espIdfToolchain({ ...env, IDF_PATH: sdk }, 'win32').sdk, sdk);
  const otherPython = join(tools, 'python_env/idf5.5_py3.12_env');
  file(join(otherPython, 'pyvenv.cfg')); file(join(otherPython, 'Scripts/python.exe'));
  assert.equal(espIdfToolchain({ ...env, IDF_PATH: sdk }, 'win32'), undefined);
  assert.equal(espIdfToolchain({ ...env, IDF_PATH: sdk, IDF_PYTHON_ENV_PATH: python }, 'win32').python, join(python, 'Scripts/python.exe'));
  assert.equal(espIdfToolchain({ ...env, IDF_PATH: sdk, IDF_PYTHON_ENV_PATH: join(root, 'missing') }, 'win32'), undefined);
});

test('missing or incomplete SDK/venv metadata returns no claimed toolchain', t => {
  const { sdk, python, env } = fixture(t);
  assert.equal(espIdfToolchain({}, 'win32'), undefined);
  rmSync(join(python, 'pyvenv.cfg'));
  assert.equal(espIdfToolchain(env, 'win32'), undefined);
  writeFileSync(join(python, 'pyvenv.cfg'), 'version = 3.11.2');
  writeFileSync(join(sdk, 'tools/tools.json'), '{bad JSON');
  assert.equal(espIdfToolchain(env, 'win32'), undefined);
});

test('tool manifest path traversal, duplicate recommendations and escaping exports are rejected', t => {
  const { root, sdk, tools, manifest, env } = fixture(t);
  const path = join(sdk, 'tools/tools.json');
  const changes = [
    { ...manifest.tools[0], name: '../outside' },
    { ...manifest.tools[0], versions: [{ name: '../../outside', status: 'recommended' }] },
    { ...manifest.tools[0], export_paths: [['..', 'outside']] },
    { ...manifest.tools[0], export_paths: [[root]] },
    { ...manifest.tools[0], versions: [...manifest.tools[0].versions, { name: 'other', status: 'recommended' }] },
  ];
  for (const tool of changes) {
    writeFileSync(path, JSON.stringify({ tools: [tool] }));
    assert.equal(espIdfToolchain(env, 'win32'), undefined);
  }
  writeFileSync(path, JSON.stringify(manifest));
  const outside = join(root, 'outside'); mkdirSync(outside);
  rmSync(join(tools, 'tools/cmake/3.30.2/bin'), { recursive: true });
  symlinkSync(outside, join(tools, 'tools/cmake/3.30.2/bin'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(espIdfToolchain(env, 'win32'), undefined);
});
