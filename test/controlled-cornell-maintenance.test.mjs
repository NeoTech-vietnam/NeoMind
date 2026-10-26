import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { getRecord, updateRecord, hash, safePath, atomicWrite } from '../dist/storage.js';
import { reconcileControlledCornellRenderer, controlledStatus } from '../dist/controlled-workflow.js';
import { cornellMaintenanceFixture as fixture } from './cornell-maintenance-fixture.mjs';
test('trusted renderer maintenance archives the exact old generation once, preserves exhausted budgets and awaits fresh independent work', async t => {
  const a = fixture(t), before = readFileSync(safePath(a.root, a.note.meta.data.artifact_path));
  const receipt = await reconcileControlledCornellRenderer(a.root, a.input), run = controlledStatus(a.root, a.run.workflow_id);
  assert.equal(receipt.outcome, 'renderer-corrected-awaiting-independent-verification');
  assert.equal(run.status, 'paused'); assert.equal(run.phase, 'implementation'); assert.deepEqual(run.repair_budget, a.run.repair_budget);
  assert.equal(run.repairs, 3); assert.equal(run.attempts.length, 0); assert.equal(run.checks.length, 0);
  assert.equal(run.cornell_results.length, 2); assert.ok(run.pending_renderer_recovery); assert.equal(run.renderer_reconciliations.length, 1);
  const note = getRecord(a.root, a.note.meta.id); assert.equal(note.meta.revision, a.note.meta.revision + 1);
  assert.equal(note.meta.data.research.format_renderer_revision, 2);
  assert.deepEqual(readFileSync(safePath(a.root, note.meta.data.revision_history[0].artifacts[a.note.meta.data.artifact_path].history_path)), before);
  assert.equal(readFileSync(safePath(a.root, `.neomind/controlled/workflows/${hash(a.run.workflow_id)}.${a.run.epoch_id}.contract.json`), 'utf8'), a.contractBytes);
  const replay = await reconcileControlledCornellRenderer(a.root, a.input); assert.equal(replay.replayed, true);
  assert.equal(getRecord(a.root, note.meta.id).meta.revision, note.meta.revision); assert.equal(controlledStatus(a.root, a.run.workflow_id).revision, run.revision);
});

test('trusted maintenance refuses stale revisions, user edits, changed source, active work and foreign ownership without replacing files', async t => {
  for (const kind of ['revision', 'user-file', 'source', 'active', 'ownership']) {
    const a = fixture(t), path = safePath(a.root, a.note.meta.data.artifact_path);
    if (kind === 'revision') a.input.expected_revision--;
    if (kind === 'user-file') writeFileSync(path, 'A real user edit must survive.\n');
    if (kind === 'source') writeFileSync(safePath(a.root, a.source.path), '{}');
    if (kind === 'active') { a.run.active_invocations.push({ id: randomUUID(), role: 'developer', state: 'running' }); atomicWrite(a.statePath, JSON.stringify(a.run)); }
    if (kind === 'ownership') updateRecord(a.root, a.note.meta.id, { data: { workflow_id: 'FOREIGN-WORKFLOW' } });
    const before = readFileSync(path), record = getRecord(a.root, a.note.meta.id), state = readFileSync(a.statePath);
    await assert.rejects(reconcileControlledCornellRenderer(a.root, a.input));
    assert.deepEqual(readFileSync(path), before); assert.deepEqual(getRecord(a.root, a.note.meta.id), record); assert.deepEqual(readFileSync(a.statePath), state);
  }
});

test('lost completion or workflow responses reconcile the same prepared renderer revision without duplicate effects', async t => {
  for (const point of ['completion', 'workflow']) {
    const a = fixture(t), original = fs.writeFileSync; let injected = false;
    fs.writeFileSync = function(file, ...args) {
      const path = typeof file === 'string' ? file.replaceAll('\\', '/') : '';
      if (!injected && (point === 'completion' ? /\/cornell-renderer-reconciliations\/[a-f0-9]+\.json$/.test(path)
        : path.startsWith(a.statePath.replaceAll('\\', '/') + '.'))) {
        injected = true; throw Object.assign(new Error('Injected lost maintenance response.'), { code: 'EIO' });
      }
      return original.call(this, file, ...args);
    }; syncBuiltinESMExports();
    try { await assert.rejects(reconcileControlledCornellRenderer(a.root, a.input)); }
    finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    const recovered = await reconcileControlledCornellRenderer(a.root, a.input); assert.equal(recovered.replayed, false);
    const note = getRecord(a.root, a.note.meta.id), run = controlledStatus(a.root, a.run.workflow_id);
    assert.equal(note.meta.revision, 2); assert.equal(note.meta.data.revision_history.length, 1); assert.equal(run.cornell_results.length, 2);
    assert.deepEqual(run.repair_budget, a.run.repair_budget);
    assert.equal((await reconcileControlledCornellRenderer(a.root, a.input)).replayed, true);
  }
});

test('managed output or frozen source edited while the async validator runs is preserved before commit', async t => {
  for (const kind of ['output', 'source']) {
    const a = fixture(t), target = safePath(a.root, kind === 'output' ? a.note.meta.data.artifact_path : a.source.path), original = fs.writeFileSync;
    let edited = false;
    fs.writeFileSync = function(file, ...args) {
      if (!edited && typeof file === 'string' && /\/neomind-cornell-validation-[^/]+\/note\.md$/.test(file.replaceAll('\\', '/'))) {
        edited = true; original.call(this, target, readFileSync(target, 'utf8') + '\nUser edit during canonical validation.\n');
      }
      return original.call(this, file, ...args);
    }; syncBuiltinESMExports();
    try { await assert.rejects(reconcileControlledCornellRenderer(a.root, a.input)); }
    finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
    assert.equal(edited, true); assert.match(readFileSync(target, 'utf8'), /User edit during canonical validation/);
    assert.equal(getRecord(a.root, a.note.meta.id).meta.revision, 1);
    assert.equal(controlledStatus(a.root, a.run.workflow_id).revision, a.run.revision);
  }
});
