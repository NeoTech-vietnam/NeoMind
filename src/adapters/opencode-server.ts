import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { ProcessScope } from './worker-scope.js';

/** Low-level transport only. Callers must independently verify configuration and capabilities before dispatch. */
export class OpenCodeServer {
  private constructor(private readonly scope: ProcessScope, private readonly child: ChildProcessWithoutNullStreams,
    private readonly origin: string, private readonly authorization: string) {}

  static async start(options: { scope: ProcessScope; command: string; workspace: string; configHome: string; dataHome: string; cacheHome: string;
    config: Record<string, unknown>; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<OpenCodeServer> {
    if (!path.isAbsolute(options.command)) throw new Error('OpenCode executable must be an absolute path');
    const password = randomBytes(32).toString('hex');
    // Inherited OPENCODE_* variables could point the server at project configuration, agents or another password.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) => !/^OPENCODE_/i.test(key)));
    Object.assign(env, { XDG_CONFIG_HOME: options.configHome, XDG_DATA_HOME: options.dataHome,
      XDG_CACHE_HOME: options.cacheHome, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await options.scope.start({ command: path.resolve(options.command), args: ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], cwd: options.workspace, env });
    } catch (error) {
      if (!await options.scope.stop()) throw new Error(`${error instanceof Error ? error.message : String(error)}; OpenCode worker stop unconfirmed`);
      throw error;
    }
    child.stderr.resume();
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => done(new Error('OpenCode server startup timed out')), options.timeoutMs ?? 30000);
        const done = (error?: Error, value?: string) => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose); child.off('error', onError); error ? reject(error) : resolve(value!); };
        const onClose = () => done(new Error('OpenCode server exited during startup'));
        const onError = (error: Error) => done(error);
        const onData = (chunk: Buffer) => {
          output += chunk.toString();
          const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/i.exec(output);
          if (match) done(undefined, match[1]);
          else if (output.length > 65536) done(new Error('OpenCode server startup output too large'));
        };
        child.stdout.on('data', onData);
        child.once('close', onClose);
        child.once('error', onError);
      });
      child.stdout.resume(); child.stderr.resume(); child.stdin.end();
      const server = new OpenCodeServer(options.scope, child, origin, auth);
      await server.request('GET', '/global/health');
      return server;
    } catch (error) {
      if (!await options.scope.stop()) throw new Error(`${error instanceof Error ? error.message : String(error)}; OpenCode worker stop unconfirmed`);
      throw error;
    }
  }

  async request(method: 'GET' | 'POST', endpoint: string, body?: unknown, timeoutMs = 30000): Promise<unknown> {
    // Only paths on the loopback origin: the Basic credentials must never reach another host.
    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) throw new Error('Invalid OpenCode API path');
    const url = new URL(endpoint, this.origin);
    if (url.origin !== this.origin) throw new Error('Invalid OpenCode API origin');
    const response = await fetch(url, { method, redirect: 'error', headers: { authorization: this.authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`OpenCode API returned HTTP ${response.status}`);
    return response.json();
  }

  async close(): Promise<boolean> { const stopped = await this.scope.stop(); this.child.kill(); return stopped; }
}
