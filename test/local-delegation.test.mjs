import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalDelegator } = require('../extensions/vscode-model-bridge/local-delegation.cjs');
const handoff = model => ({ agentName: 'WF.FnD', prompt: 'Implement the backend-issued bounded task.', description: 'Implement this task',
  ...(model ? { model } : {}) });
const nativeSchema = () => ({ type: 'object', properties: Object.fromEntries(['agentName', 'prompt', 'description', 'model']
  .map(key => [key, { type: 'string' }])), required: ['prompt', 'description'] });
const opaque = Object.freeze({ opaque: Symbol('actual host token') });

function fixture({ schema = nativeSchema(), tools, inventory, invoke, workerProfiles } = {}) {
  const calls = [], selections = [];
  const raw = { content: [{ value: 'A worker report mentioning quota is still unverified content.' }] };
  const vscode = { lm: {
    tools: tools ?? [{ name: 'runSubagent', inputSchema: schema }],
    async selectChatModels(selector) { selections.push(selector); return typeof inventory === 'function' ? inventory() : inventory ?? []; },
    async invokeTool(...args) { calls.push(args); return invoke ? invoke(...args) : raw; },
  } };
  return { delegator: createLocalDelegator(vscode, workerProfiles), calls, selections, raw, vscode };
}

test('a runtime-bound hidden worker profile is observed separately from its professional role', async () => {
  const profiles = Object.fromEntries(['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'].map(role => [role, `${role} Worker`]));
  const app = fixture({ workerProfiles: profiles });
  const result = await app.delegator.invoke(handoff(), opaque);
  assert.equal(app.calls[0][1].input.agentName, 'WF.FnD Worker');
  assert.equal(result.metadata.agentName, 'WF.FnD');
  assert.equal(result.metadata.native_agent_name, 'WF.FnD Worker');
  const invalid = fixture({ workerProfiles: { ...profiles, 'WF.FnD': 'WF.PM' } });
  assert.equal((await invalid.delegator.invoke(handoff(), opaque)).status, 'rejected');
  assert.equal(invalid.calls.length, 0);
});

test('delegator invokes only the issued native specialist arguments with the exact opaque context and cancellation', async () => {
  const app = fixture();
  const cancellation = { isCancellationRequested: false };
  const result = await app.delegator.invoke(handoff(), opaque, cancellation);
  assert.equal(app.calls.length, 1);
  const [name, options, token] = app.calls[0];
  assert.equal(name, 'runSubagent');
  assert.deepEqual(options.input, handoff());
  assert.equal(options.toolInvocationToken, opaque);
  assert.equal(token, cancellation);
  assert.equal(app.selections.length, 0, 'Inheriting the parent does not invent or require a model alias');
  assert.equal(result.raw_result, app.raw);
  assert.equal(result.status, 'returned');
  assert.equal(result.metadata.transport, 'vscode-native');
  assert.equal(result.metadata.invoked, true);
  assert.match(result.metadata.host_call_id, /^[a-f0-9-]{36}$/);
  assert.equal(result.metadata.native_context_id, null);
  assert.equal('host_call_id' in options.input, false);
  assert.equal(result.metadata.outcome, 'unverified');
  assert.equal(result.metadata.resolved_model, 'unknown');
  assert.equal(result.metadata.resolved_provider, 'unknown');
  assert.deepEqual(result.metadata.requested_model, { selection: 'inherit' });
});

test('explicit selection uses the current inventory name and keeps requested and resolved identities separate', async () => {
  const app = fixture({ inventory: [{ id: 'choice', vendor: 'customendpoint', name: 'Available Model' }] });
  const result = await app.delegator.invoke(handoff({ id: 'choice', vendor: 'customendpoint' }), opaque);
  assert.deepEqual(app.selections, [{}]);
  assert.equal(app.calls[0][1].input.model, 'Available Model (customendpoint)');
  assert.deepEqual(result.metadata.requested_model, { selection: 'explicit', id: 'choice', vendor: 'customendpoint',
    name: 'Available Model', native_argument: 'Available Model (customendpoint)' });
  assert.equal(result.metadata.resolved_model, 'unknown');
  assert.equal(result.metadata.resolved_provider, 'unknown');
});

