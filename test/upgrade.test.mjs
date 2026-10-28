import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';
import { initialize, retryWindowsFileOperation } from '../dist/storage.js';
import { UpgradeError, upgradeProject } from '../dist/upgrade.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const oldVersion = '0.1.0';
const newVersion = '2.3.4';
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeJson(path, value) {
  write(path, JSON.stringify(value, null, 2) + '\n');
}

// npm test itself and developer machines can export global/save/workspace options.
// Clear those only for the synchronous invocation under test, then restore exactly.
// No registry, proxy, credential, or PATH value is inspected or logged by the fake.
function withNpmEnvironment(overrides, action) {
  const relevant = (key) => /^(?:npm_config_|npm_execpath$|NODE_ENV$)/i.test(key);
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => relevant(key)));
  for (const key of Object.keys(process.env)) if (relevant(key)) delete process.env[key];
  try {
    Object.assign(process.env, overrides);
    return action();
  } finally {
    for (const key of Object.keys(process.env)) if (relevant(key)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

// Serialized into an independent .mjs, launched by the runner with Node, never a
// shell shim. Archives are deterministic fixture bytes, NOT actual npm tarballs.
function fakeNpmMain() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const args = process.argv.slice(2);
  const command = args[0];
  const environmentKeys = [
    'global', 'location', 'prefix', 'workspace', 'workspaces', 'include_workspace_root',
    'dry_run', 'package_lock_only', 'ignore_scripts', 'save', 'save_dev', 'save_prod',
    'save_optional', 'save_peer', 'bin_links', 'include',
  ];
  appendFileSync(fixture.log, JSON.stringify({
    command, args, cwd: process.cwd(), executable: fileURLToPath(import.meta.url),
    environment: Object.fromEntries(environmentKeys.map((key) => [key, process.env[`npm_config_${key}`] ?? null])),
  }) + '\n');
  assert.equal(process.cwd(), fixture.root);
  assert.equal(args[args.indexOf('--prefix') + 1], fixture.root);
  assert.ok(args.includes('--global=false'));
  assert.ok(args.includes('--workspaces=false'));
  assert.ok(args.includes('--package-lock=true'));
  assert.ok(args.includes('--ignore-scripts'));
  assert.equal(process.env.npm_config_global, 'false');
  assert.equal(process.env.npm_config_location, 'project');
  assert.equal(process.env.npm_config_prefix, fixture.root);
  assert.equal(process.env.npm_config_ignore_scripts, 'true');
  assert.equal(process.env.npm_config_include, 'dev');

  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const put = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  };
  const fail = (message) => { process.stderr.write(message + '\n'); process.exit(23); };
  const manifestPath = join(fixture.root, 'package.json');
  const statePath = join(dirname(fixturePath), 'packed-target.json');

  if (command === 'pack') {
    assert.ok(args.includes('--json'));
    const destination = args[args.indexOf('--pack-destination') + 1];
    const target = basename(destination) === 'target';
    if (fixture.fail === (target ? 'target-pack' : 'old-pack')) fail('fixture pack failure');
    const metadata = target
      ? { name: fixture.packName ?? 'workforce', version: fixture.version }
      : read(join(args[1], 'package.json'));
    const name = metadata.name;
    const version = metadata.version;
    const filename = `${name}-${version}.tgz`;
    const bytes = target && isAbsolute(args[1])
      ? readFileSync(args[1])
      : Buffer.from(JSON.stringify({ name, version, fixture_archive: true }) + '\n');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, filename), bytes);
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    if (target) put(statePath, { name, version, integrity });
    const packed = {
      name, version, filename, integrity,
      files: [{ path: 'package.json' }, { path: 'dist/cli.js' }],
    };
    const output = fixture.packShape === 'keyed' ? { [fixture.packKey ?? name]: packed }
      : fixture.packShape === 'ambiguous-keyed' ? { [name]: packed, unexpected: packed }
      : fixture.packShape === 'null-keyed' ? { [name]: null }
      : fixture.packShape === 'direct-object' ? packed
      : fixture.packShape === 'ambiguous-array' ? [packed, packed] : [packed];
    process.stdout.write(JSON.stringify(output));
    return;
  }

  if (command === 'uninstall') {
    if (fixture.fail === 'uninstall') fail('fixture uninstall failure');
    const manifest = read(manifestPath);
    for (const name of args.slice(1, args.indexOf('--ignore-scripts'))) {
      assert.ok(['workforce', 'neomind', 'taskforces', 'verythinker'].includes(name));
      // Also removes the original runner and loaded old core in the survival test.
      rmSync(join(fixture.root, 'node_modules', name), { recursive: true, force: true });
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
        if (manifest[section]) delete manifest[section][name];
    }
    put(manifestPath, manifest);
    return;
  }

  if (command === 'install') {
    if (fixture.fail === 'install') fail('fixture install failure');
    assert.ok(args.includes('--save-exact'));
    const section = args.includes('--save-dev') ? 'devDependencies' : 'dependencies';
    assert.ok(args.includes(section === 'dependencies' ? '--save-prod' : '--save-dev'));
    const target = read(statePath);
    const local = isAbsolute(args[1]);
    assert.equal(local ? existsSync(args[1]) : args[1], local ? true : `workforce@${target.version}`);
    const spec = local ? 'file:' + relative(fixture.root, args[1]).split(sep).join('/') : target.version;
    const manifest = read(manifestPath);
    manifest[section] ??= {};
    manifest[section].workforce = spec;
    put(manifestPath, manifest);
    const installed = join(fixture.root, 'node_modules', 'workforce');
    put(join(installed, 'package.json'), {
      name: 'workforce', version: target.version, type: 'module', bin: { workforce: 'dist/cli.js' },
    });
    mkdirSync(join(installed, 'dist'), { recursive: true });
    writeFileSync(join(installed, 'dist/cli.js'), fixture.newCliSource);
    const packages = { '': { [section]: { ...manifest[section] } } };
    packages['node_modules/workforce'] = {
      version: target.version,
      resolved: local ? spec : `https://registry.invalid/workforce/-/workforce-${target.version}.tgz`,
      integrity: target.integrity,
    };
    put(join(fixture.root, 'package-lock.json'), { name: manifest.name, lockfileVersion: 3, packages });
    return;
  }
  fail(`Unexpected fake npm command: ${command}`);
}

