import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { initialize, safePath } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { createOpenCodeGateway, openCodeConfiguration, openCodeEndpoint, openCodeError, startOpenCodeEngine,
  opencodeRuntimeVersion, opencodeProtocol, opencodeRuntimeIntegrity } from '../dist/opencode-engine.js';
import { openCodeStorage, openCodeStorageFailure, openCodeMinimumFreeBytes } from '../dist/opencode-engine.js';
import { openCodeWindowsGuardian, validateOpenCodeWindowsGuardian } from '../dist/opencode-engine.js';
import { OpenCodeSession, openCodeAttestation, openCodeSystemText } from '../dist/opencode-session.js';
import { registerControlledContext } from '../dist/controlled-context.js';
import { secureHostPrivateDirectory } from '../dist/vscode-wire.js';

function project(t, catalog, engine = false) {
  const parent = engine ? resolve('artifacts/test-temp') : tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'wf-opencode-policy-'));
  initialize(root, { project_id: 'WF-ENGINE', name: 'Engine test' });
  const catalogPath = join(root, 'private-models.json');
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const policy = { ...ensureRoutingPolicy(root), strong_model: 'top-models', worker_models: ['worker-models'],
    strong_provider: 'customendpoint', worker_provider: 'customendpoint', language_models_file: catalogPath };
  writeFileSync(safePath(root, '.neomind/routing.json'), JSON.stringify(policy));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, receipt: { role: 'developer', requested_model: 'worker-models' } };
}

test('custom endpoint resolution is role-bound, unambiguous and does not require provider defaults', t => {
  const { root, receipt } = project(t, [{ name: '9router', vendor: 'customendpoint', apiKey: 'private-value', models: [
    { id: 'worker-models', url: 'http://127.0.0.1:20128/v1' }, { id: 'top-models', url: 'http://127.0.0.1:20128/v1' }] }]);
  assert.deepEqual(openCodeEndpoint(root, receipt), { model: 'worker-models', provider: '9router',
    baseURL: 'http://127.0.0.1:20128/v1', apiKey: 'private-value' });
  assert.throws(() => openCodeEndpoint(root, { ...receipt, requested_model: 'invented-model' }), /outside the bound role policy/);
});

test('ambiguous endpoints and URL-embedded credentials never select an arbitrary route', t => {
  const group = { vendor: 'customendpoint', apiKey: 'private-value', models: [{ id: 'worker-models', url: 'http://127.0.0.1/v1' }] };
  const { root, receipt } = project(t, [group, group]);
  assert.throws(() => openCodeEndpoint(root, receipt), /one supported custom endpoint/);
  const catalogPath = join(root, 'private-models.json');
  for (const url of ['https://user:secret@example.org/v1', 'http://remote.example/v1', 'https://example.org/v1?key=secret']) {
    writeFileSync(catalogPath, JSON.stringify([{ ...group, models: [{ id: 'worker-models', url }] }]));
    assert.throws(() => openCodeEndpoint(root, receipt), /one supported custom endpoint/);
  }
});

test('engine configuration disables builtin actions and exposes only its exact bound tools', () => {
  const config = openCodeConfiguration({ model: 'worker-models', provider: '9router', baseURL: 'http://127.0.0.1/v1', apiKey: 'private-value' },
    { url: 'http://127.0.0.1:9999/mcp', authorization: 'Bearer private-token' }, ['project_read', 'assignment_report']);
  assert.equal(config.permission['*'], 'deny');
  assert.equal(config.permission.wf_project_read, 'allow');
  assert.equal(config.permission.wf_assignment_report, 'allow');
  assert.equal(config.permission.wf_task_file_write, undefined);
  assert.equal(config.agent.workforce.tools['*'], false);
  assert.equal(config.agent.build.disable, true);
  assert.equal(config.agent.explore.disable, true);
  assert.equal(config.snapshot, false);
  assert.equal(config.autoupdate, false);
  assert.deepEqual(config.enabled_providers, ['workforce-router']);
  assert.deepEqual(Object.keys(config.mcp), ['wf']);
  assert.equal(config.mcp.wf.oauth, false);
  assert.equal(config.model, 'workforce-router/worker-models');
});

