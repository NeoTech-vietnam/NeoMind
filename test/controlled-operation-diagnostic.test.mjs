import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { controlledOperationDiagnostic } from '../dist/controlled-operation-diagnostic.js';
import { createControlledMcpServer, ControlledToolError } from '../dist/controlled-tools.js';
import { ControlledPayloadError } from '../dist/controlled-payload.js';
import { ControlledEvidenceScanTimeout } from '../dist/controlled-evidence-error.js';
import { controlledFailure } from '../dist/controlled-failure.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const owned = module => fileURLToPath(new URL(`../dist/${module}`, import.meta.url));
const secrets = /SECRET_|private-user|private\.invalid|secret-provider|Bearer|api_key/;
function privateError() {
  const cause = Object.assign(new Error('SECRET_CAUSE api_key=SECRET_KEY'), { code: 'ENOENT' });
  cause.stack = `SECRET_CAUSE_STACK\n at load (${owned('storage.js')}:91:7)`;
  const error = new TypeError('Bearer SECRET_TOKEN https://private.invalid/p?api_key=SECRET_QUERY', { cause });
  error.stack = `SECRET_RAW_STACK\n at read (${owned('controlled-review-context.js')}:123:4)\n` +
    ' at provider (C:/private-user/dist/secret-provider.js:5:6)\n' +
    ' at spoof (C:/private-user/dist/controlled-tools.js:6:7)';
  return error;
}

test('unknown operation diagnostics retain owned locations and stable message hashes without private text', () => {
  const error = privateError(), diagnostic = controlledOperationDiagnostic('operation', 'check_evidence', error);
  assert.equal(diagnostic.phase, 'operation'); assert.equal(diagnostic.tool, 'check_evidence');
  assert.equal(diagnostic.error_class, 'TypeError'); assert.equal(diagnostic.fs_error_code, null);
  assert.equal(diagnostic.message_sha256, digest(error.message));
  assert.deepEqual(diagnostic.frames, [{ module: 'controlled-review-context.js', line: 123, column: 4 }]);
  assert.equal(diagnostic.causes[0].fs_error_code, 'ENOENT');
  assert.equal(diagnostic.causes[0].message_sha256, digest(error.cause.message));
  assert.deepEqual(diagnostic.causes[0].frames, [{ module: 'storage.js', line: 91, column: 7 }]);
  assert.deepEqual(controlledOperationDiagnostic('operation', 'check_evidence', error), diagnostic);
  assert.doesNotMatch(JSON.stringify(diagnostic), secrets);
  assert.equal(Object.hasOwn(diagnostic, 'message'), false); assert.equal(Object.hasOwn(diagnostic, 'stack'), false);
});

test('host actions share fixed metadata while arbitrary class/code/phase/tool and fake frames cannot leak', () => {
  for (const operation of ['open', 'run', 'poll', 'result', 'cancel', 'close'])
    assert.equal(controlledOperationDiagnostic('host-dispatch', operation, new Error('SECRET_HOST')).tool, operation);
  const diagnostic = controlledOperationDiagnostic('SECRET_PHASE', 'SECRET_TOOL', {
    name: 'SECRET_CLASS', code: 'SECRET_CODE', message: 'SECRET_MESSAGE',
    stack: `at remote (https://private.invalid/dist/controlled-tools.js:2:3)\n` +
      `at absent (${owned('secret-provider.js')}:2:3)\n` +
      `at owned (${new URL('../dist/controlled-tools.js', import.meta.url).href}:22:3)`,
    cause: { name: 'SECRET_CAUSE_CLASS', code: 'ECONNRESET', message: 'SECRET_CAUSE' },
  });
  assert.equal(diagnostic.phase, 'unclassified'); assert.equal(diagnostic.tool, 'unclassified');
  assert.equal(diagnostic.error_class, 'Error'); assert.equal(diagnostic.fs_error_code, null);
  assert.equal(diagnostic.causes[0].fs_error_code, null, 'Provider codes are not filesystem codes.');
  assert.deepEqual(diagnostic.frames, [{ module: 'controlled-tools.js', line: 22, column: 3 }]);
  assert.doesNotMatch(JSON.stringify(diagnostic), secrets);
});

test('diagnostics bound causes, stacks and messages and survive hostile getters and cycles', () => {
  const chain = Array.from({ length: 8 }, () => privateError());
  chain.forEach((error, i) => { error.cause = chain[(i + 1) % chain.length]; });
  chain[0].message = 'SECRET_' + 'x'.repeat(100000);
  chain[0].stack = Array.from({ length: 100 }, () => ` at own (${owned('controlled-tools.js')}:9:2)`).join('\n');
  const diagnostic = controlledOperationDiagnostic('operation', 'check_run', chain[0]);
  assert.equal(diagnostic.causes.length, 3); assert.equal(diagnostic.frames.length, 8);
  assert.equal(diagnostic.message_sha256, digest(chain[0].message.slice(0, 64000)));
  assert.ok(JSON.stringify(diagnostic).length < 6000); assert.doesNotMatch(JSON.stringify(diagnostic), secrets);
  const hostile = {};
  for (const key of ['name', 'code', 'message', 'stack', 'cause'])
    Object.defineProperty(hostile, key, { get() { throw new Error('SECRET_GETTER'); } });
  assert.doesNotThrow(() => controlledOperationDiagnostic('operation', 'check_evidence', hostile));
  const cycle = new Error('SECRET_CYCLE'); cycle.cause = cycle;
  assert.deepEqual(controlledOperationDiagnostic('operation', 'check_evidence', cycle).causes, []);
});

