import { lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { compileCornellResearch, type CornellResearchInput } from './cornell-workflow.js';
import { getRecord, hash, safePath } from './storage.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import { cornellFormatRendererRevision, resolveControlledCornellFormatProfile } from './cornell-format-profile.js';
import { controlledCornellResearchSchema, normalizeControlledCornellSources, bindControlledCornellPractice,
  bindControlledCornellDemonstration, type ControlledCornellSourceContext, type ControlledCornellResult } from './controlled-cornell-sources.js';
import { assertControlledPayloadCurrent, type ControlledPayloadSource } from './controlled-payload.js';
import { controlledCornellGeneration, type CornellCanonicalReceipt } from './controlled-cornell-validation.js';
import { canonicalJson, readInvocation } from './routing.js';
import { controlledPublicReferencePath, controlledSkillInputPath } from './controlled-tools.js';
import type { ControlledSnapshot, ControlledContract } from './controlled-workflow.js';

export const cornellRendererMaintenanceSchema = z.strictObject({ workflow_id: z.string().min(1).max(256),
  expected_revision: z.number().int().nonnegative(), note_id: z.string().min(1).max(256) });
export type CornellRendererMaintenanceInput = z.input<typeof cornellRendererMaintenanceSchema>;
export interface CornellRendererReconciliation {
  schema_version: 1; kind: 'controlled-cornell-renderer-reconciliation'; id: string;
  workflow_id: string; epoch_id: string; task_id: string; contract_hash: string;
  expected_revision: number; previous: ControlledCornellResult; previous_note_revision: number;
  source: ControlledPayloadSource; renderer_revision: number; input_hash: string; compiled_note_hash: string;
  artifact_hashes: Record<string, string>;
  source_producer?: { attempt_id: string; invocation_id: string; report_fingerprint: string; signed_receipt_sha256: string };
  result?: ControlledCornellResult; completed_at?: string; canonical_validation?: CornellCanonicalReceipt;
}
export const cornellRendererLedgerPath = (id: string) => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid compiler reconciliation identity.');
  return `.neomind/controlled/cornell-renderer-reconciliations/${id}.json`;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function sourceProducer(root: string, run: ControlledSnapshot, contract: ControlledContract, previous: ControlledCornellResult) {
  const source = previous.payload_source!;
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!contract.plan.allowed_paths.some(path => key(source.path) === key(path) || key(source.path).startsWith(`${key(path)}/`)) ||
      !controlledPublicReferencePath(source.path) || !source.path.endsWith('.json'))
    throw new Error('An unbound retained research source must remain an ordinary JSON file in its original producer scope.');
  for (const attempt of [...run.attempts].reverse()) {
    if (attempt.stage !== 'implementation' || attempt.role !== 'developer' || attempt.state !== 'completed' ||
        attempt.report?.outcome !== 'completed' || !attempt.invocation_id || !attempt.report_id || !attempt.report_fingerprint ||
        attempt.bound_hashes?.[source.path] !== source.sha256 ||
        Object.entries(previous.artifact_hashes).some(([path, digest]) => attempt.bound_hashes?.[path] !== digest)) continue;
    const receipt = readInvocation(root, attempt.invocation_id), report = getRecord(root, attempt.report_id);
    if (receipt.issuer !== 'neomind-vscode-lm' || receipt.state !== 'completed' || !receipt.inference_completed ||
        receipt.workflow_id !== run.workflow_id || receipt.task_id !== contract.task_id || receipt.role !== 'developer' ||
        receipt.request_id !== attempt.request_id || receipt.controlled_execution?.epoch_id !== run.epoch_id || receipt.controlled_execution.stage !== 'implementation' ||
        report.meta.owner !== 'developer' || report.meta.data.kind !== 'controlled-work-record' || report.meta.data.outcome !== 'completed' ||
        report.meta.data.workflow_id !== run.workflow_id || report.meta.data.task_id !== contract.task_id || report.meta.data.epoch_id !== run.epoch_id ||
        report.meta.data.attempt_id !== attempt.id || report.meta.data.invocation_id !== attempt.invocation_id ||
        report.meta.data.report_payload_hash !== hash(canonicalJson(attempt.report)) ||
        evidenceRecordFingerprint(report) !== attempt.report_fingerprint || !equal(report.meta.data.artifact_hashes, attempt.bound_hashes))
      throw new Error('The retained research source lacks its authentic same-task completed producer checkpoint.');
    return { attempt_id: attempt.id, invocation_id: attempt.invocation_id, report_fingerprint: attempt.report_fingerprint,
      signed_receipt_sha256: hash(canonicalJson(receipt)) };
  }
  throw new Error('The retained research source was not bound to the original generated artifacts by a completed signed producer.');
}
function matches(root: string, artifacts: Record<string, string>) {
  return Object.entries(artifacts).every(([path, digest]) => {
    try { const file = safePath(root, path), info = lstatSync(file); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && hash(readFileSync(file)) === digest; }
    catch { return false; }
  });
}

