import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceReportPaths, pendingEvidenceDocumentation, controlledChecksForPhase } from '../dist/controlled-report-phase.js';

function fixture() {
  const plan = { allowed_paths: ['src', 'docs'], verification_paths: ['checks'],
    outputs: ['src/product.cjs', 'docs/report.md', 'docs/guide.md'], documentation_paths: ['docs/report.md', 'docs/guide.md'],
    evidence_report_paths: ['docs/report.md'], acceptance_criteria: ['The report contains independently observed results.'],
    checks: [{ title: 'Positive', command: ['node', 'checks/check.cjs'], expected_exit_code: 0,
      negative_controls: [{ title: 'Reject wrong product', command: ['node', 'checks/check.cjs', '--bad'], expected_exit_code: 1 }] }] };
  const run = { attempts: [{ id: 'producer-1', stage: 'implementation', state: 'completed', report: { outcome: 'completed' } },
    { id: 'verifier-1', stage: 'verification', state: 'completed', report: { outcome: 'completed', verdict: 'pass' } }],
    checks: [{ id: 'check-positive', attempt_id: 'verifier-1', title: 'Positive', command: ['node', 'checks/check.cjs'],
      negative: false, passed: true, exit_code: 0, expected_exit_code: 0, cancelled: false, log_sha256: 'a'.repeat(64), evidence_id: 'EVD-1' },
    { id: 'check-negative', attempt_id: 'verifier-1', title: 'Reject wrong product', command: ['node', 'checks/check.cjs', '--bad'],
      negative: true, passed: true, exit_code: 1, expected_exit_code: 1, cancelled: false, log_sha256: 'b'.repeat(64), evidence_id: 'EVD-2' }] };
  return { run, contract: { plan } };
}

test('only explicitly promised report documents enter the post-verification pass', () => {
  const { contract } = fixture(), plan = contract.plan;
  assert.deepEqual(evidenceReportPaths(plan), ['docs/report.md']);
  delete plan.evidence_report_paths;
  assert.deepEqual(evidenceReportPaths(plan), [], 'Ordinary documentation does not automatically add another model stage.');
  plan.acceptance_criteria = ['Final report at `docs/report.md` records real results, referencing docs/guide.md.'];
  assert.deepEqual(evidenceReportPaths(plan), ['docs/report.md'], 'A referenced ordinary guide is not itself a final report promise.');
  plan.acceptance_criteria = ['Báo cáo cuối docs/report.md và verifier report ghi argv, positive và negative results thực.'];
  assert.deepEqual(evidenceReportPaths(plan), ['docs/report.md']);
  plan.evidence_report_paths = [];
  assert.deepEqual(evidenceReportPaths(plan), ['docs/report.md'], 'An empty metadata field cannot disable an already committed final-report promise.');
  delete plan.evidence_report_paths;
  plan.acceptance_criteria = ['Final report docs/report.md.backup must not capture docs/report.md.', 'Read docs/report.md; final report is elsewhere.'];
  assert.deepEqual(evidenceReportPaths(plan), [], 'An exact output and unambiguous final-report association are both required.');
});

test('report routing cannot widen either producer ownership or independent checker access', () => {
  const { contract } = fixture();
  for (const path of ['checks/result.md', 'docs', '../docs/report.md', '.neomind/internal.md', 'docs/missing.md', 'src/product.cjs'])
    assert.throws(() => evidenceReportPaths({ ...contract.plan, evidence_report_paths: [path] }), /exact declared producer documentation/);
  assert.deepEqual(evidenceReportPaths({ ...contract.plan, evidence_report_paths: [] }), []);
  assert.deepEqual(evidenceReportPaths({ ...contract.plan, evidence_report_paths: ['docs/report.md', 'docs/report.md'] }), ['docs/report.md']);
});

test('primary Cornell notes and practice never become mutable evidence reports', () => {
  const { contract } = fixture(), plan = contract.plan;
  plan.cornell_output_dir = 'docs/cornell';
  const notes = ['note.md', 'exercises.md', 'answers.md', 'practice-solution.md'].map(name => `docs/cornell/${name}`);
  plan.outputs.push(...notes); plan.documentation_paths.push(...notes);
  for (const path of notes) assert.throws(() => evidenceReportPaths({ ...plan, evidence_report_paths: [path] }), /primary Cornell notes/);
  delete plan.evidence_report_paths; plan.acceptance_criteria = ['Final report docs/cornell/note.md is a misleading declaration.'];
  assert.deepEqual(evidenceReportPaths(plan), []);
});

