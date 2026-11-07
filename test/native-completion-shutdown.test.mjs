import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialize, createRecord, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy, readInvocation, routingProblems } from '../dist/routing.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { startNative, waitNative, shutdownNative, reconcileWorkForceInvocations } from '../dist/native.js';
import { OpenCodeSession } from '../dist/opencode-session.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function ownedCompletion(t, { closeError, actualEngine = false, assessmentOutputs, readContract } = {}) {
  const parent = resolve('artifacts/test-temp'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'wf-native-completion-'));
  initialize(root, { execution_engine: 'opencode' }); ensureRoutingPolicy(root);
  if (actualEngine) {
    const catalog = join(root, 'models.json');
    writeFileSync(catalog, JSON.stringify([{ vendor: 'customendpoint', models: [
      { id: 'worker-models', url: 'http://127.0.0.1:1/v1' }, { id: 'top-models', url: 'http://127.0.0.1:1/v1' },
    ] }]));
    writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify({ ...ensureRoutingPolicy(root), language_models_file: catalog }));
  }
  const workflow = createRecord(root, { type: 'knowledge', title: 'Owned completion ordering', data: { kind: 'manager-workflow' } });
  const task = createRecord(root, { type: 'task', title: 'Retain an observed result while shutdown is reconciled', owner: 'developer', data: { workflow_id: workflow.meta.id } });
  const requestId = randomUUID(), closeEntered = deferred(), closeAllowed = deferred();
  let complete, closes = 0;
  const previous = { open: OpenCodeSession.prototype.open, run: OpenCodeSession.prototype.run, close: OpenCodeSession.prototype.close };
  OpenCodeSession.prototype.open = actualEngine ? previous.open : async function () {
    this.update({ opencode: { version: '1.19.4', binary_sha256: '0'.repeat(64), gateway_instance: '1'.repeat(64) } });
  };
  OpenCodeSession.prototype.run = async function () { complete = this.complete; };
  OpenCodeSession.prototype.close = async function () {
    closes++; closeEntered.resolve(); await closeAllowed.promise;
    if (actualEngine) await previous.close.call(this);
    if (closeError) throw closeError;
  };
  const release = registerControlledContext(root, requestId, { epoch_id: randomUUID(),
    binding: { workflow_id: workflow.meta.id, task_id: task.meta.id, role: 'developer', stage: 'implementation', process_contract: 'workforce/v1',
      ...(assessmentOutputs ? { assessment_outputs: assessmentOutputs } : {}),
      ...(readContract ? { read_contract: readContract } : {}),
      implementation_paths: ['products'], verification_paths: [], read_paths: ['products'], execution_steps: [], procedure_bound: false, cornell_bound: false },
    bindInvocation() {}, callbacks: { assertActive() {}, saveReport() { throw new Error('No model/report call is needed for this lifecycle fixture.'); } } });
  t.after(async () => {
    closeAllowed.resolve();
    await shutdownNative(root).catch(() => {});
    Object.assign(OpenCodeSession.prototype, previous); release();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const receipt = await startNative(root, { role: 'developer', workflow_id: workflow.meta.id, task_id: task.meta.id,
    request_id: requestId, prompt: 'No inference is dispatched. Exercise the owned completion callback and transport shutdown ordering.' });
  assert.equal(typeof complete, 'function');
  return { root, receipt, complete, closeEntered, closeAllowed, get closes() { return closes; } };
}

test('a validated model finish remains observed but does not publish completed before owned shutdown finishes', { timeout: 5000 }, async t => {
  const fixture = await ownedCompletion(t), finishing = fixture.complete('completed', null);
  try {
    await fixture.closeEntered.promise;
    const pending = readInvocation(fixture.root, fixture.receipt.id);
    assert.notEqual(pending.state, 'completed', 'A controller must not advance while engine shutdown is still uncertain.');
    assert.equal(pending.inference_completed, true, 'Observed model completion and engine shutdown are separate facts.');
  } finally { fixture.closeAllowed.resolve(); await finishing; }
  const ended = await waitNative(fixture.root, fixture.receipt.id, 1000);
  assert.equal(ended.state, 'completed'); assert.equal(ended.inference_completed, true); assert.equal(ended.error, null);
  assert.equal(fixture.closes, 1);
});

test('unknown engine shutdown retains actual completed inference without an unhandled cleanup rejection or false success', { timeout: 5000 }, async t => {
  const fixture = await ownedCompletion(t, { closeError: new Error('OpenCode shutdown has no authenticated ended proof; preserve the invocation for reconciliation.') });
  const finishing = fixture.complete('completed', null);
  await fixture.closeEntered.promise; fixture.closeAllowed.resolve(); await finishing;
  const ended = await waitNative(fixture.root, fixture.receipt.id, 1000);
  assert.equal(ended.state, 'blocked'); assert.equal(ended.inference_completed, true);
  assert.match(ended.error, /shutdown has no authenticated ended proof/);
  assert.match(ended.opencode.shutdown_failure.message_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.closes, 1);
});

test('failed inference and failed cleanup preserve the primary refusal without inventing completed inference', { timeout: 5000 }, async t => {
  const fixture = await ownedCompletion(t, { closeError: new Error('Fixture shutdown proof is pending.') });
  await fixture.complete('blocked', 'The actual model did not finish.');
  await fixture.closeEntered.promise; fixture.closeAllowed.resolve();
  const ended = await waitNative(fixture.root, fixture.receipt.id, 1000);
  assert.equal(ended.state, 'blocked'); assert.equal(ended.inference_completed, false);
  assert.equal(ended.error, 'The actual model did not finish.');
  assert.match(ended.opencode.shutdown_failure.message_sha256, /^[a-f0-9]{64}$/);
});

test('a duplicate or late terminal callback cannot overwrite an owned refusal during shutdown', { timeout: 5000 }, async t => {
  const fixture = await ownedCompletion(t);
  await fixture.complete('blocked', 'The owned result was refused.');
  await fixture.closeEntered.promise;
  await fixture.complete('completed', null);
  fixture.closeAllowed.resolve();
  const ended = await waitNative(fixture.root, fixture.receipt.id, 1000);
  assert.equal(ended.state, 'blocked'); assert.equal(ended.inference_completed, false);
  assert.equal(ended.error, 'The owned result was refused.'); assert.equal(fixture.closes, 1);
});

for (const assigned of [false, true]) test(`signed v3 gateway reconstructs ${assigned ? 'explicit assigned reads' : 'historical scope without new read authority'}`, { timeout: 5000 }, async t => {
  const fixture = await ownedCompletion(t, { ...(assigned ? { assessmentOutputs: ['products/current.txt'] } : {}) });
  const receipt = readInvocation(fixture.root, fixture.receipt.id);
  assert.equal(receipt.controlled_execution.tool_contract.assigned_read, assigned ? true : undefined);
  assert.equal(receipt.native_tool_scope.includes('assignment_read'), assigned);
  const problems = routingProblems(fixture.root, 'developer', receipt.id, { workflow_id: receipt.workflow_id, task_id: receipt.task_id, require_completed: false });
  // The session-open fixture does not fabricate model/thread provenance; this
  // assertion isolates the real signed gateway reconstruction boundary.
  assert.deepEqual(problems.filter(problem => /tool contract|gateway|scope differs/i.test(problem)), []);
});

for (const contract of [undefined, 'opaque-pages', 'legacy-selectors']) test(`signed gateway binds ${contract ?? 'default opaque-pages'} while retaining legacy read scope`, { timeout: 5000 }, async t => {
  const fixture = await ownedCompletion(t, { readContract: contract, assessmentOutputs: ['products/current.txt'] });
  const receipt = readInvocation(fixture.root, fixture.receipt.id), opaque = contract !== 'legacy-selectors';
  assert.equal(receipt.controlled_execution.tool_contract.read_contract, opaque ? 'opaque-pages' : undefined);
  assert.equal(receipt.native_tool_scope.includes('project_read_more'), opaque);
  assert.equal(receipt.controlled_execution.tool_contract.assigned_read, true);
  assert.equal(receipt.native_tool_scope.includes('assignment_read'), true);
  const problems = routingProblems(fixture.root, 'developer', receipt.id, { workflow_id: receipt.workflow_id, task_id: receipt.task_id, require_completed: false });
  assert.deepEqual(problems.filter(problem => /tool contract|gateway|scope differs/i.test(problem)), []);
});

test('an authenticated process-tree exit reconciles retained observed inference without another model invocation', { timeout: 90000 }, async t => {
  // Only the terminal callback is scripted. Engine creation, shutdown and its
  // signed process-tree exit proof are real; run never submits a model prompt.
  const fixture = await ownedCompletion(t, { actualEngine: true, closeError: new Error('Fixture lost shutdown acknowledgment after actual owned engine exit.') });
  const finishing = fixture.complete('completed', null);
  await fixture.closeEntered.promise; fixture.closeAllowed.resolve(); await finishing;
  const pending = await waitNative(fixture.root, fixture.receipt.id, 1000);
  assert.equal(pending.state, 'blocked'); assert.equal(pending.inference_completed, true);
  const diagnostic = pending.opencode.shutdown_failure;
  const observed = await reconcileWorkForceInvocations(fixture.root, pending.workflow_id);
  assert.equal(observed.find(item => item.id === pending.id)?.state, 'stopped');
  const final = readInvocation(fixture.root, pending.id);
  assert.equal(final.state, 'completed'); assert.equal(final.inference_completed, true); assert.equal(final.error, null);
  assert.match(final.opencode.interruption_proof_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(final.opencode.shutdown_failure, diagnostic, 'Historical cleanup uncertainty remains in sanitized diagnostics.');
  assert.deepEqual(await reconcileWorkForceInvocations(fixture.root, final.workflow_id), []);
});
