import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { runDurableCommand, readDurableCommandResult } from '../dist/durable-command.js';

const temporary = resolve('artifacts/test-temp');
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const bound = suffix => ({ workflow_id: `WF-request-${suffix}`, epoch_id: 'epoch-1', attempt_id: 'attempt-1', operation_id: `op-${suffix}`, kind: 'check' });
function privateFolder(root) {
  const physical = realpathSync.native(root), identity = `${userInfo().username}\0${process.platform === 'win32' ? physical.toLowerCase() : physical}`;
  return join(dirname(physical), '.workforce-private', createHash('sha256').update(identity).digest('hex'));
}
function fixture(t) {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'durable-command-')), privatePath = privateFolder(root);
  t.after(() => {
    assert.equal(dirname(resolve(root)), temporary);
    assert.equal(dirname(privatePath), join(temporary, '.workforce-private'));
    rmSync(privatePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}
async function until(read, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await pause(40); }
  assert.fail('Timed out waiting for the actual durable command event.');
}
const node = (script, ...args) => [process.execPath, '-e', script, ...args];

test('durable command commits its backend reference before spawn and verifies its actual final result', { timeout: 30000 }, async t => {
  const root = fixture(t), binding = bound('complete'), marker = join(root, 'effect.txt');
  let ref, started;
  const result = await runDurableCommand(root, { binding, cwd: root,
    command: node(`require('node:fs').writeFileSync(process.argv[1],'effect');process.stdout.write('hello');process.stderr.write('diagnostic');process.exitCode=7`, marker),
    env: { WF_APPROVED_VALUE: 'bounded' }, onStart: pid => { started = pid; } },
  { onPrepared: job => {
    assert.equal(existsSync(marker), false);
    assert.equal(readDurableCommandResult(root, job, binding), undefined);
    ref = job;
  } });
  assert.ok(Number.isSafeInteger(started));
  assert.equal(result.exit_code, 7); assert.equal(result.stdout, 'hello'); assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.durable_state, 'completed'); assert.equal(result.cancelled, false);
  assert.equal(readFileSync(marker, 'utf8'), 'effect');
  assert.deepEqual(readDurableCommandResult(root, ref, binding), result);
  assert.equal(Object.keys(ref).sort().join(','), 'binding_sha256,id,schema_version,spec_hmac,spec_sha256');
  assert.ok(!JSON.stringify(ref).includes('WF_APPROVED_VALUE'));
});

test('durable Windows compiler launch is frozen before admission while authored argv remains unchanged', {
  timeout: 30000,
  skip: process.platform !== 'win32' || !existsSync('C:/msys64/mingw64/bin/gcc.exe'),
}, async t => {
  const root = fixture(t), binding = bound('bare-compiler'), output = join(root, 'hello.exe');
  writeFileSync(join(root, 'hello.c'), 'int main(void) { return 0; }\n');
  const command = ['gcc', '-std=c11', '-Wall', '-Wextra', '-Werror', 'hello.c', '-o', output];
  const authored = [...command];
  let prepared;
  const result = await runDurableCommand(root, { binding, cwd: root, command,
    env: { Path: join(process.env.SystemRoot ?? 'C:/Windows', 'System32') } }, {
    onPrepared: job => {
      assert.equal(existsSync(output), false, 'The compiler cannot run before its controller admission.');
      const spec = JSON.parse(readFileSync(join(privateFolder(root), 'commands', job.id, 'spec.json'), 'utf8'));
      assert.deepEqual(spec.command, authored);
      assert.ok(Array.isArray(spec.resolved_command), 'The exact installed compiler must already be frozen in its authenticated spec.');
      assert.match(spec.resolved_command[0], /msys64[\\/](?:ucrt64|mingw64|clang64)[\\/]bin[\\/]gcc\.exe$/i);
      assert.deepEqual(spec.resolved_command.slice(1), authored.slice(1));
      prepared = job;
    },
  });
  assert.deepEqual(command, authored);
  assert.equal(result.exit_code, 0, result.stderr || result.error);
  assert.equal(result.error, null);
  assert.equal(existsSync(output), true);
  assert.deepEqual(readDurableCommandResult(root, prepared, binding), result);
});

