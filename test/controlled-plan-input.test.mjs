import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer, controlledPlanSchema, controlledConsultationRoles } from '../dist/controlled-tools.js';
import { normalizeControlledPlanInput, controlledConsultationRole } from '../dist/controlled-plan-input.js';
import { initialize, atomicWrite, createRecord, loadRecords, hash, safePath } from '../dist/storage.js';
import { prepareControlledCheckEvidence, controlledFingerprints } from '../dist/controlled-acceptance.js';
import { randomUUID } from 'node:crypto';
import { ensureRoutingPolicy } from '../dist/routing.js';
import { enableVSCodeHost } from '../dist/vscode-host.js';
import { shutdownNative } from '../dist/native.js';
import { ownedContext } from '../dist/controlled-context.js';
import { startControlledHost, startControlledWorkflow, controlledStatus } from '../dist/controlled-workflow.js';

function fixture(t) {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-plan-input-')));
  for (const dir of ['src', 'docs', 'checks', '.agents/skills/existing/assets']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'src/value.mjs'), 'existing public source\n');
  writeFileSync(join(root, '.agents/skills/existing/assets/template.md'), '# Existing readonly template\n');
  t.after(() => { assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function plan() {
  return { title: 'Bounded implementation with independent checking', objective: 'Deliver the requested value and documentation.',
    rationale: 'Reuse existing public source and the exact readonly skill template.', acceptance_criteria: ['Outputs are independently correct.'],
    allowed_paths: ['src/value.mjs', 'docs/readme.md'], verification_paths: ['checks'], outputs: ['src/value.mjs', 'docs/readme.md'],
    input_paths: ['src/value.mjs', '.agents/skills/existing/assets/template.md'],
    checks: [{ title: 'Independent check', command: ['node', 'checks/check.mjs', 'src/value.mjs'],
      negative_controls: [{ title: 'Reject invalid fixture', command: ['node', 'checks/check.mjs', 'checks/bad.json'], expected_exit_code: 1 }] }], risk: 'low' };
}

test('actual MCP canonicalizes reported Cornell tool steps, checker ownership and exact hidden input metadata before strict plan submission', async t => {
  const root = fixture(t), directory = 'docs/cornell', prepared = 'src/prepared-cornell.json';
  const bundle = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`);
  const template = '.agents/skills/existing/assets/template.md';
  writeFileSync(join(root, prepared), JSON.stringify({ topic: 'Existing prepared research content' }));
  const captured = [], server = createControlledMcpServer(root, { workflow_id: 'BACKEND-WORKFLOW', invocation_id: 'BOUND-NATIVE-CORNELL-PLAN',
    stage: 'planning', role: 'manager', implementation_paths: [], verification_paths: [] }, {
    assertActive() {}, saveReport() { return { saved: true }; },
    submitPlan(value) { captured.push(normalizeControlledPlanInput(root, value)); return { saved: true }; },
  });
  const client = new Client({ name: 'actual-captured-native-cornell-plan', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a); t.after(async () => { await client.close(); await server.close(); });
  // Sanitized shape from actual Local requests0143/0144: native tools were put
  // into OS execution_steps, verifier artifacts into producer outputs, and an
  // exact skill template into public preservation metadata.
  const source = { ...plan(), allowed_paths: [directory], verification_paths: ['checks'],
    outputs: [...bundle, 'checks/check.mjs', 'checks/bad.json'], documentation_paths: [...bundle],
    cornell_output_dir: directory, input_paths: [], preservation_paths: [prepared, template],
    checks: [{ title: 'Inspect primary Cornell', argv: ['node', 'checks/check.mjs', directory],
      baseline_paths: [template, prepared], negative_controls: [{ title: 'Reject wrong Cornell output',
        argv: ['node', 'checks/check.mjs', 'checks/bad.json'], expected_exit_code: 1 }] }] };
  const variants = [
    { title: 'Compile prepared Cornell from file', tool: 'cornell_research_compile', input_path: prepared,
      parameters: { input_path: prepared }, outputs: bundle },
    { title: 'Native compiler with bound content', command: ['cornell_research_compile'], output_paths: bundle },
    { title: 'Native compiler with prepared source', command: ['cornell_research_compile', prepared], output_paths: bundle },
  ];
  for (const [index, step] of variants.entries()) {
    const request = { ...source, execution_steps: [step] }, before = JSON.stringify(request);
    const result = await client.callTool({ name: 'workflow_plan', arguments: request });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(JSON.stringify(request), before, 'Canonicalization must not mutate the original model request.');
    const normalized = captured.at(-1);
    assert.deepEqual(normalized.outputs, bundle);
    assert.deepEqual(normalized.allowed_paths, source.allowed_paths);
    assert.deepEqual(normalized.verification_paths, source.verification_paths);
    assert.deepEqual(normalized.documentation_paths, bundle);
    assert.deepEqual(normalized.input_paths, [template]);
    assert.deepEqual(normalized.preservation_paths, [prepared]);
    assert.equal(normalized.cornell_input_path, index === 1 ? undefined : prepared,
      'An explicit source remains bound; a source-less native marker keeps the author-content interface.');
    assert.deepEqual(normalized.execution_steps, [], 'Native compilation stays a bound tool, never an invented executable.');
    assert.deepEqual(normalized.checks[0].command, source.checks[0].argv);
    assert.deepEqual(normalized.checks[0].negative_controls[0].command, source.checks[0].negative_controls[0].argv);
    assert.ok(normalized.checks[0].baseline_paths.includes('checks/check.mjs'));
    assert.ok(normalized.checks[0].negative_controls[0].baseline_paths.includes('checks/bad.json'));
    assert.deepEqual(normalized.acceptance_criteria, source.acceptance_criteria);
  }
  assert.equal(captured.length, 3);
  const canonical = await client.callTool({ name: 'workflow_plan', arguments: { ...source, execution_steps: [], cornell_input_path: prepared } });
  assert.equal(canonical.isError, undefined, JSON.stringify(canonical));
  assert.equal(captured.length, 4);
  assert.equal(captured.at(-1).cornell_input_path, prepared);
  assert.deepEqual(captured.at(-1).preservation_paths, [prepared]);
  assert.deepEqual(captured.at(-1).execution_steps, [], 'Canonical prepared input needs no fictitious OS execution step.');
  for (const forbidden of [{ cornell_input_sha256: 'f'.repeat(64) }, { cornell_source: { path: prepared, sha256: 'f'.repeat(64) } },
    { workflow_id: 'forged-workflow' }, { invocation_id: 'forged-invocation' }]) {
    const forged = await client.callTool({ name: 'workflow_plan', arguments: { ...source, execution_steps: [], cornell_input_path: prepared, ...forbidden } });
    assert.equal(forged.isError, true, 'Source paths are professional input; hashes and invocation identity are backend-only.');
  }
  assert.equal(captured.length, 4);
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'workflow_plan').inputSchema;
  assert.equal(schema.properties.cornell_input_path.type, 'string');
  assert.equal('cornell_input_sha256' in schema.properties, false); assert.equal('cornell_source' in schema.properties, false);
  assert.ok(schema.properties.checks.items.properties.command);
  assert.equal('argv' in schema.properties.checks.items.properties, false);
  assert.ok(schema.properties.execution_steps.items.properties.command);
  assert.equal('tool' in schema.properties.execution_steps.items.properties, false);
  assert.equal('parameters' in schema.properties.execution_steps.items.properties, false);
  assert.equal(existsSync(join(root, '.neomind/controlled/workflows')), false, 'The boundary fixture creates no workflow, task or product files.');
  assert.equal(readFileSync(join(root, template), 'utf8'), '# Existing readonly template\n');
});

test('producer execution capability and cross-step output collisions are rejected before freezing any task', t => {
  const root = fixture(t), proposed = { ...plan(), allowed_paths: ['src','docs'], outputs: ['docs/generated.md'] };
  const step = { title: 'One', command: ['node','src/value.mjs'], input_paths: [], output_paths: ['docs/generated.md'] };
  const valid = normalizeControlledPlanInput(root, { ...proposed, execution_steps: [step] });
  assert.equal(valid.execution_steps[0].title, 'One');
  assert.throws(() => normalizeControlledPlanInput(root, { ...proposed,
    execution_steps: [step, { ...step, title: 'Two' }] }), /overlapping/);
  assert.throws(() => normalizeControlledPlanInput(root, { ...proposed,
    execution_steps: [{ ...step, command: ['node','--eval','console.log(1)'] }] }), /Inline code|exact existing/);
  assert.throws(() => normalizeControlledPlanInput(root, { ...proposed,
    execution_steps: [{ ...step, output_paths: ['checks/generated.md'] }] }), /producer|checker|scope/);
  assert.equal(existsSync(join(root, '.neomind/controlled/workflows')), false);
});

test('referenced verifier outputs retain actual required check baselines while unrelated promised artifacts cannot disappear', t => {
  const root = fixture(t), source = controlledPlanSchema.parse({ ...plan(), outputs: [...plan().outputs, 'checks/check.mjs', 'checks/bad.json'] });
  const normalized = normalizeControlledPlanInput(root, source);
  assert.deepEqual(normalized.outputs, plan().outputs);
  assert.deepEqual(normalized.allowed_paths, source.allowed_paths); assert.deepEqual(normalized.verification_paths, source.verification_paths);
  assert.ok(normalized.checks[0].baseline_paths.includes('checks/check.mjs'));
  assert.ok(normalized.checks[0].negative_controls[0].baseline_paths.includes('checks/bad.json'));
  assert.deepEqual(normalized.checks[0].command, source.checks[0].command);
  assert.deepEqual(normalized.checks[0].negative_controls[0].command, source.checks[0].negative_controls[0].command);
  assert.deepEqual(source.outputs, [...plan().outputs, 'checks/check.mjs', 'checks/bad.json']);
  assert.throws(() => normalizeControlledPlanInput(root, controlledPlanSchema.parse({ ...source,
    outputs: [...source.outputs, 'checks/unreferenced-report.md'] })), /not referenced.*without dropping/);
  initialize(root, { project_id: 'PARTITION-BASELINE' });
  writeFileSync(join(root, 'checks/check.mjs'), 'process.exit(1);\n');
  const requirement = createRecord(root, { type: 'requirement', title: 'The independent checker needs its real invalid fixture.', owner: 'manager' });
  const workflow = createRecord(root, { type: 'knowledge', title: 'Workflow: partitioned check fixture', owner: 'manager',
    data: { kind: 'manager-workflow', requirement_id: requirement.meta.id } });
  const task = createRecord(root, { type: 'task', title: 'Bounded fixture check', owner: 'developer', data: { workflow_id: workflow.meta.id } });
  const run = { workflow_id: workflow.meta.id, epoch_id: randomUUID(), contract_hash: 'a'.repeat(64) };
  const contract = { task_id: task.meta.id, requirement_ids: [requirement.meta.id] };
  const negative = normalized.checks[0].negative_controls[0], missing = controlledFingerprints(root, negative.baseline_paths);
  assert.equal(missing['checks/bad.json'], 'missing');
  assert.throws(() => prepareControlledCheckEvidence(root, run, contract, negative, missing, null), /hash|missing|SHA-256/i);
  assert.equal(loadRecords(root).filter(record => record.meta.type === 'evidence').length, 0,
    'A missing verifier fixture cannot become a passing materialized execution.');
});

test('only an exact existing safe skill file can move from preservation to read-only input metadata', t => {
  const root = fixture(t), template = '.agents/skills/existing/assets/template.md';
  writeFileSync(join(root, 'prior.md'), '# Existing public read-only source\n');
  const source = controlledPlanSchema.parse({ ...plan(), input_paths: [], preservation_paths: [template, 'prior.md'] });
  const normalized = normalizeControlledPlanInput(root, source);
  assert.deepEqual(normalized.input_paths, [template]); assert.deepEqual(normalized.preservation_paths, ['prior.md']);
  assert.deepEqual(normalized.allowed_paths, source.allowed_paths); assert.deepEqual(normalized.verification_paths, source.verification_paths);
  for (const path of ['.agents/skills/existing', '.agents/skills/existing/assets', '.agents/skills/existing/assets/secrets.json',
    '.codex/config.toml', '.vscode/settings.json', '.env', '.agents/skills/existing/assets/missing.md'])
    assert.throws(() => normalizeControlledPlanInput(root, controlledPlanSchema.parse({ ...source, preservation_paths: [path] })), undefined, path);
  mkdirSync(join(root, '.agents/skills/existing/assets/directory.md'));
  assert.throws(() => normalizeControlledPlanInput(root, controlledPlanSchema.parse({ ...source,
    preservation_paths: ['.agents/skills/existing/assets/directory.md'] })), /ordinary/);
  assert.equal(readFileSync(join(root, template), 'utf8'), '# Existing readonly template\n');
  assert.equal(existsSync(join(root, '.neomind')), false);
});

test('native Cornell normalization retains its prepared source and rejects ambiguous tools, outputs, limits and source ownership', t => {
  const root = fixture(t), directory = 'docs/cornell', prepared = 'src/prepared.json';
  const bundle = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`);
  writeFileSync(join(root, prepared), JSON.stringify({ topic: 'Prepared semantic research input' }));
  mkdirSync(join(root, directory)); writeFileSync(join(root, directory, 'owned-input.json'), JSON.stringify({ topic: 'Producer-owned changing data' }));
  const step = { title: 'Bound native compiler', command: ['cornell_research_compile', prepared], output_paths: bundle };
  const source = { ...plan(), allowed_paths: [directory], outputs: bundle, cornell_output_dir: directory, input_paths: [], execution_steps: [step] };
  const normalized = normalizeControlledPlanInput(root, controlledPlanSchema.parse(source));
  assert.deepEqual(normalized.execution_steps, []);
  assert.equal(normalized.cornell_input_path, prepared);
  assert.deepEqual(normalized.preservation_paths, [prepared]);
  assert.deepEqual(normalized.outputs, bundle); assert.deepEqual(normalized.allowed_paths, source.allowed_paths);
  assert.deepEqual(normalized.acceptance_criteria, source.acceptance_criteria);
  assert.deepEqual(normalizeControlledPlanInput(root, normalized), normalized, 'Canonical metadata must be idempotent on resubmission.');
  for (const invalid of [
    { cornell_output_dir: undefined },
    { execution_steps: [{ ...step, output_paths: [...bundle, 'docs/extra.md'] }] },
    { execution_steps: [{ ...step, output_paths: bundle.slice(0, 2) }] },
    { execution_steps: [{ ...step, timeout_ms: 10 }] },
    { execution_steps: [step, { ...step, title: 'Different native input' }] },
    { execution_steps: [step, { title: 'Local conflicting generator', command: ['node', 'src/value.mjs'], output_paths: [bundle[0]] }] },
    { execution_steps: [{ ...step, command: ['cornell_research_compile', '.neomind/config.json'] }] },
    { execution_steps: [{ ...step, command: ['cornell_research_compile', `${directory}/owned-input.json`] }] },
    { execution_steps: [{ ...step, command: ['cornell_research_compile', '../outside.json'] }] },
    { execution_steps: [{ ...step, command: ['cornell_research_compile', 'https://example.invalid/input.json'] }] },
  ]) assert.throws(() => normalizeControlledPlanInput(root, controlledPlanSchema.parse({ ...source, ...invalid })), undefined, JSON.stringify(invalid));
  assert.equal(controlledPlanSchema.safeParse({ ...source, execution_steps: [{ ...step, command: ['cornell_research_compile', prepared],
    tool: 'cornell_research_compile', parameters: { input_path: 'src/different.json' } }] }).success, false);
  assert.equal(controlledPlanSchema.safeParse({ ...source, execution_steps: [{ ...step, tool: 'cornell_research_compile',
    parameters: { input_path: prepared, shell: 'unexpected' } }] }).success, false);
  assert.equal(controlledPlanSchema.safeParse({ ...source, execution_steps: [{ ...step, tool: 'cornell_research_compile',
    workflow_id: 'forged-identity' }] }).success, false);
  const conflictingCheck = { ...plan().checks[0], argv: ['node', 'checks/different.mjs'] };
  assert.equal(controlledPlanSchema.safeParse({ ...source, checks: [conflictingCheck] }).success, false);
  assert.equal(existsSync(join(root, '.neomind')), false);
});

test('queued normalized Cornell plans retain exactly one canonical source path and revalidate its read-only authority', t => {
  const root = fixture(t), directory = 'docs/cornell', first = 'src/first.json', second = 'src/second.json';
  const bundle = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`);
  for (const path of [first, second]) writeFileSync(join(root, path), JSON.stringify({ topic: 'Prepared compiler source' }));
  const marker = { title: 'Explicit native source', command: ['cornell_research_compile', first], output_paths: bundle };
  const submitted = controlledPlanSchema.parse({ ...plan(), allowed_paths: [directory], outputs: bundle, input_paths: [],
    cornell_output_dir: directory, execution_steps: [marker] });
  const pending = normalizeControlledPlanInput(root, submitted), before = JSON.stringify(pending);
  assert.equal(pending.cornell_input_path, first); assert.deepEqual(pending.execution_steps, []);
  const canonical = controlledPlanSchema.parse({ ...submitted, execution_steps: [], cornell_input_path: first });
  assert.deepEqual(normalizeControlledPlanInput(root, canonical), pending,
    'Canonical source paths and compatibility markers bind the same prepared data.');
  assert.throws(() => normalizeControlledPlanInput(root, { ...canonical, cornell_output_dir: undefined }), /actual bound output directory/);
  assert.deepEqual(normalizeControlledPlanInput(root, pending), pending);
  assert.equal(JSON.stringify(pending), before);
  assert.equal(controlledPlanSchema.safeParse(pending).success, true,
    'A canonical source path can be resubmitted without constructing source hashes or internal identity.');
  assert.throws(() => normalizeControlledPlanInput(root, { ...pending, execution_steps: [{ ...marker, command: ['cornell_research_compile', second] }] }), /conflicting prepared sources/);
  assert.throws(() => normalizeControlledPlanInput(root, { ...submitted,
    execution_steps: [{ ...marker, input_paths: [first, second] }] }), /one unambiguous/);
  assert.throws(() => normalizeControlledPlanInput(root, { ...pending, cornell_input_path: '.neomind/config.json' }), /public read-only|managed storage/);
  writeFileSync(join(root, first), '{');
  assert.throws(() => normalizeControlledPlanInput(root, pending), /valid UTF-8 JSON object/);
  assert.equal(JSON.stringify(pending), before, 'Failed revalidation must not rewrite the retained source or preservation contract.');
  assert.equal(existsSync(join(root, '.neomind')), false);
});

test('actual owning planner MCP canonicalizes terminal scope separators before checker baselines and frozen-plan validation', async t => {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-scope-separators-')));
  initialize(root, { project_id: 'SCOPE-SLASH', platforms: ['copilot'], repair_attempts: 1 });
  for (const directory of ['src', 'docs', 'checks', 'preserved']) mkdirSync(join(root, directory));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value=1;\n');
  writeFileSync(join(root, 'preserved/keep.txt'), 'existing authored content\n');
  const policy = ensureRoutingPolicy(root);
  atomicWrite(safePath(root, '.neomind/routing.json'), JSON.stringify({ ...policy, vscode_effort_policy: 'allow-unavailable' }));
  class Cancellation { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() { this.cancel(); } }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const api = { version: '1.109.0', workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] },
    LanguageModelTextPart: class {}, LanguageModelToolCallPart: class {}, LanguageModelToolResultPart: class {},
    LanguageModelChatToolMode: { Auto: 1 }, CancellationTokenSource: Cancellation,
    LanguageModelChatMessage: { User: content => ({ role: 1, content }), Assistant: content => ({ role: 2, content }) },
    lm: { selectChatModels: async selector => [{ ...selector, capabilities: { toolCalling: true }, sendRequest: async (_messages, _options, token) => ({
      stream: (async function* () { while (!token.isCancellationRequested) await delay(10); })(),
    }) }] } };
  const bridge = await enableVSCodeHost(api, root), owner = await startControlledHost(root);
  let server, client;
  t.after(async () => { await client?.close(); await server?.close(); await owner.close(); await shutdownNative(root); await bridge.close();
    assert.equal(dirname(root), parent); rmSync(root, { recursive: true, force: true }); });
  const initial = await startControlledWorkflow(root, { requirement: 'Deliver the scalar and documentation with independent verification.', request_id: 'scope-slash' });
  let context, run;
  const deadline = Date.now() + 30000;
  do { run = controlledStatus(root, initial.workflow_id); const attempt = run.attempts.at(-1);
    if (attempt?.state === 'running' && attempt.invocation_id) context = ownedContext(root, attempt.request_id);
    if (!context) await delay(10);
  } while (!context && Date.now() < deadline);
  assert.ok(context, 'The actual signed owning planner must bind its backend callbacks.');
  server = createControlledMcpServer(root, { ...context.binding, invocation_id: run.attempts.at(-1).invocation_id }, context.callbacks);
  client = new Client({ name: 'actual-scope-plan-input', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const source = { ...plan(), input_paths: [], allowed_paths: ['src/', 'docs/'], verification_paths: ['checks/'], preservation_paths: ['preserved/'] };
  const submit = input => client.callTool({ name: 'workflow_plan', arguments: input });
  for (const invalid of [{ allowed_paths: ['../outside/'] }, { verification_paths: ['checks/../outside/'] }, { preservation_paths: ['../outside/'] }]) {
    const response = await submit({ ...source, ...invalid });
    assert.equal(response.isError, true); assert.equal(JSON.parse(response.content[0].text).code, 'PLAN_INVALID');
    assert.equal(loadRecords(root).filter(record => record.meta.type === 'task').length, 0);
  }
  assert.throws(() => normalizeControlledPlanInput(root, controlledPlanSchema.parse({ ...source, outputs: ['docs/'] })), /canonical/);
  const before = JSON.stringify(source), response = await submit(source);
  assert.equal(response.isError, undefined, JSON.stringify(response)); assert.equal(JSON.stringify(source), before);
  const frozen = JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(initial.workflow_id)}.${run.epoch_id}.contract.json`), 'utf8')).plan;
  assert.deepEqual(frozen.allowed_paths, ['src', 'docs']); assert.deepEqual(frozen.verification_paths, ['checks']);
  assert.deepEqual(frozen.preservation_paths, ['preserved']); assert.deepEqual(frozen.outputs, source.outputs);
  assert.deepEqual(frozen.checks[0].command, source.checks[0].command);
  assert.deepEqual(frozen.acceptance_criteria, source.acceptance_criteria);
  assert.ok(frozen.checks[0].baseline_paths.includes('checks/check.mjs'));
  assert.deepEqual(frozen.checks[0].negative_controls[0].baseline_paths, ['checks/check.mjs', 'checks/bad.json']);
  assert.equal(readFileSync(join(root, 'preserved/keep.txt'), 'utf8'), 'existing authored content\n');
});

