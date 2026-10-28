import { lstatSync, readFileSync } from 'node:fs';
import { canonicalJson, readInvocation, routingProblems } from './routing.js';
import { hash, safePath } from './storage.js';
import { evidenceRecordFingerprint, validateEvidenceInputs } from './evidence-inputs.js';
import { controlledAcceptanceBudget, controlledContractForTask, controlledRecordView, type ControlledRecordAt } from './controlled-acceptance.js';
import { pendingEvidenceDocumentation, type EvidenceDocumentationSource } from './controlled-report-phase.js';
import { ControlledToolError } from './controlled-tools.js';
import { ControlledEvidenceScanTimeout } from './controlled-evidence-error.js';
import { captureControlledCheckerScope, controlledCheckerScopeCurrent } from './controlled-checker-scope.js';
import type { ControlledContract, ControlledSnapshot, ControlledCheckReceipt } from './controlled-workflow.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type Attempt = ControlledSnapshot['attempts'][number];
type AuthorityBudget = ReturnType<typeof controlledAcceptanceBudget>;

/** Authenticate a report-only handoff without changing earlier records or evidence. */
export function assertEvidenceDocumentationAuthority(root: string, supplied: ControlledSnapshot, expected: ControlledContract,
  source: EvidenceDocumentationSource, admission?: { allow_blocked: boolean }): Record<string, string> {
  try { return evidenceDocumentationAuthority(root, supplied, expected, source, undefined, admission); }
  catch (error) {
    if (error instanceof ControlledToolError || error instanceof ControlledEvidenceScanTimeout) throw error;
    throw new ControlledToolError('STATE_UNCERTAIN', 'The backend could not authenticate the original documentation checkpoint. Preserve its signed reports, execution logs and input snapshots for runtime reconciliation; do not construct replacement IDs or credentials.');
  }
}

