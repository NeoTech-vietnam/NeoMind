import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initialize, atomicWrite, createRecord, getRecord, hash, loadRecords, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { beginWorkflow } from '../dist/manager.js';
import { shutdownNative } from '../dist/native.js';
import { startControlledHost, startControlledWorkflow, controlControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';

// Actual private Bridge transport and durable storage; model generation is an
// intentionally pending fixture, not actual Copilot/Codex inference or completion.
class Cancellation {
  constructor() { this.token = { isCancellationRequested: false }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-intake-crash-')));
  initialize(root, { project_id: 'INTAKE', platforms: ['copilot'], max_workers: 3, repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, vscode_effort_policy: 'allow-unavailable' }));
  let requests = 0;
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    CancellationTokenSource: Cancellation, LanguageModelChatToolMode: { Auto: 1 },
    LanguageModelTextPart: class {}, LanguageModelToolCallPart: class {}, LanguageModelToolResultPart: class {},
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (_messages, _options, token) => {
      requests++;
      return { stream: (async function* () { while (!token.isCancellationRequested) await delay(10); })() };
    } }] } };
  let bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, requests: () => requests, restart: async () => {
    await owner.close(); await shutdownNative(root); await bridge.close();
    bridge = await enableVSCodeHost(api, root); owner = await startControlledHost(root);
  } };
}

test('fault after parent creation but before initial journal save recovers the same intake after owner restart', async t => {
  const a = await fixture(t), id = 'INTAKE-KNW-0001', request = 'journal-save-fault', requirements = ['Inspect the existing scalar tooling.', 'Implement one independently checked bounded scalar.'];
  const path = safePath(a.root, `.neomind/controlled/workflows/${hash(id)}.json`);
  // A directory at the final file path injects a real atomic-rename failure.
  // No model dispatch can occur before that initial journal becomes durable.
  mkdirSync(path, { recursive: true });
  await assert.rejects(startControlledWorkflow(a.root, { requirements, request_id: request, title: 'Crash-window intake' }), /refused/);
  const parents = () => loadRecords(a.root).filter(record => record.meta.data.kind === 'manager-workflow');
  assert.equal(parents().length, 1); assert.equal(parents()[0].meta.id, id);
  assert.equal(parents()[0].meta.data.request_id, request);
  assert.equal(a.requests(), 0); assert.equal(loadRecords(a.root).filter(record => record.meta.type === 'task').length, 0);
  await assert.rejects(startControlledWorkflow(a.root, { requirements: [...requirements].reverse(), request_id: request }),
    error => error.code === 'INTAKE_PAYLOAD_MISMATCH');
  await assert.rejects(startControlledWorkflow(a.root, { requirements, request_id: request, title: 'Different title' }),
    error => error.code === 'INTAKE_PAYLOAD_MISMATCH');
  const originalParent = readFileSync(safePath(a.root, getRecord(a.root, id).path));
  assert.equal(dirname(path), safePath(a.root, '.neomind/controlled/workflows'));
  rmdirSync(path); // Only the exact empty fault-injection directory is removed.
  await a.restart();
  const recovered = await startControlledWorkflow(a.root, { requirements, request_id: request, title: 'Crash-window intake' });
  assert.equal(recovered.workflow_id, id); assert.equal(recovered.request_id, request);
  assert.equal(recovered.events[0].kind, 'intake-recovered');
  assert.equal(parents().length, 1);
  assert.deepEqual(readFileSync(safePath(a.root, getRecord(a.root, id).path)), originalParent, 'Recovery preserves the original durable intake.');
  const replay = await startControlledWorkflow(a.root, { requirements, request_id: request, title: 'Crash-window intake' });
  assert.equal(replay.workflow_id, id); assert.equal(replay.epoch_id, recovered.epoch_id);
  assert.equal(parents().length, 1); assert.ok(a.requests() <= 1, 'An intake replay cannot allocate another model session.');
});

