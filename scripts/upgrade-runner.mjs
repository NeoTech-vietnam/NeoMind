// This file is copied outside node_modules before execution. Keep ALL imports
// built-in and eager: neither npm removal nor update may load the old package.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const names = ['taskforces', 'verythinker'];
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const settled = new Set(['completed', 'failed', 'interrupted', 'blocked', 'orphaned']);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
let phase = 'preflight';
let configuration;
let journal;

function inside(base, path) {
  const rel = relative(base, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function regular(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  return path;
}

function directory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a real directory: ${path}`);
  return path;
}

function equalPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function localPath(root, path) {
  if (!inside(root, path) || !equalPath(realpathSync(path), path))
    throw new Error(`Links/junctions are unsupported in upgrade paths: ${path}`);
  return path;
}

function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

function checkpoint(next) {
  phase = next;
  journal.phase = phase;
  atomicJson(join(configuration.recovery_path, 'recovery.json'), journal);
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Treat pack/lock metadata as claims: compare integrity with the actual staged bytes.
function verifyIntegrity(path, integrity) {
  if (typeof integrity !== 'string' || !integrity.trim())
    throw new Error('Missing or invalid archive integrity.');
  const bytes = readFileSync(path);
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match || createHash(match[1]).update(bytes).digest('base64') !== match[2])
      throw new Error('Archive bytes do not match the declared integrity.');
  }
}

function cacheTarget(target) {
  const { root, managed_root: managed } = configuration;
  const base = localPath(root, directory(join(root, managed)));
  const cache = join(base, 'package-cache');
  try { mkdirSync(cache, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  localPath(base, directory(cache));
  const path = join(cache, `${target.sha256}.tgz`);
  // Exclusive creation never overwrites an existing archive (including a dangling link).
  try { copyFileSync(target.path, path, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (sha(localPath(cache, regular(path))) !== target.sha256)
    throw new Error('Durable package cache does not match the staged target; refusing to overwrite it.');
  return path;
}

// Diagnostics are bounded and scrubbed; do not log npm environment or raw output.
function clean(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b(?:https?|git\+https?):\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted authorization]')
    .replace(/((?:_authToken|_auth|password|passwd|token|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\bnpm_[A-Za-z0-9]{16,}\b/g, '[redacted token]')
    .slice(-12000);
}

function validateConfiguration(path) {
  if (!isAbsolute(path)) throw new Error('Runner config must be absolute.');
  regular(path);
  const cfg = json(path);
  if (cfg?.schema_version !== 1 || !isAbsolute(cfg.root ?? '') ||
      !isAbsolute(cfg.recovery_path ?? '') || !isAbsolute(cfg.result_path ?? '') ||
      !['.taskforces', '.verythinker'].includes(cfg.managed_root) ||
      !Number.isSafeInteger(cfg.supervisor_pid) || cfg.supervisor_pid < 1 ||
      typeof cfg.lock_token !== 'string' || !cfg.lock_token)
    throw new Error('Invalid runner configuration.');
  directory(cfg.root);
  directory(cfg.recovery_path);
  if (!equalPath(realpathSync(cfg.root), cfg.root) ||
      !equalPath(realpathSync(cfg.recovery_path), cfg.recovery_path) ||
      dirname(path) !== cfg.recovery_path ||
      cfg.result_path !== join(cfg.recovery_path, 'result.json') ||
      inside(join(cfg.root, 'node_modules'), cfg.recovery_path) ||
      !inside(cfg.recovery_path, fileURLToPath(import.meta.url)))
    throw new Error('Runner, config and results must be staged together outside project node_modules.');
  if (existsSync(cfg.result_path) || existsSync(join(cfg.recovery_path, 'recovery.json')))
    throw new Error('Recovery directory has already been used.');
  if (cfg.npm_cli !== undefined && (!isAbsolute(cfg.npm_cli) || !/\.[cm]?js$/i.test(cfg.npm_cli)))
    throw new Error('npm_cli must be an absolute npm JavaScript CLI.');
  if (typeof cfg.spec !== 'string') throw new Error('Invalid target spec.');
  if (isAbsolute(cfg.spec)) {
    if (!/\.tgz$/i.test(cfg.spec)) throw new Error('Local targets must be .tgz files.');
    regular(cfg.spec);
  } else if (!/^taskforces@[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(cfg.spec)) {
    throw new Error('Only taskforces versions/tags and absolute local .tgz files are supported; scoped packages are unsupported.');
  }
  return cfg;
}

function validateRoot() {
  const { root, managed_root: managed } = configuration;
  if (root.split(/[\\/]/).some((part) => part.toLowerCase() === 'node_modules'))
    throw new Error('Cannot upgrade a project inside node_modules.');
  if (/^(true|1)$/i.test(process.env.npm_config_global ?? '') || process.env.npm_config_location === 'global')
    throw new Error('Global installation mode is unsupported.');
  const pkg = json(localPath(root, regular(join(root, 'package.json'))));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Invalid project package.json.');
  if (names.includes(pkg.name)) throw new Error('Cannot replace the tool source checkout.');
  for (let ancestor = root; ; ancestor = dirname(ancestor)) {
    const path = join(ancestor, 'package.json');
    if (existsSync(path)) {
      const parent = json(path);
      if (parent && Object.hasOwn(parent, 'workspaces'))
        throw new Error('Workspace roots and projects inside workspaces are unsupported.');
    }
    if (ancestor === dirname(ancestor)) break;
  }
  if (/"workspace:[^"]*"/.test(JSON.stringify(pkg))) throw new Error('workspace: dependencies are unsupported.');
  if (typeof pkg.packageManager === 'string' && !pkg.packageManager.startsWith('npm@'))
    throw new Error('Only npm projects are supported.');
  for (const name of ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'])
    if (existsSync(join(root, name))) throw new Error(`Non-npm lockfile ${name} requires manual package-manager migration.`);
  if (existsSync(join(root, '.taskforces-migration.lock')))
    throw new Error('Storage migration is active; stop it before upgrading.');
  if (existsSync(join(root, managed === '.taskforces' ? '.verythinker' : '.taskforces')))
    throw new Error('Both managed storage roots exist; resolve them before upgrading.');
  localPath(root, directory(join(root, managed)));
  regular(localPath(root, join(root, managed, 'config.json')));
  localPath(root, directory(join(root, 'node_modules')));
  const matches = [];
  for (const section of sections) {
    const deps = pkg[section];
    if (deps !== undefined && (!deps || typeof deps !== 'object' || Array.isArray(deps)))
      throw new Error(`Invalid ${section}.`);
    for (const name of names) {
      if (deps && Object.hasOwn(deps, name)) {
        if (typeof deps[name] !== 'string' || !deps[name]) throw new Error(`Invalid direct dependency ${name}.`);
        matches.push({ name, section });
      }
    }
    // Reject renamed npm aliases too: their install/remove ownership is ambiguous.
    if (deps && Object.entries(deps).some(([key, value]) =>
      !names.includes(key) && typeof value === 'string' && /^npm:(?:taskforces|verythinker)(?:@|$)/.test(value)))
      throw new Error('Renamed taskforces/verythinker dependency aliases are unsupported.');
  }
  if (!matches.length) throw new Error('No direct local taskforces or verythinker dependency exists.');
  const dependencySection = matches[0].section;
  if (!['dependencies', 'devDependencies'].includes(dependencySection) ||
      matches.some((entry) => entry.section !== dependencySection))
    throw new Error('Tool dependencies must be unambiguous and in the same dependencies or devDependencies section; optional/peer installs are unsupported.');
  if (pkg.peerDependenciesMeta && names.some((name) => Object.hasOwn(pkg.peerDependenciesMeta, name)))
    throw new Error('Tool peer dependency metadata is unsupported.');
  function hasToolOverride(value) {
    return value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
      names.some((name) => key === name || key.startsWith(`${name}@`)) || hasToolOverride(child));
  }
  if (hasToolOverride(pkg.overrides))
    throw new Error('TaskForces/VeryThinker npm overrides require manual review before package replacement.');
  for (const name of names) {
    const installed = join(root, 'node_modules', name);
    if (!matches.some((entry) => entry.name === name) && existsSync(installed))
      throw new Error(`An undeclared local ${name} package is present; resolve it before upgrading.`);
  }
  const previous = matches.map(({ name }) => inspectPackage(name));
  return { pkg, dependencySection, previous };
}

function inspectPackage(name, expectedVersion) {
  const { root } = configuration;
  const path = localPath(root, directory(join(root, 'node_modules', name)));
  const pkg = json(localPath(path, regular(join(path, 'package.json'))));
  if (pkg.name !== name || typeof pkg.version !== 'string' || !versionPattern.test(pkg.version) ||
      (expectedVersion !== undefined && pkg.version !== expectedVersion))
    throw new Error(`Installed ${name} metadata does not match the expected package identity/version.`);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
  if (typeof bin !== 'string' || !['dist/cli.js', './dist/cli.js'].includes(bin))
    throw new Error(`Installed ${name} does not expose its expected dist/cli.js binary.`);
  const cli = localPath(path, regular(join(path, 'dist', 'cli.js')));
  return { name, version: pkg.version, path, cli };
}

function assertQuiescent() {
  const { root, managed_root: managed, lock_token: token, supervisor_pid: pid } = configuration;
  if (existsSync(join(root, '.taskforces-migration.lock')))
    throw new Error('Storage migration lock is present.');
  const base = join(root, managed);
  const leasePath = join(base, 'operations', 'package-upgrade.lock');
  const lease = json(localPath(base, regular(leasePath)));
  if (lease.token !== token || lease.pid !== pid) throw new Error('Package upgrade lock ownership changed.');
  try { process.kill(pid, 0); }
  catch { throw new Error('Upgrade supervisor is no longer running; manual recovery is required.'); }
  if (['write.lock', '.write.lock'].some((name) => existsSync(join(base, name))))
    throw new Error('A project write lock is present; stop all clients before upgrading.');
  for (const sub of ['operations', 'tools']) {
    const path = join(base, sub);
    if (!existsSync(path)) continue;
    localPath(base, directory(path));
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.name.endsWith('.lock')) continue;
      if (sub === 'operations' && entry.name === 'package-upgrade.lock') continue;
      throw new Error(`A project lock is present at ${sub}/${entry.name}; inspect it and stop active clients.`);
    }
  }
  const receipts = join(base, 'native', 'receipts');
  if (!existsSync(receipts)) return;
  localPath(base, directory(receipts));
  for (const entry of readdirSync(receipts, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    const path = localPath(base, regular(join(receipts, entry.name)));
    let receipt;
    try { receipt = json(path); }
    catch { throw new Error(`Native receipt ${entry.name} is unreadable; active state is indeterminate.`); }
    // Never rewrite signed receipts; only conservatively inspect their persisted state.
    if (!settled.has(receipt?.state))
      throw new Error(`Native receipt ${entry.name} is not settled (state ${String(receipt?.state)}); stop active clients first.`);
  }
}

function resolveNpm() {
  const { root, npm_cli: override } = configuration;
  const candidates = override ? [override] : [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((path) => [
      join(path, 'node_modules/npm/bin/npm-cli.js'),
      join(path, '../lib/node_modules/npm/bin/npm-cli.js'),
      join(path, 'npm'),
    ]),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    if (!/\.[cm]?js$/i.test(path) || !lstatSync(path).isFile()) continue;
    if (inside(join(root, 'node_modules'), path)) {
      if (override) throw new Error('npm_cli must survive removal: place it outside project node_modules.');
      continue;
    }
    return path;
  }
  throw new Error('Cannot resolve a surviving npm JavaScript CLI; use npm_execpath, adjacent Node npm, PATH npm, or npm_cli. Shell wrappers are unsupported.');
}

function npmEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^npm_config_(?:global|location|prefix|workspace|workspaces|include_workspace_root|dry_run|package_lock_only|ignore_scripts|save|save_dev|save_prod|save_optional|save_peer|bin_links|include)$/i.test(key))
      delete env[key];
  return {
    ...env,
    npm_config_global: 'false',
    npm_config_location: 'project',
    npm_config_prefix: configuration.root,
    npm_config_workspaces: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_dry_run: 'false',
    npm_config_package_lock_only: 'false',
    npm_config_bin_links: 'true',
    npm_config_save: 'true',
    npm_config_save_dev: 'false',
    npm_config_save_prod: 'false',
    npm_config_save_optional: 'false',
    npm_config_save_peer: 'false',
    // A production/omit=dev environment must not skip reinstalling a devDependency.
    npm_config_include: 'dev',
  };
}

function runNode(args, label, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: configuration.root,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? `${result.error.code ?? result.error.name}: ${result.error.message}` :
      `exit ${result.status}${result.signal ? `, signal ${result.signal}` : ''}`;
    const diagnostics = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${label} failed (${clean(reason)}). ${clean(diagnostics)}`);
  }
  return result.stdout;
}

