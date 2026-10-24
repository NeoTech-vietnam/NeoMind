import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseJsonc } from 'jsonc-parser';
import { initialize, getRecord, createRecord, loadRecords, readConfig } from '../dist/storage.js';
import { installProject, updateProject } from '../dist/installer.js';
import { managedRun } from '../dist/managed.js';
import { beginWorkflow, workflowStatus, readAutomationPolicy } from '../dist/manager.js';
import { nativeWorkflowRecord } from '../dist/engineering.js';
import { checkpointLightweight } from '../dist/lightweight.js';
import { configureRouter, setRoleModel } from '../dist/model-control.js';
import { adapterNodeCommand } from '../dist/adapters.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { readAgentActivity } from '../dist/agent-activity.js';

const profiles = ['coordinator', 'explorer', 'researcher', 'planner', 'architect', 'implementer', 'debugger', 'verifier', 'reviewer'];
function project(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neomind codex parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'CODEX-PARITY', platforms: ['codex'], ...options });
  return root;
}
const read = (root, path) => readFileSync(join(root, path), 'utf8');
function write(root, path, content) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}
function field(source, key) {
  const line = source.split('\n').find(line => line.startsWith(`${key} = `));
  return line ? JSON.parse(line.slice(key.length + 3)) : undefined;
}

