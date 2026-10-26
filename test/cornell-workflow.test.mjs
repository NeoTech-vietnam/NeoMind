import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { updateRecord } from '../dist/storage.js';
import { researchFixture } from './cornell-research-fixture.mjs';
import { reviewRecord, startTask } from '../dist/engineering.js';
import { runRecipe } from '../dist/recipes.js';
import { createCornellNote, reviseCornellNote, validateCornellNote } from '../dist/notes.js';
import { compileCornellResearch, prepareCornellResearch, readCornellDestination, configureCornellDestination,
  prepareCornellExport, applyCornellExport, readCornellExportPlan, verifiedCornellExport } from '../dist/cornell-workflow.js';

export function reviewedResearch(t) {
  const work = researchFixture(t), compiled = compileCornellResearch(work.root, work.input);
  const note = createCornellNote(work.root, compiled.note);
  reviewRecord(work.root, note.meta.id, 'reviewer', 'pass', [], 'independent-research-review');
  configureCornellDestination(work.root, { notes_root: work.notesRoot });
  return { ...work, compiled, note };
}

test('structured research compiles deterministically into the authoritative Cornell engine and separate questions/answers', t => {
  const { root, input } = researchFixture(t);
  const one = compileCornellResearch(root, input), two = compileCornellResearch(root, structuredClone(input));
  assert.deepEqual(one, two);
  const note = createCornellNote(root, one.note), body = readFileSync(join(root, one.note.path), 'utf8');
  assert.equal(validateCornellNote(root, note.meta.id).ok, true);
  for (const heading of ['Abstract', 'Learning Objectives', 'Methods', 'Results', 'Discussion', 'Research Questions']) assert.match(body, new RegExp(`#{2,3} ${heading}`));
  assert.match(body, /completion is not claimed/);
  assert.doesNotMatch(readFileSync(join(root, one.note.practice.exercise_path), 'utf8'), /There are eight ordered pairs/);
  assert.match(readFileSync(join(root, one.note.practice.answer_path), 'utf8'), /## Q1[\s\S]*## P1/);
  assert.equal(one.note.demonstration.observed, undefined);
});

test('the core note engine independently checks research fingerprint, objective identity and practice mode', t => {
  const { root, input } = researchFixture(t), compiled = compileCornellResearch(root, input);
  for (const mutate of [
    note => { note.research.requirement_fingerprint = '0'.repeat(64); },
    note => { note.research.learning_objectives.push(note.research.learning_objectives[0]); },
    note => { note.practice.mode = 'invented'; },
  ]) {
    const note = structuredClone(compiled.note); mutate(note);
    assert.throws(() => createCornellNote(root, note), /requirement|objective|Practice mode/);
  }
  assert.equal(existsSync(join(root, compiled.note.path)), false);
});

test('research preparation reuses the real reviewed Cornell recipe and its generated note', t => {
  const { root, input } = researchFixture(t);
  const prepared = prepareCornellResearch(root, input), instance = prepared.recipe_instance;
  assert.equal(prepareCornellResearch(root, input).recipe_instance.meta.id, instance.meta.id);
  reviewRecord(root, instance.meta.data.design_id, 'reviewer', 'pass', [], 'design-review');
  reviewRecord(root, instance.meta.data.check_id, 'reviewer', 'pass', [], 'check-review');
  startTask(root, instance.meta.data.task_id, 'source-backed-worker', undefined, 'reported-worker');
  const generated = runRecipe(root, instance.meta.id);
  assert.equal(generated.evidence.meta.data.result, 'pass');
  const reused = prepareCornellResearch(root, input);
  assert.equal(reused.status, 'reused');
  assert.equal(reused.existing_note_id, generated.note.meta.id);
});

test('unknown fields, unmapped objectives, duplicate question IDs, missing answers and stale/foreign requirements refuse preparation', t => {
  const { root, input, requirement } = researchFixture(t);
  const cases = [
    { ...input, invented: true }, { ...input, expected_requirement_revision: requirement.meta.revision + 1 },
    { ...input, learning_objectives: [...input.learning_objectives, { id: 'O2', text: 'Explain a second independent counting mechanism.' }] },
    { ...input, questions: [input.questions[0], input.questions[0]] },
    { ...input, questions: [{ ...input.questions[0], objective_ids: ['O2'] }] },
    { ...input, questions: [{ ...input.questions[0], answer: '' }] },
    { ...input, results: '[source-reported] An unknown source establishes the result [S9].' },
    { ...input, workflow_id: 'OTHER-KNW-0001' }, { ...input, output_dir: '../outside' },
  ];
  for (const value of cases) assert.throws(() => compileCornellResearch(root, value));
  assert.equal(existsSync(join(root, input.output_dir)), false);
});

test('local export defaults are portable and preview leaves the configured notes repository untouched', t => {
  const work = reviewedResearch(t);
  assert.equal(readCornellDestination(work.root).directory, '00_note/NeoMind');
  const plan = prepareCornellExport(work.root, { note_id: work.note.meta.id, expected_revision: work.note.meta.revision });
  assert.equal(plan.status, 'ready');
  assert.equal(existsSync(join(work.notesRoot, '00_note')), false);
  assert.deepEqual(readCornellExportPlan(work.root, plan.plan_hash), plan);
  assert.ok(plan.files.some(file => file.path.endsWith('/exercises.md')) && plan.files.some(file => file.path.endsWith('/answers.md')));
});

test('explicit attachments cannot collide with generated bundle entry or provenance paths', t => {
  const work = reviewedResearch(t);
  for (const reserved of ['README.md', 'provenance.json']) {
    writeFileSync(join(work.root, reserved), 'Authored attachment remains untouched.');
    assert.throws(() => prepareCornellExport(work.root, { note_id: work.note.meta.id,
      expected_revision: work.note.meta.revision, include_paths: [reserved] }), /duplicate|collid|reserved/i);
    assert.equal(readFileSync(join(work.root, reserved), 'utf8'), 'Authored attachment remains untouched.');
  }
  assert.equal(existsSync(join(work.notesRoot, '00_note')), false);
});

test('an unreviewed note gives a concrete blocked preview, not permission to copy or an empty success', t => {
  const work = researchFixture(t), compiled = compileCornellResearch(work.root, work.input);
  const note = createCornellNote(work.root, compiled.note);
  const plan = prepareCornellExport(work.root, { note_id: note.meta.id, expected_revision: note.meta.revision });
  assert.equal(plan.status, 'blocked'); assert.ok(plan.files.length >= 3);
  assert.match(plan.problems.join(' '), /independent note review/);
  assert.throws(() => applyCornellExport(work.root, { plan_hash: plan.plan_hash }));
  assert.equal(existsSync(join(work.root, '00_note')), false);
});

test('apply verifies exact bytes, preserves authored solutions and unrelated notes, and is idempotent', t => {
  const work = reviewedResearch(t), solution = join(work.root, work.compiled.note.practice.solution_path);
  writeFileSync(solution, '# My authored answer\nKeep this private reasoning unchanged.\n');
  mkdirSync(join(work.notesRoot, '00_note/NeoMind'), { recursive: true });
  writeFileSync(join(work.notesRoot, '00_note/NeoMind/my-note.md'), '# My existing notes\n');
  const plan = prepareCornellExport(work.root, { note_id: work.note.meta.id, expected_revision: work.note.meta.revision });
  assert.equal(plan.status, 'ready');
  const applied = applyCornellExport(work.root, { plan_hash: plan.plan_hash });
  assert.equal(applied.status, 'completed');
  assert.deepEqual(applyCornellExport(work.root, { plan_hash: plan.plan_hash }), applied);
  assert.equal(verifiedCornellExport(work.root, plan.plan_hash).plan.plan_hash, plan.plan_hash);
  assert.match(readFileSync(solution, 'utf8'), /private reasoning/);
  assert.equal(readFileSync(join(work.notesRoot, '00_note/NeoMind/my-note.md'), 'utf8'), '# My existing notes\n');
  assert.ok(plan.files.every(file => !file.path.endsWith('my-solution.md')));
  assert.doesNotMatch(JSON.stringify(plan.files.map(file => Buffer.from(file.content_base64, 'base64').toString('utf8'))), /private reasoning/);
});

test('an interrupted owned export resumes exact bytes and refuses authored edits before adding other files', t => {
  for (const changed of [false, true]) {
    const work = reviewedResearch(t), plan = prepareCornellExport(work.root, { note_id: work.note.meta.id, expected_revision: work.note.meta.revision });
    const receiptPath = join(work.root, '.neomind/cornell-exports/receipts', `${plan.plan_hash}.json`);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({ schema_version: 1, plan_hash: plan.plan_hash, note_id: work.note.meta.id,
      status: 'writing', files: plan.files.map(file => ({ path: file.path, sha256: file.sha256 })) }));
    const first = plan.files[0], path = join(work.notesRoot, first.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, changed ? 'My edited partial copy stays here.' : Buffer.from(first.content_base64, 'base64'));
    if (changed) {
      assert.throws(() => applyCornellExport(work.root, { plan_hash: plan.plan_hash }), /changed target/);
      assert.equal(readFileSync(path, 'utf8'), 'My edited partial copy stays here.');
      assert.equal(existsSync(join(work.notesRoot, plan.files[1].path)), false);
    } else {
      assert.equal(applyCornellExport(work.root, { plan_hash: plan.plan_hash }).status, 'completed');
      assert.equal(verifiedCornellExport(work.root, plan.plan_hash).receipt.status, 'completed');
    }
  }
});

