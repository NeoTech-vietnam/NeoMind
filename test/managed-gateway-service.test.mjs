import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const base = process.env.WF_GATEWAY_MODULE_BASE ?? new URL('../dist/', import.meta.url).href;
const load = name => import(new URL(name, base.endsWith('/') ? base : base + '/').href);
const { installManagedGateway, verifyManagedGatewayArtifact } = await load('managed-gateway-artifact.js');
const { createManagedGatewayService } = await load('managed-gateway-service.js');
const candidate = process.env.WF_GATEWAY_ARCHIVE ?? fileURLToPath(new URL('../resources/managed-gateway/9router-0.5.116.tgz', import.meta.url));

test('real pinned standalone service confines state, freezes upstream combos, reconciles a lost create response and preserves a second host',
  { skip: !existsSync(candidate), timeout: 300000 }, async t => {
    const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'wf-managed-gateway-integration-'));
    const values = new Map(), secretStore = { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); } };
    let service, attached;
    t.after(async () => {
      await attached?.dispose(); await service?.dispose();
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
