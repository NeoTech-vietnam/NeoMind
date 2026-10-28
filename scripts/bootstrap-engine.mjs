// A build/install prerequisite, never a model-request fallback.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  return { version: '1.19.4', root };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(bootstrapEngine(), null, 2));
