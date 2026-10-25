import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { createControlledMcpServer, controlledInstructions, controlledToolNames } from '../dist/controlled-tools.js';

const decode = result => JSON.parse(result.content[0].text);
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-controlled-tools-'));
  initialize(root, { project_id: 'CONTROLLED', name: 'Controlled tools' });
  for (const folder of ['src', 'checks', 'docs']) mkdirSync(join(root, folder));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'checks/oracle.mjs'), 'protected oracle\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function binding(stage = 'implementation', extra = {}) {
  return { workflow_id: 'CONTROLLED-KNW-0001', task_id: 'CONTROLLED-TASK-0001',
    invocation_id: `actual-invocation-${stage}`, role: stage === 'implementation' ? 'developer'
      : stage === 'verification' ? 'verifier' : stage === 'review' ? 'reviewer' : 'manager',
    stage, implementation_paths: ['src', 'docs'], verification_paths: ['checks'],
    protected_paths: ['checks/oracle.mjs'], check_titles: ['Independent check'], ...extra };
}
async function connect(t, root, actor = binding(), callbacks = {}) {
  const reports = [], plans = [], checks = [], events = [];
  const server = createControlledMcpServer(root, actor, {
    assertActive() {}, saveReport: value => { reports.push(value); return { saved: true }; },
    submitPlan: value => { plans.push(value); return { saved: true }; },
    runCheck: title => { checks.push(title); return { exit_code: 0, observed: true }; },
    prepareWork: () => ({ decision: 'new', execution_authorized: false }),
    trace: value => { events.push(value); }, ...callbacks,
  });
  const client = new Client({ name: 'actual-mcp-controlled-tools-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, server, reports, plans, checks, events,
    call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

test('controlled workers discover only role-local semantic inputs, without identity/credential/lifecycle fields', async t => {
  const root = project(t);
  for (const stage of ['planning', 'implementation', 'verification', 'review', 'diagnosis']) {
    const actor = binding(stage), c = await connect(t, root, actor);
    const tools = (await c.client.listTools()).tools;
    assert.deepEqual(tools.map(item => item.name).sort(), controlledToolNames(actor).sort());
    const schemas = JSON.stringify(tools.map(item => item.inputSchema));
    assert.doesNotMatch(schemas, /workflow_id|task_id|invocation_id|expected_hash|operation_id|claim_token|reported_assignment|target_ids|submit_task/);
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(!tools.some(item => /record_(create|update)|claim|progress|workflow_next/.test(item.name)));
    assert.doesNotMatch(controlledInstructions(actor), /seven.section|assignment_open|claim_token|assignment_claim/);
  }
});

test('identity spoofing is rejected before the bound report callback and no supplied secret is echoed', async t => {
  const c = await connect(t, project(t));
  for (const field of ['workflow_id', 'task_id', 'invocation_id', 'claim_token', 'reported_assignment', 'submit_task']) {
    const response = await c.call('assignment_report', { outcome: 'completed', summary: 'Useful substantive work.',
      [field]: field === 'reported_assignment' ? { id: 'other', token: 'secret-marker' } : 'secret-marker' });
    assert.equal(response.isError, true, field);
    assert.doesNotMatch(JSON.stringify(response), /secret-marker/);
  }
  assert.equal(c.reports.length, 0);
});

test('explicit canonical skill assets are readable as data without exposing private client configuration or write access', async t => {
  const root = project(t), input = '.agents/skills/cornell/assets/template.md';
  mkdirSync(join(root, '.agents/skills/cornell/assets'), { recursive: true });
  writeFileSync(join(root, input), '# Existing research template\n');
  const c = await connect(t, root, binding('planning', { approved_inputs: [input] }));
  assert.match(decode(await c.call('project_read', { path: input })).text, /Existing research template/);
  assert.equal((await c.call('project_read', { path: '.codex/config.toml' })).isError, true);
  assert.throws(() => createControlledMcpServer(root, binding('planning', { approved_inputs: ['.agents/skills/cornell/assets/credentials.json'] }),
    { assertActive() {}, saveReport() {} }), /bounded skill assets/);
});

test('producer writes use actual-read CAS and preserve external edits, with replay safe after server restart', async t => {
  const root = project(t), actor = binding(), c = await connect(t, root, actor);
  assert.equal((await c.call('task_file_write', { path: 'src/value.mjs', content: 'unread overwrite' })).isError, true);
  assert.equal(decode(await c.call('project_read', { path: 'src/value.mjs' })).text, 'export const value = 1;\n');
  writeFileSync(join(root, 'src/value.mjs'), 'external user edit\n');
  const conflict = await c.call('task_file_write', { path: 'src/value.mjs', content: 'stale overwrite' });
  assert.equal(decode(conflict).code, 'INPUT_CHANGED');
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'external user edit\n');
  await c.call('project_read', { path: 'src/value.mjs' });
  const content = 'export const value = 2;\n';
  assert.deepEqual(decode(await c.call('task_file_write', { path: 'src/value.mjs', content })),
    { path: 'src/value.mjs', saved: true, replayed: false });
  const next = await connect(t, root, actor);
  assert.equal(decode(await next.call('task_file_write', { path: 'src/value.mjs', content })).replayed, true);
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), content);
  const writes = join(root, '.neomind', 'controlled-tools');
  assert.equal(readdirSync(writes).length, 1);
  const traces = JSON.stringify(c.events);
  assert.doesNotMatch(traces, /external user edit|export const/);
  assert.match(traces, /content_sha256/);
});

