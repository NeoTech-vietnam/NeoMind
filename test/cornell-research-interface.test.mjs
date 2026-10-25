import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { cornellResearchSchema, compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
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
