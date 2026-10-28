import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { hash, safePath, loadRecords, now } from './storage.js';
import { canonicalJson, readInvocation } from './routing.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import type { ControlledSnapshot, ControlledContract } from './controlled-workflow.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid(), pid = z.number().int().positive();
const hashes = z.record(z.string(), z.string().regex(/^(?:[a-f0-9]{64}|missing)$/));
const assessment = z.strictObject({
  operator: z.literal('codex-maintenance-operator'), project_effects: z.literal('none-observed'),
  external_effects: z.literal('authorized-disposable-os-temp-only'), command_and_delegate_reviewed: z.literal(true),
  process_identities: z.array(z.strictObject({ pid, created_at: z.string().datetime({ offset: true }),
    role: z.enum(['owner', 'check-root', 'descendant', 'console']) })).min(1).max(64),
});
export const interruptedCheckMaintenanceSchema = z.strictObject({ workflow_id: z.string().min(1).max(256),
  expected_revision: z.number().int().nonnegative(), assessment });
export type InterruptedCheckMaintenanceInput = z.input<typeof interruptedCheckMaintenanceSchema>;
const intentProof = z.strictObject({ id: uuid, intent_hash: digest, attempt_id: uuid, invocation_id: uuid,
  signed_receipt_hash: digest, owner_pid: pid, check_pid: pid, baseline: hashes });
