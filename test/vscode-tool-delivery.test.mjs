import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VSCodeSession, vscodeToolDeliveryDiagnostic } from '../dist/vscode-session.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { serveHost, readHost } from '../dist/vscode-wire.js';

test('delivery diagnostics preserve safe phase/classification/frames/hash without persisting SDK secrets', () => {
  const error = Object.assign(new Error('Bearer SECRET_TOKEN https://private.invalid/path?api_key=SECRET_QUERY'), { code: 'ECONNRESET' });
  error.stack = 'SECRET_STACK\n at deliver (C:/private-user/dist/vscode-session.js:123:4)\n at provider (C:/SECRET_PATH/dist/secret-provider.js:5:6)';
  const transport = vscodeToolDeliveryDiagnostic('host-result', error);
  assert.equal(transport.kind, 'environment'); assert.equal(transport.code, 'ECONNRESET'); assert.equal(transport.phase, 'host-result');
  assert.deepEqual(transport.frames, [{ module: 'vscode-session.js', line: 123, column: 4 }]);
  assert.match(transport.message_sha256, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(transport), /SECRET_|private-user|private\.invalid|secret-provider/);
  assert.equal(vscodeToolDeliveryDiagnostic('postbinding', error).kind, 'protocol', 'Backend validation is not relabeled as a transport failure.');
  assert.equal(vscodeToolDeliveryDiagnostic('mcp-call', Object.assign(new Error('PRIVATE SDK MESSAGE'), { code: -32001 })).kind, 'environment');
  assert.equal(vscodeToolDeliveryDiagnostic('host-result', Object.assign(new Error('PRIVATE HTTP BODY'), { code: 'BRIDGE_REFUSED', status_code: 400 })).kind, 'protocol');
});

test('every gateway rejection identifies its boundary and never retries the tool', async () => {
  for (const phase of ['scope', 'prebinding', 'mcp-call', 'result-bounds', 'postbinding']) {
    let calls = 0, validations = 0;
    const receipt = { id: 'fixture', request_id: 'fixture', native_tool_scope: ['task_file_write'] };
    const session = new VSCodeSession(process.cwd(), receipt, () => {}, async () => {});
    session.assertCurrentInvocation = () => { validations++; if (phase === 'prebinding' || phase === 'postbinding' && validations === 2) throw new Error('SECRET_BINDING_DETAIL'); };
    session.client = { callTool: async () => { calls++; if (phase === 'mcp-call') throw Object.assign(new Error('SECRET_MCP_DETAIL'), { code: 'ECONNRESET' });
      return { content: [{ type: 'text', text: phase === 'result-bounds' ? 'x'.repeat(1024 * 1024) : '{}' }] }; } };
    const event = { name: phase === 'scope' ? 'unscoped' : 'task_file_write', call_id: 'fixture', input: {} };
    await assert.rejects(session.tool(event), error => {
      assert.equal(error.diagnostic.phase, phase); assert.doesNotMatch(JSON.stringify(error.diagnostic), /SECRET_/); return true;
    });
    assert.equal(calls, ['scope', 'prebinding'].includes(phase) ? 0 : 1);
  }
});

