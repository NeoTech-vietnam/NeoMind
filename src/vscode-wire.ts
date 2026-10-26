import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const bridgeLimit = 1024 * 1024;
export const bridgeProtocol = 'neomind-vscode-lm-v1';
export interface HostDescriptor { protocol: string; root: string; port: number; token: string; instance: string; pid: number }
type HostOperation = 'open' | 'run' | 'poll' | 'result' | 'cancel' | 'controlled-start' | 'controlled-control' | 'controlled-status';
/** Trusted process configuration; never read these budgets from a wire request body. */
export interface BridgeTimeoutOptions {
  connect_timeout_ms?: number;
  operation_timeouts_ms?: Partial<Record<HostOperation, number>>;
  /** Trusted caller optimization only; never read from an RPC request body. */
  prefer_local_dispatch?: boolean;
  /** Best-effort trusted diagnostics after a successful authorized request. */
  on_dispatch?: (transport: 'in-process' | 'http') => void;
}
interface LocalHost { descriptor: HostDescriptor; dispatch(operation: string, input: unknown): Promise<unknown>; options: BridgeTimeoutOptions }
const localHosts = new Map<string, LocalHost>();
function observeDispatch(options: BridgeTimeoutOptions, transport: 'in-process' | 'http'): void {
  const callback = options.on_dispatch;
  if (callback) setImmediate(() => { try { callback(transport); } catch { /* Diagnostic callbacks never alter dispatch. */ } });
}
function bridgeError(code: string, message: string, status?: number): Error {
  return Object.assign(new Error(message), { code, ...(status === undefined ? {} : { status_code: status }) });
}
function requestTimeout(operation: string, phase: 'connection' | 'response'): Error {
  return bridgeError(phase === 'connection' ? 'BRIDGE_CONNECTION_TIMEOUT' : 'BRIDGE_RESPONSE_TIMEOUT', phase === 'connection'
    ? 'VS Code bridge connection timed out; the host may be busy or unavailable.'
    : `VS Code bridge request timed out during ${Object.hasOwn(operationTimeouts, operation) ? operation : 'control operation'}; inspect host load before retrying. No operation was automatically retried.`);
}
function refused(status?: number): Error {
  return bridgeError('BRIDGE_REFUSED', 'VS Code bridge refused request. Re-enable bridge or resolve host blocker.', status);
}
const operationTimeouts: Record<HostOperation, number> = {
  // Selection and signed result validation include bounded filesystem/model-discovery work.
  open: 30000, result: 30000,
  // Durable admission and controls validate current project records and commit
  // their checkpoint before acknowledging. They are not model polling calls.
  'controlled-start': 30000, 'controlled-control': 30000, 'controlled-status': 15000,
  // Model generation runs asynchronously; these operations return control metadata only.
  run: 15000, poll: 15000, cancel: 5000,
};
function checkedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 60000)
    throw new Error('VS Code bridge timeouts must be between 10 and 60000 milliseconds.');
  return value;
}
function operationTimeout(operation: string, options: BridgeTimeoutOptions): number {
  return checkedTimeout(Object.hasOwn(operationTimeouts, operation)
    ? options.operation_timeouts_ms?.[operation as HostOperation] ?? operationTimeouts[operation as HostOperation]
    : 15000);
}
export function exactRoot(root: string): string { return realpathSync.native(root); }
function descriptorPath(root: string): string {
  const key = createHash('sha256').update(`${userInfo().username}\0${exactRoot(root)}`).digest('hex');
  return join(tmpdir(), `neomind-vscode-${key}`, 'host.json');
}
/** Internal diagnostic sidecars share the directory already secured by serveHost; no wire API or bearer material. */
export function hostPrivateDirectory(root: string): string { return join(descriptorPath(root), '..'); }
/** Apply and verify the same owner-only policy for private Bridge subdirectories. Never exposed as a wire operation. */
export function secureHostPrivateDirectory(path: string): void {
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o077))))
    throw new Error('VS Code bridge descriptor directory is not private.');
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`],
      { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    // Existing explicit grants survive icacls /inheritance:r. Reject them rather than expose bearer token.
    // Use the framework ACL API: Get-Acl's Security module can fail to autoload
    // in child hosts with incompatible or duplicate type data.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $acl=[System.IO.Directory]::GetAccessControl($env:NEOMIND_PRIVATE_DIRECTORY); " +
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
      // Token defaults can give fresh objects an Administrators owner and
      // explicit foreign grants. Initialize only an atomically created directory.
      "if ($env:NEOMIND_PRIVATE_CREATED -eq '1') { $acl=New-Object System.Security.AccessControl.DirectorySecurity; " +
      "$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); " +
      "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); " +
      "$acl.AddAccessRule($rule); " +
      "[System.IO.Directory]::SetAccessControl($env:NEOMIND_PRIVATE_DIRECTORY,$acl); " +
      "$acl=[System.IO.Directory]::GetAccessControl($env:NEOMIND_PRIVATE_DIRECTORY) }; " +
      "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }; " +
      "foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { " +
      "if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { exit 1 } }"],
      { env: { ...process.env, NEOMIND_PRIVATE_DIRECTORY: path, NEOMIND_PRIVATE_CREATED: created ? '1' : '0' }, stdio: 'ignore', windowsHide: true, timeout: 10000 });
  } else chmodSync(path, 0o700);
}
async function body(message: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of message) {
    size += chunk.length;
    if (size > bridgeLimit) throw new Error('VS Code bridge payload exceeds limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function bounded(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > bridgeLimit) throw new Error('VS Code bridge payload exceeds limit.');
  return text;
}
export function readHost(root: string): HostDescriptor {
  try {
    const path = descriptorPath(root);
    const stat = lstatSync(path), directory = lstatSync(join(path, '..'));
    if (!stat.isFile() || stat.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o077) ||
          directory.uid !== process.getuid!() || (directory.mode & 0o077)))) throw new Error();
    const descriptor = JSON.parse(readFileSync(path, 'utf8'));
    if (descriptor.protocol !== bridgeProtocol || descriptor.root !== exactRoot(root) ||
        !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(descriptor.token) || !/^[a-f0-9]{64}$/.test(descriptor.instance) ||
        !Number.isInteger(descriptor.pid) || descriptor.pid < 1) throw new Error();
    process.kill(descriptor.pid, 0);
    return descriptor;
  } catch {
    throw new Error('VS Code bridge is disabled or its descriptor is stale. Run NeoMind: Enable Model Bridge in the trusted workspace.');
  }
}
export async function hostRequest(host: HostDescriptor, operation: string, input: unknown, signal?: AbortSignal, options: BridgeTimeoutOptions = {}): Promise<any> {
  const text = bounded(input);
  const connectBudget = checkedTimeout(options.connect_timeout_ms ?? 5000), responseBudget = operationTimeout(operation, options);
  const local = options.prefer_local_dispatch === true && host.pid === process.pid ? localHosts.get(host.root) : undefined;
  if (local && local.descriptor.protocol === host.protocol && local.descriptor.pid === host.pid && local.descriptor.port === host.port &&
      local.descriptor.root === host.root && local.descriptor.instance === host.instance && typeof host.token === 'string' &&
      host.token.length === local.descriptor.token.length && timingSafeEqual(Buffer.from(host.token), Buffer.from(local.descriptor.token))) {
    // The exact registered live capability still enters the same host dispatch.
    // JSON cloning and both configured response ceilings match the wire boundary;
    // no TCP socket or handshake can wait on this very process's blocked loop.
    const budget = Math.min(responseBudget, operationTimeout(operation, local.options));
    return new Promise((fulfill, reject) => {
      let settled = false;
      const deadline = Date.now() + budget;
      const done = (error?: Error, value?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancelled);
        if (error) reject(error); else { fulfill(value); observeDispatch(options, 'in-process'); }
      };
      const cancelled = () => done(bridgeError('BRIDGE_CANCELLED', 'VS Code bridge request cancelled.'));
      const timer = setTimeout(() => done(requestTimeout(operation, 'response')), budget);
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) { cancelled(); return; }
      void Promise.resolve().then(() => {
        if (settled) return undefined;
        if (localHosts.get(host.root) !== local) throw refused();
        return local.dispatch(operation, JSON.parse(text));
      }).then(value => {
        if (settled) return;
        if (localHosts.get(host.root) !== local) { done(refused()); return; }
        if (Date.now() >= deadline) { done(requestTimeout(operation, 'response')); return; }
        try { done(undefined, JSON.parse(bounded(value))); } catch { done(refused()); }
      }, () => done(refused()));
    });
  }
  return new Promise((fulfill, reject) => {
    let settled = false, timeoutPhase: 'connection' | 'response' | undefined;
    let timer: NodeJS.Timeout | undefined;
    const done = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else { fulfill(value); observeDispatch(options, 'http'); }
    };
    const timedOut = () => requestTimeout(operation, timeoutPhase === 'connection' ? 'connection' : 'response');
    // Control IPC can follow synchronous local hashing/review work. A pooled idle
    // socket may expire while that work blocks the event loop; never replay a
    // mutation after ECONNRESET or reuse a possibly expired connection.
    const req = request({ hostname: '127.0.0.1', port: host.port, path: `/${operation}`, method: 'POST', agent: false,
      headers: { authorization: `Bearer ${host.token}`, 'x-neomind-host': host.instance,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, signal }, async (res) => {
      try {
        if (res.statusCode === 408) { res.resume(); timeoutPhase = 'response'; throw timedOut(); }
        const result = await body(res);
        if (res.statusCode !== 200) throw refused(res.statusCode);
        done(undefined, result);
      } catch (error) { done(error instanceof Error ? error : new Error('VS Code bridge returned invalid bounded state.')); }
    });
    timer = setTimeout(() => { timeoutPhase = 'connection'; req.destroy(timedOut()); }, connectBudget);
    req.on('socket', socket => {
      const connected = () => {
        if (settled) return; clearTimeout(timer);
        timer = setTimeout(() => { timeoutPhase = 'response'; req.destroy(timedOut()); }, responseBudget);
      };
      if (socket.connecting) socket.once('connect', connected); else connected();
    });
    req.on('error', () => done(timeoutPhase ? timedOut() : bridgeError(signal?.aborted ? 'BRIDGE_CANCELLED' : 'BRIDGE_CONNECTION_FAILED', signal?.aborted
      ? 'VS Code bridge request cancelled.'
      : 'VS Code bridge connection failed or descriptor is stale. Re-enable bridge.')));
    req.end(text);
  });
}
/** Only authentication material lives outside project, never in receipts or logs. */
export async function serveHost(root: string, dispatch: (operation: string, input: any) => Promise<unknown>, options: BridgeTimeoutOptions = {}): Promise<{ instance: string; close(): Promise<void> }> {
  for (const value of Object.values(options.operation_timeouts_ms ?? {})) checkedTimeout(value);
  root = exactRoot(root);
  const path = descriptorPath(root), directory = join(path, '..');
  secureHostPrivateDirectory(directory);
  if (existsSync(path)) {
    const old = readHostIfLive(root);
    if (old) throw new Error('VS Code bridge already enabled for this workspace. Disable its existing host first.');
    rmSync(path, { force: true });
  }
  const token = randomBytes(32).toString('hex'), instance = randomBytes(32).toString('hex');
  const dispatchResult = async (operation: string, input: unknown) => JSON.parse(bounded(await dispatch(operation, input)));
  const server = createServer(async (req, res) => {
    let responseTimer: NodeJS.Timeout | undefined;
    let expired = false;
    const auth = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || req.headers.origin || req.headers['x-neomind-host'] !== instance ||
        auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      req.resume(); res.writeHead(403).end('{}'); return;
    }
    try {
      const input = await body(req);
      const operation = req.url!.slice(1);
      responseTimer = setTimeout(() => {
        expired = true;
        if (!res.destroyed) res.writeHead(408, { 'content-type': 'application/json' }).end('{"error":"response-timeout"}');
      }, operationTimeout(operation, options));
      const value = await dispatchResult(operation, input);
      if (!expired && !res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(bounded(value));
    } catch {
      // Never echo transport inputs, tokens, provider error messages, or credentials.
      if (!expired && !res.destroyed) res.writeHead(400).end('{}');
    } finally { clearTimeout(responseTimer); }
  });
  // Upload/auth admission is bounded independently of authenticated dispatch.
  // No socket-wide 15s timer may silently reset an otherwise live selection/result request.
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 0;
  server.maxConnections = 64;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('VS Code loopback binding failed.');
  const descriptor: HostDescriptor = { protocol: bridgeProtocol, root, port: address.port, token, instance, pid: process.pid };
  try {
    writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
  } catch (error) { server.close(); throw error; }
  const local: LocalHost = { descriptor, dispatch: dispatchResult, options: { ...options,
    operation_timeouts_ms: { ...options.operation_timeouts_ms } } };
  localHosts.set(root, local);
  return { instance, close: async () => {
    if (localHosts.get(root) === local) localHosts.delete(root);
    try {
      if (readHost(root).instance === instance) rmSync(path);
    } catch { /* Missing or replaced descriptor must not prevent shutdown. */ }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  } };
}
function readHostIfLive(root: string): HostDescriptor | null {
  try { return readHost(root); } catch { return null; }
}