test('missing journal with an existing execution task remains uncertain and cannot silently resume or rewrite effects', async t => {
  const a = await fixture(t), request = 'missing-journal-existing-effect', requirement = 'Preserve an execution whose initial journal is missing.';
  const parent = beginWorkflow(a.root, { requirement, request_id: request, execution_mode: 'neomind-controlled' }), epoch = randomUUID();
  atomicWrite(safePath(a.root, 'source/uncertain.txt'), 'Existing side effect must be preserved.\n');
  const task = createRecord(a.root, { type: 'task', title: 'Existing execution task with unknown outcome', owner: 'developer',
    data: { workflow_id: parent.meta.id, process_contract: 'software-tools/v2', epoch_id: epoch, allowed_paths: ['source/uncertain.txt'] } });
  const before = readFileSync(safePath(a.root, task.path));
  const result = await startControlledWorkflow(a.root, { requirement, request_id: request });
  assert.equal(result.workflow_id, parent.meta.id); assert.equal(result.request_id, request); assert.equal(result.epoch_id, epoch);
  assert.equal(result.status, 'uncertain'); assert.equal(result.blocker.code, 'INTAKE_OUTCOME_UNCERTAIN');
  assert.deepEqual(result.intake_recovery.observed_records, [task.meta.id]); assert.equal(a.requests(), 0);
  const retry = await startControlledWorkflow(a.root, { requirement, request_id: request });
  assert.equal(retry.status, 'uncertain'); assert.equal(retry.epoch_id, epoch);
  const resumed = await controlControlledWorkflow(a.root, { workflow_id: parent.meta.id, action: 'resume' });
  assert.equal(resumed.status, 'uncertain'); assert.equal(a.requests(), 0);
  assert.equal(controlledStatus(a.root, parent.meta.id).status, 'uncertain');
  assert.deepEqual(readFileSync(safePath(a.root, task.path)), before);
  assert.equal(readFileSync(safePath(a.root, 'source/uncertain.txt'), 'utf8'), 'Existing side effect must be preserved.\n');
  assert.equal(loadRecords(a.root).filter(record => record.meta.data.kind === 'manager-workflow').length, 1);
});

test('a partial execution receipt prevents fresh dispatch and a different orphan identity is rejected before host calls', async t => {
  const a = await fixture(t), request = 'receipt-fragment-intake', requirement = 'Reconcile this orphaned intake rather than guessing that it never ran.';
  const parent = beginWorkflow(a.root, { requirement, request_id: request, execution_mode: 'neomind-controlled' }), receipt = randomUUID(), epoch = randomUUID();
  // Deliberately incomplete metadata is only an uncertainty signal. It is never
  // treated as a valid signature, authorization, model identity or completion.
  atomicWrite(safePath(a.root, `.neomind/native/receipts/${receipt}.json`), JSON.stringify({ workflow_id: parent.meta.id, controlled_execution: { epoch_id: epoch } }));
  await assert.rejects(startControlledWorkflow(a.root, { workflow_id: parent.meta.id, request_id: 'different-identity' }),
    error => error.code === 'INTAKE_IDENTITY_MISMATCH');
  assert.equal(existsSync(safePath(a.root, `.neomind/controlled/workflows/${hash(parent.meta.id)}.json`)), false);
  const result = await startControlledWorkflow(a.root, { workflow_id: parent.meta.id });
  assert.equal(result.request_id, request); assert.equal(result.status, 'uncertain'); assert.equal(result.epoch_id, epoch);
  assert.deepEqual(result.intake_recovery.observed_invocations, [receipt]); assert.equal(a.requests(), 0);
});

test('durable target traces or unattributed write intents forbid replay even when the receipt and journal are absent', async t => {
  for (const kind of ['trace', 'write-intent']) {
    const a = await fixture(t), request = `orphan-${kind}`, requirement = 'Keep unknown existing execution effects uncertain until reconciled.';
    const parent = beginWorkflow(a.root, { requirement, request_id: request, execution_mode: 'neomind-controlled' }), epoch = randomUUID();
    const path = kind === 'trace' ? `.neomind/controlled/traces/${randomUUID()}.json`
      : `.neomind/controlled-tools/${hash('orphaned-actor')}/writes/${randomUUID()}/intent.json`;
    const bytes = JSON.stringify(kind === 'trace'
      ? { event: 'model-tool-request', workflow_id: parent.meta.id, epoch_id: epoch, backend_binding: { workflow_id: parent.meta.id } }
      : { schema_version: 1, binding_hash: hash('lost-binding'), path: 'source/unknown.txt', previous_hash: null, sha256: hash('unknown side effect') });
    atomicWrite(safePath(a.root, path), bytes);
    const result = await startControlledWorkflow(a.root, { requirement, request_id: request });
    assert.equal(result.status, 'uncertain', kind); assert.equal(result.blocker.code, 'INTAKE_OUTCOME_UNCERTAIN');
    assert.ok(result.intake_recovery.observed_artifacts.includes(path), kind);
    assert.equal(a.requests(), 0); assert.deepEqual(readFileSync(safePath(a.root, path)), Buffer.from(bytes));
    assert.equal((await controlControlledWorkflow(a.root, { workflow_id: parent.meta.id, action: 'resume' })).status, 'uncertain');
  }
});
