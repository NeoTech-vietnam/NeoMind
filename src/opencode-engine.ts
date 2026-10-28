import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statfsSync, rmSync, writeFileSync, unlinkSync, openSync, readSync, closeSync, fstatSync, fsyncSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createOpencodeClient, type Config } from '@opencode-ai/sdk/v2/client';
import { Agent, fetch as fixedFetch } from 'undici';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commandEnvironment } from './command-runner.js';
import { hash } from './storage.js';
import { secureHostPrivateDirectory } from './vscode-wire.js';
import { invocationPolicy, roleModelPolicy, requireRoutingPolicy, type NativeReceipt, type NativeRole, type RoutingPolicy } from './routing.js';
import { openCodeIntegrity, openCodeProtocol, openCodeVersion } from './execution-attestation.js';
import { adapterNodeCommand } from './adapters.js';

export const opencodeRuntimeVersion = openCodeVersion;
export const opencodeProtocol = openCodeProtocol;
export const opencodeRuntimeIntegrity = openCodeIntegrity;
export const opencodeProviderId = 'workforce-router';
export type OpenCodeClient = ReturnType<typeof createOpencodeClient>;
export interface OpenCodeEndpoint { model: string; provider: string; baseURL: string; apiKey?: string }

/** Secrets stay in this process and the explicitly owned engine environment. */
export function openCodeEndpoint(root: string, receipt: NativeReceipt): OpenCodeEndpoint {
  const policy = invocationPolicy(root, receipt), spec = roleModelPolicy(root, receipt.role, policy);
  return endpointForPolicy(root, receipt.role, receipt.requested_model, policy);
}
/** Configuration validation only; does not claim a completed model/tool call. */
export function configuredOpenCodeEndpoint(root: string, role: NativeRole, policy = requireRoutingPolicy(root)): OpenCodeEndpoint {
  const spec = roleModelPolicy(root, role, policy);
  return endpointForPolicy(root, role, spec.models[0]!, policy);
}
function endpointForPolicy(root: string, role: NativeRole, modelId: string, policy: RoutingPolicy): OpenCodeEndpoint {
  const spec = roleModelPolicy(root, role, policy);
  if (!spec.models.includes(modelId)) throw new Error('OpenCode model is outside the bound role policy.');
  if (!policy.language_models_file) throw new Error('OpenCode requires the configured custom-endpoint catalog.');
  const catalogPath = isAbsolute(policy.language_models_file) ? policy.language_models_file : resolve(root, policy.language_models_file);
  let catalog: unknown;
  try {
    const info = lstatSync(catalogPath);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error();
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch { throw new Error('Configured model catalog cannot be read.'); }
  if (!Array.isArray(catalog)) throw new Error('Configured model catalog is invalid.');
  const candidates: OpenCodeEndpoint[] = [];
  for (const group of catalog) {
    if (!group || typeof group !== 'object' || Array.isArray(group) ||
        spec.provider && group.name !== spec.provider && group.vendor !== spec.provider || !Array.isArray(group.models)) continue;
    for (const model of group.models) {
      if (!model || typeof model !== 'object' || model.id !== modelId) continue;
      const baseURL = model.url ?? model.baseURL ?? group.url ?? group.baseURL;
      const apiKey = model.apiKey ?? group.apiKey;
      if (typeof baseURL !== 'string' || apiKey !== undefined && typeof apiKey !== 'string') continue;
      let parsed: URL;
      try { parsed = new URL(baseURL); } catch { continue; }
      if (parsed.username || parsed.password || parsed.search || parsed.hash ||
          !['https:', 'http:'].includes(parsed.protocol) || parsed.protocol === 'http:' &&
          !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) continue;
      candidates.push({ model: modelId, provider: String(group.name ?? group.vendor ?? spec.provider ?? ''),
        baseURL: parsed.toString().replace(/\/$/, ''), ...(apiKey ? { apiKey } : {}) });
    }
  }
  if (candidates.length !== 1) throw new Error('Configured model must resolve to one supported custom endpoint.');
  return candidates[0]!;
}

export function openCodeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  // Provider errors can contain headers, keys and request bodies. Diagnostics
  // record a hash, never stringify the error or an SDK response.
  return `OpenCode execution did not complete (${/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error'}).`;
}

function tokenMatches(observed: unknown, expected: string): boolean {
  if (typeof observed !== 'string') return false;
  const bytes = Buffer.from(observed), wanted = Buffer.from(expected);
  return bytes.length === wanted.length && timingSafeEqual(bytes, wanted);
}

