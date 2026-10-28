import { lstatSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { canonicalJson, observeInvocation } from './routing.js';
import { controlledAcceptanceBudget, controlledContractForTask, controlledRecordView } from './controlled-acceptance.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import { assertControlledPayloadCurrent } from './controlled-payload.js';
import { hash, safePath, validateMetadata } from './storage.js';
import type { ControlledCornellResult } from './controlled-cornell-sources.js';
import type { CornellOwnedArtifactRecovery } from './notes.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export interface ControlledCornellOwnedOverwriteRecovery {
  schema_version: 1; kind: 'owned-cornell-overwrite'; workflow_id: string; epoch_id: string; task_id: string;
  contract_hash: string; note_id: string; record_fingerprint: string; source_attempt_id: string; source_invocation_id: string;
  source_report_fingerprint: string;
  source_receipt_sha256: string;
  artifacts: Record<string, { canonical_sha256: string; overwritten_sha256: string; operation: string; binding_hash: string;
    canonical_path: string; overwritten_path: string; intent_sha256: string; completion_sha256: string }>;
}

function bytes(root: string, path: string): Buffer {
  const file = safePath(root, path), info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 * 1024)
    throw new Error('Cornell recovery needs bounded ordinary unlinked provenance files.');
  return readFileSync(file);
}

/** Read-only eligibility. A different current hash without exact completed owned-write provenance is never adopted. */
export function controlledCornellOwnedOverwriteRecovery(root: string, workflowId: string, taskId: string,
  saved: ControlledCornellResult): ControlledCornellOwnedOverwriteRecovery | undefined {
  return authenticate(root, workflowId, taskId, saved);
}

