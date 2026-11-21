/**
 * langflow backend module for Nimbalyst. Nimbalyst runs it in an Electron utility process, once per open workspace.
 * In a workspace that has `.langflow/config.toml` it starts `langflow web --api-only --port 0 --stdin-watch` there (the
 * server stops when this process closes its stdin or dies), reads the port and token from the server's first stdout line (`LANGFLOW_WEB {"port": N, "token": "…"}`), and proxies the panel's
 * API requests ({method, path, body}) to it. Requests carry `X-Langflow-Channel: panel`, so a gate answered here is
 * recorded as `panel:<user>`.
 *
 * The activate contract (`ctx.services.registerMcpTools`, returned `methods`, `ctx.call` on each call) is the one
 * NeoMind's extension and the built-in Crew extension use; it is not in the public SDK types.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; scope: 'global'; panelOnly?: boolean }
interface ActivateContext {
  services: {
    workspacePath: string;
    log: (level: LogLevel, message: string, data?: unknown) => void;
    registerMcpTools: (tools: ToolDefinition[]) => Promise<{ registered: string[] }>;
  };
}
interface Server { port: number; token: string; child: ChildProcess }
interface Reply { status: number; body: unknown }

const START_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 60000;

/** The langflow command: LANGFLOW_BIN, else the uv tool shim in ~/.local/bin, else `langflow` on PATH. */
function langflowCommand(): string {
  if (process.env.LANGFLOW_BIN) return process.env.LANGFLOW_BIN;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const shim = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'langflow.exe' : 'langflow');
  return existsSync(shim) ? shim : 'langflow';
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null && child.pid !== undefined;

/** Stop the server and everything it started at once (the uv shim runs Python as a child process). */
function killChild(child: ChildProcess): void {
  if (!running(child)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** Close the server's stdin (--stdin-watch makes it shut down), then kill it if it is still there after `graceMs`. */
async function stopChild(child: ChildProcess, graceMs = 3000): Promise<void> {
  if (!running(child)) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.stdin?.end();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, graceMs))]);
  killChild(child);
}

