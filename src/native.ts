import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  lstatSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWrite,
  hash,
  now,
  readConfig,
  safePath,
  withOperationLock,
  getRecord,
  resourceRoot,
  retryWindowsFileOperation,
} from './storage.js';
import {
  canonicalJson,
  invocationIsActive,
  nativeReceiptPath,
  ownerIsAlive,
  readInvocation,
  readRoutingPolicy,
  requireRoutingPolicy,
  roleModelPolicy,
  routingConfigurationHashes,
  invocationConfigurationHashes,
  type NativeReceipt,
  type NativeRole,
} from './routing.js';
import { roleCapabilities, resolveCapabilities, toolCatalog, type ProviderId } from './tools.js';
import { VSCodeSession } from './vscode-session.js';
import { readHost, bridgeProtocol } from './vscode-wire.js';
import { readRoleUpstreamInstructions } from './upstreams.js';
import { ownedContext } from './controlled-context.js';
import { controlledToolNames } from './controlled-tools.js';

const runtimeVersion = '0.162.1';
const runtimeIntegrity =
  'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
const active = new Map<string, NativeSession>();
const installations = new Map<string, Promise<RuntimeInfo>>();
const terminalStates = ['completed', 'failed', 'interrupted', 'blocked', 'orphaned'];
export interface RuntimeInfo {
  version: string;
  command: string;
  args: string[];
  integrity: string;
  protocol_sha256: string;
  executable_sha256: string;
  test_fixture?: boolean;
}
export interface NativeStartInput {
  role: NativeRole;
  prompt: string;
  workflow_id?: string;
  task_id?: string;
  request_id?: string;
}
export interface NativeResumeInput {
  prompt?: string;
  request_id?: string;
}
interface NativeOptions {
  runtime?: (root: string) => Promise<RuntimeInfo>;
  rpc_timeout_ms?: number;
  owner_token?: string;
}
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string; code?: number; data?: unknown };
}

