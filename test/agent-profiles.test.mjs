import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { agentProfiles, coordinatorAgentName, agentDelegation } from '../dist/agent-profiles.js';
import { initialize, createRecord, hash } from '../dist/storage.js';
import { installProject, updateProject } from '../dist/installer.js';
import { strongRoles, workerRoles, canonicalJson, readInvocation, readRoutingPolicy } from '../dist/routing.js';
import { setRoleModel, modelControlStatus } from '../dist/model-control.js';

// These are the approved product responsibilities and tool scopes, independent of the generated catalog.
const expected = [
  ['coordinator', 'Coordinator', ['manager', 'curator', 'release'], 'manager', ['read', 'search', 'web', 'execute', 'agent', 'todo']],
  ['explorer', 'Explorer', ['codebase-analyst'], 'codebase-analyst', ['read', 'search']],
  ['researcher', 'Researcher', ['researcher'], 'researcher', ['read', 'search', 'web']],
  ['planner', 'Planner', ['requirements'], 'requirements', ['read', 'search', 'web']],
  ['architect', 'Architect', ['architect', 'component-owner'], 'architect', ['read', 'search', 'web']],
  ['implementer', 'Implementer', ['developer'], 'developer', ['read', 'search', 'edit', 'execute']],
  ['debugger', 'Debugger', ['developer'], 'developer', ['read', 'search', 'edit', 'execute']],
  ['verifier', 'Verifier', ['verifier', 'check-executor'], 'verifier', ['read', 'search', 'web', 'execute']],
  ['reviewer', 'Reviewer', ['reviewer'], 'reviewer', ['read', 'search', 'web']],
];
const coreRoles = ['manager', 'requirements', 'architect', 'component-owner', 'verifier', 'reviewer',
  'researcher', 'codebase-analyst', 'curator', 'developer', 'check-executor', 'release'];

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind agent profiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'PROFILES', platforms: ['copilot'] });
  assert.deepEqual(installProject(root).conflicts, []);
  return root;
}
function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function agent(root, id) {
  const content = readFileSync(join(root, `.github/agents/neomind-${id}.agent.md`), 'utf8');
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  assert.ok(header, `${id} has client-readable YAML metadata`);
  return { content, metadata: parseYaml(header[1]) };
}

test('expert profiles preserve all twelve core IDs and explicit shared versus strong model policies', () => {
  assert.deepEqual(agentProfiles.map(profile => profile.id), expected.map(([id]) => id));
  for (const [id, title, roles, modelRole, nativeTools] of expected) {
    const profile = agentProfiles.find(profile => profile.id === id);
    assert.equal(profile.name, `NeoMind ${title} Agent`);
    assert.deepEqual(profile.roles, roles);
    assert.equal(profile.modelRole, modelRole);
    assert.deepEqual(profile.nativeTools, nativeTools);
    assert.match(profile.procedure, /Inputs:/);
    assert.match(profile.procedure, /Outputs:/);
    assert.match(profile.procedure, /[Ee]scalat|Return .* to Coordinator/);
  }
  assert.equal(coordinatorAgentName, 'NeoMind Coordinator Agent');
  assert.equal(agentDelegation.includes(coordinatorAgentName), false);
  for (const [, title] of expected.slice(1)) assert.ok(agentDelegation.includes(`NeoMind ${title} Agent`));
  assert.deepEqual(new Set(agentProfiles.flatMap(profile => profile.roles)), new Set(coreRoles));
  assert.deepEqual(new Set([...strongRoles, ...workerRoles]), new Set(coreRoles));
  assert.ok(strongRoles.includes('verifier'));
  assert.equal(coreRoles.includes('debugger'), false, 'A visible profile must not become a new receipt role.');
});

test('installed profiles enforce distinct native tools and ship actionable procedures without recursive delegates', t => {
  const root = project(t);
  for (const [id, , roles, modelRole, nativeTools] of expected) {
    const { metadata, content } = agent(root, id);
    const native = metadata.tools.filter(tool => !tool.startsWith('neomind/'));
    assert.deepEqual(new Set(native), new Set(nativeTools), id);
    assert.ok(metadata.tools.includes('neomind/assignment_report'), `${id} can return actual saved evidence`);
    assert.ok(content.includes(`Core record roles: ${roles.join(', ')}.`), id);
    assert.ok(content.includes(`Model policy: ${modelRole}.`), id);
    assert.match(content, /Inputs:/);
    assert.match(content, /Outputs:/);
    if (id !== 'coordinator') {
      assert.deepEqual(metadata.agents, []);
      assert.equal(metadata.tools.includes('agent'), false);
      assert.equal(metadata.tools.includes('neomind/manager_run'), false);
      assert.equal(metadata.tools.includes('neomind/manager_begin'), false);
    }
  }
  const explorer = agent(root, 'explorer');
  for (const operation of ['record_create', 'record_update', 'task_start', 'task_submit', 'recipe_prepare'])
    assert.equal(explorer.metadata.tools.includes(`neomind/${operation}`), false, operation);
  assert.match(explorer.content, /Source inspection is read-only/);
  assert.match(agent(root, 'debugger').content, /repeatable failing command or test/);
  assert.match(agent(root, 'debugger').content, /rank falsifiable hypotheses/);
  assert.match(agent(root, 'debugger').content, /regression.*before applying a minimal root-cause fix/);
  const verifier = agent(root, 'verifier');
  assert.ok(verifier.metadata.tools.includes('neomind/check_run'));
  assert.ok(verifier.metadata.tools.includes('neomind/check_inspect'));
  assert.match(verifier.content, /tools only when actually available and authorized/);
  const reviewer = agent(root, 'reviewer');
  assert.ok(reviewer.metadata.tools.includes('neomind/task_review'));
  assert.match(reviewer.content, /Review in a separate invocation from the producer/);
  assert.match(reviewer.content, /security\/privacy/);
  assert.match(reviewer.content, /findings: \[\]/);
});

