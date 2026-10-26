import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, atomicWrite, hash, loadRecords, safePath } from '../dist/storage.js';
import { beginWorkflow } from '../dist/manager.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { serveHost } from '../dist/vscode-wire.js';
import { startControlledHost, dispatchControlledHost } from '../dist/controlled-workflow.js';
import { createMcpServer } from '../dist/mcp.js';

async function project(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-command-receipt-')));
  initialize(root, { project_id: 'COMMAND-RECEIPT', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify({ schema_version: 1,
    manager_enabled: true, execution_mode: 'neomind-controlled', documentation_required: true,
    automatic_pr: false, upstream: null, max_discussion_rounds: 3 }));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function clientFor(t, root) {
  const server = createMcpServer(root), client = new Client({ name: 'public-command-receipt', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
function largeSnapshot(workflowId) {
  return { schema_version: 1, process_contract: 'software-tools/v2', transport: 'vscode-lm',
    workflow_id: workflowId, epoch_id: randomUUID(), status: 'paused', phase: 'implementation',
    revision: 7, request_id: 'one-saved-command-request', owner_pid: process.pid, owner_instance: 'private-owner-instance',
    updated_at: new Date().toISOString(), title: 'A private workflow title', requirement: 'PRIVATE_REQUIREMENT_NOT_A_COMMAND_RECEIPT',
    attempts: Array.from({ length: 40 }, () => ({ id: randomUUID(), request_id: randomUUID(),
      stage: 'implementation', role: 'developer', state: 'completed',
      report: { outcome: 'failed', summary: 'PRIVATE_REPORT_NOT_A_COMMAND_RECEIPT '.repeat(100), findings: ['Actual earlier work remains saved.'] } })),
    checks: [{ command: ['PRIVATE_CHECK_COMMAND'], log_path: 'PRIVATE_CHECK_LOG', baseline: { 'private-path': 'private-hash' } }],
    events: Array.from({ length: 512 }, () => ({ id: randomUUID(), at: new Date().toISOString(), kind: 'tool',
      stage: 'implementation', summary: 'PRIVATE_JOURNAL_NOT_A_COMMAND_RECEIPT '.repeat(4) })),
    repairs: 0, repair_budget: { schema_version: 1, product: 0, protocol: 0, environment: 0 }, active_invocations: [] };
}
const decode = response => { assert.notEqual(response.isError, true, JSON.stringify(response)); return JSON.parse(response.content[0].text); };
function assertCompact(response, receipt, snapshot) {
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 8192, 'A command receipt must not replay its large private workflow journal.');
  assert.equal(receipt.workflow_id, snapshot.workflow_id);
  assert.equal(receipt.epoch_id, snapshot.epoch_id);
  assert.equal(receipt.request_id, snapshot.request_id);
  for (const key of ['events', 'attempts', 'checks', 'requirement', 'title', 'owner_pid', 'owner_instance', 'reuse'])
    assert.equal(key in receipt, false, key);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_(?:REPORT|JOURNAL|REQUIREMENT|CHECK)/);
}

test('real MCP command receipts stay small and preserve identities while one owner control effect persists exactly once', async t => {
  const root = await project(t), parent = beginWorkflow(root, { requirement: 'Keep this existing controlled request.',
    request_id: 'one-saved-command-request', execution_mode: 'neomind-controlled' });
  const calls = [];
  const host = await serveHost(root, async (operation, input) => {
    calls.push(operation);
    return dispatchControlledHost(root, operation, input);
  });
  const owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await host.close(); });
  const run = largeSnapshot(parent.meta.id); run.owner_instance = host.instance;
  const path = safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.json`);
  atomicWrite(path, JSON.stringify(run));
  const before = readFileSync(path), recordCount = loadRecords(root).length, client = await clientFor(t, root);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(Object.keys(tools.find(tool => tool.name === 'manager_control').inputSchema.properties).sort(), ['action', 'workflow_id']);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.callTool({ name: 'manager_run', arguments: {
      workflow_id: run.workflow_id, request_id: run.request_id, execution_mode: 'neomind-controlled' } });
    const receipt = decode(response).workflow;
    assertCompact(response, receipt, run);
    assert.equal(receipt.status, 'paused'); assert.equal(receipt.revision, run.revision);
  }
  assert.deepEqual(readFileSync(path), before, 'Idempotent paused intake does not duplicate work or alter its journal.');
  const response = await client.callTool({ name: 'manager_control', arguments: { workflow_id: run.workflow_id, action: 'cancel' } });
  const receipt = decode(response); assertCompact(response, receipt, run);
  assert.equal(receipt.status, 'cancelled');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.status, 'cancelled'); assert.equal(saved.events.filter(event => event.kind === 'cancel').length, 1);
  assert.equal(saved.events.length, run.events.length + 1);
  assert.equal(loadRecords(root).length, recordCount);
  assert.deepEqual(calls, ['controlled-start', 'controlled-start', 'controlled-control']);
  const detailed = decode(await client.callTool({ name: 'manager_status', arguments: { workflow_id: run.workflow_id } }));
  assert.equal(detailed.events.length, saved.events.length);
  assert.equal(detailed.attempts.length, run.attempts.length, 'Explicit detailed status retains its existing contract.');
  assert.match(detailed.attempts[0].report.summary, /PRIVATE_REPORT_NOT_A_COMMAND_RECEIPT/);
});

test('MCP receipts bound model observations and blockers and retain completed artifact IDs without private nested data', async t => {
  const root = await project(t), run = largeSnapshot('COMMAND-RECEIPT-KNW-9999');
  run.status = 'blocked';
  run.active_invocations = Array.from({ length: 20 }, (_, index) => ({ id: `invocation-${index}`, role: 'developer', state: 'running',
    requested_model: 'requested-model', confirmed_model: 'observed-model', provider: 'observed-vendor', private_nested: 'PRIVATE_REPORT_NOT_A_COMMAND_RECEIPT' }));
  run.blocker = { kind: 'implementation', message: 'Actual product check failed.', code: 'PRODUCT_CHECK_FAILED',
    next_action: 'Inspect the saved failing check before resuming.', private_nested: 'PRIVATE_REPORT_NOT_A_COMMAND_RECEIPT' };
  const host = await serveHost(root, async operation => { assert.equal(operation, 'controlled-control'); return run; });
  t.after(() => host.close());
  const client = await clientFor(t, root);
  const invoke = async () => {
    const response = await client.callTool({ name: 'manager_control', arguments: { workflow_id: run.workflow_id, action: 'resume' } });
    const receipt = decode(response); assertCompact(response, receipt, run); return receipt;
  };
  const blocked = await invoke();
  assert.equal(blocked.active_invocations.length, 4);
  assert.equal(blocked.active_invocations_omitted, 16);
  assert.equal(blocked.active_invocations[0].requested_model, 'requested-model');
  assert.equal(blocked.active_invocations[0].confirmed_model, 'observed-model');
  assert.equal(blocked.active_invocations[0].provider, 'observed-vendor');
  assert.equal(blocked.blocker.code, 'PRODUCT_CHECK_FAILED');
  assert.equal(blocked.next_action, run.blocker.next_action);
  const feedback = JSON.stringify(run.blocker);
  for (const status of ['queued', 'running', 'paused', 'interrupted', 'cancelled', 'completed']) {
    run.status = status;
    const resumed = await invoke();
    assert.equal('blocker' in resumed, false, `${status} must not label retained repair feedback as a current blocker.`);
    assert.equal('next_action' in resumed, false, `${status} must not repeat an obsolete recovery instruction.`);
    assert.equal(JSON.stringify(run.blocker), feedback, 'Public projection preserves the private diagnostic history.');
  }
  run.status = 'uncertain';
  assert.equal((await invoke()).blocker.code, 'PRODUCT_CHECK_FAILED');
  run.status = 'completed'; run.phase = 'completed'; run.active_invocations = [];
  run.final_report_id = 'COMMAND-RECEIPT-KNW-0009'; run.cornell_note_ids = ['COMMAND-RECEIPT-KNW-0010'];
  const completed = await invoke();
  assert.equal(completed.final_report_id, run.final_report_id);
  assert.deepEqual(completed.cornell_note_ids, run.cornell_note_ids);
});

test('legacy native MCP manager_run keeps its complete handoff response unchanged', async t => {
  const root = await project(t), client = await clientFor(t, root);
  const response = await client.callTool({ name: 'manager_run', arguments: { execution_mode: 'copilot-native',
    requirement: 'Inspect a legacy native requirement.', request_id: 'legacy-command-receipt' } });
  const result = decode(response);
  assert.equal(result.handoff.agent, 'NeoMind Coordinator Agent');
  assert.match(result.handoff.prompt, /Continue directly as NeoMind Coordinator Agent/);
  assert.equal(result.workflow.assurance, 'unsigned-native-report');
});
