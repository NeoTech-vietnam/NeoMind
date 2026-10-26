import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer, controlledPlanSchema } from '../dist/controlled-tools.js';
import { controlledPlanRequestSchemas, controlledPlanSubmissionExample, controlledPlanSubmissionGuide } from '../dist/controlled-plan-request.js';
import { controlledResultFailure } from '../dist/controlled-observability.js';

const defaults = { title: 'Saved bounded Cornell request', objective: 'Create the requested professional Cornell bundle from the complete saved requirement.' };
function actualRequest() {
  // Sanitized professional shape captured from actual Local0153. Runtime
  // identity and credentials never appear in this request.
  return { intent: 'cornell-export', title: 'Bounded prepared Cornell bundle', risk: 'low',
    summary: 'Use the existing prepared research and independently reject an incorrect example.',
    cornell_input_path: 'src/prepared-cornell.json', cornell_output_dir: 'docs/cornell',
    outputs: ['docs/cornell/note.md', 'docs/cornell/exercises.md', 'docs/cornell/answers.md'],
    allowed_paths: ['docs/cornell'], verification_paths: ['checks'], input_paths: [], preservation_paths: [], execution_steps: [],
    implementation_instructions: ['Compile the exact prepared source.', 'Keep the worked example text: literal \\n stays literal.'],
    verification_instructions: ['Inspect all three outputs and exercise the failing example.'],
    acceptance_criteria: ['The Cornell bundle preserves the supplied professional research.'],
    checks: [{ name: 'Independent Cornell check', argv: ['node', 'checks/check.cjs', 'docs/cornell'], expected_exit_code: 0, baseline_paths: [] }],
    negative_controls: [{ name: 'Reject incorrect worked example', argv: ['node', 'checks/check.cjs', 'docs/cornell', '--negative-control', 'wrong-example'],
      expected_exit_code: 1, baseline_paths: [], fixture_description: 'The same checker must reject a deliberately incorrect worked example.' }] };
}
async function fixture(t, planDefaults = defaults) {
  const root = mkdtempSync(join(tmpdir(), 'neomind-plan-request-'));
  for (const folder of ['src', 'docs', 'checks']) mkdirSync(join(root, folder));
  writeFileSync(join(root, 'src/prepared-cornell.json'), JSON.stringify({ topic: 'Prepared professional research' }));
  const captured = [], traces = [];
  const server = createControlledMcpServer(root, { workflow_id: 'BOUND-REQUEST-WORKFLOW', invocation_id: 'BOUND-REQUEST-PLANNER',
    stage: 'planning', role: 'manager', implementation_paths: [], verification_paths: [], read_paths: ['.'],
    ...(planDefaults === undefined ? {} : { plan_defaults: planDefaults }) }, {
    assertActive() {}, saveReport() { throw new Error('No report calls expected.'); },
    submitPlan(value, source) { captured.push({ value, source }); return { saved: true }; }, trace(event) { traces.push(event); },
  });
  const client = new Client({ name: 'actual-plan-request-boundary', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, captured, traces, client, call: (input) => client.callTool({ name: 'workflow_plan', arguments: input }) };
}
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual Local0153 plan shape reaches canonical backend in one MCP call without model identity assembly', async t => {
  const f = await fixture(t), input = actualRequest(), before = JSON.stringify(input);
  const result = await f.call(input);
  assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(f.captured.length, 1);
  assert.equal(JSON.stringify(input), before, 'The caller request remains unchanged.');
  const normalized = f.captured[0].value;
  assert.deepEqual(normalized, controlledPlanSchema.parse(normalized));
  assert.equal(normalized.title, input.title); assert.equal(normalized.objective, defaults.objective);
  assert.ok(normalized.rationale.startsWith(input.summary)); assert.ok(normalized.rationale.includes(`Intent: ${input.intent}`));
  for (const text of [...input.implementation_instructions, ...input.verification_instructions, input.negative_controls[0].fixture_description])
    assert.ok(normalized.rationale.includes(text), 'Professional instructions and fixture descriptions are retained verbatim.');
  assert.deepEqual(normalized.allowed_paths, input.allowed_paths); assert.deepEqual(normalized.verification_paths, input.verification_paths);
  assert.deepEqual(normalized.outputs, input.outputs); assert.deepEqual(normalized.execution_steps, []);
  assert.equal(normalized.cornell_input_path, input.cornell_input_path);
  assert.equal(normalized.checks[0].title, input.checks[0].name); assert.deepEqual(normalized.checks[0].command, input.checks[0].argv);
  assert.deepEqual(normalized.checks[0].negative_controls[0], { title: input.negative_controls[0].name,
    command: input.negative_controls[0].argv, expected_exit_code: 1, baseline_paths: [] });
  for (const alias of ['intent', 'summary', 'implementation_instructions', 'verification_instructions', 'negative_controls'])
    assert.equal(Object.hasOwn(normalized, alias), false);
  const requestTrace = f.traces.find(event => event.event === 'tool-request' && event.tool === 'workflow_plan');
  const backendTrace = f.traces.find(event => event.event === 'payload-resolved');
  assert.deepEqual(requestTrace.model_input.semantic, input, 'The model request trace preserves raw professional field spellings.');
  assert.deepEqual(backendTrace.backend_input.semantic, normalized, 'The backend request is traced separately after canonical normalization.');
  assert.equal(requestTrace.model_input.input_sha256, bytesHash(Buffer.from(JSON.stringify(requestTrace.model_input.semantic))));
  assert.equal(backendTrace.backend_input.input_sha256, bytesHash(Buffer.from(JSON.stringify(normalized))));
  assert.notEqual(requestTrace.model_input.input_sha256, backendTrace.backend_input.input_sha256);
  assert.equal(backendTrace.source, null);
  assert.equal(existsSync(join(f.root, 'docs/cornell')), false, 'Submitting semantic input cannot write product files.');
});

