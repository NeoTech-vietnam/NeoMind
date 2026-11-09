import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const base = process.env.WF_GATEWAY_MODULE_BASE ?? new URL('../dist/', import.meta.url).href;
const load = name => import(new URL(name, base.endsWith('/') ? base : base + '/').href);
const { createManagedGatewayClient, validateManagedGatewayModelDeclarations } = await load('managed-gateway-client.js');
const { sanitizeManagedGatewayQuota, assessManagedGatewayCompression } = await load('managed-gateway-policy.js');
const { initializeManagedGatewayRoot, managedGatewayPath, MANAGED_GATEWAY_PIN } = await load('managed-gateway-artifact.js');
const { createManagedGatewayService } = await load('managed-gateway-service.js');
const sse = (values, chunk = 1, onCancel = () => {}) => {
  const data = new TextEncoder().encode(values.map(value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\r\n\r\n').join(''));
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < data.length; offset += chunk) controller.enqueue(data.slice(offset, offset + chunk)); },
    cancel() { onCancel(); } }), { headers: { 'content-type': 'text/event-stream' } });
};
function fixture(extra = {}) {
  const calls = [], endpoint = { baseUrl: 'http://127.0.0.1:19191', generation: randomUUID() };
  const models = extra.models ?? [{ id: 'gh/model', owned_by: 'gh', capabilities: { tools: true, vision: false }, context_length: 32000, max_completion_tokens: 4096 }];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname; calls.push({ path, init });
    if (extra.fetch) return extra.fetch(path, init);
    if (path === '/v1/models') return Response.json({ data: models });
    if (path === '/api/combos') return Response.json({ combos: extra.combos ?? [] });
    if (path === '/api/providers') return Response.json({ connections: extra.connections ?? [] });
    if (path === '/api/models') return Response.json({ models: extra.routing ?? [] });
    return sse(extra.stream ?? [{ model: 'reported-model', choices: [{ delta: { content: 'xin chào' }, finish_reason: 'stop' }] }, '[DONE]']);
  };
  return { calls, endpoint, client: createManagedGatewayClient(endpoint, { getApiKey: () => 'owned-key', getAdminCookie: () => 'auth_token=owned-cookie', fetch,
    ...(extra.modelDeclarations !== undefined ? { modelDeclarations: extra.modelDeclarations } : {}),
    ...(extra.policy ? { policy: extra.policy } : {}), ...(extra.prepareCombo ? { prepareCombo: extra.prepareCombo } : {}), ...(extra.validateCombo ? { validateCombo: extra.validateCombo } : {}) }) };
}
const collect = async stream => { const output = []; for await (const value of stream) output.push(value); return output; };

test('catalog preserves exact IDs and declared/unknown capabilities with generation caching, never inventing upstream identity', async () => {
  const f = fixture({ models: [{ id: 'alias', name: 'Declared alias' }, { id: 'gh/model', owned_by: 'gh', capabilities: { tools: true, vision: false, reasoning: true }, context_length: 64000, max_completion_tokens: 8000 }] });
  const rows = await f.client.listModels(); await f.client.listModels();
  assert.equal(f.calls.length, 1); assert.equal(rows[0].context_length, null); assert.equal(rows[0].capabilities.tools, null);
  assert.equal(rows[1].context_length, 64000); assert.equal(rows[1].capabilities.vision, false);
  assert.equal(rows[1].capability_source, 'upstream-catalog-declaration'); assert.equal(rows[1].upstream_identity, 'not-observed');
  rows[0].id = 'mutated'; assert.equal((await f.client.listModels())[0].id, 'alias');
});