test('post-check documentation source binds one completed producer and actual successful prescribed checks', () => {
  const { run, contract } = fixture(), before = structuredClone({ run, contract });
  const pending = pendingEvidenceDocumentation(run, contract);
  assert.deepEqual(pending, { paths: ['docs/report.md'], producer_attempt_id: 'producer-1', verifier_attempt_id: 'verifier-1',
    checks: [{ id: 'check-positive', log_sha256: 'a'.repeat(64), evidence_id: 'EVD-1' },
      { id: 'check-negative', log_sha256: 'b'.repeat(64), evidence_id: 'EVD-2' }] });
  assert.deepEqual({ run, contract }, before, 'Selecting a normal next stage cannot mutate contract, reports, counters or history.');
});

test('unfinished, stale, cancelled, mismatched and failing checks never authorize evidence documentation', () => {
  for (const mutate of [
    ({ run }) => { run.attempts[0].state = 'running'; },
    ({ run }) => { run.attempts[0].report.outcome = 'blocked'; },
    ({ run }) => { run.attempts[1].state = 'running'; },
    ({ run }) => { run.attempts[1].report.verdict = 'fail'; },
    ({ run }) => { run.attempts.reverse(); },
    ({ run }) => { run.checks.pop(); },
    ({ run }) => { run.checks[1].cancelled = true; },
    ({ run }) => { run.checks[1].passed = false; },
    ({ run }) => { run.checks[1].exit_code = 2; },
    ({ run }) => { run.checks[1].log_sha256 = ''; },
    ({ run }) => { run.checks[1].command = ['node', 'different-checker.cjs']; },
  ]) {
    const state = fixture(); mutate(state); assert.equal(pendingEvidenceDocumentation(state.run, state.contract), null);
  }
});

test('completed documentation followed by fresh verification does not create a documentation/verification loop', () => {
  const { run, contract } = fixture(), source = pendingEvidenceDocumentation(run, contract);
  run.attempts.push({ id: 'docs-1', stage: 'implementation', purpose: 'evidence-documentation', state: 'completed',
    report: { outcome: 'completed' }, documentation_source: source });
  assert.equal(pendingEvidenceDocumentation(run, contract), null);
  run.attempts.push({ id: 'verifier-2', stage: 'verification', state: 'completed', report: { outcome: 'completed', verdict: 'pass' } });
  run.checks.push(...run.checks.map(check => ({ ...check, id: `${check.id}-fresh`, attempt_id: 'verifier-2' })));
  assert.equal(pendingEvidenceDocumentation(run, contract), null);
  run.attempts.push({ id: 'producer-repair', stage: 'implementation', state: 'completed', report: { outcome: 'completed' } });
  assert.equal(pendingEvidenceDocumentation(run, contract), null, 'A genuinely repaired product still needs new independent checks.');
  run.attempts.push({ id: 'verifier-3', stage: 'verification', state: 'completed', report: { outcome: 'completed', verdict: 'pass' } });
  run.checks.push(...run.checks.filter(check => check.attempt_id === 'verifier-2').map(check => ({ ...check, id: `${check.id}-repair`, attempt_id: 'verifier-3' })));
  const next = pendingEvidenceDocumentation(run, contract);
  assert.equal(next.producer_attempt_id, 'producer-repair'); assert.equal(next.verifier_attempt_id, 'verifier-3');
});

test('a forged completed documentation binding cannot suppress the required normal pass', () => {
  for (const change of [source => { source.checks[0].log_sha256 = 'f'.repeat(64); },
    source => { source.paths = ['src/product.cjs']; }, source => { source.verifier_attempt_id = 'unrelated-verifier'; },
    source => { source.checks = []; }, source => { source.checks.pop(); }]) {
    const { run, contract } = fixture(), source = pendingEvidenceDocumentation(run, contract); change(source);
    run.attempts.push({ id: 'docs-1', stage: 'implementation', purpose: 'evidence-documentation', state: 'completed',
      report: { outcome: 'completed' }, documentation_source: source });
    assert.throws(() => pendingEvidenceDocumentation(run, contract), /source binding changed/);
  }
});

function withDeferredReport() {
  const state = fixture();
  state.contract.plan.checks.push({ title: 'Final report semantics', command: ['node', 'checks/report.cjs', 'docs/report.md'],
    expected_exit_code: 0, after_evidence_reports: true, baseline_paths: ['checks/report.cjs', 'docs/report.md'],
    negative_controls: [{ title: 'Reject report with fabricated results', command: ['node', 'checks/report.cjs', 'checks/wrong-report.md'], expected_exit_code: 1 }] });
  return state;
}

