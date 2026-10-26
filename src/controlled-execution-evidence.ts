import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { hash, safePath } from './storage.js';
import { readInvocation } from './routing.js';
import { controlledExecutionDeclarationSchema } from './controlled-execution.js';
import { redactControlledValue } from './controlled-observability.js';
import { controlledPublicReferencePath } from './controlled-tools.js';
import type { ControlledContract, ControlledSnapshot } from './controlled-workflow.js';

type Operation = NonNullable<ControlledSnapshot['local_executions']>[number];
interface EvidenceBudget { fingerprints(paths: string[]): Record<string, string>; checkBudget?(): void }
interface ExecutionVerificationOptions extends EvidenceBudget { requireCurrentSource?: boolean; requireCompleted?: boolean }
interface ValidatedExecution { operation: Operation; intent: any; result: any }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The same durable authorization/provenance checks serve final acceptance and
 * read-only evidence access. A stored passed flag is never its own proof. */
export function verifyControlledExecutions(root: string, run: ControlledSnapshot, contract: ControlledContract,
  options: ExecutionVerificationOptions): ValidatedExecution[] {
  const verified: ValidatedExecution[] = [];
  const invocations = new Map<string, ReturnType<typeof readInvocation>>();
  for (const operation of run.local_executions ?? []) {
    options.checkBudget?.();
    if (operation.state !== 'completed') {
      if (options.requireCompleted !== false) throw new Error('A local execution still needs effect reconciliation.');
      continue;
    }
    const intentBytes = readFileSync(safePath(root, operation.intent_path));
    if (!operation.result_path || !operation.result_sha256 || hash(intentBytes) !== operation.intent_sha256)
      throw new Error('A local execution has no intact backend authorization and result.');
    const resultBytes = readFileSync(safePath(root, operation.result_path));
    if (hash(resultBytes) !== operation.result_sha256) throw new Error('The local execution result changed.');
    const intent = JSON.parse(intentBytes.toString('utf8')), result = JSON.parse(resultBytes.toString('utf8'));
    if (intent.payload_source || result.payload_source) {
      const source = intent.payload_source;
      if (!source || !same(source, result.payload_source) || typeof source.path !== 'string' ||
          !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 0 ||
          intent.baseline?.[source.path] !== source.sha256 ||
          result.execution && result.execution.baseline?.[source.path] !== source.sha256)
        throw new Error('Prepared JSON source differs from its backend-owned execution baseline.');
      const currentOperation = run.local_executions?.findLast(item => item.title === operation.title && item.passed);
      if (options.requireCurrentSource !== false && operation.passed && currentOperation?.id === operation.id &&
          options.fingerprints([source.path])[source.path] !== source.sha256)
        throw new Error('The current prepared JSON source changed after its successful producer execution.');
    }
    const attempt = run.attempts.find(item => item.id === operation.attempt_id);
    let receipt;
    if (attempt?.invocation_id) {
      receipt = invocations.get(attempt.invocation_id) ?? readInvocation(root, attempt.invocation_id);
      invocations.set(attempt.invocation_id, receipt);
    }
    for (const proof of [intent, result]) if (proof.id !== operation.id || proof.request_hash !== operation.request_hash ||
        proof.workflow_id !== run.workflow_id || proof.epoch_id !== run.epoch_id || proof.contract_hash !== run.contract_hash ||
        proof.task_id !== contract.task_id || proof.attempt_id !== operation.attempt_id || proof.invocation_id !== attempt?.invocation_id)
      throw new Error('A local operation belongs to another actor, task or immutable execution.');
    if (attempt?.role !== 'developer' || attempt.stage !== 'implementation' || receipt?.issuer !== 'neomind-vscode-lm' ||
        receipt.role !== 'developer' || receipt.task_id !== contract.task_id || receipt.workflow_id !== run.workflow_id ||
        receipt.controlled_execution?.epoch_id !== run.epoch_id || receipt.controlled_execution.stage !== 'implementation' ||
        (result.execution?.passed ?? false) !== operation.passed)
      throw new Error('Local operation provenance differs from its signed producer.');
    verified.push({ operation, intent, result });
  }
  return verified;
}

