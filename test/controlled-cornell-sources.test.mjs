import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { researchFixture } from './cornell-research-fixture.mjs';
import { atomicWrite, createRecord, hash, loadRecords, safePath, updateRecord } from '../dist/storage.js';
import { runCheck, reviewRecord } from '../dist/engineering.js';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { controlledPublicReferencePath, controlledSkillInputPath } from '../dist/controlled-tools.js';
import { normalizeControlledCornellSources, existingControlledCornellNote, controlledCornellResult, bindControlledCornellPractice,
  bindControlledCornellDemonstration, controlledCornellResearchSchema } from '../dist/controlled-cornell-sources.js';

test('unobserved Cornell work needs no record identity, while actual observations bind only backend evidence', () => {
  const expected = { body: 'Walk the finite input through the algorithm.', expected: 'The expected scalar result is six.' };
  assert.deepEqual(bindControlledCornellDemonstration(expected, []), { ...expected, evidence_ids: [] });
  assert.throws(() => bindControlledCornellDemonstration({ ...expected, observed: 'The result was six.', evidence_ids: ['invented-id'] }, []),
    /Omit worked_example.observed and provide expected only/);
  assert.deepEqual(bindControlledCornellDemonstration({ ...expected, observed: 'The independent run returned six.', evidence_ids: ['invented-id'] }, ['actual-bound-evidence']),
    { ...expected, observed: 'The independent run returned six.', evidence_ids: ['actual-bound-evidence'] });
});

test('producer Cornell interface hides observations and defers only cached observation fields without altering professional content', () => {
  const professional = { body: 'Trace the finite inputs through the proposed procedure.', expected: 'The expected scalar result is six.',
    command: ['node', 'documented-example.mjs'] };
  const schema = controlledCornellResearchSchema(false), advertised = z.toJSONSchema(schema, { io: 'output' });
  assert.equal('observed' in advertised.properties.worked_example.properties, false);
  assert.equal('evidence_ids' in advertised.properties.worked_example.properties, false);
  assert.equal('observed' in z.toJSONSchema(controlledCornellResearchSchema(), { io: 'output' }).properties.worked_example.properties, true);
  for (const observed of ['not executed', 'omit this field', 'Đã đọc source; chưa chạy CLI.', 'Unsupported proposed success claim.', null, { guessed: true }]) {
    const cached = { ...professional, observed, evidence_ids: ['invented-cached-id'] };
    assert.deepEqual(schema.shape.worked_example.parse(cached), professional);
    assert.deepEqual(bindControlledCornellDemonstration(cached, ['old-or-current-backend-evidence'], false),
      { ...professional, evidence_ids: [] });
  }
  assert.throws(() => schema.shape.worked_example.parse({ ...professional, arbitrary_path: '../outside.md' }));
  assert.throws(() => bindControlledCornellDemonstration({ ...professional, observed: 'An actual run succeeded.' }, []));
  assert.deepEqual(bindControlledCornellDemonstration({ ...professional, observed: 'An actual run succeeded.', evidence_ids: ['invented'] }, ['current-evidence']),
    { ...professional, observed: 'An actual run succeeded.', evidence_ids: ['current-evidence'] });
});

test('advertised Cornell authoring schema names canonical source paths and an explicit truthful claim citation without inventing either', () => {
  const advertised = z.toJSONSchema(controlledCornellResearchSchema(false, false), { io: 'output' });
  const source = advertised.properties.sources.items.properties;
  assert.match(source.uri.description, /exact canonical project-relative path returned by project_read/);
  for (const rejectedForm of ['file:', 'drive prefix', 'leading ./', 'backslashes', '#line fragment'])
    assert.ok(source.uri.description.includes(rejectedForm), rejectedForm);
  assert.match(source.uri.description, /line references in locator/);
  assert.equal('record_id' in source, false); assert.equal('sha256' in source, false);
  assert.ok(advertised.properties.methods.description.includes('[source-reported] The inspected implementation rejects unsafe integers [S1].'));
  assert.match(advertised.properties.methods.description, /Select the truthful claim basis yourself; the backend never invents it/);
  const arms = advertised.properties.practice.anyOf ?? advertised.properties.practice.oneOf;
  assert.equal(arms.length, 2);
  assert.ok(arms.some(arm => arm.required?.includes('command')));
  assert.ok(arms.some(arm => arm.required?.includes('procedure')));
});

