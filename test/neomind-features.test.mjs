import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, createRecord, getRecord, safePath } from '../dist/storage.js';
import { installProject, updateProject } from '../dist/installer.js';
import { migrateStorage } from '../dist/migration.js';
import { createMcpServer } from '../dist/mcp.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-feature-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'FEATURES', platforms: ['copilot', 'codex', 'claude'] });
  return root;
}

test('TaskForces projects remain readable and migrate without rewriting existing record bytes', t => {
  const root = project(t);
  const record = createRecord(root, { type: 'knowledge', title: 'Existing project knowledge' });
  const original = readFileSync(join(root, record.path));
  renameSync(join(root, '.neomind'), join(root, '.taskforces'));
  assert.equal(initialize(root).project_id, 'FEATURES');
  assert.equal(existsSync(join(root, '.neomind')), false);
  assert.equal(getRecord(root, record.meta.id).meta.title, record.meta.title);
  assert.equal(safePath(root, '.neomind/config.json'), join(root, '.taskforces/config.json'));
  migrateStorage(root);
  assert.deepEqual(readFileSync(join(root, record.path)), original);
  assert.equal(safePath(root, '.taskforces/config.json'), join(root, '.neomind/config.json'));
  mkdirSync(join(root, '.taskforces'));
  assert.throws(() => initialize(root), /Both storage roots/);
});

test('TaskForces instruction markers upgrade once and preserve user-owned text', t => {
  const root = project(t);
  installProject(root);
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.codex/config.toml']) {
    const file = join(root, path);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('NEOMIND', 'TASKFORCES') + '\n# User-owned instructions\n');
  }
  assert.deepEqual(updateProject(root).conflicts, []);
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.codex/config.toml']) {
    const text = readFileSync(join(root, path), 'utf8');
    assert.doesNotMatch(text, /BEGIN TASKFORCES|END TASKFORCES/);
    assert.match(text, /User-owned instructions/);
  }
  assert.deepEqual(updateProject(root).conflicts, []);
});

test('CLI role selection regenerates the native Copilot agent and exposes the real map contract', t => {
  const root = project(t);
  installProject(root);
  const cli = (...args) => JSON.parse(execFileSync(process.execPath,
    ['dist/cli.js', ...args, '--project', root], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true }));
  const saved = cli('models', 'set', '--role', 'developer', '--model', 'new-worker', '--effort', 'low');
  assert.equal(saved.applies_to, 'next-invocation');
  assert.deepEqual(saved.installation.conflicts, []);
  assert.match(readFileSync(join(root, '.github/agents/neomind-implementer.agent.md'), 'utf8'), /model: "new-worker"/);
  assert.match(readFileSync(join(root, '.codex/agents/neomind-developer.toml'), 'utf8'), /model = "new-worker"/);
  const map = cli('map');
  assert.equal(map.project.id, 'FEATURES');
  assert.deepEqual(map.nodes, []);
  assert.equal(cli('upstream', 'list').sources.length, 0);
});

test('MCP exposes upstream tools and preserves local-only refusal without transport access', async t => {
  const root = project(t);
  installProject(root);
  const server = createMcpServer(root), client = new Client({ name: 'neomind-feature-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const names = new Set((await client.listTools()).tools.map(tool => tool.name));
  for (const name of ['agent_map', 'upstream_list', 'upstream_discover', 'upstream_track', 'upstream_check', 'upstream_clone', 'upstream_adopt', 'upstream_instructions'])
    assert.ok(names.has(name), name);
  const result = await client.callTool({ name: 'upstream_discover', arguments: { query: 'agent skills' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Local-only policy/);
  assert.equal(existsSync(join(root, '.neomind/upstreams.json')), false);
});