test('verification has its own checker scope and producer/protected outputs remain immutable', async t => {
  const root = project(t), verifier = await connect(t, root, binding('verification'));
  for (const path of ['src/value.mjs', 'checks/oracle.mjs', '../outside.mjs', 'checks/../src/value.mjs', '.neomind/config.json'])
    assert.equal((await verifier.call('task_file_write', { path, content: 'bad overwrite' })).isError, true, path);
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(readFileSync(join(root, 'checks/oracle.mjs'), 'utf8'), 'protected oracle\n');
  assert.equal(decode(await verifier.call('task_file_write', { path: 'checks/new.mjs', content: 'assert.equal(value, 1);\n' })).saved, true);
  assert.equal((await verifier.call('check_run', { title: 'made-up command' })).isError, true);
  assert.equal((await verifier.call('check_run', { title: 'Independent check' })).isError, undefined);
  assert.deepEqual(verifier.checks, ['Independent check']);
  const producer = await connect(t, root);
  assert.equal((await producer.call('task_file_write', { path: 'checks/other.mjs', content: 'bad checker' })).isError, true);
});

test('blocked and failed substantive reports persist without task submission or mandatory progress calls', async t => {
  const c = await connect(t, project(t));
  for (const outcome of ['blocked', 'failed']) {
    const report = { outcome, summary: 'Discovery is useful but implementation is incomplete.',
      artifacts: ['src/value.mjs'], failure_kind: 'environment', findings: ['Compiler is unavailable.'] };
    assert.deepEqual(decode(await c.call('assignment_report', report)), { saved: true });
    assert.deepEqual(c.reports.at(-1), report);
  }
  assert.equal(c.reports.length, 2);
  assert.doesNotMatch(JSON.stringify(c.reports), /submit_task|invocation_id|workflow_id/);
});