// The installed replacement has its OWN executable CLI. This deliberately small
// update stand-in emits the actual InstallReport shape, not a second upgrader.
function newCliMain() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const root = fixture.root;
  const args = process.argv.slice(2);
  appendFileSync(fixture.log, JSON.stringify({
    command: 'update', args, cwd: process.cwd(), executable: fileURLToPath(import.meta.url),
  }) + '\n');
  assert.deepEqual(args, ['update', '--project', root, '--json']);
  assert.equal(process.cwd(), root);
  assert.equal(existsSync(join(root, 'node_modules/workforce/scripts/upgrade-runner.mjs')), false);
  if (fixture.fail === 'update') {
    process.stderr.write('fixture new CLI update failure\n');
    process.exit(31);
  }
  if (fixture.fail === 'update-json') {
    process.stdout.write('not JSON');
    return;
  }
  const managed = fixture.managed;
  const marker = `${managed}/roles/upgrade-marker.md`;
  mkdirSync(dirname(join(root, marker)), { recursive: true });
  writeFileSync(join(root, marker), `New CLI ${fixture.version}\n`);
  const conflicts = [];
  if (fixture.conflicts) {
    const candidate = `${managed}/updates/${fixture.version}/roles/researcher.md`;
    mkdirSync(dirname(join(root, candidate)), { recursive: true });
    writeFileSync(join(root, candidate), 'Replacement research procedure.\n');
    conflicts.push({ path: `${managed}/roles/researcher.md`, candidate, reason: 'Managed content was modified by the user.' });
  }
  const report = {
    schema_version: 1, version: fixture.version, root, platforms: ['copilot'],
    installed: [], updated: [marker], unchanged: ['AGENTS.md'], conflicts,
    warnings: conflicts.length ? ['User edits were preserved; review the update candidate.'] : [],
  };
  if (fixture.fail === 'update-report') report.version = '0.0.0';
  process.stdout.write(JSON.stringify(report) + '\n');
}

function executableSource(main, fixturePath, npm = false) {
  return [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    ...(npm ? ["import { createHash } from 'node:crypto';"] : []),
    `const fixturePath = ${JSON.stringify(fixturePath)};`,
    `(${main.toString()})();`,
    '',
  ].join('\n');
}

