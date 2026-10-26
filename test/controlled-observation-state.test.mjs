import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../dist/storage.js';
import { controlledLoopState } from '../dist/controlled-observability.js';
import { ControlledObservationLoop } from '../dist/controlled-observation-loop.js';

test('fresh durable checks and producer receipts reset repeated observations while trace revisions do not', t => {
  const root = mkdtempSync(join(tmpdir(), 'neomind-observation-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, '.neomind/controlled/workflows'); mkdirSync(folder, { recursive: true });
  const binding = { workflow_id: 'workflow', invocation_id: 'verifier' };
  const path = join(folder, `${hash(binding.workflow_id)}.json`);
  const run = { epoch_id: 'epoch', phase: 'verification', status: 'running', contract_hash: 'contract',
    attempts: [{ id: 'attempt', state: 'running' }], checks: [], local_executions: [], revision: 1, events: [] };
  const save = () => { writeFileSync(path, JSON.stringify(run)); return controlledLoopState(root, binding); };
  const observer = new ControlledObservationLoop(), result = { content: [{ type: 'text', text: JSON.stringify([{ title: 'A', passed: true }]) }] };
  const observe = (state, round) => observer.observe('check_evidence', { title: 'A' }, result, state, round);
  const original = save();
  assert.equal(observe(original, 1), undefined); assert.equal(observe(original, 2).kind, 'notice');
  run.revision = 200; run.events.push({ kind: 'trace', at: 'later' });
  assert.equal(save(), original, 'Observing the same state does not manufacture progress.');
  run.checks.push({ id: 'new-check-B', attempt_id: 'attempt', log_sha256: hash('actual log'), passed: true, exit_code: 0, expected_exit_code: 0 });
  const afterCheck = save(); assert.notEqual(afterCheck, original);
  assert.equal(observe(afterCheck, 3), undefined, 'Real check B permits a fresh inspection of unchanged A.');
  assert.equal(observe(afterCheck, 4).kind, 'notice');
  run.local_executions.push({ id: 'operation', attempt_id: 'producer', state: 'running', intent_sha256: hash('intent') });
  const started = save(); assert.notEqual(started, afterCheck); assert.equal(observe(started, 5), undefined);
  run.local_executions[0] = { ...run.local_executions[0], state: 'completed', passed: true, result_sha256: hash('actual result') };
  const completed = save(); assert.notEqual(completed, started); assert.equal(observe(completed, 6), undefined);
  run.revision++; run.events.push({ kind: 'trace' });
  assert.equal(save(), completed); assert.equal(observe(completed, 7).kind, 'notice');
  assert.equal(observe(completed, 8).kind, 'reconcile', 'Unchanged reads remain bounded after genuine work ends.');
});
