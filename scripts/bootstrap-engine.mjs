// A build/install prerequisite, never a model-request fallback.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, lstatSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
export function bootstrapWindowsGuardian(root = join(repository, 'resources/opencode-bootstrap')) {
  if (process.platform !== 'win32') return undefined;
  const source = join(root, 'windows-guardian.cs'), assembly = join(root, 'windows-guardian.dll'), manifest = join(root, 'windows-guardian.manifest.json');
  if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error('Windows guardian source is not an ordinary reviewed resource.');
  const sourceHash = sha(readFileSync(source));
  try {
    const current = JSON.parse(readFileSync(manifest, 'utf8'));
    if (lstatSync(manifest).isFile() && !lstatSync(manifest).isSymbolicLink() && current.schema_version === 1 && current.assembly === 'windows-guardian.dll' && current.source_sha256 === sourceHash &&
        lstatSync(assembly).isFile() && !lstatSync(assembly).isSymbolicLink() && current.assembly_sha256 === sha(readFileSync(assembly))) return current;
  } catch { /* Setup repairs a missing/incomplete build; request execution never compiles. */ }
  const temporary = join(root, `windows-guardian-${randomUUID()}.dll`);
  try {
    const build = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:WORKFORCE_GUARDIAN_SOURCE)) -OutputAssembly $env:WORKFORCE_GUARDIAN_ASSEMBLY"],
      { env: { ...process.env, WORKFORCE_GUARDIAN_SOURCE: source, WORKFORCE_GUARDIAN_ASSEMBLY: temporary }, encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, maxBuffer: 65536 });
    if (build.error || build.status !== 0) throw new Error(`Windows guardian setup compilation failed: ${build.error?.message ?? build.stderr.trim().slice(-2000)}`);
    const result = { schema_version: 1, assembly: 'windows-guardian.dll', source_sha256: sourceHash, assembly_sha256: sha(readFileSync(temporary)) };
    renameSync(temporary, assembly);
    const metadata = `${manifest}.${randomUUID()}.tmp`;
    try { writeFileSync(metadata, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); renameSync(metadata, manifest); }
    finally { rmSync(metadata, { force: true }); }
    return result;
  } finally { rmSync(temporary, { force: true }); }
}
export function bootstrapEngine(root = join(repository, 'resources/opencode-bootstrap')) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (manifest.dependencies?.['@opencode-ai/plugin'] !== '1.19.4' || lock.packages?.['node_modules/@opencode-ai/plugin']?.version !== '1.19.4')
    throw new Error('OpenCode bootstrap must match the pinned engine.');
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(path => path && existsSync(path));
  if (!npm) throw new Error('Run npm run engine:bootstrap so the npm CLI path is available.');
  const result = spawnSync(process.execPath, [resolve(npm), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(repository, 'artifacts/npm-build-cache')], {
    cwd: root, stdio: 'inherit', env: process.env, shell: false, windowsHide: true, timeout: 300000,
  });
  if (result.error || result.status !== 0) throw new Error(`Locked engine bootstrap installation failed: ${result.error?.message ?? result.status}`);
  if (JSON.parse(readFileSync(join(root, 'node_modules/@opencode-ai/plugin/package.json'), 'utf8')).version !== '1.19.4')
    throw new Error('Installed engine bootstrap version is inconsistent.');
  const guardian = bootstrapWindowsGuardian(root);
  return { version: '1.19.4', root, ...(guardian ? { guardian } : {}) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(bootstrapEngine(), null, 2));