function project(t, options = {}) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'neomind upgrade-')));
  const root = join(sandbox, 'project with spaces');
  const recoveryPaths = new Set();
  t.after(() => {
    for (const recovery of recoveryPaths) {
      assert.equal(dirname(recovery), realpathSync(tmpdir()));
      assert.ok(basename(recovery).startsWith('workforce-upgrade-'));
      rmSync(recovery, { recursive: true, force: true });
    }
    rmSync(sandbox, { recursive: true, force: true });
  });
  initialize(root, { project_id: 'UPGRADE-TEST', platforms: ['copilot'] });
  const managed = options.legacyStorage ? '.verythinker' : options.neomindStorage ? '.neomind' : '.workforce';
  if (options.legacyStorage || options.neomindStorage) {
    const source = resolve(root, '.workforce'), destination = resolve(root, managed);
    assert.equal(dirname(sandbox), realpathSync(tmpdir()));
    assert.ok(basename(sandbox).startsWith('neomind upgrade-'));
    assert.equal(dirname(resolve(root)), sandbox);
    assert.equal(dirname(source), resolve(root));
    assert.equal(dirname(destination), resolve(root));
    retryWindowsFileOperation(() => renameSync(source, destination));
  }
  const section = options.section ?? 'devDependencies';
  const names = options.names ?? ['neomind'];
  const manifest = {
    name: 'upgrade-consumer', version: '1.0.0', private: true, packageManager: 'npm@11.0.0',
    dependencies: { 'keep-production': '1.2.3' },
    devDependencies: { 'keep-development': '4.5.6' },
  };
  for (const name of names) manifest[section][name] = `^${oldVersion}`;
  writeJson(join(root, 'package.json'), manifest);
  const packages = { '': { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies } };
  for (const name of names) {
    packages[`node_modules/${name}`] = { version: oldVersion };
    writeJson(join(root, 'node_modules', name, 'package.json'), {
      name, version: oldVersion, type: 'module', bin: { [name]: 'dist/cli.js' },
    });
    write(join(root, 'node_modules', name, 'dist/cli.js'), "throw new Error('The old CLI must never run');\n");
    write(join(root, 'node_modules', name, 'scripts/upgrade-runner.mjs'), '// Original old runner sentinel.\n');
  }
  writeJson(join(root, 'package-lock.json'), { name: manifest.name, lockfileVersion: 3, packages });
  writeJson(join(root, 'node_modules/.package-lock.json'), { lockfileVersion: 3, packages });
  writeJson(join(root, managed, 'install-manifest.json'), { schema_version: 1, version: oldVersion, files: {} });
  write(join(root, managed, 'records/keep.md'), 'Keep managed project data.\n');
  write(join(root, 'AGENTS.md'), '# User instructions\nPreserve this file.\n');

  const npmCli = join(sandbox, 'fake npm outside node_modules', 'npm-cli.mjs');
  const fixturePath = join(dirname(npmCli), 'fixture.json');
  const log = join(dirname(npmCli), 'invocations.jsonl');
  const configuration = {
    root, managed, log, version: newVersion, ...options,
    newCliSource: executableSource(newCliMain, fixturePath),
  };
  writeJson(fixturePath, configuration);
  write(npmCli, executableSource(fakeNpmMain, fixturePath, true));
  const original = new Map([
    'package.json', 'package-lock.json', 'node_modules/.package-lock.json',
    `${managed}/config.json`, `${managed}/install-manifest.json`,
    `${managed}/records/keep.md`, 'AGENTS.md',
  ].map((path) => [path, readFileSync(join(root, path))]));
  const track = (value) => {
    if (value?.recovery_path) recoveryPaths.add(value.recovery_path);
    return value;
  };
  return {
    root, sandbox, managed, section, names, npmCli, fixturePath, original, track,
    events: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    configure: (changes) => writeJson(fixturePath, { ...json(fixturePath), ...changes }),
    upgrade(target = 'latest', environment = {}) {
      return withNpmEnvironment(environment, () => {
        try { return track(upgradeProject(root, target, { npm_cli: npmCli })); }
        catch (error) { track(error); throw error; }
      });
    },
  };
}

function commands(fixture) {
  return fixture.events().map((event) => event.command);
}

function failure(fixture, phase, target = 'latest', environment = {}, message) {
  let caught;
  assert.throws(() => fixture.upgrade(target, environment), (error) => {
    caught = error;
    assert.ok(error instanceof UpgradeError);
    assert.equal(error.phase, phase);
    if (message) assert.match(error.message, message);
    return true;
  });
  if (caught.recovery_path) {
    const journal = json(join(caught.recovery_path, 'recovery.json'));
    assert.equal(journal.phase, phase);
    assert.equal(journal.error.phase, phase);
    const result = json(join(caught.recovery_path, 'result.json'));
    assert.equal(result.ok, false);
    assert.equal(result.result, undefined);
  }
  return caught;
}

function unchanged(fixture) {
  for (const [path, bytes] of fixture.original)
    assert.deepEqual(readFileSync(join(fixture.root, path)), bytes, path);
  for (const name of fixture.names)
    assert.equal(json(join(fixture.root, 'node_modules', name, 'package.json')).version, oldVersion);
}

function backups(fixture, recovery) {
  const journal = json(join(recovery, 'recovery.json'));
  for (const entry of journal.backups) {
    if (entry.backup === null) {
      assert.equal(entry.path, 'npm-shrinkwrap.json');
      continue;
    }
    assert.deepEqual(readFileSync(entry.backup), fixture.original.get(entry.path), entry.path);
    assert.equal(createHash('sha256').update(readFileSync(entry.backup)).digest('hex'), entry.sha256);
  }
  assert.ok(journal.backups.some((entry) => entry.path === `${fixture.managed}/config.json` && entry.backup));
  return journal;
}

