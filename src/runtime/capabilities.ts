import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { startWorkerScope, type WorkerScope } from '../adapters/worker-scope.js';
import { windowsProcessInfo } from '../platform/windows-helper.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
let verified: Promise<{ sandboxVerified: true; stopVerified: true }> | undefined;

/** Probe this host using disposable files, before granting writes to a project. */
export function verifyRuntimeCapabilities(): Promise<{ sandboxVerified: true; stopVerified: true }> {
  return verified ??= probe().catch(error => { verified = undefined; throw error; });
}

async function probe(): Promise<{ sandboxVerified: true; stopVerified: true }> {
  const root = await mkdtemp(path.join(homedir(), '.neomind-capability-'));
  const allowed = path.join(root, 'allowed'), outside = path.join(root, 'outside');
  await mkdir(allowed);
  let scope: WorkerScope | undefined;
  try {
    scope = await startWorkerScope(() => {}, () => {});
    const sandboxPolicy = { type: 'workspaceWrite', writableRoots: [allowed], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
    const command = process.platform === 'win32'
      ? [powershell(), '-NoProfile', '-NonInteractive', '-Command', `Set-Content -LiteralPath ${psQuote(path.join(allowed, 'proof'))} -Value ok -NoNewline -ErrorAction Stop; try { Set-Content -LiteralPath ${psQuote(outside)} -Value escape -ErrorAction Stop } catch { exit 0 }; exit 71`]
      : ['/bin/sh', '-c', `printf ok > ${quote(path.join(allowed, 'proof'))}; if printf escape > ${quote(outside)} 2>/dev/null; then exit 71; fi`];
    const result = await scope.transport.request('command/exec', { command, cwd: root, timeoutMs: 10000, sandboxPolicy }, 30000) as { exitCode?: number };
    if (result.exitCode !== 0 || await readFile(path.join(allowed, 'proof'), 'utf8') !== 'ok') throw new Error('Directory sandbox probe failed');
    try { await readFile(outside); throw new Error('Sandbox allowed an out-of-scope write'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (process.platform === 'win32') {
      // Codex may launch sandboxed commands outside the caller's job (e.g. through a separate sandbox account).
      // Require proof that a still-running sandboxed command ends when the job stops.
      await stopsSandboxedCommand(scope, root, allowed, sandboxPolicy);
    } else if (!await scope.stop()) throw new Error('Worker stop capability could not be verified');
    scope = undefined;
    return { sandboxVerified: true, stopVerified: true };
  } finally {
    const stopped = scope ? await scope.stop() : true;
    if (stopped) await rm(root, { recursive: true, force: true });
  }
}

function powershell(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function stopsSandboxedCommand(scope: WorkerScope, root: string, allowed: string, sandboxPolicy: Record<string, unknown>): Promise<void> {
  const pidFile = path.join(allowed, 'sleeper.pid');
  const pending = scope.transport.request('command/exec', { command: [powershell(), '-NoProfile', '-NonInteractive', '-Command',
    `Set-Content -LiteralPath ${psQuote(pidFile)} -Value $PID -NoNewline -ErrorAction Stop; Start-Sleep -Seconds 120`], cwd: root, timeoutMs: 120000, sandboxPolicy }, 130000);
  pending.catch(() => { /* the transport closes when the job stops */ });
  let pid: number | undefined;
  for (const deadline = Date.now() + 20000; Date.now() < deadline && pid === undefined;) {
    try { const text = (await readFile(pidFile, 'utf8')).trim(); if (/^\d+$/.test(text)) pid = Number(text); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (pid === undefined) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (pid === undefined) throw new Error('Sandboxed stop probe did not start');
  const before = windowsProcessInfo(pid);
  if (before?.state !== 'alive' || !before.start) throw new Error('Sandboxed stop probe process is not observable');
  if (!await scope.stop()) throw new Error('Worker stop capability could not be verified');
  const after = windowsProcessInfo(pid);
  if (!after || after.state === 'unknown' || (after.state === 'alive' && after.start === before.start)) throw new Error('A sandboxed command survived the worker job stop');
}
