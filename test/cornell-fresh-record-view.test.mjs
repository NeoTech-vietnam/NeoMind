import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { initialize, createRecord, loadRecords, atomicWrite, safePath, now } from '../dist/storage.js';
import { runCheck } from '../dist/engineering.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { cornellFixture } from './cornell-fixture.mjs';

function fixture(t, padding = 0) {
  const parent = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(parent, 'neomind-cornell-record-view-')));
  t.after(() => { assert.equal(dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  initialize(root, { project_id: 'NOTE-READS' });
  fs.mkdirSync(join(root, 'src')); fs.writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  const requirement = createRecord(root, { type: 'requirement', title: 'Observed scalar contract',
    body: 'The named scalar export must equal integer one.', data: { acceptance_criteria: ['The export equals integer one.'] } });
  const task = createRecord(root, { type: 'task', title: 'Inspect observed scalar', links: [{ type: 'satisfies', target: requirement.meta.id }] });
  const check = createRecord(root, { type: 'check', title: 'Independent local scalar check', links: [{ type: 'verifies', target: requirement.meta.id }],
    data: { command: [process.execPath, '--input-type=module', '-e', 'import assert from "node:assert/strict"; import {value} from "./src/value.mjs"; assert.equal(value,1); console.log(value)'],
      baseline_paths: ['src/value.mjs'] } });
  const evidence = [runCheck(root, check.meta.id, task.meta.id), runCheck(root, check.meta.id, task.meta.id)];
  assert.ok(evidence.every(record => record.meta.data.result === 'pass'), 'Fixture evidence comes from actual local subprocess checks.');
  const input = cornellFixture(undefined, requirement.meta.id), sources = [requirement, check, task, ...evidence];
  input.sources = sources.map((record, index) => ({ id: `S${index + 1}`, title: `Saved scalar source ${index + 1}`,
    uri: `https://example.com/scalar-source-${index + 1}`, record_id: record.meta.id, retrieved_at: '2026-10-25T00:00:00Z' }));
  input.main_notes = '[source-reported] Saved records define the scalar contract and its independent check [S1] [S2] [S3]. [observed] Both actual local executions passed against the same scalar baseline [S4] [S5].';
  input.demonstration.observed = 'Two actual local Node subprocesses checked the scalar and exited successfully.';
  input.demonstration.evidence_ids = evidence.map(record => record.meta.id);
  const note = createCornellNote(root, input);
  // Add ordinary authoritative bytes directly so the performance fixture does
  // not itself spend quadratic setup time in intentionally fresh writer paths.
  for (let index = 0; index < padding; index++) {
    const meta = { schema_version: 1, id: `NOTE-READS-KNW-${9000 + index}`, type: 'knowledge', title: `Unrelated source history ${index}`,
      owner: 'manager', status: 'draft', revision: 1, created_at: now(), updated_at: now(), links: [], data: {} };
    atomicWrite(safePath(root, `.neomind/records/${meta.id}.md`), `---\n${JSON.stringify(meta)}\n---\n# Unrelated saved knowledge\n`);
  }
  return { root, requirement, task, check, evidence, note, input, records: loadRecords(root).length };
}
function countRecordReads(root, operation) {
  const original = fs.readFileSync, counts = new Map(), base = resolve(root, '.neomind/records').replaceAll('\\', '/').toLowerCase() + '/';
  fs.readFileSync = function (path, ...args) {
    if (typeof path === 'string' && resolve(path).replaceAll('\\', '/').toLowerCase().startsWith(base)) counts.set(String(path), (counts.get(String(path)) ?? 0) + 1);
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: operation(), total: [...counts.values()].reduce((a, b) => a + b, 0), maximum: Math.max(0, ...counts.values()) }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}
function rewrite(root, record, change) {
  const updated = structuredClone(record); change(updated);
  atomicWrite(safePath(root, record.path), `---\n${JSON.stringify(updated.meta)}\n---\n${updated.body}`);
}

test('scaled Cornell validation reads each authoritative record once despite five sources and two evidence graphs', t => {
  const a = fixture(t, 128), read = countRecordReads(a.root, () => validateCornellNote(a.root, a.note.meta.id));
  assert.equal(read.result.ok, true, JSON.stringify(read.result.problems));
  assert.equal(a.note.meta.data.sources.length, 5); assert.equal(a.note.meta.data.demonstration.evidence_ids.length, 2);
  assert.equal(read.total, a.records, 'All source, requirement, check and evidence lookups share this fresh local inventory.');
  assert.equal(read.maximum, 1, 'No referenced ID may trigger another full-store scan.');
});

test('a Cornell record view never survives a call: source/evidence edits and deletions are observed immediately', t => {
  const a = fixture(t);
  assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, true);
  for (const record of [a.requirement, a.evidence[0]]) {
    const path = safePath(a.root, record.path), original = fs.readFileSync(path);
    rewrite(a.root, record, value => { if (value.meta.type === 'evidence') value.meta.data.result = 'fail'; else value.body += '\nChanged acceptance intent.\n'; });
    assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, false, 'Changed current record bytes cannot reuse the prior validation view.');
    fs.writeFileSync(path, original); assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, true);
    fs.unlinkSync(path); assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, false, 'Deleted source/evidence cannot be served from memory.');
    fs.writeFileSync(path, original); assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, true);
  }
  const source = safePath(a.root, 'src/value.mjs'), originalSource = fs.readFileSync(source);
  fs.writeFileSync(source, 'export const value = 2;\n');
  assert.ok(validateCornellNote(a.root, a.note.meta.id).problems.some(problem => /evidence input changed/.test(problem)));
  fs.writeFileSync(source, originalSource);
  const log = safePath(a.root, a.evidence[0].meta.data.log_path), originalLog = fs.readFileSync(log);
  fs.writeFileSync(log, 'Changed observed output.');
  assert.ok(validateCornellNote(a.root, a.note.meta.id).problems.some(problem => /execution log/.test(problem)));
  fs.writeFileSync(log, originalLog); assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, true);
});

test('fresh inventory preserves duplicate, missing-note and wrong-type failures and cannot authorize a later mutation', t => {
  const a = fixture(t);
  assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, true);
  const evidencePath = safePath(a.root, a.evidence[0].path), original = fs.readFileSync(evidencePath);
  rewrite(a.root, a.evidence[0], value => { value.meta.data.result = 'fail'; });
  const next = structuredClone(a.input); next.path = 'docs/knowledge/next.md';
  next.practice.exercise_path = 'docs/practice/next.md'; next.practice.answer_path = 'docs/practice/next-answer.md';
  assert.throws(() => createCornellNote(a.root, next), /current passing evidence/,
    'A validation-local view must never become writer authorization or override the default fresh evidence resolver.');
  assert.equal(fs.existsSync(join(a.root, next.path)), false); fs.writeFileSync(evidencePath, original);
  assert.throws(() => validateCornellNote(a.root, 'NOTE-READS-KNW-MISSING'), /Record not found: NOTE-READS-KNW-MISSING/);
  assert.throws(() => validateCornellNote(a.root, a.requirement.meta.id), /Expected a Cornell knowledge record/);
  const duplicate = safePath(a.root, '.neomind/records/duplicate-current-id.md'); fs.writeFileSync(duplicate, original);
  assert.throws(() => validateCornellNote(a.root, a.note.meta.id), /Duplicate record ID/);
  fs.unlinkSync(duplicate); assert.equal(validateCornellNote(a.root, a.note.meta.id).ok, true);
});
