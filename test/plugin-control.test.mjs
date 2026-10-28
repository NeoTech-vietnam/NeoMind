// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { hash } from '../dist/storage.js';
import { readPluginControlStatus, pluginRegistration, setPluginEnabled, installPlugin, probePlugin, pluginWorkerLaunch } from '../dist/plugin-control.js';
import { toolCatalog, readToolPolicy, installProvider } from '../dist/tools.js';
import { ensureRoutingPolicy, canonicalJson, roleModelPolicy, routingConfigurationHashes } from '../dist/routing.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const sdk = pathToFileURL(join(repository, 'node_modules/@modelcontextprotocol/sdk/dist/esm')).href;
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-plugin-control-'));
  initialize(root, { project_id: 'PLUGIN-CONTROL' });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function bytes(root) {
  const result = {};
  const visit = (folder, prefix = '') => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name), key = prefix + item.name;
      if (item.isDirectory()) visit(path, key + '/');
      else result[key] = hash(readFileSync(path));
    }
  };
  visit(root); return result;
}
function installedFixture(root, id = 'context7', tools) {
  const pin = toolCatalog.find(item => item.id === id);
  const base = join(root, '.neomind/tools', id, pin.version), pkg = join(base, 'node_modules', pin.package);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: pin.package, version: pin.version, bin: 'server.mjs', type: 'module' }));
  writeFileSync(join(pkg, 'server.mjs'), `
import {McpServer} from ${JSON.stringify(sdk + '/server/mcp.js')};
import {StdioServerTransport} from ${JSON.stringify(sdk + '/server/stdio.js')};
import {appendFileSync} from 'node:fs';
const server = new McpServer({name:'fixture',version:'1.0.0'});
for (const name of ${JSON.stringify(tools ?? pin.tools)}) server.registerTool(name, {description:'Fixture only'}, () => {
  appendFileSync('unexpected-tool-call.txt', name); return {content:[{type:'text',text:'fixture'}]};
});
console.error('PRIVATE-DIAGNOSTIC-DO-NOT-EXPOSE');
await server.connect(new StdioServerTransport());
`);
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { [pin.package]: pin.version } },
    [`node_modules/${pin.package}`]: { version: pin.version, integrity: pin.integrity } } });
  writeFileSync(join(base, 'package-lock.json'), lock);
  mkdirSync(join(root, '.neomind/tool-locks'), { recursive: true });
  writeFileSync(join(root, `.neomind/tool-locks/${id}-${pin.version}.json`), lock);
  return { base, pkg };
}
test('status and enabling a missing plug-in never install, spawn, disclose launch paths or change other approvals', async t => {
  const root = project(t), before = bytes(root);
  const initial = readPluginControlStatus(root);
  assert.equal(initial.plugins.length, 4);
  assert.deepEqual(bytes(root), before);
  const result = setPluginEnabled(root, 'rea', true);
  assert.deepEqual(readToolPolicy(root).approved_providers, ['rea']);
  const rea = result.plugins.find(item => item.id === 'rea');
  assert.equal(rea.enabled, true); assert.equal(rea.availability, 'missing');
  assert.equal(existsSync(join(root, '.neomind/tools')), false);
  const afterEnable = bytes(root);
  assert.doesNotMatch(JSON.stringify(readPluginControlStatus(root)), /command|node_command|args|PRIVATE|[A-Z]:\\/);
  assert.deepEqual(bytes(root), afterEnable);
  assert.equal(pluginRegistration(root, 'rea').status, 'missing');
  setPluginEnabled(root, 'rea', false);
  assert.deepEqual(readToolPolicy(root).approved_providers, []);
  assert.equal(JSON.parse(readFileSync(join(root, '.neomind/rea.json'))).enabled, false);
});
test('target-free stdio probe gates native readiness, then disabling revokes its registration', async t => {
  const root = project(t); setPluginEnabled(root, 'context7', true);
  const { pkg } = installedFixture(root);
  assert.equal(readPluginControlStatus(root).plugins.find(item => item.id === 'context7').availability, 'installed');
  assert.equal(pluginRegistration(root, 'context7').status, 'missing');
  await probePlugin(root, 'context7');
  const ready = pluginRegistration(root, 'context7');
  assert.equal(ready.status, 'ready'); assert.equal(ready.server.args[0], join(pkg, 'server.mjs'));
  const previousElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  try {
    Object.defineProperty(process.versions, 'electron', { value: 'fixture', configurable: true });
    assert.equal(pluginRegistration(root, 'context7').status, 'ready', 'Electron reads the same probe baseline as the real Node worker');
  } finally {
    if (previousElectron) Object.defineProperty(process.versions, 'electron', previousElectron);
    else delete process.versions.electron;
  }
  assert.equal(existsSync(join(root, 'unexpected-tool-call.txt')), false);
  const status = readPluginControlStatus(root).plugins.find(item => item.id === 'context7');
  assert.equal(status.last_probe.status, 'passed'); assert.equal(status.last_probe.tool_count, 2);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE-DIAGNOSTIC|server\.mjs/);
  setPluginEnabled(root, 'context7', false);
  assert.deepEqual(pluginRegistration(root, 'context7'), { status: 'disabled', tools: [...toolCatalog.find(p => p.id === 'context7').tools] });
  assert.equal(readPluginControlStatus(root).plugins.find(item => item.id === 'context7').installed, true);
});
test('a changed executable or dependency baseline invalidates saved discovery; incomplete MCP catalogs do not pass', async t => {
  const root = project(t); setPluginEnabled(root, 'context7', true);
  const { pkg, base } = installedFixture(root);
  await probePlugin(root, 'context7');
  writeFileSync(join(pkg, 'server.mjs'), readFileSync(join(pkg, 'server.mjs'), 'utf8') + '\n// changed\n');
  assert.equal(pluginRegistration(root, 'context7').status, 'missing');
  writeFileSync(join(base, 'package-lock.json'), '{}');
  assert.equal(readPluginControlStatus(root).plugins.find(item => item.id === 'context7').installed, false);
  installedFixture(root, 'context7', ['resolve-library-id']);
  await assert.rejects(probePlugin(root, 'context7'), /verification failed/);
  assert.notEqual(pluginRegistration(root, 'context7').status, 'ready');
});
test('local-only downloads are refused consistently for every catalog provider', async t => {
  const root = project(t);
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ network_policy: 'local-only' }));
  for (const pin of toolCatalog) {
    setPluginEnabled(root, pin.id, true);
    await assert.rejects(installPlugin(root, pin.id), /Local-only/);
    assert.throws(() => installProvider(root, pin.id), /Local-only/);
  }
  assert.equal(existsSync(join(root, '.neomind/tools')), false);
});
test('malformed signed receipts and invalid policy block every mutation while preserving protected bytes', async t => {
  const root = project(t); setPluginEnabled(root, 'context7', true);
  installedFixture(root);
  const receiptDirectory = join(root, '.neomind/native/receipts'); mkdirSync(receiptDirectory, { recursive: true });
  writeFileSync(join(receiptDirectory, 'malformed.json'), JSON.stringify({ state: 'completed' }));
  const before = readFileSync(join(root, '.neomind/tools.json'));
  assert.throws(() => setPluginEnabled(root, 'context7', false));
  await assert.rejects(installPlugin(root, 'context7'));
  await assert.rejects(probePlugin(root, 'context7'));
  assert.deepEqual(readFileSync(join(root, '.neomind/tools.json')), before);
  rmSync(join(receiptDirectory, 'malformed.json'));
  writeFileSync(join(root, '.neomind/tools.json'), 'invalid-private-config');
  assert.throws(() => setPluginEnabled(root, 'context7', false), /JSON/);
  assert.equal(readPluginControlStatus(root).plugins[0].availability, 'blocked');
  assert.doesNotMatch(JSON.stringify(readPluginControlStatus(root)), /invalid-private-config/);
});
test('unknown IDs reject before touching disk or selecting executables', async t => {
  const root = project(t), before = bytes(root);
  assert.throws(() => setPluginEnabled(root, '../arbitrary', true), /Unknown/);
  assert.throws(() => pluginRegistration(root, 'npx arbitrary'), /Unknown/);
  await assert.rejects(installPlugin(root, 'unknown'), /Unknown/);
  await assert.rejects(probePlugin(root, 'unknown'), /Unknown/);
  assert.deepEqual(bytes(root), before);
});
test('signed active invocations prevent approval edits and Electron workers never launch Code.exe', async t => {
  const root = project(t); setPluginEnabled(root, 'context7', true);
  const launch = pluginWorkerLaunch(root, 'probe', 'context7', { executable: 'C:/Program Files/Code/Code.exe', electron: true });
  assert.equal(launch.command, 'node');
  assert.deepEqual(launch.args.slice(1), ['plugins', 'probe', 'context7', '--project', resolve(root)]);
  const policy = ensureRoutingPolicy(root), model = roleModelPolicy(root, 'researcher');
  const keys = generateKeyPairSync('ed25519'), pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = hash(pem), id = randomUUID(), protocol = hash('Private plug-in guard fixture');
  const integrity = 'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true });
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.neomind/native/keys/${keyId}.pem`), pem);
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  writeFileSync(join(root, '.neomind/native-runtime.lock.json'), JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }));
  const receipt = { schema_version: 1, issuer: 'neomind-codex-app-server', execution_mode: 'native', id,
    receipt_path: `.neomind/native/receipts/${id}.json`, project_id: 'PLUGIN-CONTROL', role: 'researcher',
    workflow_id: null, task_id: null, requested_model: model.models[0], confirmed_model: model.models[0],
    model_provider: 'private-unit-fixture', native_sandbox: 'workspaceWrite', reasoning_effort: model.reasoning_effort,
    confirmed_reasoning_effort: model.reasoning_effort, client_version: '0.162.1', runtime_integrity: integrity,
    protocol_sha256: protocol, routing_sha256: hash(canonicalJson(policy)), native_thread_id: `unit-${id}`, native_turn_id: `unit-turn-${id}`,
    state: 'running', inference_completed: false, reroutes: [], owner_pid: process.pid, key_id: keyId,
    configuration_hashes: routingConfigurationHashes(root) };
  writeFileSync(join(root, receipt.receipt_path), JSON.stringify({ ...receipt,
    signature: sign(null, Buffer.from(canonicalJson(receipt)), keys.privateKey).toString('base64') }));
  const before = readFileSync(join(root, '.neomind/tools.json'));
  assert.throws(() => setPluginEnabled(root, 'context7', false), /invocation is active/);
  await assert.rejects(probePlugin(root, 'context7'), /invocation is active/);
  assert.deepEqual(readFileSync(join(root, '.neomind/tools.json')), before);
});
