import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp.js';
import { initialize, getRecord, hash } from '../dist/storage.js';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { managedRun } from '../dist/managed.js';
import { cornellFixture } from './cornell-fixture.mjs';

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind cornell placeholders-'));
  initialize(root, { project_id: 'PLACEHOLDERS', platforms: ['copilot'] });
  ensureRoutingPolicy(root);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const server = createMcpServer(root), client = new Client({ name: 'cornell-placeholder-contract', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  let sequence = 0;
  async function note() {
    const run = await managedRun(root, { requirement: 'Inspect a local Cornell transport contract.',
      execution_mode: 'copilot-native', request_id: `fixture-${++sequence}` });
    const workflow = getRecord(root, run.workflow.workflow_id);
    const value = cornellFixture(workflow.meta.id, workflow.meta.data.requirement_id);
    value.path = `docs/knowledge/value-${sequence}.md`;
    value.practice.exercise_path = `docs/practice/value-${sequence}.md`;
    value.practice.answer_path = `docs/practice/value-${sequence}-answer.md`;
    return value;
  }
  return { root, client, note };
}

function unpack(response) {
  const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function create(client, args) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try { return await client.callTool({ name: 'note_create', arguments: args }, undefined,
    { timeout: 5000, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function inventory(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      assert.equal(entry.isSymbolicLink(), false);
      return entry.isDirectory() ? inventory(root, path) : [[path, hash(readFileSync(join(root, path)))]];
    });
}

test('MCP creates fresh Cornell notes when native clients send blank or null optional revision placeholders', async t => {
  const { root, client, note } = await setup(t);
  const variants = [
    { revision_id: '' },
    { revision_id: ' \t ' },
    { revision_id: null },
    { revision_id: null, expected_revision: null, revision_reason: null },
    { revision_id: '  ', expected_revision: null, revision_reason: ' \t ' },
    { expected_revision: null, revision_reason: '' },
  ];
  for (const fields of variants) {
    const input = await note(), result = await create(client, { note: input, ...fields });
    assert.notEqual(result.isError, true, `${JSON.stringify(fields)}: ${unpack(result).error}`);
    const saved = unpack(result);
    assert.equal(saved.meta.data.artifact_path, input.path);
    assert.equal(saved.meta.data.workflow_id, input.workflow_id);
    assert.equal(saved.meta.revision, 1, 'Placeholders create a fresh record, never repair an existing one.');
    assert.equal(getRecord(root, saved.meta.id).meta.data.workflow_id, input.workflow_id);
    assert.match(readFileSync(join(root, input.path), 'utf8'), /Verified named export/);
  }
});

test('MCP optional revision normalization leaves blank required ownership and source IDs invalid without writes', async t => {
  const { root, client, note } = await setup(t), valid = await note();
  const variants = [
    { ...valid, workflow_id: '' },
    { ...valid, workflow_id: '  ' },
    { ...valid, requirement_ids: [''] },
    { ...valid, sources: [{ ...valid.sources[0], record_id: '  ' }] },
  ];
  const before = inventory(root);
  for (const input of variants) {
    const result = await create(client, { note: input, revision_id: null, expected_revision: null, revision_reason: '' });
    assert.equal(result.isError, true);
    assert.match(unpack(result).error, /must be a non-empty record ID|workflow ownership/i);
    assert.deepEqual(inventory(root), before, 'Invalid required bindings must not write artifacts, records or history.');
  }
});

test('nonempty Cornell revision IDs retain current revision, rationale and workflow guards', async t => {
  const { root, client, note } = await setup(t), input = await note();
  const first = await create(client, { note: input });
  assert.notEqual(first.isError, true, unpack(first).error);
  const saved = unpack(first), other = await note(), before = inventory(root);
  const rationale = 'Repair this owned note with the reviewed corrected context.';
  const attempts = [
    [{ revision_id: saved.meta.id, expected_revision: saved.meta.revision + 1, revision_reason: rationale }, input, /revision|changed|stale/i],
    [{ revision_id: saved.meta.id, expected_revision: saved.meta.revision + 0.5, revision_reason: rationale }, input, /integer|int/i],
    [{ revision_id: saved.meta.id, expected_revision: null, revision_reason: rationale }, input, /expected record revision|rationale/i],
    [{ revision_id: saved.meta.id, expected_revision: saved.meta.revision, revision_reason: '  ' }, input, /expected record revision|rationale/i],
    [{ revision_id: saved.meta.id, expected_revision: saved.meta.revision, revision_reason: null }, input, /expected record revision|rationale/i],
    [{ revision_id: saved.meta.id, expected_revision: saved.meta.revision, revision_reason: rationale }, other, /workflow ownership|ownership mismatch/i],
    [{ revision_id: 'PLACEHOLDERS-KNW-9999', expected_revision: saved.meta.revision, revision_reason: rationale }, input, /not found|does not exist/i],
  ];
  for (const [fields, value, expected] of attempts) {
    const result = await create(client, { note: value, ...fields });
    assert.equal(result.isError, true, 'A real requested revision must not downgrade to creation.');
    assert.match(unpack(result).error, expected);
    assert.deepEqual(inventory(root), before);
  }
  const revised = await create(client, { note: { ...input, context: 'A corrected bounded export contract under its original workflow.' },
    revision_id: saved.meta.id, expected_revision: saved.meta.revision, revision_reason: rationale });
  assert.notEqual(revised.isError, true, unpack(revised).error);
  assert.equal(unpack(revised).meta.id, saved.meta.id);
  assert.equal(unpack(revised).meta.revision, saved.meta.revision + 1);
  assert.equal(unpack(revised).meta.data.workflow_id, input.workflow_id);
});

test('substantive revision companions without a revision ID still refuse fresh creation', async t => {
  const { root, client, note } = await setup(t), input = await note(), before = inventory(root);
  for (const fields of [
    { revision_id: '', expected_revision: 1, revision_reason: null },
    { revision_id: null, expected_revision: null, revision_reason: 'This is an actual revision request with no target record.' },
  ]) {
    const result = await create(client, { note: input, ...fields });
    assert.equal(result.isError, true);
    assert.match(unpack(result).error, /revision fields require revision_id/);
    assert.deepEqual(inventory(root), before);
  }
});
