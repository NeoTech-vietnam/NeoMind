import { canonicalJson } from './routing.js';
import { now } from './storage.js';
import { controlledContractForTask, controlledFingerprints, controlledRecordView } from './controlled-acceptance.js';
import { controlledPublicReferencePath, controlledSkillInputPath, type ControlledReviewPurpose } from './controlled-tools.js';
import type { ControlledContract, ControlledSnapshot } from './controlled-workflow.js';
import { latestControlledChecks } from './controlled-current-checks.js';
import { captureControlledCheckerScope, projectControlledCheckerScope } from './controlled-checker-scope.js';

/** Current backend facts, not an agent verdict or a new historical baseline. */
export function controlledReviewContext(root: string, supplied: ControlledSnapshot, expected?: ControlledContract,
  purpose: ControlledReviewPurpose = 'final-product', maxFiles = 64) {
  const unavailable = (reason: string) => ({ kind: 'workflow' as const, available: false, reason });
  if (!expected) return unavailable('NO_FROZEN_CONTRACT');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 128)
    throw new Error('Workflow evidence can display between one and 128 scoped preservation files.');
  if (expected.workflow_id !== supplied.workflow_id || expected.epoch_id !== supplied.epoch_id)
    return unavailable('CONTRACT_BINDING_MISMATCH');
  // Reuse the acceptance authority seam: validate the actual journal, sealed
  // contract, task scopes, parent binding and immutable requirement baselines.
  // A caller-supplied hash map alone can never become preservation evidence.
  const recordAt = controlledRecordView(root);
  const { run, contract } = controlledContractForTask(root, recordAt(expected.task_id), undefined, recordAt);
  if (run.workflow_id !== supplied.workflow_id || run.epoch_id !== supplied.epoch_id ||
      run.contract_hash !== supplied.contract_hash || canonicalJson(expected) !== canonicalJson(contract))
    return unavailable('CONTRACT_BINDING_MISMATCH');
  const observedAt = now(), preserved = Object.keys(contract.preserved_hashes).sort();
  const current = controlledFingerprints(root, preserved);
  const changes = preserved.filter(path => current[path] !== contract.preserved_hashes[path]);
  const visible = preserved.filter(path => controlledPublicReferencePath(path) ||
    contract.plan.input_paths?.includes(path) && controlledSkillInputPath(path));
  const ordered = [...visible.filter(path => changes.includes(path)), ...visible.filter(path => !changes.includes(path))];
  const latest = (stage: string) => run.attempts.findLast(attempt => attempt.stage === stage && attempt.purpose !== 'specialist' && attempt.purpose !== 'check-review');
  const producer = latest('implementation'), verifier = latest('verification');
  const selectedChecks = verifier ? latestControlledChecks(run.checks, verifier.id) : [];
  const checkerScope = selectedChecks.length ? captureControlledCheckerScope(contract.plan.verification_paths, paths => controlledFingerprints(root, paths)) : undefined;
  const currentChecks = checkerScope ? selectedChecks.map(check => projectControlledCheckerScope(check, checkerScope)) : [];
  const fresh = !!verifier && !!producer && run.attempts.indexOf(verifier) > run.attempts.indexOf(producer);
  // A public report.md named in plan.outputs remains a producer deliverable.
  // It is never confused with the backend final record created after review.
  const documents = contract.plan.documentation_paths.map(path => ({ path, owner: 'developer' as const,
    declared_output: contract.plan.outputs.includes(path), final_criteria_still_apply: true }));
  let finalRecord = 'not-created' as 'not-created' | 'pending-acceptance' | 'completed' | 'invalid';
  const reportId = run.final_report_id ?? run.finalizing_report_id;
  if (reportId) {
    try {
      const report = recordAt(reportId);
      const matches = report.meta.type === 'knowledge' && report.meta.owner === 'manager' &&
        report.meta.data.kind === 'controlled-final-report' && report.meta.data.workflow_id === run.workflow_id &&
        report.meta.data.epoch_id === run.epoch_id && report.meta.data.contract_hash === run.contract_hash;
      finalRecord = !matches ? 'invalid'
        : run.status === 'completed' && run.phase === 'completed' && run.final_report_id === reportId ? 'completed' : 'pending-acceptance';
    } catch { finalRecord = 'invalid'; }
  }
  return {
    kind: 'workflow' as const, available: true, observed_at: observedAt,
    source: 'backend-immutable-contract-and-current-files' as const,
    workflow_id: run.workflow_id, task_id: contract.task_id, epoch_id: run.epoch_id,
    contract_hash: run.contract_hash, review_purpose: purpose,
    state: { workflow_status: run.status, stage: run.phase, revision: run.revision },
    preservation: {
      baseline_source: 'original-immutable-plan' as const,
      baseline_captured_at: run.events.find(event => event.kind === 'plan-saved')?.at ?? null,
      file_count: preserved.length, all_unchanged: changes.length === 0, changed_count: changes.length,
      checked_at: observedAt,
      files: ordered.slice(0, maxFiles).map(path => ({ path,
        expected_sha256: contract.preserved_hashes[path]!, current_sha256: current[path]!,
        unchanged: current[path] === contract.preserved_hashes[path] })),
      displayed_count: Math.min(ordered.length, maxFiles), omitted_count: preserved.length - Math.min(ordered.length, maxFiles),
      private_path_count: preserved.length - visible.length,
      coverage: 'Only the files captured by the original declared preservation/input contract. This is not a whole-repository historical snapshot. No new baseline was substituted.' as const,
    },
    checks: {
      fresh_after_latest_producer: fresh,
      latest_verifier_completed: verifier?.state === 'completed' && verifier.report?.outcome === 'completed',
      positive_count: currentChecks.filter(check => !check.negative).length,
      negative_count: currentChecks.filter(check => check.negative).length,
      journal_results_all_passed: currentChecks.length > 0 && currentChecks.every(check => check.observed_passed),
      current_results_all_passed: currentChecks.length > 0 && currentChecks.every(check => check.passed),
      checker_scope_current: currentChecks.length > 0 && currentChecks.every(check => check.checker_scope_current),
      authority: 'Read bound execution evidence for actual commands, diagnostics and negative-control meaning. These counts alone do not establish acceptance.' as const,
    },
    finalization: {
      backend_final_report: finalRecord,
      final_report_pending: finalRecord !== 'completed',
      backend_final_report_created_after_required_review: true,
      producer_documents: documents,
      duties: 'Judge producer deliverables against their unchanged criteria and actual bound evidence. A missing backend final record is expected before acceptance. A requested final-report artifact remains an output requirement; handoff prose cannot replace promised post-verification findings. Do not rewrite checked artifacts in a read-only review.' as const,
    },
  };
}