/** Internal renderer upgrade only: preserved professional source, exact owned output and a newer renderer. */
export function prepareCornellRendererReconciliation(root: string, run: ControlledSnapshot, contract: ControlledContract,
  input: CornellRendererMaintenanceInput, retained?: CornellRendererReconciliation) {
  if (run.workflow_id !== input.workflow_id || run.revision !== input.expected_revision || run.status !== 'blocked' ||
      run.active_invocations.length || run.attempts.some(attempt => ['starting', 'running'].includes(attempt.state)) ||
      run.check_intents?.some(intent => intent.state !== 'completed') || run.local_executions?.some(operation => operation.state !== 'completed'))
    throw new Error('Renderer maintenance requires the expected blocked, quiescent workflow revision and no uncertain execution effects.');
  const previous = run.cornell_results?.findLast(result => result.note_id === input.note_id);
  if (!previous?.payload_source || !contract.plan.cornell_output_dir || contract.plan.cornell_input_path &&
      (previous.payload_source.path !== contract.plan.cornell_input_path ||
       contract.preserved_hashes[previous.payload_source.path] !== previous.payload_source.sha256))
    throw new Error('Renderer maintenance requires the actual retained compiler result and the unchanged contract-bound semantic source.');
  assertControlledPayloadCurrent(root, previous.payload_source);
  const producer = contract.plan.cornell_input_path ? undefined : sourceProducer(root, run, contract, previous);
  const profile = resolveControlledCornellFormatProfile(root, contract);
  if (!profile) throw new Error('Renderer maintenance requires the existing pinned canonical format profile.');
  const note = getRecord(root, previous.note_id), revision = retained?.previous_note_revision ?? note.meta.revision;
  const nextRevision = cornellFormatRendererRevision(profile);
  if (!retained && ((Number((note.meta.data.research as any)?.format_renderer_revision ?? 1) >= nextRevision) ||
      !equal(note.meta.data.format_profile, profile) || evidenceRecordFingerprint(note) !== previous.record_fingerprint ||
      !equal(note.meta.data.artifact_hashes, previous.artifact_hashes) || !matches(root, previous.artifact_hashes)))
    throw new Error('Only an exact older backend-owned renderer generation can be upgraded. Current user edits and same-version failures are preserved.');
  if (note.meta.type !== 'knowledge' || note.meta.status !== 'draft' || note.meta.data.workflow_id !== run.workflow_id ||
      note.meta.data.format !== 'cornell-v1' || note.meta.data.artifact_path !== `${contract.plan.cornell_output_dir}/note.md`)
    throw new Error('Renderer maintenance cannot adopt a foreign, accepted or unrelated note.');
  for (const [path, digest] of Object.entries(contract.preserved_hashes))
    if (!matches(root, { [path]: digest })) throw new Error('A frozen input changed; renderer maintenance cannot rebaseline the contract.');
  for (const [id, digest] of Object.entries(contract.requirement_fingerprints))
    if (evidenceRecordFingerprint(getRecord(root, id)) !== digest) throw new Error('A committed requirement changed before renderer maintenance.');
  const source = previous.payload_source;
  const semantic = controlledCornellResearchSchema().parse(JSON.parse(readFileSync(safePath(root, source.path), 'utf8')));
  const context: ControlledCornellSourceContext = { workflow_id: run.workflow_id, epoch_id: run.epoch_id, task_id: contract.task_id,
    requirement_ids: contract.requirement_ids, saved_results: run.cornell_results, evidence: [],
    file_allowed: path => controlledPublicReferencePath(path) ||
      (contract.plan.input_paths ?? []).includes(path) && controlledSkillInputPath(path) };
  const requirement = getRecord(root, contract.requirement_ids[0]!);
  const sources = normalizeControlledCornellSources(root, semantic.sources, context);
  const compiled = compileCornellResearch(root, { ...semantic, schema_version: 1,
    practice: bindControlledCornellPractice(semantic.practice, contract.plan.cornell_output_dir,
      contract.plan.outputs.includes(`${contract.plan.cornell_output_dir}/practice-solution.md`)), sources: sources.sources,
    worked_example: bindControlledCornellDemonstration(semantic.worked_example, [], false), requirement_id: requirement.meta.id,
    expected_requirement_revision: requirement.meta.revision, workflow_id: run.workflow_id, task_id: contract.task_id,
    owner: note.meta.owner, output_dir: contract.plan.cornell_output_dir } as CornellResearchInput,
    { approved_source_files: sources.approved_source_files, format_profile: profile });
  const generation = controlledCornellGeneration(root, compiled)!;
  const descriptor = { schema_version: 1 as const, kind: 'controlled-cornell-renderer-reconciliation' as const,
    workflow_id: run.workflow_id, epoch_id: run.epoch_id, task_id: contract.task_id, contract_hash: run.contract_hash!,
    expected_revision: input.expected_revision, previous, previous_note_revision: revision, source,
    ...(producer ? { source_producer: producer } : {}),
    renderer_revision: nextRevision, input_hash: compiled.input_hash, compiled_note_hash: hash(JSON.stringify(compiled.note)),
    artifact_hashes: generation.artifact_hashes };
  const identity: CornellRendererReconciliation = { ...descriptor, id: hash(JSON.stringify(descriptor)) };
  if (retained && (retained.id !== identity.id || !equal({ ...retained, result: undefined, completed_at: undefined, canonical_validation: undefined },
      { ...identity, result: undefined, completed_at: undefined, canonical_validation: undefined })))
    throw new Error('The immutable renderer maintenance intent differs from the current source and contract.');
  if (retained && evidenceRecordFingerprint(note) !== previous.record_fingerprint &&
      (note.meta.revision !== revision + 1 || (note.meta.data.research as any)?.input_hash !== compiled.input_hash ||
       !equal(note.meta.data.artifact_hashes, generation.artifact_hashes) || !matches(root, generation.artifact_hashes)))
    throw new Error('The interrupted renderer operation differs from its exact prepared next generation. Current edits are preserved.');
  return { identity, compiled, context, semantic, source };
}

export function assertCornellRendererResultCurrent(root: string, ledger: CornellRendererReconciliation) {
  if (!ledger.result || !ledger.canonical_validation || ledger.canonical_validation.exit_code !== 0 ||
      ledger.canonical_validation.input_hash !== ledger.input_hash || ledger.canonical_validation.renderer_revision !== ledger.renderer_revision ||
      !equal(ledger.canonical_validation.artifact_hashes, ledger.artifact_hashes) || !matches(root, ledger.artifact_hashes) ||
      ledger.result.record_fingerprint !== evidenceRecordFingerprint(getRecord(root, ledger.result.note_id)) ||
      !equal(ledger.result.artifact_hashes, ledger.artifact_hashes))
    throw new Error('The renderer maintenance result no longer matches its canonical receipt and current owned bytes.');
  assertControlledPayloadCurrent(root, ledger.source);
}