test('OpenCode specialist system guidance names only tools actually assigned to that role', () => {
  const worker = openCodeSystemText('WF.FnD: produce the requested files.', ['project_read', 'task_file_write', 'assignment_report']);
  assert.doesNotMatch(worker, /wf_workflow_plan|assignment_claim|request_input/); assert.match(worker, /wf_assignment_report/);
  assert.match(openCodeSystemText('WF.PM: save one bounded plan.', ['workflow_plan', 'assignment_report']), /wf_workflow_plan/);
});

test('a real planning session binds an absent task to the native null task before cancelled startup, while a foreign task is refused', async t => {
  const { root } = project(t, [{ name: '9router', vendor: 'customendpoint', models: [{ id: 'top-models', url: 'http://127.0.0.1:1/v1' }] }]);
  const request = randomUUID(), receipt = { id: randomUUID(), request_id: request, workflow_id: 'WF-REQUEST', task_id: null,
    role: 'manager', requested_model: 'top-models' };
  let bound = 0, session;
  const release = registerControlledContext(root, request, { epoch_id: randomUUID(),
    binding: { workflow_id: receipt.workflow_id, stage: 'planning', role: 'manager', process_contract: 'workforce/v1',
      implementation_paths: [], verification_paths: [], read_paths: ['.'] },
    bindInvocation(id) { assert.equal(id, receipt.id); bound++; session.controller.abort(); },
    callbacks: { assertActive() {}, saveReport() {} } });
  t.after(release);
  session = new OpenCodeSession(root, receipt, () => {}, async () => {});
  await assert.rejects(session.open(), { name: 'AbortError' });
  assert.equal(bound, 1, 'planning binding succeeded without a model request or process spawn');
  const mismatched = new OpenCodeSession(root, { ...receipt, task_id: 'FOREIGN-TASK' }, () => {}, async () => {});
  await assert.rejects(mismatched.open(), /backend-owned controlled assignment/);
  assert.equal(bound, 1, 'foreign task never reaches invocation binding');
});

async function gateway(t, label) {
  let active = true, calls = 0;
  const server = await createOpenCodeGateway(() => {
    const mcp = new McpServer({ name: label, version: '1' });
    mcp.registerTool('observe', { inputSchema: { input: z.string() } }, async ({ input }) => {
      calls++; return { content: [{ type: 'text', text: `${label}:${input}` }] };
    });
    return mcp;
  }, () => { if (!active) throw new Error('actor ended'); });
  t.after(() => server.close());
  return { server, end: () => { active = false; }, get calls() { return calls; } };
}
async function client(t, server) {
  const result = new Client({ name: 'wf-engine-test', version: '1' });
  await result.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: server.authorization } },
  }));
  t.after(() => result.close());
  return result;
}

test('actual HTTP MCP transport isolates bound gateways and rejects cross-worker tokens and browser origin', async t => {
  const a = await gateway(t, 'actor-a'), b = await gateway(t, 'actor-b');
  const ca = await client(t, a.server), cb = await client(t, b.server);
  const results = await Promise.all([ca.callTool({ name: 'observe', arguments: { input: 'a' } }), cb.callTool({ name: 'observe', arguments: { input: 'b' } })]);
  assert.equal(results[0].content[0].text, 'actor-a:a');
  assert.equal(results[1].content[0].text, 'actor-b:b');
  assert.equal(a.calls, 1); assert.equal(b.calls, 1);
  const denied = await fetch(b.server.url, { method: 'POST', headers: { Authorization: a.server.authorization }, body: '{}' });
  assert.equal(denied.status, 403);
  const origin = await fetch(a.server.url, { method: 'POST', headers: { Authorization: a.server.authorization, Origin: 'https://example.org' }, body: '{}' });
  assert.equal(origin.status, 403);
  assert.equal(a.calls, 1); assert.equal(b.calls, 1);
  assert.deepEqual([...a.server.calls], ['observe']);
});

