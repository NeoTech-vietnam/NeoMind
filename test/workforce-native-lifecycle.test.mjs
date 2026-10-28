import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, safePath, createRecord } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation } from '../dist/routing.js';
import { reconcileWorkForceInvocations, interruptNative } from '../dist/native.js';

test('actual owner death reconciles a signed OpenCode invocation only from its authenticated process-tree exit', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wf-native-owner-'));
  initialize(root, { execution_engine: 'opencode' });
  const catalog = join(root, 'models.json');
  writeFileSync(catalog, JSON.stringify([{ vendor: 'customendpoint', apiKey: 'lifecycle-test-unused',
    models: [{ id: 'worker-models', url: 'http://127.0.0.1:1/v1' }, { id: 'top-models', url: 'http://127.0.0.1:1/v1' }] }]));
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify({ ...ensureRoutingPolicy(root), language_models_file: catalog }));
  const workflow = createRecord(root, { type: 'knowledge', title: 'Lifecycle proof without inference', data: { kind: 'manager-workflow' } });
  const task = createRecord(root, { type: 'task', owner: 'developer', title: 'Preserve partial output on owner crash', data: { workflow_id: workflow.meta.id } });
  mkdirSync(join(root, 'products')); writeFileSync(join(root, 'products/partial.txt'), 'A real useful checkpoint remains.');
  const owner = fork(fileURLToPath(new URL('./helpers/workforce-native-owner.mjs', import.meta.url)), [root, workflow.meta.id, task.meta.id],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  t.after(() => { if (owner.exitCode === null && !owner.killed) owner.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); });
  const [opened] = await once(owner, 'message', { signal: AbortSignal.timeout(80000) });
  assert.equal(opened.failed, undefined); assert.equal(opened.state, 'running'); assert.equal(opened.supervision, true);
  const active = readInvocation(root, opened.id);
  assert.equal(active.issuer, 'workforce-opencode');
  const before = await reconcileWorkForceInvocations(root, workflow.meta.id);
  assert.equal(before.find(item => item.id === opened.id)?.state, 'still_live');
  assert.equal(readInvocation(root, opened.id).state, 'running');
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  let proof;
  const deadline = Date.now() + 20000;
  do {
    proof = (await reconcileWorkForceInvocations(root, workflow.meta.id)).find(item => item.id === opened.id);
    if (proof?.state === 'stopped') break;
    await new Promise(done => setTimeout(done, 100));
  } while (Date.now() < deadline);
  assert.equal(proof?.state, 'stopped'); assert.match(proof.proof_sha256, /^[a-f0-9]{64}$/);
  const interrupted = readInvocation(root, opened.id);
  assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.inference_completed, false);
  assert.equal(interrupted.opencode.interruption_proof_sha256, proof.proof_sha256);
  assert.equal(existsSync(join(root, 'products/partial.txt')), true);
  assert.deepEqual(await interruptNative(root, opened.id), interrupted);
  assert.deepEqual(await reconcileWorkForceInvocations(root, workflow.meta.id), []);
});
