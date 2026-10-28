import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { initialize } from '../dist/storage.js';
import { prepareWork } from '../dist/procedure-reuse.js';
import { registerProcedure } from '../dist/procedures.js';

const temporary = resolve('artifacts/test-temp');
function fixture(t) {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'workforce-procedure-intent-'));
  t.after(() => { assert.equal(dirname(resolve(root)), temporary); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  initialize(root, { project_id: 'WF-INTENT' });
  return root;
}
function prepare(root, request, additional = {}) {
  return prepareWork(root, { request, environment: { client: 'copilot' }, scope: { allowed_paths: ['out'], network: false, publication: false }, ...additional });
}

test('original ordinary LeetCode prompt and Vietnamese next-exercise wording retain the algorithm family', t => {
  const root = fixture(t);
  for (const request of [
    'I want to have a new LeetCode problem within #attachment:02_contiguous_vs_linked_structures , please create and make a cornell note for me',
    'Create the next LeetCode problem and a Cornell note.',
    'Tạo bài LeetCode tiếp theo trong 02_contiguous_vs_linked_structures và ghi chú Cornell cho tôi.',
    "Don't modify existing exercises; create a new LeetCode problem with a Cornell note.",
    'Không sửa các bài tập hiện có, tạo bài LeetCode mới cùng Cornell note.',
    'Create another LeetCode exercise without changing existing exercises; include a Cornell note.',
  ]) {
    const result = prepare(root, request);
    assert.equal(result.intent_id, 'algorithm-exercise', request);
    assert.equal(result.original_request, request);
    assert.equal(result.execution_authorized, false);
  }
});

test('nearby English and Vietnamese exclusions do not authorize a LeetCode generator', t => {
  const root = fixture(t);
  for (const request of [
    'Do not create LeetCode; only a Cornell note.',
    "Don't create a new LeetCode problem; only create a Cornell note.",
    "I don't want a new LeetCode exercise; create only a Cornell note.",
    'No need to create a LeetCode exercise; only a Cornell note.',
    'Create a Cornell note, not a new LeetCode exercise.',
    'Không tạo bài LeetCode mới; chỉ tạo Cornell note.',
    'Đừng chọn bài LeetCode mới, chỉ tạo ghi chú nghiên cứu Cornell.',
    'Do not create an algorithm exercise on linked lists; only a Cornell note.',
  ]) assert.equal(prepare(root, request).intent_id, 'cornell-note', request);
});

test('task family remains advisory; original prompt cannot qualify or authorize a new script', t => {
  const root = fixture(t); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/produce.cjs'), 'process.exitCode=0;');
  writeFileSync(join(root, 'scripts/verify.cjs'), 'process.exitCode=0;');
  registerProcedure(root, { id: 'exercise', version: '1.0.0', title: 'LeetCode exercise bundle', description: 'Exercise with Cornell note.',
    task_family: 'algorithm-exercise', keywords: ['LeetCode', 'Cornell'], author: 'producer', script: 'scripts/produce.cjs', verification_script: 'scripts/verify.cjs',
    parameters: {}, outputs: [{ path: 'out/new.json', min_bytes: 1 }], environment: { platforms: [process.platform], clients: ['copilot'], node_major_min: 24 },
    effects: { write_roots: ['out'], network: false, publication: false } });
  const result = prepare(root, 'I want to have a new LeetCode problem within #attachment:02_contiguous_vs_linked_structures , please create and make a cornell note for me');
  assert.equal(result.intent_id, 'algorithm-exercise');
  assert.equal(result.decision, 'adapt');
  assert.equal(result.selected_procedure.id, 'exercise', 'An adaptation reference is not execution approval.');
  assert.equal(result.candidates[0].compatible, false);
  assert.equal(result.candidates[0].status, 'candidate');
  assert.ok(result.candidates[0].reasons.some(reason => reason.code === 'NOT_QUALIFIED'));
  assert.ok(!result.candidates[0].reasons.some(reason => reason.code === 'INTENT_MISMATCH'));
  assert.equal(result.execution_authorized, false);
  assert.equal(prepare(root, 'Create a new LeetCode exercise.', { intent_id: 'cornell-note' }).intent_id, 'cornell-note', 'Explicit backend task family is authoritative.');
});