test('controlled delivery traces are persisted before fixed receipt failure and contain no raw SDK input', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-delivery-diagnostic-')), order = [], receipt = {
    id: 'fixture', request_id: 'private-request', native_tool_scope: ['task_file_write'] };
  const unregister = registerControlledContext(root, receipt.request_id, { epoch_id: 'private-epoch',
    binding: { workflow_id: 'private-workflow', stage: 'implementation', role: 'developer', implementation_paths: [], verification_paths: [] },
    bindInvocation() {}, callbacks: { assertActive() {}, saveReport() {}, trace(value) { order.push({ kind: 'trace', value }); } } });
  t.after(() => { unregister(); rmSync(root, { recursive: true, force: true }); });
  const session = new VSCodeSession(root, receipt, () => {}, async (state, error) => order.push({ kind: 'complete', state, error }));
  let reads = 0, tools = 0;
  session.assertCurrentInvocation = () => { if (++reads === 2) throw new Error('SECRET_POSTBINDING'); };
  session.client = { callTool: async () => { tools++; return { content: [{ type: 'text', text: '{"saved":true}' }] }; } };
  const event = { name: 'task_file_write', call_id: 'private-call', input: { content: 'SECRET_FILE_BODY' } };
  let failure; try { await session.tool(event); } catch (error) { failure = error; }
  await session.deliveryFailed(event, failure);
  assert.deepEqual(order.map(item => item.kind), ['trace', 'complete']); assert.equal(tools, 1);
  assert.equal(order[0].value.event, 'mcp-delivery-failed'); assert.equal(order[0].value.delivery.phase, 'postbinding');
  assert.equal(order[1].state, 'blocked'); assert.match(order[1].error, /^MCP_DELIVERY_PROTOCOL:/);
  assert.doesNotMatch(JSON.stringify(order), /SECRET_|private-call|private-request|private-epoch|private-workflow/);
});

test('an actual same-process result dispatch records one private transport observation per invocation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-delivery-route-')), events = [], receipt = {
    id: 'fixture', request_id: 'route-request', native_turn_id: 'fixture-turn', native_tool_scope: ['task_file_write'] };
  let dispatches = 0;
  const host = await serveHost(root, async () => ({ accepted: ++dispatches }));
  const unregister = registerControlledContext(root, receipt.request_id, { epoch_id: 'fixture-epoch',
    binding: { workflow_id: 'fixture-workflow', stage: 'implementation', role: 'developer', implementation_paths: [], verification_paths: [] },
    bindInvocation() {}, callbacks: { assertActive() {}, saveReport() {}, trace(event) { events.push(event); } } });
  t.after(async () => { unregister(); await host.close(); rmSync(root, { recursive: true, force: true }); });
  const session = new VSCodeSession(root, receipt, () => {}, async () => {});
  session.host = readHost(root); session.assertCurrentInvocation = () => {};
  session.client = { callTool: async () => ({ content: [{ type: 'text', text: '{"saved":true}' }] }) };
  await session.tool({ name: 'task_file_write', call_id: 'one', input: {} });
  await new Promise(done => setImmediate(done));
  await session.tool({ name: 'task_file_write', call_id: 'two', input: {} });
  await new Promise(done => setImmediate(done));
  assert.equal(dispatches, 2); assert.equal(events.length, 1);
  assert.equal(events[0].event, 'bridge-transport'); assert.equal(events[0].transport, 'in-process');
  assert.equal(events[0].diagnostic_only, true);
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'diagnostic_only', 'event', 'owner', 'stage', 'transport']);
  assert.doesNotMatch(JSON.stringify(events), /"(?:token|port|descriptor)"\s*:|fixture-workflow|route-request/);
});

test('host dispatch refusal is reported at host-result without exposing its underlying error', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-delivery-refusal-'));
  const host = await serveHost(root, async () => { throw new Error('SECRET_DISPATCH_HEADER'); });
  t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  const receipt = { id: 'fixture', native_turn_id: 'fixture-turn', native_tool_scope: ['task_file_write'] };
  const session = new VSCodeSession(root, receipt, () => {}, async () => {}); let calls = 0;
  session.host = readHost(root); session.assertCurrentInvocation = () => {};
  session.client = { callTool: async () => { calls++; return { content: [] }; } };
  await assert.rejects(session.tool({ name: 'task_file_write', call_id: 'refusal', input: {} }), error => {
    assert.equal(error.diagnostic.phase, 'host-result'); assert.equal(error.diagnostic.kind, 'protocol');
    assert.equal(error.diagnostic.code, 'BRIDGE_REFUSED'); assert.doesNotMatch(JSON.stringify(error.diagnostic), /SECRET_/); return true;
  });
  assert.equal(calls, 1);
});
