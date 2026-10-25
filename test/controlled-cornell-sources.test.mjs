import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { researchFixture } from './cornell-research-fixture.mjs';
import { atomicWrite, createRecord, hash, loadRecords, safePath } from '../dist/storage.js';
import { runCheck, reviewRecord } from '../dist/engineering.js';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { controlledPublicReferencePath, controlledSkillInputPath } from '../dist/controlled-tools.js';
import { normalizeControlledCornellSources, existingControlledCornellNote, controlledCornellResult } from '../dist/controlled-cornell-sources.js';

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
