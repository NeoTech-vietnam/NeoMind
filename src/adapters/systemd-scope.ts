import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppServerTransport } from './app-server-transport.js';
const exec = promisify(execFile);
export interface ScopeIdentity { unit: string; controlGroup: string }
export interface WorkerScope { identity: ScopeIdentity; transport: Pick<AppServerTransport, 'request'>; isActive(): Promise<boolean>; stop(): Promise<boolean> }

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
    const env = { ...process.env };
    // A worker must not attach itself to the parent desktop task's tool bridge.
    for (const key of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete env[key];
    const transport = new AppServerTransport('systemd-run', ['--user', '--scope', '--unit', unit, '--quiet', '--', 'codex', ...codexArgs, 'app-server'], notification, serverRequest, env);
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
async function show(unit: string): Promise<Record<string, string>> {
  const { stdout } = await exec('systemctl', ['--user', 'show', unit, '--property=ActiveState,LoadState,ControlGroup'], { timeout: 10000 });
  return Object.fromEntries(stdout.trim().split('\n').map(line => { const position = line.indexOf('='); return [line.slice(0, position), line.slice(position + 1)]; }));
}
