// Preserve the real prerequisites while keeping npm --json stdout machine-readable.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function runPrepack(root = repository) {
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
    .find(path => path && existsSync(path));
  if (!npm) throw new Error('The npm CLI is required for the WorkForce prepack build.');
  for (const [stage, args] of [
    ['build', [resolve(npm), 'run', 'build']],
    ['engine bootstrap', [join(root, 'scripts/bootstrap-engine.mjs')]],
  ]) {
    const result = spawnSync(process.execPath, args, {
      cwd: root, env: process.env, shell: false, windowsHide: true,
      stdio: ['ignore', 2, 2], timeout: 300000,
    });
    if (result.error || result.status !== 0) {
      const error = new Error(`WorkForce prepack ${stage} failed; no package is ready.`);
      error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
      throw error;
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { runPrepack(); }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
}
