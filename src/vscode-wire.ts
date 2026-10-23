import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const bridgeLimit = 1024 * 1024;
export const bridgeProtocol = 'neomind-vscode-lm-v1';
export interface HostDescriptor { protocol: string; root: string; port: number; token: string; instance: string; pid: number }
export function exactRoot(root: string): string { return realpathSync.native(root); }
function descriptorPath(root: string): string {
  const key = createHash('sha256').update(`${userInfo().username}\0${exactRoot(root)}`).digest('hex');
  return join(tmpdir(), `neomind-vscode-${key}`, 'host.json');
}
function privateDirectory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o077))))
      throw new Error('VS Code bridge descriptor directory is not private.');
  } else mkdirSync(path, { mode: 0o700 });
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`],
      { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    // Existing explicit grants survive icacls /inheritance:r. Reject them rather than expose bearer token.
    // Use the framework ACL API: Get-Acl's Security module can fail to autoload
    // in child hosts with incompatible or duplicate type data.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $acl=[System.IO.Directory]::GetAccessControl($env:NEOMIND_PRIVATE_DIRECTORY); " +
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
      "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }; " +
      "foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { " +
      "if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { exit 1 } }"],
      { env: { ...process.env, NEOMIND_PRIVATE_DIRECTORY: path }, stdio: 'ignore', windowsHide: true, timeout: 10000 });
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
export async function hostRequest(host: HostDescriptor, operation: string, input: unknown, signal?: AbortSignal): Promise<any> {
  const text = bounded(input);
  return new Promise((fulfill, reject) => {
    const req = request({ hostname: '127.0.0.1', port: host.port, path: `/${operation}`, method: 'POST',
      headers: { authorization: `Bearer ${host.token}`, 'x-neomind-host': host.instance,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, signal }, async (res) => {
      try {
        const result = await body(res);
        if (res.statusCode !== 200) throw new Error('VS Code bridge refused request. Re-enable bridge or resolve host blocker.');
        fulfill(result);
      } catch (error) { reject(error); }
    });
    req.setTimeout(15000, () => req.destroy(new Error('VS Code bridge request timed out.')));
    req.on('error', () => reject(new Error('VS Code bridge connection failed or descriptor is stale. Re-enable bridge.')));
    req.end(text);
  });
}
/** Only authentication material lives outside project, never in receipts or logs. */
export async function serveHost(root: string, dispatch: (operation: string, input: any) => Promise<unknown>): Promise<{ instance: string; close(): Promise<void> }> {
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
    const auth = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || req.headers.origin || req.headers['x-neomind-host'] !== instance ||
        auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      req.resume(); res.writeHead(403).end('{}'); return;
    }
    try {
      const input = await body(req);
      const value = await dispatch(req.url!.slice(1), input);
      res.writeHead(200, { 'content-type': 'application/json' }).end(bounded(value));
    } catch {
      // Never echo transport inputs, tokens, provider error messages, or credentials.
      res.writeHead(400).end('{}');
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 15000;
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
