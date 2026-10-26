import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicWrite, safePath, hash, getRecord, updateRecord } from '../dist/storage.js';
import { controlledFingerprints, prepareControlledCheckEvidence, materializeControlledEvidence, verifyControlledTask } from '../dist/controlled-acceptance.js';
import { assertCompletedEvidenceDocumentationLineage } from '../dist/controlled-report-authority.js';
import { runCommand } from '../dist/command-runner.js';
import { lineageFixture } from './controlled-report-lineage-fixture.mjs';

async function completed(t, repairChecker = false) {
  const state = await lineageFixture(t), { root, run, contract, source, actor, report, save } = state;
  const documentation = actor('developer', 'implementation', source);
  documentation.purpose = 'evidence-documentation'; documentation.documentation_source = structuredClone(source);
  atomicWrite(safePath(root, 'docs/report.md'), '# Final factual report\nThe first independent product check exited zero; the wrong-value control exited one.\n');
  report(documentation, contract.plan.outputs); run.attempts.push(documentation); save();
  assert.doesNotThrow(() => assertCompletedEvidenceDocumentationLineage(root, run, contract, documentation.id));
  assert.equal(verifyControlledTask(root, getRecord(root, contract.task_id), 'verified').ok, false,
    'Completed documentation alone cannot replace fresh post-write verification.');
  if (repairChecker) {
    const path = safePath(root, 'checks/check.cjs');
    atomicWrite(path, readFileSync(path, 'utf8') + '\n// The later independent Verifier repaired its own diagnostics.\n');
  }
  const finalVerifier = actor('verifier', 'verification'); run.attempts.push(finalVerifier);
  for (const selected of [{ ...contract.plan.checks[0], negative: false },
    ...contract.plan.checks[0].negative_controls.map(check => ({ ...check, negative: true }))]) {
    const baseline = controlledFingerprints(root, selected.baseline_paths);
    const evidenceInput = prepareControlledCheckEvidence(root, run, contract, selected, baseline, finalVerifier.invocation_id);
    const result = await runCommand({ command: selected.command, cwd: root, timeout_ms: 5000 });
    assert.equal(result.exit_code, selected.expected_exit_code);
    const id = randomUUID(), logPath = `.neomind/controlled/checks/${id}.log`;
    const log = JSON.stringify({ command: selected.command, planned_command: selected.command, purpose: 'self-check', baseline, result });
    atomicWrite(safePath(root, logPath), log);
    const check = { id, attempt_id: finalVerifier.id, invocation_id: finalVerifier.invocation_id, title: selected.title,
      command: selected.command, planned_command: selected.command, purpose: 'self-check', baseline, log_path: logPath,
      log_sha256: hash(log), exit_code: result.exit_code, expected_exit_code: selected.expected_exit_code,
      negative: selected.negative, passed: true, cancelled: false, at: new Date().toISOString(), evidence_input: evidenceInput };
    check.evidence_id = materializeControlledEvidence(root, run, contract, check); run.checks.push(check);
  }
  report(finalVerifier, ['checks/check.cjs', 'checks/bad.txt']);
  const reviewer = actor('reviewer', 'review'); report(reviewer, []); run.attempts.push(reviewer);
  run.phase = 'completed'; run.status = 'queued'; save();
  const acceptance = () => verifyControlledTask(root, getRecord(root, contract.task_id), 'accepted');
  assert.equal(acceptance().ok, true, JSON.stringify(acceptance().findings));
  return { ...state, documentation, finalVerifier, reviewer, acceptance };
}

test('final acceptance authenticates first-check history while allowing a later independent checker repair', async t => {
  const state = await completed(t, true), before = state.snapshot();
  const guard = assertCompletedEvidenceDocumentationLineage(state.root, state.run, state.contract, state.documentation.id);
  assert.equal(guard['src/value.txt'], hash('1\n')); assert.equal('checks/check.cjs' in guard, false);
  assert.equal(state.acceptance().ok, true);
  assert.equal(state.snapshot(), before, 'Lineage verification cannot rewrite source reports, logs, snapshots or the final checker.');
});

test('fresh final checks cannot hide a modified or missing first independent check log', async t => {
  const state = await completed(t), check = state.run.checks[0], path = safePath(state.root, check.log_path), bytes = readFileSync(path);
  atomicWrite(path, '{"result":{"exit_code":0},"forged":true}');
  assert.equal(state.acceptance().ok, false);
  atomicWrite(path, bytes); assert.equal(state.acceptance().ok, true);
  unlinkSync(path); assert.equal(state.acceptance().ok, false);
  atomicWrite(path, bytes); assert.equal(state.acceptance().ok, true);
});

test('the original producer signature and saved work record remain necessary after the report handoff', async t => {
  const state = await completed(t), receiptPath = safePath(state.root, `.neomind/native/receipts/${state.producer.invocation_id}.json`);
  const bytes = readFileSync(receiptPath), receipt = JSON.parse(bytes.toString('utf8'));
  receipt.request_id = randomUUID(); atomicWrite(receiptPath, JSON.stringify(receipt));
  assert.equal(state.acceptance().ok, false, 'The newest report session cannot stand in for the original signed product producer.');
  atomicWrite(receiptPath, bytes); assert.equal(state.acceptance().ok, true);
  const record = getRecord(state.root, state.producer.report_id);
  updateRecord(state.root, record.meta.id, {}, record.body + '\nTampered historical result.\n');
  assert.equal(state.acceptance().ok, false);
});

test('removing source check receipts or the source binding cannot silently shorten completed workflow history', async t => {
  const state = await completed(t), checks = [...state.run.checks];
  state.run.checks = checks.filter(check => check.attempt_id !== state.verifier.id); state.save();
  assert.equal(state.acceptance().ok, false);
  state.run.checks = checks; state.save(); assert.equal(state.acceptance().ok, true);
  const source = state.documentation.documentation_source; delete state.documentation.documentation_source; state.save();
  assert.equal(state.acceptance().ok, false);
  state.documentation.documentation_source = source; state.save(); assert.equal(state.acceptance().ok, true);
});

test('signed report-only purpose cannot be stripped from the unsigned journal to bypass lineage validation', async t => {
  const state = await completed(t); delete state.documentation.purpose; state.save();
  const actual = state.acceptance(); assert.equal(actual.ok, false);
  assert.match(actual.findings.map(finding => finding.message).join('\n'), /purpose differs from its signed documentation handoff/);
});

test('a validly signed but wrongly bound source digest cannot stand in for the actual documentation checkpoint', async t => {
  const state = await completed(t);
  state.resign(state.documentation.invocation_id, receipt => { receipt.controlled_execution.documentation_source_sha256 = 'f'.repeat(64); });
  const actual = state.acceptance(); assert.equal(actual.ok, false);
  assert.match(actual.findings.map(finding => finding.message).join('\n'), /source differs from its signed backend checkpoint identity/);
});

test('post-report production edits still require new implementation and current verification', async t => {
  const state = await completed(t, true);
  atomicWrite(safePath(state.root, 'src/value.txt'), '2\n');
  assert.throws(() => assertCompletedEvidenceDocumentationLineage(state.root, state.run, state.contract, state.documentation.id), /changed outside/);
  assert.equal(state.acceptance().ok, false);
});