function cleanError(error: unknown): string {
  return String(error)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{8,}/g, '[redacted credential]')
    .slice(0, 3000);
}
export class NativeSigningError extends Error {
  constructor(readonly code: 'NATIVE_SIGNING_TRUST_INVALID' | 'NATIVE_SIGNING_HISTORY_REQUIRES_TRUST' |
    'NATIVE_SIGNING_KEY_INVALID' | 'NATIVE_SIGNING_KEY_UNTRUSTED', message: string) {
    super(message); this.name = 'NativeSigningError';
  }
}
function receiptKey(root: string): { privateKey: string; id: string } {
  return withOperationLock(root, 'native-receipt-key', () => {
    const privatePath = safePath(root, '.neomind/cache/native/private-key.pem');
    const trustPath = safePath(root, '.neomind/native/trust.json');
    const receiptsPath = safePath(root, '.neomind/native/receipts');
    const pendingPath = safePath(root, '.neomind/cache/native/pending-key.pem');
    // A missing registry cannot be recreated around historical evidence. Even
    // unrecognized entries are history to reconcile, not permission to rotate.
    const hasHistory = existsSync(receiptsPath) && readdirSync(receiptsPath).length > 0;
    const missingTrust = !existsSync(trustPath);
    let trusted: { schema_version?: number; keys: string[]; [key: string]: unknown };
    try {
      if (!missingTrust && !lstatSync(trustPath).isFile()) throw new Error();
      trusted = missingTrust ? { schema_version: 1, keys: [] } : JSON.parse(readFileSync(trustPath, 'utf8'));
      if (!trusted || typeof trusted !== 'object' || Array.isArray(trusted) ||
          trusted.schema_version !== undefined && trusted.schema_version !== 1 ||
          !Array.isArray(trusted.keys) || trusted.keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))) throw new Error();
    } catch {
      throw new NativeSigningError('NATIVE_SIGNING_TRUST_INVALID',
        'Native signing trust is malformed. Restore the reviewed registry; no key or trust data was replaced.');
    }
    if (missingTrust && hasHistory)
      throw new NativeSigningError('NATIVE_SIGNING_HISTORY_REQUIRES_TRUST',
        'Native signing trust is missing while receipt history exists. Restore its trusted public keys before resuming; history was preserved.');
    let current: { privateKey: string; publicKey: string; id: string } | undefined;
    if (existsSync(privatePath)) {
      try {
        const info = lstatSync(privatePath);
        if (!info.isFile() || info.nlink !== 1) throw new Error();
        const privateKey = readFileSync(privatePath, 'utf8'), parsed = createPrivateKey(privateKey);
        if (parsed.asymmetricKeyType !== 'ed25519') throw new Error();
        const publicKey = createPublicKey(parsed).export({ type: 'spki', format: 'pem' }).toString();
        current = { privateKey, publicKey, id: hash(publicKey) };
      } catch {
        throw new NativeSigningError('NATIVE_SIGNING_KEY_INVALID',
          'Native signing key is invalid. Restore the reviewed identity; its cached bytes were preserved.');
      }
      const publicPath = safePath(root, `.neomind/native/keys/${current.id}.pem`);
      if (!missingTrust && trusted.keys.includes(current.id) && existsSync(publicPath) &&
          lstatSync(publicPath).isFile() && readFileSync(publicPath, 'utf8') === current.publicKey)
        return { privateKey: current.privateKey, id: current.id };
      if (hasHistory)
        throw new NativeSigningError('NATIVE_SIGNING_KEY_UNTRUSTED',
          'Native signing key has no matching trusted public key and receipt history exists. Restore its reviewed trust data; no identity was changed.');
      if (!missingTrust && !existsSync(pendingPath))
        throw new NativeSigningError('NATIVE_SIGNING_KEY_UNTRUSTED',
          'Native signing key is excluded by existing trust data. Restore its reviewed identity; automatic recovery cannot override a trust restriction.');
      // A cached key with no signed history is an incomplete bootstrap. Never
      // silently trust it. Retain it privately and mint a distinct new identity.
      const retired = safePath(root, `.neomind/cache/native/retired/${current.id}.pem`);
      mkdirSync(dirname(retired), { recursive: true, mode: 0o700 });
      if (!existsSync(retired)) writeFileSync(retired, current.privateKey, { flag: 'wx', mode: 0o600 });
      else if (!lstatSync(retired).isFile() || readFileSync(retired, 'utf8') !== current.privateKey)
        throw new NativeSigningError('NATIVE_SIGNING_KEY_UNTRUSTED',
          'Native signing recovery conflicts with retained private history. Reconcile the cached identities before retrying.');
    }
    {
      let privateKey: string, publicKey: string;
      if (existsSync(pendingPath)) {
        if (hasHistory)
          throw new NativeSigningError('NATIVE_SIGNING_HISTORY_REQUIRES_TRUST',
            'Native signing bootstrap is incomplete while receipt history exists. Reconcile the retained identity before continuing.');
        try {
          const info = lstatSync(pendingPath);
          if (!info.isFile() || info.nlink !== 1) throw new Error();
          privateKey = readFileSync(pendingPath, 'utf8');
          const parsed = createPrivateKey(privateKey);
          if (parsed.asymmetricKeyType !== 'ed25519') throw new Error();
          publicKey = createPublicKey(parsed).export({ type: 'spki', format: 'pem' }).toString();
        } catch {
          throw new NativeSigningError('NATIVE_SIGNING_KEY_INVALID',
            'Pending native signing identity is invalid. Reconcile the retained bootstrap; its bytes were preserved.');
        }
        if (current && publicKey === current.publicKey)
          throw new NativeSigningError('NATIVE_SIGNING_KEY_UNTRUSTED',
            'Pending native signing bootstrap cannot reauthorize the orphaned cached identity. Restore a reviewed identity.');
        if (!missingTrust) {
          const pendingId = hash(publicKey), pendingPublic = safePath(root, `.neomind/native/keys/${pendingId}.pem`);
          let approved = false;
          try { approved = trusted.keys.includes(pendingId) && existsSync(pendingPublic) &&
            lstatSync(pendingPublic).isFile() && readFileSync(pendingPublic, 'utf8') === publicKey; } catch { /* Fail closed below. */ }
          if (!approved)
            throw new NativeSigningError('NATIVE_SIGNING_KEY_UNTRUSTED',
              'Pending native signing identity is not approved by the existing trust data. Restore its reviewed bootstrap; automatic recovery cannot override a trust restriction.');
        }
      } else {
        const keys = generateKeyPairSync('ed25519');
        privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        mkdirSync(dirname(pendingPath), { recursive: true, mode: 0o700 });
        writeFileSync(pendingPath, privateKey, { flag: 'wx', mode: 0o600 });
      }
      const id = hash(publicKey);
      const publicPath = safePath(root, `.neomind/native/keys/${id}.pem`);
      atomicWrite(publicPath, publicKey);
      atomicWrite(
        trustPath,
        JSON.stringify({ ...trusted, schema_version: 1, keys: [...new Set([...trusted.keys, id])] }, null, 2) +
          '\n',
      );
      // Publish the public trust data first. An interrupted first-key creation can
      // safely retry rather than leaving an unusable private key without proof.
      // Renaming the exclusive 0600 pending file preserves private permissions
      // and leaves a resumable pending identity if publication is interrupted.
      retryWindowsFileOperation(() => renameSync(pendingPath, privatePath));
      return { privateKey, id };
    }
  });
}
/** Safe runtime preflight. No private key material leaves the signing boundary. */
export function ensureNativeSigningIdentity(root: string): { key_id: string } {
  readConfig(root);
  return { key_id: receiptKey(root).id };
}
function persist(root: string, receipt: NativeReceipt): NativeReceipt {
  const key = receiptKey(root);
  receipt.key_id = key.id;
  receipt.updated_at = now();
  const { signature: oldSignature, ...unsigned } = receipt;
  void oldSignature;
  receipt.signature = sign(
    null,
    Buffer.from(canonicalJson(unsigned)),
    createPrivateKey(key.privateKey),
  ).toString('base64');
  atomicWrite(nativeReceiptPath(root, receipt.id), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
function allReceipts(root: string): NativeReceipt[] {
  const path = safePath(root, '.neomind/native/receipts');
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readInvocation(root, name.slice(0, -5)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
function npmCommand(): { command: string; args: string[] } {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((path) => join(path, 'node_modules/npm/bin/npm-cli.js')),
  ].filter((value): value is string => !!value);
  const cli = candidates.find((path) => existsSync(path) && path.endsWith('.js'));
  if (cli) return { command: process.execPath, args: [cli] };
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('The local npm CLI could not be resolved without invoking a shell.');
}
async function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 180000,
): Promise<string> {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native runtime preparation timed out.'));
    }, timeout);
    child.stdout.on('data', (data) => {
      output = (output + data).slice(-100000);
    });
    child.stderr.on('data', (data) => {
      output = (output + data).slice(-100000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0
        ? fulfill(output)
        : reject(new Error(`Native runtime command failed (${code}): ${cleanError(output)}`));
    });
  });
}
async function installationLease<T>(root: string, action: () => Promise<T>): Promise<T> {
  const path = safePath(root, '.neomind/tools/codex.install.lock');
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 180000;
  let fd: number;
  while (true) {
    try {
      fd = openSync(path, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number } = {};
      try {
        owner = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* A malformed lease must not be removed automatically. */
      }
      if (owner.pid && !ownerIsAlive(owner.pid)) {
        unlinkSync(path);
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error('Native runtime installation is locked by another owner.');
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
    return await action();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
async function prepareRuntime(root: string): Promise<RuntimeInfo> {
  if (requireRoutingPolicy(root).platform === 'copilot') {
    readHost(root);
    return { version: 'vscode-extension-host', command: '', args: [], integrity: '',
      protocol_sha256: hash(bridgeProtocol), executable_sha256: '' };
  }

  return installationLease(root, async () => {
    const prefix = safePath(root, '.neomind/tools/codex');
    const main = join(prefix, 'node_modules/@openai/codex/bin/codex.js');
    const lockPath = join(prefix, 'package-lock.json');
    if (!existsSync(main) || !existsSync(lockPath)) {
      mkdirSync(prefix, { recursive: true });
      const npm = npmCommand();
      await run(
        npm.command,
        [
          ...npm.args,
          'install',
          '--prefix',
          prefix,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--save-exact',
          `@openai/codex@${runtimeVersion}`,
        ],
        root,
      );
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const entry = lock.packages?.['node_modules/@openai/codex'];
    if (entry?.version !== runtimeVersion || entry?.integrity !== runtimeIntegrity)
      throw new Error(
        'The isolated Codex package does not match the pinned version and integrity.',
      );
    const version = await run(process.execPath, [main, '--version'], root, 15000);
    if (version.trim() !== `codex-cli ${runtimeVersion}`)
      throw new Error('The native executable does not report the pinned Codex version.');
    const schemaDirectory = safePath(root, '.neomind/cache/native/schema-0.162.1');
    await run(
      process.execPath,
      [main, 'app-server', 'generate-json-schema', '--out', schemaDirectory],
      root,
      30000,
    );
    const schemaNames = [
      'ThreadStartResponse',
      'ThreadResumeResponse',
      'TurnStartResponse',
      'TurnCompletedNotification',
      'ModelReroutedNotification',
    ];
    const schemas = schemaNames.map((name) =>
      JSON.parse(readFileSync(join(schemaDirectory, 'v2', `${name}.json`), 'utf8')),
    );
    for (const schema of schemas.slice(0, 2)) {
      if (
        !['model', 'modelProvider', 'thread', 'cwd'].every((field) =>
          schema.required?.includes(field),
        ) ||
        !schema.properties?.reasoningEffort
      )
        throw new Error('The pinned native model acknowledgment schema is incompatible.');
    }
    if (!schemas[3]?.required?.includes('turn') || !schemas[4]?.required?.includes('toModel'))
      throw new Error('The native completion or rerouting schema is incompatible.');
    const nativePackage = Object.entries(lock.packages as Record<string, any>).filter(
      ([name, value]) =>
        name.startsWith('node_modules/@openai/codex-') &&
        value.optional &&
        existsSync(join(prefix, name)),
    );
    const binaries: Record<string, string> = {};
    function scan(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.name === 'codex' || entry.name === 'codex.exe')
          binaries[path.slice(prefix.length + 1).replaceAll('\\', '/')] = hash(readFileSync(path));
      }
    }
    for (const [name] of nativePackage) scan(join(prefix, name));
    if (!Object.keys(binaries).length)
      throw new Error('No pinned platform Codex binary was installed.');
    const info: RuntimeInfo = {
      version: runtimeVersion,
      command: process.execPath,
      args: [main],
      integrity: runtimeIntegrity,
      protocol_sha256: hash(canonicalJson(schemas)),
      executable_sha256: hash(canonicalJson(binaries)),
    };
    const publicLock = {
      schema_version: 1,
      package: '@openai/codex',
      version: runtimeVersion,
      integrity: runtimeIntegrity,
      protocol_sha256: info.protocol_sha256,
      launcher_sha256: hash(readFileSync(main)),
      binaries,
      dependencies: Object.fromEntries(
        nativePackage.map(([name, value]) => [
          name,
          { version: value.version, integrity: value.integrity },
        ]),
      ),
    };
    const target = safePath(root, '.neomind/native-runtime.lock.json');
    const serialized = JSON.stringify(publicLock, null, 2) + '\n';
    if (existsSync(target) && readFileSync(target, 'utf8') !== serialized)
      throw new Error(
        'The pinned native runtime or protocol changed from its recorded lock; review it before execution.',
      );
    if (!existsSync(target)) atomicWrite(target, serialized);
    return info;
  });
}
export function ensureNativeRuntime(root: string): Promise<RuntimeInfo> {
  root = resolve(root);
  const running = installations.get(root);
  if (running) return running;
  const promise = prepareRuntime(root).finally(() => installations.delete(root));
  installations.set(root, promise);
  return promise;
}

class RpcTransport {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  nextId = 1;
  closed = false;
  onMessage: (message: RpcMessage) => void = () => {};
  onClose: (error: Error) => void = () => {};
  constructor(
    runtime: RuntimeInfo,
    root: string,
    readonly timeout: number,
  ) {
    this.child = spawn(runtime.command, [...runtime.args, 'app-server', '--listen', 'stdio://'], {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    this.child.stdout.on('data', (data) => {
      buffer += data.toString();
      if (buffer.length > 8 * 1024 * 1024)
        return this.fail(new Error('Native protocol exceeded its bounded message buffer.'));
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message: RpcMessage = JSON.parse(line);
          if (
            message.id !== undefined &&
            !message.method &&
            typeof message.id === 'number' &&
            this.pending.has(message.id)
          ) {
            const waiting = this.pending.get(message.id)!;
            this.pending.delete(message.id);
            clearTimeout(waiting.timer);
            message.error
              ? waiting.reject(
                  new Error(
                    `Native RPC ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`,
                  ),
                )
              : waiting.resolve(message.result);
          } else this.onMessage(message);
        } catch (error) {
          this.fail(new Error(`Native protocol could not be parsed: ${cleanError(error)}`));
        }
      }
    });
    this.child.stderr.on('data', () => {}); // Native stderr can contain private session content; do not archive it.
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => this.fail(new Error(`Native transport exited (${code}).`)));
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Native transport is closed.'));
    const id = this.nextId++;
    return new Promise((fulfill, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native RPC ${method} timed out.`));
      }, this.timeout);
      this.pending.set(id, { resolve: fulfill, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(
      JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + '\n',
    );
  }
  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    this.onClose(error);
    this.child.kill();
  }
  close(): Promise<void> {
    const exited = this.child.exitCode !== null || this.child.signalCode !== null;
    const closed = exited
      ? Promise.resolve()
      : new Promise<void>((fulfill, reject) => {
          const timer = setTimeout(() => {
            this.child.off('close', done);
            reject(new Error('The owned native process did not close within five seconds.'));
          }, 5000);
          const done = () => {
            clearTimeout(timer);
            fulfill();
          };
          this.child.once('close', done);
        });
    this.fail(new Error('Native transport closed by its owner.'));
    return closed;
  }
}
function modelUnavailable(error: unknown): boolean {
  const message = cleanError(error);
  return (
    /model/i.test(message) &&
    /unavailable|unsupported|not supported|does not exist|not found|not available|cannot be used|cannot use|not allowed.*account/i.test(
      message,
    ) &&
    !/rate limit|quota|network|authentication|unauthorized|credential|api key/i.test(message)
  );
}
function validateAcknowledgment(value: any, root: string, model: string, effort: string): void {
  if (
    !value ||
    typeof value.model !== 'string' ||
    typeof value.modelProvider !== 'string' ||
    typeof value.thread?.id !== 'string' ||
    typeof value.cwd !== 'string'
  )
    throw new Error('Native thread acknowledgment is missing required model provenance.');
  if (value.model !== model)
    throw new Error(
      `Native thread selected ${value.model}, but strict routing requested ${model}.`,
    );
  if (value.reasoningEffort !== effort)
    throw new Error(
      `Native thread reasoning effort is ${value.reasoningEffort ?? 'unavailable'}; ${effort} is required.`,
    );
  if (resolve(value.cwd).toLowerCase() !== resolve(root).toLowerCase())
    throw new Error('Native thread acknowledgment belongs to another project directory.');
}
class NativeSession {
  transport: RpcTransport | null = null;
  vscode: VSCodeSession | null = null;
  receipt: NativeReceipt;
  completion: Promise<void>;
  resolveCompletion!: () => void;
  events: RpcMessage[] = [];
  baseConfiguration: Record<string, any> = {};
  closing: Promise<void> | null = null;
  turnResolvers = new Map<string, (value: any) => void>();
  constructor(
    readonly root: string,
    receipt: NativeReceipt,
    readonly options: NativeOptions,
  ) {
    this.receipt = receipt;
    this.completion = new Promise((fulfill) => {
      this.resolveCompletion = fulfill;
    });
  }
  update(patch: Partial<NativeReceipt>): void {
    Object.assign(this.receipt, patch);
    persist(this.root, this.receipt);
  }
  settle(state: NativeReceipt['state'], error: string | null = null): void {
    this.update({ state, error, inference_completed: state === 'completed' });
    void this.releaseTransport().finally(() => {
      this.resolveCompletion();
      active.delete(`${this.root}:${this.receipt.id}`);
    });
  }
  releaseTransport(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.vscode?.close();
      if (this.transport && !this.transport.closed && this.receipt.native_thread_id)
        await this.transport
          .request('thread/unsubscribe', { threadId: this.receipt.native_thread_id })
          .catch(() => {});
      await this.transport?.close();
    })();
    return this.closing;
  }
  onMessage(message: RpcMessage): void {
    if (this.closing) return;
    const params = message.params;
    if (message.id !== undefined && message.method) {
      const reason = cleanError(
        params?.reason ??
          params?.message ??
          `Native host action required: ${message.method}${params?.serverName ? ` (${params.serverName})` : ''}`,
      );
      this.update({
        state: 'waiting-native-permission',
        permissions: [
          ...this.receipt.permissions,
          { method: message.method, request_id: message.id, reason, at: now() },
        ],
      });
      // Leave native approval requests pending. Existing host policy, not this bridge, owns authorization.
      return;
    }
    if (
      params?.threadId &&
      this.receipt.native_thread_id &&
      params.threadId !== this.receipt.native_thread_id
    )
      return;
    if (message.method === 'model/rerouted') {
      this.update({
        reroutes: [
          ...this.receipt.reroutes,
          { from: params.fromModel, to: params.toModel, reason: String(params.reason), at: now() },
        ],
        confirmed_model: params.toModel,
        state: 'blocked',
        error: 'Native model rerouting requires a fresh invocation and reassessment.',
      });
      if (this.receipt.native_turn_id)
        void this.transport
          ?.request('turn/interrupt', {
            threadId: this.receipt.native_thread_id,
            turnId: this.receipt.native_turn_id,
          })
          .catch(() => {});
    }
    if (message.method === 'item/agentMessage/delta' && typeof params?.delta === 'string')
      this.update({ output: (this.receipt.output + params.delta).slice(0, 64000) });
    if (
      message.method === 'item/completed' &&
      params?.item?.type === 'agentMessage' &&
      typeof params.item.text === 'string'
    )
      this.update({ output: params.item.text.slice(0, 64000) });
    if (message.method === 'turn/completed' && typeof params?.turn?.id === 'string') {
      const waiting = this.turnResolvers.get(params.turn.id);
      if (waiting) {
        this.turnResolvers.delete(params.turn.id);
        waiting(params.turn);
      } else this.events.push(message);
    }
  }
  async turnResult(id: string): Promise<any> {
    const cached = this.events.find((message) => message.params?.turn?.id === id);
    if (cached) {
      this.events = this.events.filter((message) => message !== cached);
      return cached.params.turn;
    }
    return new Promise((fulfill) => this.turnResolvers.set(id, fulfill));
  }
  async beginVSCode(): Promise<void> {
    this.vscode = new VSCodeSession(this.root, this.receipt, (patch) => this.update(patch), async (state, error) => {
      if (state !== 'completed') { this.settle(state, error); return; }
      try {
        if (canonicalJson(invocationConfigurationHashes(this.root, this.receipt)) !== canonicalJson(this.receipt.configuration_hashes))
          throw new Error('Native configuration changed during inference.');
        await this.finishInference();
      } catch (failure) { this.settle('blocked', cleanError(failure)); }
    });
    await this.vscode.open();
    this.update({ state: 'running' });
    if (this.receipt.role === 'manager' && this.receipt.workflow_id && !this.receipt.controlled_execution) {
      const { bindManagerInvocation } = await import('./manager.js');
      bindManagerInvocation(this.root, this.receipt.workflow_id, this.receipt.id);
    }
    await this.vscode.run();
  }
  async begin(runtime: RuntimeInfo, resumeThread?: string): Promise<void> {
    this.transport = new RpcTransport(runtime, this.root, this.options.rpc_timeout_ms ?? 30000);
    this.transport.onMessage = (message) => this.onMessage(message);
    this.transport.onClose = (error) => {
      if (!terminalStates.includes(this.receipt.state)) this.settle('orphaned', cleanError(error));
    };
    this.update({
      server_pid: this.transport.child.pid ?? null,
      client_version: runtime.version,
      runtime_integrity: runtime.integrity,
      protocol_sha256: runtime.protocol_sha256,
      configuration_hashes: routingConfigurationHashes(this.root),
    });
    await this.transport.request('initialize', {
      clientInfo: {
        name: 'neomind',
        title: 'NeoMind managed engineering',
        version: '0.1.0-alpha.3',
      },
      capabilities: { experimentalApi: false },
    });
    this.transport.notify('initialized');
    const configuration = await this.transport.request('config/read', {
      includeLayers: false,
      cwd: this.root,
    });
    this.baseConfiguration = configuration.config ?? {};
    this.update({ effective_configuration_sha256: hash(canonicalJson(configuration.config)) });
    await this.launch(resumeThread);
  }
  async launch(resumeThread?: string): Promise<void> {
    const transport = this.transport!;
    const spec = roleModelPolicy(this.root, this.receipt.role);
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    const operations = roleCapabilities(this.receipt.role).operations;
    const previousGateway = this.baseConfiguration.mcp_servers?.neomind ?? {};
    for (const operation of operations) {
      const explicit = previousGateway.tools?.[operation]?.approval_mode;
      if (explicit && explicit !== 'approve')
        throw new Error(
          `Authored NeoMind tool approval policy for ${operation} requires ${explicit}; preserve it and review the configuration before automatic execution.`,
        );
    }
    if (
      Array.isArray(previousGateway.enabled_tools) &&
      operations.some((operation) => !previousGateway.enabled_tools.includes(operation))
    )
      throw new Error(
        'Authored NeoMind enabled_tools restricts this role. Review the native tool configuration before execution.',
      );
    if (
      Array.isArray(previousGateway.disabled_tools) &&
      previousGateway.disabled_tools.some((operation: string) => operations.includes(operation))
    )
      throw new Error(
        'Authored NeoMind disabled_tools conflicts with this role; preserve the restriction and review configuration.',
      );
    const instructionPaths = [
      `roles/${this.receipt.role}.md`,
      'guides/workflow.md',
      ...(this.receipt.role === 'manager' ? ['guides/manager.md'] : []),
    ];
    const instructions = instructionPaths
      .map((path) => {
        const installed = safePath(this.root, `.neomind/${path}`);
        const source = existsSync(installed) ? installed : join(resourceRoot, path);
        return existsSync(source)
          ? `\n## Installed instruction ${path}\n${readFileSync(source, 'utf8')}`
          : '';
      })
      .join('')
      .slice(0, 32000) + '\n' + readRoleUpstreamInstructions(this.root, this.receipt.role);
    const authoringGuidance =
      this.receipt.role === 'developer'
        ? ' For ordinary assigned source or documentation edits, use project_read to obtain the current SHA-256, then task_file_write with complete UTF-8 content and that expected_hash; null is only for a missing file. Reuse the same operation UUID and payload for lost-response recovery. Cornell artifacts use note_create and its draft revision envelope. These core operations preserve reviewed scope and acceptance artifacts; native permission requests remain separate blockers.'
        : this.receipt.role === 'check-executor'
          ? ' For a reviewed inspection_items rubric, read the current plan through record_get with explicit data_fields and include_body:false. Inspect every exact item, obtain file SHA-256 values through project_read or full record fingerprints through record_get, then submit actual observations and limitations through check_inspect. Report fail/gap when the expected criterion is not demonstrated. This records model-performed inspection, not automatic semantic proof; independent review and actual executable checks remain distinct.'
          : '';
    const params = {
      model: this.receipt.requested_model,
      cwd: this.root,
      ...(spec.strong ? { sandbox: 'read-only' } : {}),
      config: {
        model_reasoning_effort: spec.reasoning_effort,
        'mcp_servers.neomind': {
          command: process.execPath,
          args: [cli, 'mcp', '--project', this.root, '--invocation', this.receipt.id],
          enabled_tools: operations,
          tools: Object.fromEntries(
            operations.map((operation) => [operation, { approval_mode: 'approve' }]),
          ),
        },
      },
      developerInstructions: `NeoMind native invocation ${this.receipt.id}; role ${this.receipt.role}; workflow ${this.receipt.workflow_id ?? 'unassigned'}; task ${this.receipt.task_id ?? 'unassigned'}. Use the invocation-bound NeoMind MCP operations. Work only within your role and task contract. Do not invoke manager_run recursively. The manager has already created the workflow. Every durable change and review must reference this invocation. Before ending your assignment, call assignment_report with substantive Objective, Inputs and Sources, Decisions and Rationale, Results, Evidence, Limitations, and Lessons sections. A producer's task_submit with the full seven-section work_record satisfies this reporting requirement instead. Reviewers report after their actual review; check executors report after executing checks and inspecting the result. For a follow-up report, explicitly list any covered prior invocation IDs of your own role and assignment. Do not fabricate another agent's narrative. Native authorization belongs to the existing client policy.${authoringGuidance} The installed role and workflow instructions are included below; use MCP record and recipe operations to inspect engineering state rather than shell commands just to reload these instructions.${instructions}`,
    };
    let ack: any;
    this.update({
      native_tool_scope: operations,
      gateway_policy_sha256: hash(canonicalJson(params.config['mcp_servers.neomind'])),
    });
    try {
      ack = await transport.request(resumeThread ? 'thread/resume' : 'thread/start', {
        ...params,
        ...(resumeThread ? { threadId: resumeThread } : {}),
      });
    } catch (error) {
      const modelIndex = spec.models.indexOf(this.receipt.requested_model);
      const nextModel = !spec.strong && modelIndex >= 0 ? spec.models[modelIndex + 1] : undefined;
      if (nextModel && modelUnavailable(error)) {
        this.update({
          requested_model: nextModel,
          fallback_evidence: {
            model: this.receipt.requested_model,
            reason: cleanError(error),
            at: now(),
          },
        });
        return this.launch(resumeThread);
      }
      throw error;
    }
    validateAcknowledgment(ack, this.root, this.receipt.requested_model, spec.reasoning_effort);
    if (spec.strong && ack.sandbox?.type !== 'readOnly')
      throw new Error(
        'The native client did not acknowledge read-only shell access for the strategic role.',
      );
    this.update({
      confirmed_model: ack.model,
      model_provider: ack.modelProvider,
      native_sandbox: ack.sandbox?.type ?? null,
      confirmed_reasoning_effort: ack.reasoningEffort,
      native_thread_id: ack.thread.id,
    });
    if (resumeThread) {
      const running = (ack.thread.turns ?? []).filter((turn: any) => turn.status === 'inProgress');
      for (const turn of running) {
        await transport.request('turn/interrupt', { threadId: resumeThread, turnId: turn.id });
        const completed = await Promise.race([
          this.turnResult(turn.id),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('The previous native turn could not be reconciled.')),
              30000,
            ),
          ),
        ]);
        if (!completed || (completed as any).status === 'inProgress')
          throw new Error('The previous native turn still owns its transport.');
      }
    }
    const started = await transport.request('turn/start', {
      threadId: ack.thread.id,
      input: [{ type: 'text', text: this.receipt.input_text, text_elements: [] }],
      effort: spec.reasoning_effort,
      clientUserMessageId: this.receipt.id,
    });
    if (typeof started?.turn?.id !== 'string')
      throw new Error('Native turn start acknowledgment has no turn identity.');
    this.update({ native_turn_id: started.turn.id, state: 'running' });
    void this.completeTurn(started.turn.id);
  }
  async completeTurn(id: string): Promise<void> {
    try {
      const turn = await this.turnResult(id);
      if (this.receipt.reroutes.length)
        return this.settle('blocked', 'Native model rerouted; outputs require reassessment.');
      const spec = roleModelPolicy(this.root, this.receipt.role);
      const modelIndex = spec.models.indexOf(this.receipt.requested_model);
      const nextModel = !spec.strong && modelIndex >= 0 ? spec.models[modelIndex + 1] : undefined;
      if (
        turn.status === 'failed' &&
        nextModel &&
        modelUnavailable(turn.error?.message ?? JSON.stringify(turn.error))
      ) {
        this.update({
          requested_model: nextModel,
          confirmed_model: null,
          native_thread_id: null,
          native_turn_id: null,
          state: 'starting',
          output: '',
          fallback_evidence: {
            model: this.receipt.requested_model,
            reason: cleanError(turn.error?.message ?? JSON.stringify(turn.error)),
            at: now(),
          },
        });
        return await this.launch();
      }
      if (turn.status !== 'completed')
        return this.settle(
          turn.status === 'interrupted' ? 'interrupted' : 'failed',
          cleanError(turn.error?.message ?? `Native turn ended with ${turn.status}.`),
        );
      const configuration = await this.transport!.request('config/read', {
        includeLayers: false,
        cwd: this.root,
      });
      if (
        hash(canonicalJson(configuration.config)) !== this.receipt.effective_configuration_sha256 ||
        canonicalJson(routingConfigurationHashes(this.root)) !==
          canonicalJson(this.receipt.configuration_hashes)
      )
        return this.settle('blocked', 'Native configuration changed during inference.');
      await this.finishInference();
    } catch (error) {
      this.settle('blocked', cleanError(error));
    }
  }
  async finishInference(): Promise<void> {
      this.update({ state: 'completed', inference_completed: true, error: null });
      if (this.receipt.role === 'manager' && this.receipt.workflow_id) {
        try {
          const workflow = getRecord(this.root, this.receipt.workflow_id);
          if (workflow.meta.data.phase === 'awaiting-native-completion') {
            const { finishWorkflow } = await import('./manager.js');
            finishWorkflow(this.root, this.receipt.workflow_id, {});
          }
        } catch (error) {
          // Publication/closure failures do not rewrite a frozen accepted snapshot
          // or turn successful native inference into a failed inference claim.
          atomicWrite(
            safePath(this.root, `.neomind/native/completion/${this.receipt.id}.json`),
            JSON.stringify(
              {
                schema_version: 1,
                workflow_id: this.receipt.workflow_id,
                invocation_id: this.receipt.id,
                error: cleanError(error),
                at: now(),
              },
              null,
              2,
            ) + '\n',
          );
        }
      }
      // The completed receipt may now be frozen in an archive. Do not re-sign it.
      await this.releaseTransport();
      this.resolveCompletion();
      active.delete(`${this.root}:${this.receipt.id}`);
  }
}
function newReceipt(root: string, input: NativeStartInput, prior?: NativeReceipt): NativeReceipt {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 64000)
    throw new Error(
      'Native invocation needs a non-empty bounded prompt (maximum 64000 characters).',
    );
  if (
    input.request_id !== undefined &&
    (typeof input.request_id !== 'string' ||
      !input.request_id.trim() ||
      input.request_id.length > 256)
  )
    throw new Error('Native request ID must be a non-empty bounded string.');
  const spec = roleModelPolicy(root, input.role);
  const id = randomUUID();
  return {
    schema_version: 1,
    issuer: 'neomind-codex-app-server',
    execution_mode: 'native',
    id,
    receipt_path: `.neomind/native/receipts/${id}.json`,
    project_id: readConfig(root).project_id,
    role: input.role,
    workflow_id: input.workflow_id ?? null,
    task_id: input.task_id ?? null,
    request_id: input.request_id ?? null,
    prior_invocation_id: prior?.id ?? null,
    input_text: input.prompt,
    input_sha256: hash(input.prompt),
    requested_model: spec.models[0]!,
    confirmed_model: null,
    model_provider: null,
    native_sandbox: null,
    native_tool_scope: [],
    gateway_policy_sha256: null,
    reasoning_effort: spec.reasoning_effort,
    confirmed_reasoning_effort: null,
    client_version: runtimeVersion,
    runtime_integrity: '',
    protocol_sha256: '',
    routing_sha256: hash(canonicalJson(readRoutingPolicy(root))),
    configuration_hashes: routingConfigurationHashes(root),
    effective_configuration_sha256: null,
    native_thread_id: null,
    native_turn_id: null,
    state: 'starting',
    inference_completed: false,
    output: '',
    error: null,
    fallback_evidence: null,
    reroutes: [],
    permissions: [],
    owner_pid: process.pid,
    server_pid: null,
    created_at: now(),
    updated_at: now(),
    key_id: '',
    signature: '',
  };
}
async function startOwned(
  root: string,
  input: NativeStartInput,
  options: NativeOptions,
  prior?: NativeReceipt,
): Promise<NativeReceipt> {
  root = resolve(root);
  requireRoutingPolicy(root);
  const receipt = withOperationLock(root, 'native-dispatch', () => {
    const receipts = allReceipts(root);
    if (input.request_id) {
      const existing = receipts.find((receipt) => receipt.request_id === input.request_id);
      if (existing) {
        if (
          existing.input_sha256 !== hash(input.prompt) ||
          existing.role !== input.role ||
          existing.workflow_id !== (input.workflow_id ?? null) ||
          existing.task_id !== (input.task_id ?? null)
        )
          throw new Error('Native request ID is already bound to different work.');
        return existing;
      }
    }
    const running = receipts.filter((receipt) => invocationIsActive(receipt));
    const abandoned = running.find((receipt) => !ownerIsAlive(receipt.owner_pid));
    if (abandoned)
      throw new Error(
        `Native invocation ${abandoned.id} has an absent owner; reconcile it before dispatching more work.`,
      );
    if (input.task_id && running.some((receipt) => receipt.task_id === input.task_id))
      throw new Error('This task already has a live native invocation.');
    if (
      input.role !== 'manager' &&
      running.filter((receipt) => receipt.role !== 'manager').length >= readConfig(root).max_workers
    )
      throw new Error('The project already has its maximum concurrent native workers.');
    const created = newReceipt(root, input, prior);
    if (options.runtime) created.execution_mode = 'protocol-fixture';
    else if (requireRoutingPolicy(root).platform === 'copilot') {
      created.issuer = 'neomind-vscode-lm';
      created.execution_mode = 'vscode-extension-host';
      created.identity_provenance = 'local-vscode-extension-host';
      created.effort_support = 'unavailable';
      created.client_version = '';
      created.protocol_sha256 = hash(bridgeProtocol);
      created.native_tool_scope = roleCapabilities(input.role).operations;
      created.gateway_policy_sha256 = hash(canonicalJson(created.native_tool_scope));
      const controlled = ownedContext(root, input.request_id);
      if (controlled) {
        if (controlled.binding.workflow_id !== input.workflow_id || controlled.binding.role !== input.role ||
            controlled.binding.task_id !== input.task_id) throw new Error('Controlled invocation context differs from backend dispatch.');
        created.controlled_execution = { schema_version: 1, epoch_id: controlled.epoch_id, stage: controlled.binding.stage,
          routing_policy: structuredClone(requireRoutingPolicy(root)) };
        created.native_tool_scope = controlledToolNames(controlled.binding);
        created.gateway_policy_sha256 = hash(canonicalJson(created.native_tool_scope));
      }
    }
    persist(root, created);
    return created;
  });
  const key = `${root}:${receipt.id}`;
  if (
    active.has(key) ||
    receipt.owner_pid !== process.pid ||
    receipt.state !== 'starting' ||
    receipt.server_pid !== null
  )
    return receipt;
  const session = new NativeSession(root, receipt, options);
  active.set(key, session);
  try {
    if (receipt.task_id) {
      const task = getRecord(root, receipt.task_id);
      const required = task.meta.data.required_tools;
      if (required !== undefined) {
        if (
          !Array.isArray(required) ||
          required.some(
            (id) => typeof id !== 'string' || !toolCatalog.some((provider) => provider.id === id),
          )
        )
          throw new Error('Task required_tools must name approved provider IDs.');
        if (required.length)
          await resolveCapabilities(root, {
            role: receipt.role,
            required: required as ProviderId[],
          });
      }
    }
    if (receipt.issuer === 'neomind-vscode-lm') await session.beginVSCode();
    else {
      const runtime = await (options.runtime ?? ensureNativeRuntime)(root);
      await session.begin(runtime, prior?.native_thread_id ?? undefined);
    }
  } catch (error) {
    session.settle('blocked', cleanError(error));
  }
  return readInvocation(root, receipt.id);
}
export function startNative(
  root: string,
  input: NativeStartInput,
  ownerToken?: string,
): Promise<NativeReceipt> {
  return startOwned(root, input, { owner_token: ownerToken });
}
export function nativeStatus(root: string, id?: string): NativeReceipt | NativeReceipt[] {
  return id ? readInvocation(root, id) : allReceipts(root);
}
export async function waitNative(root: string, id: string, waitMs = 10000): Promise<NativeReceipt> {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000)
    throw new Error('Native wait must be between 0 and 60000 milliseconds.');
  root = resolve(root);
  const session = active.get(`${root}:${id}`);
  if (session && waitMs > 0)
    await Promise.race([session.completion, new Promise((fulfill) => setTimeout(fulfill, waitMs))]);
  return readInvocation(root, id);
}
export async function interruptNative(root: string, id: string): Promise<NativeReceipt> {
  root = resolve(root);
  const receipt = readInvocation(root, id);
  if (!invocationIsActive(receipt) && receipt.state !== 'blocked') return receipt;
  const session = active.get(`${root}:${id}`);
  if (!session) {
    if (ownerIsAlive(receipt.owner_pid))
      throw new Error(
        'The live native transport is owned by another process. Interrupt it through that owner.',
      );
    if (receipt.server_pid && ownerIsAlive(receipt.server_pid))
      throw new Error(
        'The orphaned native server remains alive; stop the original transport before resuming.',
      );
    receipt.state = 'orphaned';
    receipt.inference_completed = false;
    receipt.error =
      'The previous owner and transport are absent; a resumed invocation must reconcile native turn history.';
    return persist(root, receipt);
  }
  if (
    receipt.native_thread_id &&
    receipt.native_turn_id &&
    session.transport &&
    !session.transport.closed
  ) {
    try {
      await session.transport.request('turn/interrupt', {
        threadId: receipt.native_thread_id,
        turnId: receipt.native_turn_id,
      });
      await waitNative(root, id, 1000);
    } catch {
      /* Closing the owned transport below preserves an interrupted receipt. */
    }
  }
  if (active.has(`${root}:${id}`))
    session.settle('interrupted', 'Native invocation interrupted by its owner.');
  return readInvocation(root, id);
}
async function resumeOwned(
  root: string,
  id: string,
  input: NativeResumeInput,
  options: NativeOptions,
): Promise<NativeReceipt> {
  root = resolve(root);
  requireRoutingPolicy(root);
  let prior = readInvocation(root, id);
  if (invocationIsActive(prior)) prior = await interruptNative(root, id);
  const ending = active.get(`${root}:${id}`);
  if (ending?.closing) await ending.closing;
  if (prior.server_pid && ownerIsAlive(prior.server_pid) && !active.has(`${root}:${id}`))
    throw new Error('The prior native transport has not exited; retry after reconciliation.');
  if (!prior.native_thread_id)
    throw new Error(
      'This invocation has no acknowledged native thread to resume. Start a new bounded invocation after resolving its blocker.',
    );
  if (prior.issuer === 'neomind-vscode-lm' &&
      (prior.routing_sha256 !== hash(canonicalJson(readRoutingPolicy(root))) ||
       canonicalJson(prior.configuration_hashes) !== canonicalJson(routingConfigurationHashes(root))))
    throw new Error('VS Code invocation configuration changed; start fresh invocation after review.');
  return startOwned(
    root,
    {
      role: prior.role,
      prompt: input.prompt ?? prior.input_text,
      ...(prior.workflow_id ? { workflow_id: prior.workflow_id } : {}),
      ...(prior.task_id ? { task_id: prior.task_id } : {}),
      ...(input.request_id ? { request_id: input.request_id } : {}),
    },
    options,
    prior,
  );
}
export function resumeNative(
  root: string,
  id: string,
  input: NativeResumeInput = {},
  ownerToken?: string,
): Promise<NativeReceipt> {
  return resumeOwned(root, id, input, { owner_token: ownerToken });
}
/** Dependency-injected transport factory for protocol fixtures; never exposed by CLI or MCP. */
export function createNativeBridge(options: NativeOptions): {
  start: typeof startNative;
  resume: typeof resumeNative;
  status: typeof nativeStatus;
  wait: typeof waitNative;
  interrupt: typeof interruptNative;
} {
  return {
    start: (root, input) => startOwned(root, input, options),
    resume: (root, id, input = {}) => resumeOwned(root, id, input, options),
    status: nativeStatus,
    wait: waitNative,
    interrupt: interruptNative,
  };
}
export async function shutdownNative(root?: string, ownerToken?: string): Promise<void> {
  for (const session of [...active.values()].filter(
    (session) =>
      (!root || session.root === resolve(root)) &&
      (!ownerToken || session.options.owner_token === ownerToken),
  )) {
    // Earlier awaits can finish another snapshot entry's owned cleanup. Never
    // interrupt an absent/replaced session or rewrite a refusal already closing.
    if (active.get(`${session.root}:${session.receipt.id}`) !== session) continue;
    if (!session.closing) await interruptNative(session.root, session.receipt.id);
    await session.releaseTransport();
    await session.completion;
  }
}
process.once('beforeExit', () => {
  for (const session of active.values())
    session.settle('interrupted', 'Native owner is shutting down.');
});