export interface OpenCodeGateway {
  url: string; authorization: string; calls: Set<string>; close(): Promise<void>;
}
/** Each gateway is bound to one invocation; neither headers nor IDs come from a model. */
export async function createOpenCodeGateway(factory: () => McpServer, assertActive: () => void | Promise<void>): Promise<OpenCodeGateway> {
  const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
  const connections = new Set<{ server: McpServer; transport: StreamableHTTPServerTransport }>();
  const calls = new Set<string>();
  let closed = false;
  const http = createServer(async (request, response) => {
    if (closed || request.url !== '/mcp' || request.headers.origin ||
        !tokenMatches(request.headers.authorization, authorization)) { response.writeHead(403); response.end(); return; }
    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
      response.writeHead(405); response.end(); return;
    }
    if (connections.size >= 32) { response.writeHead(503); response.end(); return; }
    try { await assertActive(); } catch { response.writeHead(409); response.end(); return; }
    let server: McpServer;
    try { server = factory(); } catch { response.writeHead(409); response.end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
      maxRequestBodySize: 1024 * 1024 });
    const connection = { server, transport }; connections.add(connection);
    const cleanup = () => { connections.delete(connection); void server.close().catch(() => {}); };
    response.once('close', cleanup);
    try {
      await server.connect(transport);
      // Protocol.connect installs its own message handler. Observe dispatch
      // after connecting without altering the SDK protocol implementation.
      const dispatch = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if ('method' in message && message.method === 'tools/call' && typeof message.params?.name === 'string') calls.add(message.params.name);
        dispatch?.(message, extra);
      };
      await transport.handleRequest(request, response);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  http.maxConnections = 32;
  http.headersTimeout = 10000;
  await new Promise<void>((fulfill, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.off('error', reject); fulfill(); }); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('OpenCode gateway did not bind loopback.');
  return { url: `http://127.0.0.1:${address.port}/mcp`, authorization, calls,
    close: async () => {
      if (closed) return; closed = true;
      await Promise.allSettled([...connections].map(({ server }) => server.close()));
      http.closeAllConnections(); await new Promise<void>(fulfill => http.close(() => fulfill()));
    } };
}

export function openCodeConfiguration(endpoint: OpenCodeEndpoint, gateway: Pick<OpenCodeGateway, 'url' | 'authorization'>,
  tools: readonly string[]): Config {
  const permissions = Object.fromEntries([['*', 'deny'], ...tools.map(name => [`wf_${name}`, 'allow'])]);
  return { autoupdate: false, share: 'disabled', snapshot: false, formatter: false, lsp: false,
    enabled_providers: [opencodeProviderId], model: `${opencodeProviderId}/${endpoint.model}`,
    small_model: `${opencodeProviderId}/${endpoint.model}`,
    provider: { [opencodeProviderId]: { name: 'WorkForce configured endpoint', npm: '@ai-sdk/openai-compatible',
      options: { baseURL: endpoint.baseURL, ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
        timeout: 1800000, headerTimeout: 300000, chunkTimeout: 300000 },
      models: { [endpoint.model]: { name: endpoint.model, tool_call: true, limit: { context: 128000, output: 16384 } } } } },
    permission: permissions,
    agent: { workforce: { mode: 'primary', prompt: 'Do the bounded professional assignment through the provided wf tools. Save substantive results through the report tool.',
      permission: permissions, tools: { '*': false, ...Object.fromEntries(tools.map(name => [`wf_${name}`, true])) } },
      build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true } },
    default_agent: 'workforce',
    mcp: { wf: { type: 'remote', url: gateway.url, oauth: false, headers: { Authorization: gateway.authorization }, timeout: 660000 } } } as Config;
}

