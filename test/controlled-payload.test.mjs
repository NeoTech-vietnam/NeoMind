import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync, readdirSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createControlledMcpServer, controlledPlanSchema, controlledReportSchema } from '../dist/controlled-tools.js';
import { controlledCornellResearchSchema } from '../dist/controlled-cornell-sources.js';
import { researchFixture } from './cornell-research-fixture.mjs';
import { resolveControlledPayload, assertControlledPayloadCurrent, controlledPayloadSchema, CONTROLLED_PAYLOAD_MAX_BYTES } from '../dist/controlled-payload.js';

function payloadFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-payload-'));
  mkdirSync(join(root, 'inputs'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reads = new Map(), recorded = [];
  const options = { sourceAllowed: path => path.startsWith('inputs/'), readHash: path => reads.get(path),
    recordRead(path, digest) { reads.set(path, digest); recorded.push({ path, digest }); }, parse: value => value };
  return { root, options, reads, recorded, write(path, value) { writeFileSync(join(root, path), JSON.stringify(value)); } };
}
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => error?.code === code;
function assertPayloadBranches(advertised, required, fields) {
  assert.equal(advertised.type, 'object'); assert.equal(advertised.additionalProperties, false);
  assert.equal(advertised.anyOf.length, 2);
  const [file, inline] = advertised.anyOf;
  assert.deepEqual(file.required, ['input_path']);
  assert.deepEqual(file.not.anyOf.map(branch => branch.required[0]).sort(), [...fields].sort());
  assert.deepEqual(inline.required, required);
  assert.deepEqual(inline.not, { required: ['input_path'] });
}

async function payloadClient(t, stage, callbacks = {}, binding = {}) {
  const fixture = researchFixture(t), { root, workflow } = fixture;
  for (const directory of ['scripts', 'docs', 'src', 'checks']) mkdirSync(join(root, directory), { recursive: true });
  const server = createControlledMcpServer(root, {
    workflow_id: workflow.meta.id, task_id: 'CORNELL-TASK-0001', invocation_id: `prepared-${stage}`,
    role: stage === 'planning' ? 'manager' : 'developer', stage,
    implementation_paths: ['docs', 'src'], verification_paths: ['checks'], read_paths: ['.'],
    procedure_bound: false, execution_steps: [], ...binding,
  }, { assertActive() {}, saveReport() { return { saved: true }; }, ...callbacks });
  const client = new Client({ name: `prepared-${stage}-mcp-test`, version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { ...fixture, client, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

const proposedPlan = () => ({ title: 'Count finite ordered pairs', objective: 'Deliver a bounded finite pair counter.',
  rationale: 'Use an exact finite example and independent negative controls.', acceptance_criteria: ['The counter returns six for three by two.'],
  allowed_paths: ['src'], verification_paths: ['checks'], outputs: ['src/pairs.mjs'],
  checks: [{ title: 'Independent pair check', command: ['node', 'checks/pairs.mjs'], negative_controls: [
    { title: 'Reject an incorrect count', command: ['node', 'checks/pairs.mjs', '--negative'], expected_exit_code: 1 },
  ] }] });

test('planning and assignment-report MCP boundaries consume prepared JSON and retain backend source identity', async t => {
  const plans = [], reports = [], c = await payloadClient(t, 'planning', {
    submitPlan(value, source) { plans.push({ value, source }); return { saved: true }; },
    saveReport(value, source) { reports.push({ value, source }); return { saved: true }; },
  });
  const plan = proposedPlan(), report = { outcome: 'completed', summary: 'Finite pair plan is ready for independent implementation.' };
  const declared = (await c.client.listTools()).tools;
  for (const [name, schema] of [['workflow_plan', controlledPlanSchema], ['assignment_report', controlledReportSchema]]) {
    const actual = declared.find(tool => tool.name === name).inputSchema;
    assertPayloadBranches(actual, z.toJSONSchema(schema, { io: 'input' }).required ?? [], Object.keys(schema.shape));
    assert.equal(actual.properties.summary?.type ?? actual.properties.title?.type, 'string');
  }
  const checkSchema = declared.find(tool => tool.name === 'workflow_plan').inputSchema.properties.checks.items;
  assert.equal(checkSchema.required.includes('baseline_paths'), false, 'Defaulted checker baselines remain optional input.');
  assert.ok(checkSchema.required.includes('command')); assert.ok(checkSchema.required.includes('negative_controls'));
  assert.equal(checkSchema.properties.baseline_paths.type, 'array');
  assert.equal(checkSchema.properties.baseline_paths.items.type, 'string');
  const negativeSchema = checkSchema.properties.negative_controls.items;
  assert.equal(negativeSchema.required.includes('baseline_paths'), false, 'Nested negative-control defaults remain optional input.');
  assert.ok(negativeSchema.required.includes('expected_exit_code'));
  assert.equal(negativeSchema.properties.baseline_paths.type, 'array');
  writeFileSync(join(c.root, 'scripts/plan.json'), JSON.stringify(plan));
  writeFileSync(join(c.root, 'scripts/report.json'), JSON.stringify(report));
  assert.equal((await c.call('workflow_plan', { input_path: 'scripts/plan.json' })).isError, undefined);
  assert.equal((await c.call('assignment_report', { input_path: 'scripts/report.json' })).isError, undefined);
  assert.deepEqual(plans[0].value, controlledPlanSchema.parse(plan));
  assert.deepEqual(reports[0].value, controlledReportSchema.parse(report));
  assert.equal(plans[0].source.path, 'scripts/plan.json');
  assert.equal(reports[0].source.path, 'scripts/report.json');
  assert.equal(plans[0].source.sha256, hashBytes(readFileSync(join(c.root, 'scripts/plan.json'))));
  assert.equal((await c.call('workflow_plan', { input_path: 'scripts/plan.json', title: 'Mixed override' })).isError, true);
  assert.equal((await c.call('assignment_report', { input_path: 'scripts/report.json', outcome: 'failed' })).isError, true);
  assert.equal(plans.length, 1); assert.equal(reports.length, 1);
});

test('prepared MCP data cannot bypass private, malformed, scope or saved-read validation', async t => {
  const plans = [], c = await payloadClient(t, 'planning', { submitPlan(value) { plans.push(value); return { saved: true }; } },
    { read_paths: ['scripts'] });
  const plan = proposedPlan();
  writeFileSync(join(c.root, 'scripts/plan.json'), JSON.stringify(plan));
  assert.equal((await c.call('project_read', { path: 'scripts/plan.json' })).isError, undefined);
  writeFileSync(join(c.root, 'scripts/plan.json'), JSON.stringify({ ...plan, objective: 'A legitimate user changed this objective.' }));
  const stale = await c.call('workflow_plan', { input_path: 'scripts/plan.json' });
  assert.equal(stale.isError, true); assert.equal(JSON.parse(stale.content[0].text).code, 'STALE_READ');
  assert.equal(plans.length, 0);
  assert.equal((await c.call('project_read', { path: 'scripts/plan.json' })).isError, undefined);
  assert.equal((await c.call('workflow_plan', { input_path: 'scripts/plan.json' })).isError, undefined);
  assert.equal(plans.length, 1);
  writeFileSync(join(c.root, 'scripts/malformed.json'), '{');
  writeFileSync(join(c.root, 'scripts/array.json'), '[]');
  writeFileSync(join(c.root, 'scripts/incomplete.json'), '{}');
  for (const path of ['.neomind/config.json', '.codex/config.json', 'scripts/../plan.json', 'docs/outside.json',
    'scripts/malformed.json', 'scripts/array.json', 'scripts/incomplete.json'])
    assert.equal((await c.call('workflow_plan', { input_path: path })).isError, true, path);
  assert.equal(plans.length, 1, 'Invalid inputs must not submit a plan.');
});

test('source edits during asynchronous payload tracing cannot commit a stale semantic operation', async t => {
  const submitted = [];
  const c = await payloadClient(t, 'planning', {
    submitPlan(value) { submitted.push(value); return { saved: true }; },
    trace(event) {
      if (event.event === 'payload-resolved') writeFileSync(join(c.root, 'scripts/plan.json'), JSON.stringify({ ...proposedPlan(), title: 'Concurrent user change' }));
    },
  });
  writeFileSync(join(c.root, 'scripts/plan.json'), JSON.stringify(proposedPlan()));
  const result = await c.call('workflow_plan', { input_path: 'scripts/plan.json' });
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).code, 'STALE_READ');
  assert.equal(submitted.length, 0);
  assert.equal(JSON.parse(readFileSync(join(c.root, 'scripts/plan.json'), 'utf8')).title, 'Concurrent user change');
});

test('task_run passes decoded prepared data with private source identity and leaves declaration bookkeeping to the backend', async t => {
  const executed = [], sources = [], input = { body: 'A real paragraph\n\nAnother paragraph', expected_stdout: '{"sum":6}\n' };
  const step = { title: 'Run bounded generator', command: ['node', 'src/generator.mjs'], input_paths: ['scripts/input.json'], output_paths: ['docs/output.md'] };
  const c = await payloadClient(t, 'implementation', { runTask(request, source) { executed.push(request); sources.push(source); return { passed: true }; } }, { execution_steps: [step] });
  writeFileSync(join(c.root, 'src/generator.mjs'), 'console.log("Scoped source inspected before execution.");\n');
  writeFileSync(join(c.root, 'scripts/input.json'), JSON.stringify(input));
  writeFileSync(join(c.root, 'scripts/undeclared.json'), JSON.stringify(input));
  assert.equal((await c.call('project_read', { path: 'src/generator.mjs' })).isError, undefined);
  assert.equal((await c.call('task_run', { title: step.title, input_path: 'scripts/input.json' })).isError, undefined);
  assert.deepEqual(executed, [{ ...step, input }]);
  assert.equal(sources[0].path, 'scripts/input.json');
  assert.equal((await c.call('task_run', { title: step.title, input_path: 'scripts/input.json', input })).isError, true);
  assert.equal((await c.call('task_run', { title: step.title, input_path: 'scripts/undeclared.json' })).isError, undefined);
  assert.deepEqual(executed[1], { ...step, input }, 'The runtime still validates the original declaration before adding its private read baseline.');
  assert.equal(sources[1].path, 'scripts/undeclared.json');
  writeFileSync(join(c.root, 'scripts/input.json'), JSON.stringify({ ...input, body: 'A later user edit.' }));
  const stale = await c.call('task_run', { title: step.title, input_path: 'scripts/input.json' });
  assert.equal(stale.isError, true); assert.equal(JSON.parse(stale.content[0].text).code, 'STALE_READ');
  assert.equal(executed.length, 2);
});

test('advertised payload schema is a strict root object whose prepared-file arm never synthesizes semantic defaults', () => {
  const semantic = z.strictObject({ title: z.string().min(2), format: z.literal(1).default(1),
    entries: z.array(z.string()).default([]), normalized: z.preprocess(() => 'runtime-owned', z.literal('runtime-owned')).default('runtime-owned') });
  const schema = controlledPayloadSchema(semantic), advertised = z.toJSONSchema(schema, { io: 'output' });
  assertPayloadBranches(advertised, ['title'], Object.keys(semantic.shape));
  assert.equal(advertised.properties.title.type, 'string');
  assert.equal(advertised.properties.title.minLength, 2);
  assert.ok(advertised.properties.input_path); assert.ok(advertised.properties.title);
  assert.deepEqual(schema.parse({ input_path: 'inputs/research.json' }), { input_path: 'inputs/research.json' });
  assert.deepEqual(schema.parse({ title: 'Professional title' }), { title: 'Professional title' });
  assert.deepEqual(semantic.parse(schema.parse({ title: 'Professional title' })),
    { title: 'Professional title', format: 1, entries: [], normalized: 'runtime-owned' });
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ title: 23 }).success, false);
  assert.equal(schema.safeParse({ input_path: 'inputs/research.json', title: 'Override' }).success, false);
  assert.equal(schema.safeParse({ input_path: 'inputs/research.json', format: 1 }).success, false);
  assert.equal(schema.safeParse({ input_path: 'inputs/research.json', entries: [] }).success, false);
  assert.equal(schema.safeParse({ input_path: 'inputs/research.json', unknown: 'override' }).success, false);
  assert.throws(() => controlledPayloadSchema(z.strictObject({ input_path: z.string() })), /reserve input_path/);
});

