import { canonicalJson } from './routing.js';
import { hash } from './storage.js';
import { latestControlledChecks } from './controlled-current-checks.js';
import type { ControlledSnapshot } from './controlled-workflow.js';

export interface ControlledDiagnosisSource {
  schema_version: 1; source_attempt_id: string; source_fingerprint: string; key: string;
}
type State = Pick<ControlledSnapshot, 'attempts' | 'checks'> & { diagnosis_sources?: ControlledDiagnosisSource[] };
type Attempt = ControlledSnapshot['attempts'][number];
const genuine = (attempt: Attempt) => attempt.purpose !== 'specialist' && attempt.stage !== 'diagnosis';

/** Backend failure identity excludes unrelated journal revisions, progress events and model wording. */
export function controlledDiagnosisSource(run: State, source: Attempt | undefined): ControlledDiagnosisSource | undefined {
  if (!source || !genuine(source) || source.state !== 'completed') return undefined;
  const fingerprint = hash(canonicalJson({ stage: source.stage, role: source.role, invocation_id: source.invocation_id ?? null,
    request_id: source.request_id, report_fingerprint: source.report_fingerprint ?? null, bound_hashes: source.bound_hashes ?? {},
    checks: latestControlledChecks(run.checks, source.id).map(check => ({ id: check.id, title: check.title,
      log_sha256: check.log_sha256, evidence_id: check.evidence_id ?? null, passed: check.passed, baseline: check.baseline })) }));
  return { schema_version: 1, source_attempt_id: source.id, source_fingerprint: fingerprint,
    key: hash(canonicalJson({ source_attempt_id: source.id, source_fingerprint: fingerprint })) };
}

/** Existing signed-stage order supplies legacy source bindings without rewriting historical attempts. */
export function controlledDiagnosisDecision(run: State, maximum: number): {
  allowed: boolean; reason: 'eligible' | 'no-new-failure-source' | 'same-failure-source' | 'diagnosis-budget-exhausted' | 'invalid-source-ledger';
  source?: ControlledDiagnosisSource; previous_sources: ControlledDiagnosisSource[];
} {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 3) throw new Error('Diagnosis uses the existing bounded project repair allowance.');
  const previous = new Map<string, ControlledDiagnosisSource>();
  if (run.diagnosis_sources !== undefined && !Array.isArray(run.diagnosis_sources))
    return { allowed: false, reason: 'invalid-source-ledger', previous_sources: [] };
  for (const [index, attempt] of run.attempts.entries()) if (attempt.stage === 'diagnosis' && attempt.purpose !== 'specialist') {
    const source = controlledDiagnosisSource(run, run.attempts.slice(0, index).findLast(genuine));
    if (!source) return { allowed: false, reason: 'invalid-source-ledger', previous_sources: [...previous.values()] };
    previous.set(source.key, source);
  }
  for (const entry of run.diagnosis_sources ?? []) {
    if (!entry || entry.schema_version !== 1 || typeof entry.source_attempt_id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.source_fingerprint) || !/^[a-f0-9]{64}$/.test(entry.key))
      return { allowed: false, reason: 'invalid-source-ledger', previous_sources: [...previous.values()] };
    const source = controlledDiagnosisSource(run, run.attempts.find(attempt => attempt.id === entry.source_attempt_id));
    if (!source || canonicalJson(entry) !== canonicalJson(source))
      return { allowed: false, reason: 'invalid-source-ledger', previous_sources: [...previous.values()] };
    previous.set(source.key, source);
  }
  const source = controlledDiagnosisSource(run, run.attempts.at(-1));
  const result = { source, previous_sources: [...previous.values()] };
  if (!source) return { ...result, allowed: false, reason: 'no-new-failure-source' };
  if (previous.has(source.key)) return { ...result, allowed: false, reason: 'same-failure-source' };
  if (previous.size >= maximum) return { ...result, allowed: false, reason: 'diagnosis-budget-exhausted' };
  return { ...result, allowed: true, reason: 'eligible' };
}