test('unplanned starter policy hides only starter and cached paths while preserving both practice modes', () => {
  const practice = { questions: [{ id: 'P1', prompt: 'Enumerate the finite ordered pairs independently.', objective_ids: ['O1'],
    answer: 'Each first-set element pairs with every second-set element.' }], command: ['node', 'practice-check.mjs'],
  procedure: ['List the finite input elements and enumerate every ordered pair.'] };
  const schema = controlledCornellResearchSchema(false, false),
    advertised = z.toJSONSchema(schema, { io: 'output' }).properties.practice;
  const arms = advertised.anyOf ?? advertised.oneOf;
  assert.equal(arms.length, 2);
  for (const arm of arms) {
    assert.equal('starter' in arm.properties, false); assert.equal('solution_path' in arm.properties, false);
  }
  const { command: _command, ...manual } = practice, { procedure: _procedure, ...runnable } = practice;
  for (const semantic of [practice, manual, runnable]) for (const starter of ['# Unplanned learner worksheet\n', null, { cached: true }]) {
    const supplied = { ...semantic, starter, solution_path: '../unplanned-answers.md' };
    assert.deepEqual(schema.shape.practice.parse(supplied), semantic);
    assert.deepEqual(bindControlledCornellPractice(supplied, 'docs/fixed-cornell', false), semantic);
  }
  assert.throws(() => schema.shape.practice.parse({ ...practice, arbitrary_path: '../outside.md' }));
  const starter = '# Explicitly allowed independent learner worksheet\n';
  assert.deepEqual(bindControlledCornellPractice({ ...practice, starter, solution_path: '../untrusted.md' }, 'docs/fixed-cornell'),
    { ...practice, starter, solution_path: 'docs/fixed-cornell/practice-solution.md' });
});

const template = '.agents/skills/leetcode-notes/assets/cornell-note-template.md';
test('public Cornell and controlled entry modules initialize in fresh processes regardless of import order', () => {
  for (const modules of [['cornell-workflow', 'controlled-tools', 'index'], ['index', 'cornell-workflow', 'controlled-tools']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `for(const name of ${JSON.stringify(modules)}) await import('./dist/'+name+'.js'); console.log('imports-ready');`],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /imports-ready/);
  }
});
function fixture(t) {
  const a = researchFixture(t);
  atomicWrite(safePath(a.root, 'scripts/README-leetcode.md'), '# Actual source for six finite ordered pairs\n');
  atomicWrite(safePath(a.root, 'scripts/leetcode-exercise.mjs'), 'export const pairs = 6;\n');
  atomicWrite(safePath(a.root, template), '# Canonical Cornell research template\n');
  const task = createRecord(a.root, { type: 'task', title: 'Independently inspect the finite pair count', owner: 'developer',
    data: { workflow_id: a.workflow.meta.id }, links: [{ type: 'satisfies', target: a.requirement.meta.id }] });
  const check = createRecord(a.root, { type: 'check', title: 'Verify the actual six pairs', owner: 'verifier', status: 'ready',
    data: { workflow_id: a.workflow.meta.id, task_id: task.meta.id, baseline_paths: ['scripts/leetcode-exercise.mjs'],
      command: [process.execPath, '--input-type=module', '-e', 'import assert from "node:assert/strict"; import {pairs} from "./scripts/leetcode-exercise.mjs"; assert.equal(pairs,6); console.log("six independent pairs");'] },
    links: [{ type: 'verifies', target: a.requirement.meta.id }] });
  reviewRecord(a.root, check.meta.id, 'reviewer', 'pass', [], 'actual-source-fixture-check-review');
  const evidence = [runCheck(a.root, check.meta.id, task.meta.id), runCheck(a.root, check.meta.id, task.meta.id)];
  assert.ok(evidence.every(record => record.meta.data.result === 'pass'));
  const context = { workflow_id: a.workflow.meta.id, epoch_id: randomUUID(), task_id: task.meta.id,
    requirement_ids: [a.requirement.meta.id], evidence: evidence.map(record => ({ evidence_id: record.meta.id, log_path: record.meta.data.log_path })),
    file_allowed: path => controlledPublicReferencePath(path) || path === template && controlledSkillInputPath(path) };
  return { ...a, task, evidence, context };
}
function captured(a) {
  // Sanitized actual request pattern: an unrelated real EVD and a zero hash were
  // attached to README/template sources by the model. URI authority must win.
  return [
    { id: 'S1', title: 'Generator README source', uri: 'scripts/README-leetcode.md', record_id: a.evidence[0].meta.id, sha256: '0'.repeat(64), retrieved_at: 'invented' },
    { id: 'S2', title: 'Canonical Cornell template', uri: template, record_id: 'invented-template-description', sha256: '0'.repeat(64), retrieved_at: 'invented' },
    { id: 'S3', title: 'Current original check evidence', uri: a.evidence[0].meta.data.log_path, record_id: a.evidence[1].meta.id, sha256: '0'.repeat(64), retrieved_at: 'invented' },
  ];
}
function compile(a, sources) {
  return compileCornellResearch(a.root, { ...a.input, task_id: a.task.meta.id, sources: sources.sources,
    worked_example: { ...a.input.worked_example, observed: 'The independent command printed six pairs and exited successfully.',
      evidence_ids: a.evidence.map(record => record.meta.id) } }, { approved_source_files: sources.approved_source_files });
}
function expectedPrimary(t) {
  const a = researchFixture(t);
  const task = createRecord(a.root, { type: 'task', title: 'Produce the primary expected Cornell bundle', owner: 'developer',
    data: { workflow_id: a.workflow.meta.id }, links: [{ type: 'satisfies', target: a.requirement.meta.id }] });
  const context = { workflow_id: a.workflow.meta.id, epoch_id: randomUUID(), task_id: task.meta.id,
    requirement_ids: [a.requirement.meta.id], evidence: [], file_allowed: () => false };
  const compileExpected = () => {
    const normalized = normalizeControlledCornellSources(a.root, a.input.sources, context);
    return compileCornellResearch(a.root, { ...a.input, task_id: task.meta.id, sources: normalized.sources,
      worked_example: bindControlledCornellDemonstration(a.input.worked_example, []) },
    { approved_source_files: normalized.approved_source_files });
  };
  return { ...a, task, context, compileExpected };
}

