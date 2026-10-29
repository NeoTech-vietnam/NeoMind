export type ReviewVerdict = 'pass' | 'needs_changes' | 'blocked' | 'inconclusive';
export interface ReviewerSpec { id: string; required: boolean }
export interface ReviewerResult {
  reviewerId: string; sessionId: string; baselineHash: string; verdict: ReviewVerdict;
  findingIds: string[];
}
/** Assessment is produced by trusted core evidence checks, never by the reviewer. */
export interface ReviewAssessment {
  evidenceValidated: boolean;
  criteriaCovered: boolean;
  verifiedFindingIds: string[];
  unresolvedDisagreement: boolean;
  mandatoryCriteriaFailed: boolean;
}
export type ReviewDecision =
  | { decision: 'pass'; advisoryFindingIds: string[] }
  | { decision: 'needs_changes'; findingIds: string[] }
  | { decision: 'waiting'; reasons: string[] };

/** Aggregate only evidence already checked by core against the exact artifact baseline. */
export function evaluateReviews(
  reviewers: ReviewerSpec[], results: ReviewerResult[], assessments: Record<string, ReviewAssessment>,
  baselineHash: string, producerSessionId: string,
): ReviewDecision {
  if (!baselineHash || !producerSessionId) throw new Error('Baseline and producer session are required');
  if (reviewers.length === 0 || !reviewers.some(r => r.required)) throw new Error('A required reviewer is necessary');
  if (new Set(reviewers.map(r => r.id)).size !== reviewers.length) throw new Error('Duplicate reviewer ID');
  if (new Set(results.map(r => r.reviewerId)).size !== results.length) throw new Error('Duplicate review result');
  if (new Set(results.map(r => r.sessionId)).size !== results.length) throw new Error('Review sessions must be independent');
  const definitions = new Map(reviewers.map(r => [r.id, r]));
  const byId = new Map(results.map(r => [r.reviewerId, r]));
  for (const result of results) {
    if (!definitions.has(result.reviewerId)) throw new Error(`Unknown reviewer ${result.reviewerId}`);
    if (!result.sessionId || result.sessionId === producerSessionId) throw new Error('Reviewer must use a different session from the producer');
  }
  const reasons: string[] = [], repair = new Set<string>(), advisory = new Set<string>();
  for (const spec of reviewers) {
    const result = byId.get(spec.id), check = assessments[spec.id];
    if (!result) { if (spec.required) reasons.push(`${spec.id}: missing result`); continue; }
    if (result.baselineHash !== baselineHash) { if (spec.required) reasons.push(`${spec.id}: stale baseline`); continue; }
    if (!check || !check.evidenceValidated || !check.criteriaCovered) {
      if (spec.required) reasons.push(`${spec.id}: evidence or criteria not verified`);
      continue;
    }
    if (check.unresolvedDisagreement) { reasons.push(`${spec.id}: unresolved disagreement`); continue; }
    if (result.verdict === 'blocked' || result.verdict === 'inconclusive') {
      if (spec.required) reasons.push(`${spec.id}: ${result.verdict}`);
      continue;
    }
    if (result.verdict === 'needs_changes') {
      const verified = result.findingIds.filter(id => check.verifiedFindingIds.includes(id));
      if (verified.length === 0) { if (spec.required || check.mandatoryCriteriaFailed) reasons.push(`${spec.id}: findings not verified`); continue; }
      if (spec.required || check.mandatoryCriteriaFailed) verified.forEach(id => repair.add(id));
      else verified.forEach(id => advisory.add(id));
    } else if (check.mandatoryCriteriaFailed) {
      reasons.push(`${spec.id}: mandatory criteria failed despite pass verdict`);
    }
  }
  if (reasons.length) return { decision: 'waiting', reasons };
  if (repair.size) return { decision: 'needs_changes', findingIds: [...repair].sort() };
  return { decision: 'pass', advisoryFindingIds: [...advisory].sort() };
}
