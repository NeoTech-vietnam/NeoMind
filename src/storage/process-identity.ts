import { readFileSync } from 'node:fs';
import { windowsProcessInfo } from '../platform/windows-helper.js';

/** `startTicks` is /proc start time on Linux and the process creation FILETIME on Windows; `bootId` identifies the boot. */
export interface ProcessIdentity { pid: number; startTicks: string; bootId: string }
export function currentProcessIdentity(): ProcessIdentity | undefined {
  if (process.platform === 'win32') {
    try {
      const info = windowsProcessInfo(process.pid);
      return info?.state === 'alive' && info.bootId && info.start ? { pid: process.pid, startTicks: info.start, bootId: info.bootId } : undefined;
    } catch { return undefined; }
  }
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const startTicks = processStart(process.pid);
    if (!bootId || !startTicks) return undefined;
    return { pid: process.pid, startTicks, bootId };
  } catch { return undefined; }
}
function processStart(pid: number): string | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), boundary = stat.lastIndexOf(') ');
  if (boundary < 0) throw new Error('Invalid process stat');
  const start = stat.slice(boundary + 2).split(' ')[19];
  return start && /^\d+$/.test(start) ? start : undefined;
}
/** Unknown is never treated as dead; PID reuse and boot changes do not identify the old process as alive. */
export function ownerLiveness(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.startTicks) || !identity.bootId) return 'unknown';
  if (process.platform === 'win32') return windowsLiveness(identity);
  if (process.platform !== 'linux') return 'unknown';
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!bootId) return 'unknown';
    if (bootId !== identity.bootId) return 'dead';
    try { const start = processStart(identity.pid); return !start ? 'unknown' : start === identity.startTicks ? 'alive' : 'dead'; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown';
      try { process.kill(identity.pid, 0); return 'unknown'; }
      catch (probe) { return (probe as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
    }
  } catch { return 'unknown'; }
}
function windowsLiveness(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  try {
    const info = windowsProcessInfo(identity.pid);
    if (!info?.bootId) return 'unknown';
    if (info.bootId !== identity.bootId) return 'dead';
    if (info.state === 'absent') return 'dead';
    if (info.state === 'unknown' || !info.start) return 'unknown';
    // A different creation time is a reused PID; an exited process may still be held open by another handle.
    return info.start !== identity.startTicks || info.state === 'exited' ? 'dead' : 'alive';
  } catch { return 'unknown'; }
}
