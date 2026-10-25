import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer, controlledPlanSchema, controlledConsultationRoles } from '../dist/controlled-tools.js';
import { normalizeControlledPlanInput, controlledConsultationRole } from '../dist/controlled-plan-input.js';

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
  assert.match(schema.properties.preservation_paths.description, /Narrow existing files/);
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