test('native selectable catalog requires connection-enabled canonical routes, supports generic explicit prefixes and omits unapproved combos', async () => {
  const f = fixture({ models: [{ id: 'gh/model', owned_by: 'gh' }, { id: 'cx/model', owned_by: 'cx' }, { id: 'custom/model', owned_by: 'custom' }, { id: 'friendly' }, { id: 'top', owned_by: 'combo' }],
    connections: [{ id: 'a', provider: 'github', isActive: true, testStatus: 'active', providerSpecificData: { copilotToken: 'SECRET' } },
      { id: 'b', provider: 'codex', isActive: false }, { id: 'c', provider: 'openai-compatible-chat-123', isActive: true, providerSpecificData: { prefix: 'custom' } }],
    routing: [{ provider: 'github', routedModel: 'gh/model', fullModel: 'github/model', alias: 'friendly' }], combos: [{ name: 'top', models: ['gh/model', 'custom/model'] }] });
  const rows = await f.client.listUsableModels();
  assert.deepEqual(rows.map(row => row.id), ['gh/model', 'custom/model', 'friendly']);
  assert.equal(JSON.stringify(rows).includes('SECRET'), false);
  assert.ok(rows.every(row => row.availability === 'connection-enabled-not-inference-tested'));
});

test('fragmented UTF8/CRLF text and usage complete on DONE without waiting for server EOF', async () => {
  let cancelled = false;
    const f = fixture({ fetch: async path => path === '/v1/models' ? Response.json({ data: [{ id: 'direct' }] }) : sse([
    { choices: [{ delta: { reasoning_content: 'reasoning' } }] }, { model: 'alias-reported', choices: [{ delta: { content: 'xin chào' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, choices: [] }, '[DONE]'], 1, () => { cancelled = true; }) });
  const events = await collect(f.client.chat({ model: 'direct', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(events.find(event => event.type === 'text').text, 'xin chào'); assert.equal(events.find(event => event.type === 'usage').total_tokens, 12);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.find(event => event.type === 'routing').upstream_verified, false); assert.equal(cancelled, true);
});

test('tool fragments retain exact IDs, arguments, system prompt and raw tool evidence without wrapper invention', async () => {
  const f = fixture({ stream: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { arguments: '"C11 error"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]'] });
  const messages = [{ role: 'system', content: 'Preserve the acceptance criteria.' }, { role: 'tool', tool_call_id: 'previous', content: 'fatal error: assertion failed\n'.repeat(500) }];
  const original = structuredClone(messages), events = await collect(f.client.chat({ model: 'gh/model', messages, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }));
  assert.deepEqual(events.find(event => event.type === 'tool-call'), { type: 'tool-call', id: 'call-1', name: 'lookup', args: { q: 'C11 error' } });
  assert.deepEqual(JSON.parse(f.calls.find(call => call.path === '/v1/chat/completions').init.body).messages, original); assert.deepEqual(messages, original);
  assert.equal(events.at(-1).raw_tool_results_preserved, true);
});

test('incomplete and invalid model tool output fail honestly without automatic provider retries', async () => {
  for (const stream of [[{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'],
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{bad' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']]) {
    const f = fixture({ stream });
    await assert.rejects(collect(f.client.chat({ model: 'gh/model', messages: [] })), error => ['GATEWAY_INCOMPLETE_RESPONSE', 'GATEWAY_TOOL_ARGUMENTS'].includes(error.code));
    assert.equal(f.calls.filter(call => call.path === '/v1/chat/completions').length, 1);
  }
});

test('valid tool JSON without a final response marker never publishes a tool side effect', async () => {
  const f = fixture({ stream: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'write_file', arguments: '{"path":"product.c"}' } }] } }] }, '[DONE]'] });
  const observed = [];
  await assert.rejects(async () => { for await (const event of f.client.chat({ model: 'gh/model', messages: [] })) observed.push(event); },
    error => error.code === 'GATEWAY_INCOMPLETE_RESPONSE');
  assert.equal(observed.some(event => event.type === 'tool-call' || event.type === 'done'), false);
  assert.equal(f.calls.filter(call => call.path === '/v1/chat/completions').length, 1);
});

