// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { hash } from '../dist/storage.js';
import { ensureToolPolicy, roleCapabilities, invokeCapability, resolveCapabilities, closeCapabilitySessions } from '../dist/tools.js';
import { canonicalJson, ensureRoutingPolicy, roleModelPolicy, routingConfigurationHashes } from '../dist/routing.js';
import { reaPin, configureRea, reaStatus, reaRegistration, reaToolsForRole, readReaSkillBundle,
  connectRea, callReaTool, probeRea } from '../dist/rea.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const sdk = pathToFileURL(join(repository, 'node_modules/@modelcontextprotocol/sdk/dist/esm')).href;
const zod = pathToFileURL(join(repository, 'node_modules/zod/index.js')).href;
const connections = new Map();
async function connect(root) {
  const connection = await connectRea(root);
  const list = connections.get(root) ?? [];
  list.push(connection); connections.set(root, list);
  return connection;
}
function project(t, install = true) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-rea-'));
  initialize(root, { project_id: 'REA-CONTRACT' });
  t.after(async () => {
    await closeCapabilitySessions(root);
    await Promise.all((connections.get(root) ?? []).map(connection => connection.client.close()));
    connections.delete(root);
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
  });
  if (!install) return { root };
  const base = join(root, '.neomind/tools/rea/6.7.0'), pkg = join(base, 'node_modules/rea-agents');
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  mkdirSync(join(pkg, 'skills/reverse-engineer-anything/references'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: reaPin.package, version: reaPin.version, bin: 'scripts/rea.mjs', type: 'module' }));
  writeFileSync(join(pkg, 'LICENSE'), 'MIT fixture notice\r\n');
  writeFileSync(join(pkg, 'skills/reverse-engineer-anything/SKILL.md'), '\ufeff---\r\nname: reverse-engineer-anything\r\ndescription: Original fixture skill.\r\n---\r\nRead [reference](references/source.md).\r\n');
  writeFileSync(join(pkg, 'skills/reverse-engineer-anything/references/source.md'), '# Original reference\r\nPreserve these bytes.\r\n');
  writeFileSync(join(pkg, 'scripts/rea.mjs'), `
import {McpServer} from ${JSON.stringify(sdk + '/server/mcp.js')};
import {StdioServerTransport} from ${JSON.stringify(sdk + '/server/stdio.js')};
import {z} from ${JSON.stringify(zod)};
import {appendFileSync} from 'node:fs';
const server=new McpServer({name:'rea',version:'6.7.0'}), evidence=new Set();
const id='ev_'+ 'a'.repeat(64);
const outputSchema={evidence_id:z.string().optional(),state:z.string().optional(),count:z.number().optional(),inherited_secret:z.boolean().optional()};
function result(data){return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,_meta:{provenance:{untrusted_content:true,source:'analysis_target'}}};}
function observe(name){appendFileSync('fake-calls.log',name+'\\n');}
server.registerTool('binary_session',{inputSchema:{},outputSchema},()=>{observe('identity');return result({state:'empty',inherited_secret:Boolean(process.env.NEOMIND_ROUTER_API_KEY)});});
server.registerTool('analyze_javascript_application',{inputSchema:{input_path:z.string(),detail:z.enum(['summary','complete']).optional(),analysis_timeout_ms:z.number().int().optional(),max_heap_mb:z.number().int().optional(),max_semantic_nodes:z.number().int().optional()},outputSchema},()=>{observe('analysis');evidence.add(id);return result({evidence_id:id});});
server.registerTool('inspect_analysis_view',{inputSchema:{source:z.object({kind:z.literal('retained-evidence'),evidence_id:z.string()}),view:z.object({kind:z.literal('summary')})},outputSchema},({source})=>{observe('view');return evidence.has(source.evidence_id)?result({evidence_id:source.evidence_id}):{isError:true,content:[{type:'text',text:'Unknown same-session Evidence.'}]};});
server.registerTool('get_evidence_bundle',{inputSchema:{},outputSchema},()=>result({count:evidence.size}));
console.error('fixture-private-token-do-not-copy');
await server.connect(new StdioServerTransport());
`);
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { [reaPin.package]: reaPin.version } },
    [`node_modules/${reaPin.package}`]: { version: reaPin.version, integrity: reaPin.integrity } } });
  writeFileSync(join(base, 'package-lock.json'), lock);
  mkdirSync(join(root, '.neomind/tool-locks'), { recursive: true });
  writeFileSync(join(root, '.neomind/tool-locks/rea-6.7.0.json'), lock);
  const target = join(root, 'sample-app'); mkdirSync(target);
  writeFileSync(join(target, 'main.js'), 'export const value = 1;\n');
  return { root, base, pkg, target };
}

