import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';

/** Same canonical project/user identity as private OpenCode storage. No bearer
 * material is placed in the project or derived from the caller's TEMP. */
export function stableHostDescriptorPath(root: string): string {
  const physical = realpathSync.native(root);
  const identity = `${userInfo().username}\0${process.platform === 'win32' ? physical.toLowerCase() : physical}`;
  return join(dirname(physical), '.workforce-private', createHash('sha256').update(identity).digest('hex'), 'host', 'host.json');
}
export function legacyHostDescriptorPaths(root: string): string[] {
  const physical = realpathSync.native(root);
  const key = createHash('sha256').update(`${userInfo().username}\0${physical}`).digest('hex');
  const directories = process.platform === 'win32'
    ? [tmpdir(), join(userInfo().homedir, 'AppData', 'Local', 'Temp'), ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Temp')] : [])]
    : [tmpdir(), '/tmp'];
  return [...new Set(directories.flatMap(directory => ['neomind-vscode', 'workforce-vscode'].map(prefix => join(directory, `${prefix}-${key}`, 'host.json'))))];
}
let ownCreation: string | undefined;
/** Fresh OS observation for publication/reclamation/quiescence. Client RPCs
 * use the private descriptor's actual token/instance handshake, not polling a
 * PowerShell process for every model tool or status request. */
export function hostProcessCreation(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  if (pid === process.pid && ownCreation) return ownCreation;
  try {
    let value: string | undefined;
    if (process.platform === 'win32') {
      const output = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`],
        { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^\d+$/.test(output)) value = `win32:${output}`;
    } else if (process.platform === 'linux') {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (/^\d+$/.test(ticks ?? '') && /^[a-f0-9-]{36}$/.test(boot)) value = `linux:${boot}:${ticks}`;
    }
    if (pid === process.pid && value) ownCreation = value;
    return value;
  } catch { return; }
}
export function validHostCreation(value: unknown): value is string {
  return typeof value === 'string' && /^(?:win32:\d+|linux:[a-f0-9-]{36}:\d+)$/.test(value);
}
export function hostOwnerState(value: { pid: number; owner_created_at?: string }, requireCreation: boolean): 'live' | 'stale' | 'unknown' {
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || requireCreation && !validHostCreation(value.owner_created_at) ||
      value.owner_created_at !== undefined && !validHostCreation(value.owner_created_at)) return 'unknown';
  try { process.kill(value.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'unknown'; }
  if (!value.owner_created_at) return 'live'; // Conservative legacy exclusion.
  const actual = hostProcessCreation(value.pid);
  return actual === undefined ? 'unknown' : actual === value.owner_created_at ? 'live' : 'stale';
}
/** Refuse linked, oversized or public POSIX descriptors before reading even
 * their non-secret owner fields. Windows creation uses the existing ACL guard. */
export function readHostAuthority(root: string, path: string): Record<string, any> {
  if (path === stableHostDescriptorPath(root)) {
    for (let current = dirname(path); current !== dirname(realpathSync.native(root)); current = dirname(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' &&
          (info.uid !== process.getuid!() || info.mode & 0o077)) throw new Error('Stable editor authority has a non-private or linked ancestor.');
    }
  }
  const file = lstatSync(path), directory = lstatSync(dirname(path));
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 65536 ||
      !directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' &&
      (file.uid !== process.getuid!() || file.mode & 0o077 || directory.uid !== process.getuid!() || directory.mode & 0o077))
    throw new Error('Editor host authority is not an ordinary private descriptor.');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.root !== realpathSync.native(root) || !Number.isSafeInteger(value.pid) || value.pid < 1)
    throw new Error('Editor host authority identity is indeterminate.');
  return value;
}
/** Stable authority is checked regardless of current execution configuration,
 * including while migrating that configuration. Unknown old arbitrary TEMP
 * locations cannot be discovered; stop those legacy hosts before migration. */
export function assertNoLiveHost(root: string): void {
  const stable = stableHostDescriptorPath(root);
  for (const path of [stable, ...legacyHostDescriptorPaths(root)]) {
    if (!existsSync(path)) continue;
    const value = readHostAuthority(root, path);
    const state = hostOwnerState({ pid: value.pid, owner_created_at: value.owner_created_at }, path === stable);
    if (state !== 'stale') throw new Error(state === 'live'
      ? 'An editor execution owner is active; disable the WorkForce/NeoMind host before changing its runtime.'
      : 'Editor execution owner identity is indeterminate; preserve its authority until it can be reconciled.');
  }
}