let binaryCache: { key: string; value: { path: string; sha256: string } } | undefined;
export function openCodeBinary(): { path: string; sha256: string } {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  if (!['windows', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(process.arch))
    throw new Error('This platform has no packaged WorkForce OpenCode engine.');
  const require = createRequire(import.meta.url), packagePath = require.resolve(`opencode-${platform}-${process.arch}/package.json`);
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  const path = join(dirname(packagePath), 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  if (manifest.version !== opencodeRuntimeVersion || !existsSync(path) || !lstatSync(path).isFile())
    throw new Error('Packaged OpenCode engine does not match the pinned runtime.');
  const info = lstatSync(path), key = JSON.stringify([path, manifest.version, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
  if (binaryCache?.key === key) return { ...binaryCache.value };
  const value = { path, sha256: hash(readFileSync(path)) };
  binaryCache = { key, value }; return { ...value };
}

export interface OpenCodeEngine {
  client: OpenCodeClient; directory: string; instance: string; binary_sha256: string; pid: number;
  supervision: OpenCodeSupervisionRef;
  readonly failure?: { code: string; message: string };
  close(): Promise<void>;
}
export interface OpenCodeProcessIdentity { pid: number; created_at: string; executable_sha256: string }
export interface OpenCodeSupervisionRef {
  schema_version: 1; invocation_id: string; instance: string; spec_sha256: string; spec_hmac: string;
  owner: { pid: number; created_at: string }; engine?: OpenCodeProcessIdentity;
}
const engineStartupStages = ['owner-verified', 'watchdog-spawned', 'watchdog-waiting', 'admitted',
  'guardian-spawned', 'engine-identity-observed', 'server-listening', 'authenticated-ready'] as const;
export interface OpenCodeStartupObservation { stage: typeof engineStartupStages[number]; elapsed_ms: number }
export interface OpenCodeEngineOptions {
  onPrepared?(ref: OpenCodeSupervisionRef): void | Promise<void>;
  /** Bounded owner diagnostic only: no paths, identity, endpoint or credentials. */
  onStartupStage?(observation: OpenCodeStartupObservation): void;
  /** Trusted transport fault seam; not part of a worker or wire payload. */
  wrapControlFetch?(transport: typeof globalThis.fetch): typeof globalThis.fetch;
}
export interface OpenCodeOwnerReconciliation {
  state: 'stopped' | 'still_live' | 'uncertain'; proof_sha256?: string; owner_matches?: boolean;
}
export const openCodeMinimumFreeBytes = 512 * 1024 * 1024;
/** Heavy private engine state shares the project volume, outside the repository. */
export function openCodeStorage(root: string): { path: string; free_bytes: number; required_bytes: number } {
  const physical = realpathSync.native(root), base = dirname(physical);
  const device = statfsSync(base, { bigint: true });
  const free = Number(device.bavail * device.bsize);
  const identity = `${userInfo().username}\0${process.platform === 'win32' ? physical.toLowerCase() : physical}`;
  return { path: join(base, '.workforce-private', hash(identity)), free_bytes: free, required_bytes: openCodeMinimumFreeBytes };
}
/** Fixed diagnostics only; never return raw provider bodies, paths or credentials. */
export function openCodeStorageFailure(text: string): { code: string; message: string } | undefined {
  return /database or disk is full|\bSQLITE_FULL\b|\bENOSPC\b|no space left on device/i.test(text)
    ? { code: 'OPENCODE_STORAGE_UNAVAILABLE', message: 'OPENCODE_STORAGE_UNAVAILABLE: the private engine cannot persist data. Execution stopped; existing products and operation evidence are retained for reconciliation.' } : undefined;
}
/** A no-inference wake condition after an actual storage incident. */
export function probeOpenCodeStorage(root: string): { ready: boolean; free_bytes: number; required_bytes: number } {
  const storage = openCodeStorage(root);
  if (storage.free_bytes < storage.required_bytes) return { ready: false, free_bytes: storage.free_bytes, required_bytes: storage.required_bytes };
  secureHostPrivateDirectory(dirname(storage.path)); secureHostPrivateDirectory(storage.path);
  const path = join(storage.path, `storage-probe-${randomBytes(16).toString('hex')}.db`);
  let database: DatabaseSync | undefined, ready = false;
  try {
    database = new DatabaseSync(path);
    database.exec('PRAGMA synchronous=FULL; CREATE TABLE probe(value TEXT NOT NULL);');
    const value = 'WorkForce-storage-observation'.repeat(128);
    database.prepare('INSERT INTO probe(value) VALUES (?)').run(value);
    ready = database.prepare('SELECT value FROM probe').get()?.value === value;
  } catch { ready = false; }
  finally { database?.close(); try { unlinkSync(path); } catch { /* An exact probe file is harmless diagnostic state if cleanup fails. */ } }
  return { ready, free_bytes: storage.free_bytes, required_bytes: storage.required_bytes };
}
/** Installed, lock-pinned plugin bootstrap. Workers never install packages while executing a request. */
export function openCodeBootstrap(): { path: string; lock_sha256: string } {
  const path = fileURLToPath(new URL('../resources/opencode-bootstrap/', import.meta.url));
  try {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    const lockBytes = readFileSync(join(path, 'package-lock.json'));
    const lock = JSON.parse(lockBytes.toString('utf8'));
    const installed = JSON.parse(readFileSync(join(path, 'node_modules/@opencode-ai/plugin/package.json'), 'utf8'));
    if (manifest.dependencies?.['@opencode-ai/plugin'] !== openCodeVersion ||
        lock.packages?.['node_modules/@opencode-ai/plugin']?.version !== openCodeVersion || installed.version !== openCodeVersion ||
        lstatSync(path).isSymbolicLink() || lstatSync(join(path, 'node_modules')).isSymbolicLink()) throw new Error('pin');
    return { path, lock_sha256: hash(lockBytes) };
  } catch { throw new Error('Pinned WorkForce engine bootstrap is missing or invalid. Complete engine:bootstrap during setup or use the portable GitHub runtime before accepting requests.'); }
}

const engineMac = (key: Buffer, domain: string, bytes: string | Buffer) => createHmac('sha256', key).update(`${domain}\0`).update(bytes).digest('hex');
function enginePrivateFile(path: string, limit: number): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit ||
      process.platform !== 'win32' && (info.uid !== process.getuid!() || info.mode & 0o077)) throw new Error('Invalid private engine supervision file.');
  return readFileSync(path);
}
function engineAtomic(path: string, bytes: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
function processBirth(pid: number, expectedPath?: string): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === 'linux') {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      if (expectedPath && realpathSync.native(`/proc/${pid}/exe`) !== realpathSync.native(expectedPath)) return undefined;
      return `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`;
    }
    if (process.platform === 'win32') {
      const observed = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById([int]$env:WORKFORCE_OBSERVED_PID); " +
        "$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); $p.MainModule.FileName"],
      { env: { ...commandEnvironment(), WORKFORCE_OBSERVED_PID: String(pid) }, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192 });
      if (observed.error || observed.status !== 0) return undefined;
      const [created, executable] = observed.stdout.trim().split(/\r?\n/);
      if (!created || !/^\d+$/.test(created) || expectedPath && realpathSync.native(executable!).toLowerCase() !== realpathSync.native(expectedPath).toLowerCase()) return undefined;
      return `win32:${created}`;
    }
  } catch { /* An unavailable creation identity is uncertainty, never a kill authority. */ }
  return undefined;
}
let currentProcessBirth: string | undefined;
function ownerBirth(pid: number): string | undefined {
  return pid === process.pid ? currentProcessBirth ??= processBirth(process.pid, process.execPath) : processBirth(pid);
}
interface EngineSupervisionSpec {
  schema_version: 1; root: string; invocation_id: string; instance: string; owner: OpenCodeSupervisionRef['owner'];
  binary: { path: string; sha256: string }; directory: string; config_directory: string; env: NodeJS.ProcessEnv; module_sha256: string;
}
function supervisionDirectory(root: string, invocation: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(invocation)) throw new Error('Invalid engine supervision invocation.');
  return join(openCodeStorage(root).path, `opencode-${invocation}`, 'supervision');
}
function engineProof(root: string, ref: OpenCodeSupervisionRef): { path: string; key: Buffer; spec: EngineSupervisionSpec } {
  if (ref?.schema_version !== 1 || !/^[a-f0-9-]{36}$/i.test(ref.invocation_id) || !/^[a-f0-9]{64}$/.test(ref.instance) ||
      !/^[a-f0-9]{64}$/.test(ref.spec_sha256) || !/^[a-f0-9]{64}$/.test(ref.spec_hmac)) throw new Error('Invalid engine supervision reference.');
  const path = supervisionDirectory(root, ref.invocation_id);
  for (const selected of [dirname(dirname(path)), dirname(path), path]) {
    const info = lstatSync(selected);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid!() || info.mode & 0o077)) throw new Error('Invalid private engine supervision directory.');
  }
  const key = enginePrivateFile(join(path, 'key.bin'), 32), bytes = enginePrivateFile(join(path, 'spec.json'), 4 * 1024 * 1024);
  if (key.length !== 32 || hash(bytes) !== ref.spec_sha256 || !tokenMatches(engineMac(key, 'workforce-engine-spec-v1', bytes), ref.spec_hmac)) throw new Error('Engine supervision spec authentication failed.');
  const spec = JSON.parse(bytes.toString('utf8')) as EngineSupervisionSpec;
  if (spec.schema_version !== 1 || spec.root !== realpathSync.native(root) || spec.invocation_id !== ref.invocation_id || spec.instance !== ref.instance ||
      !Number.isSafeInteger(spec.owner?.pid) || spec.owner.pid < 1 || typeof spec.owner.created_at !== 'string' ||
      spec.owner.pid !== ref.owner?.pid || spec.owner.created_at !== ref.owner.created_at || dirname(path) !== spec.directory || spec.config_directory !== join(spec.directory, 'config/opencode'))
    throw new Error('Engine supervision belongs to another owner or invocation.');
  return { path, key, spec };
}
function authenticatedEnginePayload(path: string, key: Buffer, ref: OpenCodeSupervisionRef, name: 'ready' | 'ended'): any | undefined {
  const full = join(path, `${name}.json`); if (!existsSync(full)) return undefined;
  const bytes = enginePrivateFile(full, 65536), envelope = JSON.parse(bytes.toString('utf8')), encoded = JSON.stringify(envelope?.payload);
  if (!encoded || envelope.schema_version !== 1 || !tokenMatches(engineMac(key, `workforce-engine-${name}-v1`, encoded), envelope.hmac) ||
      envelope.payload.root !== realpathSync.native(envelope.payload.root) || envelope.payload.invocation_id !== ref.invocation_id ||
      envelope.payload.instance !== ref.instance || envelope.payload.spec_sha256 !== ref.spec_sha256) throw new Error('Engine supervision proof authentication failed.');
  return envelope.payload;
}
/** No PID disappearance, current PID reuse or health request can prove shutdown. */
export async function reconcileOpenCodeOwner(root: string, ref: OpenCodeSupervisionRef): Promise<OpenCodeOwnerReconciliation> {
  try {
    const { path, key, spec } = engineProof(root, ref), deadline = Date.now() + 4000;
    let ownerMatches: boolean | undefined;
    do {
      const ended = authenticatedEnginePayload(path, key, ref, 'ended');
      if (ended && ended.root === spec.root && (ended.actual_exit_observed === true || ended.engine_never_started === true && ended.engine === null) && ended.process_tree_closed === true &&
          (!ref.engine || ended.engine?.pid === ref.engine.pid && ended.engine?.created_at === ref.engine.created_at && ended.engine?.executable_sha256 === ref.engine.executable_sha256) &&
          (ended.engine === null || Number.isSafeInteger(ended.engine?.pid) && ended.engine.pid > 0 && typeof ended.engine.created_at === 'string' && ended.engine.executable_sha256 === spec.binary.sha256))
        return { state: 'stopped', proof_sha256: hash(enginePrivateFile(join(path, 'ended.json'), 65536)), ...(ownerMatches === undefined ? {} : { owner_matches: ownerMatches }) };
      ownerMatches ??= ownerBirth(spec.owner.pid) === spec.owner.created_at;
      if (ownerMatches) break;
      await new Promise(done => setTimeout(done, 50));
    } while (Date.now() < deadline);
    const ready = authenticatedEnginePayload(path, key, ref, 'ready'), observed = ready?.root === spec.root ? ready.engine : undefined;
    return { state: observed && processBirth(observed.pid, spec.binary.path) === observed.created_at ? 'still_live' : 'uncertain', owner_matches: ownerMatches };
  } catch { return { state: 'uncertain' }; }
}

