import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initialize } from '../dist/storage.js';
import { createControlledMcpServer, controlledInstructions, controlledToolNames } from '../dist/controlled-tools.js';
import { researchFixture } from './cornell-research-fixture.mjs';

const decode = result => JSON.parse(result.content[0].text);

test('worker guide is served from trusted runtime documentation without reading a poisoned private project file', async t => {
  const root = project(t);
  mkdirSync(join(root, '.neomind/guides'), { recursive: true });
  writeFileSync(join(root, '.neomind/guides/controlled-workflows.md'), 'PRIVATE_PROJECT_GUIDE_CANARY');
  const c = await connect(t, root);
  const guide = decode(await c.call('project_read', { path: '.neomind/guides/controlled-workflows.md' }));
  assert.equal(guide.source, 'trusted-installed-runtime'); assert.equal(guide.project_private_file_read, false);
  assert.match(guide.text, /Backend-owned session/); assert.doesNotMatch(guide.text, /PRIVATE_PROJECT_GUIDE_CANARY/);
  const privateFile = await c.call('project_read', { path: '.neomind/config.json' });
  assert.equal(privateFile.isError, true); assert.equal(decode(privateFile).code, 'PRIVATE_PATH');
});

test('planning can inspect exact skill assets before declaring readonly downstream inputs, while private client files remain denied', async t => {
  const root = project(t); mkdirSync(join(root, '.agents/skills/example/assets'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/example/assets/template.md'), '# Canonical readonly template');
  const c = await connect(t, root, binding('planning'));
  assert.match(decode(await c.call('project_read', { path: '.agents/skills/example/assets/template.md' })).text, /Canonical/);
  assert.equal((await c.call('project_read', { path: '.codex/config.toml' })).isError, true);
});

test('declared producer execution exposes only a step title and professional JSON input, never model-selected argv or identity', async t => {
  const root = project(t), executed = [];
  const step = { title: 'Generate output', command: ['node', 'src/value.mjs'], input_paths: [], output_paths: ['docs/generated.md'] };
  const c = await connect(t, root, binding('implementation', { execution_steps: [step], procedure_bound: false }), {
    runTask(input) { executed.push(input); return { passed: true }; },
  });
  const tools = (await c.client.listTools()).tools, operation = tools.find(tool => tool.name === 'task_run');
  assert.deepEqual(Object.keys(operation.inputSchema.properties).sort(), ['input', 'title']);
  assert.ok(!tools.some(tool => tool.name === 'procedure_run'));
  await c.call('project_read', { path: 'src/value.mjs' });
  assert.equal((await c.call('task_run', { title: step.title, input: { message: 'prepared content' } })).isError, undefined);
  assert.deepEqual(executed, [{ ...step, input: { message: 'prepared content' } }]);
  assert.equal((await c.call('task_run', { title: step.title, command: ['node','elsewhere.mjs'] })).isError, true);
  assert.equal(executed.length, 1);
});
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
  for (const stage of ['planning', 'implementation', 'verification', 'review', 'diagnosis', 'synthesis']) {
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

test('final synthesis can read bound execution evidence and compile notes without receiving source-write tools', async t => {
  const observed = [], root = project(t), c = await connect(t, root, binding('synthesis'), {
    readEvidence(title) { observed.push(title); return [{ title: 'Independent check', exit_code: 0, stdout: 'actual bounded output' }]; },
  });
  const names = (await c.client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('cornell_research_compile')); assert.ok(names.includes('check_evidence'));
  assert.equal(names.includes('task_file_write'), false); assert.equal(names.includes('check_run'), false);
  assert.equal(decode(await c.call('check_evidence', { title: 'Independent check' }))[0].exit_code, 0);
  assert.deepEqual(observed, ['Independent check']);
});

test('controlled Cornell sources advertise only semantic citations and strip only cached provenance fields', async t => {
  const { root, input } = researchFixture(t), captured = [], c = await connect(t, root, binding('synthesis'), {
    compileResearch(value) { captured.push(value); return { saved: true }; },
  });
  const declared = (await c.client.listTools()).tools.find(tool => tool.name === 'cornell_research_compile').inputSchema;
  assert.deepEqual(Object.keys(declared.properties.sources.items.properties).sort(), ['id', 'locator', 'title', 'uri']);
  const { requirement_id, expected_requirement_revision, workflow_id, task_id, owner, output_dir, ...semantic } = input;
  semantic.sources = [{ id: 'S1', title: 'Actual README provenance', uri: 'scripts/README-leetcode.md',
    record_id: 'invented-description', sha256: '0'.repeat(64), retrieved_at: 'invented timestamp' }];
  const response = await c.call('cornell_research_compile', semantic);
  assert.equal(response.isError, undefined);
  assert.deepEqual(captured[0].sources, [{ id: 'S1', title: 'Actual README provenance', uri: 'scripts/README-leetcode.md' }]);
  const unknown = await c.call('cornell_research_compile', { ...semantic,
    sources: [{ ...semantic.sources[0], unsupported_source_field: true }] });
  assert.equal(unknown.isError, true);
  assert.equal(captured.length, 1, 'Only the three obsolete provenance fields may be discarded.');
});

test('controlled Cornell practice and demonstrations hide backend paths, evidence identities and schema version', async t => {
  const { root, input } = researchFixture(t), captured = [], c = await connect(t, root, binding('synthesis'), {
    compileResearch(value) { captured.push(value); return { saved: true }; },
  });
  const declared = (await c.client.listTools()).tools.find(tool => tool.name === 'cornell_research_compile').inputSchema;
  for (const option of declared.properties.practice.anyOf) {
    assert.equal('solution_path' in option.properties, false);
    assert.ok('starter' in option.properties);
  }
  assert.equal('evidence_ids' in declared.properties.worked_example.properties, false);
  assert.match(declared.properties.worked_example.properties.observed.description, /Omit this field until.*passing independent check/);
  assert.match(declared.properties.methods.description, /inline \[S1\]/);
  assert.equal(declared.required.includes('schema_version'), false);
  const { requirement_id, expected_requirement_revision, workflow_id, task_id, owner, output_dir, ...semantic } = input;
  for (const solution_path of ['answers.md', '../outside.md', '.neomind/config.json', 'C:/outside.md']) {
    const response = await c.call('cornell_research_compile', { ...semantic, schema_version: 999,
      practice: { ...semantic.practice, solution_path, starter: '# Learner reasoning\nKeep the worked steps separate.\n' },
      worked_example: { ...semantic.worked_example, evidence_ids: ['invented-evidence-id'] } });
    assert.equal(response.isError, undefined);
    const value = captured.at(-1);
    assert.equal(value.schema_version, 1);
    assert.equal(value.practice.solution_path, undefined);
    assert.equal(value.worked_example.evidence_ids, undefined);
    assert.equal(value.practice.starter, '# Learner reasoning\nKeep the worked steps separate.\n');
    assert.deepEqual(value.practice.procedure, semantic.practice.procedure);
  }
  const unsupported = await c.call('cornell_research_compile', { ...semantic,
    practice: { ...semantic.practice, invented_path: '../outside.md' } });
  assert.equal(unsupported.isError, true);
  assert.equal(captured.length, 4, 'Cached metadata stripping must not discard arbitrary unknown properties.');
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

test('review purpose is backend-bound and cannot be selected through a worker report or tool schema', async t => {
  const actor = binding('review', { review_purpose: 'checker-readiness' });
  const c = await connect(t, project(t), actor), tools = (await c.client.listTools()).tools;
  assert.match(controlledInstructions(actor), /Review purpose: checker-readiness/);
  assert.match(controlledInstructions(actor), /including any generator or product code the planned commands execute/);
  for (const tool of tools) assert.equal('review_purpose' in tool.inputSchema.properties, false, tool.name);
  const response = await c.call('assignment_report', { outcome: 'completed', summary: 'Attempted scope change.',
    verdict: 'pass', review_purpose: 'final-product' });
  assert.equal(response.isError, true);
  assert.equal(c.reports.length, 0);
  assert.match(controlledInstructions(binding('review')), /Review purpose: final-product/);
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

test('literal search accepts a file path and retains directory search and match limits', async t => {
  const root = project(t), c = await connect(t, root);
  writeFileSync(join(root, 'src/main.mjs'), 'async function main() {\n  const marker = "main()";\n  return marker;\n}\n');
  const file = await c.call('project_search', { query: 'async function main()', path: 'src/main.mjs', max_matches: 5 });
  assert.equal(file.isError, undefined, JSON.stringify(file));
  assert.deepEqual(decode(file), { matches: [{ path: 'src/main.mjs', line: 1, text: 'async function main() {' }], truncated: false });
  const tree = decode(await c.call('project_search', { query: 'async function main()', path: 'src', max_matches: 5 }));
  assert.deepEqual(tree, decode(file));
  const limited = decode(await c.call('project_search', { query: 'marker', path: 'src/main.mjs', max_matches: 1 }));
  assert.equal(limited.matches.length, 1); assert.equal(limited.matches[0].line, 2); assert.equal(limited.truncated, true);
});

test('file-path search still refuses private, out-of-scope, oversized and linked inputs', async t => {
  const root = project(t), c = await connect(t, root);
  writeFileSync(join(root, '.env'), 'PRIVATE_SEARCH_CREDENTIAL');
  const privateFile = await c.call('project_search', { query: 'PRIVATE_SEARCH', path: '.env' });
  assert.equal(privateFile.isError, true); assert.equal(decode(privateFile).code, 'PRIVATE_PATH');
  assert.doesNotMatch(JSON.stringify(privateFile), /PRIVATE_SEARCH_CREDENTIAL/);
  const scoped = await connect(t, root, binding('review', { read_paths: ['docs'] }));
  assert.equal(decode(await scoped.call('project_search', { query: 'value', path: 'src/value.mjs' })).code, 'SCOPE_DENIED');
  writeFileSync(join(root, 'src/oversized.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  assert.equal(decode(await c.call('project_search', { query: 'A', path: 'src/oversized.txt' })).code, 'INVALID_FILE');
  linkSync(join(root, 'src/value.mjs'), join(root, 'src/value-alias.mjs'));
  assert.equal(decode(await c.call('project_search', { query: 'value', path: 'src/value-alias.mjs' })).code, 'INVALID_FILE');
  try { symlinkSync(join(root, 'docs'), join(root, 'src/link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Windows junction privilege unavailable; other path guards were checked.'); return; } throw error; }
  writeFileSync(join(root, 'docs/linked.txt'), 'LINK_TARGET_CONTENT');
  const linked = await c.call('project_search', { query: 'LINK_TARGET', path: 'src/link/linked.txt' });
  assert.equal(linked.isError, true); assert.doesNotMatch(JSON.stringify(linked), /LINK_TARGET_CONTENT/);
});

test('role briefs and denied writes name the actual file owner and expected handoff without changing reports', async t => {
  const root = project(t);
  for (const stage of ['implementation', 'verification', 'review']) {
    const actor = binding(stage), instructions = controlledInstructions(actor);
    const declared = JSON.parse(instructions.split('\n')[0].slice('Authoritative role ownership: '.length));
    assert.deepEqual(declared.your_writable_paths, stage === 'implementation' ? ['src', 'docs'] : stage === 'verification' ? ['checks'] : []);
    assert.equal(declared.implementation.owner, 'developer'); assert.equal(declared.verification.owner, 'verifier');
  }
  const producer = await connect(t, root);
  const deniedChecker = decode(await producer.call('task_file_write', { path: 'checks/new.mjs', content: 'another role owns this' }));
  assert.equal(deniedChecker.code, 'SCOPE_DENIED'); assert.equal(deniedChecker.target_owner, 'verifier');
  assert.equal(deniedChecker.rule, 'ROLE_HANDOFF_REQUIRED'); assert.equal(deniedChecker.target_path, 'checks/new.mjs');
  const handoffTrace = producer.events.find(event => event.event === 'tool-result' && event.rule === 'ROLE_HANDOFF_REQUIRED');
  assert.equal(handoffTrace.target_owner, 'verifier'); assert.equal(handoffTrace.target_path, 'checks/new.mjs');
  assert.equal(handoffTrace.backend_binding.invocation_id, binding().invocation_id);
  assert.match(handoffTrace.request_sha256, /^[a-f0-9]{64}$/);
  assert.match(deniedChecker.next_action, /expected.*independent Verifier/);
  assert.equal(existsSync(join(root, 'checks/new.mjs')), false);
  const blocked = { outcome: 'blocked', summary: 'A genuine implementation dependency is unavailable.', failure_kind: 'environment' };
  await producer.call('assignment_report', blocked); assert.deepEqual(producer.reports, [blocked]);
  const verifier = await connect(t, root, binding('verification'));
  const deniedProduct = decode(await verifier.call('task_file_write', { path: 'src/value.mjs', content: 'must not overwrite product' }));
  assert.equal(deniedProduct.target_owner, 'developer'); assert.match(deniedProduct.next_action, /failure_kind implementation/);
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'export const value = 1;\n');
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