test('native regeneration routes Verifier strongly and changes Implementer and Debugger through the shared developer policy', t => {
  const root = project(t), policy = readRoutingPolicy(root);
  const models = ['top-alias', 'worker-alias', 'code-alias', 'check-alias'];
  write(root, 'models.json', JSON.stringify([{ name: '9router', vendor: 'customendpoint', models: models.map(id => ({ id, name: id })) }]));
  write(root, '.neomind/routing.json', JSON.stringify({ ...policy, language_models_file: 'models.json',
    strong_provider: '9router', worker_provider: '9router', strong_model: 'top-alias', worker_models: ['worker-alias'] }));
  assert.deepEqual(updateProject(root).conflicts, []);
  assert.equal(agent(root, 'verifier').metadata.model, 'top-alias (customendpoint)');
  assert.equal(agent(root, 'implementer').metadata.model, 'worker-alias (customendpoint)');
  assert.equal(agent(root, 'debugger').metadata.model, 'worker-alias (customendpoint)');
  setRoleModel(root, { role: 'developer', model: 'code-alias', provider: '9router' });
  setRoleModel(root, { role: 'verifier', model: 'check-alias', provider: '9router' });
  setRoleModel(root, { role: 'check-executor', model: 'code-alias', provider: '9router' });
  assert.deepEqual(updateProject(root).conflicts, []);
  for (const id of ['implementer', 'debugger']) assert.equal(agent(root, id).metadata.model, 'code-alias (customendpoint)');
  assert.equal(agent(root, 'verifier').metadata.model, 'check-alias (customendpoint)');
  assert.equal(agent(root, 'reviewer').metadata.model, 'top-alias (customendpoint)');
  const before = readFileSync(join(root, '.neomind/routing.json'));
  assert.throws(() => setRoleModel(root, { role: 'debugger', model: 'worker-alias' }));
  assert.deepEqual(readFileSync(join(root, '.neomind/routing.json')), before);
  assert.deepEqual(new Set(modelControlStatus(root).roles.map(role => role.role)), new Set(coreRoles));
  const profiles = modelControlStatus(root).agent_profiles;
  assert.equal(profiles.find(profile => profile.id === 'debugger').model_role, 'developer');
  assert.equal(profiles.find(profile => profile.id === 'verifier').model_role, 'verifier');
});

test('profile replacement retires only unchanged owned agents and preserves edits, unrelated files and historical evidence', t => {
  const root = project(t), manifestPath = '.neomind/install-manifest.json';
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
  for (const [oldId, currentId, edited] of [['manager', 'coordinator', false], ['swsd', 'planner', true]]) {
    const oldPath = `.github/agents/neomind-${oldId}.agent.md`, currentPath = `.github/agents/neomind-${currentId}.agent.md`;
    const original = readFileSync(join(root, currentPath), 'utf8');
    write(root, oldPath, edited ? original + '\nUser-owned instructions remain.\n' : original);
    manifest.files[oldPath] = { ...manifest.files[currentPath], path: oldPath };
  }
  write(root, manifestPath, JSON.stringify(manifest));
  write(root, '.github/agents/neomind-fnd.agent.md', 'Unowned personal agent.\r\n');
  const record = createRecord(root, { type: 'knowledge', title: 'Existing accepted developer lesson', owner: 'developer',
    status: 'accepted', body: 'Historical source and conclusions remain unchanged.\n' });
  const recordBytes = readFileSync(join(root, record.path));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId = hash(pem), id = randomUUID();
  write(root, `.neomind/native/keys/${keyId}.pem`, pem);
  write(root, '.neomind/native/trust.json', JSON.stringify({ keys: [keyId] }));
  const unsigned = { schema_version: 1, issuer: 'taskforces-vscode-lm', id, project_id: 'PROFILES', key_id: keyId,
    receipt_path: `.taskforces/native/receipts/${id}.json`, role: 'developer', state: 'completed', input_text: 'Historical fixture', output: 'Preserved fixture result' };
  const receiptBytes = JSON.stringify({ ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') });
  const receiptPath = `.neomind/native/receipts/${id}.json`;
  write(root, receiptPath, receiptBytes);
  assert.equal(readInvocation(root, id).role, 'developer');
  const edited = readFileSync(join(root, '.github/agents/neomind-swsd.agent.md'));
  for (let update = 0; update < 2; update++) {
    const result = updateProject(root);
    assert.equal(existsSync(join(root, '.github/agents/neomind-manager.agent.md')), false);
    assert.deepEqual(readFileSync(join(root, '.github/agents/neomind-swsd.agent.md')), edited);
    assert.equal(readFileSync(join(root, '.github/agents/neomind-fnd.agent.md'), 'utf8'), 'Unowned personal agent.\r\n');
    assert.ok(result.warnings.some(warning => warning.includes('neomind-swsd.agent.md')));
    assert.deepEqual(readFileSync(join(root, record.path)), recordBytes);
    assert.equal(readFileSync(join(root, receiptPath), 'utf8'), receiptBytes);
    assert.equal(readInvocation(root, id).issuer, 'taskforces-vscode-lm');
    for (const [profileId] of expected) assert.ok(existsSync(join(root, `.github/agents/neomind-${profileId}.agent.md`)));
  }
});
