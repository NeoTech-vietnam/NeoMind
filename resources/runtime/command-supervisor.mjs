// A private, one-job process. No daemon, shell or model-facing authentication.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const controller = new AbortController();
let disconnected = !process.connected, cancelled = false, running = false, terminal = false;
const digest = value => createHash('sha256').update(value).digest('hex');
const mac = (key, domain, bytes) => createHmac('sha256', key).update(`${domain}\0`).update(bytes).digest('hex');
const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string') return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const directory = resolve(process.argv[2] ?? '');
const sha = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function privateStat(path, file, cap = Infinity) {
  const info = lstatSync(path);
  if ((file ? !info.isFile() || info.nlink !== 1 || info.size > cap : !info.isDirectory()) || info.isSymbolicLink() ||
      process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077)) throw new Error('Invalid private job path.');
}
const regular = (path, cap) => { privateStat(path, true, cap); return readFileSync(path); };
function save(path, value) {
  if (existsSync(path)) throw new Error('A durable final result already exists.');
  const temporary = `${path}.${process.pid}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
function authenticate(message) {
  if (typeof process.send !== 'function') throw new Error('A private owner IPC channel is required.');
  const key = regular(join(directory, 'key.bin'), 32), bytes = regular(join(directory, 'spec.json'), 2 * 1024 * 1024);
  const ref = JSON.parse(regular(join(directory, 'ref.json'), 2048)), spec = JSON.parse(bytes);
  const root = realpathSync.native(spec.root), identity = `${userInfo().username}\0${process.platform === 'win32' ? root.toLowerCase() : root}`;
  const base = join(dirname(root), '.workforce-private', digest(identity));
  const runner = fileURLToPath(new URL('../../dist/command-runner.js', import.meta.url));
  for (const path of [dirname(base), base, join(base, 'commands'), directory]) privateStat(path, false);
  if (key.length !== 32 || ref.schema_version !== 1 || !uuid.test(ref.id) || ![ref.spec_sha256, ref.binding_sha256, ref.spec_hmac].every(value => sha.test(value)) ||
      spec.schema_version !== 1 || spec.root !== root || spec.job_id !== ref.id || directory !== join(base, 'commands', ref.id) ||
      !Number.isSafeInteger(spec.owner_pid) || spec.owner_pid < 1 || !disconnected && spec.owner_pid !== process.ppid ||
      digest(bytes) !== ref.spec_sha256 || digest(JSON.stringify(spec.binding)) !== ref.binding_sha256 ||
      !equal(mac(key, 'workforce-command-spec-v1', bytes), ref.spec_hmac) ||
      message && (message.type !== 'start' || JSON.stringify(message.ref) !== JSON.stringify(ref)) ||
      digest(readFileSync(fileURLToPath(import.meta.url))) !== spec.supervisor_sha256 || digest(readFileSync(runner)) !== spec.runner_sha256)
    throw new Error('Unverified durable command spec.');
  return { key, ref, spec, runner };
}
async function run(message) {
  if (running || terminal) return; running = true;
  const { key, ref, spec, runner } = authenticate(message);
  if (message?.cancelled || disconnected || cancelled) { cancelled = true; controller.abort(); }
  // Aborted before admission also has an authenticated interrupted result;
  // the authored executable never starts after its owner has vanished.
  const { runCommand } = await import(pathToFileURL(runner).href);
  const result = await runCommand({ command: spec.command, cwd: spec.cwd, timeout_ms: spec.timeout_ms, max_output_bytes: spec.max_output_bytes,
    stdin: spec.stdin, env: spec.env, signal: controller.signal,
    onStart: pid => { if (process.connected) process.send({ type: 'started', id: ref.id, spec_sha256: ref.spec_sha256, pid }, () => {}); } });
  const payload = { job_id: ref.id, root: spec.root, spec_sha256: ref.spec_sha256, binding_sha256: ref.binding_sha256,
    supervisor_pid: process.pid, finished_at: new Date().toISOString(), reason: disconnected ? 'owner-disconnected' : cancelled ? 'cancelled' : 'completed', result };
  const encoded = JSON.stringify(payload);
  save(join(directory, 'result.json'), JSON.stringify({ schema_version: 1, payload, sha256: digest(encoded), hmac: mac(key, 'workforce-command-result-v1', encoded) }) + '\n');
  terminal = true;
  if (process.connected) process.send({ type: 'finished', id: ref.id, spec_sha256: ref.spec_sha256 }, () => { if (process.connected) process.disconnect(); });
}
function fail() { process.exitCode = 1; if (process.connected) process.disconnect(); }
process.on('disconnect', () => { disconnected = true; if (!terminal) { controller.abort(); void run().catch(fail); } });
process.on('message', message => {
  if (message?.type === 'cancel') { cancelled = true; controller.abort(); return; }
  if (message?.type === 'start') void run(message).catch(fail);
});
if (disconnected) { controller.abort(); void run().catch(fail); }