function npm(cli, args, label) {
  // Explicit prefix/cwd plus disabled workspaces prevent npm walking into a parent.
  return runNode([cli, ...args, '--prefix', configuration.root, '--global=false', '--workspaces=false',
    '--package-lock=true'], label, npmEnvironment());
}

function backupProject() {
  const { root, managed_root: managed, recovery_path: recovery } = configuration;
  const backups = join(recovery, 'backups');
  mkdirSync(backups, { mode: 0o700 });
  const paths = [
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
    'node_modules/.package-lock.json', `${managed}/install-manifest.json`, `${managed}/config.json`,
  ];
  return paths.map((path, index) => {
    const source = join(root, path);
    if (!existsSync(source)) return { path, backup: null, sha256: null };
    regular(localPath(root, source));
    const backup = join(backups, `${index}-${path.split(/[\\/]/).at(-1)}`);
    copyFileSync(source, backup);
    return { path, backup, sha256: sha(backup) };
  });
}

function assertBackupsUnchanged(backups) {
  for (const entry of backups) {
    const source = join(configuration.root, entry.path);
    if (entry.backup === null) {
      if (existsSync(source)) throw new Error(`Project changed during staging: ${entry.path} appeared.`);
    } else if (!existsSync(source) || sha(regular(localPath(configuration.root, source))) !== entry.sha256) {
      throw new Error(`Project changed during staging: ${entry.path}; nothing has been uninstalled.`);
    }
  }
}