function success(fixture, result) {
  assert.equal(result.schema_version, 1);
  assert.equal(result.status, 'upgraded');
  assert.equal(result.root, fixture.root);
  assert.deepEqual(result.target, { name: 'workforce', version: newVersion });
  assert.deepEqual(result.previous, fixture.names.map((name) => ({ name, version: oldVersion })));
  assert.equal(result.dependency_section, fixture.section);
  assert.equal(result.update.schema_version, 1);
  assert.equal(result.update.version, newVersion);
  assert.equal(result.update.root, fixture.root);
  assert.deepEqual(result.update.platforms, ['copilot']);
  for (const key of ['installed', 'updated', 'unchanged', 'warnings']) assert.ok(Array.isArray(result.update[key]));
  assert.deepEqual(result.conflicts, result.update.conflicts);
  assert.deepEqual(result.migration, { required: fixture.managed !== '.workforce', target_engine: 'opencode',
    command: ['workforce', 'migrate', '--project', fixture.root] });
  assert.equal(readFileSync(join(fixture.root, fixture.managed, 'roles/upgrade-marker.md'), 'utf8'), `New CLI ${newVersion}\n`);
  for (const path of [`${fixture.managed}/config.json`, `${fixture.managed}/records/keep.md`, 'AGENTS.md'])
    assert.deepEqual(readFileSync(join(fixture.root, path)), fixture.original.get(path));
  const manifest = json(join(fixture.root, 'package.json'));
  assert.equal(manifest.dependencies['keep-production'], '1.2.3');
  assert.equal(manifest.devDependencies['keep-development'], '4.5.6');
  for (const section of dependencySections) {
    assert.equal(manifest[section]?.verythinker, undefined);
    assert.equal(manifest[section]?.neomind, undefined);
    if (section !== fixture.section) assert.equal(manifest[section]?.workforce, undefined);
  }
  const journal = backups(fixture, result.recovery_path);
  assert.equal(journal.phase, 'complete');
  assert.equal(journal.previous.length, fixture.names.length);
  for (const old of journal.previous) assert.ok(existsSync(old.archive.path));
  assert.deepEqual(result.backups, journal.backups.map(({ path, backup }) => ({ path, backup })));
  assert.equal(json(join(result.recovery_path, 'result.json')).ok, true);
  assert.equal(existsSync(join(fixture.root, fixture.managed, 'operations/package-upgrade.lock')), false);
  assert.equal(fixture.events().at(-1).executable, join(fixture.root, 'node_modules/workforce/dist/cli.js'));
}

test('an existing WorkForce package upgrades without mutating routing aliases or historical records', t => {
  const fixture = project(t, { names: ['workforce'] });
  const path = join(fixture.root, fixture.managed, 'routing.json');
  const routing = Buffer.from('{ "strong_model": "top-models", "worker_models": ["worker-models"], "strong_provider": "customendpoint" }\r\n');
  write(path, routing);
  success(fixture, fixture.upgrade());
  assert.deepEqual(readFileSync(path), routing);
});

test('a NeoMind physical project returns explicit migration instructions after releasing the package lease', t => {
  const fixture = project(t, { neomindStorage: true });
  const result = fixture.upgrade();
  success(fixture, result);
  assert.equal(result.migration.required, true);
  assert.equal(existsSync(join(fixture.root, '.workforce')), false);
  assert.equal(existsSync(join(fixture.root, '.neomind/operations/package-upgrade.lock')), false);
});

test('an enabled editor execution owner prevents package replacement before npm runs', t => {
  const fixture = project(t);
  const key = createHash('sha256').update(`${userInfo().username}\0${realpathSync.native(fixture.root)}`).digest('hex');
  const directory = join(realpathSync(tmpdir()), `neomind-vscode-${key}`);
  assert.equal(dirname(directory), realpathSync(tmpdir()));
  assert.match(basename(directory), /^neomind-vscode-[a-f0-9]{64}$/);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeJson(join(directory, 'host.json'), { root: realpathSync.native(fixture.root), pid: process.pid });
  failure(fixture, 'preflight', 'latest', {}, /editor execution owner is active/);
  assert.deepEqual(commands(fixture), []);
  unchanged(fixture);
});

for (const section of ['dependencies', 'devDependencies']) {
  for (const target of ['2.3.4', 'next']) {
    test(`registry ${target} is pinned and saved exact in ${section}, after staging both archives`, (t) => {
      const fixture = project(t, { section });
      const result = fixture.upgrade(target);
      success(fixture, result);
      assert.deepEqual(commands(fixture), ['pack', 'pack', 'uninstall', 'install', 'update']);
      const [targetPack, oldPack, uninstall, install] = fixture.events();
      assert.equal(targetPack.args[1], `workforce@${target}`);
      assert.equal(oldPack.args[1], join(fixture.root, 'node_modules/neomind'));
      assert.deepEqual(uninstall.args.slice(0, 2), ['uninstall', 'neomind']);
      assert.equal(install.args[1], `workforce@${newVersion}`);
      assert.ok(install.args.includes('--save-exact'));
      assert.ok(install.args.includes(section === 'dependencies' ? '--save-prod' : '--save-dev'));
      assert.equal(result.dependency_spec, newVersion);
      assert.equal(json(join(fixture.root, 'package.json'))[section].workforce, newVersion);
      assert.equal(result.durable_target, undefined);
      assert.ok(existsSync(result.staged_target));
    });
  }
}