test('actual MCP advertises canonical types and only backend-supplied duplicate metadata becomes optional', async t => {
  const f = await fixture(t), schema = (await f.client.listTools()).tools.find(tool => tool.name === 'workflow_plan').inputSchema;
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.objective.type, 'string'); assert.equal(schema.properties.checks.items.properties.command.type, 'array');
  const inline = schema.anyOf.find(branch => !branch.required.includes('input_path'));
  assert.equal(inline.required.includes('objective'), false); assert.equal(inline.required.includes('title'), false);
  assert.ok(inline.required.includes('rationale')); assert.ok(inline.required.includes('checks'));
  for (const alias of ['intent', 'summary', 'implementation_instructions', 'verification_instructions', 'negative_controls'])
    assert.equal(Object.hasOwn(schema.properties, alias), false, 'Compatibility aliases do not replace the documented canonical interface.');
  assert.deepEqual(schema.properties.checks.items.required, ['title', 'command', 'negative_controls']);
  assert.equal(Object.hasOwn(schema.properties.checks.items.properties, 'name'), false);
  const canonical = controlledPlanRequestSchemas(controlledPlanSchema);
  const advertised = (await import('zod')).z.toJSONSchema(canonical.schema, { io: 'input' });
  assert.ok(advertised.required.includes('title')); assert.ok(advertised.required.includes('objective'));
});

