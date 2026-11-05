import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeLegacy as initialize } from './helpers/legacy-project.mjs';
import { createControlledMcpServer, controlledInstructions } from '../dist/controlled-tools.js';

const decoded = result => JSON.parse(result.content[0].text);

test('WorkForce write and checker guidance use scoped edits and byte-identical short-path compiler staging', () => {
  const binding = { workflow_id: 'FILEEDIT-KNW-0001', role: 'developer', stage: 'implementation',
    process_contract: 'workforce/v1', implementation_paths: ['README.md'], verification_paths: ['checks'] };
  const producer = controlledInstructions(binding);
  assert.match(producer, /prefer task_file_write with edits/);
  assert.match(producer, /including replayed:true/);
  const checker = controlledInstructions({ ...binding, role: 'verifier', stage: 'verification' });
  assert.match(checker, /Windows compiler cannot open a long existing project source path/);
  assert.match(checker, /stage exactly unchanged source bytes/);
  assert.match(checker, /verify source hash identity against the current baseline/);
  assert.match(checker, /do not rename or modify product files or weaken checks/);
});
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-file-edits-'));
  initialize(root, { project_id: 'FILEEDIT', name: 'Scoped file edits' });
  mkdirSync(join(root, 'checks'));
  const original = '# Curriculum\r\n' + 'Preserved unrelated navigation.\r\n'.repeat(400) +
    '- [Existing exercise](exercises/old.md)\r\n\r\n## Other courses\r\nKeep all of these.\r\n';
  writeFileSync(join(root, 'README.md'), original);
  const binding = { workflow_id: 'FILEEDIT-KNW-0001', task_id: 'FILEEDIT-TASK-0001',
    invocation_id: 'actual-file-edit-invocation', role: 'developer', stage: 'implementation',
    process_contract: 'workforce/v1', implementation_paths: ['README.md'], verification_paths: ['checks'],
    cornell_bound: false, procedure_bound: false, execution_steps: [] };
  const events = [];
  async function connect() {
    const server = createControlledMcpServer(root, binding, { assertActive() {}, saveReport() {}, trace: event => events.push(event) });
    const client = new Client({ name: 'scoped-file-edit-repro', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    t.after(async () => { await client.close(); await server.close(); });
    return (name, args = {}) => client.callTool({ name, arguments: args });
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, original, connect, events };
}

test('a small scoped README edit preserves all original CRLF bytes without resending the whole file', async t => {
  const f = await fixture(t), call = await f.connect();
  await call('project_read', { path: 'README.md' });
  const old_text = '- [Existing exercise](exercises/old.md)', new_text = old_text + '\r\n- [1290](exercises/1290.md)';
  const args = { path: 'README.md', edits: [{ old_text, new_text }] };
  assert.ok(JSON.stringify(args).length < f.original.length / 20);
  const result = await call('task_file_write', args);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(decoded(result).replayed, false);
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), f.original.replace(old_text, new_text));
  assert.doesNotMatch(JSON.stringify(f.events), /Preserved unrelated navigation|Existing exercise|1290\.md/);
});

test('lost-response edit retries survive restart without adding the link twice or rewriting the file', async t => {
  const f = await fixture(t), call = await f.connect();
  await call('project_read', { path: 'README.md' });
  const args = { path: 'README.md', edits: [{ old_text: '## Other courses', new_text: '## Other courses\r\nNew link' }] };
  assert.notEqual((await call('task_file_write', args)).isError, true);
  const before = statSync(join(f.root, 'README.md')).mtimeMs, next = await f.connect();
  const replay = await next('task_file_write', args);
  assert.notEqual(replay.isError, true); assert.equal(decoded(replay).replayed, true);
  assert.equal(statSync(join(f.root, 'README.md')).mtimeMs, before);
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8').split('New link').length, 2);
});

test('edits preserve concurrent user changes and never apply partial or ambiguous replacements', async t => {
  const f = await fixture(t), call = await f.connect();
  const args = { path: 'README.md', edits: [{ old_text: '## Other courses', new_text: '## Renamed courses' }] };
  assert.equal(decoded(await call('task_file_write', args)).code, 'READ_REQUIRED');
  await call('project_read', { path: 'README.md' });
  writeFileSync(join(f.root, 'README.md'), f.original + 'User edit\r\n');
  assert.equal(decoded(await call('task_file_write', args)).code, 'INPUT_CHANGED');
  await call('project_read', { path: 'README.md' });
  for (const edits of [[{ old_text: 'not present', new_text: 'wrong' }],
    [{ old_text: 'Preserved unrelated navigation.', new_text: 'wrong' }],
    [{ old_text: '## Other courses', new_text: '## Renamed' }, { old_text: 'not present', new_text: 'wrong' }]]) {
    assert.equal((await call('task_file_write', { path: 'README.md', edits })).isError, true);
    assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), f.original + 'User edit\r\n');
  }
  assert.equal((await call('task_file_write', { path: 'checks/checker.py', edits: args.edits })).isError, true);
  assert.equal((await call('task_file_write', { path: 'README.md', content: 'wrong', edits: args.edits })).isError, true);
});

test('LF-normalized multiline snippets preserve CRLF, BOM, Unicode and untouched trailing bytes', async t => {
  const f = await fixture(t), call = await f.connect();
  const original = '\ufeff# Unicode 🌎\r\nA\r\nB\r\n\r\nUntouched  \r\n';
  writeFileSync(join(f.root, 'README.md'), original);
  await call('project_read', { path: 'README.md' });
  const result = await call('task_file_write', { path: 'README.md', content: null,
    edits: [{ old_text: '🌎\nA\nB', new_text: '🌎\nC\nD' }] });
  assert.notEqual(result.isError, true);
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), original.replace('A\r\nB', 'C\r\nD'));
});

test('unchanged content is acknowledged without physical replacement or a spurious write operation', async t => {
  const f = await fixture(t), call = await f.connect();
  await call('project_read', { path: 'README.md' });
  const before = statSync(join(f.root, 'README.md')).mtimeMs;
  const result = decoded(await call('task_file_write', { path: 'README.md', content: f.original, edits: null }));
  assert.equal(result.unchanged, true); assert.equal(result.replayed, true);
  assert.equal(statSync(join(f.root, 'README.md')).mtimeMs, before);
  const journal = join(f.root, '.neomind/controlled-tools', createHash('sha256').update('actual-file-edit-invocation').digest('hex'), 'state.json');
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).writes.length, 0);
});

test('a replay cannot conceal a concurrent user revision or altered immutable operation history', async t => {
  const f = await fixture(t), call = await f.connect();
  await call('project_read', { path: 'README.md' });
  const args = { path: 'README.md', edits: [{ old_text: '## Other courses', new_text: '## Renamed' }] };
  assert.notEqual((await call('task_file_write', args)).isError, true);
  const saved = readFileSync(join(f.root, 'README.md'), 'utf8');
  writeFileSync(join(f.root, 'README.md'), saved + 'User\r\n');
  assert.equal(decoded(await call('task_file_write', args)).code, 'INPUT_CHANGED');
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), saved + 'User\r\n');
  writeFileSync(join(f.root, 'README.md'), saved);
  const base = join(f.root, '.neomind/controlled-tools', createHash('sha256').update('actual-file-edit-invocation').digest('hex'));
  const state = JSON.parse(readFileSync(join(base, 'state.json'), 'utf8'));
  writeFileSync(join(base, 'writes', state.writes[0].operation, 'previous.utf8'), 'tampered');
  assert.equal((await call('task_file_write', args)).isError, true);
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), saved);
});