test('an unavailable compiler cannot adopt a new PATH or working-directory binary after admission', {
  timeout: 30000, skip: process.platform !== 'win32',
}, async t => {
  const root = fixture(t), bin = join(root, 'new-bin'), marker = join(root, 'must-not-run.txt');
  mkdirSync(bin);
  const drive = ['Z:', 'Y:', 'X:'].find(value => !existsSync(`${value}/msys64`));
  assert.ok(drive, 'The negative fixture requires one absent conventional MSYS2 drive.');
  const command = ['gcc', '-e', 'require("node:fs").writeFileSync(process.argv[1],"wrong")', marker];
  const result = await runDurableCommand(root, { binding: bound('unavailable-compiler'), cwd: root, command,
    env: { Path: bin, SystemDrive: drive } }, {
    onPrepared: job => {
      const spec = JSON.parse(readFileSync(join(privateFolder(root), 'commands', job.id, 'spec.json'), 'utf8'));
      assert.equal(spec.resolved_command, null, 'Absence is frozen before controller admission too.');
      // An actual harmless Node executable has the missing compiler's name.
      // Rediscovering it after admission would execute the marker-writing code.
      copyFileSync(process.execPath, join(bin, 'gcc.exe'));
      copyFileSync(process.execPath, join(root, 'gcc.exe'));
    },
  });
  assert.equal(result.exit_code, null);
  assert.equal(result.error, 'Command could not start (ENOENT).');
  assert.equal(result.durable_reason, 'completed');
  assert.equal(existsSync(marker), false);
});

test('failed onPrepared never starts an authored command and does not invent a final result', { timeout: 30000 }, async t => {
  const root = fixture(t), binding = bound('not-admitted'), marker = join(root, 'unexpected.txt');
  let ref;
  await assert.rejects(runDurableCommand(root, { binding, cwd: root,
    command: node(`require('node:fs').writeFileSync(process.argv[1],'unexpected')`, marker) },
  { onPrepared: job => { ref = job; throw new Error('Controller checkpoint failed.'); } }), /Controller checkpoint failed/);
  await pause(150);
  assert.equal(existsSync(marker), false);
  assert.equal(readDurableCommandResult(root, ref, binding), undefined);
});

test('command temporary directories default to private project volume and retain explicit approved overrides', { timeout: 30000 }, async t => {
  const root = fixture(t), binding = bound('temporary');
  const command = node(`process.stdout.write(JSON.stringify({TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR}))`);
  const defaults = await runDurableCommand(root, { binding, cwd: root, command });
  const observed = JSON.parse(defaults.stdout), expected = join(privateFolder(root), 'commands', defaults.durable_job.id, 'tmp');
  assert.deepEqual(observed, { TEMP: expected, TMP: expected, TMPDIR: expected }); assert.equal(existsSync(expected), true);
  const approved = join(root, 'approved-temp'); mkdirSync(approved);
  const overridden = await runDurableCommand(root, { binding: bound('temporary-override'), cwd: root, command, env: { TEMP: approved, TMP: approved, TMPDIR: approved } });
  assert.deepEqual(JSON.parse(overridden.stdout), { TEMP: approved, TMP: approved, TMPDIR: approved });
});

