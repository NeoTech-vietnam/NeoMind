import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { researchFixture } from './cornell-research-fixture.mjs';
import { createRecord, getRecord, safePath } from '../dist/storage.js';
import { compileCornellResearch } from '../dist/cornell-workflow.js';
import { createCornellNote, validateCornellNote } from '../dist/notes.js';
import { controlledCornellResult } from '../dist/controlled-cornell-sources.js';
import { persistControlledCornellNote } from '../dist/controlled-cornell-write.js';

function fixture(t) {
  const a = researchFixture(t);
  const task = createRecord(a.root, { type: 'task', title: 'Write and independently verify the research bundle', owner: 'developer',
    data: { workflow_id: a.workflow.meta.id }, links: [{ type: 'satisfies', target: a.requirement.meta.id }] });
  const input = { ...a.input, task_id: task.meta.id, worked_example: { ...a.input.worked_example } };
  delete input.worked_example.observed; delete input.worked_example.evidence_ids;
  const compiled = compileCornellResearch(a.root, input), note = createCornellNote(a.root, compiled.note);
  const context = { workflow_id: a.workflow.meta.id, epoch_id: 'owned-current-epoch', task_id: task.meta.id,
    requirement_ids: [a.requirement.meta.id], evidence: [], file_allowed: () => false,
    saved_results: [controlledCornellResult(compiled, note)] };
  return { ...a, task, input, compiled, note, context };
}

test('a current owned Cornell producer can revise its generated bundle with immutable history and replay the new result', t => {
  const a = fixture(t), originalBytes = readFileSync(safePath(a.root, a.compiled.note.path));
  const revisedInput = { ...a.input, discussion: `${a.input.discussion}\n\n[expected] A corrected decoded paragraph preserves the literal JSON example instead of copying its serialized representation.` };
  const revised = compileCornellResearch(a.root, revisedInput);
  const written = persistControlledCornellNote(a.root, revised, a.context);
  assert.equal(written.meta.id, a.note.meta.id);
  assert.equal(written.meta.revision, a.note.meta.revision + 1);
  assert.equal(written.meta.data.revision_history.length, 1);
  const snapshot = written.meta.data.revision_history[0].artifacts[a.compiled.note.path];
  assert.deepEqual(readFileSync(safePath(a.root, snapshot.history_path)), originalBytes);
  assert.equal(validateCornellNote(a.root, written.meta.id).ok, true);
  a.context.saved_results.push(controlledCornellResult(revised, written));
  const replay = persistControlledCornellNote(a.root, revised, a.context);
  assert.equal(replay.meta.revision, written.meta.revision);
  assert.equal(replay.meta.data.revision_history.length, 1);
});

test('a Cornell repair never overwrites user edits, foreign task ownership or a changed backend receipt', t => {
  for (const change of ['user-file', 'record', 'task', 'receipt']) {
    const a = fixture(t), path = safePath(a.root, a.compiled.note.path);
    if (change === 'user-file') writeFileSync(path, 'An independent user edit must survive.\n');
    if (change === 'record') a.context.saved_results[0].record_fingerprint = '0'.repeat(64);
    if (change === 'task') a.context.task_id = 'CORNELL-TASK-FOREIGN';
    if (change === 'receipt') a.context.saved_results = [];
    const before = readFileSync(path), old = getRecord(a.root, a.note.meta.id);
    const revised = compileCornellResearch(a.root, { ...a.input, discussion: `${a.input.discussion}\n\n[expected] This alternate professional conclusion must not replace unowned or changed artifacts.` });
    assert.throws(() => persistControlledCornellNote(a.root, revised, a.context));
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(getRecord(a.root, a.note.meta.id), old);
  }
});

test('returning to earlier Cornell content uses the newest revision receipt instead of adopting the first historical generation', t => {
  const a = fixture(t), originalInput = structuredClone(a.input);
  const changed = compileCornellResearch(a.root, { ...a.input, discussion: `${a.input.discussion}\n\n[expected] This intervening conclusion is a separate professional revision with preserved history.` });
  const second = persistControlledCornellNote(a.root, changed, a.context);
  a.context.saved_results.push(controlledCornellResult(changed, second));
  const returned = compileCornellResearch(a.root, originalInput), third = persistControlledCornellNote(a.root, returned, a.context);
  a.context.saved_results.push(controlledCornellResult(returned, third));
  assert.equal(third.meta.revision, a.note.meta.revision + 2);
  assert.equal(third.meta.data.revision_history.length, 2);
  assert.equal(validateCornellNote(a.root, third.meta.id).ok, true);
  const repeated = persistControlledCornellNote(a.root, returned, a.context);
  assert.equal(repeated.meta.revision, third.meta.revision);
  assert.equal(repeated.meta.data.revision_history.length, 2);
});

