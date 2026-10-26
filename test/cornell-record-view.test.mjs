import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { getRecord, loadRecords, safePath, updateRecord } from '../dist/storage.js';
import { withCornellRecordView, assertCornellRecordView } from '../dist/cornell-record-view.js';
import { createCornellNote, noteFreshnessProblems, validateCornellNote } from '../dist/notes.js';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { normalizeCornellOwnership } from '../dist/recipes.js';
import { researchFixture } from './cornell-research-fixture.mjs';

function recordReads(action) {
  const original = fs.readFileSync; let count = 0;
  fs.readFileSync = function(path, ...args) {
    if (String(path).replaceAll('\\', '/').includes('/.neomind/records/')) count++;
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: action(), count: () => count }; }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}
function author(root, input, directory = input.output_dir) {
  const compiled = compileCornellResearch(root, { ...input, output_dir: directory,
    practice: { ...input.practice, solution_path: `${directory}/my-solution.md` } });
  return { compiled, note: createCornellNote(root, compiled.note) };
}

test('Cornell read views preserve a full fresh inventory while returning defensive copies and expiring after the call', t => {
  const { root, requirement } = researchFixture(t), expected = loadRecords(root).length;
  let escaped;
  const observation = recordReads(() => withCornellRecordView(root, view => {
    escaped = view;
    for (let index = 0; index < 20; index++) assert.equal(view.get(requirement.meta.id).meta.id, requirement.meta.id);
    const first = view.get(requirement.meta.id); first.meta.title = 'Modified caller copy'; first.body = 'Modified caller body';
    const all = view.all(); all[0].meta.title = 'Modified caller inventory';
    assert.equal(view.get(requirement.meta.id).meta.title, requirement.meta.title);
    assert.equal(view.get(requirement.meta.id).body, requirement.body);
    assert.throws(() => assertCornellRecordView(join(root, 'another-project'), view), /another project/);
    return view.get(requirement.meta.id);
  }));
  assert.equal(observation.count(), expected, 'Many scoped lookups perform exactly one complete record inventory.');
  assert.equal(observation.result.meta.title, requirement.meta.title);
  assert.throws(() => escaped.get(requirement.meta.id), /expired/);
  assert.throws(() => escaped.all(), /expired/);
  assert.throws(() => assertCornellRecordView(root, {}), /active synchronous validation/);
  updateRecord(root, requirement.meta.id, { title: 'Fresh title saved after the previous scope' });
  assert.equal(withCornellRecordView(root, view => view.get(requirement.meta.id).meta.title), 'Fresh title saved after the previous scope');
});

test('Cornell read views reject asynchronous escape and cannot supply authority to later validation', async t => {
  const { root, requirement, input } = researchFixture(t); let escaped, pending;
  assert.throws(() => withCornellRecordView(root, view => {
    escaped = view; pending = Promise.resolve().then(() => view.get(requirement.meta.id)); return pending;
  }), /asynchronous boundary/);
  await assert.rejects(pending, /expired/);
  const { note } = author(root, input);
  assert.throws(() => validateCornellNote(root, note.meta.id, escaped), /expired/);
  assert.throws(() => normalizeCornellOwnership(root, { requirement_ids: [requirement.meta.id] }, {}, escaped), /expired/);
  assert.equal(validateCornellNote(root, note.meta.id).ok, true, 'The default API opens a new fresh scope.');
});

test('reflected keys, forged scope symbols, copied methods and proxies cannot create Cornell read authority', t => {
  const { root, input } = researchFixture(t), { note, compiled } = author(root, input);
  const invalid = []; let expired, fabricatedReads = 0;
  const rejects = view => {
    assert.throws(() => assertCornellRecordView(root, view), /expired|unrecognized/);
    assert.throws(() => validateCornellNote(root, note.meta.id, view), /expired|unrecognized/);
    assert.throws(() => normalizeCornellOwnership(root, compiled.note, {}, view), /expired|unrecognized/);
  };
  withCornellRecordView(root, view => {
    expired = view;
    assert.deepEqual(Reflect.ownKeys(view).sort(), ['all', 'get'], 'No reflected symbol is trusted as a scope credential.');
    const copied = Object.fromEntries(Reflect.ownKeys(view).map(key => [key, view[key]]));
    const legacySymbol = Reflect.ownKeys(view).find(key => typeof key === 'symbol') ?? Symbol('synchronous Cornell record view');
    const forged = { [legacySymbol]() {}, get() { fabricatedReads++; return structuredClone(note); },
      all() { fabricatedReads++; return [structuredClone(note)]; } };
    invalid.push(copied, forged, Object.freeze({ ...view }), new Proxy(view, {}));
    for (const candidate of invalid) rejects(candidate);
    assert.equal(validateCornellNote(root, note.meta.id, view).ok, true, 'Only the actual active frozen view retains scoped authority.');
  });
  for (const candidate of [...invalid, expired]) rejects(candidate);
  assert.equal(fabricatedReads, 0, 'Forgery is rejected before any caller-supplied record resolver can run.');
});

