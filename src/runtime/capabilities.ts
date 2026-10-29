import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { SystemdScope } from '../adapters/systemd-scope.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
let verified: Promise<{ sandboxVerified: true; stopVerified: true }> | undefined;

/** Probe this host using disposable files, before granting writes to a project. */
export function verifyRuntimeCapabilities(): Promise<{ sandboxVerified: true; stopVerified: true }> {
  return verified ??= probe().catch(error => { verified = undefined; throw error; });
}

async function probe(): Promise<{ sandboxVerified: true; stopVerified: true }> {
  const root = await mkdtemp(path.join(homedir(), '.neomind-capability-'));
  const allowed = path.join(root, 'allowed'), outside = path.join(root, 'outside');
  await mkdir(allowed);
  let scope: SystemdScope | undefined;
  try {
    scope = await SystemdScope.start(() => {}, () => {});
    const command = `printf ok > ${quote(path.join(allowed, 'proof'))}; if printf escape > ${quote(outside)} 2>/dev/null; then exit 71; fi`;
    const result = await scope.transport.request('command/exec', { command: ['/bin/sh', '-c', command], cwd: root, timeoutMs: 10000,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [allowed], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }) as { exitCode?: number };
    if (result.exitCode !== 0 || await readFile(path.join(allowed, 'proof'), 'utf8') !== 'ok') throw new Error('Directory sandbox probe failed');
    try { await readFile(outside); throw new Error('Sandbox allowed an out-of-scope write'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!await scope.stop()) throw new Error('Worker stop capability could not be verified');
    scope = undefined;
    return { sandboxVerified: true, stopVerified: true };
  } finally {
    const stopped = scope ? await scope.stop() : true;
    if (stopped) await rm(root, { recursive: true, force: true });
  }
}
