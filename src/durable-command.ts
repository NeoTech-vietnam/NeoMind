import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { adapterNodeCommand } from './adapters.js';
import { commandEnvironment, type CommandInput, type CommandResult } from './command-runner.js';
import { secureHostPrivateDirectory } from './vscode-wire.js';

export interface DurableCommandBinding { workflow_id: string; epoch_id: string; attempt_id: string; operation_id: string; kind: 'check' | 'producer' }
export interface DurableCommandRef { schema_version: 1; id: string; spec_sha256: string; binding_sha256: string; spec_hmac: string }
export interface DurableCommandResult extends CommandResult { durable_job: DurableCommandRef; durable_state: 'completed' | 'interrupted' }
export interface DurableCommandInput extends CommandInput { binding: DurableCommandBinding }
export interface DurableCommandOptions { onPrepared?(job: DurableCommandRef): void | Promise<void> }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const mac = (key: Buffer, domain: string, bytes: Buffer | string) => createHmac('sha256', key).update(`${domain}\0`).update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
function equal(left: string, right: string) { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function binding(value: DurableCommandBinding): DurableCommandBinding {
  if (!value || Object.keys(value).some(key => !['workflow_id', 'epoch_id', 'attempt_id', 'operation_id', 'kind'].includes(key)) ||
      !['workflow_id', 'epoch_id', 'attempt_id', 'operation_id'].every(key => typeof value[key as keyof DurableCommandBinding] === 'string' && value[key as keyof DurableCommandBinding].length > 0 && value[key as keyof DurableCommandBinding].length <= 256) ||
      !['check', 'producer'].includes(value.kind)) throw new Error('Durable command needs its complete backend binding.');
  return { workflow_id: value.workflow_id, epoch_id: value.epoch_id, attempt_id: value.attempt_id, operation_id: value.operation_id, kind: value.kind };
}
function project(root: string) { return realpathSync.native(resolve(root)); }
function privateBase(root: string) {
  const physical = project(root), identity = `${userInfo().username}\0${process.platform === 'win32' ? physical.toLowerCase() : physical}`;
  return join(dirname(physical), '.workforce-private', digest(identity));
}
function directory(root: string, id: string) {
  if (!uuid.test(id)) throw new Error('Invalid durable job identity.');
  return join(privateBase(root), 'commands', id);
}
function regular(path: string, cap: number): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > cap ||
      process.platform !== 'win32' && (info.uid !== process.getuid!() || info.mode & 0o077)) throw new Error('Durable job file is not private and ordinary.');
  return readFileSync(path);
}
function validateDirectories(root: string, id: string): string {
  const base = privateBase(root), job = directory(root, id);
  for (const path of [dirname(base), base, join(base, 'commands'), job]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid!() || info.mode & 0o077))
      throw new Error('Durable job directory is not owner-private.');
  }
  return job;
}
function save(path: string, bytes: Buffer | string): void {
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
function trustedNode(root: string): string {
  const configured = adapterNodeCommand(root);
  const candidates = isAbsolute(configured) ? [configured] : (commandEnvironment().PATH ?? commandEnvironment().Path ?? '').split(delimiter).filter(isAbsolute)
    .map(path => join(path, process.platform === 'win32' ? 'node.exe' : 'node'));
  for (const candidate of candidates) try {
    const path = realpathSync.native(candidate); if (!lstatSync(path).isFile()) continue;
    const version = spawnSync(path, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false, env: commandEnvironment(), timeout: 10000, maxBuffer: 1024 });
    const major = /^v(\d+)\./.exec(version.stdout ?? '')?.[1];
    if (!version.error && version.status === 0 && major && (Number(major) === 24 || Number(major) >= 26)) return path;
  } catch { /* Only an observed actual supported Node executable is eligible. */ }
  throw new Error('A trusted supported Node executable is required for durable commands.');
}

