import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { AppServerTransport } from './app-server-transport.js';
import { SystemdProcessScope, SystemdScope } from './systemd-scope.js';
import { WindowsJobScope, WindowsProcessScope, isWindowsJobIdentity } from './windows-job.js';

/** `unit` names the OS container; `controlGroup` is its kernel-level identity (cgroup path or Windows job object). */
export interface ScopeIdentity { unit: string; controlGroup: string }
export interface WorkerScope { identity: ScopeIdentity; transport: Pick<AppServerTransport, 'request'>; isActive(): Promise<boolean>; stop(): Promise<boolean> }
/** An executable to run inside a process scope; `command` must be an absolute path (a native `.exe` on Windows). */
export interface ProcessLaunch { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
/**
 * A worker scope for one arbitrary process. The identity is allocated without starting anything, so the caller can
 * journal it first; `start` may be called once and resolves only after the process is observed inside the scope.
 * All three standard streams are piped and owned by the caller.
 */
export interface ProcessScope {
  identity: ScopeIdentity;
  start(launch: ProcessLaunch): Promise<ChildProcessWithoutNullStreams>;
  isActive(): Promise<boolean>;
  stop(): Promise<boolean>;
}
type Notification = (method: string, params: unknown) => void;
type ServerRequest = (id: string | number, method: string, params: unknown) => void;

/** Journal schema for scope bindings recorded on either platform. */
export const scopeBindingIdentity = {
  unit: z.string().regex(/^neomind-run-[a-f0-9-]+\.(?:scope|job)$/),
  controlGroup: z.string().refine(value => value.startsWith('/user.slice/') || /^windows-job:Global\\neomind-run-[a-f0-9-]+$/.test(value)),
};

export function workerScopeSupported(): boolean { return process.platform === 'linux' || process.platform === 'win32'; }

export function startWorkerScope(notification: Notification, serverRequest: ServerRequest, codexArgs: string[] = []): Promise<WorkerScope> {
  return process.platform === 'win32' ? WindowsJobScope.start(notification, serverRequest, codexArgs) : SystemdScope.start(notification, serverRequest, codexArgs);
}

/** Wait until a freshly launched scope reports a member; fail if the probe throws, the launcher exits or the deadline passes. */
export async function observeMembership(child: ChildProcessWithoutNullStreams, observed: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  let exited = child.exitCode !== null || child.signalCode !== null, failed: Error | undefined;
  const onExit = () => { exited = true; }, onError = (error: Error) => { failed = error; };
  child.once('exit', onExit); child.once('error', onError);
  try {
    for (const deadline = Date.now() + timeoutMs; ;) {
      if (failed) throw new Error(`Scoped process failed to start: ${failed.message}`);
      if (await observed()) return;
      if (exited) throw new Error('Scoped process exited before it was observed in its scope');
      if (Date.now() > deadline) throw new Error('Scoped process was not observed in its scope');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { child.off('exit', onExit); child.off('error', onError); }
}

/** Allocate (but do not start) a process scope; journal `identity` before calling `start`. */
export function allocateProcessScope(): Promise<ProcessScope> {
  return process.platform === 'win32' ? Promise.resolve(WindowsProcessScope.allocate()) : SystemdProcessScope.allocate();
}

/** Stop a persisted scope after restart; an identity from another platform is never confirmed stopped. */
export function stopExistingWorkerScope(identity: ScopeIdentity): Promise<boolean> {
  if (isWindowsJobIdentity(identity)) return process.platform === 'win32' ? WindowsJobScope.stopExisting(identity) : Promise.resolve(false);
  return process.platform === 'linux' ? SystemdScope.stopExisting(identity) : Promise.resolve(false);
}