test('changed target notes, source notes, requirement or destination invalidate an export plan without overwriting', t => {
  for (const change of ['target', 'source', 'requirement', 'destination']) {
    const work = reviewedResearch(t), plan = prepareCornellExport(work.root, { note_id: work.note.meta.id, expected_revision: work.note.meta.revision });
    applyCornellExport(work.root, { plan_hash: plan.plan_hash });
    if (change === 'target') writeFileSync(join(work.notesRoot, plan.files[0].path), 'My edited target must remain.');
    if (change === 'source') writeFileSync(join(work.root, work.compiled.note.path), 'My edited source must remain.');
    if (change === 'requirement') updateRecord(work.root, work.requirement.meta.id, { body: 'A different counting requirement changes the evidence baseline.' });
    if (change === 'destination') configureCornellDestination(work.root, { directory: '00_note/Other' });
    assert.throws(() => applyCornellExport(work.root, { plan_hash: plan.plan_hash }), /changed|Preserve|current/);
    if (change === 'target') assert.equal(readFileSync(join(work.notesRoot, plan.files[0].path), 'utf8'), 'My edited target must remain.');
  }
});

test('path traversal, linked destinations and stale note revisions cannot publish a local copy', t => {
  const work = reviewedResearch(t);
  assert.throws(() => configureCornellDestination(work.root, { directory: '../escape' }));
  assert.throws(() => prepareCornellExport(work.root, { note_id: work.note.meta.id, expected_revision: work.note.meta.revision + 1 }));
  const alias = join(work.notesRoot, 'alias');
  symlinkSync(work.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => configureCornellDestination(work.root, { directory: 'alias/notes' }), /link|escapes/);
});

test('research revisions preserve old artifacts and learner solutions through the existing note revision engine', t => {
  const work = reviewedResearch(t), original = readFileSync(join(work.root, work.compiled.note.path));
  const solution = join(work.root, work.compiled.note.practice.solution_path);
  writeFileSync(solution, 'My independent learner solution remains untouched.');
  const replacement = structuredClone(work.compiled.note);
  replacement.research.abstract += ' The expanded explanation retains the original counting assumptions.';
  replacement.summary += ' Review the expanded explanation before applying it elsewhere.';
  const revised = reviseCornellNote(work.root, work.note.meta.id, replacement, work.note.meta.revision, 'Improve the research abstract while preserving the prior learning artifacts.');
  assert.equal(revised.meta.data.revision_history.length, 1);
  const artifact = revised.meta.data.revision_history[0].artifacts[replacement.path];
  assert.deepEqual(readFileSync(join(work.root, artifact.history_path)), original);
  assert.equal(readFileSync(solution, 'utf8'), 'My independent learner solution remains untouched.');
});