test('research compilation and whole-batch note freshness each load records once without weakening validation', t => {
  const { root, input } = researchFixture(t), initialCount = loadRecords(root).length;
  const compilation = recordReads(() => compileCornellResearch(root, input));
  assert.equal(compilation.count(), initialCount, 'Requirement, sources and ownership share one read-only preparation inventory.');
  const first = createCornellNote(root, compilation.result.note);
  const second = author(root, input, 'docs/research/second-product').note;
  const allCount = loadRecords(root).length, batch = recordReads(() => noteFreshnessProblems(root));
  assert.deepEqual(batch.result, []); assert.equal(batch.count(), allCount, 'Every note in one synchronous freshness batch shares its full validated inventory.');
  const narrative = safePath(root, first.meta.data.artifact_path), original = readFileSync(narrative);
  try {
    writeFileSync(narrative, Buffer.concat([original, Buffer.from('\nUser edit after validation.\n')]));
    assert.equal(validateCornellNote(root, first.meta.id).ok, false);
    assert.ok(noteFreshnessProblems(root).some(problem => problem.includes(first.meta.id)));
    assert.equal(validateCornellNote(root, second.meta.id).ok, true);
  } finally { writeFileSync(narrative, original); }
  assert.deepEqual(noteFreshnessProblems(root), []);
});

test('duplicate and malformed records anywhere remain fatal to readonly preparation and validation', t => {
  const { root, input, requirement } = researchFixture(t), { note, compiled } = author(root, input);
  const extra = safePath(root, '.neomind/records/knowledge/read-view-extra.md'); mkdirSync(dirname(extra), { recursive: true });
  const operations = [() => withCornellRecordView(root, view => view.get(requirement.meta.id)),
    () => compileCornellResearch(root, input), () => validateCornellNote(root, note.meta.id),
    () => noteFreshnessProblems(root), () => normalizeCornellOwnership(root, compiled.note)];
  try {
    writeFileSync(extra, readFileSync(safePath(root, requirement.path)));
    for (const operation of operations) assert.throws(operation, /Duplicate record ID/);
    writeFileSync(extra, 'This is a malformed record without its required metadata.\n');
    for (const operation of operations) assert.throws(operation);
  } finally { rmSync(extra, { force: true }); }
  assert.equal(validateCornellNote(root, note.meta.id).ok, true);
});

test('writer preparation refreshes requirements and source files rather than reusing the compiler read view', t => {
  const { root, input, requirement } = researchFixture(t), compiled = compileCornellResearch(root, input);
  updateRecord(root, requirement.meta.id, { title: 'Changed requirement after pure research compilation' });
  assert.throws(() => createCornellNote(root, compiled.note), /Research requirement revision or binding changed/);
  assert.equal(existsSync(safePath(root, input.output_dir)), false, 'A stale prepared note creates no product artifacts.');
  const current = getRecord(root, requirement.meta.id), source = 'docs/source.md';
  mkdirSync(dirname(safePath(root, source)), { recursive: true }); writeFileSync(safePath(root, source), '# Original source\nFinite Cartesian products enumerate ordered pairs.\n');
  const fileInput = { ...input, expected_requirement_revision: current.meta.revision,
    sources: [{ id: 'S1', title: 'Local finite Cartesian product source', uri: source, retrieved_at: '2026-10-23T00:00:00Z' }] };
  const fileCompiled = compileCornellResearch(root, fileInput);
  writeFileSync(safePath(root, source), '# User-edited source\nThe source bytes changed after compilation.\n');
  assert.throws(() => createCornellNote(root, fileCompiled.note), /Source hash is stale/);
  assert.equal(existsSync(safePath(root, input.output_dir)), false);
});