function pack(cli, spec, folder, expectedName, expectedVersion) {
  const destination = join(configuration.recovery_path, folder);
  mkdirSync(destination, { mode: 0o700 });
  const output = npm(cli, ['pack', spec, '--ignore-scripts', '--pack-destination', destination, '--json'], `npm pack (${folder})`);
  let entries;
  try { entries = JSON.parse(output); }
  catch { throw new Error(`npm pack (${folder}) did not return JSON metadata.`); }
  const pkg = Array.isArray(entries) && entries.length === 1 ? entries[0] : null;
  // npm's pack result supplies the packed package identity, not the input spec.
  if (!pkg || pkg.name !== expectedName || typeof pkg.version !== 'string' || !versionPattern.test(pkg.version) ||
      (expectedVersion !== undefined && pkg.version !== expectedVersion))
    throw new Error(`Packed ${folder} identity/version is not ${expectedName}${expectedVersion ? `@${expectedVersion}` : ''}; scoped packages are unsupported.`);
  if (typeof pkg.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/.test(pkg.filename))
    throw new Error(`npm pack (${folder}) returned an unsafe filename.`);
  if (!Array.isArray(pkg.files) || !['package.json', 'dist/cli.js'].every((required) =>
    pkg.files.some((entry) => entry?.path === required)))
    throw new Error(`Packed ${folder} does not contain package.json and dist/cli.js; refusing to uninstall.`);
  const path = localPath(destination, regular(join(destination, pkg.filename)));
  if (pkg.integrity !== undefined) verifyIntegrity(path, pkg.integrity);
  return { name: pkg.name, version: pkg.version, path, sha256: sha(path),
    ...(pkg.integrity === undefined ? {} : { integrity: pkg.integrity }) };
}