test('verythinker is renamed without migrating legacy managed data', (t) => {
  const fixture = project(t, { names: ['verythinker'], legacyStorage: true, section: 'dependencies' });
  const result = fixture.upgrade();
  success(fixture, result);
  assert.deepEqual(commands(fixture), ['pack', 'pack', 'uninstall', 'install', 'update']);
  assert.equal(fixture.events()[1].args[1], join(fixture.root, 'node_modules/verythinker'));
  assert.equal(fixture.events()[2].args[1], 'verythinker');
  assert.equal(existsSync(join(fixture.root, 'node_modules/verythinker')), false);
  assert.equal(existsSync(join(fixture.root, '.neomind')), false);
});

test('both old direct package names in one section are backed up before a single uninstall', (t) => {
  const fixture = project(t, { names: ['neomind', 'verythinker'] });
  const result = fixture.upgrade();
  success(fixture, result);
  assert.deepEqual(commands(fixture), ['pack', 'pack', 'pack', 'uninstall', 'install', 'update']);
  assert.deepEqual(fixture.events()[3].args.slice(0, 3), ['uninstall', 'neomind', 'verythinker']);
  assert.equal(existsSync(join(fixture.root, 'node_modules/verythinker')), false);
});

for (const section of ['dependencies', 'devDependencies']) {
  test(`local .tgz saves a durable managed cache file: dependency in ${section}`, (t) => {
    const fixture = project(t, { section, legacyStorage: section === 'dependencies' });
    const input = join(fixture.sandbox, 'input archives/replacement.tgz');
    const bytes = Buffer.from(JSON.stringify({ name: 'workforce', version: newVersion, fixture_archive: true }) + '\n');
    write(input, bytes);
    const result = fixture.upgrade(relative(fixture.root, input));
    success(fixture, result);
    assert.deepEqual(commands(fixture), ['pack', 'pack', 'uninstall', 'install', 'update']);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(result.durable_target, join(fixture.root, fixture.managed, 'package-cache', `${digest}.tgz`));
    assert.equal(result.dependency_spec, `file:${fixture.managed}/package-cache/${digest}.tgz`);
    assert.equal(fixture.events()[0].args[1], input);
    assert.equal(fixture.events()[3].args[1], result.durable_target);
    assert.equal(json(join(fixture.root, 'package.json'))[section].workforce, result.dependency_spec);
    assert.equal(json(join(fixture.root, 'package-lock.json')).packages['node_modules/workforce'].resolved, result.dependency_spec);
    assert.deepEqual(readFileSync(result.staged_target), bytes);
    rmSync(input);
    rmSync(result.recovery_path, { recursive: true, force: true });
    assert.deepEqual(readFileSync(resolve(fixture.root, result.dependency_spec.slice(5))), bytes);
  });
}

test('host npm save/workspace/dry-run options cannot override a local dev install', (t) => {
  const fixture = project(t);
  const result = fixture.upgrade('latest', {
    NODE_ENV: 'production', npm_execpath: join(fixture.root, 'node_modules/never-run.mjs'),
    npm_config_prefix: join(fixture.sandbox, 'wrong-prefix'), npm_config_workspace: 'wrong-workspace',
    npm_config_workspaces: 'true', npm_config_include_workspace_root: 'true',
    npm_config_dry_run: 'true', npm_config_package_lock_only: 'true', npm_config_ignore_scripts: 'false',
    npm_config_package_lock: 'false',
    npm_config_save: 'false', npm_config_save_prod: 'true', npm_config_save_optional: 'true',
    npm_config_save_peer: 'true', npm_config_bin_links: 'false', npm_config_include: 'prod', npm_config_omit: 'dev',
  });
  success(fixture, result);
  for (const invocation of fixture.events().filter((event) => event.command !== 'update')) {
    assert.equal(invocation.executable, fixture.npmCli);
    assert.equal(invocation.environment.prefix, fixture.root);
    for (const key of ['global', 'workspaces', 'dry_run', 'package_lock_only'])
      assert.equal(invocation.environment[key], 'false', key);
    // npm 12 treats explicitly provided save modes as exclusive even when false.
    // Pack must receive no save mode; install chooses one original section via CLI.
    for (const key of ['save_dev', 'save_prod', 'save_optional', 'save_peer'])
      assert.equal(invocation.environment[key], null, `${invocation.command}: ${key}`);
    for (const key of ['ignore_scripts', 'bin_links', 'save']) assert.equal(invocation.environment[key], 'true', key);
    assert.equal(invocation.environment.location, 'project');
    assert.equal(invocation.environment.include, 'dev');
    assert.equal(invocation.environment.workspace, null);
    assert.equal(invocation.environment.include_workspace_root, null);
  }
  const packs = fixture.events().filter((event) => event.command === 'pack');
  assert.equal(packs.length, 2, 'Both target and recovery packing use the scrubbed environment');
  for (const packed of packs)
    assert.ok(!packed.args.some((arg) => /^--save-(?:dev|prod|optional|peer)(?:=|$)/.test(arg)));
});

