import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initialize } from '../dist/storage.js';
import { createControlledMcpServer, controlledInstructions } from '../dist/controlled-tools.js';
import { createOpenCodeGateway } from '../dist/opencode-engine.js';
import { canonicalJson } from '../dist/routing.js';

const parsed = result => JSON.parse(result.content[0].text);
async function fixture(t, stage = 'implementation') {
  const temporary = resolve('artifacts/test-temp'); mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'wf-stage-result-'));
  initialize(root, { execution_engine: 'opencode' }); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/temperature.mjs'), 'export const convert = c => c * 9 / 5 - 32;\n');
  const binding = { workflow_id: 'WF-STAGE', task_id: 'WF-TASK', invocation_id: 'actual-http-gateway-fixture',
    role: stage === 'implementation' ? 'developer' : stage === 'diagnosis' ? 'manager' : stage === 'verification' ? 'verifier' : 'reviewer',
    stage, process_contract: 'workforce/v1', implementation_paths: ['src/temperature.mjs'], verification_paths: ['checks'],
    read_paths: ['.'], check_titles: ['Existing project tests'], execution_steps: [], procedure_bound: false, cornell_bound: false };
  const reports = [], gateway = await createOpenCodeGateway(() => createControlledMcpServer(root, binding, {
    assertActive() {}, saveReport(report) { reports.push(report); return { saved: true, outcome: report.outcome }; },
  }), () => {});
  const client = new Client({ name: 'workforce-stage-contract-fixture', version: '1' });
  t.after(async () => { await client.close(); await gateway.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), { requestInit: { headers: { Authorization: gateway.authorization } } }));
  return { root, binding, reports, client, tools: (await client.listTools()).tools,
    call: (name, args) => client.callTool({ name, arguments: args }) };
}

test('actual HTTP WF result schema removes model lifecycle and hands a ready product to the scheduled Tester', async t => {
  const { root, binding, reports, tools, call } = await fixture(t);
  const result = tools.find(tool => tool.name === 'assignment_report');
  assert.equal(result.inputSchema.properties.outcome, undefined);
  assert.equal(tools.some(tool => tool.name === 'task_run' || tool.name === 'check_run'), false);
  for (const text of [result.description, controlledInstructions(binding)]) {
    assert.match(text, /WF\.Tester/); assert.match(text, /Existing project tests/);
    assert.match(text, /Pending npm test\/compiler\/check evidence is expected/);
  }
  assert.equal((await call('project_read', { path: 'src/temperature.mjs' })).isError, undefined);
  assert.equal((await call('task_file_write', { path: 'src/temperature.mjs', content: 'export const convert = c => c * 9 / 5 + 32;\n' })).isError, undefined);
  const saved = await call('assignment_report', { summary: 'The assigned product is ready; independent npm test is scheduled next.',
    artifacts: ['src/temperature.mjs'], product_findings: [], limitations: ['No independent test execution is claimed by this producer.'] });
  assert.notEqual(saved.isError, true); assert.equal(parsed(saved).outcome, 'completed');
  assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'completed');
  assert.equal(canonicalJson(reports[0]), canonicalJson(JSON.parse(JSON.stringify(reports[0]))), 'The hashed handoff survives durable JSON readback exactly.');
  assert.match(readFileSync(join(root, 'src/temperature.mjs'), 'utf8'), /\+ 32/);
  const injected = await call('assignment_report', { outcome: 'blocked', summary: 'The model cannot choose global lifecycle.' });
  assert.equal(injected.isError, true); assert.equal(reports.length, 1);
});

test('typed WF product defects remain real repair findings and cannot target another scope', async t => {
  const { reports, call } = await fixture(t);
  const denied = await call('assignment_report', { summary: 'An outside path is not assigned.', product_findings: [{ path: 'other/product.mjs', issue: 'Unrelated defect.' }] });
  assert.equal(denied.isError, true); assert.equal(parsed(denied).code, 'SCOPE_DENIED'); assert.equal(reports.length, 0);
  const result = await call('assignment_report', { summary: 'The assigned conversion is still wrong.',
    product_findings: [{ path: 'src/temperature.mjs', issue: 'The offset still subtracts32 rather than adding32.' }] });
  assert.notEqual(result.isError, true); assert.equal(reports[0].outcome, 'failed'); assert.equal(reports[0].failure_kind, 'implementation');
  assert.match(reports[0].findings[0], /src\/temperature.mjs/);
});

for (const stage of ['review', 'verification', 'diagnosis']) test(`WF ${stage} requires its professional decision without exposing outcome`, async t => {
  const { tools, reports, call } = await fixture(t, stage), schema = tools.find(tool => tool.name === 'assignment_report').inputSchema;
  assert.equal(schema.properties.outcome, undefined);
  const field = stage === 'diagnosis' ? 'failure_kind' : 'verdict';
  assert.ok(JSON.stringify(schema).includes(field));
  assert.equal((await call('assignment_report', { summary: 'A decision has not yet been supplied.' })).isError, true);
  const saved = await call('assignment_report', { summary: 'Actual professional decision.', [field]: stage === 'diagnosis' ? 'unknown' : 'fail',
    ...(stage === 'diagnosis' ? {} : { failure_kind: 'implementation', findings: ['Current assigned product has a concrete defect.'] }) });
  assert.notEqual(saved.isError, true); assert.equal(reports[0].outcome, 'completed'); assert.equal(reports[0][field], stage === 'diagnosis' ? 'unknown' : 'fail');
});