test('private files are omitted from reads, listing and search; project text and semantic plans remain usable', async t => {
  const root = project(t);
  writeFileSync(join(root, '.env'), 'SECRET-MARKER');
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/token'), 'SECRET-MARKER');
  writeFileSync(join(root, 'docs/concept.md'), 'Visible search phrase\n');
  const c = await connect(t, root, binding('planning'));
  for (const path of ['.env', '.git/token', '.neomind/config.json', 'D:/private.txt', '../outside'])
    assert.equal((await c.call('project_read', { path })).isError, true, path);
  const listed = decode(await c.call('project_list'));
  assert.ok(listed.files.includes('docs/concept.md'));
  assert.ok(!listed.files.some(path => path.startsWith('.')));
  assert.equal(decode(await c.call('project_search', { query: 'SECRET-MARKER' })).matches.length, 0);
  assert.equal(decode(await c.call('project_search', { query: 'Visible search phrase' })).matches[0].path, 'docs/concept.md');
  const plan = { title: 'Deliver bounded work', objective: 'Create a useful scoped artifact.', rationale: 'Reuse the current implementation.',
    acceptance_criteria: ['Actual output passes an independent check.'], allowed_paths: ['src'], verification_paths: ['checks'],
    outputs: ['src/value.mjs'], documentation_paths: [], checks: [{ title: 'Independent check', command: ['node', 'checks/new.mjs'], baseline_paths: ['src', 'checks'],
      negative_controls: [{ title: 'Reject invalid fixture', command: ['node', 'checks/new.mjs', 'checks/invalid.json'], baseline_paths: ['checks'], expected_exit_code: 1 }] }],
    risk: 'elevated', specialists: [{ role: 'explorer', objective: 'Inspect current reusable tooling.' }] };
  assert.equal(decode(await c.call('workflow_plan', plan)).saved, true);
  assert.deepEqual(c.plans[0], plan);
  assert.equal((await c.call('workflow_plan', { ...plan, checks: [{ ...plan.checks[0],
    negative_controls: [{ ...plan.checks[0].negative_controls[0], expected_exit_code: 0 }] }] })).isError, true);
});

test('write replay refuses tampered immutable history and invalid content leaves no pending write intent', async t => {
  const root = project(t), c = await connect(t, root);
  const invalid = await c.call('task_file_write', { path: 'src/new.txt', content: '\0invalid' });
  assert.equal(decode(invalid).code, 'INVALID_FILE');
  assert.equal(existsSync(join(root, '.neomind/controlled-tools')), false);
  assert.equal((await c.call('task_file_write', { path: 'src/new.txt', content: 'valid text' })).isError, undefined);
  const tools = join(root, '.neomind/controlled-tools'), invocation = readdirSync(tools)[0];
  const folder = join(tools, invocation, 'writes'), operation = readdirSync(folder)[0];
  writeFileSync(join(folder, operation, 'next.utf8'), 'tampered bytes');
  const replay = await c.call('task_file_write', { path: 'src/new.txt', content: 'valid text' });
  assert.equal(decode(replay).code, 'STATE_UNCERTAIN');
  assert.equal(readFileSync(join(root, 'src/new.txt'), 'utf8'), 'valid text');
});

test('read scope and readonly roles cannot be widened by mutating the caller binding', async t => {
  const root = project(t), actor = binding('review', { read_paths: ['docs'] });
  const c = await connect(t, root, actor);
  actor.read_paths.push('src'); actor.stage = 'implementation'; actor.role = 'developer';
  assert.equal((await c.call('project_read', { path: 'src/value.mjs' })).isError, true);
  assert.deepEqual(decode(await c.call('project_list')).files, []);
  const tools = (await c.client.listTools()).tools;
  assert.ok(!tools.some(item => item.name === 'task_file_write' || item.name === 'check_run'));
});

test('authoritative binding prevents calls after cancellation and callback errors do not leak credentials', async t => {
  let active = true;
  const c = await connect(t, project(t), binding(), { assertActive() { if (!active) throw new Error('secret-token-in-private-error'); } });
  active = false;
  const result = await c.call('task_file_write', { path: 'src/new.txt', content: 'never write' });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-token-in-private-error/);
});

test('a writable filesystem link cannot redirect the scoped producer', async t => {
  const root = project(t), external = mkdtempSync(join(tmpdir(), 'neomind-controlled-outside-'));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(join(external, 'outside.txt'), 'original');
  try { symlinkSync(external, join(root, 'src/link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows link privilege unavailable'); return; } throw error; }
  const c = await connect(t, root);
  assert.equal((await c.call('task_file_write', { path: 'src/link/outside.txt', content: 'overwrite' })).isError, true);
  assert.equal(readFileSync(join(external, 'outside.txt'), 'utf8'), 'original');
});