for (const scenario of [
  { label: 'wrong keyed package name', options: { packShape: 'keyed', packKey: 'unexpected' }, phase: 'stage-target', sequence: ['pack'], message: /identity\/version/ },
  { label: 'ambiguous keyed metadata', options: { packShape: 'ambiguous-keyed' }, phase: 'stage-target', sequence: ['pack'], message: /identity\/version/ },
  { label: 'null keyed metadata', options: { packShape: 'null-keyed' }, phase: 'stage-target', sequence: ['pack'], message: /identity\/version/ },
  { label: 'unwrapped direct metadata', options: { packShape: 'direct-object' }, phase: 'stage-target', sequence: ['pack'], message: /identity\/version/ },
  { label: 'ambiguous array metadata', options: { packShape: 'ambiguous-array' }, phase: 'stage-target', sequence: ['pack'], message: /identity\/version/ },
  { label: 'wrong packed package identity', options: { packName: 'verythinker' }, phase: 'stage-target', sequence: ['pack'], message: /identity\/version/ },
  { label: 'target pack failure', options: { fail: 'target-pack' }, phase: 'stage-target', sequence: ['pack'], message: /pack/ },
  { label: 'old recovery pack failure', options: { fail: 'old-pack' }, phase: 'stage-old', sequence: ['pack', 'pack'], message: /pack/ },
]) {
  test(`${scenario.label} stops before uninstall`, (t) => {
    const fixture = project(t, scenario.options);
    const error = failure(fixture, scenario.phase, 'latest', {}, scenario.message);
    assert.deepEqual(commands(fixture), scenario.sequence);
    unchanged(fixture);
    backups(fixture, error.recovery_path);
    assert.equal(existsSync(join(fixture.root, fixture.managed, 'operations/package-upgrade.lock')), false);
  });
}

for (const section of ['dependencies', 'devDependencies']) {
  test(`single expected-name keyed pack metadata upgrades ${section}`, t => {
    const fixture = project(t, { section, packShape: 'keyed' });
    const result = fixture.upgrade('latest');
    success(fixture, result);
    assert.deepEqual(commands(fixture), ['pack', 'pack', 'uninstall', 'install', 'update']);
  });
}

for (const phase of ['uninstall', 'install']) {
  test(`${phase} failure retains recovery, backups and managed config without continuing`, (t) => {
    const fixture = project(t, { fail: phase });
    const error = failure(fixture, phase, 'latest', {}, new RegExp(`fixture ${phase} failure`));
    assert.deepEqual(commands(fixture), phase === 'uninstall'
      ? ['pack', 'pack', 'uninstall'] : ['pack', 'pack', 'uninstall', 'install']);
    const journal = backups(fixture, error.recovery_path);
    assert.equal(journal.phase, phase);
    assert.ok(existsSync(journal.target.path));
    assert.ok(existsSync(journal.previous[0].archive.path));
    for (const path of [`${fixture.managed}/config.json`, `${fixture.managed}/install-manifest.json`, `${fixture.managed}/records/keep.md`])
      assert.deepEqual(readFileSync(join(fixture.root, path)), fixture.original.get(path));
    assert.equal(existsSync(join(fixture.root, fixture.managed, 'roles/upgrade-marker.md')), false);
    assert.equal(existsSync(join(fixture.root, fixture.managed, 'operations/package-upgrade.lock')), false);
    // No automatic rollback is promised after destructive uninstall.
    if (phase === 'uninstall') unchanged(fixture);
    else assert.equal(existsSync(join(fixture.root, 'node_modules/neomind')), false);
  });
}

for (const mode of ['update', 'update-json', 'update-report']) {
  test(`${mode} failure never returns an upgraded success`, (t) => {
    const fixture = project(t, { fail: mode });
    const error = failure(fixture, 'update');
    assert.deepEqual(commands(fixture), ['pack', 'pack', 'uninstall', 'install', 'update']);
    backups(fixture, error.recovery_path);
    assert.equal(json(join(fixture.root, 'node_modules/workforce/package.json')).version, newVersion);
    assert.deepEqual(readFileSync(join(fixture.root, fixture.managed, 'config.json')), fixture.original.get(`${fixture.managed}/config.json`));
    assert.equal(existsSync(join(fixture.root, fixture.managed, 'operations/package-upgrade.lock')), false);
  });
}

test('new CLI conflicts remain visible and user edits are preserved', (t) => {
  const fixture = project(t, { conflicts: true });
  const path = `${fixture.managed}/roles/researcher.md`;
  write(join(fixture.root, path), 'User research procedure.\n');
  const result = fixture.upgrade();
  success(fixture, result);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, path);
  assert.match(result.conflicts[0].reason, /modified/);
  assert.equal(readFileSync(join(fixture.root, path), 'utf8'), 'User research procedure.\n');
  assert.equal(readFileSync(join(fixture.root, result.conflicts[0].candidate), 'utf8'), 'Replacement research procedure.\n');
  assert.ok(result.update.warnings.length > 0);
});