test('actual MCP schema preserves nested optional defaults across objects, array items and union branches', async t => {
  const semantic = z.strictObject({ title: z.string().min(2), configuration: z.strictObject({
    required_name: z.string().min(3), rows: z.array(z.strictObject({ name: z.string(), flags: z.array(z.string()).default([]) })).default([]),
    choice: z.union([z.strictObject({ kind: z.literal('first'), baseline_paths: z.array(z.string()).default([]) }),
      z.strictObject({ kind: z.literal('second'), count: z.number().int().min(0).default(0) })]),
  }) });
  const server = new McpServer({ name: 'nested-prepared-schema-test', version: '1' });
  server.registerTool('nested', { inputSchema: controlledPayloadSchema(semantic) }, () => ({ content: [{ type: 'text', text: '{"saved":true}' }] }));
  const client = new Client({ name: 'nested-prepared-schema-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const advertised = (await client.listTools()).tools[0].inputSchema.properties.configuration;
  assert.deepEqual(advertised.required, ['required_name', 'choice']);
  assert.equal(advertised.properties.required_name.type, 'string'); assert.equal(advertised.properties.required_name.minLength, 3);
  assert.equal(advertised.properties.rows.type, 'array');
  assert.deepEqual(advertised.properties.rows.items.required, ['name']);
  assert.equal(advertised.properties.rows.items.properties.flags.type, 'array');
  for (const branch of advertised.properties.choice.anyOf) assert.deepEqual(branch.required, ['kind']);
  for (const configuration of [{ required_name: 'Real input', choice: { kind: 'first' } },
    { required_name: 'Real input', rows: [{ name: 'Row without defaulted flags' }], choice: { kind: 'second' } }]) {
    assert.equal((await client.callTool({ name: 'nested', arguments: { title: 'Valid semantic input', configuration } })).isError, undefined);
    assert.doesNotThrow(() => semantic.parse({ title: 'Valid semantic input', configuration }));
  }
  assert.equal((await client.callTool({ name: 'nested', arguments: { title: 'Missing real required input', configuration: { choice: { kind: 'first' } } } })).isError, true);
});

test('prepared source preserves decoded Markdown and legitimate JSON example escapes exactly once', t => {
  const f = payloadFixture(t), body = 'Paragraph one\n\n```json\n{"stdout":"ok\\n"}\n```\nParagraph two';
  const original = { body, command: ['node', 'checker.mjs'], nested: { example: '\\n', newline: '\n' } };
  f.write('inputs/research.json', original);
  const bytes = readFileSync(join(f.root, 'inputs/research.json'));
  const result = resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, f.options);
  assert.deepEqual(result.input, original);
  assert.deepEqual(result.source, { path: 'inputs/research.json', sha256: hashBytes(bytes), size_bytes: bytes.length });
  assert.deepEqual(f.recorded, [{ path: 'inputs/research.json', digest: hashBytes(bytes) }]);
  assert.notEqual(result.input.body, JSON.stringify(body).slice(1, -1));
  assertControlledPayloadCurrent(f.root, result.source);
  const replay = resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, f.options);
  assert.deepEqual(replay, result);
});