test('an ended actor cannot execute another tool even while its transport credentials still exist', async t => {
  const a = await gateway(t, 'actor-a'), ca = await client(t, a.server);
  await ca.callTool({ name: 'observe', arguments: { input: 'before' } });
  a.end();
  await assert.rejects(ca.callTool({ name: 'observe', arguments: { input: 'after' } }, undefined, { timeout: 1000 }));
  assert.equal(a.calls, 1);
  await a.server.close();
  await assert.rejects(fetch(a.server.url, { method: 'POST', headers: { Authorization: a.server.authorization }, body: '{}' }));
});

test('cancelled startup never launches an engine, and execution diagnostics do not echo provider secrets', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(startOpenCodeEngine('not-a-project', randomUUID(), {}, signal), { name: 'AbortError' });
  const error = new Error('Authorization: Bearer private-token; apiKey=secret https://secret-endpoint');
  assert.equal(openCodeError(error), 'OpenCode execution did not complete (Error).');
  assert.equal(opencodeRuntimeVersion, '1.19.4');
  assert.equal(opencodeProtocol, 'workforce-opencode-v1');
  assert.match(opencodeRuntimeIntegrity, /^sha512-/);
  assert.equal(openCodeAttestation.issuer, 'workforce-opencode');
  assert.equal(openCodeAttestation.identity_provenance, 'local-opencode');
});