test('an invocation keeps its issued prompt and model selection while inventory lookup is pending', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = fixture({ inventory: () => pending });
  const input = handoff({ id: 'original', vendor: 'vendor' });
  const result = app.delegator.invoke(input, opaque);
  input.prompt = 'A different task must not replace the issued invocation';
  input.model.id = 'changed';
  release([{ id: 'original', vendor: 'vendor', name: 'Original' }]);
  assert.equal((await result).status, 'returned');
  assert.equal(app.calls[0][1].input.prompt, handoff().prompt);
  assert.equal(app.calls[0][1].input.model, 'Original (vendor)');
});

test('concurrent native calls keep distinct host IDs, role inputs and opaque tokens', async () => {
  let release;
  const firstResult = new Promise(resolve => { release = resolve; });
  const app = fixture({ invoke: (_name, options) => options.input.agentName === 'WF.FnD' ? firstResult : { content: [{ value: 'Second report' }] } });
  const secondToken = Object.freeze({ opaque: Symbol('second host token') });
  const first = app.delegator.invoke(handoff(), opaque);
  const second = await app.delegator.invoke({ ...handoff(), agentName: 'WF.Tester' }, secondToken);
  const raw = { content: [{ value: 'First report' }] };
  release(raw);
  const result = await first;
  assert.equal(result.raw_result, raw);
  assert.notEqual(result.metadata.host_call_id, second.metadata.host_call_id);
  assert.equal(result.metadata.agentName, 'WF.FnD');
  assert.equal(second.metadata.agentName, 'WF.Tester');
  assert.equal(app.calls[0][1].toolInvocationToken, opaque);
  assert.equal(app.calls[1][1].toolInvocationToken, secondToken);
});

test('only the five specialist role names are delegated and manager recursion is refused', async () => {
  for (const agentName of ['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester']) {
    const app = fixture();
    assert.equal((await app.delegator.invoke({ ...handoff(), agentName }, opaque)).status, 'returned');
  }
  for (const agentName of ['WF.PM', 'WF.Tester Native Proof', 'general-purpose']) {
    const app = fixture();
    assert.equal((await app.delegator.invoke({ ...handoff(), agentName }, opaque)).error.code, 'INVALID_HANDOFF');
    assert.equal(app.calls.length, 0);
  }
});

test('malformed handoffs and missing invocation context never reach a native tool', async () => {
  for (const input of [null, { ...handoff(), prompt: '' }, { ...handoff(), description: [] },
    { ...handoff(), claim_token: 'do-not-forward' }, handoff({ id: 'choice', vendor: 'vendor', cost_tier: 'strong' })]) {
    const app = fixture();
    assert.equal((await app.delegator.invoke(input, opaque)).error.code, 'INVALID_HANDOFF');
    assert.equal(app.calls.length, 0);
  }
  const app = fixture();
  assert.equal((await app.delegator.invoke(handoff(), undefined)).error.code, 'INVOCATION_TOKEN_REQUIRED');
  assert.equal(app.calls.length, 0);
});

test('missing, renamed or duplicate native tools are refused without fuzzy matching', async () => {
  for (const tools of [[], [{ name: 'mcp_runSubagent', inputSchema: nativeSchema() }],
    [{ name: 'runSubagent', inputSchema: nativeSchema() }, { name: 'runSubagent', inputSchema: nativeSchema() }]]) {
    const app = fixture({ tools });
    assert.equal((await app.delegator.invoke(handoff(), opaque)).error.code, 'NATIVE_TOOL_UNAVAILABLE');
    assert.equal(app.calls.length, 0);
  }
});

test('schema checks reject changed field types, missing inputs and unsupported required fields', async () => {
  const schemas = [undefined, { type: 'array' }, { ...nativeSchema(), required: ['prompt'] },
    { ...nativeSchema(), required: ['prompt', 'description', 'unknown'] },
    { ...nativeSchema(), required: ['prompt', 'description', 'model'] }];
  const wrongType = nativeSchema(); wrongType.properties.agentName.type = 'object'; schemas.push(wrongType);
  const missingName = nativeSchema(); delete missingName.properties.agentName; schemas.push(missingName);
  const narrowed = nativeSchema(); narrowed.properties.agentName.enum = ['Some Other Agent']; schemas.push(narrowed);
  const composed = nativeSchema(); composed.properties.prompt.anyOf = [{ type: 'string' }]; schemas.push(composed);
  for (const schema of schemas) {
    const app = fixture({ tools: [{ name: 'runSubagent', inputSchema: schema }] });
    const result = await app.delegator.invoke(handoff(), opaque);
    assert.equal(result.error.code, 'NATIVE_SCHEMA_INCOMPATIBLE');
    assert.equal(result.metadata.invoked, false);
    assert.equal(app.calls.length, 0);
  }
});

