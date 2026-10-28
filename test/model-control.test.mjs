// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readConfig, withOperationLock } from '../dist/storage.js';
import { canonicalJson, ensureRoutingPolicy, readRoutingPolicy, roleModelPolicy, routingConfigurationHashes, readInvocation, routingProblems } from '../dist/routing.js';
import { roleCapabilities } from '../dist/tools.js';
import { vscodeSelection } from '../dist/vscode-policy.js';
import { configureRouter, modelControlStatus, readRouterConfiguration, routerHealth, routerModels, routerProbe, setRoleModel } from '../dist/model-control.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-model-control-'));
  initialize(root); ensureRoutingPolicy(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function signedReceipt(root, state = 'running', namespace = 'neomind', fields = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = createHash('sha256').update(pem).digest('hex');
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true });
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  writeFileSync(join(root, `.neomind/native/keys/${keyId}.pem`), pem);
  const id = randomUUID();
  const receipt = { schema_version: 1, issuer: `${namespace}-vscode-lm`, id,
    project_id: readConfig(root).project_id, receipt_path: `.${namespace}/native/receipts/${id}.json`,
    key_id: keyId, role: 'developer', state, owner_pid: process.pid, ...fields };
  const signature = sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString('base64');
  writeFileSync(join(root, `.neomind/native/receipts/${id}.json`), JSON.stringify({ ...receipt, signature }));
  return id;
}

test('role override changes only the selected role and resolves catalog provider identity', t => {
  const root = project(t);
  const policy = ensureRoutingPolicy(root);
  policy.language_models_file = 'catalog.json';
  writeFileSync(join(root, 'catalog.json'), JSON.stringify([
    { name: '9Router', vendor: 'customendpoint', apiKey: 'secret-catalog', models: [{ id: 'cc/model', name: 'My Model' }] },
    { name: 'Other', vendor: 'customendpoint', models: [{ id: 'cc/model', name: 'Other Model' }] },
  ]));
  writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
  const before = roleModelPolicy(root, 'reviewer');
  const hashes = routingConfigurationHashes(root);
  const result = setRoleModel(root, { role: 'developer', model: 'My Model', provider: '9Router', effort: 'medium' });
  assert.equal(result.model, 'cc/model');
  assert.equal(result.applies_to, 'next-invocation');
  assert.deepEqual(roleModelPolicy(root, 'developer'), { role: 'developer', strong: false,
    models: ['cc/model'], provider: '9Router', reasoning_effort: 'medium' });
  assert.deepEqual(vscodeSelection(root, 'developer', 'cc/model'), { vendor: 'customendpoint', id: 'cc/model' });
  assert.deepEqual(roleModelPolicy(root, 'reviewer'), before);
  assert.notDeepEqual(routingConfigurationHashes(root), hashes);
  assert.doesNotMatch(JSON.stringify(modelControlStatus(root)), /secret-catalog/);
  const saved = readFileSync(join(root, '.neomind/routing.json'), 'utf8');
  assert.throws(() => setRoleModel(root, { role: 'developer', model: 'cc/model', provider: 'customendpoint' }), /exactly one/);
  assert.equal(readFileSync(join(root, '.neomind/routing.json'), 'utf8'), saved);
});

test('invalid role overrides and active signed invocations leave configuration unchanged', t => {
  const root = project(t);
  const path = join(root, '.neomind/routing.json');
  const before = readFileSync(path, 'utf8');
  assert.throws(() => setRoleModel(root, { role: 'unknown', model: 'x' }));
  assert.throws(() => setRoleModel(root, { role: 'developer', model: 'x', provider: '9Router' }), /requires.*catalog/);
  const id = signedReceipt(root);
  assert.deepEqual(modelControlStatus(root).active_invocations, [{ id, role: 'developer', state: 'running' }]);
  assert.throws(() => setRoleModel(root, { role: 'reviewer', model: 'x' }), /invocation is active/);
  assert.throws(() => configureRouter(root, { base_url: 'http://127.0.0.1:20128/v1' }), /invocation is active/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readRouterConfiguration(root), null);
});

