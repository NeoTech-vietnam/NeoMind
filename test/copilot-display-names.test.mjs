// Historical mode fixtures explicitly retain the pre-WorkForce engine and storage root.
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { installProject } from '../dist/installer.js';
import { createMcpServer } from '../dist/mcp.js';

const displayNames = new Map([
  ['coordinator', 'NeoMind Coordinator Agent'],
  ['explorer', 'NeoMind Explorer Agent'],
  ['researcher', 'NeoMind Researcher Agent'],
  ['planner', 'NeoMind Planner Agent'],
  ['architect', 'NeoMind Architect Agent'],
  ['implementer', 'NeoMind Implementer Agent'],
  ['debugger', 'NeoMind Debugger Agent'],
  ['verifier', 'NeoMind Verifier Agent'],
  ['reviewer', 'NeoMind Reviewer Agent'],
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

test('nine NeoMind profiles expose only Coordinator and resolve every bounded delegate by exact name', (t) => {
  const { root, generated } = installedProject(t);
  for (const [id, expectedName] of displayNames) {
    assert.equal(generated.get(id).metadata.name, expectedName,
      `${id} must be discoverable by the NeoMind product name in Copilot metadata.`);
  }
  const names = new Set([...generated.values()].map(({ metadata }) => metadata.name));
  assert.equal(names.size, 9);
  assert.deepEqual(readdirSync(join(root, '.github/agents')).sort(),
    [...displayNames.keys()].map(id => `neomind-${id}.agent.md`).sort());
  const coordinator = generated.get('coordinator').metadata;
  const workers = [...generated.entries()].filter(([id]) => id !== 'coordinator');
  assert.deepEqual(new Set(coordinator.agents), new Set(workers.map(([, { metadata }]) => metadata.name)));
  for (const [id, { metadata }] of generated) {
    assert.equal(metadata['user-invocable'], id === 'coordinator');
    for (const target of metadata.agents) assert.ok(names.has(target), `${id} delegates to a generated display name.`);
    if (id !== 'coordinator') {
      assert.deepEqual(metadata.agents, []);
      assert.equal(metadata.tools.includes('agent'), false);
      assert.equal(metadata.tools.includes('neomind/manager_run'), false);
      assert.ok(generated.get('coordinator').text.includes(metadata.name), `Coordinator names ${id} in its actual prompt.`);
    }
  }
  assert.equal(coordinator.agents.includes(coordinator.name), false);
  const generic = readFileSync(join(root, '.github/copilot-instructions.md'), 'utf8');
  const target = generic.match(/Launch exactly (.+?) through the standard VS Code agent tool/)?.[1];
  assert.equal(target, coordinator.name, 'Generic intake must launch the same display name Copilot registers.');
});

test('published manager_run handoffs resolve to installed Coordinator in native and lightweight modes', async (t) => {
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
    assert.equal(result.handoff.agent, 'NeoMind Coordinator Agent');
    assert.equal(result.handoff.agent, generated.get('coordinator').metadata.name);
    if (mode === 'copilot-native') {
      for (const [id, { metadata }] of generated) {
        if (id !== 'coordinator') assert.ok(result.handoff.prompt.includes(metadata.name),
          `Coordinator handoff must name the installed ${id} delegate.`);
      }
    }
  }
});