test('an explicit model requires a supported string model field and a unique inventory match', async () => {
  const model = { id: 'choice', vendor: 'vendor', name: 'Choice' };
  for (const inventory of [[], [model, model], [{ ...model, vendor: 'another' }]]) {
    const app = fixture({ inventory });
    assert.equal((await app.delegator.invoke(handoff({ id: 'choice', vendor: 'vendor' }), opaque)).error.code, 'MODEL_UNAVAILABLE');
    assert.equal(app.calls.length, 0);
  }
  const schema = nativeSchema(); delete schema.properties.model;
  const app = fixture({ schema, inventory: [model] });
  assert.equal((await app.delegator.invoke(handoff({ id: 'choice', vendor: 'vendor' }), opaque)).error.code, 'NATIVE_SCHEMA_INCOMPATIBLE');
  assert.equal(app.calls.length, 0);
});

test('an explicitly configured model that loses tool capability is refused before invocation', async () => {
  const app = fixture({ inventory: [{ id: 'choice', vendor: 'vendor', name: 'Text only', capabilities: { toolCalling: false } }] });
  const observations = [];
  const result = await app.delegator.invoke(handoff({ id: 'choice', vendor: 'vendor' }), opaque, undefined, value => observations.push(value));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'MODEL_TOOL_CALLING_UNAVAILABLE');
  assert.equal(result.error.category, 'configuration');
  assert.equal(result.metadata.invoked, false); assert.equal(result.metadata.host_call_id, null);
  assert.equal(app.calls.length, 0); assert.deepEqual(observations, []);
  assert.deepEqual(result.metadata.requested_model, { selection: 'explicit', id: 'choice', vendor: 'vendor' });
});

test('a native model policy refusal retains one real failed invocation without claiming applied or retrying', async () => {
  const app = fixture({ invoke() { throw new Error('Model access denied by client cost-tier policy; PRIVATE_DETAIL'); } });
  const result = await app.delegator.invoke(handoff(), opaque);
  assert.equal(result.status, 'rejected'); assert.equal(result.metadata.invoked, true);
  assert.equal(app.calls.length, 1); assert.equal(result.metadata.outcome, 'unknown');
  assert.equal(result.metadata.resolved_model, 'unknown'); assert.equal(result.metadata.resolved_provider, 'unknown');
  assert.equal('applied' in result, false); assert.equal('applied' in result.metadata, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DETAIL/);
});

test('cancellation before dispatch prevents calls; cancellation during a call keeps effects unknown', async () => {
  const app = fixture();
  const early = await app.delegator.invoke(handoff(), opaque, { isCancellationRequested: true });
  assert.equal(early.status, 'cancelled');
  assert.equal(early.metadata.invoked, false);
  assert.equal(early.metadata.host_call_id, null);
  assert.equal(app.calls.length, 0);
  const token = { isCancellationRequested: false };
  const running = fixture({ invoke() { token.isCancellationRequested = true; throw new Error('Native cancellation'); } });
  const later = await running.delegator.invoke(handoff(), opaque, token);
  assert.equal(later.status, 'cancelled');
  assert.equal(later.metadata.invoked, true);
  assert.match(later.metadata.host_call_id, /^[a-f0-9-]{36}$/);
  assert.equal(later.metadata.outcome, 'unknown');
  assert.equal(running.calls.length, 1);
});

test('cancellation during inventory lookup stops before native invocation', async () => {
  const cancellation = { isCancellationRequested: false };
  const app = fixture({ inventory() {
    cancellation.isCancellationRequested = true;
    return [{ id: 'choice', vendor: 'vendor', name: 'Choice' }];
  } });
  const result = await app.delegator.invoke(handoff({ id: 'choice', vendor: 'vendor' }), opaque, cancellation);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.metadata.invoked, false);
  assert.equal(result.metadata.host_call_id, null);
  assert.equal(app.calls.length, 0);
});

