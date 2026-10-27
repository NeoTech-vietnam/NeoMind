import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer, controlledInstructions, controlledToolNames } from '../dist/controlled-tools.js';
import { researchFixture } from './cornell-research-fixture.mjs';

function binding(stage, extra = {}) {
  return { workflow_id: 'NM-INSTRUCTION-KNW-0001', invocation_id: 'instruction-fixture',
    stage, role: stage === 'implementation' ? 'developer' : stage === 'verification' ? 'verifier' :
      stage === 'review' ? 'reviewer' : 'manager', implementation_paths: ['src', 'notes'],
    verification_paths: ['checks'], ...extra };
}

test('an implementation with no execution binding is not told to invoke unavailable execution tools', () => {
  const actor = binding('implementation', { execution_steps: [], procedure_bound: false });
  const names = controlledToolNames(actor), instructions = controlledInstructions(actor);
  assert.equal(names.includes('task_run'), false);
  assert.equal(names.includes('procedure_run'), false);
  assert.doesNotMatch(instructions, /use task_run|calls procedure_run/i);
});

test('read-only review instructions do not direct producer execution or recipe lifecycle operations', () => {
  const actor = binding('review', { execution_steps: [], procedure_bound: false });
  const names = controlledToolNames(actor), instructions = controlledInstructions(actor);
  assert.equal(names.includes('task_run'), false);
  assert.equal(names.includes('procedure_run'), false);
  assert.equal(names.includes('cornell_research_compile'), false);
  assert.doesNotMatch(instructions, /use task_run|calls procedure_run|then implementation calls cornell_research_compile/i);
});

test('planning describes future bindings while an executable producer receives its actual execution instructions', () => {
  const planner = controlledInstructions(binding('planning'));
  assert.match(planner, /execution_steps/);
  assert.doesNotMatch(planner, /procedure_candidate|Procedure subprocess stdin contract/);
  assert.match(controlledInstructions(binding('planning', { procedure_registration_required: true })), /procedure_candidate/);
  const actor = binding('implementation', { execution_steps: [{ title: 'Generate', command: ['node', 'src/build.mjs'] }], procedure_bound: true });
  assert.ok(controlledToolNames(actor).includes('task_run'));
  assert.ok(controlledToolNames(actor).includes('procedure_run'));
  const producer = controlledInstructions(actor);
  assert.match(producer, /task_run/);
  assert.match(producer, /procedure_run/);
});

test('the planning schema presented over MCP distinguishes native tools, OS processes and each artifact owner', async t => {
  const { root } = researchFixture(t);
  const server = createControlledMcpServer(root, binding('planning'), { assertActive() {}, saveReport() {} });
  const client = new Client({ name: 'documented-planning-boundaries-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const plan = (await client.listTools()).tools.find(tool => tool.name === 'workflow_plan').inputSchema.properties;
  assert.match(plan.execution_steps.description, /direct local script.*fixed --version/);
  assert.match(plan.execution_steps.description, /cornell_research_compile and procedure_run are not OS executables/);
  assert.match(plan.cornell_output_dir.description, /supplies cornell_research_compile directly/);
  assert.match(plan.outputs.description, /Verifier checker scripts, negative fixtures and verifier-authored reports belong to verification_paths, not outputs/);
  assert.match(plan.input_paths.description, /hidden canonical templates and validators here, not in preservation_paths/);
  assert.match(plan.preservation_paths.description, /Hidden skill templates and validator scripts belong in input_paths/);
});

test('the post-check report assignment receives report-only instructions and no unavailable producer tools', () => {
  const actor = binding('implementation', { evidence_documentation: true,
    implementation_paths: ['docs/final-report.md'], execution_steps: [], procedure_bound: false });
  const names = controlledToolNames(actor), instructions = controlledInstructions(actor);
  assert.ok(names.includes('task_file_write'));
  assert.ok(names.includes('check_evidence'));
  for (const name of ['task_run', 'procedure_run', 'cornell_research_compile']) {
    assert.equal(names.includes(name), false, name);
    assert.doesNotMatch(instructions, new RegExp(`Use ${name}|calls ${name}`, 'i'));
  }
  assert.match(instructions, /evidence-documentation/);
  assert.match(instructions, /requested final report files/);
  assert.match(instructions, /independent verification checkpoint/);
  assert.match(instructions, /fresh independent verification and required review/);
  assert.match(instructions, /workflow is not yet accepted or closed/);
  assert.doesNotMatch(instructions, /missing verifier artifacts are EXPECTED/);
  assert.match(controlledInstructions(binding('planning')), /evidence_report_paths within both outputs and documentation_paths/);
});

test('the prepared-payload instruction works through actual MCP without copying or double-escaping research text', async t => {
  const { root, input } = researchFixture(t), received = [];
  const { requirement_id, expected_requirement_revision, workflow_id, task_id, owner, output_dir, ...semantic } = input;
  const body = '[inferred] Read the source example [S1].\n\n```json\n{"stdout":"first\\nsecond\\n"}\n```\nPreserve both kinds of newline.';
  semantic.explanations[0].body = body;
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/prepared-research.json'), JSON.stringify(semantic));
  const server = createControlledMcpServer(root, binding('implementation', {
    read_paths: ['scripts'], execution_steps: [], procedure_bound: false,
  }), { assertActive() {}, saveReport() {}, compileResearch(value) { received.push(value); return { saved: true }; } });
  const client = new Client({ name: 'documented-controlled-payload-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'cornell_research_compile', arguments: { input_path: 'scripts/prepared-research.json' } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(received.length, 1);
  assert.equal(received[0].explanations[0].body, body);
  assert.ok(received[0].explanations[0].body.includes('"first\\nsecond\\n"'));
  assert.ok(received[0].explanations[0].body.includes('\n```json\n'));
  const mixed = await client.callTool({ name: 'cornell_research_compile', arguments: {
    input_path: 'scripts/prepared-research.json', topic: 'Unbound override',
  } });
  assert.equal(mixed.isError, true);
  assert.equal(received.length, 1, 'The documented file form never merges model overrides into the saved payload.');
});
