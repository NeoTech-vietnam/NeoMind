import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { ProcessScope } from './worker-scope.js';

/** Low-level transport only. Callers must independently verify configuration and capabilities before dispatch. */
export class OpenCodeServer {
  private constructor(private readonly scope: ProcessScope, private readonly child: ChildProcessWithoutNullStreams,
    private readonly origin: string, private readonly authorization: string) {}

  static async start(options: { scope: ProcessScope; command: string; workspace: string; configHome: string; dataHome: string; cacheHome: string;
    config: Record<string, unknown>; env?: NodeJS.ProcessEnv; timeoutMs?: number; protocol?: 'v1' | 'v2' }): Promise<OpenCodeServer> {
    if (!path.isAbsolute(options.command)) throw new Error('OpenCode executable must be an absolute path');
    const password = randomBytes(32).toString('hex');
    // Inherited OPENCODE_* variables could point the server at project configuration, agents or another password.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) => !/^OPENCODE_/i.test(key)));
    Object.assign(env, { XDG_CONFIG_HOME: options.configHome, XDG_DATA_HOME: options.dataHome,
      XDG_CACHE_HOME: options.cacheHome, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await options.scope.start({ command: path.resolve(options.command), args: ['serve', ...(options.protocol === 'v2' ? [] : ['--pure']), '--hostname', '127.0.0.1', '--port', '0'], cwd: options.workspace, env });
    } catch (error) {
      if (!await options.scope.stop()) throw new Error(`${error instanceof Error ? error.message : String(error)}; OpenCode worker stop unconfirmed`);
      throw error;
    }
    // Do not expose arbitrary stderr: it may contain credentials or private configuration.
    let startupError = '';
    child.stderr.on('data', (chunk: Buffer) => { if (startupError.length < 65536) startupError += chunk.toString().slice(0, 65536 - startupError.length); });
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => done(new Error('OpenCode server startup timed out')), options.timeoutMs ?? 30000);
        const done = (error?: Error, value?: string) => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose); child.off('error', onError); error ? reject(error) : resolve(value!); };
        const onClose = () => done(new Error(/unrecognized flag:\s*--pure/i.test(startupError)
          ? 'OpenCode server rejected --pure; this OpenCode version is not supported by the NeoMind runner'
          : 'OpenCode server exited during startup'));
        const onError = (error: Error) => done(error);
        const onData = (chunk: Buffer) => {
          output += chunk.toString();
          const match = /(?:opencode )?server listening on (http:\/\/127\.0\.0\.1:\d+)/i.exec(output);
          if (match) done(undefined, match[1]);
          else if (output.length > 65536) done(new Error('OpenCode server startup output too large'));
        };
        child.stdout.on('data', onData);
        child.once('close', onClose);
        child.once('error', onError);
      });
      child.stdout.resume(); child.stderr.resume(); child.stdin.end();
      const server = new OpenCodeServer(options.scope, child, origin, auth);
      const health = await server.request('GET', options.protocol === 'v2' ? '/api/info' : '/global/health');
      if (options.protocol === 'v2') {
        const info = health as { version?: unknown; pid?: unknown };
        if (info?.version !== '2.2.7' || !Number.isSafeInteger(info.pid) || (info.pid as number) <= 0) throw new Error('Unsupported OpenCode V2 server identity');
      }
      return server;
    } catch (error) {
      if (!await options.scope.stop()) throw new Error(`${error instanceof Error ? error.message : String(error)}; OpenCode worker stop unconfirmed`);
      throw error;
    }
  }

  async request(method: 'GET' | 'POST' | 'PATCH', endpoint: string, body?: unknown, timeoutMs = 30000): Promise<unknown> {
    // Only paths on the loopback origin: the Basic credentials must never reach another host.
    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) throw new Error('Invalid OpenCode API path');
    const url = new URL(endpoint, this.origin);
    if (url.origin !== this.origin) throw new Error('Invalid OpenCode API origin');
    // The synchronous OpenCode message endpoint sends headers only after the model finishes. Node's fetch has an
    // independent five-minute headers timeout, even when the requested turn timeout is longer.
    return new Promise((resolve, reject) => {
      const request = httpRequest(url, { method, headers: { authorization: this.authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        signal: AbortSignal.timeout(timeoutMs) }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) { reject(new Error(`OpenCode API returned HTTP ${status}`)); return; }
          if (status === 204) { resolve(undefined); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  /**
   * Follow the server's event stream (`GET /event`, server-sent events). Returns a function that ends the subscription.
   * Observation only: a broken stream is dropped silently and never fails the turn.
   */
  subscribe(onEvent: (event: unknown) => void, endpoint = '/event'): () => void {
    const controller = new AbortController();
    void (async () => {
      if (!endpoint.startsWith('/') || endpoint.startsWith('//') || new URL(endpoint, this.origin).origin !== this.origin) return;
      const response = await fetch(new URL(endpoint, this.origin), { headers: { authorization: this.authorization, accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body) return;
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:')) continue;
          try { onEvent(JSON.parse(line.slice(5).trim()) as unknown); } catch { /* Not JSON: ignore the event. */ }
        }
      }
    })().catch(() => undefined);
    return () => controller.abort();
  }

  async close(): Promise<boolean> { const stopped = await this.scope.stop(); this.child.kill(); return stopped; }
}