test('actual MCP advertises a backend-generated canonical plan example and accepts it without protocol assembly', async t => {
  const f = await fixture(t), metadata = (await f.client.listTools()).tools.find(tool => tool.name === 'workflow_plan');
  const example = controlledPlanSubmissionExample(), before = JSON.stringify(example);
  const guide = controlledPlanSubmissionGuide(controlledPlanSchema);
  assert.ok(metadata.description.includes(guide));
  assert.deepEqual(controlledPlanSchema.parse(example).execution_steps[0].command, ['node', 'scripts/example-producer/generate.cjs']);
  const execution = metadata.inputSchema.properties.execution_steps.items;
  assert.ok(execution.required.includes('title')); assert.ok(execution.required.includes('command')); assert.ok(execution.required.includes('output_paths'));
  assert.equal(execution.required.includes('input_paths'), false);
  assert.match(execution.properties.command.description, /input_path.*stdin/);
  assert.match(execution.properties.output_paths.description, /exact new producer-created files/);
  assert.ok(guide.includes('task_run({"title":"Generate the prepared result","input_path":"inputs/example.json"})'));
  assert.match(guide, /original file whitespace is not promised on stdin/);
  assert.match(guide, /node -e\/--eval wrapper/);
  const result = await f.call(example);
  assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(f.captured.length, 1);
  assert.deepEqual(f.captured[0].value, controlledPlanSchema.parse(example));
  assert.equal(JSON.stringify(example), before); assert.equal(existsSync(join(f.root, 'scripts/example-producer')), false);
  assert.doesNotMatch(before, /workflow_id|task_id|invocation_id|claim_token|credential|verdict/);
});

test('actual captured producer-ingress mistakes return actionable canonical field paths without guessing missing declarations', async t => {
  const f = await fixture(t), input = controlledPlanSubmissionExample();
  input.execution_steps = [{ argv: ['node', 'scripts/example-producer/generate.cjs'], stdin_path: 'inputs/example.json',
    expected_exit_code: 0, baseline_paths: ['inputs/example.json'] }];
  const result = await f.call(input);
  assert.equal(result.isError, true); assert.equal(f.captured.length, 0);
  const diagnostic = controlledResultFailure(result); assert.equal(diagnostic.code, 'SCHEMA_INVALID');
  for (const field of ['title', 'command', 'output_paths'])
    assert.ok(diagnostic.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['execution_steps', 0, field])), `Canonical ${field} is visible in the actual SDK diagnostic.`);
  assert.equal(existsSync(join(f.root, 'scripts/example-producer')), false);
});

test('bound defaults do not overwrite professional values and missing rationale is never invented', async t => {
  const f = await fixture(t), input = actualRequest();
  input.objective = 'An explicitly supplied, narrower professional objective.';
  input.rationale = input.summary;
  assert.equal((await f.call(input)).isError, undefined);
  assert.equal(f.captured[0].value.objective, input.objective); assert.equal(f.captured[0].value.title, input.title);
  const bad = actualRequest(); delete bad.summary; delete bad.checks[0].name; delete bad.negative_controls;
  const { schema } = controlledPlanRequestSchemas(controlledPlanSchema, defaults), parsed = schema.safeParse(bad);
  assert.equal(parsed.success, false);
  const paths = parsed.error.issues.map(issue => issue.path.join('.'));
  for (const expected of ['rationale', 'checks.0.title', 'checks.0.negative_controls']) assert.ok(paths.includes(expected), `All independent canonical errors are reported: ${expected}`);
  assert.equal((await f.call(bad)).isError, true); assert.equal(f.captured.length, 1);
  const blank = actualRequest(); delete blank.summary; blank.rationale = '   ';
  assert.equal((await f.call(blank)).isError, true, 'Compatibility notes cannot turn a blank professional rationale into approval.');
  assert.equal(f.captured.length, 1);
});