test('three-artifact primary compilation cannot create an unplanned fourth learner worksheet', t => {
  const a = expectedPrimary(t), normalized = normalizeControlledCornellSources(a.root, a.input.sources, a.context),
    practice = bindControlledCornellPractice(a.input.practice, a.input.output_dir, false);
  const compiled = compileCornellResearch(a.root, { ...a.input, task_id: a.task.meta.id, practice, sources: normalized.sources,
    worked_example: bindControlledCornellDemonstration(a.input.worked_example, [], false) },
  { approved_source_files: normalized.approved_source_files });
  const note = createCornellNote(a.root, compiled.note);
  assert.equal(validateCornellNote(a.root, note.meta.id).ok, true);
  assert.equal(Object.keys(note.meta.data.artifact_hashes).length, 3);
  assert.equal(compiled.note.practice.solution_path, undefined);
  assert.equal(existsSync(safePath(a.root, `${a.input.output_dir}/practice-solution.md`)), false);
  assert.deepEqual(practice.questions, a.input.practice.questions);
  assert.deepEqual(practice.procedure, a.input.practice.procedure);
});

test('persisted expected-only primary Cornell bundle replays after a lost response without new evidence or artifact writes', t => {
  const a = expectedPrimary(t), compiled = a.compileExpected(), note = createCornellNote(a.root, compiled.note);
  assert.equal(validateCornellNote(a.root, note.meta.id).ok, true);
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined, 'An unjournaled note remains an uncertain cutpoint.');
  a.context.saved_results = JSON.parse(JSON.stringify([controlledCornellResult(compiled, note)]));
  const before = loadRecords(a.root).length, paths = Object.keys(note.meta.data.artifact_hashes);
  const bytes = paths.map(path => readFileSync(safePath(a.root, path)));
  const repeated = a.compileExpected();
  assert.equal(repeated.input_hash, compiled.input_hash);
  assert.deepEqual(repeated.note.demonstration.evidence_ids, []);
  assert.equal(repeated.note.demonstration.observed, undefined);
  assert.equal(existingControlledCornellNote(a.root, repeated, a.context)?.meta.id, note.meta.id);
  assert.equal(loadRecords(a.root).length, before);
  paths.forEach((path, index) => assert.deepEqual(readFileSync(safePath(a.root, path)), bytes[index]));
  assert.match(readFileSync(safePath(a.root, compiled.note.path), 'utf8'), /has not been executed; no observed result is claimed/);
});