test('a lost workflow response replays a completed Cornell write without another record or revision', t => {
  for (const mode of ['create', 'revise']) {
    const a = fixture(t);
    const input = mode === 'create' ? { ...a.input, output_dir: 'docs/recovered-cornell' }
      : { ...a.input, discussion: `${a.input.discussion}\n\n[expected] This corrected paragraph is durable even if the caller loses the response.` };
    const compiled = compileCornellResearch(a.root, input), originalContext = structuredClone({ ...a.context, file_allowed: undefined });
    originalContext.file_allowed = () => false;
    const written = persistControlledCornellNote(a.root, compiled, originalContext);
    const replayed = persistControlledCornellNote(a.root, compiled, originalContext);
    assert.equal(replayed.meta.id, written.meta.id);
    assert.equal(replayed.meta.revision, written.meta.revision);
    assert.deepEqual(replayed.meta.data.artifact_hashes, written.meta.data.artifact_hashes);
  }
});

test('a crash between Cornell record persistence and its result checkpoint recovers only the exact prepared bytes', t => {
  for (const mode of ['create', 'revise']) {
    const a = fixture(t), compiled = compileCornellResearch(a.root, mode === 'create' ? { ...a.input, output_dir: 'docs/crash-cornell' }
      : { ...a.input, discussion: `${a.input.discussion}\n\n[expected] The new professional conclusion survives a lost result checkpoint.` });
    const originalWrite = fs.writeFileSync; let injected = false;
    fs.writeFileSync = function (file, ...args) {
      if (!injected && typeof file === 'string' && /\/controlled\/cornell-writes\/[^/]+\/result\.json\./.test(file.replaceAll('\\', '/'))) {
        injected = true; throw Object.assign(new Error('Injected lost Cornell result persistence.'), { code: 'EIO' });
      }
      return originalWrite.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    try { assert.throws(() => persistControlledCornellNote(a.root, compiled, a.context), error => error.code === 'STATE_UNCERTAIN'); }
    finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    const recovered = persistControlledCornellNote(a.root, compiled, a.context);
    assert.equal(validateCornellNote(a.root, recovered.meta.id).ok, true);
    assert.equal(recovered.meta.revision, mode === 'revise' ? a.note.meta.revision + 1 : 1);
    const repeated = persistControlledCornellNote(a.root, compiled, a.context);
    assert.equal(repeated.meta.id, recovered.meta.id); assert.equal(repeated.meta.revision, recovered.meta.revision);
  }
});

test('partial generated file writes resume the same prepared creation or revision without overwriting external edits', t => {
  for (const mode of ['create', 'revise']) {
    const a = fixture(t), compiled = compileCornellResearch(a.root, mode === 'create' ? { ...a.input, output_dir: 'docs/partial-cornell' }
      : { ...a.input, discussion: `${a.input.discussion}\n\n[expected] This revised narrative is written through a recoverable operation.` });
    const failPath = safePath(a.root, mode === 'create' ? compiled.note.path : compiled.note.practice.exercise_path).replaceAll('\\', '/');
    const originalWrite = fs.writeFileSync; let injected = false;
    fs.writeFileSync = function (file, ...args) {
      if (!injected && typeof file === 'string' && file.replaceAll('\\', '/').startsWith(`${failPath}.`)) {
        injected = true; throw Object.assign(new Error('Injected partial research artifact write.'), { code: 'EIO' });
      }
      return originalWrite.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    try { assert.throws(() => persistControlledCornellNote(a.root, compiled, a.context), error => error.code === 'STATE_UNCERTAIN'); }
    finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    const recovered = persistControlledCornellNote(a.root, compiled, a.context);
    assert.equal(validateCornellNote(a.root, recovered.meta.id).ok, true);
    assert.equal(recovered.meta.revision, mode === 'revise' ? a.note.meta.revision + 1 : 1);
  }
});