test('ambiguous controls, conflicting aliases and undeclared runtime fields fail before any plan side effect', async t => {
  const f = await fixture(t), cases = [];
  let bad = actualRequest(); bad.checks.push({ ...bad.checks[0], name: 'Another positive check' }); cases.push(bad);
  bad = actualRequest(); bad.negative_controls[0].argv = ['node', 'checks/other.cjs', '--negative']; cases.push(bad);
  bad = actualRequest(); bad.rationale = 'Different rationale that cannot replace the supplied summary.'; cases.push(bad);
  bad = actualRequest(); bad.checks[0].title = 'Conflicting check title'; cases.push(bad);
  bad = actualRequest(); bad.checks[0].command = ['node', 'checks/different.cjs']; cases.push(bad);
  bad = actualRequest(); bad.checks[0].negative_controls = [{ title: bad.negative_controls[0].name,
    command: [...bad.negative_controls[0].argv, '--different'], expected_exit_code: 1 }]; cases.push(bad);
  for (const extra of [{ workflow_id: 'invented' }, { invocation_id: 'invented' }, { cornell_input_sha256: 'f'.repeat(64) },
    { plan_defaults: defaults }, { arbitrary_operation: 'invented' }]) cases.push({ ...actualRequest(), ...extra });
  for (const value of cases) assert.equal((await f.call(value)).isError, true, JSON.stringify(value));
  assert.equal(f.captured.length, 0);
  assert.equal(existsSync(join(f.root, '.neomind/controlled/workflows')), false);
  assert.equal(existsSync(join(f.root, 'docs/cornell')), false);
});

test('top-level controls match the exact unique checker and exact nested duplicates remain one obligation', async t => {
  const f = await fixture(t), input = actualRequest();
  input.checks.push({ title: 'A distinct checker', command: ['node', 'checks/second.cjs'], negative_controls: [
    { title: 'Second checker rejects invalid input', command: ['node', 'checks/second.cjs', '--negative'], expected_exit_code: 1 },
  ] });
  input.checks[0].negative_controls = [{ title: input.negative_controls[0].name, command: input.negative_controls[0].argv,
    baseline_paths: [], expected_exit_code: 1 }];
  input.negative_controls.push({ baseline_paths: [], expected_exit_code: 1, command: input.negative_controls[0].argv,
    title: input.negative_controls[0].name });
  assert.notDeepEqual(Object.keys(input.checks[0].negative_controls[0]), Object.keys(input.negative_controls[1]),
    'Identical obligations with different object key order are a deliberate regression case.');
  assert.equal((await f.call(input)).isError, undefined);
  assert.equal(f.captured[0].value.checks[0].negative_controls.length, 1);
  assert.equal(f.captured[0].value.checks[1].negative_controls.length, 1);
});

test('prepared alias JSON uses exact source bytes, exclusive file input and stale-read protection at actual MCP boundary', async t => {
  const f = await fixture(t), raw = actualRequest(), path = 'src/prepared-plan.json';
  const bytes = `${JSON.stringify(raw, null, 2)}\n`; writeFileSync(join(f.root, path), bytes);
  assert.equal((await f.call({ input_path: path })).isError, undefined);
  assert.equal(f.captured.length, 1); assert.equal(f.captured[0].source.path, path);
  assert.equal(f.captured[0].source.sha256, bytesHash(Buffer.from(bytes)));
  assert.equal(f.captured[0].source.size_bytes, Buffer.byteLength(bytes));
  assert.equal(f.captured[0].value.objective, defaults.objective);
  assert.ok(f.captured[0].value.rationale.includes(raw.implementation_instructions[1]));
  assert.equal(readFileSync(join(f.root, path), 'utf8'), bytes, 'Compatibility normalization never rewrites prepared source bytes.');
  for (const override of [{ title: 'Override' }, { summary: 'Override' }, { intent: 'Override' }])
    assert.equal((await f.call({ input_path: path, ...override })).isError, true);
  assert.equal(f.captured.length, 1);
  writeFileSync(join(f.root, path), `${bytes}\n`);
  assert.equal((await f.call({ input_path: path })).isError, true, 'A changed source cannot reuse an old read observation.');
  assert.equal(f.captured.length, 1);
  const invalidPath = 'src/invalid-plan.json'; writeFileSync(join(f.root, invalidPath), JSON.stringify({ ...raw, claim_token: 'not-accepted' }));
  assert.equal((await f.call({ input_path: invalidPath })).isError, true); assert.equal(f.captured.length, 1);
});