export function controlledExecutionPublicText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // The shared redactor bounds each string to 2000 characters. Select the final
  // tail first, rather than accidentally losing the final 6000 of an 8000-char tail.
  const cap = Math.min(max, 2000), redacted = redactControlledValue(value.slice(-cap));
  let text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  // Quoted Windows paths may contain spaces. Classify the full candidate before
  // the ordinary-token pass; never open any path mentioned by program output.
  text = text.replace(/(["'`])([^"'`\r\n]+)\1/g, (whole, quote: string, candidate: string) =>
    privatePath(candidate) ? `${quote}[private path]${quote}` : whole);
  text = text.replace(/[^\s"'`<>|,;()[\]{}=]+/g, candidate =>
    privatePath(candidate.replace(/[.,:!?]+$/, '')) ? '[private path]' : candidate);
  return `${value.length > cap ? '[truncated to final log tail]\n' : ''}${text}`.slice(-max);
}
// Keep projection filters aligned with the existing worker path policy. This
// invokes the shared classifier only at evidence access, not during module load.
const privatePath = (path: string) => !controlledPublicReferencePath(path.replace(/\\/g, '/'));

/** Public producer observations are separate from independent checks. Missing
 * or stale evidence stays nonpassing and never authorizes workflow closure. */
export function controlledProducerExecutionEvidence(root: string, run: ControlledSnapshot, contract: ControlledContract,
  title: string | undefined, options: EvidenceBudget): Record<string, unknown>[] {
  const verified = verifyControlledExecutions(root, run, contract, { ...options, requireCurrentSource: false, requireCompleted: false });
  const declarations = contract.plan.execution_steps;
  const titles = [...new Set(declarations?.map(step => step.title) ?? (run.local_executions ?? []).map(operation => operation.title))];
  // The combined gateway validates the selector across checks and producer
  // steps. A valid independent-check title simply selects no producer rows.
  return titles.filter(candidate => title === undefined || candidate === title).slice(-16).map(selected => {
    const operation = run.local_executions?.findLast(item => item.title === selected);
    const declared = declarations?.find(step => step.title === selected);
    const base = { evidence_kind: 'producer-execution', title: selected,
      note: 'Observed producer execution is separate from independent verification; it cannot establish a verifier verdict or workflow acceptance.' };
    if (!operation || operation.state !== 'completed') return { ...base, state: operation?.state ?? 'pending', passed: false,
      observed_passed: false, current_baseline: false, ...(declared ? { command: redactControlledValue(declared.command) } : {}) };
    const proof = verified.find(entry => entry.operation.id === operation.id)!;
    const savedDeclaration = controlledExecutionDeclarationSchema.parse(proof.intent.declaration);
    if (savedDeclaration.title !== selected || declared && !same(savedDeclaration, controlledExecutionDeclarationSchema.parse(declared)))
      throw new Error('Producer evidence differs from its exact declared operation.');
    const execution = proof.result.execution;
    if (execution && (!same(execution.command, proof.intent.command) || execution.input_sha256 !== proof.intent.input_sha256 ||
        execution.payload_hash !== proof.intent.payload_hash || !same(execution.baseline, proof.intent.baseline)))
      throw new Error('Producer execution bytes differ from the retained authorization.');
    let current = false;
    if (execution) {
      options.checkBudget?.();
      try {
        current = same(execution.baseline, options.fingerprints(Object.keys(execution.baseline))) &&
          same(execution.output_hashes, options.fingerprints(Object.keys(execution.output_hashes)));
      } catch { current = false; }
    }
    const commandPassed = execution?.passed === true && execution.result?.exit_code === 0 &&
      !execution.result.cancelled && !execution.result.timed_out && !execution.result.output_limited && !execution.result.error &&
      !execution.changed_inputs?.length && !execution.missing_outputs?.length;
    return { ...base, state: 'completed', operation_id: operation.id, finished_at: proof.result.finished_at,
      command: redactControlledValue(savedDeclaration.command), resolved_executable: execution ? basename(execution.executable) : undefined,
      passed: commandPassed && current, observed_passed: commandPassed, current_baseline: current,
      exit_code: execution?.result?.exit_code ?? null, cancelled: execution?.result?.cancelled ?? false,
      timed_out: execution?.result?.timed_out ?? false, output_limited: execution?.result?.output_limited ?? false,
      duration_ms: execution?.result?.duration_ms ?? null, not_started: proof.result.not_started ?? false,
      stdout: controlledExecutionPublicText(execution?.result?.stdout, 8000), stderr: controlledExecutionPublicText(execution?.result?.stderr, 4000),
      output_hashes: Object.fromEntries(Object.entries(execution?.output_hashes ?? {}).filter(([path]) => !privatePath(path))),
      ...(!current ? { limitation: 'Current inputs or outputs differ from the saved producer result or could not be revalidated. This observation cannot support the current result.' } : {}) };
  });
}
