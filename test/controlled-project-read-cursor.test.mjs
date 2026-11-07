import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { createControlledMcpServer, controlledInstructions } from '../dist/controlled-tools.js';

const decoded = result => JSON.parse(result.content[0].text);
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-public-read-cursor-'));
  initialize(root); mkdirSync(join(root, 'docs'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function binding(extra = {}) {
  return { workflow_id: 'WF-READ-KNW-0001', invocation_id: 'actual-owned-read', stage: 'review', role: 'reviewer',
    process_contract: 'workforce/v1', implementation_paths: ['docs'], verification_paths: [], read_paths: ['docs'], ...extra };
}
async function connect(t, root, actor = binding()) {
  const reports = [], server = createControlledMcpServer(root, actor, { assertActive() {},
    saveReport(report, _source, assessment) { reports.push({ report, assessment }); return { saved: true }; } });
  const client = new Client({ name: 'actual-public-read-cursor-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, server, reports, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

test('all new WorkForce roles advertise path-only first reads and a separate backend-cursor continuation', async t => {
  const root = project(t);
  for (const [stage, role] of [['planning', 'manager'], ['requirements', 'requirements'], ['design', 'architect'],
    ['implementation', 'developer'], ['review', 'reviewer'], ['verification', 'verifier'], ['diagnosis', 'manager']]) {
    const actor = binding({ stage, role, invocation_id: `owned-${stage}` }), c = await connect(t, root, actor);
    const tools = (await c.client.listTools()).tools;
    const schema = tools.find(tool => tool.name === 'project_read').inputSchema;
    assert.deepEqual(Object.keys(schema.properties), ['path']);
    assert.deepEqual(schema.required, ['path']);
    assert.equal(schema.additionalProperties, false);
    assert.doesNotMatch(JSON.stringify(schema), /max_chars|start_line|start_char|workflow_id|invocation_id/);
    const more = tools.find(tool => tool.name === 'project_read_more').inputSchema;
    assert.deepEqual(Object.keys(more.properties), ['cursor']); assert.deepEqual(more.required, ['cursor']);
    assert.match(controlledInstructions(actor), /project_read takes only.*path/);
  }
  const c = await connect(t, root, binding({ invocation_id: 'historical-read', process_contract: 'software-tools/v2' }));
  const schema = (await c.client.listTools()).tools.find(tool => tool.name === 'project_read').inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['max_chars', 'path', 'start_char', 'start_line']);
});

test('owned path-only reads use bounded opaque pages, replay lost replies and preserve actual assessment coverage through reconnect', async t => {
  const root = project(t), path = 'docs/large.md', body = 'A'.repeat(130050) + '\r\nFinal line.\r\n';
  writeFileSync(join(root, path), body);
  const actor = binding({ assessment_outputs: [path] });
  let c = await connect(t, root, actor);
  const report = () => c.call('assignment_report', { summary: 'Independent complete current-text inspection.', verdict: 'pass' });
  assert.equal(decoded(await report()).code, 'READ_REQUIRED');
  const first = decoded(await c.call('project_read', { path }));
  assert.equal(first.text.length, 64000); assert.equal(first.truncated, true);
  assert.match(first.next_cursor, /^[a-f0-9-]{36}$/);
  assert.equal('next_start_char' in first, false); assert.equal('start_line' in first, false);
  assert.deepEqual(decoded(await c.call('project_read', { path })), first);
  assert.deepEqual(first.next_read, { tool: 'project_read_more', arguments: { cursor: first.next_cursor } });
  assert.equal((await c.call('project_read', { path, cursor: null })).isError, true, 'The first-read tool has no cursor field to materialize.');
  assert.equal(decoded(await report()).code, 'READ_REQUIRED');
  await c.client.close(); await c.server.close(); c = await connect(t, root, actor);
  const second = decoded(await c.call(first.next_read.tool, first.next_read.arguments));
  assert.equal(second.text.length, 64000);
  assert.deepEqual(decoded(await c.call('project_read_more', { cursor: first.next_cursor })), second);
  assert.equal(decoded(await report()).code, 'READ_REQUIRED');
  const last = decoded(await c.call(second.next_read.tool, second.next_read.arguments));
  assert.equal(last.truncated, false); assert.equal('next_cursor' in last, false);
  assert.equal(first.text + second.text + last.text, body.replace(/\r\n/g, '\n'));
  assert.notEqual((await report()).isError, true);
  assert.equal(c.reports[0].assessment.artifact_hashes[path], last.sha256);
});

test('file changes invalidate issued read cursors and stale coverage without reviving a token after reverting bytes', async t => {
  const root = project(t), path = 'docs/changed.md', original = 'A'.repeat(90000), replacement = 'B'.repeat(95000);
  writeFileSync(join(root, path), original);
  const c = await connect(t, root, binding({ assessment_outputs: [path] }));
  const report = () => c.call('assignment_report', { summary: 'Independent current content review.', verdict: 'pass' });
  const first = decoded(await c.call('project_read', { path }));
  writeFileSync(join(root, path), replacement);
  assert.equal(decoded(await c.call('project_read_more', { cursor: first.next_cursor })).code, 'INPUT_CHANGED');
  assert.equal(decoded(await report()).code, 'READ_REQUIRED');
  const restarted = decoded(await c.call('project_read', { path }));
  assert.equal(restarted.text, replacement.slice(0, 64000)); assert.notEqual(restarted.sha256, first.sha256);
  assert.equal(decoded(await report()).code, 'READ_REQUIRED');
  const last = decoded(await c.call('project_read_more', { cursor: restarted.next_cursor }));
  assert.equal(restarted.text + last.text, replacement);
  assert.notEqual((await report()).isError, true);
  writeFileSync(join(root, path), original);
  assert.equal(decoded(await c.call('project_read_more', { cursor: first.next_cursor })).code, 'INPUT_CHANGED');
  const fresh = decoded(await c.call('project_read', { path }));
  assert.notEqual(fresh.next_cursor, first.next_cursor);
  assert.equal(decoded(await report()).code, 'READ_REQUIRED');
});

test('opaque cursors are bound to the exact file, tool and actual assignment, not caller-selected positions', async t => {
  const root = project(t), path = 'docs/large.md';
  writeFileSync(join(root, path), 'A'.repeat(65000));
  writeFileSync(join(root, 'docs/other.md'), 'Other assigned content.');
  const c = await connect(t, root, binding({ assessment_outputs: [path] }));
  const first = decoded(await c.call('project_read', { path }));
  assert.equal(decoded(await c.call('project_read_more', { cursor: randomUUID() })).code, 'INVALID_CURSOR');
  assert.equal((await c.call('project_read_more', { path: 'docs/other.md', cursor: first.next_cursor })).isError, true);
  assert.equal((await c.call('project_read', { path: 'docs/other.md', cursor: first.next_cursor })).isError, true);
  const other = await connect(t, root, binding({ invocation_id: 'actual-foreign-read' }));
  assert.equal(decoded(await other.call('project_read_more', { cursor: first.next_cursor })).code, 'INVALID_CURSOR');
  const batch = decoded(await c.call('assignment_read', { cursor: null }));
  assert.ok(batch.pages.every(page => !('next_start_char' in page)), 'Batch pagination exposes only its outer opaque cursor.');
  assert.equal(decoded(await c.call('project_read_more', { cursor: batch.next_cursor })).code, 'INVALID_CURSOR');
  assert.equal(decoded(await c.call('assignment_read', { cursor: first.next_cursor })).code, 'INVALID_CURSOR');
  assert.equal(decoded(await c.call('project_read_more', { cursor: first.next_cursor })).text.length, 1000);
  for (const input of [{ cursor: null }, {}, { cursor: '' }]) assert.equal((await c.call('project_read_more', input)).isError, true);
});

test('owned simplified reads retain private, scope, traversal and schema guards', async t => {
  const root = project(t), path = 'docs/readable.md';
  writeFileSync(join(root, path), 'Ordinary scoped text.\n');
  writeFileSync(join(root, 'outside.md'), 'Not assigned.\n');
  const c = await connect(t, root, binding({ assessment_outputs: [path] }));
  for (const input of [{ path, max_chars: 128 }, { path, max_chars: null }, { path, start_line: 1 }, { path, start_char: 0 },
    { path, cursor: '' }, { path: null }, { path, workflow_id: 'forged' }])
    assert.equal((await c.call('project_read', input)).isError, true);
  assert.equal(decoded(await c.call('assignment_report', { summary: 'Premature pass.', verdict: 'pass' })).code, 'READ_REQUIRED');
  assert.equal(decoded(await c.call('project_read', { path: '.workforce/config.json' })).code, 'PRIVATE_PATH');
  assert.equal(decoded(await c.call('project_read', { path: '../outside.md' })).code, 'INVALID_PATH');
  assert.equal(decoded(await c.call('project_read', { path: 'outside.md' })).code, 'SCOPE_DENIED');
  assert.equal(decoded(await c.call('project_read', { path })).text, 'Ordinary scoped text.\n');
});

test('owned runtime guide reads use opaque input and trusted installed content instead of a poisoned private project guide', async t => {
  const root = project(t);
  mkdirSync(join(root, '.workforce/guides'), { recursive: true });
  writeFileSync(join(root, '.workforce/guides/workforce.md'), 'PRIVATE_PROJECT_GUIDE_CANARY');
  const actor = binding({ stage: 'design', role: 'architect' }), c = await connect(t, root, actor);
  const guide = decoded(await c.call('project_read', { path: '.neomind/guides/controlled-workflows.md' }));
  assert.equal(guide.path, '.workforce/guides/workforce.md');
  assert.equal(guide.source, 'trusted-installed-runtime'); assert.equal(guide.project_private_file_read, false);
  assert.doesNotMatch(guide.text, /PRIVATE_PROJECT_GUIDE_CANARY/);
  assert.ok(guide.text.length <= 64000);
  assert.doesNotMatch(JSON.stringify(Object.keys(guide)), /next_start_char|start_line/);
  assert.match(controlledInstructions(actor), /project_read takes only.*path/);
});

test('legacy software-tools numeric pagination and required-field rejection remain unchanged', async t => {
  const root = project(t), path = 'docs/legacy.md', body = 'First\r\n' + 'A'.repeat(200) + '\r\nLast\r\n';
  writeFileSync(join(root, path), body);
  const c = await connect(t, root, binding({ process_contract: 'software-tools/v2' }));
  const first = decoded(await c.call('project_read', { path, max_chars: 128 }));
  assert.equal(first.text, body.replace(/\r\n/g, '\n').slice(0, 128));
  assert.equal(first.next_start_char, 128);
  const next = decoded(await c.call('project_read', { path, start_char: first.next_start_char }));
  assert.equal(first.text + next.text, body.replace(/\r\n/g, '\n'));
  assert.equal(decoded(await c.call('project_read', { path, start_line: 2 })).text, 'A'.repeat(200) + '\nLast\n');
  assert.equal((await c.call('project_read', { path, cursor: null })).isError, true);
  assert.equal((await c.call('project_read', { path, max_chars: null })).isError, true);
});

test('explicit historical WorkForce legacy-selectors retain numeric and null-default semantics without the new continuation tool', async t => {
  const root = project(t), path = 'docs/historical.md', body = 'First\nSecond\nThird\n';
  writeFileSync(join(root, path), body);
  const c = await connect(t, root, binding({ read_contract: 'legacy-selectors' }));
  const tools = (await c.client.listTools()).tools;
  assert.equal(tools.some(tool => tool.name === 'project_read_more'), false);
  assert.deepEqual(Object.keys(tools.find(tool => tool.name === 'project_read').inputSchema.properties), ['path', 'max_chars', 'start_line', 'start_char']);
  for (const args of [{ path }, { path, max_chars: null, start_line: null, start_char: null },
    { path, max_chars: 64000, start_line: 1, start_char: 0 }]) assert.equal(decoded(await c.call('project_read', args)).text, body);
  assert.equal(decoded(await c.call('project_read', { path, start_line: 2, start_char: 0 })).text, 'Second\nThird\n');
  assert.equal(decoded(await c.call('project_read', { path, start_line: 2, start_char: 6 })).code, 'INVALID_PAYLOAD');
});