const preflightCases = [
  ...['workforce', 'neomind', 'taskforces', 'verythinker'].map((name) => ({
    label: `source checkout named ${name}`, message: /source checkout|named neomind/,
    setup(fixture, manifest) { manifest.name = name; },
  })),
  {
    label: 'workspace root', message: /workspace/i,
    setup(fixture, manifest) { manifest.workspaces = ['packages/*']; },
  },
  {
    label: 'workspace ancestor', message: /workspace/i,
    setup(fixture) { writeJson(join(fixture.sandbox, 'package.json'), { private: true, workspaces: ['*'] }); },
  },
  {
    label: 'workspace protocol dependency', message: /workspace/i,
    setup(fixture, manifest) { manifest.dependencies.other = 'workspace:*'; },
  },
  {
    label: 'renamed npm alias', message: /alias/i,
    setup(fixture, manifest) { manifest.dependencies['renamed-tool'] = 'npm:neomind@1.0.0'; },
  },
  {
    label: 'renamed legacy npm alias', message: /alias/i,
    setup(fixture, manifest) { manifest.dependencies['renamed-tool'] = 'npm:verythinker@1.0.0'; },
  },
  {
    label: 'ambiguous dependency sections', message: /unambiguous|same/,
    setup(fixture, manifest) { manifest.dependencies.neomind = oldVersion; },
  },
  ...[
    { neomind: oldVersion },
    { [`neomind@${oldVersion}`]: oldVersion },
    { other: { verythinker: oldVersion } },
  ].map((overrides) => ({
    label: `tool override ${JSON.stringify(overrides)}`, message: /overrides.*manual review/i,
    setup(fixture, manifest) { manifest.overrides = overrides; },
  })),
  ...['write.lock', '.write.lock', 'operations/manager.lock', 'tools/codex.install.lock'].map((path) => ({
    label: `active ${path}`, message: /lock/i,
    setup(fixture) { writeJson(join(fixture.root, fixture.managed, path), { pid: process.pid }); },
  })),
  {
    label: 'active package-upgrade lease', message: /already running|locked/i,
    setup(fixture) {
      writeJson(join(fixture.root, fixture.managed, 'operations/package-upgrade.lock'), {
        pid: process.pid, thread_id: threadId, token: 'existing-live-owner', started_at: new Date().toISOString(),
      });
    },
  },
  ...['running', 'pending', 'unrecognized'].map((state) => ({
    label: `native receipt ${state}`, message: /not settled|active/i,
    setup(fixture) { writeJson(join(fixture.root, fixture.managed, 'native/receipts/active.json'), { state }); },
  })),
  {
    label: 'unreadable native receipt', message: /indeterminate|unreadable/i,
    setup(fixture) { write(join(fixture.root, fixture.managed, 'native/receipts/active.json'), '{broken'); },
  },
  ...[
    { npm_config_global: 'true' }, { npm_config_global: '1' }, { npm_config_location: 'global' },
  ].map((environment) => ({ label: `global npm ${JSON.stringify(environment)}`, environment, message: /global/i })),
];

for (const scenario of preflightCases) {
  test(`preflight rejects ${scenario.label} before any npm invocation`, (t) => {
    const fixture = project(t);
    const manifest = json(join(fixture.root, 'package.json'));
    scenario.setup?.(fixture, manifest);
    writeJson(join(fixture.root, 'package.json'), manifest);
    fixture.original.set('package.json', readFileSync(join(fixture.root, 'package.json')));
    failure(fixture, 'preflight', 'latest', scenario.environment ?? {}, scenario.message);
    assert.deepEqual(commands(fixture), []);
    unchanged(fixture);
  });
}

for (const target of [
  '--global', ' latest', 'latest ', 'neomind@next', '@scope/tool',
  'npm:neomind@2.3.4', 'workspace:*', 'https://registry.invalid/tool.tgz',
  'git+https://example.invalid/tool.git', 'file:../tool.tgz', '2.3.4\0--global',
]) {
  test(`unsafe target ${JSON.stringify(target)} fails preflight without npm`, (t) => {
    const fixture = project(t);
    const error = failure(fixture, 'preflight', target);
    assert.equal(error.recovery_path, null);
    assert.deepEqual(commands(fixture), []);
    unchanged(fixture);
  });
}

test('linked installed package is rejected before uninstall (Windows junction supported)', (t) => {
  const fixture = project(t);
  const installed = join(fixture.root, 'node_modules/neomind');
  const external = join(fixture.sandbox, 'linked old package');
  renameSync(installed, external);
  symlinkSync(external, installed, process.platform === 'win32' ? 'junction' : 'dir');
  failure(fixture, 'preflight', 'latest', {}, /real directory|link|junction/i);
  assert.deepEqual(commands(fixture), []);
  unchanged(fixture);
});