test('the confirmed native core agent-policy rejection is sanitized compatibility evidence without another native or model call', async () => {
  const privateName = 'WF.P-RES Worker MCP b5d020825139f00d', privatePath = 'C:\\PRIVATE\\workspace\\agent.agent.md', privateSecret = 'PRIVATE_PROVIDER_TOKEN';
  const profiles = Object.fromEntries(['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'].map(role => [role, `${role} Worker`]));
  const prepared = { role: 'WF.P-RES', profile: { name: privateName } };
  const app = fixture({ invoke() { throw new Error(`Requested agent '${privateName}' is not allowed by the current agent. ${privatePath} ${privateSecret}`); } });
  const delegator = createLocalDelegator(app.vscode, profiles, { isPrepared: value => value === prepared });
  const result = await delegator.invoke({ ...handoff(), agentName: 'WF.P-RES' }, opaque, undefined, undefined, prepared);
  assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'NATIVE_AGENT_POLICY'); assert.equal(result.error.category, 'compatibility');
  assert.equal(result.metadata.invoked, true, 'The actual native host API was called; this does not imply a child provider/model started.');
  assert.equal(result.metadata.native_agent_name, privateName); assert.equal(result.metadata.agentName, 'WF.P-RES');
  assert.match(result.metadata.host_call_id, /^[a-f0-9-]{36}$/); assert.equal(result.metadata.outcome, 'unknown');
  assert.equal(app.calls.length, 1, 'An admission-policy error must not trigger a retry or an unrelated worker.');
  assert.equal(app.selections.length, 0, 'No provider diagnosis or automatic model selection is warranted.');
  assert.doesNotMatch(JSON.stringify(result.error), /b5d020825139f00d|PRIVATE|C:\\\\|Requested agent '/);
});

test('known provider failures stay observable without exposing raw error secrets or retrying', async () => {
  for (const [error, code, category] of [
    [{ status: 429, message: 'secret provider token' }, 'PROVIDER_QUOTA', 'provider-quota'],
    [{ code: '401', message: 'secret provider token' }, 'PROVIDER_AUTHORIZATION', 'provider-authorization'],
    [{ code: 'model_not_supported' }, 'PROVIDER_MODEL_UNAVAILABLE', 'provider-model'],
    [{ code: 'ETIMEDOUT' }, 'PROVIDER_CONNECTION', 'provider-connection'],
    [{ message: 'secret provider token' }, 'NATIVE_INVOCATION_FAILED', 'unknown'],
  ]) {
    const app = fixture({ invoke() { throw error; } });
    const result = await app.delegator.invoke(handoff(), opaque);
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, code);
    assert.equal(result.error.category, category);
    assert.equal(result.metadata.outcome, 'unknown');
    assert.equal(app.calls.length, 1);
    assert.equal(JSON.stringify(result).includes('secret provider token'), false);
  }
});

test('inventory failure never silently changes model or falls back', async () => {
  const app = fixture({ inventory() { throw new Error('Inventory temporarily unavailable'); } });
  const result = await app.delegator.invoke(handoff({ id: 'choice', vendor: 'vendor' }), opaque);
  assert.equal(result.error.code, 'MODEL_INVENTORY_UNAVAILABLE');
  assert.equal(app.calls.length, 0);
});

test('native returned content remains raw and unverified even when empty or reporting an error', async () => {
  const calls = new Set();
  for (const raw of [undefined, { content: [] }, { content: [{ value: 'Agent completed with no output' }] },
    { content: [{ value: 'The observed diagnostic was: Error invoking subagent: HTTP 429' }] }]) {
    const app = fixture({ invoke: () => raw });
    const result = await app.delegator.invoke(handoff(), opaque);
    assert.equal(result.status, 'returned');
    assert.equal(result.raw_result, raw);
    assert.equal(result.metadata.outcome, 'unverified');
    assert.equal(result.metadata.resolved_model, 'unknown');
    assert.equal(calls.has(result.metadata.host_call_id), false);
    calls.add(result.metadata.host_call_id);
  }
});

