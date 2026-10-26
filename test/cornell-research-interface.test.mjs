import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { cornellResearchSchema, compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { hash } from '../dist/storage.js';
import { researchFixture } from './cornell-research-fixture.mjs';

test('Cornell research accepts the actual command-plus-steps request shape and renders every step without executing commands', t => {
  const { root, input } = researchFixture(t);
  // Sanitized reproduction of the synthesis request that was refused repeatedly:
  // a runnable checker plus the human instruction to inspect its exact bytes.
  const steps = ['Review exact bytes before execution.', 'Explain why a constant result must fail an independent oracle.'];
  const marker = join(root, 'must-not-execute.txt');
  input.practice = { questions: input.practice.questions,
    command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
    procedure: steps, solution_path: input.practice.solution_path, starter: input.practice.starter };
  const before = structuredClone(input), compiled = compileCornellResearch(root, input);
  assert.deepEqual(input, before, 'Compilation preserves the model research input.');
  assert.deepEqual(compiled.note.practice.command, before.practice.command);
  assert.notEqual(compiled.note.practice.mode, 'manual', 'The canonical engine retains runnable command mode.');
  assert.equal(compiled.note.practice.procedure, undefined, 'Descriptive steps are rendered instead of conflicting with canonical execution mode.');
  for (const step of steps) assert.ok(compiled.note.practice.exercise.includes(step));
  assert.match(compiled.note.practice.exercise, /1\. Review exact bytes before execution\.[\s\S]*2\. Explain why/);
  assert.match(compiled.note.practice.answer, /## Q1[\s\S]*## P1/);
  const note = createCornellNote(root, compiled.note);
  assert.equal(validateCornellNote(root, note.meta.id).ok, true);
  const exercise = readFileSync(join(root, compiled.note.practice.exercise_path), 'utf8');
  for (const step of steps) assert.ok(exercise.includes(step));
  assert.equal(existsSync(marker), false, 'Neither compilation nor note generation executes the supplied command.');
});

test('advertised research schema explicitly accepts command, procedure or both and rejects missing or malformed practice', t => {
  const { input } = researchFixture(t), declared = z.toJSONSchema(cornellResearchSchema).properties.practice;
  assert.ok(declared.anyOf, 'MCP JSON schema exposes the at-least-one practice alternatives.');
  assert.ok(declared.anyOf.some(option => option.required.includes('command')));
  assert.ok(declared.anyOf.some(option => option.required.includes('procedure')));
  for (const practice of [
    { questions: input.practice.questions, command: ['node', 'checker.mjs'] },
    { questions: input.practice.questions, procedure: input.practice.procedure },
    { questions: input.practice.questions, command: ['node', 'checker.mjs'], procedure: input.practice.procedure },
  ]) assert.equal(cornellResearchSchema.safeParse({ ...input, practice }).success, true);
  for (const practice of [
    { questions: input.practice.questions },
    { ...input.practice, command: [] },
    { ...input.practice, command: 'node checker.mjs' },
    { ...input.practice, procedure: [] },
    { ...input.practice, command: ['node'], procedure: [false] },
    { ...input.practice, invented: true },
  ]) assert.equal(cornellResearchSchema.safeParse({ ...input, practice }).success, false);
});

test('substantive discussion of TODO and placeholder validation survives compilation, writing and later validation', t => {
  const { root, input } = researchFixture(t);
  input.methods = '[source-reported] The validator rejects unfinished placeholder and TODO markers, while preserving complete explanations of those validation rules [S1].';
  input.discussion = '[inferred] Mentioning a placeholder in a research explanation does not mean the explanation is unfinished [S1].';
  const compiled = compileCornellResearch(root, input), note = createCornellNote(root, compiled.note);
  const body = readFileSync(join(root, compiled.note.path), 'utf8');
  assert.ok(body.includes(input.methods));
  assert.ok(body.includes(input.discussion));
  assert.deepEqual(validateCornellNote(root, note.meta.id).problems, []);
});

test('complete C and C++ shift expressions are technical prose rather than unfinished templates', t => {
  const { root, input } = researchFixture(t);
  input.methods = '[source-reported] For an unsigned value within range, compare value << 2 >> 1 with an independently calculated result before compiling either implementation [S1].';
  const compiled = compileCornellResearch(root, input), note = createCornellNote(root, compiled.note);
  assert.ok(readFileSync(join(root, compiled.note.path), 'utf8').includes('value << 2 >> 1'));
  assert.deepEqual(validateCornellNote(root, note.meta.id).problems, []);
});

test('research and canonical note guards still reject actual unfinished markers and unexpanded templates', t => {
  const { root, input } = researchFixture(t), compiled = compileCornellResearch(root, input);
  for (const unfinished of [
    'placeholder', 'TODO: explain the mechanism later.', 'TODO explain this numeric interface later.',
    '# TBD: add the missing results.', 'Results: TBD', 'Insert here',
    'lorem ipsum is still unfinished sample content.', 'The measured result is {{result}}.',
    'The expected result is <placeholder>.', 'The result is [TODO: add independent reasoning].',
    '```js\n// TODO: complete the demonstration.\n```',
  ]) {
    assert.equal(cornellResearchSchema.safeParse({ ...input, methods: unfinished }).success, false, unfinished);
    assert.throws(() => createCornellNote(root, { ...compiled.note, main_notes: unfinished }), /placeholders/, unfinished);
  }
  assert.equal(existsSync(join(root, compiled.note.path)), false);
});

test('command-only and manual-only research preserve their canonical practice contracts', t => {
  const { root, input } = researchFixture(t), manual = compileCornellResearch(root, input);
  assert.equal(manual.note.practice.mode, 'manual');
  assert.deepEqual(manual.note.practice.procedure, input.practice.procedure);
  assert.equal(manual.note.practice.command, undefined);
  const { procedure, ...runnable } = input.practice;
  const command = ['node', 'independent-check.mjs'];
  const compiled = compileCornellResearch(root, { ...input, practice: { ...runnable, command } });
  assert.deepEqual(compiled.note.practice.command, command);
  assert.equal(compiled.note.practice.mode, undefined);
  assert.equal(compiled.note.practice.procedure, undefined);
  assert.equal(compiled.note.practice.exercise, manual.note.practice.exercise);
});

test('natural research claim labels compile to their declared canonical classifications without inventing a basis', t => {
  const { root, input } = researchFixture(t);
  input.methods = 'Observed: Read the saved requirement and independently enumerate the finite example [S1].';
  input.explanations[0].body = 'Source-reported: Each first-set element pairs with every second-set element [S1].';
  input.results = 'Expected: Three elements paired with two elements yield six distinct ordered pairs [S1].';
  input.discussion = 'Inferred: Finite enumeration supports this bounded example rather than every possible counting problem [S1].';
  const before = structuredClone(input), compiled = compileCornellResearch(root, input);
  assert.deepEqual(input, before);
  for (const [label, body] of [['observed', input.methods], ['source-reported', input.explanations[0].body],
    ['expected', input.results], ['inferred', input.discussion]])
    assert.ok(compiled.note.main_notes.includes(`[${label}]${body.slice(body.indexOf(':') + 1)}`));
  const note = createCornellNote(root, compiled.note);
  assert.deepEqual(validateCornellNote(root, note.meta.id).problems, []);
  const methods = z.toJSONSchema(cornellResearchSchema).properties.methods;
  assert.match(methods.description, /Observed:.*Source-reported:.*Expected:.*Inferred:/);
});

test('claim rendering preserves literal code, expected output, commands and unclassified prose', t => {
  const { root, input } = researchFixture(t);
  const fenced = '```text\nObserved: EXACT_STDOUT\nExpected: EXACT_EXPECTATION\n```';
  const indented = '    Inferred: INDENTED_LITERAL';
  input.methods = `Observed: Compare the explicit finite result with its source [S1].\n\n${fenced}\n\n${indented}\n\nThe literal \`Observed: VALUE\` is an example output.`;
  input.explanations[0].body = '    Expected: this indented code remains a literal rather than a classification.';
  input.worked_example.body = 'Observed: this example text is literal and remains unchanged.';
  input.worked_example.expected = 'Expected: this exact expected-output string must remain unchanged.';
  const compiled = compileCornellResearch(root, input);
  assert.ok(compiled.note.main_notes.includes(fenced));
  assert.ok(compiled.note.main_notes.includes(indented));
  assert.ok(compiled.note.main_notes.includes('The literal `Observed: VALUE` is an example output.'));
  assert.ok(compiled.note.main_notes.includes('\n\n    Expected: this indented code remains a literal rather than a classification.\n\n'));
  assert.ok(!compiled.note.main_notes.includes('[expected] this indented code'));
  assert.deepEqual(compiled.note.demonstration, input.worked_example);
  assert.deepEqual(compiled.note.practice.command, input.practice.command);
  const note = createCornellNote(root, compiled.note);
  assert.equal(validateCornellNote(root, note.meta.id).ok, true);
});

test('unlabeled narratives and unsupported observation claims still fail the canonical gates with exact syntax guidance', t => {
  for (const invalid of ['unlabeled', 'unsupported-label', 'code-only-label', 'observed-without-evidence']) {
    const { root, input } = researchFixture(t);
    if (invalid === 'observed-without-evidence') input.worked_example.observed = 'Observed: The claimed test passed, but no actual execution evidence was supplied.';
    else {
      input.methods = invalid === 'code-only-label' ? '```text\nObserved: example output only\n```' :
        `${invalid === 'unsupported-label' ? 'Measured: ' : ''}Read the finite example and count its entries [S1].`;
      input.explanations[0].body = 'Each first-set element pairs with every second-set element [S1].';
      input.results = 'Three elements paired with two elements produce six ordered pairs [S1].';
      input.discussion = 'This finite example does not establish every possible counting result [S1].';
    }
    const compiled = compileCornellResearch(root, input);
    assert.throws(() => createCornellNote(root, compiled.note), invalid === 'observed-without-evidence'
      ? /observed demonstration requires evidence record IDs/i : /\[observed\].*\[source-reported\].*\[expected\].*\[inferred\]/);
    assert.equal(existsSync(join(root, compiled.note.path)), false);
  }
});

test('trusted exact file-source approval permits canonical skill assets without relaxing output paths or private sources', t => {
  const { root, input } = researchFixture(t), source = '.agents/skills/research/assets/reference.md';
  mkdirSync(join(root, '.agents/skills/research/assets'), { recursive: true });
  const content = '# Finite research reference\nThe saved finite example has six ordered pairs.\n';
  writeFileSync(join(root, source), content);
  input.sources = [{ id: 'S1', title: 'Canonical finite research source', uri: source, retrieved_at: '2026-10-25T00:00:00Z' }];
  assert.throws(() => compileCornellResearch(root, input), /canonical visible/);
  assert.throws(() => compileCornellResearch(root, input, { approved_source_files: [source + '.other'] }), /canonical visible/);
  const policy = { approved_source_files: [source] }, compiled = compileCornellResearch(root, input, policy);
  assert.equal(compiled.note.sources[0].sha256, hash(content));
  assert.equal(compiled.note.sources[0].uri, source);
  assert.throws(() => compileCornellResearch(root, { ...input, output_dir: '.agents/research-output' }, policy), /canonical visible/);
  assert.throws(() => compileCornellResearch(root, { ...input, sources: [{ ...input.sources[0], uri: '.neomind/project.yaml' }] },
    { approved_source_files: ['.neomind/project.yaml'] }), /private|canonical visible/);
  for (const alias of ['.neomind./source.md', '.git /source.md', '.agents/skills/research/assets/reference.md ',
    '.agents/skills/research/assets/CON.md', '.agents/skills/research/assets/NUL', '.agents/skills/research/assets/com1.json',
    '.agents/skills/research/assets/reference.md:stream', '.agents/skills/research/assets/*.md'])
    assert.throws(() => compileCornellResearch(root, { ...input, sources: [{ ...input.sources[0], uri: alias }] },
      { approved_source_files: [alias] }), /Approved research sources must be canonical relative files/, alias);
  const note = createCornellNote(root, compiled.note);
  assert.equal(validateCornellNote(root, note.meta.id).ok, true);
  writeFileSync(join(root, source), content + 'A later change invalidates the earlier source baseline.\n');
  assert.equal(validateCornellNote(root, note.meta.id).ok, false, 'Approval never substitutes for current source freshness.');
});
