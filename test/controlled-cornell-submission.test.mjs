import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlledMcpServer } from '../dist/controlled-tools.js';
import { controlledCornellResearchSchema } from '../dist/controlled-cornell-sources.js';
import { normalizeControlledCornellSources } from '../dist/controlled-cornell-sources.js';
import { normalizeControlledCornellSubmission } from '../dist/controlled-cornell-submission.js';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { researchFixture } from './cornell-research-fixture.mjs';

async function fixture(t, existing, invocation = 'cornell-content-ingress') {
  const f = existing ?? researchFixture(t), received = [];
  const { requirement_id, expected_requirement_revision, workflow_id, task_id, owner, output_dir, ...input } = f.input;
  const expected = controlledCornellResearchSchema(false, false).parse(input);
  const server = createControlledMcpServer(f.root, { workflow_id: f.workflow.meta.id, task_id: 'CORNELL-TASK-0001',
    invocation_id: invocation, stage: 'implementation', role: 'developer',
    implementation_paths: ['docs'], verification_paths: ['checks'], read_paths: ['.'],
    procedure_bound: false, execution_steps: [], cornell_starter_allowed: false,
  }, { assertActive() {}, saveReport() { return { saved: true }; }, compileResearch(value) { received.push(value); return { saved: true }; } });
  const client = new Client({ name: 'cornell-content-ingress', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { ...f, canonicalInput: f.input, input, expected, received, client,
    call: input => client.callTool({ name: 'cornell_research_compile', arguments: input }) };
}

test('actual Cornell MCP accepts professional content without model-generated metadata boilerplate', async t => {
  const c = await fixture(t), input = structuredClone(c.input);
  delete input.date;
  input.learning_objectives = input.learning_objectives.map(o => o.text);
  input.constraints = input.constraints[0];
  for (const question of [...input.questions, ...input.practice.questions]) {
    delete question.id; delete question.objective_ids;
    question.question = question.prompt; delete question.prompt;
  }
  for (const explanation of input.explanations) { explanation.title = explanation.heading; delete explanation.heading; }
  for (const source of input.sources) { delete source.id; source.url = source.uri; delete source.uri; }
  const result = await c.call(input);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(c.received.length, 1);
  assert.deepEqual(c.received[0], { ...c.expected, date: c.workflow.meta.created_at.slice(0, 10) });
  const advertised = (await c.client.listTools()).tools.find(t => t.name === 'cornell_research_compile');
  assert.match(advertised.description, /learning_objectives/);
  assert.match(advertised.description, /objective_indexes/);
  assert.equal(JSON.stringify(advertised.inputSchema).includes('"$ref"'), false);
});

test('backend-owned date replays across midnight and a new invocation without changing professional content', async t => {
  const c = await fixture(t), input = structuredClone(c.input), expected = c.workflow.meta.created_at.slice(0, 10);
  delete input.date;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(expected + 'T23:59:59Z') });
  assert.equal((await c.call(input)).isError, undefined);
  t.mock.timers.setTime(Date.parse(expected + 'T23:59:59Z') + 2 * 86400000);
  const resumed = await fixture(t, { ...c, input: c.canonicalInput }, 'cornell-content-ingress-resumed');
  assert.equal((await resumed.call(input)).isError, undefined);
  assert.equal(c.received[0].date, expected);
  assert.deepEqual(resumed.received[0], c.received[0]);
  assert.throws(() => normalizeControlledCornellSubmission(input), /backend-bound saved workflow date/);
});

test('canonical input remains equivalent, lowercase IDs normalize, and explicit numeric objective mapping is deterministic', async t => {
  const c = await fixture(t);
  assert.equal((await c.call(c.input)).isError, undefined);
  assert.deepEqual(c.received[0], c.expected);
  const input = structuredClone(c.input);
  input.learning_objectives[0].id = 'o1';
  for (const question of [...input.questions, ...input.practice.questions]) {
    question.id = question.id.toLowerCase();
    delete question.objective_ids; question.objective_indexes = [1];
  }
  input.sources[0].id = 's1';
  assert.equal((await c.call(input)).isError, undefined);
  assert.deepEqual(c.received[1], c.expected);
});

test('submission normalization cannot invent answers, source titles, objective relationships or observation authority', async t => {
  const c = await fixture(t);
  for (const mutate of [
    input => delete input.questions[0].answer,
    input => delete input.sources[0].title,
    input => { input.learning_objectives.push({ id: 'O2', text: 'Explain a different professional learning objective.' }); delete input.questions[0].objective_ids; },
    input => { input.questions[0].objective_ids = ['O99']; },
    input => { input.learning_objectives[0].id = 'invariant'; input.learning_objectives.push({ id: 'INVARIANT', text: 'State another independent and distinct learning objective.' }); input.questions[0].objective_ids = ['invariant']; },
    input => { input.sources[0].url = 'https://different.example/source'; },
    input => { input.sources[0].id = 'unmapped-source-label'; },
    input => { input.sources.push({ ...input.sources[0], id: 's1' }); },
  ]) {
    const input = structuredClone(c.input); mutate(input);
    assert.equal((await c.call(input)).isError, true);
  }
  assert.equal(c.received.length, 0);
  const input = structuredClone(c.input);
  input.worked_example.observed = 'A fabricated independent run allegedly succeeded.';
  input.worked_example.evidence_ids = ['invented-receipt'];
  assert.equal((await c.call(input)).isError, undefined);
  assert.equal('observed' in c.received[0].worked_example, false);
  assert.equal('evidence_ids' in c.received[0].worked_example, false);
  const corrupt = { ...c.input, questions: [{ ...c.input.questions[0], objective_ids: ['O99'] }] };
  assert.throws(() => compileCornellResearch(c.root, { ...c.canonicalInput, ...corrupt }), /unknown objective/);
});

test('normalized submission retains canonical content quality, real provenance and citation validation', async t => {
  const c = await fixture(t), professional = normalizeControlledCornellSubmission(c.input, false, false);
  const context = { workflow_id: c.workflow.meta.id, epoch_id: 'cornell-ingress-provenance', task_id: 'CORNELL-TASK-0001',
    requirement_ids: [c.requirement.meta.id], evidence: [], file_allowed(path) { return !path.split('/').some(part => part.startsWith('.')); } };
  const ledger = normalizeControlledCornellSources(c.root, professional.sources, context);
  const canonical = { ...c.canonicalInput, ...professional, sources: ledger.sources };
  const compiled = compileCornellResearch(c.root, canonical);
  const note = createCornellNote(c.root, compiled.note);
  assert.equal(validateCornellNote(c.root, note.meta.id).ok, true);
  assert.throws(() => normalizeControlledCornellSources(c.root, [{ id: 'S1', title: 'An untrusted runtime source', uri: '.neomind/config.json' }], context));
  assert.throws(() => compileCornellResearch(c.root, { ...canonical, methods: canonical.methods + ' Unsupported reference [S99].' }), /Unknown source citation/);
  const unclassified = { ...canonical, output_dir: 'docs/research/unclassified',
    methods: canonical.methods.replace('[source-reported]', ''),
    explanations: canonical.explanations.map(item => ({ ...item, body: item.body.replace('[inferred]', '') })),
    results: canonical.results.replace('[expected]', ''), discussion: canonical.discussion.replace('[inferred]', '') };
  const incomplete = compileCornellResearch(c.root, unclassified);
  assert.throws(() => createCornellNote(c.root, incomplete.note), /must label claims/);
  assert.throws(() => normalizeControlledCornellSubmission({ ...c.input, summary: 'TODO: complete this research summary.' }), /Complete substantive prose/);
});
