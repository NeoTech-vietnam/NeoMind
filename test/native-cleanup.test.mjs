import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeBridge, interruptNative, shutdownNative } from '../dist/native.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { initialize } from '../dist/storage.js';

const fixture = fileURLToPath(new URL('../resources/native/fake-app-server.mjs', import.meta.url));
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-native-cleanup-'));
  initialize(root, { project_id: 'NATIVE-CLEANUP-TEST' });
  ensureRoutingPolicy(root);
  t.after(async () => {
    await shutdownNative(root);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function bridge(scenario, executable = fixture, gate) {
  return createNativeBridge({ rpc_timeout_ms: 10_000, runtime: async () => ({
    version: '0.162.1', command: process.execPath,
    args: [executable, scenario, ...(gate ? [gate] : [])],
    integrity: 'protocol-fixture', protocol_sha256: 'protocol-fixture',
    executable_sha256: 'protocol-fixture', test_fixture: true,
  }) });
}
function holdBlockedTransport(t) {
  const originalKill = ChildProcess.prototype.kill, held = new Map();
  let released = false;
  const mockedKill = t.mock.method(ChildProcess.prototype, 'kill', function (...args) {
    if (!released && this.spawnargs.includes('explicit-tool-policy')) {
      held.set(this, args);
      return true;
    }
    return originalKill.apply(this, args);
  });
  return {
    release() {
      released = true;
      for (const [child, args] of held) originalKill.apply(child, args);
      held.clear();
    },
    restore() { mockedKill.mock.restore(); },
  };
}
function assertBlockedPreserved(root, before) {
  const after = readInvocation(root, before.id);
  assert.equal(after.state, 'blocked');
  assert.equal(after.error, before.error);
  assert.equal(after.owner_pid, before.owner_pid);
  assert.equal(after.inference_completed, false);
}

test('shutdown skips an owned session removed while an earlier snapshot entry awaits transport closure', async t => {
  const root = project(t), gate = join(root, 'interrupt-gate'), executable = join(root, 'gated-server.mjs');
  const source = readFileSync(fixture, 'utf8'), interrupt = "  if (method === 'turn/interrupt') {";
  assert.ok(source.includes(interrupt));
  writeFileSync(executable, "import { existsSync } from 'node:fs';\n" + source.replace(interrupt, `${interrupt}
    const gateDeadline = Date.now() + 10_000;
    while (!existsSync(process.argv[3])) {
      if (Date.now() > gateDeadline) throw new Error('Fixture interrupt gate timed out.');
      await new Promise(done => setTimeout(done, 5));
    }`));
  const native = bridge('hang', executable, gate);
  const first = await native.start(root, { role: 'reviewer', prompt: 'Observe owned cleanup only.' });
  assert.equal(first.state, 'running');
  const held = holdBlockedTransport(t);
  let stopping;
  try {
    const second = await bridge('explicit-tool-policy').start(root, { role: 'reviewer', prompt: 'Observe authored approval refusal.' });
    assert.equal(second.state, 'blocked');
    // Both sessions are in shutdown's snapshot. Keep the first interrupt pending
    // until the second's own asynchronous cleanup has removed its active entry.
    stopping = shutdownNative(root).then(() => null, error => error);
    held.release();
    await native.wait(root, second.id, 5_000);
    assert.throws(() => process.kill(second.server_pid, 0), { code: 'ESRCH' });
    writeFileSync(gate, 'release');
    assert.equal(await stopping, null);
    assert.equal(readInvocation(root, first.id).state, 'interrupted');
    assertBlockedPreserved(root, second);
  } finally {
    held.release();
    writeFileSync(gate, 'release');
    if (stopping) await stopping;
    held.restore();
  }
});

test('shutdown awaits an already closing owned blocked session without rewriting its refusal', async t => {
  const root = project(t), held = holdBlockedTransport(t);
  let stopping;
  try {
    const blocked = await bridge('explicit-tool-policy').start(root, { role: 'reviewer', prompt: 'Preserve the authored approval refusal.' });
    assert.equal(blocked.state, 'blocked');
    assert.match(blocked.error, /Authored NeoMind tool approval policy/);
    stopping = shutdownNative(root).then(() => null, error => error);
    held.release();
    assert.equal(await stopping, null);
    assertBlockedPreserved(root, blocked);
  } finally {
    held.release();
    if (stopping) await stopping;
    held.restore();
  }
});

test('owned shutdown does not authorize interruption of a live foreign native transport', async t => {
  const root = project(t);
  const nativeModule = new URL('../dist/native.js', import.meta.url).href;
  const program = `import { createNativeBridge, shutdownNative } from ${JSON.stringify(nativeModule)};
    const root = process.argv[1];
    const native = createNativeBridge({ rpc_timeout_ms: 5000, runtime: async () => ({
      version: '0.162.1', command: process.execPath, args: [process.argv[2], 'hang'],
      integrity: 'protocol-fixture', protocol_sha256: 'protocol-fixture', executable_sha256: 'protocol-fixture', test_fixture: true,
    }) });
    const receipt = await native.start(root, { role: 'reviewer', prompt: 'Observe foreign ownership refusal only.' });
    console.log(JSON.stringify({ id: receipt.id, state: receipt.state }));
    process.stdin.resume();
    await new Promise(done => process.stdin.once('end', done));
    await shutdownNative(root);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, root, fixture], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise((fulfill, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => fulfill({ code, signal }));
  });
  try {
    const observed = await new Promise((fulfill, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Foreign fixture startup timed out.')), 10_000);
      child.stdout.on('data', data => {
        output += data;
        if (output.length > 1024) { clearTimeout(timer); reject(new Error('Unexpected foreign fixture output size.')); }
        else if (output.includes('\n')) {
          clearTimeout(timer);
          try { fulfill(JSON.parse(output.slice(0, output.indexOf('\n')))); }
          catch { reject(new Error('Invalid foreign fixture startup observation.')); }
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(observed.state, 'running');
    const before = readInvocation(root, observed.id);
    assert.equal(before.owner_pid, child.pid);
    await assert.rejects(interruptNative(root, observed.id), /live native transport is owned by another process/);
    await shutdownNative(root);
    const after = readInvocation(root, observed.id);
    assert.equal(after.state, 'running');
    assert.equal(after.owner_pid, child.pid);
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 10_000);
    try { assert.equal((await exited).code, 0); }
    finally { clearTimeout(timer); }
  }
});