// Private signed guard fixture only: it never claims observed model execution.
function gatewayReceipt(root) {
  const policy = ensureRoutingPolicy(root), model = roleModelPolicy(root, 'researcher');
  const key = generateKeyPairSync('ed25519'), pem = key.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = hash(pem), id = randomUUID(), protocol = hash('REA private gateway guard fixture');
  const integrity = 'sha512-NWZdi/kxyjv/8EUGFupziGU38YyleugZRM4JXgY5XFH7FUmaFA33NZS2Bmq0HPazf7S3jJQQWsZ/jAK9jsrV3Q==';
  mkdirSync(join(root, '.neomind/native/keys'), { recursive: true });
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  writeFileSync(join(root, `.neomind/native/keys/${keyId}.pem`), pem);
  writeFileSync(join(root, '.neomind/native/trust.json'), JSON.stringify({ keys: [keyId] }));
  writeFileSync(join(root, '.neomind/native-runtime.lock.json'), JSON.stringify({ version: '0.162.1', integrity, protocol_sha256: protocol }));
  const receipt = { schema_version: 1, issuer: 'neomind-codex-app-server', execution_mode: 'native', id,
    receipt_path: `.neomind/native/receipts/${id}.json`, project_id: 'REA-CONTRACT', role: 'researcher',
    workflow_id: null, task_id: null, requested_model: model.models[0], confirmed_model: model.models[0],
    model_provider: 'private-unit-fixture', native_sandbox: 'workspaceWrite', reasoning_effort: model.reasoning_effort,
    confirmed_reasoning_effort: model.reasoning_effort, client_version: '0.162.1', runtime_integrity: integrity,
    protocol_sha256: protocol, routing_sha256: hash(canonicalJson(policy)), native_thread_id: `unit-${id}`, native_turn_id: `unit-turn-${id}`,
    state: 'running', inference_completed: false, reroutes: [], owner_pid: process.pid, key_id: keyId };
  const save = () => {
    const value = { ...receipt, configuration_hashes: routingConfigurationHashes(root) };
    writeFileSync(join(root, receipt.receipt_path), JSON.stringify({ ...value,
      signature: sign(null, Buffer.from(canonicalJson(value)), key.privateKey).toString('base64') }));
  };
  save(); return { id, save };
}

test('REA stays opt-in and a local-only policy refuses downloads without writing configuration', async t => {
  const { root } = project(t, false);
  assert.equal(reaStatus(root).status, 'disabled');
  assert.equal(readReaSkillBundle(root), null);
  assert.equal(ensureToolPolicy(root).approved_providers.includes('rea'), false);
  writeFileSync(join(root, '.neomind/automation.json'), JSON.stringify({ network_policy: 'local-only' }));
  await assert.rejects(configureRea(root, { enabled: true, install: true }), /Local-only/);
  assert.equal(existsSync(join(root, '.neomind/rea.json')), false);
  assert.equal(roleCapabilities('developer').providers.includes('rea'), false);
  assert.equal(roleCapabilities('researcher').providers.includes('rea'), true);
});

