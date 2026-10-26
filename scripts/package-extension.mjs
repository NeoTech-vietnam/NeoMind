// Package the extension from source; no prior VSIX, publishing account or root dependency is required.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(repository, 'extensions/vscode-model-bridge');
const runtime = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1])) {
  throw new Error('Usage: node scripts/package-extension.mjs [--out <VSIX path>]');
}
const output = args.length ? resolve(args[1]) : join(repository, 'artifacts',
  `release-v${runtime.version}`, `neomind-agent-monitor-${manifest.version}.vsix`);
if (!output.toLowerCase().endsWith('.vsix')) throw new Error('Extension output must end in .vsix.');
const npmCli = [process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
].find(candidate => candidate && existsSync(candidate));
if (!npmCli) throw new Error('Run npm run extension:package so the npm executable path is available.');
// VSCE honors this variable for sorted entries and stable ZIP timestamps.
// A fixed default makes identical source reproducible without requiring Git history.
const epoch = process.env.SOURCE_DATE_EPOCH ?? '946684800';
if (!/^\d+$/.test(epoch) || !Number.isSafeInteger(Number(epoch)) ||
    Number(epoch) < 315532800 || Number(epoch) > 4354819198) {
  throw new Error('SOURCE_DATE_EPOCH must be integral seconds within the ZIP date range (1980–2107).');
}
if (!readFileSync(join(extension, 'LICENSE.txt')).equals(readFileSync(join(repository, 'LICENSE')))) {
  throw new Error('Extension LICENSE.txt must match the root LICENSE.');
}
mkdirSync(dirname(output), { recursive: true });
// Normalize file modes in an isolated source copy so Windows/Unix permissions do
// not change the archive. Only exact manifest entries can enter this copy.
if (!Array.isArray(manifest.files)) throw new Error('Extension manifest requires an explicit files list.');
const temporaryRoot = resolve(tmpdir());
const staging = mkdtempSync(join(temporaryRoot, 'neomind-vsix-'));
let result;
try {
  for (const name of new Set(['package.json', ...manifest.files])) {
    if (typeof name !== 'string' || /[*?\[\]{}]/.test(name)) throw new Error('Extension files must be exact file paths.');
    const source = resolve(extension, name), child = relative(extension, source);
    if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) ||
        !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
      throw new Error('Extension files must be regular files within its source directory.');
    }
    const target = join(staging, child);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, 0o644);
  }
  result = spawnSync(process.execPath, [resolve(npmCli), 'exec', '--yes', '--no-audit', '--no-fund',
    '--cache', join(repository, 'artifacts/vsce-tool-cache'),
    '--registry=https://registry.npmjs.org', '--package=@vscode/vsce@4.0.0', '--',
    'vsce', 'package', '--no-dependencies', '--out', output,
  ], { cwd: staging, env: { ...process.env, SOURCE_DATE_EPOCH: epoch, TZ: 'UTC' },
    shell: false, windowsHide: true, stdio: 'inherit', timeout: 180_000 });
} finally {
  const child = relative(temporaryRoot, staging);
  if (!isAbsolute(child) && /^neomind-vsix-[^\\/]+$/.test(child)) rmSync(staging, { recursive: true, force: true });
}
if (result.error) throw new Error(`Extension packaging failed: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status ?? 1);
const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
console.log(JSON.stringify({ path: output, extension: `${manifest.publisher}.${manifest.name}`,
  version: manifest.version, packager: '@vscode/vsce@4.0.0', sha256 }, null, 2));
