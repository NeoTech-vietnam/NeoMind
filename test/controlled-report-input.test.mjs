import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer, controlledInstructions } from '../dist/controlled-tools.js';
import { researchFixture } from './cornell-research-fixture.mjs';

async function reportClient(t, stage) {
  const fixture = researchFixture(t), received = [];
  mkdirSync(join(fixture.root, 'reports'), { recursive: true });
  const binding = { workflow_id: fixture.workflow.meta.id, invocation_id: `report-input-${stage}`,
    stage, role: stage === 'verification' ? 'verifier' : stage === 'review' ? 'reviewer' : 'developer',
    implementation_paths: ['docs'], verification_paths: ['checks'], read_paths: ['reports'],
    execution_steps: [], procedure_bound: false, cornell_bound: false };
  const server = createControlledMcpServer(fixture.root, binding, {
    assertActive() {}, saveReport(value, source) { received.push({ value, source }); return { saved: true }; },
  });
  const client = new Client({ name: `role-report-input-${stage}`, version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { ...fixture, binding, received, client,
    call: args => client.callTool({ name: 'assignment_report', arguments: args }),
    prepared(name, value) {
      const path = `reports/${name}.json`; writeFileSync(join(fixture.root, path), JSON.stringify(value)); return { input_path: path };
    } };
}

for (const stage of ['verification', 'review']) {
  test(`${stage} advertises completed-result verdict without excluding prepared or incomplete reports`, async t => {
    const c = await reportClient(t, stage);
    const report = (await c.client.listTools()).tools.find(tool => tool.name === 'assignment_report');
    const schema = report.inputSchema;
    assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
    assert.ok(schema.anyOf.some(branch => branch.required?.includes('input_path')));
    assert.ok(schema.allOf.some(condition => condition.if?.properties?.outcome?.const === 'completed' &&
      condition.if.required?.includes('outcome') && condition.then?.required?.includes('verdict')));
    assert.equal(schema.required?.includes('verdict') ?? false, false, 'Incomplete reports remain valid without a verdict.');
    assert.match(report.description, /explicit verdict pass or fail/);
    assert.match(controlledInstructions(c.binding), /For outcome completed, include your explicit verdict pass or fail/);
  });

  test(`${stage} requires a chosen verdict at both direct and prepared MCP boundaries`, async t => {
    const c = await reportClient(t, stage), missing = { outcome: 'completed', summary: 'The assigned inspection has completed.' };
    for (const args of [missing, c.prepared('missing-verdict', missing)]) {
      const response = await c.call(args);
      assert.equal(response.isError, true);
    }
    assert.equal(c.received.length, 0, 'A missing professional verdict cannot reach persistence or receive an automatic pass.');
    for (const verdict of ['pass', 'fail']) {
      const result = { ...missing, verdict };
      assert.equal((await c.call(result)).isError, undefined);
      assert.equal((await c.call(c.prepared(`explicit-${verdict}`, result))).isError, undefined);
    }
    assert.deepEqual(c.received.map(item => item.value.verdict), ['pass', 'pass', 'fail', 'fail']);
  });

  test(`${stage} blocked and failed findings persist without a verdict in either input form`, async t => {
    const c = await reportClient(t, stage);
    for (const outcome of ['blocked', 'failed']) {
      const result = { outcome, summary: 'Useful partial findings remain available for backend diagnosis.',
        findings: ['The assigned work could not reach a final professional verdict.'] };
      assert.equal((await c.call(result)).isError, undefined);
      assert.equal((await c.call(c.prepared(`incomplete-${outcome}`, result))).isError, undefined);
    }
    assert.deepEqual(c.received.map(item => item.value.outcome), ['blocked', 'blocked', 'failed', 'failed']);
    assert.ok(c.received.every(item => !Object.hasOwn(item.value, 'verdict')));
  });
}

test('producer completion still accepts a substantive result without inventing a verification verdict', async t => {
  const c = await reportClient(t, 'implementation');
  const report = (await c.client.listTools()).tools.find(tool => tool.name === 'assignment_report');
  assert.equal(report.inputSchema.allOf, undefined);
  assert.doesNotMatch(controlledInstructions(c.binding), /For outcome completed, include your explicit verdict/);
  const result = { outcome: 'completed', summary: 'The bounded implementation is ready for independent verification.' };
  assert.equal((await c.call(result)).isError, undefined);
  assert.equal((await c.call(c.prepared('producer-result', result))).isError, undefined);
  assert.ok(c.received.every(item => !Object.hasOwn(item.value, 'verdict')));
});
