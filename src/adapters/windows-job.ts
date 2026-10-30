import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppServerTransport } from './app-server-transport.js';
import { resolveWindowsCodex, workerEnvironment } from './worker-environment.js';
import { observeMembership, type ProcessLaunch, type ProcessScope, type ScopeIdentity, type WorkerScope } from './worker-scope.js';
import { windowsHelperPath } from '../platform/windows-helper.js';
const exec = promisify(execFile);
const namePattern = /^neomind-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isWindowsJobIdentity(identity: ScopeIdentity): boolean { return identity.controlGroup.startsWith('windows-job:'); }
function jobName(identity: ScopeIdentity): string | undefined {
  const name = identity.unit.endsWith('.job') ? identity.unit.slice(0, -4) : '';
  return namePattern.test(name) && identity.controlGroup === `windows-job:Global\\${name}` ? name : undefined;
}
async function helper(args: string[], timeout: number): Promise<string> {
  return (await exec(windowsHelperPath(), args, { timeout, windowsHide: true })).stdout.trim();
}
/** Job membership survives helper restarts; the job object is destroyed only once every member has exited. */
async function activeProcesses(name: string): Promise<number> {
  const output = await helper(['query', name], 10000);
  if (output === 'absent') return 0;
  const match = /^active (\d+)$/.exec(output);
  if (!match) throw new Error('Unexpected job query output');
  return Number(match[1]);
}
async function stopJob(name: string): Promise<boolean> {
  try { return ['stopped', 'absent'].includes(await helper(['stop', name, '20000'], 30000)); }
  catch { return false; }
}

/**
 * Windows job object with kill-on-close, held by a supervisor that joins the job before starting Codex.
 * Every descendant inherits membership and cannot break away; a stop is confirmed only when the job reports
 * zero active processes or no longer exists. If the supervisor dies, closing its handle terminates the job.
 */
export class WindowsJobScope implements WorkerScope {
  private constructor(readonly identity: ScopeIdentity, readonly transport: AppServerTransport) {}
  static async start(notification: (method: string, params: unknown) => void,
    serverRequest: (id: string | number, method: string, params: unknown) => void, codexArgs: string[] = []): Promise<WindowsJobScope> {
    if (process.platform !== 'win32') throw new Error('Windows job scope is only supported on Windows');
    const name = `neomind-run-${randomUUID()}`, codex = resolveWindowsCodex();
    const transport = new AppServerTransport(windowsHelperPath(), ['run', name, codex.command, ...codex.args, ...codexArgs, 'app-server'], notification, serverRequest, workerEnvironment());
    try {
      await transport.initialize();
      if (await activeProcesses(name) < 1) throw new Error('Windows job has no observed processes');
      return new WindowsJobScope({ unit: `${name}.job`, controlGroup: `windows-job:Global\\${name}` }, transport);
    } catch (error) {
      await stopJob(name);
      transport.close(); throw error;
    }
  }
  async isActive(): Promise<boolean> {
    const name = jobName(this.identity);
    try { return !!name && await activeProcesses(name) > 0; } catch { return false; }
  }
  /** Stop a persisted job after restart. Never acts on a malformed identity. */
  static async stopExisting(identity: ScopeIdentity): Promise<boolean> {
    const name = jobName(identity);
    return name ? stopJob(name) : false;
  }
  async stop(): Promise<boolean> {
    try { return await WindowsJobScope.stopExisting(this.identity); }
    finally { this.transport.close(); }
  }
}

/**
 * Job object for one arbitrary native executable, started through the helper's `run` command. The job name exists
 * before the helper starts, so it can be journaled first; every descendant of the executable is a job member.
 */
export class WindowsProcessScope implements ProcessScope {
  private started = false;
  private child?: ChildProcessWithoutNullStreams;
  private constructor(readonly identity: ScopeIdentity, private readonly name: string) {}
  static allocate(): WindowsProcessScope {
    if (process.platform !== 'win32') throw new Error('Windows job scope is only supported on Windows');
    const name = `neomind-run-${randomUUID()}`;
    return new WindowsProcessScope({ unit: `${name}.job`, controlGroup: `windows-job:Global\\${name}` }, name);
  }
  async start(launch: ProcessLaunch): Promise<ChildProcessWithoutNullStreams> {
    if (this.started) throw new Error('Process scope was already started');
    this.started = true;
    if (!path.isAbsolute(launch.command) || path.extname(launch.command).toLowerCase() !== '.exe') throw new Error('Scoped process must be an absolute .exe path');
    if (await helper(['query', this.name], 10000) !== 'absent') throw new Error('Windows job name is already in use');
    const child = spawn(windowsHelperPath(), ['run', this.name, launch.command, ...launch.args], { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    try {
      await observeMembership(child, async () => await activeProcesses(this.name) > 0);
      return child;
    } catch (error) {
      await stopJob(this.name); child.kill(); throw error;
    }
  }
  async isActive(): Promise<boolean> {
    try { return await activeProcesses(this.name) > 0; } catch { return false; }
  }
  async stop(): Promise<boolean> {
    const stopped = await stopJob(this.name);
    // Terminating the job ends the helper too; kill it only if the job could not be confirmed stopped.
    if (!stopped && this.child && this.child.exitCode === null) this.child.kill();
    return stopped;
  }
}