test('product checkpoint precedes factual report writing and all original checks return for final verification', () => {
  const { run, contract } = withDeferredReport(), frozen = structuredClone(contract);
  assert.deepEqual(controlledChecksForPhase(run, contract).map(check => check.title), ['Positive']);
  const source = pendingEvidenceDocumentation(run, contract);
  assert.deepEqual(source.checks.map(check => check.id), ['check-positive', 'check-negative'],
    'Initial product proof can authorize the report without demanding nonexistent future report evidence.');
  run.attempts.push({ id: 'docs-1', stage: 'implementation', purpose: 'evidence-documentation', state: 'running',
    documentation_source: source });
  assert.deepEqual(controlledChecksForPhase(run, contract).map(check => check.title), ['Positive'],
    'A selected or running documentation pass is not a completed final report.');
  Object.assign(run.attempts.at(-1), { state: 'completed', report: { outcome: 'completed' } });
  const finalChecks = controlledChecksForPhase(run, contract);
  assert.deepEqual(finalChecks, contract.plan.checks);
  assert.deepEqual(finalChecks[1].baseline_paths, ['checks/report.cjs', 'docs/report.md'], 'Backend retains complete check fields.');
  assert.deepEqual(finalChecks[1].negative_controls, contract.plan.checks[1].negative_controls);
  assert.equal(pendingEvidenceDocumentation(run, contract), null);
  finalChecks[0].command.push('caller mutation');
  assert.deepEqual(contract, frozen, 'Phase selection neither edits nor drops commands from the frozen final acceptance contract.');
  run.attempts.push({ id: 'verifier-2', stage: 'verification', state: 'running' });
  assert.deepEqual(controlledChecksForPhase(run, contract), contract.plan.checks);
  assert.equal(pendingEvidenceDocumentation(run, contract), null, 'Fresh final verification does not reopen the same documentation pass.');
});

test('later genuine product repairs require a new product checkpoint before another final-report pass', () => {
  const { run, contract } = withDeferredReport(), source = pendingEvidenceDocumentation(run, contract);
  run.attempts.push({ id: 'docs-1', stage: 'implementation', purpose: 'evidence-documentation', state: 'completed',
    report: { outcome: 'completed' }, documentation_source: source });
  assert.equal(controlledChecksForPhase(run, contract).length, 2);
  run.attempts.push({ id: 'producer-2', stage: 'implementation', state: 'completed', report: { outcome: 'completed' } });
  assert.deepEqual(controlledChecksForPhase(run, contract).map(check => check.title), ['Positive']);
  assert.equal(pendingEvidenceDocumentation(run, contract), null);
  run.attempts.push({ id: 'verifier-2', stage: 'verification', state: 'completed', report: { outcome: 'completed', verdict: 'pass' } });
  run.checks.push(...run.checks.map(check => ({ ...check, id: `${check.id}-2`, attempt_id: 'verifier-2' })));
  const next = pendingEvidenceDocumentation(run, contract);
  assert.equal(next.producer_attempt_id, 'producer-2'); assert.equal(next.verifier_attempt_id, 'verifier-2');
  assert.deepEqual(next.paths, ['docs/report.md']);
});

test('deferred checks cannot eliminate initial product verification or invent report write authority', () => {
  const cases = [
    state => { state.contract.plan.checks[0].after_evidence_reports = true; },
    state => { state.contract.plan.evidence_report_paths = []; },
    state => { delete state.contract.plan.evidence_report_paths; },
  ];
  for (const mutate of cases) {
    const state = withDeferredReport(); mutate(state);
    assert.throws(() => controlledChecksForPhase(state.run, state.contract), /at least one product check before documentation/);
    assert.throws(() => pendingEvidenceDocumentation(state.run, state.contract), /at least one product check before documentation/);
  }
});

test('legacy plans retain every initial check and no deferred metadata is added to their immutable bytes', () => {
  const { run, contract } = fixture(); delete contract.plan.evidence_report_paths;
  contract.plan.acceptance_criteria = ['Final report at docs/report.md contains actual observations.'];
  const before = structuredClone(contract);
  assert.deepEqual(controlledChecksForPhase(run, contract), contract.plan.checks);
  assert.ok(pendingEvidenceDocumentation(run, contract)); assert.deepEqual(contract, before);
});

test('a forged documentation source cannot expose deferred final checks as ready', () => {
  const { run, contract } = withDeferredReport(), source = pendingEvidenceDocumentation(run, contract);
  source.checks.pop();
  run.attempts.push({ id: 'docs-forged', stage: 'implementation', purpose: 'evidence-documentation', state: 'completed',
    report: { outcome: 'completed' }, documentation_source: source });
  assert.throws(() => controlledChecksForPhase(run, contract), /source binding changed/);
});