/** No PID observation can substitute for this authenticated durable final result. */
export function readDurableCommandResult(root: string, ref: DurableCommandRef, expected: DurableCommandBinding): DurableCommandResult | undefined {
  if (!ref || ref.schema_version !== 1 || !uuid.test(ref.id) || ![ref.spec_sha256, ref.binding_sha256, ref.spec_hmac].every(value => sha.test(value)))
    throw new Error('Invalid durable job reference.');
  const job = validateDirectories(root, ref.id), key = regular(join(job, 'key.bin'), 32);
  if (key.length !== 32) throw new Error('Invalid durable job key.');
  const bytes = regular(join(job, 'spec.json'), 2 * 1024 * 1024);
  if (digest(bytes) !== ref.spec_sha256 || !equal(mac(key, 'workforce-command-spec-v1', bytes), ref.spec_hmac)) throw new Error('Durable job spec identity changed.');
  const spec = JSON.parse(bytes.toString('utf8'));
  if (spec.schema_version !== 1 || spec.job_id !== ref.id || spec.root !== project(root) || digest(JSON.stringify(binding(spec.binding))) !== ref.binding_sha256 ||
      digest(JSON.stringify(binding(expected))) !== ref.binding_sha256) throw new Error('Durable job belongs to another operation binding.');
  const path = join(job, 'result.json'); if (!existsSync(path)) return undefined;
  // JSON can escape a single output byte as six bytes; bound the serialized
  // envelope independently without rejecting valid control-character output.
  const envelope = JSON.parse(regular(path, spec.max_output_bytes * 6 + 65536).toString('utf8'));
  const payload = envelope?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Durable command result authentication failed.');
  const encoded = JSON.stringify(payload);
  if (envelope.schema_version !== 1 || envelope.sha256 !== digest(encoded) || typeof envelope.hmac !== 'string' ||
      !equal(envelope.hmac, mac(key, 'workforce-command-result-v1', encoded)) || payload.job_id !== ref.id || payload.root !== project(root) ||
      payload.spec_sha256 !== ref.spec_sha256 || payload.binding_sha256 !== ref.binding_sha256 ||
      !Number.isSafeInteger(payload.supervisor_pid) || payload.supervisor_pid < 1 || typeof payload.finished_at !== 'string' ||
      !Number.isFinite(Date.parse(payload.finished_at)) || !['completed', 'owner-disconnected', 'cancelled'].includes(payload.reason))
    throw new Error('Durable command result authentication failed.');
  const result = payload.result as CommandResult;
  if (!result || ![result.cancelled, result.timed_out, result.output_limited].every(value => typeof value === 'boolean') ||
      result.exit_code !== null && (!Number.isInteger(result.exit_code) || result.exit_code < 0 || result.exit_code > 0xffffffff) ||
      result.signal !== null && (typeof result.signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(result.signal)) ||
      typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.error !== null && typeof result.error !== 'string' ||
      !Number.isFinite(result.duration_ms) || result.duration_ms < 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > spec.max_output_bytes ||
      payload.reason !== 'completed' && !result.cancelled) throw new Error('Durable command result shape or limits are invalid.');
  return { ...result, durable_job: { ...ref }, durable_state: payload.reason === 'completed' ? 'completed' : 'interrupted' };
}

