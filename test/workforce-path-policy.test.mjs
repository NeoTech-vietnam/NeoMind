// Actual MCP/file operations with synthetic role binding; no model inference or
// installed-client acceptance is claimed by this contract regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { createControlledMcpServer } from '../dist/controlled-tools.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-path-policy-'));
  initialize(root, { project_id: 'WF-PATH', platforms: ['copilot'] });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/ci.yml'), 'name: initial\non: workflow_dispatch\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function tools(t, root, { legacy = false, paths = ['.github/workflows'] } = {}) {
  const server = createControlledMcpServer(root, {
    workflow_id: 'WF-PATH-KNW-0001', task_id: 'WF-PATH-TASK-0001', invocation_id: 'bound-path-regression',
    role: 'developer', stage: 'implementation', process_contract: legacy ? 'software-tools/v2' : 'workforce/v1',
    implementation_paths: paths, verification_paths: ['tests'], procedure_bound: false, cornell_bound: false,
  }, { assertActive() {}, saveReport: value => value });
  const client = new Client({ name: 'workforce-path-policy-regression', version: '1' });
  const [caller, receiver] = InMemoryTransport.createLinkedPair(); await server.connect(receiver); await client.connect(caller);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, call: (name, input) => client.callTool({ name, arguments: input }) };
}
const decoded = result => JSON.parse(result.content[0].text);

test('WorkForce CI product writes use the same frozen path permission through read and atomic commit, retaining CAS', async t => {
  const root = project(t), path = '.github/workflows/ci.yml', api = await tools(t, root);
  assert.match(decoded(await api.call('project_read', { path })).text, /name: initial/);
  const content = 'name: updated\non: workflow_dispatch\n';
  assert.equal((await api.call('task_file_write', { path, content })).isError, undefined);
  assert.equal(readFileSync(join(root, path), 'utf8'), content);
  const schema = (await api.client.listTools()).tools.find(tool => tool.name === 'task_file_write').inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['content', 'path']);
  writeFileSync(join(root, path), content + '# Outside user edit\n');
  const stale = await api.call('task_file_write', { path, content: 'name: stale replacement\n' });
  assert.equal(stale.isError, true); assert.equal(decoded(stale).code, 'INPUT_CHANGED');
  assert.equal(readFileSync(join(root, path), 'utf8'), content + '# Outside user edit\n');
});

test('WorkForce protected instruction/config paths refuse with authorization findings before file mutation', async t => {
  const root = project(t), api = await tools(t, root, { paths: ['AGENTS.md', '.github/agents', '.vscode'] });
  mkdirSync(join(root, '.github/agents'), { recursive: true }); mkdirSync(join(root, '.vscode'));
  const paths = ['AGENTS.md', '.github/agents/workforce-pm.agent.md', '.vscode/settings.json'];
  for (const path of paths) {
    const original = path.endsWith('.json') ? '{}' : '# Preserved instructions\n';
    writeFileSync(join(root, path), original);
    const result = await api.call('task_file_write', { path, content: 'unauthorized replacement' });
    assert.equal(result.isError, true);
    assert.ok(['SCOPE_DENIED', 'PRIVATE_PATH'].includes(decoded(result).code));
    assert.notEqual(decoded(result).code, 'INPUT_CHANGED');
    assert.equal(readFileSync(join(root, path), 'utf8'), original);
  }
});

test('legacy workers retain their original GitHub write restriction and cannot supply a policy override', async t => {
  const root = project(t), path = '.github/workflows/ci.yml', api = await tools(t, root, { legacy: true });
  await api.call('project_read', { path });
  const result = await api.call('task_file_write', { path, content: 'name: unauthorized legacy write\n' });
  assert.equal(result.isError, true); assert.equal(decoded(result).code, 'INVALID_FILE');
  const injected = await api.call('task_file_write', { path, content: 'name: unauthorized override\n', policy: 'workforce-product' });
  assert.equal(injected.isError, true);
  assert.equal(readFileSync(join(root, path), 'utf8'), 'name: initial\non: workflow_dispatch\n');
});
