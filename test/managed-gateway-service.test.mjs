import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const base = process.env.WF_GATEWAY_MODULE_BASE ?? new URL('../dist/', import.meta.url).href;
const load = name => import(new URL(name, base.endsWith('/') ? base : base + '/').href);
const { installManagedGateway, verifyManagedGatewayArtifact } = await load('managed-gateway-artifact.js');
const { createManagedGatewayService } = await load('managed-gateway-service.js');
const { createManagedGatewayClient } = await load('managed-gateway-client.js');
const { assessManagedGatewayCompression } = await load('managed-gateway-policy.js');
const candidate = process.env.WF_GATEWAY_ARCHIVE ?? fileURLToPath(new URL('../resources/managed-gateway/9router-0.5.116.tgz', import.meta.url));
if (process.env.WF_REQUIRE_GATEWAY_ARCHIVE === '1' && !existsSync(candidate)) throw Error('The required post-prepack pinned gateway archive is missing; service qualification cannot be skipped.');

test('real pinned standalone service confines state, freezes upstream combos, reconciles a lost create response and preserves a second host',
  { skip: !existsSync(candidate), timeout: 300000 }, async t => {
    const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'wf-managed-gateway-integration-'));
    const values = new Map(), secretStore = { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); } };
    let service, attached, providerFixture;
    t.after(async () => {
      await attached?.dispose(); await service?.dispose();
      if (providerFixture) { providerFixture.closeAllConnections(); await new Promise(resolve => providerFixture.close(resolve)); }
      assert.ok(resolve(root).startsWith(parent + sep)); rmSync(root, { recursive: true, force: true });
    });
    const artifact = await installManagedGateway(root, { allowDownload: false, nodeCommand: process.execPath, archivePath: candidate,
      fetch() { throw Error('Offline preparation must not fetch.'); } });
    assert.equal(verifyManagedGatewayArtifact(root, artifact.id).fingerprint, artifact.fingerprint);
    service = createManagedGatewayService({ privateRoot: root, nodeCommand: process.execPath, secretStore });
    const endpoint = await service.ensureStarted(), client = service.client();
    assert.equal((await client.listUsableModels()).length, 0, 'Static model catalog is not usable before any account connection.');
    assert.equal(existsSync(join(root, 'data/db/data.sqlite')), true);
    const denial = await fetch(endpoint.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unauthorized-negative-control', messages: [] }) });
    assert.equal(denial.status, 401); await denial.body?.cancel();
    const names = [...values.values()];
    assert.ok(names.length >= 3); assert.equal(names.some(value => readFileSync(join(root, 'service.json'), 'utf8').includes(value)), false);
    // Real pinned upstream RTK, with an owned local deterministic HTTP provider.
    // These are gateway transport calls, never paid or real-model inference.
    const captured = [];
    providerFixture = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'rtk-fixture' }] })); return;
      }
      if (request.method === 'POST' && request.url?.endsWith('/chat/completions')) {
        let body = ''; for await (const chunk of request) body += chunk;
        captured.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ id: 'owned-fixture', model: 'rtk-fixture', choices: [{ index: 0, delta: { content: 'Owned transport fixture acknowledged.' }, finish_reason: null }] }) + '\n\n' +
          'data: ' + JSON.stringify({ id: 'owned-fixture', model: 'rtk-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      response.writeHead(404); response.end();
    });
    await new Promise(resolve => providerFixture.listen(0, '127.0.0.1', resolve));
    const node = (await client.adminJson('/api/provider-nodes', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Owned deterministic transport fixture', prefix: 'wf-fixture', type: 'openai-compatible', apiType: 'chat',
        baseUrl: `http://127.0.0.1:${providerFixture.address().port}/v1` }) })).node;
    await client.adminJson('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: node.id, name: 'Owned RTK fixture', apiKey: 'owned-fixture-not-a-provider-credential', testStatus: 'active' }) });
    const collect = async iterable => { for await (const _event of iterable) {} };
    const makeClient = tokenSaving => createManagedGatewayClient(endpoint, { getApiKey: service.getApiKey, getAdminCookie: service.getAdminCookie, tokenSaving });
    const progress = Array.from({ length: 300 }, (_, index) => `Compiling library_${index} v1.0.0`).join('\n') + '\n';
    const messageInput = content => ({ model: 'wf-fixture/rtk-fixture', messages: [{ role: 'system', content: 'Acceptance criteria must remain verbatim.' },
      { role: 'user', content: 'Inspect retained progress.' }, { role: 'assistant', content: null,
        tool_calls: [{ id: 'owned-compile', type: 'function', function: { name: 'compile', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'owned-compile', content }, { role: 'user', content: 'Continue.' }] });
    const off = await service.configureTokenSaving('off'); assert.equal(off.effective, 'off');
    await collect(makeClient('off').chat(messageInput(progress)));
    const rawProgress = captured.at(-1).messages.find(row => row.role === 'tool').content; assert.equal(rawProgress, progress);
    const enabled = await service.configureTokenSaving('upstream-rtk', off.fingerprint); assert.equal(enabled.effective, 'upstream-rtk');
    const activeSaverLease = await service.acquire();
    const deferredSaver = await service.configureTokenSaving('off'); assert.equal(deferredSaver.effective, 'off'); assert.equal(deferredSaver.deferred, true);
    activeSaverLease.release();
    const staleSaver = await service.configureTokenSaving('off', off.fingerprint); assert.equal(staleSaver.effective, 'off'); assert.equal(staleSaver.reason, 'policy-changed');
    await collect(makeClient('upstream-rtk').chat(messageInput(progress)));
    const compact = captured.at(-1).messages.find(row => row.role === 'tool').content, measurement = assessManagedGatewayCompression(progress, compact);
    assert.ok(measurement.bytes_saved > 0, 'The actual pinned upstream RTK must reduce the qualified progress fixture.');
    assert.equal(measurement.diagnostics_preserved, true); assert.equal(measurement.token_savings, 'not-measured');
    const protectedOutput = progress + 'main.c:14:9: error: undeclared symbol\nassertion failed: observed != expected\nAcceptance evidence: cases 17/17 passed\n';
    await collect(makeClient('upstream-rtk').chat(messageInput(protectedOutput)));
    assert.equal(captured.at(-1).messages.find(row => row.role === 'tool').content, protectedOutput, 'The guarded native path must bypass RTK and retain exact diagnostics and acceptance bytes.');
    // Negative control: intentionally bypass our admission guard against only
    // this owned fake provider, exposing the pinned filter's known limitations.
    const unguarded = await fetch(endpoint.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${service.getApiKey()}`, 'x-9router-token-saver': 'on' }, body: JSON.stringify({ ...messageInput(protectedOutput), stream: true }) });
    assert.equal(unguarded.status, 200); await unguarded.text();
    const unsafe = assessManagedGatewayCompression(protectedOutput, captured.at(-1).messages.find(row => row.role === 'tool').content);
    assert.equal(unsafe.diagnostics_preserved, false, 'The independent assessor must detect markers that actual upstream RTK removes without the guard.');
    assert.deepEqual(captured.at(-1).messages.find(row => row.role === 'system'), messageInput(protectedOutput).messages[0]);
    t.diagnostic(JSON.stringify({ proof: 'actual-pinned-upstream-RTK-with-owned-HTTP-fixture', model_inference: false,
      raw_bytes: measurement.raw_bytes, compressed_bytes: measurement.compressed_bytes, bytes_saved: measurement.bytes_saved,
      guarded_diagnostics_exact: true, negative_control_missing_markers: unsafe.missing_protected_line_hashes.length, billed_tokens: 'not-measured' }));
    assert.equal((await service.configureTokenSaving('off')).effective, 'off');
    await client.adminJson('/api/combos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'approved-source', models: ['gh/model'], kind: null }) });
    const actualFetch = globalThis.fetch; let shadowPosts = 0;
    globalThis.fetch = async (...args) => {
      const [url, init] = args, path = new URL(url).pathname;
      if (path === '/api/combos' && init?.method === 'POST' && JSON.parse(init.body).name.startsWith('wf_combo_')) {
        shadowPosts++; const committed = await actualFetch(...args); assert.equal(committed.status, 201); await committed.body?.cancel();
        throw Error('Owned test loses only the actual committed response.');
      }
      return actualFetch(...args);
    };
    let shadow;
    try { shadow = await service.prepareCombo('approved-source', ['gh/model']); }
    finally { globalThis.fetch = actualFetch; }
    assert.equal(shadowPosts, 1); assert.match(shadow, /^wf_combo_[a-f0-9]{40}$/);
    assert.equal(await service.validateCombo(shadow), true);
    assert.equal(await service.prepareCombo('approved-source', ['gh/model']), shadow);
    assert.equal((await client.adminJson('/api/combos')).combos.filter(row => row.name === shadow).length, 1);
    const lease = await service.acquire();
    await assert.rejects(service.activateArtifact(artifact.id), error => error.code === 'GATEWAY_IN_USE');
    lease.release();
    const row = (await client.adminJson('/api/combos')).combos.find(row => row.name === shadow);
    const edit = await fetch(`${endpoint.baseUrl}/api/combos/${row.id}`, { method: 'PUT',
      headers: { cookie: service.getAdminCookie(), 'content-type': 'application/json' }, body: JSON.stringify({ models: ['outside/unauthorized'] }) });
    assert.equal(edit.status, 200); await edit.body?.cancel();
    assert.equal(await service.validateCombo(shadow), false);
    await assert.rejects(service.prepareCombo('approved-source', ['gh/model']), error => error.code === 'GATEWAY_COMBO_CHANGED');
    attached = createManagedGatewayService({ privateRoot: root, nodeCommand: process.execPath, secretStore });
    const same = await attached.ensureStarted(); assert.equal(same.generation, endpoint.generation);
    assert.equal(attached.status().process_owned, false);
    await service.dispose(); service = undefined;
    const health = await fetch(same.baseUrl + '/api/health'); assert.equal(health.status, 200); await health.body?.cancel();
    const attachedLease = await attached.acquire();
    assert.equal(attachedLease.generation, same.generation); attachedLease.release();
    // Closing the final host asks its owned supervisor to stop, without using a
    // PID imported from metadata. No provider/model inference occurs in this test.
    await attached.dispose(); attached = undefined;
  });
