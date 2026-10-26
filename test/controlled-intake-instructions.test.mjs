import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as toml } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, atomicWrite, safePath } from '../dist/storage.js';
import { adapterOutputs } from '../dist/adapters.js';
import { createMcpServer } from '../dist/mcp.js';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'neomind-intake-content-'));
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const config = initialize(root, { name: 'Controlled intake content', platforms: ['codex', 'copilot'], copilot_integration: 'local' });
  atomicWrite(safePath(root, '.neomind/automation.json'), JSON.stringify({ schema_version: 1, manager_enabled: true,
    documentation_required: true, automatic_pr: false, upstream: null, max_discussion_rounds: 3, execution_mode: 'neomind-controlled' }));
  return { root, config };
}

test('generated Copilot and Codex intake preserve product obligations and separate client operations identically', t => {
  const { root, config } = fixture(t);
  const surfaces = adapterOutputs(root, config).filter(output => output.path === 'AGENTS.md' ||
    output.path === '.github/instructions/neomind.instructions.md' ||
    /^\.(?:github|codex)\/agents\/neomind-/.test(output.path) || /\/skills\/neomind-[^/]+\/SKILL\.md$/.test(output.path));
  assert.ok(surfaces.some(surface => surface.path === 'AGENTS.md'));
  assert.ok(surfaces.some(surface => surface.path === '.github/agents/neomind-coordinator.agent.md'));
  assert.ok(surfaces.some(surface => surface.path === '.codex/agents/neomind-coordinator.toml'));
  let expected;
  for (const surface of surfaces) {
    const instructions = surface.path.endsWith('.toml') ? toml(surface.content).developer_instructions : surface.content;
    const guidance = instructions.split(/\r?\n/).find(line => line.startsWith('For request content,'));
    assert.ok(guidance, surface.path);
    expected ??= guidance;
    assert.equal(guidance, expected, surface.path);
    assert.match(guidance, /full product goal.*all acceptance, process, scope, preservation and safety obligations/, surface.path);
    const verbatim = instructions.split(/\r?\n/).find(line => line.startsWith('For a new intake,'));
    assert.ok(verbatim, surface.path);
    assert.match(verbatim, /copy the complete user requirement verbatim/, surface.path);
    assert.match(verbatim, /Do not append runtime operating instructions, inferred review gates, extra acceptance criteria or invented report files/, surface.path);
    assert.match(guidance, /execution_mode.*manager_status.*manager_control.*workflow_id and action/, surface.path);
    assert.match(guidance, /Preserve actual authentication, storage, execution or orchestration product requirements/, surface.path);
    assert.match(guidance, /cannot be separated unambiguously, retain the complete request.*opaque input conservatively/, surface.path);
  }
});

test('actual manager_run MCP descriptions preserve complete obligations and keep opaque input conservative', async t => {
  const { root } = fixture(t), server = createMcpServer(root);
  const client = new Client({ name: 'controlled-intake-contract-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools, manager = tools.find(tool => tool.name === 'manager_run');
  assert.ok(manager);
  const { requirement, requirements } = manager.inputSchema.properties;
  for (const input of [requirement, requirements]) {
    assert.match(input.description, /user requirement verbatim.*do not append runtime operating instructions, inferred review gates, extra criteria or invented report files/);
    assert.match(input.description, /acceptance, process, scope, preservation and safety obligations/);
    assert.match(input.description, /execution_mode.*manager_status.*manager_control/);
    assert.match(input.description, /(?:authentication, storage, execution and orchestration requirements|actual sensitive product changes)/);
    assert.match(input.description, /(?:opaque input remains conservative|ambiguous mixed requests completely)/i);
  }
  assert.ok(manager.inputSchema.properties.execution_mode);
  assert.ok(tools.some(tool => tool.name === 'manager_status'));
  assert.ok(tools.some(tool => tool.name === 'manager_control'));
});
