/** Pinned upstream service installation. No upstream CLI lifecycle hook is run;
 * the shipped standalone custom server is the only executable entry. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const MANAGED_GATEWAY_PIN = Object.freeze({ package: '9router', version: '0.5.116', repository: 'https://github.com/decolua/9router',
  commit: '1339107e624d1ab150c6a0c2c2ee22caa7e9db2f', license: 'MIT',
  integrity: 'sha512-Ny4N80cuLBjGmSpOluIwjd0kOk5IZJX26vYDZ+xZunvcVUIHX1h9/t9yu5rfiy6hlXkE6H0rVizD794P1YKMjw==',
  // Published cli/LICENSE differs from repository-root LICENSE; preserve and
  // qualify the actual shipped notice, not a substituted source notice.
  license_sha256: '7099c6555fcaa069f19c43bdd409cd78b87d4d250069428e0b3406ea2367d26e' });
export class ManagedGatewayError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ManagedGatewayError'; }
}
export const gatewayHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export interface ManagedGatewayArtifact {
  schema_version: 1; id: string; pin: typeof MANAGED_GATEWAY_PIN; directory: string; entry: string;
  lock_sha256: string; tarball_sha512: string; fingerprint: string;
  files: { path: string; sha256?: string; bytes?: number; link?: string }[];
  licenses: { package: string; version: string; license: string | null }[];
}
function fail(code: string, message: string): never { throw new ManagedGatewayError(code, message); }
function isLinked(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function managedGatewayPath(root: string, selected: string): string {
  if (!isAbsolute(root) || isAbsolute(selected) || selected.split(/[\\/]/).some(part => !part || part === '.' || part === '..'))
    fail('GATEWAY_PRIVATE_PATH', 'Select an owned absolute gateway data directory outside your repositories.');
  const base = resolve(root), target = resolve(base, selected), route = relative(base, target);
  if (!route || isAbsolute(route) || route === '..' || route.startsWith('../') || route.startsWith('..\\')) fail('GATEWAY_PRIVATE_PATH', 'Gateway paths must remain in their owned private directory.');
  for (let current = base; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) fail('GATEWAY_REPOSITORY_PATH', 'Gateway accounts and service data must be stored outside Git repositories.');
    if (existsSync(current) && isLinked(current)) fail('GATEWAY_PRIVATE_PATH', 'Gateway storage cannot follow an ancestor directory link.');
    if (current === dirname(current)) break;
  }
  for (let current = target; current !== dirname(base); current = dirname(current)) {
    if (existsSync(current) && isLinked(current)) fail('GATEWAY_PRIVATE_PATH', 'Gateway managed paths cannot follow directory links.');
    if (current === base) break;
  }
  return target;
}
export function initializeManagedGatewayRoot(privateRoot: string): string {
  if (!isAbsolute(privateRoot)) fail('GATEWAY_PRIVATE_PATH', 'Gateway storage requires an absolute private directory.');
  const root = resolve(privateRoot), marker = managedGatewayPath(root, 'owner.json');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const expected = { schema_version: 1, owner: 'workforce-managed-9router', root_sha256: gatewayHash(realpathSync.native(root)) };
  if (existsSync(marker)) {
    if (JSON.stringify(JSON.parse(readFileSync(marker, 'utf8'))) !== JSON.stringify(expected)) fail('GATEWAY_NOT_OWNED', 'This gateway directory belongs to a different installation.');
  } else {
    if (readdirSync(root).length) fail('GATEWAY_NOT_OWNED', 'Choose an empty private directory; existing router accounts are never adopted implicitly.');
    writeFileSync(marker, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
  }
  return root;
}
export function writeManagedGatewayJson(root: string, file: string, value: unknown): void {
  const target = managedGatewayPath(root, file); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const pending = `${target}.${randomUUID()}.tmp`;
  writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(pending, target);
}
export function readManagedGatewayJson(root: string, file: string): any {
  const path = managedGatewayPath(root, file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) fail('GATEWAY_METADATA_CHANGED', 'Gateway installation metadata changed.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function inventory(directory: string): ManagedGatewayArtifact['files'] {
  const output: ManagedGatewayArtifact['files'] = [];
  function visit(folder: string) {
    for (const name of readdirSync(folder).sort()) {
      if (folder === directory && name === 'artifact.json') continue;
      const file = join(folder, name), stat = lstatSync(file), selected = relative(directory, file).replaceAll('\\', '/');
      if (output.length > 50000) fail('GATEWAY_ARTIFACT_INVALID', 'Gateway artifact inventory exceeds its reviewed size.');
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(file), actual = relative(directory, realpathSync.native(file));
        if (isAbsolute(link) || isAbsolute(actual) || actual.startsWith('..')) fail('GATEWAY_ARTIFACT_INVALID', 'Gateway artifact contains an external link.');
        output.push({ path: selected, link });
      } else if (stat.isDirectory()) visit(file);
      else if (stat.isFile() && stat.nlink === 1) output.push({ path: selected, bytes: stat.size, sha256: gatewayHash(readFileSync(file)) });
      else fail('GATEWAY_ARTIFACT_INVALID', 'Gateway artifact contains unsupported filesystem entries.');
    }
  }
  visit(directory); return output;
}
export function verifyManagedGatewayArtifact(privateRoot: string, id: string): ManagedGatewayArtifact {
  initializeManagedGatewayRoot(privateRoot);
  if (!/^9router-0\.5\.116-[a-f0-9-]{36}$/.test(id)) fail('GATEWAY_ARTIFACT_INVALID', 'Select an installed pinned gateway artifact.');
  const artifact = readManagedGatewayJson(privateRoot, `artifacts/${id}/artifact.json`) as ManagedGatewayArtifact;
  const directory = managedGatewayPath(privateRoot, `artifacts/${id}`);
  if (artifact.schema_version !== 1 || artifact.id !== id || JSON.stringify(artifact.pin) !== JSON.stringify(MANAGED_GATEWAY_PIN) ||
      artifact.directory !== directory || artifact.entry !== join(directory, 'node_modules/9router/app/custom-server.js'))
    fail('GATEWAY_ARTIFACT_INVALID', 'Gateway artifact identity does not match the reviewed upstream pin.');
  const files = inventory(directory), { fingerprint, ...body } = artifact;
  if (gatewayHash(JSON.stringify(body)) !== fingerprint || JSON.stringify(files) !== JSON.stringify(artifact.files))
    fail('GATEWAY_ARTIFACT_CHANGED', 'Gateway artifact bytes changed. Reinstall the pinned artifact before using it.');
  return artifact;
}
async function tar(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  const child = spawn(command, args, { shell: false, windowsHide: true, signal, stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  child.stdout.on('data', data => { text += String(data); if (text.length > 8 * 1024 * 1024) child.kill(); });
  return new Promise((accept, reject) => {
    child.once('error', () => reject(new ManagedGatewayError('GATEWAY_EXTRACT_FAILED', 'The pinned gateway requires an available tar extractor.')));
    child.once('exit', code => code === 0 ? accept(text) : reject(new ManagedGatewayError('GATEWAY_EXTRACT_FAILED', 'Pinned gateway extraction failed.')));
  });
}
export async function installManagedGateway(privateRoot: string, options: {
  allowDownload: boolean; nodeCommand: string; npmCli?: string; signal?: AbortSignal; archivePath?: string; tarCommand?: string; fetch?: typeof globalThis.fetch;
}): Promise<ManagedGatewayArtifact> {
  const root = initializeManagedGatewayRoot(privateRoot);
  if (!options.allowDownload && !options.archivePath) fail('GATEWAY_DOWNLOAD_DISABLED', 'Allow the pinned gateway download in WorkForce settings before installing it.');
  const id = `9router-${MANAGED_GATEWAY_PIN.version}-${randomUUID()}`, directory = managedGatewayPath(root, `artifacts/${id}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tarball = join(directory, `9router-${MANAGED_GATEWAY_PIN.version}.tgz`);
  if (options.archivePath) copyFileSync(options.archivePath, tarball);
  else {
    const response = await (options.fetch ?? globalThis.fetch)(`https://registry.npmjs.org/9router/-/9router-${MANAGED_GATEWAY_PIN.version}.tgz`,
      { redirect: 'error', signal: options.signal });
    if (!response.ok || !response.body) fail('GATEWAY_DOWNLOAD_FAILED', 'Pinned gateway download failed.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength;
      if (bytes > 64 * 1024 * 1024) { await reader.cancel(); fail('GATEWAY_INTEGRITY', 'Pinned gateway archive exceeds its reviewed size.'); } chunks.push(item.value); }
    writeFileSync(tarball, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
  }
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  if (integrity !== MANAGED_GATEWAY_PIN.integrity) fail('GATEWAY_INTEGRITY', 'Downloaded gateway bytes do not match the pinned upstream release.');
  const extractor = options.tarCommand ?? (process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe') : 'tar');
  const listing = (await tar(extractor, ['-tzf', tarball], options.signal)).split(/\r?\n/).filter(Boolean);
  if (!listing.length || listing.some(file => !file.startsWith('package/') || /[\\:\u0000-\u001f]/.test(file) || file.split('/').includes('..')))
    fail('GATEWAY_ARTIFACT_INVALID', 'Pinned gateway archive contains an unsafe path.');
  const types = (await tar(extractor, ['-tvzf', tarball], options.signal)).split(/\r?\n/).filter(Boolean);
  if (types.some(line => !['-', 'd'].includes(line[0] ?? ''))) fail('GATEWAY_ARTIFACT_INVALID', 'Pinned gateway archive contains unsupported links or entries.');
  const packageRoot = join(directory, 'node_modules/9router'); mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  await tar(extractor, ['-xzf', tarball, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '-C', packageRoot], options.signal);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const license = readFileSync(join(packageRoot, 'LICENSE'));
  const entry = join(packageRoot, 'app/custom-server.js');
  if (manifest.name !== MANAGED_GATEWAY_PIN.package || manifest.version !== MANAGED_GATEWAY_PIN.version || manifest.license !== 'MIT' ||
      gatewayHash(license) !== MANAGED_GATEWAY_PIN.license_sha256 ||
      !existsSync(entry) || !existsSync(join(packageRoot, 'app/server.js'))) fail('GATEWAY_ARTIFACT_INVALID', 'The pinned package is missing its reviewed standalone entry, lock or license.');
  const unpacked = inventory(directory), licenses = unpacked.filter(file => file.path.endsWith('/package.json')).flatMap(file => {
    try { const value = JSON.parse(readFileSync(join(directory, file.path), 'utf8')); return typeof value.name === 'string' && typeof value.version === 'string'
      ? [{ package: value.name, version: value.version, license: typeof value.license === 'string' ? value.license : null }] : []; } catch { return []; }
  });
  const lock = JSON.stringify({ schema_version: 1, provenance: 'exact-published-tarball-closure', pin: MANAGED_GATEWAY_PIN, tarball_sha512: integrity,
    packages: licenses, files: unpacked });
  writeFileSync(join(directory, 'dependency-lock.json'), lock, { flag: 'wx', mode: 0o600 });
  // The only new entry is our generated closure lock. Reuse the already read
  // archive inventory instead of reopening every shipped file a second time.
  const lockEntry = { path: 'dependency-lock.json', bytes: Buffer.byteLength(lock), sha256: gatewayHash(lock) };
  const position = unpacked.findIndex(file => file.path.split('/')[0]! > lockEntry.path);
  const files = [...unpacked.slice(0, position < 0 ? unpacked.length : position), lockEntry, ...unpacked.slice(position < 0 ? unpacked.length : position)];
  const body = { schema_version: 1 as const, id, pin: MANAGED_GATEWAY_PIN, directory, entry,
    lock_sha256: gatewayHash(lock), tarball_sha512: integrity, files, licenses };
  const artifact = { ...body, fingerprint: gatewayHash(JSON.stringify(body)) };
  writeManagedGatewayJson(root, `artifacts/${id}/artifact.json`, artifact);
  if (!existsSync(managedGatewayPath(root, 'active-artifact.json'))) writeManagedGatewayJson(root, 'active-artifact.json', { id });
  return artifact;
}
