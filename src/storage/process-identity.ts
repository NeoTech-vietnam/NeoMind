import { readFileSync } from 'node:fs';

export interface ProcessIdentity { pid: number; startTicks: string; bootId: string }
export function currentProcessIdentity(): ProcessIdentity | undefined {
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
  if (process.platform !== 'linux' || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.startTicks) || !identity.bootId) return 'unknown';
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