test('direct semantic object is cloned and never mixed with a source or decoded as serialized JSON', t => {
  const f = payloadFixture(t), input = { body: 'actual\nnewline', escaped: 'literal\\n' };
  const resolved = resolveControlledPayload(f.root, { input }, f.options);
  assert.deepEqual(resolved, { input }); assert.notEqual(resolved.input, input);
  resolved.input.body = 'new content'; assert.equal(input.body, 'actual\nnewline');
  for (const request of [{}, { input, input_path: 'inputs/a.json' }, { input, override: true }, { input: [] },
    { input: null }, { input: 12 }, { input: JSON.stringify(input) }, { input: undefined }])
    assert.throws(() => resolveControlledPayload(f.root, request, f.options), hasCode('INVALID_PAYLOAD'));
  assert.equal(f.recorded.length, 0); assert.deepEqual(readdirSync(join(f.root, 'inputs')), []);
});

test('payload source paths deny private configuration, traversal and out-of-scope sources before any read is recorded', t => {
  const f = payloadFixture(t); let callbacks = 0;
  const options = { ...f.options, sourceAllowed() { callbacks++; return true; } };
  for (const path of ['../outside.json', '/absolute.json', 'C:/absolute.json', 'inputs\\a.json', 'inputs/../a.json',
    'inputs//a.json', 'inputs/./a.json', 'inputs/a.json ', 'inputs/a.md', 'inputs/CON.json', 'inputs/name?.json'])
    assert.throws(() => resolveControlledPayload(f.root, { input_path: path }, options), hasCode('INVALID_PATH'));
  for (const path of ['.neomind/config.json', '.codex/config.json', 'inputs/.vscode/settings.json', 'inputs/.env.json',
    '.agents/skills/any/assets/research.json', 'node_modules/research.json', 'inputs/credentials.json', 'inputs/auth.json'])
    assert.throws(() => resolveControlledPayload(f.root, { input_path: path }, options), hasCode('PRIVATE_PATH'));
  assert.equal(callbacks, 0, 'Invalid/private path syntax must not probe the filesystem or invoke the policy.');
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'docs/outside.json' }, f.options), hasCode('SCOPE_DENIED'));
  assert.equal(f.recorded.length, 0);
});