function evidenceDocumentationAuthority(root: string, supplied: ControlledSnapshot, expected: ControlledContract,
  source: EvidenceDocumentationSource, history?: { completed_attempt_id: string; budget: AuthorityBudget; recordAt?: ControlledRecordAt },
  admission?: { allow_blocked: boolean }): Record<string, string> {
  const budget = history?.budget ?? controlledAcceptanceBudget(root);
  const recordAt = history?.recordAt ?? controlledRecordView(root, budget.check);
  const { run, contract } = history ? { run: supplied, contract: expected }
    : controlledContractForTask(root, recordAt(expected.task_id), budget.check, recordAt);
  if (history) {
    budget.check();
    const sealed = readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.contract.json`));
    if (hash(sealed) !== run.contract_hash || !same(JSON.parse(sealed.toString('utf8')), expected))
      throw new ControlledToolError('STATE_UNCERTAIN', 'The original documentation contract changed after its source evidence was saved.');
  }
  const documentation = history ? run.attempts.find(attempt => attempt.id === history.completed_attempt_id) : undefined;
  const beforeDocumentation = documentation ? { ...run, attempts: run.attempts.slice(0, run.attempts.indexOf(documentation)) } : run;
  if (run.workflow_id !== supplied.workflow_id || run.epoch_id !== supplied.epoch_id || run.contract_hash !== supplied.contract_hash ||
      !same(contract, expected) || (!history && !['queued', 'running'].includes(run.status) && !(admission?.allow_blocked && run.status === 'blocked')) ||
      history && (!documentation || documentation.purpose !== 'evidence-documentation' || documentation.stage !== 'implementation' ||
        documentation.role !== 'developer' || documentation.state !== 'completed' || documentation.report?.outcome !== 'completed' ||
        !same(documentation.documentation_source, source)) ||
      !same(pendingEvidenceDocumentation(beforeDocumentation, contract), source))
    throw new ControlledToolError('STATE_UNCERTAIN', 'Evidence-documentation assignment differs from its authoritative producer/check checkpoint.');
  const producer = run.attempts.find(attempt => attempt.id === source.producer_attempt_id);
  const verifier = run.attempts.find(attempt => attempt.id === source.verifier_attempt_id);
  if (!producer || !verifier || producer.purpose === 'evidence-documentation' ||
      producer.stage !== 'implementation' || producer.role !== 'developer' || verifier.stage !== 'verification' || verifier.role !== 'verifier' ||
      run.attempts.indexOf(producer) >= run.attempts.indexOf(verifier) || !['pass', 'fail'].includes(verifier.report?.verdict ?? ''))
    throw new ControlledToolError('STATE_UNCERTAIN', 'Evidence documentation requires independent producer and Verifier stages in their original order.');
  const authenticate = (attempt: Attempt) => {
    budget.check();
    if (attempt.state !== 'completed' || attempt.report?.outcome !== 'completed' || !attempt.invocation_id ||
        !attempt.report_id || !attempt.report_fingerprint || !attempt.bound_hashes)
      throw new ControlledToolError('STATE_UNCERTAIN', 'The source stage lacks its completed signed result and artifact binding.');
    const receipt = readInvocation(root, attempt.invocation_id), report = recordAt(attempt.report_id);
    if (routingProblems(root, attempt.role, receipt.id, { workflow_id: run.workflow_id, task_id: contract.task_id, require_completed: true }).length ||
        !isControlledExecutionReceipt(receipt) || receipt.state !== 'completed' || !receipt.inference_completed ||
        receipt.workflow_id !== run.workflow_id || receipt.task_id !== contract.task_id || receipt.role !== attempt.role ||
        receipt.request_id !== attempt.request_id || receipt.controlled_execution?.epoch_id !== run.epoch_id ||
        receipt.controlled_execution.stage !== attempt.stage || report.meta.type !== 'knowledge' || report.meta.owner !== attempt.role ||
        report.meta.data.kind !== 'controlled-work-record' || report.meta.data.workflow_id !== run.workflow_id ||
        report.meta.data.task_id !== contract.task_id || report.meta.data.epoch_id !== run.epoch_id ||
        report.meta.data.attempt_id !== attempt.id || report.meta.data.invocation_id !== receipt.id || report.meta.data.stage !== attempt.stage ||
        attempt.verification_purpose !== undefined && report.meta.data.verification_purpose !== attempt.verification_purpose ||
        report.meta.data.outcome !== attempt.report.outcome || report.meta.data.report_payload_hash !== hash(canonicalJson(attempt.report)) ||
        !same(report.meta.data.artifact_hashes, attempt.bound_hashes) || evidenceRecordFingerprint(report) !== attempt.report_fingerprint)
      throw new ControlledToolError('STATE_UNCERTAIN', 'The source stage differs from its signed task, epoch, request or saved typed report.');
    budget.check(); return receipt;
  };
  authenticate(producer); authenticate(verifier);
  if (documentation) {
    const receipt = authenticate(documentation), declared = receipt.controlled_execution;
    if (declared?.tool_contract?.version !== 3 || !declared.tool_contract.evidence_documentation ||
        declared.documentation_source_sha256 !== hash(canonicalJson(source)))
      throw new ControlledToolError('STATE_UNCERTAIN', 'The completed documentation source differs from its signed backend checkpoint identity.');
    if (run.attempts.indexOf(documentation) <= run.attempts.indexOf(verifier) ||
        documentation.invocation_id === producer.invocation_id || documentation.invocation_id === verifier.invocation_id)
      throw new ControlledToolError('STATE_UNCERTAIN', 'The completed documentation session must follow its independently observed source checkpoint.');
  }
  if (producer.invocation_id === verifier.invocation_id)
    throw new ControlledToolError('STATE_UNCERTAIN', 'The product checkpoint must come from an independent Verifier invocation.');
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const reportPaths = new Set(source.paths.map(pathKey)), guarded: Record<string, string> = {};
  const add = (baselines: Record<string, string>, allowMissing = false) => {
    for (const [path, digest] of Object.entries(baselines)) {
      if (reportPaths.has(pathKey(path))) continue;
      if ((!(allowMissing && digest === 'missing') && !/^[a-f0-9]{64}$/.test(digest)) || guarded[path] && guarded[path] !== digest)
        throw new ControlledToolError('STATE_UNCERTAIN', 'Source stages disagree about a non-report input or require a missing artifact.');
      guarded[path] = digest;
    }
  };
  if (contract.plan.outputs.some(path => !(path in producer.bound_hashes!)))
    throw new ControlledToolError('STATE_UNCERTAIN', 'The original producer did not bind every declared output.');
  // A later independent Verifier may legitimately repair its own checker.
  // Completed lineage authenticates those old bytes through captured snapshots;
  // current checker correctness remains the final Verifier's acceptance duty.
  add(history ? Object.fromEntries(contract.plan.outputs.map(path => [path, producer.bound_hashes![path]!])) : producer.bound_hashes!);
  if (!history) add(verifier.bound_hashes!);
  add(contract.preserved_hashes, true);
  const currentCheckerScope = !history
    ? captureControlledCheckerScope(contract.plan.verification_paths, budget.fingerprints) : undefined;
  for (const ref of source.checks) {
    budget.check();
    const check = run.checks.find(check => check.id === ref.id);
    if (!check || check.attempt_id !== verifier.id || check.invocation_id !== verifier.invocation_id ||
        check.log_sha256 !== ref.log_sha256 || check.evidence_id !== ref.evidence_id ||
        !check.passed || check.cancelled || check.exit_code !== check.expected_exit_code ||
        !/^\.neomind\/controlled\/checks\/[a-f0-9-]{36}\.log$/.test(check.log_path))
      throw new ControlledToolError('STATE_UNCERTAIN', 'The report checkpoint does not match its actual independent check receipt.');
    if (currentCheckerScope && !controlledCheckerScopeCurrent(check.checker_scope, currentCheckerScope))
      throw new ControlledToolError('STATE_UNCERTAIN', 'The source checker scope changed outside the authorized report paths or lacks its execution-time seal.');
    const planned = contract.plan.checks.flatMap(positive => [{ ...positive, negative: false },
      ...(positive.negative_controls ?? []).map(negative => ({ ...negative, negative: true }))])
      .find(planned => planned.title === check.title && planned.negative === check.negative &&
        same(planned.command, check.planned_command ?? check.command) && (planned.expected_exit_code ?? 0) === check.expected_exit_code);
    if (!planned) throw new ControlledToolError('STATE_UNCERTAIN', 'The source check no longer matches a prescribed immutable command.');
    const logPath = safePath(root, check.log_path), info = lstatSync(logPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)
      throw new ControlledToolError('STATE_UNCERTAIN', 'The source check log is not an ordinary bounded backend artifact.');
    const bytes = readFileSync(logPath);
    if (hash(bytes) !== check.log_sha256) throw new ControlledToolError('STATE_UNCERTAIN', 'The original source check log changed.');
    const log = JSON.parse(bytes.toString('utf8'));
    if (!same(log.command, check.command) || !same(log.planned_command ?? log.command, check.planned_command ?? check.command) ||
        !same(log.baseline, check.baseline) || !same(log.checker_scope, check.checker_scope) || log.result?.exit_code !== check.exit_code ||
        log.result?.cancelled || log.result?.timed_out || log.result?.output_limited || log.result?.error || log.pilot_error)
      throw new ControlledToolError('STATE_UNCERTAIN', 'The source check outcome differs from the actual backend process result.');
    authenticateCheckEvidence(root, run, contract, check, recordAt);
    if (!history) {
      add(check.baseline);
      const currentInputs = budget.fingerprints(planned.baseline_paths);
      const excludeReports = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([path]) => !reportPaths.has(pathKey(path))));
      if (!same(excludeReports(currentInputs), excludeReports(check.baseline)))
        throw new ControlledToolError('STATE_UNCERTAIN', 'A source check input changed outside the authorized report paths.');
    }
  }
  if (currentCheckerScope) add(currentCheckerScope.files, true);
  if (!same(guarded, budget.fingerprints(Object.keys(guarded))))
    throw new ControlledToolError('STATE_UNCERTAIN', 'Implementation, checker or preserved inputs changed outside the authorized report paths.');
  budget.check();
  return guarded;
}

/** Final acceptance re-authenticates the retained first checkpoint and signed handoff. */
export function assertCompletedEvidenceDocumentationLineage(root: string, run: ControlledSnapshot, contract: ControlledContract,
  completedAttemptId: string, budget: AuthorityBudget = controlledAcceptanceBudget(root), recordAt?: ControlledRecordAt): Record<string, string> {
  const attempt = run.attempts.find(attempt => attempt.id === completedAttemptId);
  if (!attempt?.documentation_source)
    throw new ControlledToolError('STATE_UNCERTAIN', 'The completed documentation result lost its original source checkpoint binding.');
  try {
    return evidenceDocumentationAuthority(root, run, contract, attempt.documentation_source,
      { completed_attempt_id: completedAttemptId, budget, recordAt });
  } catch (error) {
    if (error instanceof ControlledToolError) throw error;
    throw new ControlledToolError('STATE_UNCERTAIN', 'The completed documentation history could not be authenticated. Preserve original signed results, check logs and captured input snapshots; fresh final checks cannot replace missing source history.');
  }
}

function authenticateCheckEvidence(root: string, run: ControlledSnapshot, contract: ControlledContract, check: ControlledCheckReceipt,
  recordAt: ControlledRecordAt): void {
  const input = check.evidence_input;
  if (!input || !check.evidence_id) throw new ControlledToolError('STATE_UNCERTAIN', 'The source check lacks its materialized independent evidence.');
  const record = recordAt(check.evidence_id), data = record.meta.data;
  if (record.meta.type !== 'evidence' || data.controlled_check_id !== check.id || data.controlled_epoch_id !== run.epoch_id ||
      data.controlled_contract_hash !== run.contract_hash || data.task_id !== contract.task_id || data.workflow_id !== run.workflow_id ||
      data.result !== 'pass' || data.execution_invocation_id !== check.invocation_id || !same(data.file_baseline, check.baseline) ||
      !same(data.command, check.command) || !same(data.checker_scope, check.checker_scope) || data.log_hash !== check.log_sha256 || data.log_path !== check.log_path ||
      data.check_fingerprint !== evidenceRecordFingerprint(recordAt(input.check_id)))
    throw new ControlledToolError('STATE_UNCERTAIN', 'The source typed check evidence differs from its command receipt.');
  validateEvidenceInputs(root, input.input_snapshot, { files: check.baseline, record_fingerprints: input.record_baseline,
    check_id: input.check_id, check_fingerprint: input.check_fingerprint });
  for (const [id, digest] of Object.entries(input.record_baseline))
    if (evidenceRecordFingerprint(recordAt(id)) !== digest) throw new ControlledToolError('STATE_UNCERTAIN', 'The source check record baseline changed.');
  if (data.receipt_path !== `.neomind/controlled/checks/${check.id}.receipt.json`)
    throw new ControlledToolError('STATE_UNCERTAIN', 'The source materialized evidence receipt path differs from its backend identity.');
  const saved = JSON.parse(readFileSync(safePath(root, data.receipt_path), 'utf8'));
  if (!same(saved.file_baseline, data.file_baseline) || saved.result !== data.result || saved.log_hash !== data.log_hash ||
      saved.execution_invocation_id !== data.execution_invocation_id || saved.controlled_check_id !== check.id || !same(saved.checker_scope, check.checker_scope))
    throw new ControlledToolError('STATE_UNCERTAIN', 'The source materialized execution receipt changed.');
}
import { isControlledExecutionReceipt } from './execution-attestation.js';
