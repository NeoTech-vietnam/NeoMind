import { existsSync, readFileSync } from 'node:fs';
import { canonicalJson } from './routing.js';
import { atomicWrite, getRecord, hash, safePath, withOperationLock } from './storage.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import { restoreCornellOwnedDraft, validateCornellNote } from './notes.js';
import { authenticateControlledCornellOwnedOverwrite, controlledCornellOwnedOverwriteRecovery,
  type ControlledCornellOwnedOverwriteRecovery } from './controlled-cornell-recovery.js';
import type { ControlledCornellResult } from './controlled-cornell-sources.js';
import type { ProjectRecord } from './types.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const reason = 'Backend restores only retained canonical compiler bytes after an authenticated owned overwrite; the overwritten bytes and signed producer lineage remain in immutable history. Fresh independent verification and required review remain mandatory.';
export class ControlledCornellRestoreError extends Error { readonly code = 'STATE_UNCERTAIN'; }
interface Intent {
  schema_version: 1; identity: { workflow_id: string; task_id: string; saved: ControlledCornellResult };
  operation: string; original: ProjectRecord; original_record_sha256: string; proof: ControlledCornellOwnedOverwriteRecovery;
}

/** Restore a proven generated-artifact overwrite without asking a model to reconstruct old research.
 * This creates a new managed revision; it never accepts, closes, changes semantics or updates the workflow journal. */
