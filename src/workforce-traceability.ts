import type { ControlledContract, ControlledSnapshot } from './controlled-workflow.js';
import { createHash } from 'node:crypto';
const digest = (value: Record<string, string>) => createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');

/** Derived engineering trace. IDs and associations come from the saved backend
 * contract/results, never another model-authored record payload. */
export function workforceTraceability(run: ControlledSnapshot, contract: ControlledContract) {
  const last = (stage: string) => run.attempts.findLast(item => item.stage === stage && item.state === 'completed' &&
    item.report?.outcome === 'completed' && item.purpose !== 'check-review' && item.purpose !== 'design-review');
  const requirements = last('requirements'), design = last('design'), producer = last('implementation'),
    reviewer = last('review'), tester = last('verification');
  return contract.plan.acceptance_criteria.map((text, index) => {
    const levels = contract.verification_levels?.filter(level => level.applicable &&
      (!level.criterion_indexes?.length || level.criterion_indexes.includes(index + 1))) ?? [];
    const titles = new Set(levels.flatMap(level => level.checks));
    const evidence = run.checks.filter(check => check.attempt_id === tester?.id && !check.negative && titles.has(check.title));
    return { criterion_id: `C${index + 1}`, text, requirement_ids: [...contract.requirement_ids],
      requirements: requirements?.report_id ? { report_id: requirements.report_id, invocation_id: requirements.invocation_id } : null,
      design: design?.report_id ? { report_id: design.report_id, invocation_id: design.invocation_id } : null,
      products: contract.plan.outputs.map(path => {
        const baseline = Object.fromEntries(Object.entries(producer?.bound_hashes ?? {}).filter(([file]) => file === path || file.startsWith(`${path}/`)));
        return { path, reported_baseline_sha256: Object.keys(baseline).length ? digest(baseline) : null };
      }),
      verification: levels.map(level => ({ level: level.level, method: level.method, rationale: level.rationale, checks: [...level.checks] })),
      evidence: evidence.map(check => ({ check_id: check.id, title: check.title, passed: check.passed, baseline_sha256: digest(check.baseline),
        log_path: check.log_path, log_sha256: check.log_sha256, evidence_id: check.evidence_id ?? null })),
      review: reviewer?.report_id ? { report_id: reviewer.report_id, invocation_id: reviewer.invocation_id, verdict: reviewer.report?.verdict } : null,
      independent_assessment: tester?.report_id ? { report_id: tester.report_id, invocation_id: tester.invocation_id,
        verdict: tester.report?.verdict } : null,
      // This matrix never substitutes for the acceptance evaluator or claims a
      // check passed merely because a requirement was allocated to its title.
      acceptance_authority: 'current-contract-evaluator' as const };
  });
}
