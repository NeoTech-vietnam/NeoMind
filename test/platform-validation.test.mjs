import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initialize, hash } from '../dist/storage.js';
import { installProject } from '../dist/installer.js';
import { validatePlatform } from '../dist/platform-validation.js';
import { createMcpServer } from '../dist/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function inventory(root, folder = '') {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(item => {
    const path = join(folder, item.name);
    return item.isDirectory() ? inventory(root, path) : [[path, hash(readFileSync(join(root, path)))]];
  }).sort();
}
test('validation inspects installed profiles and defaults without writes, downloads or inflated runtime claims', async t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-validate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'VALIDATE', platforms: ['codex', 'copilot'] }); installProject(root);
  const before = inventory(root), result = validatePlatform(root);
  assert.deepEqual(result.profiles.map(item => item.files.length), [9, 9]);
  assert.ok(result.profiles.every(item => item.files.every(file => file.present)));
  assert.equal(result.codex_routing.value.mode, 'inherit');
  assert.equal(result.cornell_destination.value.directory, '00_note/NeoMind');
  assert.equal(result.activity.running_hooks, 0);
  assert.match(result.assurance, /no inference/);
  const server = createMcpServer(root), client = new Client({ name: 'validation-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'platform_validate').annotations.readOnlyHint, true);
  const response = await client.callTool({ name: 'platform_validate', arguments: {} });
  assert.notEqual(response.isError, true);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'validate', '--project', root], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).project_id, 'VALIDATE');
  assert.deepEqual(inventory(root), before);
});