test('durable result is bound to exact spec, operation and authenticated output bytes', { timeout: 30000 }, async t => {
  const root = fixture(t), binding = bound('authentication');
  const result = await runDurableCommand(root, { binding, cwd: root, command: node(`process.stdout.write('actual')`) });
  assert.throws(() => readDurableCommandResult(root, result.durable_job, { ...binding, workflow_id: 'another-request' }), /another operation binding/);
  assert.throws(() => readDurableCommandResult(root, { ...result.durable_job, spec_sha256: '0'.repeat(64) }, binding), /spec identity changed/);
  const path = join(privateFolder(root), 'commands', result.durable_job.id, 'result.json');
  const envelope = JSON.parse(readFileSync(path, 'utf8')); envelope.payload.result.stdout = 'fabricated';
  writeFileSync(path, JSON.stringify(envelope));
  assert.throws(() => readDurableCommandResult(root, result.durable_job, binding), /authentication failed/);
});

test('actual timeout, output limit and cancellation persist bounded command results', { timeout: 60000 }, async t => {
  const root = fixture(t);
  const timeout = await runDurableCommand(root, { binding: bound('timeout'), cwd: root, command: node('setInterval(()=>{},1000)'), timeout_ms: 100 });
  assert.equal(timeout.timed_out, true); assert.equal(timeout.cancelled, false);
  const limited = await runDurableCommand(root, { binding: bound('output'), cwd: root, command: node(`process.stdout.write('x'.repeat(100000))`), max_output_bytes: 127 });
  assert.equal(limited.output_limited, true); assert.ok(Buffer.byteLength(limited.stdout) + Buffer.byteLength(limited.stderr) <= 127);
  const controller = new AbortController();
  const cancelled = await runDurableCommand(root, { binding: bound('cancel'), cwd: root, command: node('setInterval(()=>{},1000)'),
    signal: controller.signal, onStart: () => controller.abort() });
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.durable_state, 'interrupted');
});

test('killing the actual command owner interrupts its process tree and leaves an authenticated restart result', { timeout: 45000 }, async t => {
  const root = fixture(t), binding = bound('owner-crash'), prepared = join(root, 'prepared.json');
  const childMarker = join(root, 'child.json'), grandMarker = join(root, 'grandchild.json'), heartbeat = join(root, 'heartbeat.txt');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>fs.appendFileSync(process.argv[2],'g'),30);`;
  const command = node(`const fs=require('node:fs');const{spawn}=require('node:child_process');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));spawn(process.execPath,['-e',process.argv[4],process.argv[2],process.argv[3]],{stdio:'inherit'});setInterval(()=>fs.appendFileSync(process.argv[3],'c'),30);`, childMarker, grandMarker, heartbeat, descendant);
  const ownerScript = `import{runDurableCommand}from${JSON.stringify(new URL('../dist/durable-command.js', import.meta.url).href)};import{writeFileSync}from'node:fs';await runDurableCommand(${JSON.stringify(root)},${JSON.stringify({ binding, command, cwd: root, timeout_ms: 30000 })},{onPrepared:ref=>writeFileSync(${JSON.stringify(prepared)},JSON.stringify(ref))});`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerScript], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errorOutput = ''; owner.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  await until(() => existsSync(prepared) && existsSync(childMarker) && existsSync(grandMarker));
  const ref = JSON.parse(readFileSync(prepared, 'utf8'));
  assert.equal(readDurableCommandResult(root, ref, binding), undefined);
  assert.equal(owner.kill('SIGKILL'), true);
  const result = await until(() => readDurableCommandResult(root, ref, binding), 15000);
  assert.equal(result.durable_state, 'interrupted', errorOutput); assert.equal(result.cancelled, true);
  assert.notEqual(result.exit_code, 0);
  const envelope = JSON.parse(readFileSync(join(privateFolder(root), 'commands', ref.id, 'result.json'), 'utf8'));
  assert.equal(envelope.payload.reason, 'owner-disconnected');
  const stoppedAt = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : '';
  await pause(250);
  assert.equal(existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : '', stoppedAt, 'The child and descendant must stop writing after the owner crash.');
  assert.deepEqual(readDurableCommandResult(root, ref, binding), result, 'Restart consumes authenticated result; PID absence is not completion evidence.');
});