const ledgerSchema = z.strictObject({ schema_version: z.literal(1), kind: z.literal('controlled-interrupted-check-reconciliation'),
  id: uuid, operation_hash: digest, workflow_id: z.string(), epoch_id: uuid, task_id: z.string(), contract_hash: digest,
  expected_revision: z.number().int().nonnegative(), created_at: z.string().datetime(), outcome: z.literal('unknown'),
  assurance: z.literal('unsigned-local-maintenance-attestation'), assessment,
  intents: z.array(intentProof).min(1).max(32), observed_absent_pids: z.array(pid).min(1).max(128),
  preserved_hashes: hashes,
  producer: z.strictObject({ attempt_id: uuid, invocation_id: uuid, report_id: z.string(), report_fingerprint: digest,
    signed_receipt_hash: digest, bound_hashes: hashes }),
});
export type InterruptedCheckReconciliation = z.infer<typeof ledgerSchema>;
export interface InterruptedCheckReconciliationLink { id: string; sha256: string; intent_ids: string[] }
type Snapshot = ControlledSnapshot & { check_reconciliations?: InterruptedCheckReconciliationLink[] };
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const reconciliationPath = (id: string) => `.neomind/controlled/check-reconciliations/${uuid.parse(id)}.json`;
export const maintenanceLockKey = (workflow: string) => `controlled-maintenance-${hash(workflow).slice(0, 32)}`;
export function normalizedMaintenanceInput(value: InterruptedCheckMaintenanceInput) {
  const input = interruptedCheckMaintenanceSchema.parse(value);
  input.assessment.process_identities.sort((a, b) => a.pid - b.pid || a.role.localeCompare(b.role));
  if (new Set(input.assessment.process_identities.map(item => item.pid)).size !== input.assessment.process_identities.length)
    throw new Error('Maintenance process observations must identify each PID once.');
  return input;
}
export function processIsAbsent(id: number): boolean {
  if (!Number.isSafeInteger(id) || id < 1) return false;
  try { process.kill(id, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function noResult(root: string, run: ControlledSnapshot, id: string) {
  if (run.checks.some(check => check.id === id)) throw new Error('This check already has a durable command result; use normal result reconciliation.');
  const dir = safePath(root, '.neomind/controlled/checks');
  if (existsSync(dir) && readdirSync(dir).some(name => name === `${id}.log` || name === `${id}.receipt.json` || name.startsWith(`${id}.log.`) || name.startsWith(`${id}.receipt.json.`)))
    throw new Error('A command result or partial result file exists; preserve and inspect it rather than replacing its outcome.');
  if (existsSync(safePath(root, `.neomind/controlled/pilots/${id}`)))
    throw new Error('Retained pilot results or partial artifacts need their own result reconciliation; this unknown-check operation cannot replace them.');
}
function interruptedReceipt(root: string, run: ControlledSnapshot, contract: ControlledContract, intent: NonNullable<ControlledSnapshot['check_intents']>[number]) {
  const attempt = run.attempts.find(item => item.id === intent.attempt_id);
  if (!attempt?.invocation_id || attempt.stage !== 'verification' || attempt.state !== 'interrupted')
    throw new Error('Only an actually interrupted bound Verifier check may receive maintenance reconciliation.');
  const receipt = readInvocation(root, attempt.invocation_id);
  if (!isControlledExecutionReceipt(receipt) || receipt.state !== 'interrupted' || receipt.inference_completed ||
      !['verifier', 'check-executor'].includes(receipt.role) || receipt.workflow_id !== run.workflow_id || receipt.task_id !== contract.task_id ||
      receipt.request_id !== attempt.request_id || receipt.controlled_execution?.epoch_id !== run.epoch_id || receipt.controlled_execution.stage !== 'verification')
    throw new Error('The signed interrupted Verifier does not match this exact workflow, task, epoch and attempt.');
  return { attempt, receipt };
}

/** Read only runtime-linked immutable ledgers; an arbitrary unlinked file establishes nothing. */
export function readCheckReconciliations(root: string, run: Snapshot, contract: ControlledContract): InterruptedCheckReconciliation[] {
  const links = run.check_reconciliations ?? [];
  if (links.length > 32) throw new Error('Too many check reconciliation links.');
  if (new Set(links.map(link => link.id)).size !== links.length) throw new Error('Duplicate immutable reconciliation links.');
  const records = links.length ? new Map(loadRecords(root).map(record => [record.meta.id, record])) : new Map();
  return links.map(link => {
    const path = reconciliationPath(link.id), full = safePath(root, path), info = lstatSync(full);
    let cursor = '';
    for (const part of path.split('/')) { cursor = cursor ? `${cursor}/${part}` : part; if (lstatSync(safePath(root, cursor)).isSymbolicLink()) throw new Error('Reconciliation ledgers cannot follow links.'); }
    if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024) throw new Error('Invalid immutable reconciliation file.');
    const bytes = readFileSync(full);
    if (hash(bytes) !== link.sha256) throw new Error('The immutable reconciliation ledger changed.');
    const ledger = ledgerSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (ledger.id !== link.id || ledger.workflow_id !== run.workflow_id || ledger.epoch_id !== run.epoch_id || ledger.task_id !== contract.task_id ||
        ledger.contract_hash !== run.contract_hash || !equal(link.intent_ids, ledger.intents.map(item => item.id)) || !equal(ledger.preserved_hashes, contract.preserved_hashes))
      throw new Error('Reconciliation ledger belongs to another controlled execution.');
    const { id, operation_hash, created_at, outcome, assurance, observed_absent_pids, ...descriptor } = ledger;
    if (hash(canonicalJson(descriptor)) !== operation_hash) throw new Error('Reconciliation descriptor changed.');
    for (const proof of ledger.intents) {
      const intent = run.check_intents?.find(item => item.id === proof.id);
      if (!intent || intent.state === 'completed' || hash(canonicalJson(intent)) !== proof.intent_hash || !equal(intent.baseline, proof.baseline))
        throw new Error('The original unknown check intent changed after reconciliation.');
      const { attempt, receipt } = interruptedReceipt(root, run, contract, intent);
      if (attempt.id !== proof.attempt_id || receipt.id !== proof.invocation_id || hash(canonicalJson(receipt)) !== proof.signed_receipt_hash ||
          receipt.owner_pid !== proof.owner_pid || intent.pid !== proof.check_pid) throw new Error('Interrupted invocation provenance changed.');
      noResult(root, run, intent.id);
      if ([...records.values()].some(record => record.meta.type === 'evidence' && record.meta.data.controlled_check_id === intent.id))
        throw new Error('An execution result appeared for an unknown reconciled check.');
    }
    const producer = run.attempts.find(item => item.id === ledger.producer.attempt_id), report = records.get(ledger.producer.report_id);
    if (!producer || !report || producer.invocation_id !== ledger.producer.invocation_id || producer.report_id !== ledger.producer.report_id ||
        producer.report_fingerprint !== ledger.producer.report_fingerprint || evidenceRecordFingerprint(report) !== ledger.producer.report_fingerprint ||
        !equal(producer.bound_hashes, ledger.producer.bound_hashes) || hash(canonicalJson(readInvocation(root, ledger.producer.invocation_id))) !== ledger.producer.signed_receipt_hash)
      throw new Error('Original producer provenance changed after reconciliation.');
    return ledger;
  });
}
export function unresolvedControlledChecks(run: Snapshot, ledgers: readonly InterruptedCheckReconciliation[]) {
  const reconciled = new Set(ledgers.flatMap(ledger => ledger.intents.map(item => item.id)));
  return (run.check_intents ?? []).filter(intent => intent.state !== 'completed' && !reconciled.has(intent.id));
}
export function assertFreshVerifierAfterReconciliation(run: Snapshot, ledgers: readonly InterruptedCheckReconciliation[],
  verifierId: string, checks: readonly { at: string }[]) {
  const verifierIndex = run.attempts.findIndex(attempt => attempt.id === verifierId);
  for (const ledger of ledgers) if (verifierIndex < 0 ||
      ledger.intents.some(intent => run.attempts.findIndex(attempt => attempt.id === intent.attempt_id) >= verifierIndex) ||
      checks.some(check => Date.parse(check.at) < Date.parse(ledger.created_at)))
    throw new Error('Unknown interrupted checks require a fresh independent Verifier and new execution evidence after maintenance.');
}

/** Trusted maintenance caller only; absence/hashes support its explicit effect assessment, never a test verdict. */
export function prepareInterruptedCheckReconciliation(root: string, run: Snapshot, contract: ControlledContract,
  input: ReturnType<typeof normalizedMaintenanceInput>, fingerprints: (paths: string[]) => Record<string, string>): InterruptedCheckReconciliation {
  if (!['interrupted', 'paused', 'uncertain'].includes(run.status) || run.workflow_id !== input.workflow_id || run.revision !== input.expected_revision ||
      run.epoch_id !== contract.epoch_id || run.workflow_id !== contract.workflow_id || run.attempts.some(attempt => ['starting', 'running'].includes(attempt.state)))
    throw new Error('Maintenance requires the exact inactive interrupted revision and immutable execution.');
  if (!processIsAbsent(run.owner_pid)) throw new Error('The previous workflow owner must be absent before external maintenance.');
  const intents = unresolvedControlledChecks(run, readCheckReconciliations(root, run, contract));
  if (!intents.length) throw new Error('No unresolved interrupted check requires this maintenance operation.');
  const records = loadRecords(root);
  const proofs = intents.map(intent => {
    if (!intent.pid || !processIsAbsent(intent.pid)) throw new Error('A known check root remains alive or its identity is unavailable.');
    if (!input.assessment.process_identities.some(item => item.pid === intent.pid && item.role === 'check-root'))
      throw new Error('The trusted assessment must include the actual captured check-root identity.');
    const { attempt, receipt } = interruptedReceipt(root, run, contract, intent);
    if (receipt.owner_pid !== run.owner_pid || !processIsAbsent(receipt.owner_pid)) throw new Error('The signed original owner must be absent.');
    noResult(root, run, intent.id);
    if (records.some(record => record.meta.type === 'evidence' && record.meta.data.controlled_check_id === intent.id))
      throw new Error('Execution evidence already exists for this check; it cannot be replaced with an unknown outcome.');
    const planned = contract.plan.checks.flatMap(check => [check, ...(check.negative_controls ?? [])]).find(check => check.title === intent.title);
    if (!planned || !equal(intent.baseline, fingerprints(planned.baseline_paths))) throw new Error('The interrupted command baseline changed.');
    return { id: intent.id, intent_hash: hash(canonicalJson(intent)), attempt_id: attempt.id, invocation_id: receipt.id,
      signed_receipt_hash: hash(canonicalJson(receipt)), owner_pid: receipt.owner_pid, check_pid: intent.pid, baseline: intent.baseline };
  });
  const observed = [...new Set([run.owner_pid, ...proofs.map(proof => proof.check_pid), ...input.assessment.process_identities.map(item => item.pid)])].sort((a, b) => a - b);
  if (observed.some(id => !processIsAbsent(id))) throw new Error('Every known observed process must currently be absent.');
  if (!equal(contract.preserved_hashes, fingerprints(Object.keys(contract.preserved_hashes)))) throw new Error('Protected project effects do not match their original baseline.');
  const producer = run.attempts.findLast(attempt => attempt.stage === 'implementation');
  const report = records.find(record => record.meta.id === producer?.report_id);
  if (!producer?.invocation_id || !producer.report_id || !producer.report_fingerprint || !producer.bound_hashes || producer.state !== 'completed' ||
      producer.report?.outcome !== 'completed' || !report || evidenceRecordFingerprint(report) !== producer.report_fingerprint ||
      Object.values(producer.bound_hashes).some(value => value === 'missing') ||
      !equal(producer.bound_hashes, fingerprints(Object.keys(producer.bound_hashes)))) throw new Error('The current completed producer artifacts or report changed.');
  const native = readInvocation(root, producer.invocation_id);
  if (!isControlledExecutionReceipt(native) || native.state !== 'completed' || !native.inference_completed || native.role !== 'developer' ||
      native.workflow_id !== run.workflow_id || native.task_id !== contract.task_id || native.request_id !== producer.request_id ||
      native.controlled_execution?.epoch_id !== run.epoch_id || native.controlled_execution.stage !== 'implementation')
    throw new Error('The actual completed producer does not match this execution.');
  const descriptor = { schema_version: 1 as const, kind: 'controlled-interrupted-check-reconciliation' as const,
    workflow_id: run.workflow_id, epoch_id: run.epoch_id, task_id: contract.task_id, contract_hash: run.contract_hash!,
    expected_revision: input.expected_revision, assessment: input.assessment, intents: proofs, preserved_hashes: contract.preserved_hashes,
    producer: { attempt_id: producer.id, invocation_id: producer.invocation_id, report_id: producer.report_id,
      report_fingerprint: producer.report_fingerprint, signed_receipt_hash: hash(canonicalJson(native)), bound_hashes: producer.bound_hashes } };
  return ledgerSchema.parse({ ...descriptor, id: randomUUID(), operation_hash: hash(canonicalJson(descriptor)), created_at: now(),
    outcome: 'unknown', assurance: 'unsigned-local-maintenance-attestation', observed_absent_pids: observed });
}

/** First explicit continuation refreshes observations; later valid checks do not rewrite this historical assessment. */
export function recheckBeforeReconciledResume(root: string, run: Snapshot, ledgers: readonly InterruptedCheckReconciliation[],
  fingerprints: (paths: string[]) => Record<string, string>) {
  const latestVerifier = run.attempts.findLast(attempt => attempt.stage === 'verification');
  for (const ledger of ledgers) if (ledger.intents.some(intent => intent.attempt_id === latestVerifier?.id)) {
    if (ledger.observed_absent_pids.some(id => !processIsAbsent(id)) ||
        ledger.intents.some(intent => !equal(intent.baseline, fingerprints(Object.keys(intent.baseline)))) ||
        !equal(ledger.preserved_hashes, fingerprints(Object.keys(ledger.preserved_hashes))) ||
        !equal(ledger.producer.bound_hashes, fingerprints(Object.keys(ledger.producer.bound_hashes))))
      throw new Error('Reconciled interruption observations changed before fresh verification; preserve unknown outcome and reassess effects.');
  }
}
import { isControlledExecutionReceipt } from './execution-attestation.js';
