import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { createControlledMcpServer, controlledInstructions } from '../dist/controlled-tools.js';

async function fixture(t, callbacks, process_contract = 'workforce/v1') {
  const root = mkdtempSync(join(tmpdir(), 'wf-check-inline-')); initialize(root);
  const binding = { workflow_id: 'WF-INLINE-KNW-0001', invocation_id: 'actual-inline-check', stage: 'verification', role: 'verifier',
    process_contract, implementation_paths: [], verification_paths: [], read_paths: ['.'], check_titles: ['Build firmware'] };
  const server = createControlledMcpServer(root, binding, { assertActive() {}, saveReport() {}, ...callbacks });
  const client = new Client({ name: 'actual-check-inline-evidence', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  return { binding, call: async args => {
    const result = await client.callTool({ name: 'check_run', arguments: args });
    return { result, data: JSON.parse(result.content[0].text) };
  } };
}

test('WorkForce check_run includes actual saved execution evidence without a second model tool request', async t => {
  const order = [], traces = [], receipt = { checks: [{ title: 'Build firmware', passed: false, exit_code: 1 },
    { title: 'Reject bad firmware', negative: true, passed: true, exit_code: 1 }], retained: 'unchanged receipt' };
  const actual = [{ evidence_kind: 'independent-check', title: 'Build firmware', passed: false,
    observed_passed: false, checker_scope_current: true, exit_code: 1, stdout: 'actual compiler output', stderr: 'actual compile error' },
  { evidence_kind: 'independent-check', title: 'Reject bad firmware', negative: true, passed: true, exit_code: 1, stderr: 'intended negative failure' }];
  const c = await fixture(t, { runCheck(title) { order.push(['saved', title]); return receipt; },
    readEvidence(title, kind) { order.push(['evidence', title, kind]); return [...actual,
      { evidence_kind: 'independent-check', title: 'Unrelated prior check', stdout: 'UNRELATED_CHECK_LOG' },
      { evidence_kind: 'producer-execution', title: 'Build firmware', stdout: 'UNRELATED_PRODUCER_LOG' }]; }, trace(event) { traces.push(event); } });
  const { result, data } = await c.call({ title: 'Build firmware' });
  assert.notEqual(result.isError, true);
  assert.deepEqual(data, { ...receipt, execution_evidence: actual });
  assert.deepEqual(order, [['saved', 'Build firmware'], ['evidence', undefined, 'execution']]);
  assert.doesNotMatch(JSON.stringify(data.execution_evidence), /UNRELATED_CHECK_LOG|UNRELATED_PRODUCER_LOG/);
  assert.deepEqual(traces.filter(event => event.event === 'tool-request').map(event => event.tool), ['check_run']);
  assert.match(controlledInstructions(c.binding), /check_run.*execution_evidence/);
});

test('ancillary evidence projection failure preserves the actual completed check response without a retry or raw diagnostic leak', async t => {
  let executions = 0;
  const receipt = { checks: [{ title: 'Build firmware', passed: true, exit_code: 0 }] };
  const c = await fixture(t, { runCheck() { executions++; return receipt; },
    readEvidence() { throw Error('PRIVATE_TOKEN=never-display-secret C:/private/catalog.json'); } });
  const { result, data } = await c.call({});
  assert.notEqual(result.isError, true); assert.equal(executions, 1);
  assert.deepEqual(data.checks, receipt.checks); assert.equal(data.execution_evidence.available, false);
  assert.doesNotMatch(JSON.stringify(data), /never-display-secret|catalog\.json|PRIVATE_TOKEN/);
  assert.match(data.execution_evidence.limitation, /saved|retained/);
});

test('software-tools v2 check result and evidence fetching remain unchanged', async t => {
  let reads = 0;
  const receipt = { checks: [{ title: 'Build firmware', passed: true }] };
  const c = await fixture(t, { runCheck() { return receipt; }, readEvidence() { reads++; return []; } }, 'software-tools/v2');
  const { result, data } = await c.call({ title: 'Build firmware' });
  assert.notEqual(result.isError, true); assert.deepEqual(data, receipt); assert.equal(reads, 0);
});
