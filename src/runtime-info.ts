import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/** Hash distributable code and agent guidance, independent of install location. */
export function getRuntimeBuildFingerprint(runtimeRoot: string = packageRoot): string {
  const digest = createHash('sha256');
  const files = ['package.json'];
  const collect = (relative: string, accept: (name: string) => boolean) => {
    const directory = join(runtimeRoot, relative);
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Dependency contents are pinned by the bootstrap lock and distribution
      // integrity inventory. Do not rescan thousands of vendored package files
      // for every CLI process; hash our executable resources and lock instead.
      if (entry.isDirectory() && entry.name === 'node_modules') continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) collect(name, accept);
      else if (entry.isFile() && accept(name)) files.push(name);
    }
  };
  collect('dist', name => name.endsWith('.js'));
  collect('resources', name => /\.(?:md|json|js|mjs|cjs|py)$/.test(name));
  for (const name of files.sort()) {
    digest.update(name).update('\0').update(readFileSync(join(runtimeRoot, name))).update('\0');
  }
  return digest.digest('hex');
}

// Captured when this module is loaded. Replacing files on disk cannot make an
// already running MCP process appear to have loaded the replacement build.
const loadedBuild = Object.freeze({
  package_version: String(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version),
  runtime_root: resolve(packageRoot),
  build_fingerprint: getRuntimeBuildFingerprint(packageRoot),
});

export function createRuntimeInfo(projectRoot: string) {
  return Object.freeze({
    schema_version: 1 as const,
    ...loadedBuild,
    project_root: resolve(projectRoot),
    server_instance_id: randomUUID(),
    started_at: new Date().toISOString(),
  });
}