const actualNativeFailure = reason => `Agent error: Sorry, your request failed. Please try again.\n\nClient Request Id: 11111111-2222-4333-8444-555555555555\n\nReason: ${reason}\n\tat PH._provideLanguageModelResponse (C:\\PRIVATE\\extension.js:1617:16649)`;
test('the actual native Agent error tool-text envelope is a sanitized provider protocol failure, not a professional result', async () => {
  const raw = { content: [{ value: actualNativeFailure('Response contained no choices.: Error: Response contained no choices.') }] };
  const app = fixture({ invoke: () => raw }), result = await app.delegator.invoke(handoff(), opaque);
  assert.equal(result.status, 'rejected'); assert.equal(result.error.code, 'PROVIDER_PROTOCOL'); assert.equal(result.error.category, 'provider-protocol');
  assert.equal(result.metadata.invoked, true); assert.equal(result.metadata.outcome, 'unknown');
  assert.equal(result.metadata.resolved_model, 'unknown'); assert.equal(result.metadata.resolved_provider, 'unknown');
  assert.equal(result.raw_result, undefined); assert.equal(app.calls.length, 1); assert.equal(app.selections.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|11111111|PH\._provide|Client Request Id|Sorry, your request failed/);
  assert.equal(raw.content[0].value, actualNativeFailure('Response contained no choices.: Error: Response contained no choices.'), 'The host result itself is never rewritten');
});
test('known and unknown native failure wrappers keep their category, actual call and uncertain effects without retry', async () => {
  for (const [value, code] of [
    [actualNativeFailure('HTTP 429 quota_exhausted PRIVATE_TOKEN'), 'PROVIDER_QUOTA'],
    [actualNativeFailure('HTTP 401 invalid_api_key PRIVATE_TOKEN'), 'PROVIDER_AUTHORIZATION'],
    ['Error invoking subagent: model_not_supported PRIVATE_TOKEN', 'PROVIDER_MODEL_UNAVAILABLE'],
    ['Agent error: Native implementation details PRIVATE_TOKEN', 'NATIVE_INVOCATION_FAILED'],
    [actualNativeFailure('Response contained no choices.').replace(':1617:16649', ':401:429'), 'PROVIDER_PROTOCOL'],
    [actualNativeFailure('Unexpected native response.').replace(':1617:16649', ':429:401'), 'NATIVE_INVOCATION_FAILED'],
  ]) {
    const app = fixture({ invoke: () => ({ content: [{ value }] }) }), result = await app.delegator.invoke(handoff(), opaque);
    assert.equal(result.status, 'rejected'); assert.equal(result.error.code, code);
    assert.equal(result.metadata.invoked, true); assert.equal(result.metadata.outcome, 'unknown'); assert.equal(app.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|implementation details|Client Request Id/);
  }
});
test('professional quoted, fenced and structured descriptions of a native failure remain unverified content', async () => {
  const error = actualNativeFailure('Response contained no choices.');
  for (const value of [`The provider returned:\n${error}`, `> ${error}`, `\`\`\`text\n${error}\n\`\`\``,
    JSON.stringify({ summary: error, verdict: 'findings', findings: ['Provider response must be inspected.'] })]) {
    const raw = { content: [{ value }] }, app = fixture({ invoke: () => raw }), result = await app.delegator.invoke(handoff(), opaque);
    assert.equal(result.status, 'returned'); assert.equal(result.raw_result, raw); assert.equal(result.metadata.outcome, 'unverified');
  }
});
test('sanitized managed gateway codes survive native text wrapping without raw HTTP credentials', async () => {
  for (const [gateway, expected] of [
    ['GATEWAY_AUTHORIZATION', 'PROVIDER_AUTHORIZATION'], ['GATEWAY_QUOTA', 'PROVIDER_QUOTA'],
    ['GATEWAY_CONNECTION', 'PROVIDER_CONNECTION'], ['GATEWAY_PROVIDER_UNAVAILABLE', 'PROVIDER_CONNECTION'],
    ['GATEWAY_MODEL_NOT_APPROVED', 'PROVIDER_MODEL_UNAVAILABLE'], ['GATEWAY_PROTOCOL', 'PROVIDER_PROTOCOL'],
    ['GATEWAY_STREAM_INCOMPLETE', 'PROVIDER_PROTOCOL'], ['GATEWAY_CANCELLED', 'CANCELLED'],
  ]) {
    const app = fixture({ invoke: () => ({ content: [{ value: actualNativeFailure(`[${gateway}] Sanitized provider message.`) }] }) });
    const result = await app.delegator.invoke(handoff(), opaque);
    assert.equal(result.error.code, expected); assert.equal(result.metadata.outcome, 'unknown'); assert.equal(app.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|11111111|Client Request Id/);
  }
});