test('expected-only primary replay rejects changed artifacts and changed record fingerprints without overwriting them', t => {
  const a = expectedPrimary(t), compiled = a.compileExpected(), note = createCornellNote(a.root, compiled.note);
  a.context.saved_results = [controlledCornellResult(compiled, note)];
  const path = safePath(a.root, compiled.note.path), original = readFileSync(path);
  writeFileSync(path, 'Independent user note edit must survive.\n');
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined);
  assert.equal(readFileSync(path, 'utf8'), 'Independent user note edit must survive.\n');
  writeFileSync(path, original);
  updateRecord(a.root, note.meta.id, {}, `${note.body}\nIndependent record correction.\n`);
  assert.equal(validateCornellNote(a.root, note.meta.id).ok, true, 'Artifact structure alone does not authorize a changed record.');
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined);
  assert.deepEqual(readFileSync(path), original);
});

test('cached note or demonstration IDs cannot authorize expected-primary or stale-observed replay', t => {
  const a = expectedPrimary(t), compiled = a.compileExpected(), note = createCornellNote(a.root, compiled.note);
  const saved = controlledCornellResult(compiled, note);
  a.context.saved_results = [{ ...saved, note_id: 'invented-cached-note-id' }];
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined);
  a.context.saved_results = [{ ...saved, record_fingerprint: '0'.repeat(64) }];
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined);
  a.context.saved_results = [saved];
  assert.equal(existingControlledCornellNote(a.root, compiled, { ...a.context,
    evidence: [{ evidence_id: 'invented-cached-evidence-id', log_path: '.neomind/controlled/checks/foreign.log' }] }), undefined);
  assert.deepEqual(bindControlledCornellDemonstration({ ...a.input.worked_example, evidence_ids: ['invented-cached-evidence-id'] }, []).evidence_ids, []);
  const actual = fixture(t), observed = compile(actual, normalizeControlledCornellSources(actual.root, captured(actual), actual.context));
  const observedNote = createCornellNote(actual.root, observed.note);
  actual.context.saved_results = [controlledCornellResult(observed, observedNote)];
  assert.equal(existingControlledCornellNote(actual.root, observed, actual.context)?.meta.id, observedNote.meta.id);
  assert.equal(existingControlledCornellNote(actual.root, observed, { ...actual.context, evidence: [] }), undefined,
    'Historical observed evidence is not current evidence for an expected-only producer context.');
});

test('captured file/EVD misattribution becomes honest current provenance and persists a valid Cornell note', t => {
  const a = fixture(t), original = captured(a), before = structuredClone(original);
  const normalized = normalizeControlledCornellSources(a.root, original, a.context);
  assert.deepEqual(original, before);
  const file = normalized.sources.find(source => source.id === 'S1'), hidden = normalized.sources.find(source => source.id === 'S2');
  assert.equal(file.record_id, undefined); assert.equal(file.sha256, hash(readFileSync(safePath(a.root, file.uri))));
  assert.equal(hidden.record_id, undefined); assert.equal(hidden.sha256, hash(readFileSync(safePath(a.root, template))));
  const log = normalized.sources.find(source => source.id === 'S3');
  assert.equal(log.uri, `record:${a.evidence[0].meta.id}`); assert.equal(log.record_id, a.evidence[0].meta.id);
  assert.ok(normalized.sources.some(source => source.record_id === a.evidence[1].meta.id && /Backend-added/.test(source.locator)));
  assert.equal(new Set(normalized.sources.map(source => source.id)).size, normalized.sources.length);
  const compiled = compile(a, normalized), note = createCornellNote(a.root, compiled.note);
  assert.deepEqual(validateCornellNote(a.root, note.meta.id).problems, []);
  assert.equal(note.meta.data.sources.find(source => source.id === 'S1').record_id, undefined);
  assert.equal(note.meta.data.sources.find(source => source.id === 'S2').record_id, undefined);
});

