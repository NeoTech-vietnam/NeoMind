import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, atomicWrite, loadRecords, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { beginWorkflow } from '../dist/manager.js';
import { serveHost } from '../dist/vscode-wire.js';
import { startControlledHost, startControlledWorkflow, dispatchControlledHost } from '../dist/controlled-workflow.js';
import { shutdownNative } from '../dist/native.js';
import { createMcpServer } from '../dist/mcp.js';

const pause = ms => new Promise(done => setTimeout(done, ms));
async function fixture(t, operation, options = {}) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-intake-delivery-')));
  initialize(root, { project_id: 'DELIVERY', platforms: ['copilot', 'codex'] });
  ensureRoutingPolicy(root);
  atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify({ schema_version: 1, manager_enabled: true,
    execution_mode: 'neomind-controlled', documentation_required: true, automatic_pr: false, upstream: null, max_discussion_rounds: 3 }));
  const requests = [];
  const host = await serveHost(root, async (name, input) => {
    if (name === 'controlled-start') { requests.push(structuredClone(input)); return operation(root, input); }
    return dispatchControlledHost(root, name, input);
  }, options);
  const owner = await startControlledHost(root);
  t.after(async () => { await owner.close(); await shutdownNative(root); await host.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return { root, requests, parents: () => loadRecords(root).filter(record => record.meta.data.kind === 'manager-workflow') };
}
async function mcp(t, root) {
  const server = createMcpServer(root), client = new Client({ name: 'intake-delivery-boundary', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); }); return client;
}

test('facade creates its request identity before the one wire mutation and reconciles a lost actual admission response read-only', async t => {
  const a = await fixture(t, async (root, input) => {
    await dispatchControlledHost(root, 'controlled-start', input);
    throw new Error('PRIVATE_TRANSPORT_CAUSE_AFTER_DURABLE_COMMIT');
  });
  const receipt = await startControlledWorkflow(a.root, { requirement: 'Keep one bounded independently checked scalar request.', title: 'Stable intake identity' });
  assert.equal(a.requests.length, 1, 'No automatic controlled-start replay is permitted.');
  assert.match(a.requests[0].request_id, /^[a-f0-9-]{36}$/);
  assert.equal(receipt.request_id, a.requests[0].request_id);
  assert.equal(receipt.workflow_id, a.parents()[0].meta.id); assert.equal(a.parents().length, 1);
  assert.equal(receipt.requirement, a.requests[0].requirement);
});

test('a timed-out admission can commit later and the same facade observes it without another start call', async t => {
  const a = await fixture(t, async (root, input) => {
    await pause(100); return dispatchControlledHost(root, 'controlled-start', input);
  }, { operation_timeouts_ms: { 'controlled-start': 40 } });
  const receipt = await startControlledWorkflow(a.root, { requirement: 'Preserve this request even when its receipt arrives after the IPC deadline.' });
  assert.equal(a.requests.length, 1); assert.ok(a.requests[0].request_id);
  assert.equal(receipt.request_id, a.requests[0].request_id); assert.equal(a.parents().length, 1);
});

test('lost admission response cannot acknowledge a different semantic request under the same identity', async t => {
  const a = await fixture(t, async (root, input) => {
    await dispatchControlledHost(root, 'controlled-start', { ...input, requirement: 'A different saved requirement.' });
    throw new Error('PRIVATE_TRANSPORT_CAUSE');
  });
  await assert.rejects(startControlledWorkflow(a.root, { requirement: 'The complete original user requirement.' }), { code: 'INTAKE_PAYLOAD_MISMATCH' });
  assert.equal(a.requests.length, 1); assert.equal(a.parents().length, 1);
});

test('MCP returns a typed uncertain receipt outcome and manager_status lists its same partial-parent request identity', async t => {
  const a = await fixture(t, async (root, input) => {
    beginWorkflow(root, { ...input, execution_mode: 'neomind-controlled' });
    await pause(100); return {};
  }, { operation_timeouts_ms: { 'controlled-start': 40 } });
  const client = await mcp(t, a.root);
  const response = await client.callTool({ name: 'manager_run', arguments: {
    requirement: 'Preserve an admitted parent whose initial controller journal did not finish.', execution_mode: 'neomind-controlled' } });
  assert.equal(response.isError, true);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.code, 'INTAKE_OUTCOME_UNCERTAIN'); assert.equal(result.owner, 'runtime'); assert.equal(result.retryable, false);
  assert.equal(a.requests.length, 1); assert.equal(result.request_id, a.requests[0].request_id);
  assert.match(result.next_action, /manager_status without workflow_id/);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_TRANSPORT|Bearer|claim_token/);
  const status = JSON.parse((await client.callTool({ name: 'manager_status', arguments: {} })).content[0].text);
  const saved = status.legacy_workflows.find(item => item.request_id === result.request_id);
  assert.equal(saved.workflow_id, a.parents()[0].meta.id); assert.equal(a.parents().length, 1);
  assert.equal(a.requests.length, 1, 'Status reconciliation never mutates admission.');
});
