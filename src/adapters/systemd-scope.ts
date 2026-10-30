import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppServerTransport } from './app-server-transport.js';
import { workerEnvironment } from './worker-environment.js';
import { observeMembership, type ProcessLaunch, type ProcessScope, type ScopeIdentity, type WorkerScope } from './worker-scope.js';
export type { ScopeIdentity, WorkerScope } from './worker-scope.js';
const exec = promisify(execFile);

function validIdentity(identity: ScopeIdentity): boolean {
  const uid = process.getuid?.();
  return typeof uid === 'number' && /^neomind-run-[a-f0-9-]+\.scope$/.test(identity.unit) &&
    path.posix.normalize(identity.controlGroup) === identity.controlGroup &&
    identity.controlGroup.startsWith(`/user.slice/user-${uid}.slice/`) && identity.controlGroup.endsWith(`/${identity.unit}`);
}
async function emptyControlGroup(identity: ScopeIdentity): Promise<boolean> {
  try { return /^populated 0$/m.test(await readFile(`/sys/fs/cgroup${identity.controlGroup}/cgroup.events`, 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

/** Linux user-systemd scope; absence of a verified empty scope must be treated as unknown. */
export class SystemdScope implements WorkerScope {
  private constructor(readonly identity: ScopeIdentity, readonly transport: AppServerTransport) {}
  static async start(notification: (method: string, params: unknown) => void,
    serverRequest: (id: string | number, method: string, params: unknown) => void, codexArgs: string[] = []): Promise<SystemdScope> {
    if (process.platform !== 'linux') throw new Error('User systemd scope is only supported on Linux');
    const unit = `neomind-run-${randomUUID()}.scope`;
    const transport = new AppServerTransport('systemd-run', ['--user', '--scope', '--unit', unit, '--quiet', '--', 'codex', ...codexArgs, 'app-server'], notification, serverRequest, workerEnvironment());
    try {
      await transport.initialize();
      const properties = await show(unit), identity = { unit, controlGroup: properties.ControlGroup ?? '' };
      if (properties.ActiveState !== 'active' || !validIdentity(identity)) throw new Error('Systemd scope is not active or its identity is invalid');
      const events = await readFile(`/sys/fs/cgroup${identity.controlGroup}/cgroup.events`, 'utf8');
      if (!/^populated 1$/m.test(events)) throw new Error('Systemd scope has no observed processes');
      return new SystemdScope(identity, transport);
    } catch (error) {
      try { await exec('systemctl', ['--user', 'stop', unit], { timeout: 10000 }); } catch { /* state may still be unknown */ }
      transport.close(); throw error;
    }
  }
  async isActive(): Promise<boolean> {
    try {
      if (!validIdentity(this.identity)) return false;
      const properties = await show(this.identity.unit);
      if (properties.ActiveState !== 'active' || properties.ControlGroup !== this.identity.controlGroup) return false;
      return /^populated 1$/m.test(await readFile(`/sys/fs/cgroup${this.identity.controlGroup}/cgroup.events`, 'utf8'));
    } catch { return false; }
  }
  /** Stop a persisted scope after restart. Never stop a unit with a different identity. */
  static async stopExisting(identity: ScopeIdentity): Promise<boolean> {
    if (!validIdentity(identity)) return false;
    try {
      const before = await show(identity.unit);
      if (before.ActiveState !== 'inactive') {
        if (before.ControlGroup !== identity.controlGroup) return false;
        await exec('systemctl', ['--user', 'stop', identity.unit], { timeout: 30000 });
      }
      const after = await show(identity.unit);
      return after.ActiveState === 'inactive' && await emptyControlGroup(identity);
    } catch { return false; }
  }
  async stop(): Promise<boolean> {
    try { return await SystemdScope.stopExisting(this.identity); }
    finally { this.transport.close(); }
  }
}
/**
 * User-systemd scope for one arbitrary executable. The scope is placed in the user manager's `app.slice`, so its
 * control group is known before launch and can be journaled; the observed control group must match it exactly.
 */
export class SystemdProcessScope implements ProcessScope {
  private started = false;
  private child?: ChildProcessWithoutNullStreams;
  private constructor(readonly identity: ScopeIdentity) {}
  static async allocate(): Promise<SystemdProcessScope> {
    if (process.platform !== 'linux') throw new Error('User systemd scope is only supported on Linux');
    const unit = `neomind-run-${randomUUID()}.scope`;
    const { stdout } = await exec('systemctl', ['--user', 'show', '--property=ControlGroup'], { timeout: 10000 });
    const manager = /^ControlGroup=(\/\S+)$/m.exec(stdout)?.[1];
    const identity = { unit, controlGroup: `${manager}/app.slice/${unit}` };
    if (!manager || !validIdentity(identity)) throw new Error('User systemd manager control group is unknown');
    return new SystemdProcessScope(identity);
  }
  async start(launch: ProcessLaunch): Promise<ChildProcessWithoutNullStreams> {
    if (this.started) throw new Error('Process scope was already started');
    this.started = true;
    if (!path.isAbsolute(launch.command)) throw new Error('Scoped process must be an absolute path');
    const child = spawn('systemd-run', ['--user', '--scope', '--unit', this.identity.unit, '--slice', 'app.slice', '--collect', '--quiet', '--', launch.command, ...launch.args],
      { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    try {
      await observeMembership(child, async () => {
        const properties = await show(this.identity.unit);
        if (properties.ControlGroup && properties.ControlGroup !== this.identity.controlGroup) throw new Error('Systemd scope control group differs from its journaled identity');
        return properties.ActiveState === 'active' && /^populated 1$/m.test(await readFile(`/sys/fs/cgroup${this.identity.controlGroup}/cgroup.events`, 'utf8'));
      });
      return child;
    } catch (error) {
      try { await exec('systemctl', ['--user', 'stop', this.identity.unit], { timeout: 10000 }); } catch { /* state may still be unknown */ }
      child.kill(); throw error;
    }
  }
  async isActive(): Promise<boolean> {
    try {
      const properties = await show(this.identity.unit);
      return properties.ActiveState === 'active' && properties.ControlGroup === this.identity.controlGroup &&
        /^populated 1$/m.test(await readFile(`/sys/fs/cgroup${this.identity.controlGroup}/cgroup.events`, 'utf8'));
    } catch { return false; }
  }
  async stop(): Promise<boolean> {
    const stopped = await SystemdScope.stopExisting(this.identity);
    if (!stopped && this.child && this.child.exitCode === null) this.child.kill();
    return stopped;
  }
}
async function show(unit: string): Promise<Record<string, string>> {
  const { stdout } = await exec('systemctl', ['--user', 'show', unit, '--property=ActiveState,LoadState,ControlGroup'], { timeout: 10000 });
  return Object.fromEntries(stdout.trim().split('\n').map(line => { const position = line.indexOf('='); return [line.slice(0, position), line.slice(position + 1)]; }));
}