test('source observation timestamps are stable for retries and fresh bytes invalidate the observation identity', async t => {
  const a = fixture(t), first = normalizeControlledCornellSources(a.root, captured(a), a.context);
  await new Promise(resolve => setTimeout(resolve, 10));
  const repeated = normalizeControlledCornellSources(a.root, captured(a).map(source => ({ ...source, record_id: 'different untrusted metadata', retrieved_at: 'different', sha256: 'f'.repeat(64) })), a.context);
  assert.deepEqual(repeated, first);
  assert.equal(compile(a, first).input_hash, compile(a, repeated).input_hash);
  await new Promise(resolve => setTimeout(resolve, 10));
  atomicWrite(safePath(a.root, 'scripts/README-leetcode.md'), '# A changed actual README source\n');
  const changed = normalizeControlledCornellSources(a.root, captured(a), a.context);
  assert.notEqual(changed.sources[0].sha256, first.sources[0].sha256);
  assert.notEqual(changed.sources[0].retrieved_at, first.sources[0].retrieved_at);
});

test('current record citations reject foreign/private/unapproved sources and never fabricate fetched URL proof', t => {
  const a = fixture(t), one = uri => [{ id: 'S1', title: 'A bounded source citation', uri }];
  const foreign = createRecord(a.root, { type: 'knowledge', title: 'Foreign source record', data: { workflow_id: 'another-workflow' } });
  for (const uri of [`record:${foreign.meta.id}`, `record:${a.workflow.meta.id}`, `record:${a.task.meta.id}`, '.neomind/controlled/checks/foreign.log', '.neomind/config.json',
    '.agents/skills/other/assets/not-approved.md', '.neomind./config.json', '.vscode /settings.json', 'scripts/CON.txt',
    '../outside.md', 'https://user:password@example.com/reference'])
    assert.throws(() => normalizeControlledCornellSources(a.root, one(uri), a.context));
  const external = normalizeControlledCornellSources(a.root, [{ ...one('HTTPS://EXAMPLE.COM/reference')[0], locator: 'a'.repeat(1000),
    record_id: a.evidence[0].meta.id, sha256: '0'.repeat(64), retrieved_at: 'invented' }], a.context).sources[0];
  assert.equal(external.record_id, undefined); assert.equal(external.sha256, undefined);
  assert.equal(external.uri, 'https://example.com/reference');
  assert.match(external.locator, /not fetched or verified/); assert.ok(external.locator.length <= 1000);
});

test('a full semantic ledger stays within the advertised limit while demonstration evidence remains bound', t => {
  const a = fixture(t), normalized = normalizeControlledCornellSources(a.root,
    Array.from({ length: 64 }, (_, index) => ({ id: `S${index + 1}`, title: `Referenced finite source ${index + 1}`,
      uri: `https://example.com/reference/${index + 1}` })), a.context);
  assert.equal(normalized.sources.length, 64);
  assert.equal(normalized.sources.some(source => source.record_id), false, 'Optional ledger additions never displace semantic citations.');
  const compiled = compile(a, normalized);
  assert.deepEqual(compiled.note.demonstration.evidence_ids, a.evidence.map(record => record.meta.id));
});

test('lost response reconciles only the exact current validated Cornell record and never overwrites a conflict', t => {
  const a = fixture(t), normalized = normalizeControlledCornellSources(a.root, captured(a), a.context), compiled = compile(a, normalized);
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined);
  const note = createCornellNote(a.root, compiled.note), count = loadRecords(a.root).length;
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined,
    'A note created before the runtime result was journaled is preserved as an uncertain cutpoint, not silently adopted.');
  a.context.saved_results = [controlledCornellResult(compiled, note)];
  const paths = Object.keys(note.meta.data.artifact_hashes), bytes = paths.map(path => readFileSync(safePath(a.root, path)));
  const repeated = compile(a, normalizeControlledCornellSources(a.root, captured(a), a.context));
  assert.equal(existingControlledCornellNote(a.root, repeated, a.context).meta.id, note.meta.id);
  assert.equal(loadRecords(a.root).length, count);
  paths.forEach((path, index) => assert.deepEqual(readFileSync(safePath(a.root, path)), bytes[index]));
  const different = compileCornellResearch(a.root, { ...a.input, topic: 'Changed semantic research request', sources: normalized.sources },
    { approved_source_files: normalized.approved_source_files });
  assert.equal(existingControlledCornellNote(a.root, different, a.context), undefined);
  writeFileSync(safePath(a.root, compiled.note.path), 'User edited the existing note.\n');
  assert.equal(existingControlledCornellNote(a.root, repeated, a.context), undefined);
  assert.throws(() => createCornellNote(a.root, repeated.note));
  assert.equal(readFileSync(safePath(a.root, compiled.note.path), 'utf8'), 'User edited the existing note.\n');
  assert.ok(existsSync(safePath(a.root, compiled.note.practice.exercise_path)));
});