test('malformed, serialized, non-object, oversized and non-UTF8 source content never reaches the parser or read journal', t => {
  const f = payloadFixture(t); let parsed = 0;
  const options = { ...f.options, parse(value) { parsed++; return value; } };
  for (const content of ['{', '[]', 'null', '42', '"serialized object"', '{"body":"bad\0text"}', Buffer.from([0xff, 0xfe])]) {
    writeFileSync(join(f.root, 'inputs/research.json'), content);
    assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, options), hasCode('INVALID_PAYLOAD'));
  }
  writeFileSync(join(f.root, 'inputs/research.json'), ' '.repeat(CONTROLLED_PAYLOAD_MAX_BYTES + 1));
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, options), hasCode('INVALID_FILE'));
  assert.throws(() => resolveControlledPayload(f.root, { input: { body: 'x'.repeat(CONTROLLED_PAYLOAD_MAX_BYTES) } }, options), hasCode('INVALID_PAYLOAD'));
  mkdirSync(join(f.root, 'inputs/directory.json'));
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/directory.json' }, options), hasCode('INVALID_FILE'));
  assert.equal(parsed, 0); assert.equal(f.recorded.length, 0);
});

test('source edits after project_read or after validation stop the operation without refreshing its saved hash', t => {
  const f = payloadFixture(t); f.write('inputs/research.json', { body: 'first' });
  const previous = hashBytes(readFileSync(join(f.root, 'inputs/research.json')));
  f.reads.set('inputs/research.json', previous);
  f.write('inputs/research.json', { body: 'user changed this' });
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, f.options), hasCode('STALE_READ'));
  assert.equal(f.reads.get('inputs/research.json'), previous); assert.equal(f.recorded.length, 0);
  f.reads.delete('inputs/research.json');
  const loaded = resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, f.options);
  f.write('inputs/research.json', { body: 'second user edit' });
  assert.throws(() => assertControlledPayloadCurrent(f.root, loaded.source), hasCode('STALE_READ'));
  assert.equal(f.reads.get('inputs/research.json'), loaded.source.sha256);
  f.reads.set('inputs/research.json', null);
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, f.options), hasCode('STALE_READ'));
});