test('linked local tarball is rejected before uninstall', (t) => {
  const fixture = project(t);
  const archive = join(fixture.sandbox, 'real.tgz');
  const link = join(fixture.root, 'linked.tgz');
  write(archive, 'fixture archive\n');
  try { symlinkSync(archive, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('File symlink creation requires Windows Developer Mode or symlink privileges.');
      return;
    }
    throw error;
  }
  failure(fixture, 'preflight', 'linked.tgz', {}, /regular local file/);
  assert.deepEqual(commands(fixture), []);
  unchanged(fixture);
});

test('npm override inside the target node_modules cannot be used across uninstall', (t) => {
  const fixture = project(t);
  const unsafeCli = join(fixture.root, 'node_modules/neomind/npm-cli.mjs');
  cpSync(fixture.npmCli, unsafeCli);
  assert.throws(() => withNpmEnvironment({}, () => {
    try { upgradeProject(fixture.root, 'next', { npm_cli: unsafeCli }); }
    catch (error) { fixture.track(error); throw error; }
  }), (error) => {
    assert.ok(error instanceof UpgradeError);
    assert.equal(error.phase, 'preflight');
    assert.match(error.message, /survive removal|outside project node_modules/);
    return true;
  });
  assert.deepEqual(commands(fixture), []);
  unchanged(fixture);
});

test('settled native receipts allow upgrade without rewriting signed receipt bytes', (t) => {
  const fixture = project(t);
  const receipts = ['completed', 'failed', 'interrupted', 'blocked', 'orphaned'].map((state) => {
    const path = join(fixture.root, fixture.managed, 'native/receipts', `${state}.json`);
    const bytes = JSON.stringify({ state, signature: 'opaque-signature-never-rewritten' }) + '\n';
    write(path, bytes);
    return [path, bytes];
  });
  success(fixture, fixture.upgrade());
  for (const [path, bytes] of receipts) assert.equal(readFileSync(path, 'utf8'), bytes);
});

test('loaded installed supervisor and copied runner survive removal of the entire old package', (t) => {
  const fixture = project(t);
  const installed = join(fixture.root, 'node_modules/neomind');
  // Use the actual built upgrade/storage core under the package that fake npm
  // deletes, not a second implementation or an import from the source checkout.
  for (const file of ['upgrade.js', 'storage.js', 'storage-layout.js', 'types.js', 'execution-mode.js'])
    cpSync(join(repository, 'dist', file), join(installed, 'dist', file));
  cpSync(join(repository, 'scripts/upgrade-runner.mjs'), join(installed, 'scripts/upgrade-runner.mjs'));
  const require = createRequire(new URL('../dist/storage.js', import.meta.url));
  const yaml = dirname(require.resolve('yaml/package.json'));
  cpSync(yaml, join(fixture.root, 'node_modules/yaml'), { recursive: true });
  const supervisor = join(fixture.sandbox, 'loaded supervisor.mjs');
  write(supervisor, [
    `import { upgradeProject } from ${JSON.stringify(pathToFileURL(join(installed, 'dist/upgrade.js')).href)};`,
    'try {',
    `  const result = upgradeProject(${JSON.stringify(fixture.root)}, 'next', { npm_cli: ${JSON.stringify(fixture.npmCli)} });`,
    '  process.stdout.write(JSON.stringify({ ok: true, result }));',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ ok: false, error: { phase: error.phase, recovery_path: error.recovery_path, message: error.message } }));',
    '  process.exitCode = 1;',
    '}',
    '',
  ].join('\n'));
  const child = withNpmEnvironment({}, () => spawnSync(process.execPath, [supervisor], {
    cwd: fixture.sandbox, encoding: 'utf8', shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  }));
  let envelope;
  try {
    envelope = JSON.parse(child.stdout);
    fixture.track(envelope.result ?? envelope.error);
  } catch (error) {
    assert.fail(`Supervisor did not return JSON: ${child.error?.message ?? error.message}; stderr: ${child.stderr}`);
  }
  assert.equal(child.status, 0, JSON.stringify(envelope));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const result = envelope.result;
  success(fixture, result);
  assert.deepEqual(commands(fixture), ['pack', 'pack', 'uninstall', 'install', 'update']);
  assert.equal(existsSync(join(installed, 'dist/upgrade.js')), false);
  assert.equal(existsSync(join(installed, 'dist/storage.js')), false);
  assert.equal(existsSync(join(installed, 'scripts/upgrade-runner.mjs')), false);
  assert.equal(readFileSync(join(result.recovery_path, 'upgrade-runner.mjs'), 'utf8'),
    readFileSync(join(repository, 'scripts/upgrade-runner.mjs'), 'utf8'));
  const recoveryRelative = relative(join(fixture.root, 'node_modules'), result.recovery_path);
  assert.ok(isAbsolute(recoveryRelative) || recoveryRelative === '..' || recoveryRelative.startsWith(`..${sep}`));
  assert.equal(json(join(result.recovery_path, 'config.json')).npm_cli, fixture.npmCli);
});
