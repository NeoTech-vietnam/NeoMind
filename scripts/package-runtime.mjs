// Build a native portable runtime. Dependency installation happens here, never
// inside a user's first request. Run this on each supported target platform.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapEngine } from './bootstrap-engine.mjs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  return { platform, arch, target: `${platform === 'win32' ? 'windows' : 'linux'}-${arch}`,
    binaryPackage: `opencode-${platform === 'win32' ? 'windows' : 'linux'}-${arch}`,
    binaryName: platform === 'win32' ? 'opencode.exe' : 'opencode' };
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
    const bootstrap = join(root, 'resources/opencode-bootstrap');
    const seed = lstatSync(join(bootstrap, 'seed.cjs'));
    if (!seed.isFile() || seed.isSymbolicLink()) throw new Error('The runtime must ship its reviewed dependency-copy worker.');
    bootstrapEngine(bootstrap);
    // npm can install multiple libc/CPU variants for the same OS. The runtime
    // resolver uses exactly this asset's pinned binary; do not ship unused copies.
    for (const entry of readdirSync(join(root, 'node_modules'))) if (entry.startsWith('opencode-') && !['opencode-ai', target.binaryPackage].includes(entry)) {
      const path = resolve(root, 'node_modules', entry), child = relative(root, path);
      if (isAbsolute(child) || child.startsWith(`..${sep}`) || lstatSync(path).isSymbolicLink()) throw new Error('Unexpected OpenCode dependency path.');
      rmSync(path, { recursive: true, force: true });
    }
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const dependencies = lockedDependencyInventory(root, lock), find = name => dependencies.find(entry => entry.name === name);
    for (const name of ['@opencode-ai/sdk', 'opencode-ai', target.binaryPackage]) {
      if (find(name)?.version !== '1.19.4' || !find(name)?.integrity) throw new Error(`Pinned OpenCode dependency is absent: ${name}`);
    }
    const binary = join(root, 'node_modules', target.binaryPackage, 'bin', target.binaryName);
    if (!lstatSync(binary).isFile() || lstatSync(binary).isSymbolicLink()) throw new Error('The bundled engine must be a regular platform binary.');
    if (process.platform !== 'win32') chmodSync(binary, 0o755);
    if (execute(binary, ['--version'], root).trim() !== '1.19.4') throw new Error('Bundled OpenCode did not report its pinned version.');
    const cliVersion = execute(process.execPath, [join(root, 'dist/cli.js'), '--version'], root).trim();
    if (cliVersion !== pkg.version) throw new Error('Bundled CLI does not match the release version.');
    const info = await import(pathToFileURL(join(root, 'dist/index.js')).href);
    if (typeof info.requestStatus !== 'function' || typeof info.requestSubmit !== 'function') throw new Error('Bundled request facade cannot be loaded.');
    const guardian = (await import(pathToFileURL(join(root, 'dist/opencode-engine.js')).href)).openCodeWindowsGuardian();
    const distribution = { schema_version: 1, package: pkg.name, version: pkg.version, ...target,
      build_fingerprint: info.createRuntimeInfo(root).build_fingerprint,
      source_build_fingerprint: info.getRuntimeBuildFingerprint(repository),
      node: pkg.engines.node, engine: { version: '1.19.4', binary: `node_modules/${target.binaryPackage}/bin/${target.binaryName}`, sha256: await fileHash(binary) },
      ...(guardian ? { windows_guardian: { path: 'resources/opencode-bootstrap/windows-guardian.dll', sha256: guardian.sha256,
        source_sha256: guardian.source_sha256, manifest_sha256: guardian.manifest_sha256 } } : {}),
      dependencies, bootstrap: { path: 'resources/opencode-bootstrap', lock_sha256: await fileHash(join(bootstrap, 'package-lock.json')),
        dependencies: lockedDependencyInventory(bootstrap, JSON.parse(readFileSync(join(bootstrap, 'package-lock.json'), 'utf8'))) },
      limitations: ['Node.js is a prerequisite; no Node executable is bundled.', 'Linux core packaging is not Linux VS Code desktop acceptance.', 'No model inference is run by the packaging check.'] };
    writeFileSync(join(root, 'distribution-manifest.json'), `${JSON.stringify(distribution, null, 2)}\n`);
    const filename = `workforce-runtime-${pkg.version}-${target.target}.tgz`, path = join(output, filename);
    await archiveRuntime(staging, path);
    const result = { path, version: pkg.version, target: target.target, sha256: await fileHash(path), binary_sha256: distribution.engine.sha256 };
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