async function diagnosticClient(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-operation-diagnostic-')), traces = [];
  const binding = { workflow_id: 'private-workflow', invocation_id: 'private-invocation', stage: 'review', role: 'reviewer',
    implementation_paths: ['src'], verification_paths: ['checks'], procedure_bound: false, cornell_bound: false };
  const server = createControlledMcpServer(root, binding, {
    assertActive() {}, saveReport() {}, readEvidence() { throw privateError(); }, ...overrides,
    trace(value) { traces.push(value); },
  });
  const client = new Client({ name: 'controlled-operation-diagnostic-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  return { traces, client, call: () => client.callTool({ name: 'check_evidence', arguments: { kind: 'workflow' } }) };
}

test('actual MCP unknown failures retain backend diagnostics while returning the unchanged safe typed response', async t => {
  const c = await diagnosticClient(t), response = await c.call(), result = JSON.parse(response.content[0].text);
  assert.equal(response.isError, true); assert.equal(result.code, 'CONTROLLED_OPERATION_FAILED');
  assert.equal(Object.hasOwn(result, 'diagnostic'), false); assert.doesNotMatch(JSON.stringify(response), secrets);
  const failure = c.traces.find(event => event.event === 'tool-result' && event.status === 'failed');
  assert.equal(failure.diagnostic.phase, 'operation'); assert.equal(failure.diagnostic.tool, 'check_evidence');
  assert.equal(failure.diagnostic.error_class, 'TypeError');
  assert.deepEqual(failure.diagnostic.frames, [{ module: 'controlled-review-context.js', line: 123, column: 4 }]);
  assert.doesNotMatch(JSON.stringify(c.traces), secrets);
});

test('actual MCP diagnostics distinguish activity and result-encoding failures without replaying the operation', async t => {
  let calls = 0;
  const inactive = await diagnosticClient(t, { assertActive() { throw privateError(); }, readEvidence() { calls++; } });
  assert.equal((await inactive.call()).isError, true); assert.equal(calls, 0);
  assert.equal(inactive.traces.find(event => event.status === 'failed').diagnostic.phase, 'assert-active');
  const circular = { private: 'SECRET_UNSERIALIZABLE' }; circular.self = circular;
  const encoding = await diagnosticClient(t, { readEvidence() { calls++; return circular; } });
  const response = await encoding.call();
  assert.equal(response.isError, true); assert.equal(calls, 1);
  assert.equal(encoding.traces.find(event => event.status === 'failed').diagnostic.phase, 'result-encoding');
  assert.equal(encoding.traces.filter(event => event.status === 'succeeded').length, 0);
  assert.doesNotMatch(JSON.stringify(response), secrets); assert.doesNotMatch(JSON.stringify(encoding.traces), secrets);
});

test('actual MCP known content and schema errors retain their existing code without unknown-error metadata', async t => {
  for (const error of [new ControlledToolError('NO_CHECK_EVIDENCE', 'The assigned check evidence is unavailable.'),
    new ControlledPayloadError('INVALID_PAYLOAD', 'The prepared data must be an object.'),
    z.object({ title: z.string() }).safeParse({ title: 1 }).error]) {
    const c = await diagnosticClient(t, { readEvidence() { throw error; } }), response = await c.call();
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).code, error instanceof z.ZodError ? 'SCHEMA_INVALID' : error.code);
    const failure = c.traces.find(event => event.status === 'failed');
    assert.equal(Object.hasOwn(failure, 'diagnostic'), false);
  }
});

test('actual MCP preserves only a trusted scan-timeout class as runtime-owned rather than blaming professional content', async t => {
  const trusted = await diagnosticClient(t, { readEvidence() { throw new ControlledEvidenceScanTimeout(10000); } });
  const response = await trusted.call(), result = JSON.parse(response.content[0].text);
  assert.equal(response.isError, true);
  assert.equal(result.code, 'EVIDENCE_SCAN_TIMEOUT');
  assert.equal(result.validation.owner, 'runtime');
  assert.match(result.error, /Keep the saved requirement and preservation scope unchanged/);
  assert.equal(Object.hasOwn(trusted.traces.find(event => event.status === 'failed'), 'diagnostic'), false);
  const untrusted = await diagnosticClient(t, { readEvidence() { throw Object.assign(new Error('SECRET_PROVIDER_ERROR'), { code: 'EVIDENCE_SCAN_TIMEOUT' }); } });
  const unknown = JSON.parse((await untrusted.call()).content[0].text);
  assert.equal(unknown.code, 'CONTROLLED_OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(unknown), /SECRET_PROVIDER_ERROR/);
});

test('the scheduler classifies a trusted changed prepared source as INPUT_CHANGED without exposing its contents', () => {
  const failure = controlledFailure(new ControlledPayloadError('STALE_READ', 'SECRET_PREPARED_SOURCE changed after its retained observation.'));
  assert.equal(failure.code, 'INPUT_CHANGED');
  assert.equal(failure.owner, 'runtime');
  assert.match(failure.next_action, /current inputs.*fresh owned evidence/);
  assert.doesNotMatch(JSON.stringify(failure), /SECRET_PREPARED_SOURCE/);
  assert.equal(controlledFailure(Object.assign(new Error('SECRET_PROVIDER_STALE_READ'), { code: 'STALE_READ' })).code, 'UNEXPECTED_RUNTIME_FAILURE');
});
