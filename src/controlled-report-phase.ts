import { canonicalJson } from './routing.js';
import type { ControlledCheckReceipt } from './controlled-workflow.js';
import { latestControlledChecks, controlledCheckMatches } from './controlled-current-checks.js';

interface DocumentationPlan {
  documentation_paths: string[]; outputs: string[]; allowed_paths: string[]; verification_paths: string[];
  acceptance_criteria: string[]; cornell_output_dir?: string; evidence_report_paths?: string[];
  checks: { title: string; command: string[]; expected_exit_code?: number; after_evidence_reports?: boolean;
    negative_controls?: { title: string; command: string[]; expected_exit_code: number }[] }[];
}
export interface EvidenceDocumentationSource {
  paths: string[]; producer_attempt_id: string; verifier_attempt_id: string;
  checks: { id: string; log_sha256: string; evidence_id?: string }[];
}
interface DocumentationAttempt {
  id: string; stage: string; state: string; purpose?: string;
  report?: { outcome?: string; verdict?: string };
  documentation_source?: EvidenceDocumentationSource;
}
interface DocumentationState { attempts: DocumentationAttempt[]; checks: ControlledCheckReceipt[] }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const covers = (scope: string, path: string) => key(scope) === key(path) || key(path).startsWith(`${key(scope)}/`);
const plain = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
const canonicalPath = (path: string) => path && !path.startsWith('/') && !/[\\:\x00-\x1f]/.test(path) &&
  !path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function explicitlyFinal(criterion: string, path: string): boolean {
  // Existing frozen plans cannot acquire new fields. Recognize only a final
  // report promise that already names this exact declared document path.
  // This is routing metadata, never authority to relax the criterion itself.
  const boundary = '(?=$|[\\s\x60"\'),;:]|\\.(?=\\s|$))';
  const exact = new RegExp(`(?:^|[\\s\x60"'(])${escapeRegExp(path)}${boundary}`).test(criterion);
  const final = '(?:final\\s+(?:verification\\s+|execution\\s+|acceptance\\s+)?report|post[- ]verification\\s+report|bao\\s+cao\\s+cuoi)';
  return exact && new RegExp(`\\b${final}\\s*(?:(?:at|in|tai)\\s*)?[:\\-]?\\s*[\x60"']?${escapeRegExp(plain(path))}${boundary}`).test(plain(criterion));
}

/** Derive only already promised final report outputs; learner notes stay immutable. */
export function evidenceReportPaths(plan: DocumentationPlan): string[] {
  const primary = new Set(plan.cornell_output_dir ?
    ['note.md', 'exercises.md', 'answers.md', 'practice-solution.md'].map(name => key(`${plan.cornell_output_dir}/${name}`)) : []);
  const eligible = (path: string) => canonicalPath(path) && plan.documentation_paths.includes(path) && plan.outputs.includes(path) &&
    plan.allowed_paths.some(scope => covers(scope, path)) && !plan.verification_paths.some(scope => covers(scope, path)) && !primary.has(key(path));
  const promised = plan.documentation_paths.filter(path => eligible(path) && plan.acceptance_criteria.some(criterion => explicitlyFinal(criterion, path)));
  if (plan.evidence_report_paths !== undefined) {
    if (plan.evidence_report_paths.length > 128 || plan.evidence_report_paths.some(path => !eligible(path)))
      throw new Error('Evidence report paths must be exact declared producer documentation outputs outside independent checks and primary Cornell notes.');
    return [...new Set([...plan.evidence_report_paths, ...promised])];
  }
  return [...new Set(promised)];
}

function checkpointChecks<Check extends DocumentationPlan['checks'][number]>(
  plan: Omit<DocumentationPlan, 'checks'> & { checks: Check[] }): Check[] {
  const reports = evidenceReportPaths(plan);
  const initial = plan.checks.filter(check => !(check.after_evidence_reports ?? check.command.some(arg => reports.includes(arg))));
  if (initial.length !== plan.checks.length && (!initial.length || !reports.length))
    throw new Error('Deferred evidence-report checks require declared evidence report outputs and at least one product check before documentation.');
  return initial;
}

