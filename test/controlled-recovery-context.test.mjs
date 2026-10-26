import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { controlledPlanningRecovery } from '../dist/controlled-recovery-context.js';

test('resumed planning retains bounded same-epoch validation without private input or credentials', t => {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, 'neomind-recovery-context-')));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(parent)); rmSync(root, { recursive: true, force: true }); });
  const directory = join(root, '.neomind/controlled/traces'); mkdirSync(directory, { recursive: true });
  const run = { workflow_id: 'NM-RECOVERY-KNW-0001', epoch_id: randomUUID(), events: [] };
  const save = (rule, extra = {}) => {
    const id = randomUUID();
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ workflow_id: run.workflow_id, epoch_id: run.epoch_id,
      event: 'tool-result', tool: 'workflow_plan', status: 'failed', code: 'PLAN_INVALID',
      validation: { rule, owner: 'agent-content' }, model_input: { credential: 'never-include-private-input' }, ...extra }));
    run.events.push({ kind: 'tool', summary: `Semantic tool workflow_plan: failed; trace ${id}` });
  };
  save('Preservation scope exceeded its bounded inventory. Use narrow exercised inputs.');
  save('Preservation scope exceeded its bounded inventory. Use narrow exercised inputs.');
  save('another workflow must not leak', { workflow_id: 'NM-OTHER-KNW-0001' });
  save('old execution must not leak', { epoch_id: randomUUID() });
  save('Authorization: Bearer example-secret-value');
  const damaged = randomUUID(); writeFileSync(join(directory, `${damaged}.json`), '{damaged');
  run.events.push({ kind: 'tool', summary: `Semantic tool workflow_plan: failed; trace ${damaged}` });
  const actual = controlledPlanningRecovery(root, run), serialized = JSON.stringify(actual);
  assert.equal(actual.length, 2); assert.match(actual[0].rule, /narrow exercised inputs/);
  for (const sensitive of ['never-include-private-input', 'example-secret-value', 'another workflow', 'old execution']) assert.ok(!serialized.includes(sensitive));
  assert.match(serialized, /redacted/);
  // Clearing a displayed blocker during resume cannot erase this journal context.
  assert.deepEqual(controlledPlanningRecovery(root, { ...run, blocker: undefined }), actual);
});

test('empty diagnostic history contains no plan to replay and needs no filesystem scan', () => {
  assert.deepEqual(controlledPlanningRecovery('D:/not-used', { workflow_id: 'w', epoch_id: 'e', events: [] }), []);
});
