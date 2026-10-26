import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { getRecord, hash } from '../dist/storage.js';
import { researchFixture } from './cornell-research-fixture.mjs';

function inventory(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => { const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? inventory(root, path) : [[path, hash(readFileSync(join(root, path)))]]; });
}
function output(result) {
  return JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
}
async function connect(t, root) {
  const server = createMcpServer(root), client = new Client({ name: 'cornell-research-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('MCP research compile is read-only and its exact recipe_input enters existing unsigned native preparation', async t => {
  const { root, input, workflow } = researchFixture(t), client = await connect(t, root);
  const advertised = (await client.listTools()).tools.find(tool => tool.name === 'cornell_research_compile');
  assert.ok(advertised); assert.equal(advertised.annotations.readOnlyHint, true);
  assert.equal(advertised.annotations.destructiveHint, false);
  assert.equal(advertised.annotations.openWorldHint, false);
  assert.deepEqual(advertised.inputSchema.required, ['input']);
  const before = inventory(root), response = await client.callTool({ name: 'cornell_research_compile', arguments: { input } });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const compiled = output(response);
  assert.deepEqual(compiled, compileCornellResearch(root, input));
  assert.deepEqual(inventory(root), before, 'Compilation changes no source or managed file.');
  const requirementStatus = getRecord(root, input.requirement_id).meta.status;
  const prepared = await client.callTool({ name: 'recipe_prepare', arguments: compiled.recipe_input });
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
  const instance = output(prepared);
  assert.equal(instance.meta.data.recipe_id, 'cornell-evidence-note');
  assert.equal(instance.meta.data.workflow_id, workflow.meta.id);
  assert.equal(getRecord(root, instance.meta.data.task_id).meta.data.workflow_id, workflow.meta.id);
  assert.equal(getRecord(root, input.requirement_id).meta.status, requirementStatus, 'Preparation does not accept the requirement.');
  assert.equal(instance.meta.data.note_id, undefined);
  assert.equal(existsSync(join(root, input.output_dir)), false, 'Existing recipe_run and its gates still own generation.');
});

test('MCP rejects malformed and unmapped research without creating artifacts or changing records', async t => {
  const { root, input } = researchFixture(t), client = await connect(t, root), before = inventory(root);
  for (const altered of [
    { ...input, questions: [{ ...input.questions[0], objective_ids: ['O99'] }] },
    { ...input, questions: [{ ...input.questions[0], answer: '' }] },
    { ...input, unexpected_publication: true },
  ]) {
    const result = await client.callTool({ name: 'cornell_research_compile', arguments: { input: altered } });
    assert.equal(result.isError, true);
    assert.deepEqual(inventory(root), before);
  }
});

test('CLI data-file compilation matches the core/MCP envelope without writing project state', t => {
  const { root, notesRoot, input } = researchFixture(t), path = join(notesRoot, 'research.json');
  writeFileSync(path, JSON.stringify(input, null, 2));
  const before = inventory(root), cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'cornell', 'compile', '--project', root, '--data-file', path],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), compileCornellResearch(root, input));
  assert.deepEqual(inventory(root), before);
});
