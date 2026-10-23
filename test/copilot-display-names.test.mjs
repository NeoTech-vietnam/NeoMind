import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { installProject } from '../dist/installer.js';
import { createMcpServer } from '../dist/mcp.js';

const displayNames = new Map([
  ['manager', 'NeoMind Manager Agent'],
  ['swsd', 'NeoMind SWSD Agent'],
  ['p-res', 'NeoMind P-RES Agent'],
  ['fnd', 'NeoMind FnD Agent'],
  ['reviewer', 'NeoMind Reviewer Agent'],
  ['tester', 'NeoMind Tester Agent'],
]);

function installedProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-copilot-display-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'DISPLAY-TEST', platforms: ['copilot'] });
  assert.deepEqual(installProject(root).conflicts, []);
  const generated = new Map([...displayNames.keys()].map((id) => {
    const text = readFileSync(join(root, `.github/agents/neomind-${id}.agent.md`), 'utf8');
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    assert.ok(header, `Generated ${id} agent must expose YAML metadata.`);
    return [id, { metadata: parseYaml(header[1]), text }];
  }));
  return { root, generated };
}

test('generated Copilot UI names carry NeoMind and delegation targets resolve without exposing workers', (t) => {
  const { root, generated } = installedProject(t);
  for (const [id, expectedName] of displayNames) {
    assert.equal(generated.get(id).metadata.name, expectedName,
      `${id} must be discoverable by the NeoMind product name in Copilot metadata.`);
  }
  const names = new Set([...generated.values()].map(({ metadata }) => metadata.name));
  assert.equal(names.size, 6);
  const manager = generated.get('manager').metadata;
  const workers = [...generated.entries()].filter(([id]) => id !== 'manager');
  assert.deepEqual(new Set(manager.agents), new Set(workers.map(([, { metadata }]) => metadata.name)));
  for (const [id, { metadata }] of generated) {
    assert.equal(metadata['user-invocable'], id === 'manager');
    for (const target of metadata.agents) assert.ok(names.has(target), `${id} delegates to a generated display name.`);
    if (id !== 'manager') assert.deepEqual(metadata.agents, []);
  }
  const generic = readFileSync(join(root, '.github/copilot-instructions.md'), 'utf8');
  const target = generic.match(/Launch exactly (.+?) through the standard VS Code agent tool/)?.[1];
  assert.equal(target, manager.name, 'Generic intake must launch the same display name Copilot registers.');
});

test('published manager_run handoffs resolve to the installed branded manager in native and lightweight modes', async (t) => {
  const { root, generated } = installedProject(t);
  const server = createMcpServer(root);
  const client = new Client({ name: 'copilot-display-integration', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  for (const mode of ['copilot-native', 'lightweight']) {
    const response = await client.callTool({
      name: 'manager_run',
      arguments: { requirement: `Explain the ${mode} fixture boundary.`, execution_mode: mode, request_id: `display-${mode}` },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.handoff.agent, 'NeoMind Manager Agent');
    assert.equal(result.handoff.agent, generated.get('manager').metadata.name);
    if (mode === 'copilot-native') {
      for (const [id, { metadata }] of generated) {
        if (id !== 'manager') assert.ok(result.handoff.prompt.includes(metadata.name),
          `Manager handoff must name the installed ${id} delegate.`);
      }
    }
  }
});
