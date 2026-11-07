import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { createControlledMcpServer, controlledToolNames, controlledInstructions } from '../dist/controlled-tools.js';

const decode = result => JSON.parse(result.content[0].text);
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-assignment-read-'));
  initialize(root); mkdirSync(join(root, 'docs'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function actor(outputs, overrides = {}) {
  return { workflow_id: 'WF-READ-KNW-0001', invocation_id: 'bound-review', stage: 'review', role: 'reviewer',
    process_contract: 'workforce/v1', implementation_paths: ['docs'], verification_paths: [],
    read_paths: ['docs'], assessment_outputs: outputs, ...overrides };
}
async function connect(t, root, binding, callbacks = {}) {
  const reports = [];
  const server = createControlledMcpServer(root, binding, { assertActive() {},
    saveReport(report, _source, assessment) { reports.push({ report, assessment }); return { saved: true }; }, ...callbacks });
  const client = new Client({ name: 'actual-assignment-read-mcp-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, server, reports, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}
const pass = { summary: 'Independently inspected every current output.', verdict: 'pass', product_findings: [] };

test('empty assignment_read reads all six small assigned outputs once and satisfies the actual assessment guard', async t => {
  const root = project(t), outputs = Array.from({ length: 6 }, (_, index) => `docs/output-${index}.md`);
  outputs.forEach((path, index) => writeFileSync(join(root, path), `# Output ${index}\nReviewed content.\n`));
  const binding = actor(outputs), c = await connect(t, root, binding);
  const tools = (await c.client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'assignment_read'));
  assert.deepEqual(tools.map(tool => tool.name).sort(), controlledToolNames(binding).sort());
  assert.deepEqual(Object.keys(tools.find(tool => tool.name === 'assignment_read').inputSchema.properties), ['cursor']);
  assert.match(controlledInstructions(binding), /assignment_read/);
  assert.equal(decode(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  const result = await c.call('assignment_read');
  assert.notEqual(result.isError, true);
  const batch = decode(result);
  assert.equal(batch.complete, true);
  assert.deepEqual(batch.pages.map(page => page.path), outputs);
  assert.ok(batch.pages.every(page => page.exists && !page.truncated && /^[a-f0-9]{64}$/.test(page.sha256)));
  assert.ok(batch.pages.reduce((sum, page) => sum + page.text.length, 0) <= 64000);
  assert.notEqual((await c.call('assignment_report', pass)).isError, true);
  assert.deepEqual(Object.keys(c.reports[0].assessment.artifact_hashes).sort(), outputs);
  assert.deepEqual(decode(await c.call('assignment_read')), batch, 'Retrying {} replays the same delivered batch.');
});

test('backend pagination survives MCP reconnect and never marks an undisclosed tail as assessed', async t => {
  const root = project(t), content = 'A'.repeat(130050) + '\r\nThe final line.\r\n';
  writeFileSync(join(root, 'docs/large.md'), content);
  writeFileSync(join(root, 'docs/last.md'), 'Last output.\n');
  const binding = actor(['docs/large.md', 'docs/last.md']);
  let c = await connect(t, root, binding);
  const first = decode(await c.call('assignment_read'));
  assert.equal(first.complete, false);
  assert.equal(first.pages.length, 1);
  assert.equal(first.pages[0].text.length, 64000);
  assert.match(first.next_cursor, /^[a-f0-9-]{36}$/);
  assert.deepEqual(decode(await c.call('assignment_read')), first, 'A lost first reply does not silently advance the backend cursor.');
  assert.equal(decode(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  await c.client.close(); await c.server.close();
  c = await connect(t, root, binding);
  const second = decode(await c.call('assignment_read', { cursor: first.next_cursor }));
  assert.equal(second.complete, false);
  assert.equal(second.pages[0].text.length, 64000);
  assert.deepEqual(decode(await c.call('assignment_read', { cursor: first.next_cursor })), second,
    'Retrying the same opaque cursor replays the same page and next cursor.');
  assert.equal(decode(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  const third = decode(await c.call('assignment_read', { cursor: second.next_cursor }));
  assert.equal(third.complete, true);
  assert.deepEqual(third.pages.map(page => page.path), ['docs/large.md', 'docs/last.md']);
  assert.equal([first, second, third].flatMap(batch => batch.pages).filter(page => page.path === 'docs/large.md')
    .map(page => page.text).join(''), content.replace(/\r\n/g, '\n'));
  assert.notEqual((await c.call('assignment_report', pass)).isError, true);
});

test('a changed file invalidates issued cursors and old coverage, requiring an explicit restart at current text', async t => {
  const root = project(t), path = 'docs/changed.md';
  writeFileSync(join(root, path), 'old '.repeat(25000));
  const c = await connect(t, root, actor([path]));
  const old = decode(await c.call('assignment_read'));
  assert.equal(old.complete, false);
  const replacement = 'NEW '.repeat(24000);
  writeFileSync(join(root, path), replacement);
  assert.equal(decode(await c.call('assignment_read', { cursor: old.next_cursor })).code, 'INPUT_CHANGED');
  assert.equal(decode(await c.call('assignment_read', { cursor: old.next_cursor })).code, 'INPUT_CHANGED');
  const restarted = decode(await c.call('assignment_read'));
  assert.deepEqual(restarted.changed_paths, [path]);
  assert.equal(restarted.pages[0].text, replacement.slice(0, 64000));
  assert.notEqual(restarted.pages[0].sha256, old.pages[0].sha256);
  assert.equal(restarted.complete, false);
  assert.equal(decode(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  const last = decode(await c.call('assignment_read', { cursor: restarted.next_cursor }));
  assert.equal(last.complete, true);
  assert.equal(restarted.pages[0].text + last.pages[0].text, replacement);
  assert.notEqual((await c.call('assignment_report', pass)).isError, true);
  writeFileSync(join(root, path), 'A later user revision.\n');
  assert.equal(decode(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  assert.equal(decode(await c.call('assignment_read', { cursor: restarted.next_cursor })).code, 'INPUT_CHANGED');
  const afterComplete = decode(await c.call('assignment_read'));
  assert.equal(afterComplete.complete, true);
  assert.deepEqual(afterComplete.changed_paths, [path]);
  assert.equal(afterComplete.pages[0].text, 'A later user revision.\n');
});

test('a rejected later batch file never persists coverage for earlier undelivered pages', async t => {
  const root = project(t), outputs = ['docs/first.md', 'docs/invalid.md'];
  writeFileSync(join(root, outputs[0]), 'First must actually be delivered.\n');
  writeFileSync(join(root, outputs[1]), Buffer.from([0xff, 0xfe]));
  const c = await connect(t, root, actor(outputs));
  const failed = await c.call('assignment_read');
  assert.equal(failed.isError, true);
  assert.equal(decode(failed).code, 'INVALID_FILE');
  writeFileSync(join(root, outputs[1]), 'Now valid.\n');
  await c.call('project_read', { path: outputs[1] });
  const premature = await c.call('assignment_report', pass);
  assert.equal(decode(premature).code, 'READ_REQUIRED');
  assert.equal(c.reports.length, 0);
  const recovered = decode(await c.call('assignment_read'));
  assert.equal(recovered.complete, true);
  assert.deepEqual(recovered.pages.map(page => page.path), outputs);
  assert.notEqual((await c.call('assignment_report', pass)).isError, true);
});

test('empty-input batch reads cannot select other paths or bypass private and readable-scope guards', async t => {
  const root = project(t), path = 'docs/public.md';
  writeFileSync(join(root, path), 'Public assigned content.\n');
  const c = await connect(t, root, actor([path]));
  for (const input of [{ path: '.workforce/config.json' }, { max_chars: 2097152 }, { start_char: 1 }, { workflow_id: 'foreign' }])
    assert.equal((await c.call('assignment_read', input)).isError, true);
  assert.equal(decode(await c.call('assignment_read', { cursor: randomUUID() })).code, 'INVALID_CURSOR');
  assert.equal(decode(await c.call('assignment_report', pass)).code, 'READ_REQUIRED');
  assert.equal(decode(await c.call('assignment_read')).complete, true);
  const privateActor = await connect(t, root, actor(['.workforce/config.json'], { invocation_id: 'private-bound-read', read_paths: ['.'] }));
  const denied = await privateActor.call('assignment_read');
  assert.equal(denied.isError, true);
  assert.equal(decode(denied).code, 'PRIVATE_PATH');
  const scopedActor = await connect(t, root, actor([path], { invocation_id: 'other-scope-read', read_paths: ['other'] }));
  assert.equal(decode(await scopedActor.call('assignment_read')).code, 'SCOPE_DENIED');
});

test('opaque paging cursors cannot be reused by a foreign assignment', async t => {
  const root = project(t), path = 'docs/large.md';
  writeFileSync(join(root, path), 'A'.repeat(65000));
  const owner = await connect(t, root, actor([path]));
  const first = decode(await owner.call('assignment_read'));
  const other = await connect(t, root, actor([path], { invocation_id: 'foreign-invocation', workflow_id: 'foreign-workflow' }));
  assert.equal(decode(await other.call('assignment_read', { cursor: first.next_cursor })).code, 'INVALID_CURSOR');
  assert.equal(decode(await other.call('assignment_report', pass)).code, 'READ_REQUIRED');
  assert.equal(decode(await owner.call('assignment_read', { cursor: first.next_cursor })).complete, true);
});

test('current batch text does not replace required original-file history evidence', async t => {
  const root = project(t), path = 'docs/edited.md';
  writeFileSync(join(root, path), 'Current changed product.\n');
  const c = await connect(t, root, actor([path], { change_assessment_outputs: [path] }));
  assert.equal(decode(await c.call('assignment_read')).complete, true);
  const report = await c.call('assignment_report', pass);
  assert.equal(decode(report).code, 'READ_REQUIRED');
  assert.match(decode(report).error, /Original content|original-text|check_evidence/);
  assert.equal(c.reports.length, 0);
});

test('assignment_read is available only for nonempty WorkForce assessments including read-only revalidation', async t => {
  const root = project(t), path = 'docs/result.md';
  writeFileSync(join(root, path), 'Current output.\n');
  for (const binding of [actor([], { invocation_id: 'empty-assessment' }),
    actor([path], { invocation_id: 'legacy-assessment', process_contract: 'software-tools/v2' })]) {
    const c = await connect(t, root, binding);
    assert.equal((await c.client.listTools()).tools.some(tool => tool.name === 'assignment_read'), false);
    assert.equal(controlledToolNames(binding).includes('assignment_read'), false);
    assert.notEqual((await c.call('project_read', { path })).isError, true, 'Legacy explicit file reads remain available.');
  }
  const binding = actor([path], { invocation_id: 'revalidation', artifact_revalidation: true, stage: 'implementation', role: 'developer' });
  const c = await connect(t, root, binding);
  assert.ok(controlledToolNames(binding).includes('assignment_read'));
  assert.equal(decode(await c.call('assignment_read')).complete, true);
});