test('authorization/quota errors are classified without exposing arbitrary upstream text', async () => {
  for (const [status, code] of [[401, 'GATEWAY_AUTHORIZATION'], [429, 'GATEWAY_QUOTA'], [503, 'GATEWAY_PROVIDER_UNAVAILABLE']]) {
    const f = fixture({ fetch: async path => path === '/v1/models' ? Response.json({ data: [{ id: 'direct' }] }) : new Response('SECRET provider credential', { status }) });
    await assert.rejects(collect(f.client.chat({ model: 'direct', messages: [] })), error => error.code === code && !error.message.includes('SECRET'));
    assert.equal(f.calls.filter(call => call.path === '/v1/chat/completions').length, 1);
  }
});

test('vision is never silently dropped and only an explicit declared fallback receives unchanged image bytes', async () => {
  const models = [{ id: 'text', capabilities: { vision: false } }, { id: 'vision', capabilities: { vision: true } }];
  const input = { model: 'text', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] };
  const denied = fixture({ models }); await assert.rejects(collect(denied.client.chat(input)), error => error.code === 'GATEWAY_VISION_UNAVAILABLE');
  assert.equal(denied.calls.some(call => call.path === '/v1/chat/completions'), false);
  const allowed = fixture({ models, policy: { vision_fallback: 'vision' } }), events = await collect(allowed.client.chat(input));
  const actual = JSON.parse(allowed.calls.find(call => call.path === '/v1/chat/completions').init.body);
  assert.equal(actual.model, 'vision'); assert.deepEqual(actual.messages, input.messages);
  assert.equal(events.find(event => event.type === 'routing').reason, 'authorized-vision-fallback');
  const comboFallback = fixture({ models: [...models, { id: 'vision-combo', owned_by: 'combo', capabilities: { vision: true } }],
    policy: { vision_fallback: 'vision-combo', combos: { 'vision-combo': ['vision'] } } });
  await assert.rejects(collect(comboFallback.client.chat(input)), error => error.code === 'GATEWAY_VISION_UNAVAILABLE');
  assert.equal(comboFallback.calls.some(call => call.path === '/v1/chat/completions'), false, 'A combo cannot bypass its owned shadow by being named as a vision fallback.');
});

test('one immutable User declaration snapshot governs native metadata and generic vision admission without overriding upstream false', async () => {
  const declarations = { 'custom/model': { context_length: 32000, max_output_tokens: 4096, tools: true, vision: true } };
  const f = fixture({ models: [{ id: 'custom/model' }], modelDeclarations: declarations });
  declarations['custom/model'].vision = false;
  const row = (await f.client.listModels())[0];
  assert.equal(row.capabilities.vision, true); assert.equal(row.context_length, 32000);
  assert.equal(row.capability_source, 'upstream-and-user-declaration'); assert.deepEqual(row.user_declared_fields, ['context_length', 'max_output_tokens', 'tools', 'vision']);
  const input = { model: 'custom/model', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] };
  assert.equal((await collect(f.client.chat(input))).at(-1).type, 'done');
  assert.deepEqual(JSON.parse(f.calls.find(call => call.path === '/v1/chat/completions').init.body).messages, input.messages);
  const denied = fixture({ models: [{ id: 'custom/model', capabilities: { tools: false, vision: false }, context_length: 8192, max_completion_tokens: 2048 }],
    modelDeclarations: { 'custom/model': { context_length: 99999, max_output_tokens: 9999, tools: true, vision: true } } });
  const known = (await denied.client.listModels())[0];
  assert.equal(known.capabilities.vision, false); assert.equal(known.capabilities.tools, false); assert.equal(known.context_length, 8192);
  assert.equal(known.capability_source, 'upstream-catalog-declaration');
  await assert.rejects(collect(denied.client.chat(input)), error => error.code === 'GATEWAY_VISION_UNAVAILABLE');
  assert.equal(denied.calls.some(call => call.path === '/v1/chat/completions'), false);
});