/** onPrepared commits the controller intent before a supervisor or command can start. */
export async function runDurableCommand(root: string, input: DurableCommandInput, options: DurableCommandOptions = {}): Promise<DurableCommandResult> {
  root = project(root);
  if (!Array.isArray(input.command) || !input.command.length || !input.command[0]?.trim() || input.command.some(value => typeof value !== 'string' || value.includes('\0')) ||
      typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || !lstatSync(input.cwd).isDirectory()) throw new Error('Durable command requires exact argv and an existing absolute working directory.');
  const timeout = input.timeout_ms ?? 60000, cap = input.max_output_bytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000 || !Number.isSafeInteger(cap) || cap < 1 || cap > 10 * 1024 * 1024 ||
      input.stdin !== undefined && (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin) > 1024 * 1024)) throw new Error('Durable command limits are invalid.');
  commandEnvironment(input.env);
  const node = trustedNode(root), bound = binding(input.binding), id = randomUUID(), base = privateBase(root);
  for (const path of [dirname(base), base, join(base, 'commands')]) secureHostPrivateDirectory(path);
  const job = directory(root, id); secureHostPrivateDirectory(job);
  const temporary = join(job, 'tmp'); secureHostPrivateDirectory(temporary);
  const environment = { TEMP: temporary, TMP: temporary, TMPDIR: temporary, ...input.env };
  const effective = commandEnvironment(environment), supervisorTemporary = Object.fromEntries(Object.entries(effective)
    .filter(([key]) => ['TEMP', 'TMP', 'TMPDIR'].includes(key.toUpperCase()))) as Record<string, string>;
  const supervisor = fileURLToPath(new URL('../resources/runtime/command-supervisor.mjs', import.meta.url));
  const runner = fileURLToPath(new URL('./command-runner.js', import.meta.url));
  const spec = { schema_version: 1, job_id: id, root, owner_pid: process.pid, binding: bound,
    command: [...input.command], cwd: input.cwd, timeout_ms: timeout, max_output_bytes: cap,
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }), env: environment,
    supervisor_sha256: digest(readFileSync(supervisor)), runner_sha256: digest(readFileSync(runner)) };
  const bytes = Buffer.from(JSON.stringify(spec) + '\n'); if (bytes.length > 2 * 1024 * 1024) throw new Error('Durable command spec exceeds its bound.');
  const key = randomBytes(32), ref: DurableCommandRef = { schema_version: 1, id, spec_sha256: digest(bytes),
    binding_sha256: digest(JSON.stringify(bound)), spec_hmac: mac(key, 'workforce-command-spec-v1', bytes) };
  save(join(job, 'key.bin'), key); save(join(job, 'spec.json'), bytes); save(join(job, 'ref.json'), JSON.stringify(ref) + '\n');
  await options.onPrepared?.({ ...ref });
  return await new Promise<DurableCommandResult>((fulfill, reject) => {
    let settled = false;
    const child = spawn(node, [supervisor, job], { cwd: job, windowsHide: true, shell: false, detached: true,
      env: commandEnvironment(supervisorTemporary), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const abort = () => { if (child.connected) child.send({ type: 'cancel', id }, () => {}); };
    const finish = () => {
      if (settled) return;
      try {
        const result = readDurableCommandResult(root, ref, bound); if (!result) return;
        settled = true; cleanup(); fulfill(result);
      } catch { settled = true; cleanup(); reject(Object.assign(new Error('Durable command result could not be authenticated; preserve its job for reconciliation.'), { code: 'DURABLE_COMMAND_UNCERTAIN', durable_job: ref })); }
    };
    const uncertain = () => { finish(); if (settled) return; settled = true; cleanup();
      reject(Object.assign(new Error('No authenticated durable command result is available. Effects remain uncertain.'), { code: 'DURABLE_COMMAND_UNCERTAIN', durable_job: ref })); };
    const timer = setTimeout(() => { abort(); setTimeout(uncertain, 5000).unref(); }, timeout + 20000);
    const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); };
    input.signal?.addEventListener('abort', abort, { once: true });
    child.on('message', value => {
      const message = value as { type?: string; id?: string; spec_sha256?: string; pid?: number };
      if (message.id !== id || message.spec_sha256 !== ref.spec_sha256) return;
      if (message.type === 'started' && Number.isSafeInteger(message.pid)) {
        try { input.onStart?.(message.pid!); } catch { abort(); }
      }
      if (message.type === 'finished') finish();
    });
    child.on('error', uncertain); child.on('exit', uncertain);
    child.send({ type: 'start', ref, cancelled: input.signal?.aborted === true }, error => { if (error) uncertain(); });
  });
}