function authenticate(root: string, workflowId: string, taskId: string, saved: ControlledCornellResult,
  expected?: ControlledCornellOwnedOverwriteRecovery, resumed?: Record<string, string>, historical?: { operation: string }): ControlledCornellOwnedOverwriteRecovery | undefined {
  const budget = controlledAcceptanceBudget(root), recordAt = controlledRecordView(root, budget.check);
  const { run, contract } = controlledContractForTask(root, recordAt(taskId), budget.check, recordAt);
  const latest = historical ? run.cornell_results?.find(result => same(result, saved)) : run.cornell_results?.findLast(result => result.note_id === saved.note_id);
  let note = recordAt(saved.note_id);
  if (historical) {
    const marker = note.meta.data.backend_artifact_restoration as { operation?: string; previous_revision?: number } | undefined;
    const history = note.meta.data.revision_history as { revision: number; request_hash: string; record_path: string; record_hash: string }[] | undefined;
    const entry = history?.at(-1), base = entry && `.neomind/evidence/cornell-history/${saved.note_id}/${entry.revision}-${entry.record_hash}`;
    if (!/^[a-f0-9]{64}$/.test(historical.operation) || marker?.operation !== historical.operation || !entry ||
        entry.request_hash !== historical.operation || entry.revision !== marker.previous_revision || note.meta.revision !== entry.revision + 1 ||
        entry.record_path !== `${base}/record.md`)
      throw new Error('Completed Cornell restoration lacks its exact immutable source-record lineage.');
    const recordBytes = bytes(root, entry.record_path), match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(recordBytes.toString('utf8').replace(/\r\n/g, '\n'));
    if (hash(recordBytes) !== entry.record_hash || !match) throw new Error('Completed Cornell restoration source record changed.');
    note = { meta: validateMetadata(parse(match[1]!)), body: match[2]!, path: note.path };
    if (note.meta.revision !== entry.revision) throw new Error('Completed Cornell restoration source revision changed.');
  }
  const data = note.meta.data;
  const practice = data.practice as { exercise_path?: string; answer_path?: string } | undefined;
  const directory = typeof data.artifact_path === 'string' ? data.artifact_path.replace(/\/note\.md$/, '') : '';
  const paths = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`);
  if (run.workflow_id !== workflowId || contract.task_id !== taskId || !same(latest, saved) || !run.contract_hash ||
      note.meta.type !== 'knowledge' || note.meta.status !== 'draft' || data.format !== 'cornell-v1' || data.workflow_id !== workflowId ||
      evidenceRecordFingerprint(note) !== saved.record_fingerprint || !same(data.artifact_hashes, saved.artifact_hashes) ||
      ![contract.plan.cornell_output_dir, contract.knowledge_directory].includes(directory) ||
      data.artifact_path !== paths[0] || practice?.exercise_path !== paths[1] || practice?.answer_path !== paths[2] ||
      Object.keys(saved.artifact_hashes).length !== 3 || paths.some(path => !/^[a-f0-9]{64}$/.test(saved.artifact_hashes[path] ?? '')) ||
      contract.plan.cornell_output_dir === directory && paths.some(path => !contract.plan.outputs.includes(path)) ||
      (data.research as { input_hash?: string } | undefined)?.input_hash !== saved.input_hash)
    throw new Error('Cornell overwrite recovery requires the unchanged current backend compiler receipt and its owned draft.');
  if (saved.payload_source) assertControlledPayloadCurrent(root, saved.payload_source);
  if (!same(contract.preserved_hashes, budget.fingerprints(Object.keys(contract.preserved_hashes))))
    throw new Error('Cornell recovery cannot replace a changed source or preservation baseline.');
  const current = Object.fromEntries(paths.map(path => [path, hash(bytes(root, path))]));
  const changed = expected ? Object.keys(expected.artifacts) : paths.filter(path => current[path] !== saved.artifact_hashes[path]);
  if (!changed.length) return undefined;
  if (changed.some(path => !paths.includes(path)) || paths.some(path => !changed.includes(path) &&
      current[path] !== saved.artifact_hashes[path] && current[path] !== resumed?.[path]))
    throw new Error('Cornell recovery cannot adopt another changed artifact.');
  for (const attempt of [...run.attempts].reverse()) {
    budget.check();
    if (expected && attempt.id !== expected.source_attempt_id || attempt.stage !== 'implementation' || attempt.role !== 'developer' ||
        attempt.purpose === 'evidence-documentation' || attempt.state !== 'completed' || attempt.report?.outcome !== 'completed' ||
        !attempt.invocation_id || !attempt.report_id || !attempt.report_fingerprint || !attempt.bound_hashes ||
        changed.some(path => attempt.bound_hashes?.[path] !== (expected?.artifacts[path]?.overwritten_sha256 ?? current[path]))) continue;
    const observed = observeInvocation(root, 'developer', attempt.invocation_id, { workflow_id: workflowId, task_id: taskId, require_completed: true });
    const receipt = observed.receipt, report = recordAt(attempt.report_id);
    if (observed.problems.length || !receipt || !isControlledExecutionReceipt(receipt) || receipt.state !== 'completed' || !receipt.inference_completed ||
        receipt.request_id !== attempt.request_id || receipt.controlled_execution?.epoch_id !== run.epoch_id ||
        receipt.controlled_execution.stage !== 'implementation' || !receipt.native_tool_scope?.includes('task_file_write') ||
        report.meta.type !== 'knowledge' || report.meta.owner !== 'developer' || report.meta.data.kind !== 'controlled-work-record' ||
        report.meta.data.workflow_id !== workflowId || report.meta.data.task_id !== taskId || report.meta.data.epoch_id !== run.epoch_id ||
        report.meta.data.attempt_id !== attempt.id || report.meta.data.invocation_id !== receipt.id || report.meta.data.stage !== 'implementation' ||
        report.meta.data.outcome !== 'completed' || report.meta.data.report_payload_hash !== hash(canonicalJson(attempt.report)) ||
        !same(report.meta.data.artifact_hashes, attempt.bound_hashes) || evidenceRecordFingerprint(report) !== attempt.report_fingerprint)
      throw new Error('Cornell overwrite recovery lacks its authentic completed producer and typed report.');
    const base = `.neomind/controlled-tools/${hash(attempt.invocation_id)}`, state = JSON.parse(bytes(root, `${base}/state.json`).toString('utf8'));
    if (state.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(state.binding_hash ?? '') || !Array.isArray(state.writes) || state.writes.length > 1024)
      throw new Error('Cornell write provenance journal is invalid or exceeds its bounded recovery scope.');
    const artifacts: ControlledCornellOwnedOverwriteRecovery['artifacts'] = {};
    for (const path of changed) {
      const badHash = expected?.artifacts[path]?.overwritten_sha256 ?? current[path];
      const candidates = state.writes.filter((entry: any) => entry.path === path && entry.completed === true &&
        entry.previous_hash === saved.artifact_hashes[path] && entry.sha256 === badHash);
      if (candidates.length !== 1) throw new Error('Cornell current edits do not have one exact canonical-to-current completed owned write.');
      const entry = candidates[0], operation = hash(JSON.stringify({ binding_hash: state.binding_hash, path, previous_hash: entry.previous_hash, sha256: entry.sha256 }));
      if (entry.operation !== operation) throw new Error('Cornell overwrite operation identity changed.');
      const folder = `${base}/writes/${operation}`, intentBytes = bytes(root, `${folder}/intent.json`), completionBytes = bytes(root, `${folder}/completion.json`);
      const intent = { schema_version: 1, operation, binding_hash: state.binding_hash, path, previous_hash: entry.previous_hash, sha256: entry.sha256 };
      if (intentBytes.toString('utf8') !== `${JSON.stringify(intent, null, 2)}\n` ||
          completionBytes.toString('utf8') !== `${JSON.stringify({ ...intent, kind: 'completed-controlled-file-write' }, null, 2)}\n` ||
          hash(bytes(root, `${folder}/previous.utf8`)) !== saved.artifact_hashes[path] || hash(bytes(root, `${folder}/next.utf8`)) !== badHash)
        throw new Error('Cornell canonical and overwritten bytes differ from their immutable completed write history.');
      if (current[path] !== badHash && current[path] !== resumed?.[path])
        throw new Error('Cornell artifact changed outside the authorized producer write or exact interrupted rendering.');
      artifacts[path] = { canonical_sha256: entry.previous_hash, overwritten_sha256: badHash, operation, binding_hash: state.binding_hash,
        canonical_path: `${folder}/previous.utf8`, overwritten_path: `${folder}/next.utf8`,
        intent_sha256: hash(intentBytes), completion_sha256: hash(completionBytes) };
    }
    const proof: ControlledCornellOwnedOverwriteRecovery = { schema_version: 1, kind: 'owned-cornell-overwrite', workflow_id: workflowId,
      epoch_id: run.epoch_id, task_id: taskId, contract_hash: run.contract_hash, note_id: saved.note_id,
      record_fingerprint: saved.record_fingerprint, source_attempt_id: attempt.id, source_invocation_id: attempt.invocation_id,
      source_report_fingerprint: attempt.report_fingerprint, source_receipt_sha256: hash(canonicalJson(receipt)), artifacts };
    if (expected && !same(expected, proof)) throw new Error('The checkpointed Cornell recovery provenance changed.');
    budget.check(); return proof;
  }
  throw new Error('Changed Cornell artifacts have no authenticated same-task completed producer write.');
}

/** Called again under the notes revision lock. Prepared rendering hashes are only supplied by the immutable writer checkpoint. */
export function authenticateControlledCornellOwnedOverwrite(root: string, saved: ControlledCornellResult,
  proof: ControlledCornellOwnedOverwriteRecovery, resumed?: Record<string, string>, historical?: { operation: string }): CornellOwnedArtifactRecovery {
  const verified = authenticate(root, proof.workflow_id, proof.task_id, saved, proof, resumed, historical);
  if (!verified) throw new Error('Cornell recovery lost its exact owned overwrite proof.');
  return { proof: verified, artifacts: Object.fromEntries(Object.entries(verified.artifacts).map(([path, item]) => [path, {
    original: bytes(root, item.canonical_path), overwritten: bytes(root, item.overwritten_path),
  }])) };
}
import { isControlledExecutionReceipt } from './execution-attestation.js';