test('actual controlled MCP accepts semantic plans without baseline bookkeeping and backend fills only approved metadata', async t => {
  const root = fixture(t), captured = [], server = createControlledMcpServer(root, { workflow_id: 'BACKEND-WORKFLOW', invocation_id: 'BACKEND-INVOCATION',
    stage: 'planning', role: 'manager', implementation_paths: [], verification_paths: [] }, {
    assertActive() {}, saveReport() { return { saved: true }; },
    submitPlan(value) { captured.push(normalizeControlledPlanInput(root, value)); return { saved: true }; },
  });
  const client = new Client({ name: 'plan-input-contract-fixture', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'workflow_plan').inputSchema;
  const check = schema.properties.checks.items;
  assert.ok(check.required.includes('negative_controls')); assert.equal(check.required.includes('baseline_paths'), false);
  assert.match(schema.properties.input_paths.description, /Ordinary public source paths are already readable/);
  assert.match(schema.properties.preservation_paths.description, /Narrow existing public files/);
  const source = plan(), before = JSON.stringify(source);
  const response = await client.callTool({ name: 'workflow_plan', arguments: source });
  assert.equal(response.isError, undefined, JSON.stringify(response)); assert.equal(captured.length, 1);
  const saved = captured[0];
  assert.deepEqual(saved.input_paths, ['.agents/skills/existing/assets/template.md']);
  assert.deepEqual(saved.checks[0].baseline_paths, ['src/value.mjs', 'docs/readme.md', 'checks/check.mjs']);
  assert.deepEqual(saved.checks[0].negative_controls[0].baseline_paths, ['checks/check.mjs', 'checks/bad.json']);
  assert.deepEqual(saved.checks[0].command, source.checks[0].command);
  assert.deepEqual(saved.outputs, source.outputs); assert.deepEqual(saved.acceptance_criteria, source.acceptance_criteria);
  assert.equal(JSON.stringify(source), before);
  assert.equal(readFileSync(join(root, 'src/value.mjs'), 'utf8'), 'existing public source\n');
});

test('normalization cannot promote private configuration, credentials, hidden directories or path escapes into read approvals', t => {
  const root = fixture(t);
  for (const path of ['.codex/config.toml', '.vscode/settings.json', '.env', 'src/auth.json',
    '.agents/skills/existing', '.agents/skills/existing/assets/secrets.json', 'src/../value.mjs', '../outside.md', 'C:/outside.md']) {
    const source = controlledPlanSchema.parse({ ...plan(), input_paths: [path] }), before = JSON.stringify(source);
    assert.throws(() => normalizeControlledPlanInput(root, source), undefined, path);
    assert.equal(JSON.stringify(source), before);
  }
});

test('continuation metadata restores exact committed positive baselines and never alters frozen checks or substantive commands', t => {
  const root = fixture(t), source = controlledPlanSchema.parse(plan());
  const committed = [{ command: ['node', 'checks/check.mjs', 'src/value.mjs'], baseline_paths: ['src/value.mjs', 'checks/check.mjs'] }];
  const before = JSON.stringify(committed);
  source.checks[0].baseline_paths = ['docs/readme.md'];
  source.checks.push({ ...structuredClone(source.checks[0]), title: 'New independent documentation check', command: ['node', 'checks/documentation.mjs'],
    negative_controls: [{ title: 'Reject invalid documentation', command: ['node', 'checks/documentation.mjs', 'checks/invalid.md'], baseline_paths: [], expected_exit_code: 1 }] });
  const saved = normalizeControlledPlanInput(root, source, committed);
  assert.deepEqual(saved.checks[0].baseline_paths, committed[0].baseline_paths);
  assert.equal(JSON.stringify(committed), before);
  assert.deepEqual(saved.checks[1].baseline_paths, ['docs/readme.md', 'src/value.mjs', 'checks/documentation.mjs']);
  assert.deepEqual(saved.checks[0].negative_controls[0].command, source.checks[0].negative_controls[0].command);
  assert.equal(saved.checks[0].negative_controls[0].expected_exit_code, 1);
  assert.deepEqual(saved.allowed_paths, source.allowed_paths); assert.deepEqual(saved.verification_paths, source.verification_paths);
});

test('declared current negative-control requirements remain explicit and cannot be filled by normalization', t => {
  fixture(t);
  const missing = plan(); delete missing.checks[0].negative_controls;
  assert.equal(controlledPlanSchema.safeParse(missing).success, false);
  const empty = plan(); empty.checks[0].negative_controls = [];
  assert.equal(controlledPlanSchema.safeParse(empty).success, false);
  const wrongExit = plan(); wrongExit.checks[0].negative_controls[0].expected_exit_code = 0;
  assert.equal(controlledPlanSchema.safeParse(wrongExit).success, false);
});

function candidate() {
  return { title: 'Reusable exercise generator', description: 'Generate future requested exercise artifacts without replacing its own tooling.',
    script: 'src/value.mjs', verification_script: 'checks/check.mjs',
    parameters: { output: { type: 'string', path: true } }, outputs: [{ path: '{output}', min_bytes: 1 }],
    environment: { platforms: [process.platform], clients: ['copilot', 'codex'] },
    effects: { write_roots: ['generated'], network: false, publication: false } };
}

test('actual 0062-style delivered-tooling candidate is rejected before immutable plan effects', t => {
  const root = fixture(t), source = controlledPlanSchema.parse({ ...plan(), procedure_candidate: { ...candidate(),
    outputs: [{ path: 'src/value.mjs' }, { path: 'docs/readme.md' }, { path: 'checks/check.mjs' }],
    effects: { write_roots: [], network: false, publication: false } } });
  const before = JSON.stringify(source), bytes = readFileSync(join(root, 'src/value.mjs'));
  assert.throws(() => normalizeControlledPlanInput(root, source), /future generated artifacts.*nonempty effects.write_roots/);
  assert.equal(JSON.stringify(source), before); assert.deepEqual(readFileSync(join(root, 'src/value.mjs')), bytes);
  assert.equal(existsSync(join(root, '.neomind')), false, 'Definition preview must not create a manifest, task or frozen contract.');
  source.procedure_candidate.effects.write_roots = ['src', 'docs', 'checks'];
  assert.throws(() => normalizeControlledPlanInput(root, source), /not delivered tooling/);
});

test('future parameterized artifact candidates remain valid without inventing parameter containment or registration identity', t => {
  const root = fixture(t), source = controlledPlanSchema.parse({ ...plan(), procedure_candidate: candidate() });
  const saved = normalizeControlledPlanInput(root, source);
  assert.deepEqual(saved.procedure_candidate, source.procedure_candidate);
  assert.equal('id' in saved.procedure_candidate, false); assert.equal('author' in saved.procedure_candidate, false);
  assert.equal(existsSync(join(root, '.neomind')), false);
});

test('candidate definition/default/template errors are caught before freezing without changing global registration policy', t => {
  const root = fixture(t);
  const check = changes => normalizeControlledPlanInput(root, controlledPlanSchema.parse({ ...plan(), procedure_candidate: { ...candidate(), ...changes } }));
  assert.throws(() => check({ outputs: [{ path: 'generated/{undeclared}.md' }] }), /Undeclared path template parameter/);
  assert.throws(() => check({ parameters: { output: { type: 'string', path: true, default: '../outside.md' } } }), /canonical|escapes/);
  assert.throws(() => check({ outputs: [{ path: 'outside/new.md' }] }), /outside every literal/);
  writeFileSync(join(root, 'docs/existing.md'), '# Authored file\n');
  assert.throws(() => check({ outputs: [{ path: 'docs/existing.md' }], effects: { write_roots: ['docs'], network: false, publication: false } }), /already exists/);
  assert.equal(readFileSync(join(root, 'docs/existing.md'), 'utf8'), '# Authored file\n');
  assert.equal(existsSync(join(root, '.neomind')), false);
});

test('consultation roles are explicit and unsupported frozen roles cannot silently become Architect', t => {
  const root = fixture(t), expected = ['explorer', 'planner', 'architect', 'researcher', 'curator', 'component-owner'];
  assert.deepEqual([...controlledConsultationRoles], expected);
  for (const role of ['reviewer', 'verifier', 'coordinator', 'unknown', 'toString']) {
    const source = { ...plan(), specialists: [{ role, objective: 'Approve the checker before pilots.' }] };
    assert.equal(controlledPlanSchema.safeParse(source).success, false, role);
    assert.throws(() => normalizeControlledPlanInput(root, source), error => {
      assert.equal(error.code, 'UNSUPPORTED_SPECIALIST_ROLE'); assert.match(error.message, /backend-owned stages/); return true;
    });
    const dispatched = [];
    assert.throws(() => dispatched.push(controlledConsultationRole(role)), { code: 'UNSUPPORTED_SPECIALIST_ROLE' });
    assert.deepEqual(dispatched, [], 'An unsupported existing consultation must not resolve to Architect or any other role.');
  }
  const source = controlledPlanSchema.parse({ ...plan(), specialists: [{ role: 'architect', objective: 'Resolve the new interface design.' }] });
  assert.deepEqual(normalizeControlledPlanInput(root, source).specialists, source.specialists);
  assert.equal(controlledConsultationRole('architect'), 'architect');
  assert.equal(controlledConsultationRole('explorer'), 'codebase-analyst');
  assert.equal(controlledConsultationRole('planner'), 'requirements');
  assert.equal(existsSync(join(root, '.neomind')), false);
});
