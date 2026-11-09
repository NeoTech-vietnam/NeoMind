// Release-time prerequisite only: ship the exact verified upstream closure so
// installing/enabling the optional gateway never resolves npm dependencies.
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function prepareManagedGateway({ outputDirectory = join(repository, 'resources/managed-gateway'), archivePath,
  modulePath = join(repository, 'dist/managed-gateway-artifact.js'), fetch } = {}) {
  const { MANAGED_GATEWAY_PIN: pin, installManagedGateway } = await import(pathToFileURL(resolve(modulePath)).href);
  const filename = `${pin.package}-${pin.version}.tgz`, output = resolve(outputDirectory), destination = join(output, filename);
  if (existsSync(output) && (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink())) throw new Error('Gateway release resources must be an owned regular directory.');
  mkdirSync(output, { recursive: true });
  const cached = archivePath ?? (existsSync(destination) ? destination : undefined);
  if (cached && (!lstatSync(cached).isFile() || lstatSync(cached).isSymbolicLink())) throw new Error('Gateway release archive must be a regular file.');
  const temporaryRoot = resolve(tmpdir()), temporary = mkdtempSync(join(temporaryRoot, 'workforce-gateway-package-'));
  try {
    const artifact = await installManagedGateway(join(temporary, 'private'), { allowDownload: !cached, archivePath: cached,
      nodeCommand: process.execPath, ...(fetch ? { fetch } : {}) });
    const archive = join(artifact.directory, filename), license = readFileSync(join(artifact.directory, 'node_modules/9router/LICENSE'));
    const manifest = { schema_version: 1, purpose: 'optional-offline-managed-gateway', pin, archive: filename,
      archive_sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), tarball_sha512: artifact.tarball_sha512,
      entry: 'app/custom-server.js', closure_file_count: artifact.files.length, licenses: artifact.licenses,
      license: 'LICENSE.9router.txt', license_sha256: createHash('sha256').update(license).digest('hex'),
      installation: 'installManagedGateway(privateRoot,{allowDownload:false,archivePath})',
      limitations: ['No upstream account credentials are bundled.', 'Archive validation is not provider authentication or model execution.'] };
    for (const [name, bytes] of [[filename, readFileSync(archive)], ['LICENSE.9router.txt', license],
      ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
      ['NOTICE.md', Buffer.from(`# Optional managed 9router gateway\n\nExact published ${pin.package}@${pin.version}, ${pin.license} license.\nSource: ${pin.repository}/tree/${pin.commit}\nIntegrity: ${pin.integrity}\n\nThe published package LICENSE is preserved byte-for-byte in LICENSE.9router.txt. Its standalone dependency closure remains inside the pinned archive with the upstream notices. This is an optional provider gateway; WorkForce native execution uses VS Code Local agents.\n`)]] ) {
      const target = join(output, name);
      if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new Error('Gateway release output cannot replace a link or non-file.');
      const pending = `${target}.${randomUUID()}.partial`;
      writeFileSync(pending, bytes, { flag: 'wx' }); renameSync(pending, target);
    }
    return manifest;
  } finally {
    const owned = relative(temporaryRoot, resolve(temporary));
    if (!isAbsolute(owned) && /^workforce-gateway-package-[^\\/]+$/.test(owned)) rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--archive')) throw new Error('Usage: node scripts/prepare-managed-gateway.mjs [--archive PINNED_TGZ]');
  console.error(JSON.stringify(await prepareManagedGateway(args.length ? { archivePath: resolve(args[1]) } : {})));
}