test('actual stdio discovery enables exact registration and preserves original skill BOM, references and MIT bytes', async t => {
  const { root, pkg } = project(t);
  const originalKey = process.env.NEOMIND_ROUTER_API_KEY;
  process.env.NEOMIND_ROUTER_API_KEY = 'fixture-secret-must-not-inherit';
  t.after(() => { if (originalKey === undefined) delete process.env.NEOMIND_ROUTER_API_KEY; else process.env.NEOMIND_ROUTER_API_KEY = originalKey; });
  assert.equal((await configureRea(root, { enabled: true })).status, 'ready');
  const registration = reaRegistration(root);
  assert.equal(registration.status, 'ready');
  assert.equal(registration.server.args.at(-1), 'mcp');
  assert.equal(registration.server.command, process.execPath);
  const connection = await connect(root);
  const result = await callReaTool(root, connection, 'binary_session');
  assert.equal(result.structuredContent.inherited_secret, false);
  assert.doesNotMatch(JSON.stringify(await probeRea(root)), /fixture-private-token|fixture-secret/);
  const bundle = readReaSkillBundle(root);
  for (const path of ['SKILL.md', 'references/source.md']) {
    const file = bundle.files.find(file => file.path === path);
    const bytes = readFileSync(join(pkg, 'skills/reverse-engineer-anything', path));
    assert.deepEqual(Buffer.from(file.content), bytes);
    assert.equal(hash(file.content), file.sha256);
  }
  assert.equal(bundle.files.find(file => file.path === 'LICENSE').content, readFileSync(join(pkg, 'LICENSE'), 'utf8'));
  const configPath = join(root, '.neomind/rea.json'), config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.skill_hashes = Object.fromEntries(Object.entries(config.skill_hashes).reverse());
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(readReaSkillBundle(root).files.length, bundle.files.length);
  const observationPath = join(root, '.neomind/tools/rea/6.7.0/observed.json');
  const observation = JSON.parse(readFileSync(observationPath, 'utf8'));
  observation.server.private_token = 'fixture-private-observation-value';
  observation.tools[0].private_token = 'fixture-private-observation-value';
  writeFileSync(observationPath, JSON.stringify(observation));
  assert.doesNotMatch(JSON.stringify(reaStatus(root)), /private-observation-value/);
  assert.equal(bundle.provenance.commit, undefined);
  assert.equal(reaToolsForRole(root, 'researcher').length, 4);
  assert.deepEqual(reaToolsForRole(root, 'manager'), []);
});

test('observed schema and public target guards reject calls before dispatch, while evidence remains session-local', async t => {
  const { root, target } = project(t);
  await configureRea(root, { enabled: true });
  const a = await connect(root), b = await connect(root);
  const before = readFileSync(join(root, 'fake-calls.log'), 'utf8');
  for (const [name, args, pattern] of [
    ['start_gdb_session', {}, /allowlist/],
    ['analyze_javascript_application', { input_path: 42 }, /schema/],
    ['analyze_javascript_application', { input_path: root }, /escapes/],
    ['analyze_javascript_application', { input_path: join(root, '.neomind') }, /escapes/],
    ['analyze_javascript_application', { input_path: target, analysis_timeout_ms: 999999 }, /budget/],
    ['analyze_javascript_application', { input_path: join(target, 'main.js') }, /directory.*unsupported/],
    ['analyze_javascript_application', { input_path: join(target, 'main.js'), source_paths: ['inner.js'] }, /directory.*unsupported/],
  ]) await assert.rejects(callReaTool(root, a, name, args), pattern);
  assert.equal(readFileSync(join(root, 'fake-calls.log'), 'utf8'), before);
  writeFileSync(join(target, '.env'), 'fixture-private-data');
  await assert.rejects(callReaTool(root, a, 'analyze_javascript_application', { input_path: target }), /private/);
  rmSync(join(target, '.env'));
  const result = await callReaTool(root, a, 'analyze_javascript_application', { input_path: target });
  assert.equal(result._meta.provenance.untrusted_content, true);
  const view = { source: { kind: 'retained-evidence', evidence_id: result.structuredContent.evidence_id }, view: { kind: 'summary' } };
  assert.notEqual((await callReaTool(root, a, 'inspect_analysis_view', view)).isError, true);
  assert.equal((await callReaTool(root, b, 'inspect_analysis_view', view)).isError, true);
  await assert.rejects(invokeCapability(root, { invocation_id: 'unsigned-native', provider: 'rea', tool: 'binary_session' }), /UUID|invocation|receipt/i);
});

test('active or malformed receipts block configuration and protected bytes remain unchanged', async t => {
  const { root } = project(t);
  await configureRea(root, { enabled: true });
  const path = join(root, '.neomind/rea.json'), before = readFileSync(path);
  mkdirSync(join(root, '.neomind/native/receipts'), { recursive: true });
  const receipt = join(root, '.neomind/native/receipts/active.json');
  for (const state of ['running', 'starting', 'waiting-native-permission', 'unknown']) {
    writeFileSync(receipt, JSON.stringify({ state }));
    await assert.rejects(configureRea(root, { enabled: false }), /receipts/);
    assert.deepEqual(readFileSync(path), before);
  }
});