export function restoreControlledCornellOwnedArtifacts(root: string, workflowId: string, taskId: string,
  saved: ControlledCornellResult, options: { assertActive?(): void } = {}): { note: ProjectRecord; result: ControlledCornellResult; replayed: boolean } {
  const assertActive = () => options.assertActive?.(), identity = { workflow_id: workflowId, task_id: taskId, saved };
  const key = hash(canonicalJson(identity)), folder = `.neomind/controlled/cornell-restorations/${key}`;
  return withOperationLock(root, `controlled-cornell-restore-${key.slice(0, 32)}`, () => {
    try {
      assertActive();
      const intentPath = safePath(root, `${folder}/intent.json`), resultPath = safePath(root, `${folder}/result.json`);
      let intent: Intent;
      if (existsSync(intentPath)) {
        intent = JSON.parse(readFileSync(intentPath, 'utf8'));
        if (intent.schema_version !== 1 || !same(intent.identity, identity) || intent.original?.meta?.id !== saved.note_id ||
            evidenceRecordFingerprint(intent.original) !== saved.record_fingerprint ||
            intent.operation !== hash(canonicalJson({ identity, proof: intent.proof })) ||
            intent.proof.workflow_id !== workflowId || intent.proof.task_id !== taskId || intent.proof.note_id !== saved.note_id)
          throw new Error('The immutable Cornell restoration intent differs from its original compiler generation.');
      } else {
        const proof = controlledCornellOwnedOverwriteRecovery(root, workflowId, taskId, saved);
        if (!proof) throw new Error('No authenticated owned Cornell overwrite requires restoration.');
        const original = getRecord(root, saved.note_id);
        intent = { schema_version: 1, identity, operation: hash(canonicalJson({ identity, proof })), original,
          original_record_sha256: hash(readFileSync(safePath(root, original.path))), proof };
        assertActive(); atomicWrite(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
      }
      const completed = (note: ProjectRecord): boolean => {
        const prior = intent.original, marker = note.meta.data.backend_artifact_restoration as { operation?: string; previous_revision?: number } | undefined;
        const histories = note.meta.data.revision_history as any[] | undefined, history = histories?.at(-1);
        const previousHistories = (prior.meta.data.revision_history as unknown[] | undefined) ?? [];
        if (note.meta.revision !== prior.meta.revision + 1 || marker?.operation !== intent.operation || marker.previous_revision !== prior.meta.revision ||
            note.meta.id !== prior.meta.id || note.meta.type !== prior.meta.type || note.meta.status !== prior.meta.status ||
            note.meta.title !== prior.meta.title || note.meta.owner !== prior.meta.owner || !same(note.meta.links, prior.meta.links) || note.body !== prior.body ||
            !history || histories?.length !== previousHistories.length + 1 || !same(histories.slice(0, -1), previousHistories) ||
            history.revision !== prior.meta.revision || history.request_hash !== intent.operation || history.reason !== reason ||
            history.record_hash !== intent.original_record_sha256 || !history.owned_artifact_recovery)
          return false;
        const mutable = new Set(['revision_history', 'output_paths', 'prior_invocation_ids', 'backend_artifact_restoration']);
        if (Object.keys({ ...prior.meta.data, ...note.meta.data }).some(name => !mutable.has(name) && !same(note.meta.data[name], prior.meta.data[name]))) return false;
        const originalPaths = Object.keys(saved.artifact_hashes);
        if (!same(Object.keys(history.artifacts).sort(), [...originalPaths].sort()) || originalPaths.some(path => history.artifacts[path].sha256 !== saved.artifact_hashes[path])) return false;
        const recovery = history.owned_artifact_recovery;
        if (!same(Object.keys(recovery.artifacts).sort(), Object.keys(intent.proof.artifacts).sort()) ||
            Object.entries(intent.proof.artifacts).some(([path, proof]) => recovery.artifacts[path]?.sha256 !== proof.overwritten_sha256)) return false;
        const expectedOutputPaths = [...new Set([...(Array.isArray(prior.meta.data.output_paths) ? prior.meta.data.output_paths as string[] : []),
          history.record_path, history.intent_path, ...Object.values(history.artifacts as Record<string, { history_path: string }>).map(item => item.history_path),
          recovery.proof_path, ...Object.values(recovery.artifacts as Record<string, { history_path: string }>).map(item => item.history_path)])];
        const expectedPriorInvocations = [...new Set([...(Array.isArray(prior.meta.data.prior_invocation_ids) ? prior.meta.data.prior_invocation_ids as string[] : []),
          ...(typeof prior.meta.data.invocation_id === 'string' ? [prior.meta.data.invocation_id] : [])])];
        return same(note.meta.data.output_paths, expectedOutputPaths) && same(note.meta.data.prior_invocation_ids, expectedPriorInvocations) &&
          Object.entries(saved.artifact_hashes).every(([path, digest]) => hash(readFileSync(safePath(root, path))) === digest) && validateCornellNote(root, note.meta.id).ok;
      };
      const finish = (note: ProjectRecord, replayed: boolean) => {
        if (!completed(note)) throw new Error('Cornell restoration differs from its exact canonical record, history or artifact bytes.');
        authenticateControlledCornellOwnedOverwrite(root, saved, intent.proof, saved.artifact_hashes, { operation: intent.operation });
        const result = { ...structuredClone(saved), record_fingerprint: evidenceRecordFingerprint(note) };
        const checkpoint = { schema_version: 1, operation: intent.operation, result };
        if (existsSync(resultPath)) {
          if (!same(JSON.parse(readFileSync(resultPath, 'utf8')), checkpoint)) throw new Error('The Cornell restoration completion receipt changed.');
        } else { assertActive(); atomicWrite(resultPath, `${JSON.stringify(checkpoint, null, 2)}\n`); }
        return { note, result, replayed };
      };
      const current = getRecord(root, saved.note_id);
      if (completed(current)) return finish(current, true);
      if (existsSync(resultPath) || !same(current, intent.original) || hash(readFileSync(safePath(root, current.path))) !== intent.original_record_sha256)
        throw new Error('A later Cornell generation or record edit supersedes this restoration; preserve it.');
      // An existing intent is required before canonical bytes may be accepted as
      // this operation's interrupted partial restoration.
      authenticateControlledCornellOwnedOverwrite(root, saved, intent.proof, saved.artifact_hashes);
      const note = restoreCornellOwnedDraft(root, saved.note_id, intent.original.meta.revision, intent.operation, reason, {
        assertActive,
        recover_owned_artifacts: () => authenticateControlledCornellOwnedOverwrite(root, saved, intent.proof, saved.artifact_hashes),
      });
      return finish(note, false);
    } catch (cause) {
      if (cause instanceof ControlledCornellRestoreError) throw cause;
      throw new ControlledCornellRestoreError('The backend could not reconcile the exact owned Cornell restoration. Current files, immutable history and checkpoint are preserved; do not reconstruct identities, refresh hashes or replay another generation.', { cause });
    }
  });
}
