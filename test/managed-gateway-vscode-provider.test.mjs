import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const load = () => require('../extensions/vscode-model-bridge/managed-gateway-provider.cjs');
class Text { constructor(value) { this.value = value; } }
class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class Data { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
const vscode = { LanguageModelTextPart: Text, LanguageModelToolCallPart: Call,
  LanguageModelToolResultPart: Result, LanguageModelDataPart: Data,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, LanguageModelChatToolMode: { Auto: 1, Required: 2 } };
test('native gateway conversion retains ordered tool identities, structured results and image bytes', () => {
  const { convertGatewayMessages } = load();
  const value = convertGatewayMessages(vscode, [
    { role: 1, content: [new Text('inspect'), new Data(Uint8Array.of(1, 2, 3), 'image/png')] },
    { role: 2, content: [new Text('calling'), new Call('actual-1', 'check', { value: 7 })] },
    { role: 1, content: [new Result('actual-1', [new Text('C compiler: error at line 9')]), new Text('fix it')] },
  ], { imageInput: true });
  assert.equal(value[0].content[1].image_url.url, 'data:image/png;base64,AQID');
  assert.deepEqual(value[1].tool_calls[0], { id: 'actual-1', type: 'function', function: { name: 'check', arguments: '{"value":7}' } });
  assert.equal(value[2].role, 'tool'); assert.equal(value[2].tool_call_id, 'actual-1');
  assert.match(value[2].content, /C compiler: error at line 9/); assert.equal(value[3].content, 'fix it');
});
test('unsupported images and opaque native input parts fail explicitly instead of silently losing content', () => {
  const { convertGatewayMessages } = load();
  assert.throws(() => convertGatewayMessages(vscode, [{ role: 1, content: [new Data(Uint8Array.of(1), 'image/png')] }], {}), /VISION_UNSUPPORTED/);
  assert.throws(() => convertGatewayMessages(vscode, [{ role: 1, content: [{ secret: 'opaque' }] }], {}), /INPUT_PART_UNSUPPORTED/);
});
test('catalog mapping preserves exact IDs and only declared tool/image support; unknown capacity is not invented', () => {
  const { gatewayModelInformation } = load();
  const model = { id: 'gh/exact', name: 'Exact', family: 'declared', context_length: 128000,
    max_output_tokens: 8000, capabilities: { tools: true, vision: null } };
  assert.equal(gatewayModelInformation(model).maxInputTokens, 120000);
  assert.deepEqual(gatewayModelInformation(model).capabilities, { toolCalling: true, imageInput: false });
  assert.equal(gatewayModelInformation({ ...model, context_length: null }), null);
  assert.match(gatewayModelInformation({ ...model, capability_source: 'upstream-and-user-declaration' }).tooltip, /upstream\/User/);
});
test('native stream preserves required tool mode, cancellation and releases its owned call lease on errors', async () => {
  const { createGatewayChatProvider } = load();
  let released = 0, received;
  const service = { async acquire() { return { baseUrl: 'http://127.0.0.1:3000', generation: 'a', release() { released++; } }; } };
  const provider = createGatewayChatProvider(vscode, { service, client(endpoint) { assert.equal(endpoint.generation, 'a'); return {
    async *chat(input, signal) { received = input; assert.equal(signal.aborted, false);
      yield { type: 'text', text: 'hello' }; yield { type: 'tool-call', id: 'call-1', name: 'check', args: { n: 1 } }; throw Error('QUOTA_EXCEEDED'); },
  }; } });
  const parts = [];
  await assert.rejects(provider.provideLanguageModelChatResponse({ id: 'exact', capabilities: { toolCalling: true } },
    [{ role: 1, content: [new Text('run')] }], { tools: [{ name: 'check', description: 'check', inputSchema: { type: 'object' } }], toolMode: 2 },
    { report(part) { parts.push(part); } }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }), /QUOTA_EXCEEDED/);
  assert.equal(released, 1); assert.equal(received.tool_choice, 'required');
  assert.equal(parts[0].value, 'hello'); assert.equal(parts[1].callId, 'call-1');
});
test('service-owned cancellation reaches inference even when the native token remains live', async () => {
  const { createGatewayChatProvider } = load();
  const controller = new AbortController(); let released = 0, supplied;
  const provider = createGatewayChatProvider(vscode, { service: { async acquire() { return { signal: controller.signal, release() { released++; } }; } },
    client: () => ({ async *chat(_input, signal) { supplied = signal; controller.abort(); yield { type: 'text', text: 'must not be delivered' }; } }) });
  const parts = [];
  await assert.rejects(provider.provideLanguageModelChatResponse({ id: 'exact', capabilities: {} }, [{ role: 1, content: [new Text('x')] }], {},
    { report: x => parts.push(x) }, { isCancellationRequested: false }), error => error.name === 'CancellationError');
  assert.equal(supplied, controller.signal); assert.equal(released, 1); assert.deepEqual(parts, []);
});
test('optional gateway discovery failure cannot remove other native providers or start a model', async () => {
  const { createGatewayChatProvider } = load(); let calls = 0, released = 0;
  const provider = createGatewayChatProvider(vscode, { service: { async acquire() { return { release() { released++; } }; } },
    client: () => ({ async listUsableModels() { throw Object.assign(Error('auth'), { code: 'GATEWAY_AUTHORIZATION' }); }, chat() { calls++; } }) });
  assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }), []);
  assert.equal(calls, 0); assert.equal(released, 1);
});

test('RTK observations contain policy hashes and deferred controls, never raw tool evidence or invented usage', async () => {
  const { createGatewayChatProvider } = load(); const observed = [], parts = []; let released = 0;
  const provider = createGatewayChatProvider(vscode, {
    service: { async acquire() { return { generation: 'owned-generation', tokenSaving: 'off',
      tokenSavingPolicy: { requested: 'upstream-rtk', effective: 'off', deferred: true, reason: 'active-calls', fingerprint: 'b'.repeat(64),
        raw: 'SECRET_CONTROL_BODY' }, release() { released++; } }; } },
    observe(value) { observed.push(value); },
    client: lease => ({ async *chat() {
      assert.equal(lease.tokenSaving, 'off');
      yield { type: 'token-saving', policy: { mode: 'off', header: 'off', reason: 'protected-evidence',
        raw_tool_results_sha256: 'a'.repeat(64), raw_tool_result_bytes: 1000, raw: 'SECRET_TOOL_BODY', billed_tokens: 9999 } };
      yield { type: 'text', text: 'Actual provider response.' };
    } }),
  });
  await provider.provideLanguageModelChatResponse({ id: 'exact', capabilities: {} }, [{ role: 1, content: [new Text('x')] }], {},
    { report: value => parts.push(value) }, { isCancellationRequested: false });
  assert.equal(released, 1); assert.equal(parts.length, 1); assert.equal(parts[0].value, 'Actual provider response.');
  assert.equal(observed[0].control.deferred, true); assert.equal(observed[0].policy.token_savings, 'not-measured');
  assert.equal(observed[0].policy.outbound_compressed_bytes, null);
  assert.equal(JSON.stringify(observed).includes('SECRET'), false); assert.equal(JSON.stringify(observed).includes('9999'), false);
});
