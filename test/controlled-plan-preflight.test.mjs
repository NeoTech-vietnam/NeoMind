import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, createRecord, getRecord, hash, loadRecords, safePath, updateRecord } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { atomicWrite } from '../dist/storage.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { readHost, hostRequest } from '../dist/vscode-wire.js';
import { shutdownNative } from '../dist/native.js';
import { ownedContext } from '../dist/controlled-context.js';
import { startControlledHost, startControlledWorkflow, controlControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }
const plan = paths => ({ title: 'Bounded scalar plan', objective: 'Write integer one.', rationale: 'A bounded independently checked output.',
  acceptance_criteria: ['The output is integer one.'], allowed_paths: ['source/value.txt'], verification_paths: ['checks'],
  outputs: ['source/value.txt'], documentation_paths: [], risk: 'low', preservation_paths: paths,
  checks: [{ title: 'Check integer', command: [process.execPath, 'checks/check.cjs', 'source/value.txt'], baseline_paths: ['source/value.txt', 'checks/check.cjs'],
    negative_controls: [{ title: 'Reject two', command: [process.execPath, 'checks/check.cjs', 'checks/two.txt'], baseline_paths: ['checks/check.cjs', 'checks/two.txt'], expected_exit_code: 1 }] }] });
async function fixture(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-plan-preflight-')));
  initialize(root, { project_id: 'PREFLIGHT', platforms: ['copilot'], repair_attempts: 1 });
  const policy = ensureRoutingPolicy(root); atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, vscode_effort_policy: 'allow-unavailable' }));
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: class {}, LanguageModelToolCallPart: class {}, LanguageModelToolResultPart: class {}, LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (_messages, _options, token) => ({
      stream: (async function* () { while (!token.isCancellationRequested) await delay(10); })(),
    }) }] } };
  const bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await bridge.close(); assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const initial = await startControlledWorkflow(root, { requirement: 'Create a bounded scalar with separate independent checking.', request_id: 'preflight-fixture' });
  const deadline = Date.now() + 30000; let context, run;
  do { run = controlledStatus(root, initial.workflow_id); const attempt = run.attempts.at(-1); context = attempt?.state === 'running' ? ownedContext(root, attempt.request_id) : null;
    if (!context) await delay(10);
  } while (!context && Date.now() < deadline);
  assert.ok(context, 'The actual owning signed session must register the planner callback.');
  return { root, context, run, taskRecords: () => loadRecords(root).filter(record => record.meta.type === 'task'),
    contractPath: safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`) };
}
function tree(root, count = 128) {
  mkdirSync(join(root, 'preserved'));
  for (let index = 0; index < count; index++) writeFileSync(join(root, 'preserved', `${index}.txt`), `unchanged ${index}\n`);
}

test('plan preflight yields to the actual shared Bridge and saves a compatible frozen baseline', async t => {
  const a = await fixture(t); tree(a.root); let finished = false; const descriptor = readHost(a.root);
  const pending = a.context.callbacks.submitPlan(plan(['preserved'])).then(value => { finished = true; return value; });
  const response = await hostRequest(descriptor, 'controlled-status', { workflow_id: a.run.workflow_id });
  assert.equal(response.workflow_id, a.run.workflow_id); assert.equal(finished, false, 'A second Bridge client responds while the large preservation scan is still running.');
  assert.equal((await pending).saved, true);
  const contract = JSON.parse(readFileSync(a.contractPath, 'utf8'));
  assert.equal(Object.keys(contract.preserved_hashes).length, 128);
  assert.equal(contract.preserved_hashes['preserved/0.txt'], hash('unchanged 0\n'));
  assert.equal(a.taskRecords().length, 1);
});

test('fingerprint failure occurs before TASK or immutable contract side effects', async t => {
  const a = await fixture(t); writeFileSync(join(a.root, 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(a.context.callbacks.submitPlan(plan(['oversized.bin'])), error => error.code === 'PLAN_INVALID' && /per-file byte limit.*oversized.bin/.test(error.message));
  assert.equal(a.taskRecords().length, 0); assert.equal(existsSync(a.contractPath), false);
  assert.equal(controlledStatus(a.root, a.run.workflow_id).contract_hash, undefined);
});

test('pause or changed requirements during asynchronous preflight cannot commit a stale plan', async t => {
  for (const change of ['pause', 'requirement']) {
    const a = await fixture(t); tree(a.root);
    const pending = a.context.callbacks.submitPlan(plan(['preserved']));
    const rejected = assert.rejects(pending, error => error.code === 'PLAN_INVALID' && /abort|changed|owner/i.test(error.message));
    if (change === 'pause') await controlControlledWorkflow(a.root, { workflow_id: a.run.workflow_id, action: 'pause' });
    else {
      const parent = getRecord(a.root, a.run.workflow_id), requirement = getRecord(a.root, parent.meta.data.requirement_id);
      updateRecord(a.root, requirement.meta.id, { title: 'User changed the requirement while preservation was captured.' });
    }
    await rejected;
    assert.equal(a.taskRecords().length, 0); assert.equal(existsSync(a.contractPath), false);
    if (change === 'pause') assert.equal(controlledStatus(a.root, a.run.workflow_id).status, 'paused');
  }
});

test('a mismatched orphan TASK is preserved byte-for-byte and a new execution task records explicit lineage', async t => {
  const a = await fixture(t), p = plan([]), parent = getRecord(a.root, a.run.workflow_id);
  const old = createRecord(a.root, { type: 'task', title: p.title, owner: 'developer', status: 'ready',
    links: [{ type: 'satisfies', target: parent.meta.data.requirement_id }],
    data: { workflow_id: a.run.workflow_id, epoch_id: a.run.epoch_id, process_contract: 'software-tools/v2',
      acceptance_criteria: ['Wrong old plan must never be silently adopted.'], allowed_paths: p.allowed_paths, verification_paths: p.verification_paths,
      outputs: p.outputs, documentation_paths: [] }, body: '# Failed earlier planning transaction\n' });
  const oldBytes = readFileSync(safePath(a.root, old.path));
  await a.context.callbacks.submitPlan(p);
  const contract = JSON.parse(readFileSync(a.contractPath, 'utf8')), current = getRecord(a.root, contract.task_id);
  assert.notEqual(current.meta.id, old.meta.id); assert.equal(a.taskRecords().length, 2);
  assert.ok(current.meta.links.some(link => link.type === 'derives-from' && link.target === old.meta.id));
  assert.deepEqual(current.meta.data.acceptance_criteria, p.acceptance_criteria);
  assert.deepEqual(readFileSync(safePath(a.root, old.path)), oldBytes);
  const replay = await a.context.callbacks.submitPlan(p);
  assert.equal(replay.saved, true); assert.equal(a.taskRecords().length, 2, 'Retry reuses the same committed task, not another orphan.');
});