function prescribedChecks(run: DocumentationState, plannedChecks: DocumentationPlan['checks'], verifier: DocumentationAttempt): ControlledCheckReceipt[] | null {
  const titles = new Set(plannedChecks.flatMap(check => [check.title, ...(check.negative_controls ?? []).map(check => check.title)]));
  const checks = latestControlledChecks(run.checks, verifier.id).filter(check => titles.has(check.title)), selected: ControlledCheckReceipt[] = [];
  for (const planned of plannedChecks) {
    if ((planned.expected_exit_code ?? 0) !== 0 || !planned.negative_controls?.length ||
        planned.negative_controls.some(check => check.expected_exit_code === 0)) return null;
    for (const expectation of [{ ...planned, negative: false }, ...planned.negative_controls.map(check => ({ ...check, negative: true }))]) {
      const check = checks.find(check => check.title === expectation.title && controlledCheckMatches(check, expectation));
      if (!check?.passed || check.cancelled || check.exit_code !== check.expected_exit_code || !/^[a-f0-9]{64}$/.test(check.log_sha256)) return null;
      selected.push(check);
    }
  }
  return !selected.length || checks.some(check => !check.passed) ? null : selected;
}
const checkReferences = (checks: ControlledCheckReceipt[]) => checks.map(check => ({ id: check.id, log_sha256: check.log_sha256,
  ...(check.evidence_id ? { evidence_id: check.evidence_id } : {}) }));

function genuineProducer(run: DocumentationState): DocumentationAttempt | undefined {
  return run.attempts.findLast(attempt => attempt.stage === 'implementation' && attempt.purpose !== 'evidence-documentation' && attempt.purpose !== 'specialist');
}

function completedDocumentation(run: DocumentationState, plan: DocumentationPlan, producer: DocumentationAttempt,
  paths: string[]): DocumentationAttempt | undefined {
  const previous = run.attempts.findLast(attempt => attempt.stage === 'implementation' && attempt.purpose === 'evidence-documentation' &&
    attempt.documentation_source?.producer_attempt_id === producer.id && attempt.state === 'completed' && attempt.report?.outcome === 'completed');
  if (!previous) return undefined;
  const source = previous.documentation_source!;
  const sourceVerifier = run.attempts.find(attempt => attempt.id === source.verifier_attempt_id);
  const sourceChecks = sourceVerifier ? prescribedChecks(run, checkpointChecks(plan), sourceVerifier) : null;
  if (!same(source.paths, paths) || sourceVerifier?.stage !== 'verification' ||
      sourceVerifier.state !== 'completed' || sourceVerifier.report?.outcome !== 'completed' || sourceVerifier.report.verdict !== 'pass' ||
      run.attempts.indexOf(sourceVerifier) <= run.attempts.indexOf(producer) || run.attempts.indexOf(sourceVerifier) >= run.attempts.indexOf(previous) ||
      !sourceChecks || !same(source.checks, checkReferences(sourceChecks)))
    throw new Error('The completed evidence-documentation source binding changed; retain its history for backend reconciliation.');
  return previous;
}

/** Deferred report checks still belong to the immutable final acceptance set. */
export function controlledChecksForPhase<Check extends DocumentationPlan['checks'][number]>(run: DocumentationState,
  contract: { plan: Omit<DocumentationPlan, 'checks'> & { checks: Check[] } }): Check[] {
  const initial = checkpointChecks(contract.plan);
  if (initial.length === contract.plan.checks.length) return structuredClone(contract.plan.checks);
  const producer = genuineProducer(run), paths = evidenceReportPaths(contract.plan);
  const documented = !!producer && producer.state === 'completed' && producer.report?.outcome === 'completed' &&
    !!completedDocumentation(run, contract.plan, producer, paths);
  return structuredClone(documented ? contract.plan.checks : initial);
}

/** A normal post-check report pass is once per actual implementation generation. */
export function pendingEvidenceDocumentation(run: DocumentationState, contract: { plan: DocumentationPlan }): EvidenceDocumentationSource | null {
  const initial = checkpointChecks(contract.plan);
  const paths = evidenceReportPaths(contract.plan);
  if (!paths.length) return null;
  const producer = genuineProducer(run);
  if (!producer || producer.state !== 'completed' || producer.report?.outcome !== 'completed') return null;
  if (completedDocumentation(run, contract.plan, producer, paths)) return null;
  const verifier = run.attempts.findLast(attempt => attempt.stage === 'verification' && attempt.purpose !== 'specialist');
  if (!verifier || verifier.state !== 'completed' || verifier.report?.outcome !== 'completed' || verifier.report.verdict !== 'pass' ||
      run.attempts.indexOf(verifier) <= run.attempts.indexOf(producer)) return null;
  const selected = prescribedChecks(run, initial, verifier);
  if (!selected) return null;
  return { paths, producer_attempt_id: producer.id, verifier_attempt_id: verifier.id,
    checks: checkReferences(selected) };
}
