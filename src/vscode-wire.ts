import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const bridgeLimit = 1024 * 1024;
export const bridgeProtocol = 'neomind-vscode-lm-v1';
export interface HostDescriptor { protocol: string; root: string; port: number; token: string; instance: string; pid: number }
type HostOperation = 'open' | 'run' | 'poll' | 'result' | 'cancel';
/** Trusted process configuration; never read these budgets from a wire request body. */
export interface BridgeTimeoutOptions {
  connect_timeout_ms?: number;
  operation_timeouts_ms?: Partial<Record<HostOperation, number>>;
}
const operationTimeouts: Record<HostOperation, number> = {
  // Selection and signed result validation include bounded filesystem/model-discovery work.
  open: 30000, result: 30000,
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
function privateDirectory(path: string): void {
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
  return new Promise((fulfill, reject) => {
    let settled = false, timeoutPhase: 'connection' | 'response' | undefined;
    let timer: NodeJS.Timeout | undefined;
    const done = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else fulfill(value);
    };
    const timedOut = () => new Error(timeoutPhase === 'connection'
      ? 'VS Code bridge connection timed out; the host may be busy or unavailable.'
      : `VS Code bridge request timed out during ${Object.hasOwn(operationTimeouts, operation) ? operation : 'control operation'}; inspect host load before retrying. No operation was automatically retried.`);
    const req = request({ hostname: '127.0.0.1', port: host.port, path: `/${operation}`, method: 'POST',
      headers: { authorization: `Bearer ${host.token}`, 'x-neomind-host': host.instance,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, signal }, async (res) => {
      try {
        const result = await body(res);
        if (res.statusCode === 408 && result?.error === 'response-timeout') { timeoutPhase = 'response'; throw timedOut(); }
        if (res.statusCode !== 200) throw new Error('VS Code bridge refused request. Re-enable bridge or resolve host blocker.');
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
    req.on('error', () => done(timeoutPhase ? timedOut() : new Error(signal?.aborted
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
  privateDirectory(directory);
  if (existsSync(path)) {
    const old = readHostIfLive(root);
    if (old) throw new Error('VS Code bridge already enabled for this workspace. Disable its existing host first.');
    rmSync(path, { force: true });
  }
  const token = randomBytes(32).toString('hex'), instance = randomBytes(32).toString('hex');
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
      const value = await dispatch(operation, input);
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
  try {
    writeFileSync(path, JSON.stringify({ protocol: bridgeProtocol, root, port: address.port, token, instance, pid: process.pid }), { mode: 0o600, flag: 'wx' });
  } catch (error) { server.close(); throw error; }
  return { instance, close: async () => {
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