test('schema rejection and mutation during parsing leave the source and read history uncommitted', t => {
  const f = payloadFixture(t); f.write('inputs/research.json', { body: 'first' });
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, { ...f.options,
    parse() { throw new Error('Exact professional field is invalid.'); } }), /Exact professional field/);
  assert.equal(f.recorded.length, 0);
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, { ...f.options,
    parse(value) { f.write('inputs/research.json', { body: 'concurrent edit' }); return value; } }), hasCode('STALE_READ'));
  assert.equal(f.recorded.length, 0);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'inputs/research.json'), 'utf8')).body, 'concurrent edit');
});

test('prepared payload rejects linked files, including links to another in-scope file', t => {
  const f = payloadFixture(t); f.write('inputs/research.json', { body: 'ordinary' });
  linkSync(join(f.root, 'inputs/research.json'), join(f.root, 'inputs/hard.json'));
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/hard.json' }, f.options), hasCode('INVALID_FILE'));
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/research.json' }, f.options), hasCode('INVALID_FILE'));
  try { symlinkSync(join(f.root, 'inputs/research.json'), join(f.root, 'inputs/link.json'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('File symlinks unavailable; hardlink cases still executed.'); return; } throw error; }
  assert.throws(() => resolveControlledPayload(f.root, { input_path: 'inputs/link.json' }, f.options), hasCode('INVALID_FILE'));
  assert.equal(f.recorded.length, 0);
});

test('actual Cornell MCP boundary loads prepared JSON without copying its serialized text into Markdown', async t => {
  const { root, input, workflow } = researchFixture(t);
  const { requirement_id, expected_requirement_revision, workflow_id, task_id, owner, output_dir, ...professional } = input;
  professional.explanations[0].body = [
    'First real Markdown paragraph [S1].',
    '',
    '```json',
    JSON.stringify({ cli_examples: [{ input: '[1,2,3]', stdout: '{"sum":6}\n' }] }, null, 2),
    '```',
    '',
    'Second real Markdown paragraph [S1].',
  ].join('\n');
  const expected = controlledCornellResearchSchema(false, false).parse(professional);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/research.json'), JSON.stringify(professional));
  const received = [];
  const server = createControlledMcpServer(root, {
    workflow_id: workflow.meta.id, task_id: 'CORNELL-TASK-0001', invocation_id: 'actual-payload-boundary',
    role: 'developer', stage: 'implementation', implementation_paths: ['docs'], verification_paths: ['checks'],
    read_paths: ['scripts', 'docs'], procedure_bound: false, execution_steps: [], cornell_starter_allowed: false,
  }, { assertActive() {}, saveReport() { return { saved: true }; },
    compileResearch(value) { received.push(value); return { saved: true }; } });
  const client = new Client({ name: 'actual-prepared-json-mcp-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'cornell_research_compile', arguments: { input_path: 'scripts/research.json' } });
  const declared = (await client.listTools()).tools.find(tool => tool.name === 'cornell_research_compile').inputSchema;
  const semanticSchema = controlledCornellResearchSchema(false, false);
  assertPayloadBranches(declared, z.toJSONSchema(semanticSchema, { io: 'input' }).required ?? [], Object.keys(semanticSchema.shape));
  assert.equal(declared.properties.topic.type, 'string');
  assert.equal(declared.properties.explanations.type, 'array');
  assert.equal(declared.properties.explanations.items.properties.body.type, 'string');
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], expected);
  const actual = received[0].explanations[0].body;
  assert.equal(actual, professional.explanations[0].body);
  assert.notEqual(actual, JSON.stringify(professional.explanations[0].body).slice(1, -1));
  assert.ok(actual.includes('\n```json\n'));
  const fenced = actual.match(/```json\n([\s\S]*?)\n```/)[1];
  assert.equal(JSON.parse(fenced).cli_examples[0].stdout, '{"sum":6}\n');
});