test('User declarations are validated before any fetch and catalog cache keys cannot cross declaration snapshots', async () => {
  for (const value of [[], { route: { vision: 'true' } }, { route: { context_length: -1 } }, { route: { tools: true, baseUrl: 'https://unapproved' } },
    { route: { context_length: 10, max_output_tokens: 10 } }]) assert.throws(() => validateManagedGatewayModelDeclarations(value), error => error.code === 'GATEWAY_MODEL_DECLARATION');
  const validated = validateManagedGatewayModelDeclarations({ route: { tools: true } });
  assert.equal(Object.isFrozen(validated), true); assert.equal(Object.isFrozen(validated.route), true);
  let fetches = 0; const fetch = async () => { fetches++; return Response.json({ data: [{ id: 'route' }] }); };
  const endpoint = { baseUrl: 'http://127.0.0.1:19191', generation: randomUUID() }, shared = { fetch, getApiKey: () => 'owned-key' };
  const first = createManagedGatewayClient(endpoint, { ...shared, modelDeclarations: { route: { vision: true } } });
  const second = createManagedGatewayClient(endpoint, shared);
  assert.equal((await first.listModels())[0].capabilities.vision, true); assert.equal((await second.listModels())[0].capabilities.vision, null);
  await first.listModels(); assert.equal(fetches, 2);
});

test('a mutable combo alias never reaches inference without exact authorized owned shadow preparation', async () => {
  const settings = { models: [{ id: 'top', owned_by: 'combo' }, { id: 'gh/model', capabilities: { vision: false } }], combos: [{ name: 'top', models: ['gh/model'] }] };
  const denied = fixture(settings); await assert.rejects(collect(denied.client.chat({ model: 'top', messages: [] })), error => error.code === 'GATEWAY_COMBO_NOT_APPROVED');
  assert.equal(denied.calls.some(call => call.path === '/v1/chat/completions'), false);
  const f = fixture({ ...settings, policy: { combos: { top: ['gh/model'] } }, prepareCombo: async (name, members) => {
    assert.equal(name, 'top'); assert.deepEqual(members, ['gh/model']); return 'wf_combo_owned'; }, validateCombo: async () => true });
  const events = await collect(f.client.chat({ model: 'top', messages: [{ role: 'system', content: 'Keep system prompt.' }] }));
  assert.equal(JSON.parse(f.calls.find(call => call.path === '/v1/chat/completions').init.body).model, 'wf_combo_owned');
  assert.equal(events.find(event => event.type === 'routing').requested_model, 'top');
  assert.equal(events.find(event => event.type === 'routing').selected_model, 'wf_combo_owned');
});

test('a previously unseen route is refreshed and classified before inference, never assumed to be a direct model', async () => {
  let catalogs = 0;
  const f = fixture({ fetch: async path => path === '/v1/models' ? Response.json({ data: ++catalogs === 1 ? [] : [{ id: 'new-combo', owned_by: 'combo' }] }) :
    path === '/api/combos' ? Response.json({ combos: [{ name: 'new-combo', models: ['gh/model'] }] }) : assert.fail('No inference may be sent.') });
  await assert.rejects(collect(f.client.chat({ model: 'new-combo', messages: [] })), error => error.code === 'GATEWAY_COMBO_NOT_APPROVED');
  assert.equal(catalogs, 2); assert.equal(f.calls.some(call => call.path === '/v1/chat/completions'), false);
  const missing = fixture({ models: [] });
  await assert.rejects(collect(missing.client.chat({ model: 'not-declared', messages: [] })), error => error.code === 'GATEWAY_MODEL_UNAVAILABLE');
  assert.equal(missing.calls.some(call => call.path === '/v1/chat/completions'), false);
});