function request(server: Server, method: string, apiPath: string, body: unknown): Promise<Reply> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const headers: Record<string, string | number> = { 'X-Langflow-Token': server.token, 'X-Langflow-Channel': 'panel', Accept: 'application/json' };
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path: apiPath, headers, timeout: REQUEST_TIMEOUT_MS }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text.slice(0, 2000) || `HTTP ${res.statusCode}` }; }
        resolve({ status: res.statusCode ?? 502, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`langflow web did not answer ${method} ${apiPath} within ${REQUEST_TIMEOUT_MS / 1000} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function activate(ctx: ActivateContext) {
  const { workspacePath, log, registerMcpTools } = ctx.services;
  const configured = existsSync(path.join(workspacePath, '.langflow', 'config.toml'));
  let server: Promise<Server> | undefined;
  let stopping = false;
  let generation = 0;

  function start(): Promise<Server> {
    const mine = ++generation;
    const command = langflowCommand();
    log('info', `[langflow] starting ${command} web --api-only --port 0 --stdin-watch --quiet in ${workspacePath}`);
    return new Promise<Server>((resolve, reject) => {
      const child = spawn(command, ['web', '--api-only', '--port', '0', '--stdin-watch', '--quiet'], {
        cwd: workspacePath, windowsHide: true, shell: false,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      });
      let ready = false;
      const stderrTail: string[] = [];
      const fail = (message: string) => { if (ready) return; ready = true; clearTimeout(timer); killChild(child); reject(new Error(message)); };
      const timer = setTimeout(() => fail(`langflow web did not print its LANGFLOW_WEB line within ${START_TIMEOUT_MS / 1000} s. ${stderrTail.join(' | ')}`), START_TIMEOUT_MS);
      readline.createInterface({ input: child.stdout! }).on('line', line => {
        const match = /^LANGFLOW_WEB\s+(\{.*\})\s*$/.exec(line.trim());
        if (ready || !match) { if (line.trim()) log('debug', `[langflow web] ${line}`); return; }
        try {
          const info = JSON.parse(match[1]) as { port?: unknown; token?: unknown };
          if (typeof info.port !== 'number' || typeof info.token !== 'string') throw new Error('port or token missing');
          ready = true; clearTimeout(timer);
          log('info', `[langflow] langflow web ready on 127.0.0.1:${info.port} (pid ${child.pid})`);
          resolve({ port: info.port, token: info.token, child });
        } catch (error) { fail(`bad LANGFLOW_WEB line: ${line} (${error instanceof Error ? error.message : String(error)})`); }
      });
      readline.createInterface({ input: child.stderr! }).on('line', line => {
        if (!line.trim()) return;
        stderrTail.push(line); if (stderrTail.length > 8) stderrTail.shift();
        log(ready ? 'info' : 'warn', `[langflow web] ${line}`);
      });
      child.on('error', error => fail(`cannot start ${command}: ${error.message}`));
      child.on('exit', (code, signal) => {
        fail(`langflow web exited before it was ready (code ${code}, signal ${signal}). ${stderrTail.join(' | ')}`);
        if (!stopping) log('warn', `[langflow] langflow web exited (code ${code}, signal ${signal})`);
        if (generation === mine) server = undefined;
      });
    });
  }

  const ensure = () => server ??= start().catch(error => { server = undefined; throw error; });
  if (configured) ensure().catch(error => log('error', `[langflow] ${error instanceof Error ? error.message : String(error)}`));
  else log('info', `[langflow] ${workspacePath} has no .langflow/config.toml; the langflow panel stays empty here`);

  async function api(params: Record<string, unknown>): Promise<Reply> {
    const method = String(params.method ?? 'GET').toUpperCase();
    const apiPath = String(params.path ?? '');
    if (!configured) return { status: 404, body: { error: `This workspace (${workspacePath}) has no .langflow/config.toml. Run \`langflow init\` here first.` } };
    // PUT/DELETE: memory edit/delete and schedules (phase 2). The query (e.g. /api/file?path=…) may hold a file path
    // with "..": the server checks that path against the project root, so only the route itself is checked here.
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return { status: 400, body: { error: `method ${method} is not allowed` } };
    if (!apiPath.startsWith('/api/') || apiPath.split('?')[0]!.includes('..')) return { status: 400, body: { error: `path ${apiPath} is not an API path` } };
    let current: Server;
    try { current = await ensure(); }
    catch (error) { return { status: 503, body: { error: error instanceof Error ? error.message : String(error) } }; }
    try { return await request(current, method, apiPath, params.body); }
    catch (error) {
      // The server died between calls (crash, killed): start it once more and retry reads only.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        if (server) { const dead = await server.catch(() => undefined); if (dead) killChild(dead.child); }
        server = undefined;
        if (method === 'GET') {
          try { return await request(await ensure(), method, apiPath, params.body); }
          catch (retry) { return { status: 503, body: { error: retry instanceof Error ? retry.message : String(retry) } }; }
        }
      }
      return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  await registerMcpTools([{
    name: 'api', panelOnly: true, scope: 'global',
    description: 'langflow panel: one langflow web API request (panel only; agents cannot answer gates).',
    inputSchema: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, body: {} }, required: ['method', 'path'] },
  }]);

  return {
    methods: {
      api: async (params: unknown, methodCtx: unknown) => {
        const call = methodCtx && typeof methodCtx === 'object' ? (methodCtx as { call?: { caller?: string } }).call : undefined;
        // The host hides panel-only tools from agents; this keeps gate answers human-only if that ever regresses.
        if (call?.caller === 'agent') throw new Error('langflow.api is only available to the langflow panel');
        return api(params && typeof params === 'object' ? params as Record<string, unknown> : {});
      },
    },
    deactivate: async () => {
      stopping = true;
      const current = await server?.catch(() => undefined);
      if (current) { await stopChild(current.child); log('info', '[langflow] stopped langflow web'); }
      server = undefined;
    },
  };
}