test('historical TaskForces receipt signatures and identity remain readable verbatim', t => {
  const root = project(t);
  const id = signedReceipt(root, 'completed', 'taskforces');
  const path = join(root, `.neomind/native/receipts/${id}.json`);
  const before = readFileSync(path, 'utf8');
  assert.equal(readInvocation(root, id).issuer, 'taskforces-vscode-lm');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('historical VS Code receipts retain their namespace-specific protocol and configuration hash identity', t => {
  for (const namespace of ['taskforces', 'verythinker']) {
    const root = project(t);
    const policy = { ...ensureRoutingPolicy(root), vscode_effort_policy: 'allow-unavailable' };
    writeFileSync(join(root, '.neomind/routing.json'), JSON.stringify(policy));
    const digest = value => createHash('sha256').update(value).digest('hex');
    const operations = roleCapabilities('developer').operations;
    const fields = {
      execution_mode: 'vscode-extension-host', identity_provenance: 'local-vscode-extension-host',
      host_instance: 'a'.repeat(64), protocol_sha256: digest(`${namespace}-vscode-lm-v1`), runtime_integrity: '',
      native_sandbox: null, native_thread_id: `vscode-host:conversation:${randomUUID()}`,
      native_turn_id: `vscode-host:turn:${randomUUID()}`, client_version: '1.109.0', effort_support: 'unavailable',
      reasoning_effort: 'low', confirmed_reasoning_effort: null, native_tool_scope: operations,
      gateway_policy_sha256: digest(canonicalJson(operations)), requested_model: policy.worker_models[0],
      confirmed_model: policy.worker_models[0], model_provider: 'copilot', workflow_id: null, task_id: null,
      routing_sha256: digest(canonicalJson(policy)), inference_completed: true, reroutes: [],
      configuration_hashes: Object.fromEntries(Object.entries(routingConfigurationHashes(root)).map(([path, value]) =>
        [path.replace(/^\.neomind\//, `.${namespace}/`), value])),
    };
    const id = signedReceipt(root, 'completed', namespace, fields);
    assert.deepEqual(routingProblems(root, 'developer', id), []);
  }
});

test('configuration setters share the native dispatch lock before checking idle state', t => {
  const root = project(t);
  const path = join(root, '.neomind/routing.json'), original = readFileSync(path, 'utf8');
  withOperationLock(root, 'native-dispatch', () => {
    assert.throws(() => setRoleModel(root, { role: 'developer', model: 'next' }), /native-dispatch.*already running/);
    assert.throws(() => configureRouter(root, { base_url: 'http://localhost:20128' }), /native-dispatch.*already running/);
  });
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('router config is secret-free, local-only, and included in routing fingerprints only when present', t => {
  const root = project(t);
  const hashes = routingConfigurationHashes(root);
  assert.equal(hashes['.neomind/router.json'], undefined);
  for (const base_url of ['https://example.com/v1', 'http://user:secret@localhost:20128/v1',
    'http://localhost:20128/v1?key=secret', 'http://localhost:20128/custom']) {
    assert.throws(() => configureRouter(root, { base_url }));
  }
  assert.throws(() => configureRouter(root, { base_url: 'http://localhost:20128', api_key: 'secret' }));
  assert.equal(existsSync(join(root, '.neomind/router.json')), false);
  assert.deepEqual(configureRouter(root, { base_url: 'http://127.0.0.1:20128' }), {
    schema_version: 1, base_url: 'http://127.0.0.1:20128/v1',
    api_key_env: 'NEOMIND_ROUTER_API_KEY', catalog_provider: '9Router',
  });
  assert.match(routingConfigurationHashes(root)['.neomind/router.json'], /^[a-f0-9]{64}$/);
  assert.equal(readRoutingPolicy(root).role_models, undefined);
});

test('upstream instruction fingerprints track pins while remote observation metadata stays independent', t => {
  const root = project(t);
  assert.equal(routingConfigurationHashes(root)['upstream-instructions'], undefined);
  const source = { id: 'example', repository: 'example/source', ref: 'main', commit: 'a'.repeat(40),
    latest_commit: 'a'.repeat(40), previous_commits: [], role: 'researcher',
    instruction_paths: ['SKILL.md'], instructions: [{ path: 'SKILL.md', sha256: 'b'.repeat(64),
      git_blob_sha: 'c'.repeat(40), bytes: 42 }], metadata: { repository: 'example/source', stars: 1000 },
    checked_at: '2026-10-23T00:00:00Z' };
  const registry = { schema_version: 1, minimum_stars: 1000, sources: [source] };
  const path = join(root, '.neomind/upstreams.json');
  writeFileSync(path, JSON.stringify(registry));
  const original = routingConfigurationHashes(root);
  source.checked_at = '2026-10-24T00:00:00Z'; source.latest_commit = 'd'.repeat(40);
  source.metadata.stars = 2000;
  writeFileSync(path, JSON.stringify(registry));
  assert.deepEqual(routingConfigurationHashes(root), original);
  source.instructions[0].sha256 = 'e'.repeat(64);
  writeFileSync(path, JSON.stringify(registry));
  assert.notEqual(routingConfigurationHashes(root)['upstream-instructions'], original['upstream-instructions']);
});

test('authenticated router diagnostics use verified endpoints and filter model payloads', async t => {
  const root = project(t);
  const requests = [];
  const secretName = `NEOMIND_TEST_KEY_${process.pid}`;
  process.env[secretName] = 'test-private-key';
  t.after(() => { delete process.env[secretName]; });
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    assert.equal(request.headers.authorization, 'Bearer test-private-key');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/health') response.end(JSON.stringify({ ok: true }));
    else if (request.url === '/v1/models') response.end(JSON.stringify({ object: 'list', data: [
      { id: 'cc/model', owned_by: 'anthropic', apiKey: 'must-not-escape' }, { id: 'cc/model' },
    ] }));
    else {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'cc/model');
      assert.equal(body.stream, false);
      response.end(JSON.stringify({ id: 'response-1', model: 'backend/model', choices: [{ finish_reason: 'stop' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  configureRouter(root, { base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: secretName });
  assert.deepEqual(await routerHealth(root), { ok: true });
  assert.deepEqual(await routerModels(root), [{ id: 'cc/model' }]);
  const probe = await routerProbe(root, 'cc/model');
  assert.equal(probe.returned_model, 'backend/model');
  assert.equal(probe.completed, true);
  assert.equal(probe.effort_confirmed, false);
  assert.equal(probe.sandbox_confirmed, false);
  assert.deepEqual(requests, ['/api/health', '/v1/models', '/v1/chat/completions']);
  assert.doesNotMatch(JSON.stringify(modelControlStatus(root)), /test-private-key|must-not-escape/);
});

test('router refusals retain status without persisting raw provider errors or credentials', async t => {
  const root = project(t);
  const server = createServer((request, response) => {
    response.statusCode = 401; response.end('secret-private-provider-error');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  configureRouter(root, { base_url: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(routerModels(root), { message: 'Router request failed (HTTP 401).' });
});
