import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginWorkflow, createRecord, getRecord, initialize, safePath, updateRecord } from '../dist/index.js';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'taskforces-manager-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { project_id: 'BOUNDARY' });
  return root;
}

const forgedClosures = [
  { phase: 'completed' },
  { phase: 'completed-with-blockers' },
  { phase: 'awaiting-native-completion' },
  { final_report_id: 'BOUNDARY-KNW-9999' },
  { closed_at: '2026-10-23T00:00:00.000Z' },
  { phase: 'completed', final_report_id: 'BOUNDARY-KNW-9999', closed_at: '2026-10-23T00:00:00.000Z' },
];

for (const execution_mode of ['strict', 'copilot-native']) {
  test(`${execution_mode} manager closure cannot be forged through public updateRecord`, (t) => {
    const root = project(t);
    const parent = beginWorkflow(root, { requirement: 'Save evidence-linked findings before closure.', execution_mode });
    const before = readFileSync(safePath(root, parent.path), 'utf8');
    for (const data of forgedClosures) {
      assert.throws(() => updateRecord(root, parent.meta.id, { data }), /Use manager_finish/);
      assert.equal(readFileSync(safePath(root, parent.path), 'utf8'), before);
    }
    assert.throws(() => updateRecord(root, parent.meta.id, { status: 'accepted' }), /validated acceptance decision/);
    assert.equal(readFileSync(safePath(root, parent.path), 'utf8'), before);
    assert.equal(getRecord(root, parent.meta.id).meta.data.final_report_id, undefined);

    // Planning can still reset closure metadata without claiming closure.
    const planned = updateRecord(root, parent.meta.id, {
      data: { phase: 'execution', final_report_id: null, closed_at: null },
    });
    assert.equal(planned.meta.data.phase, 'execution');
    assert.equal(planned.meta.data.final_report_id, null);
    assert.equal(planned.meta.data.closed_at, null);
  });

  test(`${execution_mode} CLI record update cannot bypass manager_finish`, (t) => {
    const root = project(t);
    const parent = beginWorkflow(root, { requirement: 'Deliver Cornell notes through validated closure.', execution_mode });
    const before = readFileSync(safePath(root, parent.path), 'utf8');
    for (const data of [...forgedClosures, { status: 'accepted' }]) {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
        'record', 'update', parent.meta.id, '--project', root, '--data', JSON.stringify(data),
      ], { cwd: root, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr || result.stdout, /Use manager_finish|validated acceptance decision/);
      assert.equal(readFileSync(safePath(root, parent.path), 'utf8'), before);
    }
  });
}

test('manager closure guard does not reserve unrelated knowledge metadata', (t) => {
  const root = project(t);
  const note = createRecord(root, { type: 'knowledge', title: 'Independent knowledge metadata' });
  const updated = updateRecord(root, note.meta.id, { data: forgedClosures.at(-1) });
  assert.equal(updated.meta.data.phase, 'completed');
  assert.equal(updated.meta.data.final_report_id, 'BOUNDARY-KNW-9999');
});
