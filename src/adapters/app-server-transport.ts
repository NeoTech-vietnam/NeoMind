import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export class RpcOutcomeUnknown extends Error {
  constructor(message: string) { super(message); this.name = 'RpcOutcomeUnknown'; }
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Message = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };

/** JSONL transport only; no turn may be dispatched until capability and policy checks pass. */
export class AppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private dead = false;
  constructor(command: string, args: string[], private readonly notification: (method: string, params: unknown) => void,
    private readonly serverRequest: (id: string | number, method: string, params: unknown) => void, env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stderr.resume(); // Never copy runtime stderr or credentials into logs.
    this.lines.on('line', line => this.onLine(line));
    this.child.on('error', () => this.fail('App server failed to start'));
    this.child.on('exit', () => this.fail('App server exited before a response'));
    this.child.stdin.on('error', () => this.fail('App server input closed'));
  }
  private fail(reason: string): void {
    this.dead = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new RpcOutcomeUnknown(reason)); }
    this.pending.clear();
  }
  private onLine(line: string): void {
    if (line.length > 4 * 1024 * 1024) { this.fail('App server message too large'); this.child.kill(); return; }
    let message: Message;
    try { message = JSON.parse(line) as Message; if (!message || typeof message !== 'object') throw new Error(); }
    catch { this.fail('Malformed app server response'); this.child.kill(); return; }
    if (message.method && message.id !== undefined) { this.serverRequest(message.id, message.method, message.params); return; }
    if (message.method) { this.notification(message.method, message.params); return; }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? 'App server request rejected'));
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(new RpcOutcomeUnknown('Malformed app server response'));
  }
  request(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
    if (this.dead) return Promise.reject(new RpcOutcomeUnknown('App server is unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcOutcomeUnknown(`Timed out waiting for ${method}; effect is unknown`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method: string, params?: unknown): void {
    if (this.dead) throw new RpcOutcomeUnknown('App server is unavailable');
    this.child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }
  respond(id: string | number, result: unknown): void {
    if (this.dead) throw new RpcOutcomeUnknown('App server is unavailable');
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }
  async initialize(): Promise<unknown> {
    const result = await this.request('initialize', { clientInfo: { name: 'neomind', title: 'NeoMind', version: '0.1.0' } });
    this.notify('initialized'); return result;
  }
  close(): void { this.fail('App server transport closed'); this.lines.close(); this.child.kill(); }
}
