// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runCommand } from '../dist/command-runner.js';
import { createRecord, hash } from '../dist/storage.js';
import { runCheck, runCheckAsync } from '../dist/engineering.js';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-command-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('command runner captures argv without a shell and filters inherited environment', async t => {
  const root = workspace(t), key = 'NEOMIND_RUNNER_PRIVATE_TEST';
  const previous = process.env[key]; process.env[key] = 'must-not-reach-child';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const result = await runCommand({ cwd: root, command: [process.execPath, '-e',
    `console.log(JSON.stringify({private:process.env.${key},provided:process.env.NEOMIND_RUNNER_ALLOWED,args:process.argv.slice(1)}))`,
    'literal; $() & value'], env: { NEOMIND_RUNNER_ALLOWED: 'explicit' } });
  assert.equal(result.exit_code, 0);
  assert.equal(result.error, null);
  assert.deepEqual(JSON.parse(result.stdout), { provided: 'explicit', args: ['literal; $() & value'] });
  assert.equal(result.cancelled, false);
  assert.equal(result.timed_out, false);
});

test('nonzero exits and spawn failures are results, not false successes', async t => {
  const root = workspace(t);
  const failed = await runCommand({ cwd: root, command: [process.execPath, '-e', 'process.stderr.write("failed"); process.exit(7)'] });
  assert.equal(failed.exit_code, 7); assert.equal(failed.stderr, 'failed');
  const missing = await runCommand({ cwd: root, command: ['neomind-no-such-executable-359792'] });
  assert.equal(missing.exit_code, null); assert.match(missing.error, /ENOENT|not found/i);
});

test('pre-cancelled execution never starts a process', async t => {
  const root = workspace(t), controller = new AbortController(); controller.abort();
  let started = false;
  const result = await runCommand({ cwd: root, command: [process.execPath, '-e', 'process.exit(0)'], signal: controller.signal, onStart: () => { started = true; } });
  assert.equal(started, false); assert.equal(result.cancelled, true); assert.equal(result.exit_code, null);
});

test('deadline and output limits cannot become passing exits', async t => {
  const root = workspace(t);
  const timed = await runCommand({ cwd: root, command: [process.execPath, '-e', 'setInterval(()=>{}, 1000)'], timeout_ms: 100 });
  assert.equal(timed.timed_out, true); assert.match(timed.error, /time/i);
  const capped = await runCommand({ cwd: root, command: [process.execPath, '-e', 'process.stdout.write("a".repeat(2048)); setInterval(()=>{}, 1000)'], max_output_bytes: 512 });
  assert.equal(capped.output_limited, true); assert.ok(Buffer.byteLength(capped.stdout) + Buffer.byteLength(capped.stderr) <= 512);
  assert.match(capped.error, /output/i);
  const invalidText = await runCommand({ cwd: root, command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(2048,255)); setInterval(()=>{},1000)'], max_output_bytes: 512 });
  assert.equal(invalidText.output_limited, true);
  assert.ok(Buffer.byteLength(invalidText.stdout) + Buffer.byteLength(invalidText.stderr) <= 512);
});

test('cancellation keeps the event loop responsive and terminates descendant processes', async t => {
  const root = workspace(t), marker = join(root, 'descendant.pid'), controller = new AbortController();
  const grandchild = 'setInterval(()=>{},1000)';
  const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid)); setInterval(()=>{},1000)`;
  const execution = runCommand({ cwd: root, command: [process.execPath, '-e', parent], signal: controller.signal, timeout_ms: 10000 });
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(existsSync(marker), 'async runner must not block the event loop');
  const pid = Number(readFileSync(marker, 'utf8'));
  controller.abort();
  const result = await execution;
  assert.equal(result.cancelled, true); assert.match(result.error, /cancel/i);
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) alive = false;
    } catch { alive = false; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, 'cancel must stop the owned descendant as well as its parent');
});

test('invalid runner input and executable-loader environment overrides are rejected', async t => {
  const root = workspace(t);
  await assert.rejects(runCommand({ cwd: root, command: [] }), /command/i);
  await assert.rejects(runCommand({ cwd: root, command: [process.execPath], timeout_ms: -1 }), /timeout/i);
  await assert.rejects(runCommand({ cwd: root, command: [process.execPath], env: { NODE_OPTIONS: '--require=untrusted' } }), /environment/i);
});

function checkFixture(t, command) {
  const root = workspace(t);
  initialize(root, { project_id: 'ASYNCCHECK', profile: 'basic' });
  writeFileSync(join(root, 'value.txt'), 'one\n');
  const requirement = createRecord(root, { type: 'requirement', title: 'Persist the value one',
    data: { acceptance_criteria: ['The value is one.'] } });
  const task = createRecord(root, { type: 'task', title: 'Write one', owner: 'developer',
    data: { allowed_paths: ['value.txt'], acceptance_criteria: ['The value is one.'] },
    links: [{ type: 'satisfies', target: requirement.meta.id }] });
  const check = createRecord(root, { type: 'check', title: 'Verify the saved one', owner: 'verifier',
    data: { command, baseline_paths: ['value.txt'] }, links: [{ type: 'verifies', target: requirement.meta.id }] });
  return { root, task, check };
}

test('async verification shares legacy scope, immutable baselines and evidence receipts', async t => {
  const { root, task, check } = checkFixture(t, [process.execPath, '-e',
    'if(require("node:fs").readFileSync("value.txt","utf8")!=="one\\n")process.exit(1)']);
  const evidence = await runCheckAsync(root, check.meta.id, task.meta.id);
  assert.equal(evidence.meta.data.result, 'pass');
  assert.equal(evidence.meta.data.file_baseline['value.txt'], hash(readFileSync(join(root, 'value.txt'))));
  assert.deepEqual(evidence.meta.data.command_execution, { cancelled: false, timed_out: false, output_limited: false });
  assert.equal(hash(readFileSync(join(root, evidence.meta.data.log_path))), evidence.meta.data.log_hash);
  const legacy = runCheck(root, check.meta.id, task.meta.id);
  assert.equal(legacy.meta.data.result, 'pass');
  assert.deepEqual(evidence.meta.data.file_baseline, legacy.meta.data.file_baseline);
  const unrelated = createRecord(root, { type: 'task', title: 'Unrelated task', owner: 'developer' });
  let started = false;
  await assert.rejects(runCheckAsync(root, check.meta.id, unrelated.meta.id, undefined, { onStart: () => { started = true; } }), /does not verify/i);
  assert.equal(started, false);
});

test('cancelled async verification persists failed evidence with the real termination cause', async t => {
  const { root, task, check } = checkFixture(t, [process.execPath, '-e', 'setInterval(()=>{},1000)']);
  const controller = new AbortController();
  const evidence = await runCheckAsync(root, check.meta.id, task.meta.id, undefined,
    { signal: controller.signal, onStart: () => setTimeout(() => controller.abort(), 25) });
  assert.equal(evidence.meta.data.result, 'fail');
  assert.equal(evidence.meta.data.command_execution.cancelled, true);
  assert.match(readFileSync(join(root, evidence.meta.data.log_path), 'utf8'), /cancelled/i);
});
