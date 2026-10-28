// Prepare reviewable local candidates. This script never creates a GitHub release.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildRuntime, fileHash } from './package-runtime.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(parameters) {
  const result = spawnSync(process.execPath, parameters, { cwd: repository, env: process.env, shell: false,
    windowsHide: true, stdio: 'inherit', timeout: 600000 });
  if (result.error || result.status !== 0) throw new Error(`Candidate packaging failed: ${result.error?.message ?? result.status}`);
}
export async function writeReleaseIndex(directory, { requirePlatforms = false } = {}) {
  const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const extension = JSON.parse(readFileSync(join(repository, 'extensions/vscode-model-bridge/package.json'), 'utf8'));
  const assets = [];
  for (const name of readdirSync(directory).sort()) if (/\.(tgz|vsix|json|md)$/.test(name) && name !== 'release-manifest.json')
    assets.push({ name, sha256: await fileHash(join(directory, name)) });
  const required = ['windows-x64', 'linux-x64'].map(target => `workforce-runtime-${pkg.version}-${target}.tgz`);
  const complete = required.every(name => assets.some(asset => asset.name === name));
  if (requirePlatforms && !complete) throw new Error('Both native Windows x64 and Linux x64 runtime assets are required.');
  const manifest = { schema_version: 1, tag: `workforce-v${pkg.version}`, runtime: { package: pkg.name, version: pkg.version },
    extension: { id: `${extension.publisher}.${extension.name}`, version: extension.version }, engine_version: '1.19.4',
    state: 'candidate', published: false, complete_platform_set: complete, assets,
    acceptance: 'Actual installed-client acceptance and a matching validation report are required before publication.',
    limitations: ['Linux package/core tests do not certify Linux VS Code desktop.', 'Portable runtime assets contain their native dependencies; Node remains a prerequisite.'] };
  const manifestPath = join(directory, 'release-manifest.json'); writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = [...assets, { name: 'release-manifest.json', sha256: await fileHash(manifestPath) }];
  writeFileSync(join(directory, 'SHA256SUMS'), checksums.map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n');
  return manifest;
}
async function main() {
  const { values } = parseArgs({ options: { 'out-dir': { type: 'string' }, 'skip-runtime': { type: 'boolean' }, 'require-platforms': { type: 'boolean' } } });
  const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const extension = JSON.parse(readFileSync(join(repository, 'extensions/vscode-model-bridge/package.json'), 'utf8'));
  const directory = resolve(values['out-dir'] ?? join(repository, 'artifacts', `workforce-v${pkg.version}`)); mkdirSync(directory, { recursive: true });
  if (!values['skip-runtime']) await buildRuntime({ outputDirectory: directory });
  run([join(repository, 'scripts/package-extension.mjs'), '--out', join(directory, `workforce-model-bridge-${extension.version}.vsix`)]);
  console.log(JSON.stringify(await writeReleaseIndex(directory, { requirePlatforms: values['require-platforms'] === true }), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