test('Codex install offers nine expert profiles and inherits parent model, permissions and MCP', t => {
  const root = project(t, { models: { economy: 'claude-haiku', balanced: 'claude-sonnet', strong: 'claude-opus' } });
  const original = '# Existing Codex settings\nmodel = "user-model"\n[projects."private"]\ntrust_level = "trusted"\n';
  write(root, '.codex/config.toml', original);
  const report = installProject(root);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(readdirSync(join(root, '.codex/agents')).sort(), profiles.map(id => `neomind-${id}.toml`).sort());
  assert.ok(read(root, '.codex/config.toml').startsWith(original.trimEnd()));
  for (const id of profiles) {
    const source = read(root, `.codex/agents/neomind-${id}.toml`);
    assert.equal(field(source, 'name'), `neomind-${id}`);
    assert.match(field(source, 'description'), /\S/);
    assert.match(field(source, 'developer_instructions'), /## NeoMind native workflow/);
    assert.match(field(source, 'developer_instructions'), /Local handles are unsigned correlation, not model or process attestations/);
    assert.doesNotMatch(source, /^model\s*=|^model_provider\s*=|^sandbox_mode\s*=|^approval_policy\s*=|\[mcp_servers\./m);
  }
  assert.match(field(read(root, '.codex/agents/neomind-coordinator.toml'), 'developer_instructions'), /Resume matching work|reuse/i);
  assert.match(read(root, '.neomind/guides/codex-native.md'), /existing.*tools|reuse/i);
  assert.match(read(root, 'AGENTS.md'), /NeoMind in Codex/);
  assert.match(read(root, 'AGENTS.md'), /Codex spawn_agent/);
  assert.equal(readAutomationPolicy(root).execution_mode, 'codex-native');
  assert.ok(existsSync(join(root, '.neomind/guides/codex-native.md')));
  const again = updateProject(root);
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(again.updated, []);
});

test('Codex-native intake and resumption preserve unsigned lifecycle and strict ancestry', async t => {
  const root = project(t);
  installProject(root);
  const input = { requirement: 'Trace the existing parser and report its boundary.', request_id: 'codex-investigation', execution_mode: 'codex-native' };
  const result = await managedRun(root, input);
  assert.equal(result.handoff.agent, 'neomind-coordinator');
  assert.match(result.handoff.prompt, /Codex.*spawn_agent|spawn_agent.*Codex/);
  assert.doesNotMatch(result.handoff.prompt, /standard VS Code agent tool/);
  for (const id of profiles.filter(id => id !== 'coordinator')) assert.ok(result.handoff.prompt.includes(`neomind-${id}`));
  assert.equal(result.invocation, undefined);
  assert.equal(result.workflow.execution_mode, 'codex-native');
  assert.equal(result.workflow.assurance, 'unsigned-native-report');
  const workflow = getRecord(root, result.workflow.workflow_id);
  assert.equal(workflow.meta.data.routing_required, false);
  assert.equal(getRecord(root, workflow.meta.data.requirement_id).meta.data.routing_required, false);
  const task = createRecord(root, { type: 'task', title: 'Inspect parser', owner: 'developer', data: { workflow_id: workflow.meta.id } });
  assert.equal(task.meta.data.routing_required, false);
  assert.equal(nativeWorkflowRecord(root, task), true);
  assert.equal(existsSync(join(root, '.neomind/native/receipts')), false);
  const repeat = await managedRun(root, input);
  assert.equal(repeat.workflow.workflow_id, workflow.meta.id);
  write(root, '.neomind/automation.json', JSON.stringify({ ...readAutomationPolicy(root), execution_mode: 'copilot-native' }));
  assert.equal((await managedRun(root, { workflow_id: workflow.meta.id })).handoff.agent, 'neomind-coordinator');
  assert.equal((await managedRun(root, { requirement: input.requirement, request_id: input.request_id })).workflow.workflow_id, workflow.meta.id);
  assert.equal(loadRecords(root).filter(record => record.meta.data.kind === 'manager-workflow').length, 1);
  await assert.rejects(managedRun(root, { workflow_id: workflow.meta.id, execution_mode: 'copilot-native' }), /mode cannot be changed/);
  const strict = beginWorkflow(root, { requirement: 'Strict protected work.', execution_mode: 'strict', request_id: 'strict-protected' });
  assert.equal(strict.meta.data.routing_required, true);
  assert.equal(nativeWorkflowRecord(root, strict), false);
  await assert.rejects(managedRun(root, { workflow_id: strict.meta.id, execution_mode: 'codex-native' }), /mode cannot be changed/);
  const mixed = createRecord(root, { type: 'task', title: 'Mixed ancestry stays strict', links: [{ type: 'satisfies', target: strict.meta.data.requirement_id }], data: { workflow_id: workflow.meta.id } });
  assert.equal(nativeWorkflowRecord(root, mixed), false);
});

test('lightweight Codex checkpoints keep their native client across policy changes', async t => {
  const root = project(t, { platforms: ['codex', 'copilot'] });
  installProject(root);
  const input = { requirement: 'Adjust one portable comment.', request_id: 'light-codex', execution_mode: 'lightweight', native_client: 'codex' };
  const first = await managedRun(root, input);
  assert.equal(first.handoff.agent, 'neomind-coordinator');
  assert.equal(first.workflow.backend, 'codex-native');
  assert.equal(first.workflow.execution_mode, 'lightweight');
  assert.equal(first.workflow.assurance, 'unsigned-native-report');
  assert.match(first.handoff.prompt, /codex-native\.md/);
  assert.throws(() => beginWorkflow(root, { requirement: input.requirement, request_id: input.request_id, execution_mode: 'codex-native' }), /immutable|lightweight/);
  assert.equal(loadRecords(root).length, 1);
  write(root, '.neomind/automation.json', JSON.stringify({ ...readAutomationPolicy(root), execution_mode: 'copilot-native' }));
  const implicit = await managedRun(root, { requirement: input.requirement, request_id: input.request_id });
  assert.equal(implicit.workflow.workflow_id, first.workflow.workflow_id);
  assert.equal(implicit.handoff.agent, 'neomind-coordinator');
  await assert.rejects(managedRun(root, { workflow_id: first.workflow.workflow_id, native_client: 'copilot' }), /backend|client.*immutable/);
  await assert.rejects(managedRun(root, { ...input, native_client: 'copilot' }), /backend|client.*immutable/);
  assert.equal((await managedRun(root, { workflow_id: first.workflow.workflow_id })).handoff.agent, 'neomind-coordinator');
  const completed = checkpointLightweight(root, {
    workflow_id: first.workflow.workflow_id, expected_revision: first.workflow.revision, phase: 'completed',
    risk: 'low', plan: ['Inspect and verify the comment.'], changed_files: [], limitations: [],
    checks: [{ command: 'Inspection', result: 'passed', output: 'The requested comment is already correct.' }],
    review: { disposition: 'not-needed', reason: 'No product change; one comment inspected.' }, summary: 'Inspected the existing comment.',
  });
  assert.equal(completed.backend, 'codex-native');
  assert.equal(completed.phase, 'completed');
  assert.equal(existsSync(join(root, '.neomind/native/receipts')), false);
});

test('explicit 9router opt-in generates a secret-free parent provider and follows core-role model changes', t => {
  const root = project(t);
  const authored = '\uFEFF# Keep personal settings\nmodel = "parent-model"\n[mcp_servers.personal]\ncommand = "personal-server"\n';
  write(root, '.codex/config.toml', authored);
  installProject(root);
  configureRouter(root, { base_url: 'http://127.0.0.1:20128', api_key_env: 'NEOMIND_TEST_CODEX_KEY', catalog_provider: '9Router' });
  write(root, 'catalog.json', JSON.stringify([{ name: '9Router', vendor: 'customendpoint', apiKey: 'catalog-secret-not-for-codex', models: [
    { id: 'top-models', name: 'Strong' }, { id: 'worker-models', name: 'Worker' }, { id: 'review-model', name: 'Review' },
  ] }]));
  const policy = JSON.parse(read(root, '.neomind/routing.json'));
  write(root, '.neomind/routing.json', JSON.stringify({ ...policy, strong_model: 'top-models', worker_models: ['worker-models'],
    strong_provider: '9Router', worker_provider: '9Router', language_models_file: 'catalog.json' }));
  write(root, '.neomind/config.json', JSON.stringify({ ...readConfig(root), codex_routing: '9router' }));
  const report = updateProject(root);
  assert.deepEqual(report.conflicts, []);
  const configuration = read(root, '.codex/config.toml');
  assert.match(configuration, /^model_provider = "neomind_9router"$/m);
  assert.ok(configuration.indexOf('model_provider = "neomind_9router"') < configuration.indexOf('[mcp_servers.personal]'));
  assert.match(configuration, /\[model_providers\.neomind_9router\]/);
  assert.match(configuration, /base_url = "http:\/\/127\.0\.0\.1:20128\/v1"/);
  assert.match(configuration, /env_key = "NEOMIND_TEST_CODEX_KEY"/);
  assert.match(configuration, /wire_api = "responses"/);
  assert.equal(configuration[0], '\uFEFF');
  assert.equal(configuration.split('\uFEFF').length, 2);
  assert.ok(configuration.includes(authored.slice(1).trimEnd()));
  assert.doesNotMatch(configuration, /catalog-secret-not-for-codex|api_key\s*=/);
  for (const id of ['coordinator', 'planner', 'architect', 'verifier', 'reviewer'])
    assert.equal(field(read(root, `.codex/agents/neomind-${id}.toml`), 'model'), 'top-models');
  for (const id of ['explorer', 'researcher', 'implementer', 'debugger'])
    assert.equal(field(read(root, `.codex/agents/neomind-${id}.toml`), 'model'), 'worker-models');
  setRoleModel(root, { role: 'reviewer', model: 'review-model', provider: '9Router' });
  const regenerated = updateProject(root);
  assert.deepEqual(regenerated.conflicts, []);
  assert.equal(field(read(root, '.codex/agents/neomind-reviewer.toml'), 'model'), 'review-model');
  assert.equal(field(read(root, '.codex/agents/neomind-implementer.toml'), 'model'),
    field(read(root, '.codex/agents/neomind-debugger.toml'), 'model'));
  const stable = read(root, '.codex/config.toml');
  assert.deepEqual(updateProject(root).updated, []);
  assert.equal(read(root, '.codex/config.toml'), stable);
});

test('Codex upgrades retire only hash-owned obsolete roles and keep saved records and authored files', async t => {
  const root = project(t);
  installProject(root);
  const workflow = await managedRun(root, { requirement: 'Inspect a stable file.', execution_mode: 'codex-native' });
  const record = getRecord(root, workflow.workflow.workflow_id);
  const savedBytes = readFileSync(join(root, record.path));
  const manifest = JSON.parse(read(root, '.neomind/install-manifest.json'));
  for (const [id, original, current] of [
    ['manager', 'name = "neomind-manager"\n', 'name = "neomind-manager"\n'],
    ['developer', 'name = "neomind-developer"\n', '# User revised legacy agent\nname = "personal-developer"\n'],
  ]) {
    const path = `.codex/agents/neomind-${id}.toml`;
    write(root, path, current);
    manifest.files[path] = { path, kind: 'file', hash: createHash('sha256').update(original).digest('hex'), version: '0.1.0-alpha.4' };
  }
  write(root, '.codex/agents/neomind-personal.toml', '# An unowned custom agent\n');
  write(root, '.neomind/install-manifest.json', JSON.stringify(manifest));
  const result = updateProject(root);
  assert.equal(existsSync(join(root, '.codex/agents/neomind-manager.toml')), false);
  assert.equal(read(root, '.codex/agents/neomind-developer.toml'), '# User revised legacy agent\nname = "personal-developer"\n');
  assert.equal(read(root, '.codex/agents/neomind-personal.toml'), '# An unowned custom agent\n');
  assert.ok(result.warnings.some(warning => warning.includes('neomind-developer.toml') && /user edits/.test(warning)));
  assert.deepEqual(readFileSync(join(root, record.path)), savedBytes);
  assert.equal(workflowStatus(root, record.meta.id).execution_mode, 'codex-native');
});

test('9router opt-out removes only owned provider blocks and refuses authored provider overrides', t => {
  const root = project(t);
  configureRouter(root, { base_url: 'http://localhost:20128', api_key_env: 'NEOMIND_TEST_CODEX_KEY' });
  write(root, '.neomind/config.json', JSON.stringify({ ...readConfig(root), codex_routing: '9router' }));
  const authored = '# Retain root model and personal table\nmodel = "parent-model"\n[projects."private"]\ntrust_level = "trusted"\n';
  write(root, '.codex/config.toml', authored);
  assert.deepEqual(installProject(root).conflicts, []);
  write(root, '.neomind/config.json', JSON.stringify({ ...readConfig(root), codex_routing: 'inherit' }));
  const result = updateProject(root);
  assert.deepEqual(result.conflicts, []);
  assert.doesNotMatch(read(root, '.codex/config.toml'), /model_provider|model_providers\.neomind_9router|NEOMIND codex-routing/);
  assert.ok(read(root, '.codex/config.toml').includes(authored.trimEnd()));
  assert.equal(field(read(root, '.codex/agents/neomind-coordinator.toml'), 'model'), undefined);

  const protectedRoot = project(t, { codex_routing: '9router' });
  configureRouter(protectedRoot, { base_url: 'http://localhost:20128' });
  const existing = 'model_provider = "personal-provider"\n[model_providers]\nneomind_9router = { name = "Personal", base_url = "http://localhost:6000/v1" }\n';
  write(protectedRoot, '.codex/config.toml', existing);
  const conflicts = installProject(protectedRoot);
  assert.ok(read(protectedRoot, '.codex/config.toml').startsWith(existing.trimEnd()));
  assert.ok(conflicts.conflicts.some(conflict => conflict.path.endsWith('#codex-routing-root')));
  assert.ok(conflicts.conflicts.some(conflict => conflict.path.endsWith('#codex-routing-provider')));
  for (const conflict of conflicts.conflicts) assert.ok(existsSync(join(protectedRoot, conflict.candidate)));
});

test('opting out preserves a provider still referenced by an edited root selection', t => {
  const root = project(t, { codex_routing: '9router' });
  configureRouter(root, { base_url: 'http://localhost:20128' });
  installProject(root);
  const source = read(root, '.codex/config.toml').replace('model_provider = "neomind_9router"', 'model_provider = "neomind_9router" # Keep my selection until manual review');
  write(root, '.codex/config.toml', source);
  write(root, '.neomind/config.json', JSON.stringify({ ...readConfig(root), codex_routing: 'inherit' }));
  const result = updateProject(root);
  assert.match(read(root, '.codex/config.toml'), /Keep my selection until manual review/);
  assert.match(read(root, '.codex/config.toml'), /\[model_providers\.neomind_9router\]/);
  assert.ok(result.warnings.some(warning => /provider.*referenced|referenced.*provider/i.test(warning)));
});

test('Codex hook upgrades merge observed lifecycle events and retain custom events and edited handlers', t => {
  const root = project(t);
  installProject(root);
  const legacyHandler = [{ hooks: [{ type: 'command', command: 'legacy-advisory', timeout: 10 }] }];
  const personalHandler = [{ hooks: [{ type: 'command', command: 'personal-hook' }] }];
  const hooks = { SessionStart: legacyHandler, PostToolUse: legacyHandler, Stop: legacyHandler, UserPromptSubmit: personalHandler };
  write(root, '.codex/hooks.json', `// Retain personal hook comment\n${JSON.stringify({ hooks }, null, 2)}\n`);
  const manifest = JSON.parse(read(root, '.neomind/install-manifest.json'));
  for (const id of Object.keys(manifest.files)) if (id.startsWith('.codex/hooks.json')) delete manifest.files[id];
  for (const event of ['SessionStart', 'PostToolUse', 'Stop']) {
    const key = `hooks.${event}`;
    manifest.files[`.codex/hooks.json#${key}`] = { path: '.codex/hooks.json', kind: 'json', key,
      hash: createHash('sha256').update(JSON.stringify(legacyHandler)).digest('hex'), version: '0.1.0-alpha.4' };
  }
  write(root, '.neomind/install-manifest.json', JSON.stringify(manifest));
  const result = updateProject(root);
  assert.deepEqual(result.conflicts, []);
  const source = read(root, '.codex/hooks.json');
  const updated = parseJsonc(source).hooks;
  assert.match(source, /Retain personal hook comment/);
  assert.equal(updated.SessionStart, undefined);
  assert.deepEqual(updated.UserPromptSubmit, personalHandler);
  for (const event of ['SubagentStart', 'SubagentStop', 'PostToolUse', 'Stop']) {
    assert.equal(updated[event].length, 1);
    assert.match(updated[event][0].hooks[0].command, /\.neomind[\\/]hooks[\\/]codex\.cjs/);
    assert.match(updated[event][0].hooks[0].commandWindows, /powershell\.exe/);
  }
  updated.PostToolUse = personalHandler;
  write(root, '.codex/hooks.json', JSON.stringify({ hooks: updated }));
  const conflict = updateProject(root);
  assert.ok(conflict.conflicts.some(item => item.path === '.codex/hooks.json#hooks.PostToolUse'));
  assert.deepEqual(parseJsonc(read(root, '.codex/hooks.json')).hooks.PostToolUse, personalHandler);
});

test('Electron regeneration retains an owned Node launcher and otherwise uses portable node', t => {
  const root = project(t);
  const editor = { executable: 'C:\\Applications\\Code.exe', electron: true };
  assert.equal(adapterNodeCommand(root, editor), 'node');
  installProject(root);
  assert.equal(adapterNodeCommand(root, editor), realpathSync.native(process.execPath));
  const source = read(root, '.codex/config.toml');
  write(root, '.codex/config.toml', source.replace(JSON.stringify(process.execPath), JSON.stringify(editor.executable)));
  assert.equal(adapterNodeCommand(root, editor), 'node');
  assert.equal(adapterNodeCommand(root, { executable: process.execPath, electron: false }), process.execPath);
});

test('inherited providers accept only explicit Codex platform model tiers', t => {
  const root = project(t, { models: { economy: { codex: 'codex-worker', claude: 'haiku' }, balanced: 'claude-legacy', strong: { codex: 'codex-strategic' } } });
  installProject(root);
  for (const id of ['coordinator', 'planner', 'architect', 'verifier', 'reviewer'])
    assert.equal(field(read(root, `.codex/agents/neomind-${id}.toml`), 'model'), 'codex-strategic');
  for (const id of ['explorer', 'researcher', 'implementer', 'debugger'])
    assert.equal(field(read(root, `.codex/agents/neomind-${id}.toml`), 'model'), 'codex-worker');
  assert.doesNotMatch(read(root, '.codex/config.toml'), /model_provider|model_providers/);
  assert.throws(() => project(t, { codex_routing: 'unsupported' }), /invalid|routing/);
});

test('MCP serves Codex-native and lightweight handoffs and reported progress while refusing strict activity', async t => {
  const root = project(t);
  installProject(root);
  const server = createMcpServer(root);
  const client = new Client({ name: 'codex-parity-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, response.content[0]?.text);
    return JSON.parse(response.content[0].text);
  }
  const native = await call('manager_run', { requirement: 'Inspect one public interface.', execution_mode: 'codex-native', request_id: 'mcp-codex' });
  assert.equal(native.handoff.agent, 'neomind-coordinator');
  assert.equal(native.workflow.execution_mode, 'codex-native');
  assert.equal(native.workflow.assurance, 'unsigned-native-report');
  assert.equal(native.invocation, undefined);
  const activity = await call('agent_activity', { workflow_id: native.workflow.workflow_id,
    assignment_id: 'coordinator', profile_id: 'coordinator', state: 'running', summary: 'Inspecting the public interface.' });
  assert.equal(activity.source, 'native-activity');
  assert.equal(activity.execution_mode, 'unsigned-native-progress');
  assert.equal(activity.profile_id, 'coordinator');
  const lightweight = await call('manager_run', { requirement: 'Inspect one comment.', execution_mode: 'lightweight', native_client: 'codex', request_id: 'mcp-light-codex' });
  assert.equal(lightweight.handoff.agent, 'neomind-coordinator');
  assert.equal(lightweight.workflow.backend, 'codex-native');
  await call('agent_activity', { workflow_id: lightweight.workflow.workflow_id,
    assignment_id: 'inspect-comment', profile_id: 'explorer', state: 'running', summary: 'Inspecting the saved comment.' });
  const before = readAgentActivity(root).events;
  const strict = beginWorkflow(root, { requirement: 'Protected strict increment.', request_id: 'mcp-strict', execution_mode: 'strict' });
  const rejected = await client.callTool({ name: 'agent_activity', arguments: { workflow_id: strict.meta.id,
    assignment_id: 'coordinator', profile_id: 'coordinator', state: 'running', summary: 'Must be refused.' } });
  assert.equal(rejected.isError, true);
  assert.deepEqual(readAgentActivity(root).events, before);
  assert.equal(existsSync(join(root, '.neomind/native/receipts')), false);
});
