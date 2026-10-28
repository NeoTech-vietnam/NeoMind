import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { initialize, createRecord, safePath } from '../dist/storage.js';
import { createControlledMcpServer } from '../dist/controlled-tools.js';
import { createOpenCodeGateway, openCodeConfiguration, startOpenCodeEngine, openCodeStorage } from '../dist/opencode-engine.js';
import { localOpenAIProvider } from './helpers/local-openai-provider.mjs';
import { ensureRoutingPolicy, readInvocation, invocationIsActive } from '../dist/routing.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { startNative, waitNative, shutdownNative, interruptNative } from '../dist/native.js';

// The real pinned engine, its OpenAI protocol parser and actual HTTP MCP gateway
// execute every tool call. Only the language-model HTTP peer is deterministic;
// this spends no provider/model quota and is not end-to-end product acceptance.
const temporary = resolve('artifacts/test-temp');
function fixture(t) {
  mkdirSync(temporary, { recursive: true }); const root = mkdtempSync(join(temporary, 'wf-tool-transport-'));
  initialize(root, { project_id: 'WF-TRANSPORT', execution_engine: 'opencode' });
  const storage = openCodeStorage(root).path;
  const cleanup = () => { assert.equal(dirname(root), temporary); assert.equal(dirname(storage), join(temporary, '.workforce-private'));
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  mkdirSync(join(root, 'products')); writeFileSync(join(root, 'products/current.txt'), 'first line\nsecond line\n');
  writeFileSync(join(root, 'products/unread.txt'), 'Preserve unread user data.'); writeFileSync(join(root, 'products/race.txt'), 'Original before outside edit.');
  return { root, cleanup };
}
const call = (name, args) => ({ toolCalls: [{ name: `wf_${name}`, arguments: args }] });

test('real OpenCode transports compatible default/null cursor reads and scoped writes while preserving range, required-null and CAS refusals', { timeout: 150000 }, async t => {
  const { root, cleanup } = fixture(t), traces = [], reports = [], events = [], startup = [];
  let provider, gateway, engine, controller;
  t.after(async () => { controller?.abort(); await engine?.close(); await gateway?.close(); await provider?.close(); cleanup(); });
  const binding = { workflow_id: 'WF-TRANSPORT-REQUEST', invocation_id: randomUUID(), task_id: 'WF-TRANSPORT-TASK', process_contract: 'workforce/v1',
    role: 'developer', stage: 'implementation', implementation_paths: ['products'], verification_paths: [], read_paths: ['products'],
    execution_steps: [], procedure_bound: false, cornell_bound: false };
  const steps = [
    // Exact captured live failure: these are equivalent origin defaults.
    call('project_read', { path: 'products/current.txt', max_chars: 64000, start_line: 1, start_char: 0 }),
    call('task_file_write', { path: 'products/current.txt', content: 'A valid current replacement.\n' }),
    call('project_read', { path: 'products/current.txt', max_chars: null, start_line: null, start_char: null }),
    call('project_read', { path: 'products/current.txt', max_chars: 128, start_line: 2, start_char: 0 }),
    call('project_read', { path: 'products/current.txt', max_chars: 128, start_line: 1, start_char: 2 }),
    call('project_read', { path: 'products/new.txt' }),
    call('task_file_write', { path: 'products/new.txt', content: 'A valid new scoped product.\n' }),
    call('project_read', { path: 'products/current.txt', max_chars: 128, start_line: 2, start_char: 2 }),
    call('project_read', { path: 'products/current.txt', max_chars: 0 }),
    call('project_read', { path: null, max_chars: 128 }),
    call('task_file_write', { path: 'products/current.txt', content: null }),
    call('task_file_write', { path: 'products/unread.txt', content: 'Must not overwrite unread content.' }),
    call('project_read', { path: 'products/race.txt' }),
    call('task_file_write', { path: 'products/race.txt', content: 'Must not overwrite an outside edit.' }),
    call('assignment_report', { summary: 'Transport fixture completed its valid read/write calls and retained deliberate validation/CAS rejections.', artifacts: ['products/current.txt', 'products/new.txt'], product_findings: [] }),
  ];
  provider = await localOpenAIProvider((index, body) => {
    assert.equal(body.model, 'worker-models');
    assert.ok(body.tools.some(tool => tool.function?.name === 'wf_project_read'));
    if (index === 13) writeFileSync(join(root, 'products/race.txt'), 'An actual concurrent outside edit.');
    if (index === 14) assert.equal(readFileSync(join(root, 'products/race.txt'), 'utf8'), 'An actual concurrent outside edit.');
    return steps[index] ?? { text: 'fixture complete' };
  }, 18);
  gateway = await createOpenCodeGateway(() => createControlledMcpServer(root, binding, {
    assertActive() {}, trace: event => { traces.push(event); }, saveReport: value => { reports.push(value); return { saved: true }; },
  }), () => {});
  engine = await startOpenCodeEngine(root, randomUUID(), openCodeConfiguration({ model: 'worker-models', provider: 'local-protocol-fixture',
    baseURL: provider.baseURL, apiKey: 'local-fixture-not-a-provider-key' }, gateway,
  ['project_read', 'project_list', 'project_search', 'runtime_context', 'task_file_write', 'assignment_report', 'check_evidence']), undefined,
    { onStartupStage: observation => startup.push(observation) }).finally(() => t.diagnostic(JSON.stringify({ startup_stages: startup })));
  controller = new AbortController();
  const stream = await engine.client.event.subscribe({ directory: engine.directory }, { signal: controller.signal });
  const observation = (async () => { for await (const event of stream.stream) events.push(event); })().catch(() => {});
  const session = await engine.client.session.create({ directory: engine.directory, agent: 'workforce', title: 'Offline tool-transport regression' });
  const listed = await engine.client.tool.ids({ directory: engine.directory });
  const allowed = new Set(['wf_project_read', 'wf_task_file_write', 'wf_assignment_report']);
  const tools = Object.fromEntries((listed.data ?? []).map(name => [name, allowed.has(name)]));
  const response = await engine.client.session.prompt({ sessionID: session.data.id, directory: engine.directory, agent: 'workforce',
    model: { providerID: 'workforce-router', modelID: 'worker-models' }, tools,
    parts: [{ type: 'text', text: 'Exercise the scripted local protocol fixture through its supplied tools. No real provider is connected.' }] }, { signal: AbortSignal.timeout(90000) });
  controller.abort(); await observation;
  const eventShapes = [...new Map(events.filter(event => event.type?.includes('tool') || event.type === 'message.part.updated' && event.properties?.part?.type === 'tool').map(event => [`${event.type}:${event.properties?.part?.state?.status ?? ''}`,
    { type: event.type, has_id: typeof event.id === 'string', property_keys: Object.keys(event.properties ?? {}).sort(), part_keys: Object.keys(event.properties?.part ?? {}).sort(),
      tool_status: event.properties?.part?.state?.status, state_keys: Object.keys(event.properties?.part?.state ?? {}).sort() }])).values()];
  t.diagnostic(JSON.stringify({ provider: 'loopback scripted OpenAI protocol only', request_count: provider.requests.length, event_shapes: eventShapes,
    backend_errors: traces.filter(event => event.event === 'tool-result' && event.status === 'failed').map(event => ({ tool: event.tool, code: event.code })) }));
  assert.equal(response.data.info.error, undefined);
  assert.deepEqual(provider.failures, []); assert.equal(provider.requests.length, steps.length + 1);
  assert.equal(readFileSync(join(root, 'products/current.txt'), 'utf8'), 'A valid current replacement.\n');
  assert.equal(readFileSync(join(root, 'products/new.txt'), 'utf8'), 'A valid new scoped product.\n');
  assert.equal(readFileSync(join(root, 'products/unread.txt'), 'utf8'), 'Preserve unread user data.');
  assert.equal(readFileSync(join(root, 'products/race.txt'), 'utf8'), 'An actual concurrent outside edit.');
  assert.equal(reports.length, 1);
  const errors = traces.filter(event => event.event === 'tool-result' && event.status === 'failed');
  assert.ok(errors.some(event => event.code === 'INVALID_PAYLOAD'), 'Conflicting nondefault cursors must still fail.');
  assert.ok(errors.some(event => event.code === 'READ_REQUIRED'), 'Omitting a model-supplied CAS field never bypasses the backend read requirement.');
  assert.ok(errors.some(event => event.code === 'INPUT_CHANGED'), 'Outside changes still invalidate a saved read.');
  const successfulReads = traces.filter(event => event.event === 'tool-result' && event.tool === 'project_read' && event.status === 'succeeded');
  assert.ok(successfulReads.length >= 6, 'Exact captured defaults, optional nulls and compatible nondefault cursor forms reach the real handler.');
  const firstSchema = provider.requests[0].tools.find(tool => tool.function?.name === 'wf_project_read').function.parameters;
  assert.ok(firstSchema.required.includes('path'));
  assert.ok(events.some(event => event.type === 'message.part.updated' || event.type?.startsWith('session.next.tool.')), 'Actual emitted tool events were observed.');
  await engine.close(); await gateway.close();
});

for (const [label, args] of [
  ['semantic MCP application failures', { path: 'products/current.txt', max_chars: 128, start_line: 2, start_char: 2 }],
  ['schema validation failures before a successful MCP handler', { path: 'products/current.txt', max_chars: 0 }],
]) test(`actual OpenCode NativeSession cuts off two unchanged ${label} without spending provider quota`, { timeout: 150000 }, async t => {
  const { root, cleanup } = fixture(t), traces = [];
  let provider, unregister;
  t.after(async () => { await shutdownNative(root); unregister?.(); await provider?.close(); cleanup(); });
  provider = await localOpenAIProvider(index => index < 6 ? call('project_read', args) : { text: 'Fixture limit: the missing circuit must not be disguised as successful completion.' }, 8);
  const catalog = join(root, 'fixture-models.json'); writeFileSync(catalog, JSON.stringify([{ name: 'fixture', vendor: 'customendpoint',
    models: [{ id: 'worker-models', url: provider.baseURL, apiKey: 'local-fixture-only' }, { id: 'top-models', url: provider.baseURL, apiKey: 'local-fixture-only' }] }]));
  writeFileSync(safePath(root, '.workforce/routing.json'), JSON.stringify({ ...ensureRoutingPolicy(root), language_models_file: catalog }));
  const workflow = createRecord(root, { type: 'knowledge', title: 'Offline repeated tool failure transport fixture', data: { kind: 'manager-workflow' } });
  const task = createRecord(root, { type: 'task', title: 'Retain actual content on repeated invalid reads', owner: 'developer', data: { workflow_id: workflow.meta.id } });
  const requestId = randomUUID(), binding = { workflow_id: workflow.meta.id, task_id: task.meta.id, role: 'developer', stage: 'implementation', process_contract: 'workforce/v1',
    implementation_paths: ['products'], verification_paths: [], read_paths: ['products'], execution_steps: [], procedure_bound: false, cornell_bound: false };
  unregister = registerControlledContext(root, requestId, { epoch_id: randomUUID(), binding, bindInvocation(id) { binding.invocation_id = id; },
    callbacks: { assertActive() {}, trace(event) { traces.push(event); }, saveReport() { throw new Error('No professional report is expected from this deliberately invalid call stream.'); } } });
  let receipt = await startNative(root, { role: 'developer', workflow_id: workflow.meta.id, task_id: task.meta.id, request_id: requestId,
    prompt: 'Run only the local offline scripted tool-call protocol fixture. No external model or product acceptance is involved.' });
  const deadline = Date.now() + 60000;
  while (invocationIsActive(receipt) && Date.now() < deadline) receipt = await waitNative(root, receipt.id, 500);
  t.diagnostic(JSON.stringify({ provider: 'loopback scripted OpenAI protocol only', case: label, request_count: provider.requests.length,
    terminal_state: receipt.state, error: receipt.error, tool_observations: traces.filter(event => event.event === 'engine-tool').map(event =>
      ({ tool: event.tool, status: event.status, repeated_failures: event.repeated_failures, halt: event.halt })),
    native_session_observed: typeof receipt.native_thread_id === 'string',
    control_failures: traces.filter(event => event.event === 'engine-failure').map(event => ({
      operation: event.control_operation, error_name: event.error_name, transport_causes: event.transport_causes,
    })) }));
  assert.equal(receipt.issuer, 'workforce-opencode'); assert.equal(receipt.state, 'blocked');
  assert.match(receipt.error ?? '', /^MCP_DELIVERY_PROTOCOL:/);
  assert.equal(readInvocation(root, receipt.id).inference_completed, false);
  assert.ok(provider.requests.length >= 2 && provider.requests.length <= 4, 'The actual engine stops near the second unchanged tool error, before a long retry loop.');
  assert.ok(traces.some(event => event.event === 'engine-tool' && event.halt === true && event.repeated_failures === 2));
  assert.equal(readFileSync(join(root, 'products/current.txt'), 'utf8'), 'first line\nsecond line\n');
  assert.deepEqual(provider.failures, []);
  await shutdownNative(root);
  const interrupted = await interruptNative(root, receipt.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.error, receipt.error, 'Authenticated shutdown preserves the original repeated-tool failure diagnosis.');
  assert.match(interrupted.opencode.interruption_proof_sha256, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(root, 'products/current.txt'), 'utf8'), 'first line\nsecond line\n');
});