test('an edited shadow prevents tool-call publication and completed response', async () => {
  const f = fixture({ models: [{ id: 'top', owned_by: 'combo' }], combos: [{ name: 'top', models: ['gh/model'] }], policy: { combos: { top: ['gh/model'] } },
    prepareCombo: async () => 'wf_combo_owned', validateCombo: async () => false,
    stream: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'execute', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]'] });
  const observed = [];
  await assert.rejects(async () => { for await (const event of f.client.chat({ model: 'top', messages: [] })) observed.push(event); }, error => error.code === 'GATEWAY_COMBO_CHANGED');
  assert.equal(observed.some(event => event.type === 'tool-call' || event.type === 'done'), false);
});

test('quota unknown and RTK byte observations do not fabricate balances or token savings', () => {
  assert.equal(sanitizeManagedGatewayQuota({ accessToken: 'SECRET' }).state, 'unknown');
  const quota = sanitizeManagedGatewayQuota({ used: 2, limit: 10, remaining: 8, resetAt: '2026-11-10T12:00:00Z', token: 'SECRET' });
  assert.equal(quota.remaining, 8); assert.equal(JSON.stringify(quota).includes('SECRET'), false);
  const raw = 'noise\n'.repeat(100) + 'error: missing semicolon\nassertion failed at case 7\n';
  const good = assessManagedGatewayCompression(raw, 'error: missing semicolon\nassertion failed at case 7\n');
  assert.equal(good.diagnostics_preserved, true); assert.equal(good.raw_evidence_required, true); assert.equal(good.token_savings, 'not-measured');
  assert.equal(assessManagedGatewayCompression(raw, 'all fine').diagnostics_preserved, false);
});

test('private root refuses repository paths and adoption of existing unowned data', t => {
  const parent = mkdtempSync(join(tmpdir(), 'wf-gateway-paths-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'owned'); assert.equal(initializeManagedGatewayRoot(root), root); assert.equal(initializeManagedGatewayRoot(root), root);
  const foreign = join(parent, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'db.json'), 'User account data');
  assert.throws(() => initializeManagedGatewayRoot(foreign), error => error.code === 'GATEWAY_NOT_OWNED');
  const repository = join(parent, 'repository'); mkdirSync(repository); mkdirSync(join(repository, '.git'));
  assert.throws(() => initializeManagedGatewayRoot(join(repository, 'gateway')), error => error.code === 'GATEWAY_REPOSITORY_PATH');
  assert.throws(() => managedGatewayPath(root, '../outside'), error => error.code === 'GATEWAY_PRIVATE_PATH');
  const link = join(parent, 'ancestor-link'); symlinkSync(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => initializeManagedGatewayRoot(join(link, 'nested/gateway')), error => error.code === 'GATEWAY_PRIVATE_PATH');
  assert.equal(MANAGED_GATEWAY_PIN.version, '0.5.116');
});

test('a concurrently removed startup lock is reconciled instead of failing the host with ENOENT', async t => {
  for (const removeOnStat of [1, 2]) {
  const root = mkdtempSync(join(tmpdir(), 'wf-gateway-lock-race-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeManagedGatewayRoot(root);
  const lock = join(root, 'startup-lock.json'), generation = randomUUID(); writeFileSync(lock, '{}');
  const originalStat = fs.lstatSync, originalFetch = globalThis.fetch; let raced = false, lockStats = 0;
  fs.lstatSync = function (selected, ...args) {
    if (selected === lock && ++lockStats === removeOnStat && !raced) {
      raced = true; fs.unlinkSync(lock);
      writeFileSync(join(root, 'service.json'), JSON.stringify({ state: 'ready', child_pid: process.pid, generation, baseUrl: 'http://127.0.0.1:19191', artifact: 'owned-fixture' }));
      throw Object.assign(Error('Concurrent release'), { code: 'ENOENT' });
    }
    return originalStat.call(this, selected, ...args);
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => new Response('{}', { headers: { 'set-cookie': 'auth_token=owned-fixture; HttpOnly' } });
  try {
    const service = createManagedGatewayService({ privateRoot: root, nodeCommand: process.execPath,
      secretStore: { async get() { return 'owned-fixture'; }, async store() {} } });
    const endpoint = await service.ensureStarted(); assert.equal(raced, true); assert.equal(endpoint.generation, generation);
  } finally { fs.lstatSync = originalStat; syncBuiltinESMExports(); globalThis.fetch = originalFetch; }
  }
});
