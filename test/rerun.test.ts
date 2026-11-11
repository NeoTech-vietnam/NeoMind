import test from 'node:test';
import assert from 'node:assert/strict';
import { rerunDraft } from '../src/domain/rerun.js';

test('rerun uses a stopped run task and flow without changing the run', () => {
  const run = { runtimeState: { phase: 'blocked' }, runtimeContext: { task: '  Fix the issue\nwith context  ' }, snapshot: { configuration: { flow: { flowId: 'custom' } } } };
  const before = structuredClone(run);
  assert.deepEqual(rerunDraft(run), { flowId: 'custom', task: run.runtimeContext.task });
  assert.deepEqual(run, before);
  assert.equal(rerunDraft({ ...run, runtimeState: { phase: 'running' } }), null);
  assert.equal(rerunDraft({ ...run, runtimeState: { phase: 'waiting_approval' } }), null);
  for (const phase of ['completed', 'cancelled', 'paused']) assert.deepEqual(rerunDraft({ ...run, runtimeState: { phase } }), { flowId: 'custom', task: run.runtimeContext.task });
  assert.equal(rerunDraft({ ...run, runtimeContext: { task: ' ' } }), null);
  assert.equal(rerunDraft({ runtimeState: { phase: 'blocked' } }), null);
});