test('a valid changed-content note retaining a copied input hash is never adopted as the compiler result', t => {
  const a = fixture(t), compiled = compile(a, normalizeControlledCornellSources(a.root, captured(a), a.context));
  const changed = { ...compiled.note, main_notes: `${compiled.note.main_notes}\n\n[inferred] Additional interpretation changes the delivered narrative [S1].` };
  const note = createCornellNote(a.root, changed);
  assert.equal(note.meta.data.research.input_hash, compiled.input_hash);
  assert.equal(validateCornellNote(a.root, note.meta.id).ok, true);
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined);
  a.context.saved_results = [{ ...controlledCornellResult(compiled, note), record_fingerprint: '0'.repeat(64) }];
  assert.equal(existingControlledCornellNote(a.root, compiled, a.context), undefined, 'A changed record cannot match a saved runtime fingerprint.');
});

test('captured and escaped learner paths can only create a backend-scoped worksheet', t => {
  const a = fixture(t), sources = normalizeControlledCornellSources(a.root, captured(a), a.context);
  atomicWrite(safePath(a.root, 'answers.md'), 'Existing unrelated learner answers must remain unchanged.\n');
  const outside = join(dirname(a.root), `outside-${randomUUID()}.md`), privatePath = '.neomind/not-authorized.md';
  const attempts = ['answers.md', `../${outside.split(/[\\/]/).at(-1)}`, privatePath, outside];
  const starter = '# Learner reasoning\nEnumerate the ordered pairs and explain the result.\n';
  for (const [index, solution_path] of attempts.entries()) {
    const directory = `docs/research/scoped-${index}`;
    const semantic = { ...a.input.practice, command: ['node', 'documented-checker.mjs'], solution_path, starter };
    const practice = bindControlledCornellPractice(semantic, directory);
    assert.equal(practice.solution_path, `${directory}/practice-solution.md`);
    assert.deepEqual(practice.command, semantic.command); assert.deepEqual(practice.procedure, semantic.procedure);
    assert.deepEqual(practice.questions, semantic.questions); assert.equal(practice.starter, starter);
    const compiled = compile({ ...a, input: { ...a.input, output_dir: directory, practice } }, sources);
    const note = createCornellNote(a.root, compiled.note);
    assert.equal(validateCornellNote(a.root, note.meta.id).ok, true);
    assert.equal(readFileSync(safePath(a.root, practice.solution_path), 'utf8'), starter);
    assert.equal(readFileSync(safePath(a.root, 'answers.md'), 'utf8'), 'Existing unrelated learner answers must remain unchanged.\n');
    assert.equal(existsSync(outside), false);
    assert.equal(existsSync(safePath(a.root, privatePath)), false);
  }
});

test('cached path alone is ignored and an existing scoped learner solution is preserved', t => {
  const a = fixture(t), { starter: _starter, ...semantic } = a.input.practice;
  const omitted = bindControlledCornellPractice({ ...semantic, solution_path: 'answers.md' }, a.input.output_dir);
  assert.equal(omitted.solution_path, undefined); assert.equal(omitted.starter, undefined);
  const sources = normalizeControlledCornellSources(a.root, captured(a), a.context),
    practice = bindControlledCornellPractice({ ...a.input.practice, solution_path: '../outside.md', starter: '# New suggested starter\n' }, a.input.output_dir);
  atomicWrite(safePath(a.root, practice.solution_path), 'My existing independent solution must survive.\n');
  const compiled = compile({ ...a, input: { ...a.input, practice } }, sources), note = createCornellNote(a.root, compiled.note);
  assert.equal(validateCornellNote(a.root, note.meta.id).ok, true);
  assert.equal(readFileSync(safePath(a.root, practice.solution_path), 'utf8'), 'My existing independent solution must survive.\n');
});