test('duplicate engine preparation preserves the first invocation dependency tree', { timeout: 45000 }, async t => {
  const { root } = project(t, [], true), invocation = randomUUID(), parent = openCodeStorage(root).path;
  const directory = join(parent, `opencode-${invocation}`), config = join(directory, 'config/opencode');
  for (const path of [dirname(parent), parent, directory]) secureHostPrivateDirectory(path);
  mkdirSync(join(config, 'node_modules'), { recursive: true });
  writeFileSync(join(config, 'package.json'), 'first invocation package\n');
  const sentinel = join(config, 'node_modules/owned.txt'); writeFileSync(sentinel, 'first invocation dependencies\n');
  t.after(() => { assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await assert.rejects(startOpenCodeEngine(root, invocation, {}), error => ['EEXIST', 'ERR_FS_CP_EEXIST'].includes(error.code));
  assert.equal(existsSync(sentinel), true, 'A rejected duplicate cannot remove another invocation dependency tree.');
  assert.equal(readFileSync(sentinel, 'utf8'), 'first invocation dependencies\n');
  assert.equal(readFileSync(join(config, 'package.json'), 'utf8'), 'first invocation package\n');
});

test('dependency seeding yields to cancellation before any watchdog or engine admission', { timeout: 45000 }, async t => {
  const { root } = project(t, [], true), invocation = randomUUID(), parent = openCodeStorage(root).path;
  const directory = join(parent, `opencode-${invocation}`);
  t.after(() => { assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const controller = new AbortController(), stages = [];
  let prepared = 0, cancellationObserved = false;
  const timer = setTimeout(() => { cancellationObserved = true; controller.abort(); }, 0);
  t.after(() => clearTimeout(timer));
  await assert.rejects(startOpenCodeEngine(root, invocation, {}, controller.signal, {
    onPrepared() { prepared++; }, onStartupStage(observation) { stages.push(observation.stage); },
  }), { name: 'AbortError' });
  assert.equal(cancellationObserved, true);
  assert.deepEqual(stages, [], 'The event loop must handle cancellation while preparing dependencies, before a watchdog is spawned.');
  assert.equal(prepared, 0);
  assert.equal(existsSync(join(directory, 'supervision/spec.json')), false);
  assert.equal(existsSync(join(directory, 'config/opencode/node_modules')), false, 'Partial dependency copies are cleaned without launching an engine.');
});

test('cancelling an in-flight dependency worker joins its writer before deleting the private partial copy', { timeout: 45000 }, async t => {
  const { root } = project(t, [], true), invocation = randomUUID(), parent = openCodeStorage(root).path;
  const directory = join(parent, `opencode-${invocation}`), dependencies = join(directory, 'config/opencode/node_modules');
  t.after(() => { assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const controller = new AbortController(), stages = []; let copyObserved = false;
  const timer = setInterval(() => { if (existsSync(dependencies)) { copyObserved = true; controller.abort(); } }, 10);
  t.after(() => clearInterval(timer));
  await assert.rejects(startOpenCodeEngine(root, invocation, {}, controller.signal,
    { onStartupStage(observation) { stages.push(observation.stage); } }), { name: 'AbortError' });
  clearInterval(timer);
  assert.equal(copyObserved, true, 'Cancellation occurred after the real worker began writing dependencies.');
  assert.deepEqual(stages, []);
  assert.equal(existsSync(dependencies), false);
  await new Promise(done => setTimeout(done, 100));
  assert.equal(existsSync(dependencies), false, 'A terminated writer cannot recreate paths after its cleanup completed.');
  assert.equal(existsSync(join(directory, 'supervision/spec.json')), false);
});

test('Windows guardian preflight binds the shipped source, assembly and frozen manifest', { skip: process.platform !== 'win32' }, t => {
  const actual = openCodeWindowsGuardian(), root = mkdtempSync(join(tmpdir(), 'wf-guardian-integrity-'));
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
  for (const name of ['windows-guardian.cs', 'windows-guardian.dll', 'windows-guardian.manifest.json']) copyFileSync(join(dirname(actual.path), name), join(root, name));
  assert.equal(validateOpenCodeWindowsGuardian(root, actual.manifest_sha256).sha256, actual.sha256);
  writeFileSync(join(root, 'windows-guardian.dll'), 'changed assembly');
  assert.throws(() => validateOpenCodeWindowsGuardian(root, actual.manifest_sha256), /OPENCODE_GUARDIAN_UNAVAILABLE/);
  const metadata = JSON.parse(readFileSync(join(root, 'windows-guardian.manifest.json'), 'utf8'));
  metadata.assembly_sha256 = createHash('sha256').update('changed assembly').digest('hex'); writeFileSync(join(root, 'windows-guardian.manifest.json'), JSON.stringify(metadata));
  assert.throws(() => validateOpenCodeWindowsGuardian(root, actual.manifest_sha256), /OPENCODE_GUARDIAN_UNAVAILABLE/);
});

test('pinned real local engine starts with its bound gateway and stops on cancellation without calling a model', { timeout: 45000 }, async t => {
  const { root } = project(t, [], true), a = await gateway(t, 'engine-bound');
  const signal = new AbortController();
  const config = openCodeConfiguration({ model: 'worker-models', provider: 'test', baseURL: 'http://127.0.0.1:1/v1' },
    a.server, ['observe']);
  const startup = [];
  const engine = await startOpenCodeEngine(root, randomUUID(), config, signal.signal,
    { onStartupStage: observation => startup.push(observation) }).finally(() => t.diagnostic(JSON.stringify({ startup_stages: startup })));
  assert.ok(startup.some(observation => observation.stage === 'authenticated-ready'));
  assert.ok(startup.every(observation => Object.keys(observation).sort().join(',') === 'elapsed_ms,stage' &&
    Number.isInteger(observation.elapsed_ms) && observation.elapsed_ms >= 0), 'Startup diagnostics contain only bounded stage names and timing.');
  if (process.platform === 'win32') {
    const expected = ['guardian-spawned', 'guardian-load-started', 'guardian-load-completed',
      'engine-create-started', 'engine-create-completed', 'engine-identity-observed'];
    const actual = startup.map(observation => observation.stage);
    for (let index = 0; index < expected.length; index++) {
      assert.equal(actual.filter(stage => stage === expected[index]).length, 1, `${expected[index]} is observed exactly once`);
      if (index) assert.ok(actual.indexOf(expected[index - 1]) < actual.indexOf(expected[index]), 'Guardian timings preserve native startup order.');
    }
  }
  t.after(() => engine.close());
  const health = await engine.client.global.health();
  assert.equal(health.data.version, '1.19.4');
  assert.equal(health.data.healthy, true);
  const mcp = await engine.client.mcp.status({ directory: engine.directory });
  assert.equal(mcp.data.wf.status, 'connected');
  assert.equal(a.calls, 0, 'startup must not spend an inference request');
  assert.match(engine.binary_sha256, /^[a-f0-9]{64}$/);
  assert.equal(engine.directory.startsWith(root), false, 'engine does not load the project config/plugin directory');
  signal.abort();
  await engine.close();
  await assert.rejects(engine.client.global.health({ signal: AbortSignal.timeout(1000) }));
  assert.equal(a.calls, 0);
  assert.equal(existsSync(join(engine.directory, 'config/opencode/node_modules')), false, 'copied dependencies are discarded after the process tree exits');
  assert.equal(existsSync(join(engine.directory, 'data/opencode/opencode.db')), true, 'durable engine state remains available for reconciliation');
  assert.equal(existsSync(join(engine.directory, 'config/package.json')), false, 'global and custom config roots share one seeded package tree');
  assert.equal(JSON.parse(readFileSync(join(engine.directory, 'bootstrap-cleanup.json'), 'utf8')).cleaned, true);
});

test('private engine storage uses the project volume and disk errors have a fixed secret-free diagnostic', t => {
  const { root } = project(t, [], true), storage = openCodeStorage(root);
  assert.ok(storage.path.startsWith(resolve('artifacts/test-temp')));
  assert.equal(storage.path.startsWith(root), false);
  assert.equal(storage.required_bytes, openCodeMinimumFreeBytes);
  assert.match(storage.path, /\.workforce-private[\\/][a-f0-9]{64}$/);
  for (const input of ['SQLiteError: database or disk is full', 'ENOSPC token=private', 'SQLITE_FULL', 'no space left on device']) {
    const failure = openCodeStorageFailure(input);
    assert.equal(failure.code, 'OPENCODE_STORAGE_UNAVAILABLE'); assert.doesNotMatch(failure.message, /token=private/);
  }
  assert.equal(openCodeStorageFailure('An ordinary product assertion failed'), undefined);
});

test('a durable engine disk failure stops the actual local process promptly without inference polling', { timeout: 45000 }, async t => {
  const { root } = project(t, [], true), a = await gateway(t, 'storage-monitor');
  const engine = await startOpenCodeEngine(root, randomUUID(), openCodeConfiguration({ model: 'worker-models', provider: 'test', baseURL: 'http://127.0.0.1:1/v1' }, a.server, ['observe']));
  t.after(() => engine.close());
  const log = join(engine.directory, 'data/opencode/log/opencode.log');
  mkdirSync(join(engine.directory, 'data/opencode/log'), { recursive: true });
  writeFileSync(log, 'timestamp=2026-10-28T00:00:00Z level=ERROR error="SQLiteError: database or disk is full"\n');
  const deadline = Date.now() + 5000;
  while (!engine.failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(engine.failure?.code, 'OPENCODE_STORAGE_UNAVAILABLE');
  await engine.close();
  await assert.rejects(engine.client.global.health({ signal: AbortSignal.timeout(1000) }));
  assert.equal(a.calls, 0); assert.equal(existsSync(join(engine.directory, 'config/opencode/node_modules')), false);
});