test('tampered entry, dependency baseline and original skill cannot be silently adopted', async t => {
  const { root, pkg, base } = project(t);
  await configureRea(root, { enabled: true });
  const entry = join(pkg, 'scripts/rea.mjs'), original = readFileSync(entry);
  writeFileSync(entry, original.toString() + '\n// changed\n');
  assert.equal(reaRegistration(root).status, 'missing');
  await assert.rejects(configureRea(root, { enabled: true }), /entry changed/);
  writeFileSync(entry, original);
  const skill = join(pkg, 'skills/reverse-engineer-anything/references/source.md');
  writeFileSync(skill, 'different guidance');
  assert.throws(() => readReaSkillBundle(root), /skill bytes changed/);
  await assert.rejects(configureRea(root, { enabled: true }), /skill bytes changed/);
  writeFileSync(join(base, 'package-lock.json'), '{}');
  assert.equal(reaRegistration(root).status, 'missing');
});

test('an incomplete original skill reference bundle fails before starting a provider', async t => {
  const { root, pkg } = project(t);
  writeFileSync(join(pkg, 'skills/reverse-engineer-anything/SKILL.md'), 'Read [missing](references/missing.md).\n');
  await assert.rejects(configureRea(root, { enabled: true }), /reference is missing/);
  assert.equal(existsSync(join(root, 'fake-calls.log')), false);
  assert.equal(reaRegistration(root).status, 'missing');
});

test('revoking REA approval blocks new discovery and an already connected strict session before dispatch', async t => {
  const { root } = project(t);
  await configureRea(root, { enabled: true });
  await resolveCapabilities(root, { role: 'researcher', required: ['rea'] });
  const receipt = gatewayReceipt(root);
  await invokeCapability(root, { invocation_id: receipt.id, provider: 'rea', tool: 'binary_session' });
  const before = readFileSync(join(root, 'fake-calls.log'), 'utf8');
  const path = join(root, '.neomind/tools.json'), policy = JSON.parse(readFileSync(path, 'utf8'));
  policy.approved_providers = policy.approved_providers.filter(id => id !== 'rea');
  writeFileSync(path, JSON.stringify(policy));
  await assert.rejects(resolveCapabilities(root, { role: 'researcher', required: ['rea'] }), /outside the approved catalog/);
  await assert.rejects(invokeCapability(root, { invocation_id: receipt.id, provider: 'rea', tool: 'binary_session' }), /configuration changed/);
  // Re-sign this private fixture against current bytes to exercise the provider gate
  // independently of the separately verified invocation configuration hash guard.
  receipt.save();
  await assert.rejects(invokeCapability(root, { invocation_id: receipt.id, provider: 'rea', tool: 'binary_session' }), /outside the approved catalog/);
  assert.equal(readFileSync(join(root, 'fake-calls.log'), 'utf8'), before);
});

test('Windows case aliases in public absolute targets terminate and dispatch once', { skip: process.platform !== 'win32' }, async t => {
  const { root } = project(t, false);
  await configureRea(root, { enabled: true });
  const publicTarget = join(root, 'public-app'); mkdirSync(publicTarget);
  writeFileSync(join(publicTarget, 'main.js'), 'export const value = 1;\n');
  const alias = publicTarget.replace(/[a-z]/gi, character => character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
  const script = `import {callReaTool} from ${JSON.stringify(pathToFileURL(join(repository, 'dist/rea.js')).href)};
const definition={name:'analyze_javascript_application',inputSchema:{type:'object',properties:{input_path:{type:'string'}},required:['input_path']}};
let calls=0; const connection={tools:new Map([[definition.name,definition]]),client:{callTool:async()=>{calls++;return {content:[]};}}};
await callReaTool(${JSON.stringify(root)},connection,definition.name,{input_path:${JSON.stringify(alias)}});
if(calls!==1)throw new Error('Expected exactly one dispatch'); console.log('case-alias accepted once');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /case-alias accepted once/);
});