// The Windows guardian creates the engine suspended, assigns its native handle
// to a kill-on-close Job Object, then resumes it. PID reuse cannot retarget a
// stop; closing the guardian's input or killing the guardian closes that job.
const windowsEngineJob = String.raw`
$ErrorActionPreference='Stop'
$source=@'
using System; using System.Runtime.InteropServices; using System.Text; using System.Threading.Tasks;
public static class WorkForceEngineJob {
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct START { public int cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr bytes,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct FT { public uint low,high; }
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr a,int b,ref EXT c,uint d);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr a,IntPtr b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr a,uint b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr a,int b,out ACCOUNT c,uint d,IntPtr e);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref START start,out PROCESS info);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out FT a,out FT b,out FT c,out FT d);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr a,IntPtr b,IntPtr c,out IntPtr d,uint access,bool inherit,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string a,uint b,uint c,ref SA d,uint e,uint f,IntPtr g);
 static void Need(bool value) { if(!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 public static void Run() {
  string binary=Environment.GetEnvironmentVariable("WORKFORCE_ENGINE_BINARY"), cwd=Environment.GetEnvironmentVariable("WORKFORCE_ENGINE_DIRECTORY"), nonce=Environment.GetEnvironmentVariable("WORKFORCE_ENGINE_CONTROL");
  Environment.SetEnvironmentVariable("WORKFORCE_ENGINE_BINARY",null); Environment.SetEnvironmentVariable("WORKFORCE_ENGINE_DIRECTORY",null); Environment.SetEnvironmentVariable("WORKFORCE_ENGINE_CONTROL",null);
  IntPtr job=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero, input=IntPtr.Zero; PROCESS p=new PROCESS();
  try {
   job=CreateJobObject(IntPtr.Zero,null); Need(job!=IntPtr.Zero); EXT limits=new EXT(); limits.basic.flags=0x2000;
   Need(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))));
   Need(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-11),GetCurrentProcess(),out output,0,true,2));
   Need(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-12),GetCurrentProcess(),out error,0,true,2));
   SA sa=new SA();sa.length=Marshal.SizeOf(typeof(SA));sa.inherit=true; input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Need(input!=new IntPtr(-1));
   START s=new START();s.cb=Marshal.SizeOf(typeof(START));s.flags=0x100;s.input=input;s.output=output;s.error=error;
   Need(CreateProcess(binary,new StringBuilder("\""+binary+"\" serve --hostname=127.0.0.1 --port=0"),IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,cwd,ref s,out p));
   Need(AssignProcessToJobObject(job,p.process)); FT birth,unused1,unused2,unused3; Need(GetProcessTimes(p.process,out birth,out unused1,out unused2,out unused3));
   Console.WriteLine("WORKFORCE_ENGINE_IDENTITY "+nonce+" "+p.pid+" "+(((ulong)birth.high<<32)|birth.low)); Console.Out.Flush();
   Need(ResumeThread(p.thread)!=0xffffffff); CloseHandle(p.thread);p.thread=IntPtr.Zero;
   Task<int> owner=Task.Run(()=>Console.OpenStandardInput().ReadByte());
   while(WaitForSingleObject(p.process,100)==258 && !owner.IsCompleted) {}
   if(owner.IsCompleted) Need(TerminateJobObject(job,130));
   Need(WaitForSingleObject(p.process,5000)==0); uint code; Need(GetExitCodeProcess(p.process,out code));
   Need(TerminateJobObject(job,130)); ACCOUNT accounting; int waited=0;
   do { Need(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));if(accounting.active==0)break;System.Threading.Thread.Sleep(20);waited+=20; } while(waited<5000);
   Need(accounting.active==0); CloseHandle(job);job=IntPtr.Zero;
   Console.WriteLine("WORKFORCE_ENGINE_EXIT "+nonce+" "+code);Console.Out.Flush();
  } finally {
   if(job!=IntPtr.Zero)CloseHandle(job); if(p.process!=IntPtr.Zero){if(WaitForSingleObject(p.process,0)==258)TerminateProcess(p.process,130);CloseHandle(p.process);}if(p.thread!=IntPtr.Zero)CloseHandle(p.thread);
   if(input!=IntPtr.Zero&&input!=new IntPtr(-1))CloseHandle(input);if(output!=IntPtr.Zero)CloseHandle(output);if(error!=IntPtr.Zero)CloseHandle(error);
  }
 }
}
'@
Add-Type -TypeDefinition $source
[WorkForceEngineJob]::Run()
`;

