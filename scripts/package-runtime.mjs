// Build a native portable runtime. Dependency installation happens here, never
// inside a user's first request. Run this on each supported target platform.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function assertPackageRuntimeIsolated(runtime) {
  const route = relative(realpathSync.native(repository), realpathSync.native(resolve(runtime)));
  if (!route || !isAbsolute(route) && route !== '..' && !route.startsWith('../') && !route.startsWith('..\\'))
    throw new Error('Use --runtime-archive or extract the runtime outside the source checkout so imports cannot borrow development dependencies.');
  return true;
}
export function packageSmokeWorkspace(temporaryRoot = tmpdir()) {
  const target = realpathSync.native(resolve(temporaryRoot)), route = relative(realpathSync.native(repository), target);
  if (!route || !isAbsolute(route) && route !== '..' && !route.startsWith('../') && !route.startsWith('..\\'))
    throw new Error('Package smoke must run outside the source checkout so it cannot borrow development dependencies.');
  return mkdtempSync(join(target, 'workforce-package-'));
}
export function nativeTarCommand() {
  // Git Bash can put GNU tar first on PATH; it interprets D: as a remote
  // archive host. Windows ships bsdtar with native drive-path support.
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}
export function packedArchive(value) {
  const candidates = Array.isArray(value) ? value : value?.filename ? [value] : Object.values(value ?? {}).flat();
  const files = candidates.filter(item => item && typeof item.filename === 'string');
  if (files.length !== 1 || !/^[^\\/]+\.tgz$/.test(files[0].filename)) throw new Error('npm pack did not identify one package archive.');
  return files[0];
}
export function distributionTarget(platform = process.platform, arch = process.arch) {
  if (arch !== 'x64' || !['win32', 'linux'].includes(platform)) throw new Error('Release runtime assets are built natively for Windows x64 and Linux x64 only.');
  return { platform, arch, target: `${platform === 'win32' ? 'windows' : 'linux'}-${arch}`, execution: 'vscode-native/v1', transport: 'vscode-local' };
}
export function assertNativeOnlyRuntime(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const legacy = name => /^@opencode-ai\//.test(name) || /^opencode(?:-|$)/.test(name);
  const lock = existsSync(join(root, 'package-lock.json')) ? JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) : {};
  const nestedLegacy = Object.keys(lock.packages ?? {}).some(path => path.startsWith('node_modules/') && !path.split('/').includes('..') &&
    /(?:^|\/)node_modules\/(?:@opencode-ai\/|opencode(?:-|\/|$))/.test(path) && existsSync(join(root, path)));
  if (Object.keys(pkg.dependencies ?? {}).some(legacy) || existsSync(join(root, 'resources/opencode-bootstrap')) ||
      existsSync(join(root, 'scripts/bootstrap-engine.mjs')) || existsSync(join(root, 'extensions/vscode-model-bridge/legacy-extension.cjs')) ||
      existsSync(join(root, 'node_modules/@opencode-ai')) ||
      nestedLegacy || (existsSync(join(root, 'node_modules')) && readdirSync(join(root, 'node_modules')).some(legacy)))
    throw new Error('Native distribution must not bundle legacy OpenCode execution dependencies or bootstrap.');
  if (existsSync(join(root, 'resources/managed-gateway')) || existsSync(join(root, 'scripts/prepare-managed-gateway.mjs')) ||
      ['native-rea-provider.cjs', 'managed-gateway-host.cjs', 'managed-gateway-provider.cjs'].some(file => existsSync(join(root, 'extensions/vscode-model-bridge', file))))
    throw new Error('Native-core distribution must not bundle deferred M7 provider activation or the managed gateway archive.');
  return true;
}
export async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
export async function archiveRuntime(staging, output) {
  const temporary = `${output}.${randomUUID()}.partial`;
  const child = spawn(nativeTarCommand(), ['-cf', '-', '-C', staging, 'workforce'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '', timedOut = false;
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  const finished = new Promise((fulfill, reject) => {
    child.once('error', reject); child.once('close', code => code === 0 ? fulfill() : reject(new Error(timedOut ? 'Runtime archiving timed out.' : `Runtime tar failed: ${diagnostic || code}`)));
  });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 900000); timer.unref();
  try {
    await Promise.all([pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(temporary, { flags: 'wx' })), finished]);
    renameSync(temporary, output);
  } catch (error) { child.kill(); rmSync(temporary, { force: true }); throw error; }
  finally { clearTimeout(timer); }
}
export function lockedDependencyInventory(root, lock) {
  return Object.entries(lock.packages ?? {}).filter(([path, entry]) => path.startsWith('node_modules/') && entry.integrity && existsSync(join(root, path, 'package.json')))
    .map(([path, entry]) => {
      const installed = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
      if (installed.version !== entry.version) throw new Error(`Installed dependency version differs from the lock: ${path}`);
      return { path, name: installed.name, version: entry.version, integrity: entry.integrity, license: installed.license ?? null };
    }).sort((a, b) => a.path.localeCompare(b.path));
}
function execute(executable, args, cwd, timeout = 300000) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true,
    env: process.env, timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Runtime packaging command failed: ${result.error?.message ?? result.stderr?.slice(-4000) ?? result.status}`);
  return result.stdout;
}
function npmPath() {
  const path = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(value => value && existsSync(value));
  if (!path) throw new Error('Run npm run runtime:package so the npm CLI path is available.');
  return resolve(path);
}
export async function buildRuntime({ outputDirectory = join(repository, 'artifacts', `workforce-v${JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version}`) } = {}) {
  const target = distributionTarget(), pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  if (pkg.name !== 'workforce') throw new Error('Only a WorkForce package can produce this release asset.');
  const npm = npmPath(), temporaryRoot = join(repository, 'artifacts/runtime-staging');
  mkdirSync(temporaryRoot, { recursive: true });
  const staging = mkdtempSync(join(temporaryRoot, 'workforce-runtime-'));
  const root = join(staging, 'workforce'), output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true }); mkdirSync(root);
  try {
    execute(process.execPath, [npm, 'run', 'build'], repository);
    const cache = join(repository, 'artifacts/npm-build-cache');
    const packed = packedArchive(JSON.parse(execute(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--cache', cache, '--pack-destination', staging], repository)));
    execute(nativeTarCommand(), ['-xzf', join(staging, packed.filename), '-C', root, '--strip-components=1'], repository);
    copyFileSync(join(repository, 'package-lock.json'), join(root, 'package-lock.json'));
    execute(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], root);
    assertNativeOnlyRuntime(root);
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const dependencies = lockedDependencyInventory(root, lock);
    const cliVersion = execute(process.execPath, [join(root, 'dist/cli.js'), '--version'], root).trim();
    if (cliVersion !== pkg.version) throw new Error('Bundled CLI does not match the release version.');
    const info = await import(pathToFileURL(join(root, 'dist/index.js')).href);
    if (typeof info.requestStatus !== 'function' || typeof info.requestSubmit !== 'function') throw new Error('Bundled request facade cannot be loaded.');
    const distribution = { schema_version: 1, package: pkg.name, version: pkg.version, ...target,
      build_fingerprint: info.createRuntimeInfo(root).build_fingerprint,
      source_build_fingerprint: info.getRuntimeBuildFingerprint(repository),
      node: pkg.engines.node, dependencies, edition: 'native-core', deferred_features: ['native-rea-provider', 'managed-gateway'],
      limitations: ['Node.js is a prerequisite; no Node executable is bundled.', 'Linux core packaging is not Linux VS Code desktop acceptance.', 'No model inference is run by the packaging check.'] };
    writeFileSync(join(root, 'distribution-manifest.json'), `${JSON.stringify(distribution, null, 2)}\n`);
    const filename = `workforce-runtime-${pkg.version}-${target.target}.tgz`, path = join(output, filename);
    await archiveRuntime(staging, path);
    const result = { path, version: pkg.version, target: target.target, sha256: await fileHash(path), execution: target.execution,
      edition: 'native-core' };
    writeFileSync(join(output, `${filename}.json`), `${JSON.stringify({ ...result, path: filename, distribution }, null, 2)}\n`);
    return result;
  } finally {
    const child = relative(temporaryRoot, staging);
    if (!isAbsolute(child) && /^workforce-runtime-[^\\/]+$/.test(child)) rmSync(staging, { recursive: true, force: true });
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out-dir')) throw new Error('Usage: node scripts/package-runtime.mjs [--out-dir DIRECTORY]');
  console.log(JSON.stringify(await buildRuntime(args.length ? { outputDirectory: args[1] } : {}), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