function validateInstalledManifest(section, target, durable) {
  const { root } = configuration;
  const pkg = json(localPath(root, regular(join(root, 'package.json'))));
  const spec = pkg[section]?.taskforces;
  if (typeof spec !== 'string') throw new Error('npm did not save taskforces in the original dependency section.');
  if (durable) {
    const path = spec.startsWith('file:') ? spec.slice(5) : '';
    if (!path || isAbsolute(path) || !equalPath(resolve(root, path), durable))
      throw new Error('npm did not save a project-relative file: dependency to the durable archive.');
  } else if (spec !== target.version) {
    throw new Error('npm did not save the exact pinned registry version.');
  }
  for (const key of sections)
    if ((key !== section && Object.hasOwn(pkg[key] ?? {}, 'taskforces')) || Object.hasOwn(pkg[key] ?? {}, 'verythinker'))
      throw new Error('npm left an ambiguous or legacy tool dependency in package.json.');
  inspectPackage('taskforces', target.version);
  // shrinkwrap takes precedence over package-lock; do not inspect the hidden npm cache lock.
  const lockPath = ['npm-shrinkwrap.json', 'package-lock.json'].map((name) => join(root, name))
    .find((path) => existsSync(path));
  if (lockPath) {
    const lock = json(localPath(root, regular(lockPath)));
    const entry = lock.packages?.['node_modules/taskforces'] ?? lock.dependencies?.taskforces;
    if (!entry || ((!durable || lock.packages) && entry.version !== target.version))
      throw new Error('npm lock target does not match the installed taskforces version.');
    if (lock.packages?.['']?.[section]?.taskforces !== undefined &&
        lock.packages[''][section].taskforces !== spec)
      throw new Error('npm lock root dependency does not match package.json.');
    if (durable) {
      const resolved = entry.resolved ?? entry.version;
      if (typeof resolved !== 'string' || !resolved.startsWith('file:') ||
          !equalPath(resolve(root, resolved.slice(5)), durable))
        throw new Error('npm lock target does not reference the durable archive.');
    } else if (entry.resolved !== undefined &&
        (typeof entry.resolved !== 'string' || !/^https?:\/\//i.test(entry.resolved))) {
      throw new Error('npm lock target is not a registry archive.');
    }
    if (entry.integrity !== undefined) verifyIntegrity(target.path, entry.integrity);
    else if (target.integrity !== undefined)
      throw new Error('npm lock target is missing the packed archive integrity.');
  } else if (target.integrity !== undefined) {
    throw new Error('npm did not write a lockfile to verify the packed archive integrity.');
  }
  return spec;
}

function performUpgrade() {
  const { root, recovery_path: recovery } = configuration;
  const { dependencySection, previous } = validateRoot();
  assertQuiescent();
  const cli = resolveNpm();
  checkpoint('backup');
  journal.backups = backupProject();
  checkpoint('stage-target');
  const target = pack(cli, configuration.spec, 'target', 'taskforces');
  journal.target = target;
  const durable = isAbsolute(configuration.spec) ? cacheTarget(target) : undefined;
  const installSpec = durable ?? `taskforces@${target.version}`;
  journal.install_spec = installSpec;
  if (durable) journal.durable_target = durable;
  checkpoint('stage-old');
  journal.previous = [];
  for (const old of previous) {
    // Installed directory packing is useful recovery material, not a promise to
    // reproduce the original registry source, install scripts or lock resolution.
    const archive = pack(cli, old.path, `old-${old.name}`, old.name, old.version);
    journal.previous.push({ name: old.name, version: old.version, archive });
    checkpoint('stage-old');
  }
  assertBackupsUnchanged(journal.backups);
  assertQuiescent();
  const current = validateRoot();
  if (current.dependencySection !== dependencySection ||
      JSON.stringify(current.previous) !== JSON.stringify(previous))
    throw new Error('Installed tool changed during staging; refusing to uninstall.');
  if (sha(localPath(recovery, regular(target.path))) !== target.sha256)
    throw new Error('Staged target changed before uninstall.');
  if (durable && sha(localPath(root, regular(durable))) !== target.sha256)
    throw new Error('Durable target changed before uninstall.');
  checkpoint('uninstall');
  npm(cli, ['uninstall', ...previous.map((pkg) => pkg.name), '--ignore-scripts', '--no-audit', '--no-fund'], 'npm uninstall');
  checkpoint('install');
  if (sha(localPath(recovery, regular(target.path))) !== target.sha256)
    throw new Error('Staged target changed before install.');
  if (durable) {
    localPath(root, directory(dirname(durable)));
    if (sha(localPath(root, regular(durable))) !== target.sha256)
      throw new Error('Durable target changed before install.');
  }
  npm(cli, ['install', installSpec, '--save-exact', dependencySection === 'devDependencies' ? '--save-dev' : '--save-prod',
    '--ignore-scripts', '--no-audit', '--no-fund'], 'npm install');
  checkpoint('verify');
  const dependencySpec = validateInstalledManifest(dependencySection, target, durable);
  const installed = inspectPackage('taskforces', target.version);
  assertQuiescent();
  checkpoint('update');
  const output = runNode([installed.cli, 'update', '--project', root, '--json'], 'new taskforces update', process.env);
  let update;
  try { update = JSON.parse(output); }
  catch { throw new Error('The new CLI update exited successfully but did not return valid JSON.'); }
  if (!update || update.schema_version !== 1 || update.version !== target.version ||
      typeof update.root !== 'string' || !equalPath(resolve(update.root), root) ||
      !['installed', 'updated', 'unchanged', 'warnings'].every((key) =>
        Array.isArray(update[key]) && update[key].every((value) => typeof value === 'string')) ||
      !Array.isArray(update.platforms) || !Array.isArray(update.conflicts) ||
      update.conflicts.some((entry) => !entry ||
        !['path', 'candidate', 'reason'].every((key) => typeof entry[key] === 'string')))
    throw new Error('The new CLI returned an unsupported update report; inspect generated output before retrying.');
  const result = {
    schema_version: 1,
    status: 'upgraded',
    root,
    target: { name: 'taskforces', version: target.version },
    previous: previous.map(({ name, version }) => ({ name, version })),
    dependency_section: dependencySection,
    dependency_spec: dependencySpec,
    recovery_path: recovery,
    staged_target: target.path,
    ...(durable === undefined ? {} : { durable_target: durable }),
    backups: journal.backups.map(({ path, backup }) => ({ path, backup })),
    update,
    conflicts: update.conflicts,
  };
  checkpoint('complete');
  return result;
}

try {
  configuration = validateConfiguration(process.argv[2] ?? '');
  journal = {
    schema_version: 1,
    root: configuration.root,
    phase,
    started_at: new Date().toISOString(),
    // Recovery holds diagnostics/backups, never the saved dependency's archive.
    notes: [
      'Stop all native/MCP/editor clients before upgrading; the upgrade lock is not a universal writer gate.',
      'No automatic rollback. Retain this directory on failure for deliberate manual recovery.',
      'After success this OS recovery directory is diagnostic only and may be deleted.',
      'Registry installs save an exact version and npm checks registry integrity for the pinned fetch.',
      'Local installs save a project-relative file: dependency in the resolved managed package-cache.',
      'That file: dependency is portable only with its archive preserved; never remove a referenced durable cache archive.',
    ],
  };
  checkpoint('preflight');
  const result = performUpgrade();
  atomicJson(configuration.result_path, { ok: true, result });
} catch (error) {
  const failure = { phase, recovery_path: configuration?.recovery_path ?? null, message: clean(error instanceof Error ? error.message : String(error)) };
  if (configuration && journal) {
    journal.error = failure;
    try { atomicJson(join(configuration.recovery_path, 'recovery.json'), journal); }
    catch { /* Retain existing journal if even recovery storage is unavailable. */ }
    try { atomicJson(configuration.result_path, { ok: false, error: failure }); }
    catch { /* Supervisor will report an invalid/missing result with recovery path. */ }
  }
  process.stderr.write(`Package upgrade failed during ${failure.phase}; recovery: ${failure.recovery_path ?? 'not created'}. ${failure.message}\n`);
  process.exitCode = 1;
}