function linuxEngineGroup(group: number): { pid: number; birth: string; state: string }[] | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), result: { pid: number; birth: string; state: string }[] = [];
    for (const name of readdirSync('/proc')) if (/^\d+$/.test(name)) {
      try { const text = readFileSync(`/proc/${name}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === group && Number(fields[3]) === group) result.push({ pid: Number(name), birth: `linux:${boot}:${fields[19]}`, state: fields[0]! });
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(String((error as NodeJS.ErrnoException).code))) return undefined; }
    }
    return result;
  } catch { return undefined; }
}

function cleanupEngineBootstrap(directory: string, configDirectory: string): boolean {
  let cleaned = false;
  try {
    const dependencies = join(configDirectory, 'node_modules');
    if (configDirectory !== join(directory, 'config/opencode') || dirname(dependencies) !== configDirectory) throw new Error('Invalid engine cleanup target.');
    if (existsSync(dependencies) && !lstatSync(dependencies).isSymbolicLink()) rmSync(dependencies, { recursive: true, force: true });
    cleaned = !existsSync(dependencies);
  } catch { /* Session DB and logs are retained even when auxiliary cleanup fails. */ }
  try { engineAtomic(join(directory, 'bootstrap-cleanup.json'), JSON.stringify({ schema_version: 1, cleaned, retained_session_state: true })); } catch { /* Storage diagnostic remains separate. */ }
  return cleaned;
}

/** Internal executable entry point: a trusted Node process owns a single engine.
 * Never registered as an MCP/model tool and never accepts model-provided IDs. */
export async function runOpenCodeOwnerSupervisor(root: string, ref: OpenCodeSupervisionRef): Promise<void> {
  if (typeof process.send !== 'function') throw new Error('Engine supervisor requires its owner IPC channel.');
  let stop = !process.connected, child: ChildProcess | undefined, observed: OpenCodeProcessIdentity | undefined;
  let actualExit = false, treeClosed = false, neverStarted = false, output = '', started = false, admitted = false;
  let admissionReady: (() => void) | undefined;
  const knownGroup = new Map<number, string>();
  const proof = engineProof(root, ref), { spec, path, key } = proof;
  if (hash(readFileSync(fileURLToPath(import.meta.url))) !== spec.module_sha256 || hash(readFileSync(spec.binary.path)) !== spec.binary.sha256)
    throw new Error('Pinned engine supervisor executable changed before launch.');
  const requestStop = () => {
    stop = true; admissionReady?.();
    if (!child) return;
    if (process.platform === 'win32') child.stdin?.end();
    else if (observed) {
      const group = linuxEngineGroup(observed.pid);
      if (processBirth(observed.pid, spec.binary.path) === observed.created_at || group?.some(member => knownGroup.get(member.pid) === member.birth))
        try { process.kill(-observed.pid, 'SIGKILL'); } catch { /* An absent process is not a completed proof. */ }
    }
  };
  process.on('disconnect', requestStop);
  process.on('message', message => {
    const value = message as { type?: string; instance?: string };
    if (value?.instance !== ref.instance) return;
    if (value.type === 'stop') requestStop();
    if (value.type === 'admit') { admitted = true; admissionReady?.(); }
  });
  const publish = (name: 'ready' | 'ended', body: Record<string, unknown>) => {
    const payload = { root: spec.root, invocation_id: ref.invocation_id, instance: ref.instance, spec_sha256: ref.spec_sha256, ...body };
    const encoded = JSON.stringify(payload); engineAtomic(join(path, `${name}.json`), JSON.stringify({ schema_version: 1, payload, hmac: engineMac(key, `workforce-engine-${name}-v1`, encoded) }));
  };
  const send = (message: Record<string, unknown>) => { if (process.connected) process.send!({ ...message, instance: ref.instance }, () => {}); };
  const finish = () => {
    cleanupEngineBootstrap(spec.directory, spec.config_directory);
    if ((actualExit || neverStarted) && treeClosed) publish('ended', { engine: observed ?? null, actual_exit_observed: actualExit, engine_never_started: neverStarted, process_tree_closed: true,
      reason: stop ? 'owner-stopped' : 'engine-exited', at: new Date().toISOString() });
    send({ type: 'ended' }); if (process.connected) process.disconnect!();
  };
  send({ type: 'waiting' });
  await new Promise<void>(done => { admissionReady = done; if (stop || admitted) done(); });
  if (stop || !admitted) { neverStarted = true; treeClosed = true; finish(); return; }
  const nonce = randomBytes(32).toString('hex');
  if (process.platform === 'win32') {
    child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', windowsEngineJob], {
      cwd: spec.directory, windowsHide: true, shell: false, env: { ...spec.env, WORKFORCE_ENGINE_BINARY: spec.binary.path, WORKFORCE_ENGINE_DIRECTORY: spec.directory, WORKFORCE_ENGINE_CONTROL: nonce }, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    child = spawn(spec.binary.path, ['serve', '--hostname=127.0.0.1', '--port=0'], { cwd: spec.directory, windowsHide: true, shell: false,
      detached: true, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) {
      const created = processBirth(child.pid, spec.binary.path);
      if (created) { observed = { pid: child.pid, created_at: created, executable_sha256: spec.binary.sha256 };
        send({ type: 'startup-stage', stage: 'engine-identity-observed' }); }
      else requestStop();
    }
  }
  child.once('spawn', () => send({ type: 'startup-stage', stage: 'guardian-spawned' }));
  child.stdin?.on('error', () => {}); child.stderr?.resume();
  child.stdout?.on('data', (bytes: Buffer) => {
    output = (output + bytes.toString('utf8')).slice(-32768);
    if (process.platform === 'win32' && !observed) {
      const match = new RegExp(`WORKFORCE_ENGINE_IDENTITY ${nonce} (\\d+) (\\d+)`).exec(output);
      if (match) { observed = { pid: Number(match[1]), created_at: `win32:${match[2]}`, executable_sha256: spec.binary.sha256 };
        send({ type: 'startup-stage', stage: 'engine-identity-observed' }); }
    }
    if (process.platform === 'win32' && new RegExp(`WORKFORCE_ENGINE_EXIT ${nonce} \\d+`).test(output)) { actualExit = true; treeClosed = true; }
    const url = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    if (!started && observed && url) { started = true; send({ type: 'startup-stage', stage: 'server-listening' });
      publish('ready', { engine: observed, url }); send({ type: 'ready', engine: observed, url }); }
  });
  const trackGroup = process.platform === 'linux' ? setInterval(() => {
    if (observed) for (const member of linuxEngineGroup(observed.pid) ?? []) knownGroup.set(member.pid, member.birth);
  }, 250) : undefined;
  await new Promise<void>(done => {
    child!.once('error', () => done());
    child!.once('close', () => { if (process.platform !== 'win32') actualExit = true; done(); });
  });
  clearInterval(trackGroup);
  if (process.platform === 'linux' && observed && actualExit) {
    const requested = stop; requestStop(); stop = requested;
    const deadline = Date.now() + 4000;
    do {
      const group = linuxEngineGroup(observed.pid);
      if (group && group.every(member => ['Z', 'X'].includes(member.state))) { treeClosed = true; break; }
      await new Promise(done => setTimeout(done, 50));
    } while (Date.now() < deadline);
  }
  finish();
}

async function startSupervisedEngine(root: string, invocationId: string, directory: string, configDirectory: string,
  binary: { path: string; sha256: string }, env: NodeJS.ProcessEnv, password: string, signal: AbortSignal | undefined,
  options: OpenCodeEngineOptions): Promise<OpenCodeEngine> {
  const startupAt = performance.now();
  let lastStartup: OpenCodeStartupObservation = { stage: 'owner-verified', elapsed_ms: 0 };
  const startup = (stage: OpenCodeStartupObservation['stage']) => {
    lastStartup = { stage, elapsed_ms: Math.round(performance.now() - startupAt) };
    try { options.onStartupStage?.({ ...lastStartup }); } catch { /* Diagnostics cannot change launch authority. */ }
  };
  const deadlineError = (message: string) => new Error(`${message} (last_stage=${lastStartup.stage}, elapsed_ms=${Math.round(performance.now() - startupAt)}).`);
  const created = ownerBirth(process.pid);
  if (!created) throw new Error('A verified process creation identity is required for this platform before starting an engine.');
  startup('owner-verified');
  const path = join(directory, 'supervision'); secureHostPrivateDirectory(path);
  if (existsSync(join(path, 'spec.json'))) throw new Error('This invocation already owns engine supervision history; reconcile it before creating a new invocation.');
  const instance = randomBytes(32).toString('hex'), key = randomBytes(32);
  const spec: EngineSupervisionSpec = { schema_version: 1, root: realpathSync.native(root), invocation_id: invocationId,
    instance, owner: { pid: process.pid, created_at: created }, binary, directory, config_directory: configDirectory, env,
    module_sha256: hash(readFileSync(fileURLToPath(import.meta.url))) };
  const bytes = JSON.stringify(spec) + '\n', ref: OpenCodeSupervisionRef = { schema_version: 1, invocation_id: invocationId, instance,
    owner: { ...spec.owner }, spec_sha256: hash(bytes), spec_hmac: engineMac(key, 'workforce-engine-spec-v1', bytes) };
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error('Engine supervision configuration exceeds its bound.');
  engineAtomic(join(path, 'key.bin'), key); engineAtomic(join(path, 'spec.json'), bytes);
  const script = `import{runOpenCodeOwnerSupervisor}from${JSON.stringify(import.meta.url)};await runOpenCodeOwnerSupervisor(process.argv[1],JSON.parse(process.argv[2]));`;
  const child = spawn(adapterNodeCommand(root), ['--input-type=module', '-e', script, root, JSON.stringify(ref)], {
    cwd: directory, detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: commandEnvironment({ TEMP: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TMPDIR: join(directory, 'tmp') }) });
  startup('watchdog-spawned');
  const observeStartup = (message: unknown) => {
    const value = message as { type?: string; instance?: string; stage?: unknown };
    if (value?.type === 'startup-stage' && value.instance === instance &&
        engineStartupStages.includes(value.stage as OpenCodeStartupObservation['stage'])) startup(value.stage as OpenCodeStartupObservation['stage']);
  };
  child.on('message', observeStartup);
  let exited = false, finishExit!: () => void;
  const exit = new Promise<void>(done => { finishExit = done; });
  child.once('error', () => { exited = true; finishExit(); }); child.once('exit', () => { exited = true; finishExit(); });
  let closing: Promise<void> | undefined, failure: OpenCodeEngine['failure'], logOffset = 0, dispatcher: Agent | undefined;
  const close = () => closing ??= (async () => {
    clearInterval(monitor); signal?.removeEventListener('abort', abort);
    child.off('message', observeStartup);
    if (!exited && child.connected) child.send({ type: 'stop', instance }, () => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exit, new Promise<void>(done => { timer = setTimeout(done, 10000); })]); clearTimeout(timer);
    const state = await reconcileOpenCodeOwner(root, ref);
    if (state.state !== 'stopped') throw new Error('OpenCode shutdown has no authenticated ended proof; preserve the invocation for reconciliation.');
  })().finally(async () => { await dispatcher?.destroy().catch(() => {}); });
  const abort = () => { void close().catch(() => {}); };
  const logPath = join(directory, 'data/opencode/log/opencode.log');
  const inspectStorage = () => {
    if (closing || failure) return;
    try {
      const current = statfsSync(directory, { bigint: true });
      if (current.bavail * current.bsize < 64n * 1024n * 1024n) failure = openCodeStorageFailure('ENOSPC');
      if (!failure && existsSync(logPath)) {
        const fd = openSync(logPath, 'r');
        try { const size = fstatSync(fd).size; if (size < logOffset) logOffset = 0;
          const start = Math.max(logOffset, size - 65536), content = Buffer.alloc(size - start);
          if (content.length) { readSync(fd, content, 0, content.length, start); failure = openCodeStorageFailure(content.toString('utf8')); } logOffset = size;
        } finally { closeSync(fd); }
      }
      if (failure) void close().catch(() => {});
    } catch { /* Missing or rotating logs are not failure evidence. */ }
  };
  const monitor = setInterval(inspectStorage, 1000); monitor.unref();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // Only the waiting watchdog exists here. It cannot start a guardian/engine
    // until the controller has durably stored the prepared supervision ref.
    await new Promise<void>((fulfill, reject) => {
      const timer = setTimeout(() => { done(); reject(deadlineError('Engine supervision admission deadline exceeded')); }, 15000);
      const done = () => { clearTimeout(timer); child.off('message', waiting); child.off('error', failed); child.off('exit', failed); };
      const failed = () => { done(); reject(new Error('Private waiting engine supervisor did not start.')); };
      const waiting = (value: unknown) => { const input = value as { type?: string; instance?: string };
        if (input?.type === 'waiting' && input.instance === instance) { done(); fulfill(); } };
      child.on('message', waiting); child.once('error', failed); child.once('exit', failed); if (exited) failed();
    });
    startup('watchdog-waiting');
    await options.onPrepared?.({ ...ref, owner: { ...ref.owner } }); signal?.throwIfAborted();
    if (!child.connected || exited) throw new Error('Private engine supervisor ended before admission.');
    startup('admitted'); child.send({ type: 'admit', instance }, () => {});
    const ready = await new Promise<{ url: string; engine: OpenCodeProcessIdentity }>((fulfill, reject) => {
      const timer = setTimeout(() => { done(); reject(deadlineError('OpenCode startup deadline exceeded')); }, 30000);
      const done = () => { clearTimeout(timer); child.off('message', message); child.off('exit', failed); child.off('error', failed); };
      const failed = () => { done(); reject(new Error('Pinned OpenCode engine exited before authenticated readiness.')); };
      const message = (value: unknown) => {
        const input = value as { type?: string; instance?: string };
        if (input?.type !== 'ready' || input.instance !== instance) return;
        try {
          const payload = authenticatedEnginePayload(path, key, ref, 'ready');
          if (!payload || payload.root !== spec.root || !/^http:\/\/127\.0\.0\.1:\d+$/.test(payload.url) ||
              payload.engine?.executable_sha256 !== binary.sha256 || processBirth(payload.engine.pid, binary.path) !== payload.engine.created_at) throw new Error();
          startup('authenticated-ready');
          done(); fulfill({ url: payload.url, engine: payload.engine });
        } catch { done(); reject(new Error('Engine readiness identity could not be authenticated.')); }
      };
      child.on('message', message); child.once('exit', failed); child.once('error', failed);
      if (exited) failed();
    });
    signal?.throwIfAborted();
    // Node 24's bundled Undici 7 can crash on a paused SSE parser when its
    // peer closes (nodejs/undici#5360). Pin the upstream fix and own this
    // engine's connection pool instead of changing the global dispatcher.
    dispatcher = new Agent();
    const controlFetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request && !init ? input : new Request(input, init);
      const response = await fixedFetch(request.url, { method: request.method, headers: [...request.headers.entries()],
        ...(request.body ? { body: new Uint8Array(await request.arrayBuffer()) } : {}),
        signal: request.signal, redirect: request.redirect, dispatcher });
      // The SDK uses the standard Response surface; the pinned package has
      // its own equivalent DOM type rather than Node's bundled declaration.
      return response as unknown as Response;
    };
    const client = createOpencodeClient({ baseUrl: ready.url, directory, fetch: options.wrapControlFetch?.(controlFetch) ?? controlFetch,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }, throwOnError: true });
    return { client, directory, instance, binary_sha256: binary.sha256, pid: ready.engine.pid,
      supervision: { ...ref, engine: ready.engine }, get failure() { return failure; }, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}
export async function startOpenCodeEngine(root: string, invocationId: string, config: Config,
  signal?: AbortSignal, options: OpenCodeEngineOptions = {}): Promise<OpenCodeEngine> {
  signal?.throwIfAborted();
  if (!/^[a-f0-9-]{36}$/i.test(invocationId)) throw new Error('Engine requires a backend invocation identity.');
  const storage = openCodeStorage(root);
  if (storage.free_bytes < storage.required_bytes)
    throw new Error('OPENCODE_STORAGE_UNAVAILABLE: fewer than 512 MiB are available on the project volume. No model request was started.');
  secureHostPrivateDirectory(dirname(storage.path));
  const parent = storage.path;
  secureHostPrivateDirectory(parent);
  const directory = join(parent, `opencode-${invocationId}`);
  secureHostPrivateDirectory(directory);
  for (const child of ['config', 'data', 'cache', 'state', 'home', 'tmp']) mkdirSync(join(directory, child), { recursive: true, mode: 0o700 });
  const bootstrap = openCodeBootstrap(), configDirectory = join(directory, 'config', 'opencode');
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  // Only the reviewed dependency seed is copied; never reuse auth, plugins,
  // sessions or project settings from a user's OpenCode configuration.
  for (const entry of ['package.json', 'package-lock.json', 'node_modules']) cpSync(join(bootstrap.path, entry), join(configDirectory, entry), {
    recursive: true, dereference: true, errorOnExist: true, force: false,
    filter: source => {
      if (lstatSync(source).isSymbolicLink()) {
        const target = relative(bootstrap.path, realpathSync(source));
        if (target === '..' || target.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(target))
          throw new Error('WorkForce bootstrap links must stay inside its reviewed dependency tree.');
      }
      return true;
    },
  });
  const binary = openCodeBinary(), password = randomBytes(32).toString('hex');
  const env = commandEnvironment();
  Object.assign(env, { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_SERVER_PASSWORD: password,
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_STATE_HOME: join(directory, 'state'), HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
    TEMP: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TMPDIR: join(directory, 'tmp') });
  return startSupervisedEngine(root, invocationId, directory, configDirectory, binary, env, password, signal, options);
}
