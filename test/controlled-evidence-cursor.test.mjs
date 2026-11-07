import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize, hash } from '../dist/storage.js';
import { createControlledMcpServer, controlledInstructions, controlledToolNames } from '../dist/controlled-tools.js';

const decoded = result => JSON.parse(result.content[0].text);
const path = 'docs/product.md', original = 'Original preservation text.\n'.repeat(3300);
const pass = { summary: 'Independently assessed current content and immutable original.', verdict: 'pass' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-evidence-cursor-'));
  initialize(root); mkdirSync(join(root, 'docs')); writeFileSync(join(root, path), 'Current product.\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function binding(extra = {}) {
  return { workflow_id: 'WF-EVIDENCE-KNW-0001', invocation_id: 'actual-evidence-reader', stage: 'review', role: 'reviewer',
    process_contract: 'workforce/v1', implementation_paths: ['docs'], verification_paths: [], read_paths: ['docs'],
    assessment_outputs: [path], change_assessment_outputs: [path], ...extra };
}
async function connect(t, root, actor = binding(), readEvidence) {
  const calls = [], reports = [], modes = [];
  const server = createControlledMcpServer(root, actor, { assertActive(mode) { modes.push(mode); },
    readEvidence: readEvidence ?? ((title, kind, page) => {
      calls.push({ title, kind, page });
      if (kind !== 'workflow') return { title: title ?? null, kind, actual: true };
      const start = page?.start_char ?? 0, end = Math.min(original.length, start + (page?.max_chars ?? 18000));
      return { artifact_changes: { omitted_count: 0, files: [{ path, available: true, history_authenticated: true,
        before_sha256: hash(original), current_sha256: hash(readFileSync(join(root, path))), evidence_sha256: hash('immutable-original-proof'),
        original_text: original.slice(start, end), original_start_char: start, original_end_char: end,
        original_total_chars: original.length, original_complete: end === original.length,
        next_start_char: end < original.length ? end : null, diff: 'Actual change.', diff_complete: true }] } };
    }), saveReport(report, _source, assessment) { reports.push({ report, assessment }); return { saved: true }; } });
  const client = new Client({ name: 'actual-evidence-cursor-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, server, reports, calls, modes, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

test('new WorkForce evidence schema contains professional selectors only, with an issued-cursor-only continuation', async t => {
  const root = fixture(t), c = await connect(t, root);
  const tools = (await c.client.listTools()).tools;
  assert.deepEqual(Object.keys(tools.find(tool => tool.name === 'check_evidence').inputSchema.properties), ['title', 'kind', 'path']);
  const more = tools.find(tool => tool.name === 'check_evidence_more').inputSchema;
  assert.deepEqual(Object.keys(more.properties), ['cursor']); assert.deepEqual(more.required, ['cursor']);
  assert.deepEqual(tools.map(tool => tool.name).sort(), controlledToolNames(binding()).sort());
  assert.doesNotMatch(controlledInstructions(binding()), /next_start_char/);
  for (const args of [{ kind: 'workflow', start_char: 0 }, { max_chars: 64000 }, { cursor: randomUUID() }, { workflow_id: 'forged' }])
    assert.equal((await c.call('check_evidence', args)).isError, true);
  assert.deepEqual(decoded(await c.call('check_evidence', { title: null, kind: null, path: null })), { title: null, kind: 'execution', actual: true });
  assert.equal(c.calls.at(-1).page, undefined);
  assert.equal(decoded(await c.call('check_evidence', { kind: 'workflow', path: '.workforce/credentials.json' })).code, 'PRIVATE_PATH');
  assert.equal(decoded(await c.call('check_evidence', { kind: 'workflow', path: 'outside.md' })).code, 'SCOPE_DENIED');
});

test('original evidence continuation replays lost responses and cannot pass a full-original guard prematurely', async t => {
  const root = fixture(t), actor = binding(); let c = await connect(t, root, actor);
  await c.call('assignment_read');
  assert.equal(decoded(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  const first = decoded(await c.call('check_evidence', { kind: 'workflow' }));
  assert.equal('next_start_char' in first.artifact_changes.files[0], false);
  assert.deepEqual(first.next_read, { tool: 'check_evidence_more', arguments: { cursor: first.next_cursor } });
  assert.deepEqual(decoded(await c.call('check_evidence', { kind: 'workflow' })), first);
  assert.equal(decoded(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  await c.client.close(); await c.server.close(); c = await connect(t, root, actor);
  const second = decoded(await c.call(first.next_read.tool, first.next_read.arguments));
  assert.deepEqual(decoded(await c.call(first.next_read.tool, first.next_read.arguments)), second);
  assert.deepEqual(c.calls[0].page, { path, start_char: 18000, max_chars: 64000 });
  assert.equal(c.modes.at(-1), 'read-only');
  assert.equal(decoded(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  const final = decoded(await c.call(second.next_read.tool, second.next_read.arguments));
  assert.equal('next_read' in final, false);
  assert.equal(first.artifact_changes.files[0].original_text + second.artifact_changes.files[0].original_text + final.artifact_changes.files[0].original_text, original);
  assert.notEqual((await c.call('assignment_report', pass)).isError, true);
  assert.equal(c.reports[0].assessment.artifact_changes[path].before_sha256, hash(original));
});

test('evidence cursors reject changed current artifacts, forged/foreign tokens and caller scope mutations', async t => {
  const root = fixture(t), c = await connect(t, root);
  const first = decoded(await c.call('check_evidence', { kind: 'workflow' }));
  assert.equal(decoded(await c.call('check_evidence_more', { cursor: randomUUID() })).code, 'INVALID_CURSOR');
  const foreign = await connect(t, root, binding({ invocation_id: 'foreign-actual-assignment' }));
  assert.equal(decoded(await foreign.call('check_evidence_more', { cursor: first.next_cursor })).code, 'INVALID_CURSOR');
  for (const args of [{ cursor: first.next_cursor, path: '.workforce/credentials.json' }, { cursor: first.next_cursor, start_char: 0 }, {}, { cursor: null }])
    assert.equal((await c.call('check_evidence_more', args)).isError, true);
  await c.call('assignment_read'); writeFileSync(join(root, path), 'Changed by the user.\n');
  assert.equal(decoded(await c.call('check_evidence_more', { cursor: first.next_cursor })).code, 'INPUT_CHANGED');
  assert.equal(decoded(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  writeFileSync(join(root, path), 'Current product.\n');
  assert.equal(decoded(await c.call('check_evidence_more', { cursor: first.next_cursor })).code, 'INPUT_CHANGED');
  const restarted = decoded(await c.call('check_evidence', { kind: 'workflow' }));
  assert.notEqual(restarted.next_cursor, first.next_cursor);
});

test('historical WorkForce evidence and software tools keep their exact numeric selector contract', async t => {
  const root = fixture(t);
  for (const extra of [{ evidence_read_contract: 'legacy-selectors' }, { read_contract: 'legacy-selectors' }, { process_contract: 'software-tools/v2' }]) {
    const c = await connect(t, root, binding({ ...extra, invocation_id: randomUUID() }));
    const tools = (await c.client.listTools()).tools;
    assert.equal(tools.some(tool => tool.name === 'check_evidence_more'), false);
    assert.deepEqual(Object.keys(tools.find(tool => tool.name === 'check_evidence').inputSchema.properties), ['title', 'kind', 'path', 'start_char', 'max_chars']);
    const result = decoded(await c.call('check_evidence', { kind: 'workflow', path, start_char: 128, max_chars: 256 }));
    assert.equal(result.artifact_changes.files[0].original_start_char, 128);
    assert.equal(result.artifact_changes.files[0].original_text.length, 256);
    assert.equal(result.artifact_changes.files[0].next_start_char, 384);
    assert.equal('next_read' in result, false);
  }
});

test('backend continuations select omitted assigned originals without caller paths and never certify unavailable history', async t => {
  const root = fixture(t), second = 'docs/second.md'; writeFileSync(join(root, second), 'Second current product.\n');
  const actor = binding({ assessment_outputs: [path, second], change_assessment_outputs: [path, second] });
  const c = await connect(t, root, actor, (_title, kind, page) => {
    assert.equal(kind, 'workflow');
    const selected = page?.path ?? path, before = `Original ${selected}.\n`;
    return { artifact_changes: { omitted_count: page?.path ? 0 : 1, files: [{ path: selected,
      available: true, history_authenticated: true, before_sha256: hash(before), current_sha256: hash(readFileSync(join(root, selected))),
      evidence_sha256: hash(`Immutable ${selected}`), original_text: before, original_start_char: 0,
      original_end_char: before.length, original_total_chars: before.length, next_start_char: null }] } };
  });
  await c.call('assignment_read');
  const first = decoded(await c.call('check_evidence', { kind: 'workflow' }));
  assert.equal(decoded(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  const last = decoded(await c.call(first.next_read.tool, first.next_read.arguments));
  assert.equal(last.artifact_changes.files[0].path, second); assert.equal('next_read' in last, false);
  assert.notEqual((await c.call('assignment_report', pass)).isError, true);
  const unavailable = await connect(t, root, binding({ invocation_id: 'unavailable-original' }), () => ({
    artifact_changes: { files: [{ path, available: false, history_authenticated: false, next_start_char: 123 }], omitted_count: 0 }
  }));
  await unavailable.call('assignment_read');
  const missing = decoded(await unavailable.call('check_evidence', { kind: 'workflow' }));
  assert.equal('next_read' in missing, false); assert.equal('next_start_char' in missing.artifact_changes.files[0], false);
  assert.equal(decoded(await unavailable.call('assignment_report', pass)).code, 'READ_REQUIRED');
});

test('read-only producer reassessment does not request future tests or unassigned original history', t => {
  const actor = binding({ stage: 'implementation', role: 'developer', artifact_revalidation: true, change_assessment_outputs: [] });
  const instructions = controlledInstructions(actor);
  assert.match(instructions, /future.*test|tests.*follow/);
  assert.doesNotMatch(instructions, /Original-file history still comes from check_evidence/);
  assert.match(instructions, /Do not.*(?:seek|read).*unassigned|No.*original.*(?:gate|obligation)/);
});
