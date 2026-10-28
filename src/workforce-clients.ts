import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { safePath, hash, atomicWrite, readConfig } from './storage.js';
import { createRuntimeInfo } from './runtime-info.js';

const directory = '.workforce/clients';
/** Observation only: client names are self-reported, never an authentication credential. */
export function observeWorkForceClient(root: string, client: { name: string; version: string } | undefined, operation = 'initialized') {
  if (!client || !/^[^\x00-\x1f]{1,256}$/.test(client.name) || !/^[^\x00-\x1f]{1,128}$/.test(client.version)) return;
  const info = createRuntimeInfo(root);
  atomicWrite(safePath(root, `${directory}/${hash(client.name)}.json`), JSON.stringify({ schema_version: 1,
    client_name: client.name, client_version: client.version, operation, observed_at: new Date().toISOString(),
    runtime_version: info.package_version, build_fingerprint: info.build_fingerprint, source: 'observed-mcp-connection' }, null, 2) + '\n');
}
export function workForceClientStatus(root: string) {
  const info = createRuntimeInfo(root), config = readConfig(root), expectedCli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const matches = (entry: any) => {
    try { return Array.isArray(entry?.args) && realpathSync.native(resolve(entry.args[0])) === realpathSync.native(expectedCli) &&
      entry.args[1] === 'mcp' && entry.args[2] === '--project' && realpathSync.native(resolve(entry.args[3])) === realpathSync.native(root); }
    catch { return false; }
  };
  const registrations = config.platforms.filter(client => client === 'copilot' || client === 'codex').map(client => {
    let configured = false;
    try { configured = matches(client === 'copilot'
      ? parseJsonc(readFileSync(safePath(root, '.vscode/mcp.json'), 'utf8'))?.servers?.workforce
      : (parseToml(readFileSync(safePath(root, '.codex/config.toml'), 'utf8')).mcp_servers as any)?.workforce); } catch { /* Missing or invalid config remains visible. */ }
    return { client, configured, state: configured ? 'configured' : 'missing',
      message: configured ? 'Workspace registration points to this exact runtime and project. Actual client discovery is reported separately.'
        : 'Workspace MCP registration is missing, conflicted or points to another runtime/project.' };
  });
  const path = safePath(root, directory);
  const connections = !existsSync(path) ? [] : readdirSync(path).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    try {
      const value = JSON.parse(readFileSync(safePath(root, `${directory}/${name}`), 'utf8'));
      if (value.schema_version !== 1 || value.build_fingerprint !== info.build_fingerprint || value.source !== 'observed-mcp-connection') return [];
      return [{ client_name: String(value.client_name).slice(0, 256), client_version: String(value.client_version).slice(0, 128),
        observed_at: value.observed_at, operation: value.operation, source: value.source }];
    } catch { return []; }
  });
  return { registrations, connections, assurance: 'MCP connection observations and workspace registration; not full client workflow acceptance.' };
}
