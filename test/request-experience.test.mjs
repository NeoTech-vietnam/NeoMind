import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findRequestExperiences, saveAcceptedRequestExperience } from '../dist/request-experience.js';
import { createRecord, initialize, saveStatus } from '../dist/storage.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-request-experience-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'WF-EXPERIENCE' });
  return root;
}

const digest = 'a'.repeat(64);
const cache = '.workforce/cache/request-experience.sqlite';
const query = { request: 'Tạo ghi chú nghiên cứu mới với bài tập và đáp án.', task_family: 'cornell-note' };

test('the project index finds a saved accepted request by normalized text and retains procedure provenance', t => {
  const root = project(t);
  assert.deepEqual(findRequestExperiences(root, query), { state: 'available', candidates: [] });
  assert.equal(existsSync(join(root, cache)), false);

  const request = createRecord(root, { type: 'knowledge', title: 'Research note',
    data: { kind: 'workforce-request', request_id: 'original-request' } });
  const task = createRecord(root, { type: 'task', title: 'Prepare note', data: { workflow_id: request.meta.id } });
  const input = {
    workflow_id: request.meta.id,
    task_family: 'cornell-note',
    summary: 'Cornell research note with practice and answers.',
    acceptance: { record_id: task.meta.id, revision: task.meta.revision },
    procedures: [{ id: 'cornell-format', version: '1.0.0', contract_hash: digest, script_sha256: digest }],
    artifact_paths: ['notes/cornell.md'],
    parameters_sha256: digest,
  };
  assert.throws(() => saveAcceptedRequestExperience(root, input), /requires an accepted request/);

  const accepted = saveStatus(root, task.meta.id, 'accepted');
  assert.throws(() => saveAcceptedRequestExperience(root, { ...input,
    acceptance: { record_id: task.meta.id, revision: accepted.meta.revision } }), /requires an accepted request/);
  saveStatus(root, request.meta.id, 'accepted');
  assert.throws(() => saveAcceptedRequestExperience(root, input), /specified revision/);
  const taskFile = join(root, accepted.path);
  const sourceBefore = readFileSync(taskFile);
  input.acceptance.revision = accepted.meta.revision;
  saveAcceptedRequestExperience(root, input);
  saveAcceptedRequestExperience(root, input);

  const { state, candidates } = findRequestExperiences(root, query);
  assert.equal(state, 'available');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].request_id, 'original-request');
  assert.equal(candidates[0].request_key, 'WF-R0001');
  assert.deepEqual(candidates[0].procedures, input.procedures);
  assert.deepEqual(candidates[0].acceptance, input.acceptance);
  assert.match(candidates[0].record_snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(taskFile), sourceBefore);
  assert.deepEqual(findRequestExperiences(root, { ...query, task_family: 'other-family' }).candidates, []);
  assert.deepEqual(findRequestExperiences(project(t), query).candidates, []);

  const unrelated = createRecord(root, { type: 'knowledge', title: 'Other request', data: { kind: 'workforce-request' } });
  assert.throws(() => saveAcceptedRequestExperience(root, { ...input, workflow_id: unrelated.meta.id }), /same request/);
});

test('an unreadable experience cache is distinct from a search with no matches', t => {
  const root = project(t);
  mkdirSync(join(root, '.workforce/cache'));
  writeFileSync(join(root, cache), 'not a SQLite database');
  assert.deepEqual(findRequestExperiences(root, query), { state: 'unavailable', candidates: [] });
});
