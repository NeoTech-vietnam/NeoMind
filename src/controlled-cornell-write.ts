import { existsSync, readFileSync } from 'node:fs';
import { cornellCanonical, type CompiledCornellResearch } from './cornell-workflow.js';
import { createCornellNote, reviseCornellNote, validateCornellNote, type CornellWritePolicy } from './notes.js';
import { existingControlledCornellNote, controlledCornellResult, type ControlledCornellSourceContext } from './controlled-cornell-sources.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import { atomicWrite, getRecord, hash, loadRecords, safePath, withOperationLock } from './storage.js';
import type { ProjectRecord } from './types.js';
import { authenticateControlledCornellOwnedOverwrite, controlledCornellOwnedOverwriteRecovery,
  type ControlledCornellOwnedOverwriteRecovery } from './controlled-cornell-recovery.js';

const same = (a: unknown, b: unknown) => cornellCanonical(a) === cornellCanonical(b);
type Rendered = Parameters<CornellWritePolicy['prepare']>[0];
export class ControlledCornellWriteError extends Error { readonly code = 'STATE_UNCERTAIN'; }

/** A generated draft is revised only from this execution's last durable receipt.
 * Model input never selects a record, revision, old hash or repair credential. */
export function persistControlledCornellNote(root: string, compiled: CompiledCornellResearch, context: ControlledCornellSourceContext,
  options: { recover_owned_overwrite?: boolean; validated_artifacts?: Record<string, string> } = {}): ProjectRecord {
  if (compiled.recipe_input.task_id !== context.task_id || compiled.note.workflow_id !== context.workflow_id ||
      compiled.recipe_input.workflow_id !== context.workflow_id ||
      (compiled.note.requirement_ids ?? []).some(id => !context.requirement_ids.includes(id)))
    throw new Error('Research persistence requires the backend-bound current task, workflow and requirements.');
  const task = getRecord(root, context.task_id);
  if (task.meta.type !== 'task' || task.meta.data.workflow_id !== context.workflow_id)
    throw new Error('Research persistence cannot bind a foreign task.');
  const path = compiled.note.path!;
  return withOperationLock(root, `controlled-cornell-${hash(`${context.workflow_id}:${context.task_id}:${path}`).slice(0, 32)}`, () => {
    try {
    const replay = existingControlledCornellNote(root, compiled, context);
    if (replay) return replay;
    const saved = [...(context.saved_results ?? [])].reverse().find(result => Object.hasOwn(result.artifact_hashes, path));
    const baseIdentity = { workflow_id: context.workflow_id, epoch_id: context.epoch_id, task_id: context.task_id,
      input_hash: compiled.input_hash, compiled_note_hash: hash(JSON.stringify(compiled.note)), previous: saved ?? null };
    let recovery: ControlledCornellOwnedOverwriteRecovery | undefined;
    if (options.recover_owned_overwrite && saved) {
      const checkpoint = safePath(root, `.neomind/controlled/cornell-recoveries/${hash(cornellCanonical(baseIdentity))}.json`);
      if (existsSync(checkpoint)) {
        const value = JSON.parse(readFileSync(checkpoint, 'utf8'));
        if (value.schema_version !== 1 || !same(value.identity, baseIdentity) || value.recovery?.kind !== 'owned-cornell-overwrite')
          throw new ControlledCornellWriteError('The owned Cornell recovery checkpoint differs from its original compiler generation.');
        recovery = value.recovery;
      } else {
        recovery = controlledCornellOwnedOverwriteRecovery(root, context.workflow_id, context.task_id, saved);
        if (recovery) atomicWrite(checkpoint, `${JSON.stringify({ schema_version: 1, identity: baseIdentity, recovery }, null, 2)}\n`);
      }
      if (recovery && (recovery.workflow_id !== context.workflow_id || recovery.task_id !== context.task_id ||
          recovery.epoch_id !== context.epoch_id || recovery.note_id !== saved.note_id))
        throw new ControlledCornellWriteError('Owned Cornell recovery cannot cross its original task, epoch or generated note.');
    }
    const identity = { ...baseIdentity, ...(recovery ? { owned_overwrite_recovery: recovery } : {}) };
    const requestHash = hash(cornellCanonical(identity)), folder = `.neomind/controlled/cornell-writes/${requestHash}`;
    const intentPath = safePath(root, `${folder}/intent.json`), renderPath = safePath(root, `${folder}/rendered.json`), resultPath = safePath(root, `${folder}/result.json`);
    const read = (file: string) => {
      try { return JSON.parse(readFileSync(file, 'utf8')); }
      catch (cause) { throw new ControlledCornellWriteError('The saved research operation checkpoint is unreadable. Preserve the draft for backend reconciliation.', { cause }); }
    };
    const owned = (note: ProjectRecord) => note.meta.type === 'knowledge' && note.meta.status === 'draft' &&
      note.meta.data.format === 'cornell-v1' && note.meta.data.workflow_id === context.workflow_id && note.meta.data.artifact_path === path &&
      (compiled.note.requirement_ids ?? []).every(id => note.meta.links.some(link => link.type === 'documents' && link.target === id));
    const previous = saved ? getRecord(root, saved.note_id) : undefined;
    let intent: { schema_version: number; request_hash: string; identity: typeof identity; previous_revision: number;
      before_note_ids: string[]; before_artifacts: Record<string, string | null> };
    if (existsSync(intentPath)) {
      intent = read(intentPath);
      if (intent.schema_version !== 1 || intent.request_hash !== requestHash || !same(intent.identity, identity) ||
          !Number.isSafeInteger(intent.previous_revision) || !Array.isArray(intent.before_note_ids) ||
          !intent.before_artifacts || typeof intent.before_artifacts !== 'object')
        throw new ControlledCornellWriteError('The immutable research write intent changed. Preserve the draft and reconcile this backend operation.');
    } else {
      if (previous && (!owned(previous) || evidenceRecordFingerprint(previous) !== saved!.record_fingerprint ||
          !same(previous.meta.data.artifact_hashes, saved!.artifact_hashes)))
        throw new ControlledCornellWriteError('The generated research record changed outside its saved backend receipt. Preserve the current record before revision.');
      const files = [path, compiled.note.practice.exercise_path, compiled.note.practice.answer_path];
      const before = Object.fromEntries(files.map(file => [file, existsSync(safePath(root, file)) ? hash(readFileSync(safePath(root, file))) : null]));
      if (saved ? Object.entries(saved.artifact_hashes).some(([file, sha256]) => before[file] !== sha256 &&
          (!recovery?.artifacts[file] || before[file] !== recovery.artifacts[file].overwritten_sha256)) : Object.values(before).some(value => value !== null))
        throw new ControlledCornellWriteError('Preserve user-edited or pre-existing research artifacts; the backend has no current receipt authorizing their replacement.');
      intent = { schema_version: 1, request_hash: requestHash, identity, previous_revision: previous?.meta.revision ?? 0,
        before_note_ids: loadRecords(root).filter(note => note.meta.data.artifact_path === path).map(note => note.meta.id), before_artifacts: before };
      atomicWrite(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
    }
    const rendered: Rendered | undefined = existsSync(renderPath) ? read(renderPath).rendered : undefined;
    if (rendered && read(renderPath).request_hash !== requestHash)
      throw new ControlledCornellWriteError('The prepared research rendering belongs to another operation.');
    if (rendered) {
      const ownedPaths = [path, compiled.note.practice.exercise_path, compiled.note.practice.answer_path, compiled.note.practice.solution_path].filter(Boolean);
      if (!rendered.artifacts || !rendered.data || typeof rendered.body !== 'string' ||
          [path, compiled.note.practice.exercise_path, compiled.note.practice.answer_path].some(file => !Object.hasOwn(rendered.artifacts, file)) ||
          Object.entries(rendered.artifacts).some(([file, digest]) => !ownedPaths.includes(file) || !/^[a-f0-9]{64}$/.test(digest)))
        throw new ControlledCornellWriteError('The prepared research rendering exceeds its generated output scope or lacks its required bytes.');
    }
    const matchesRendered = (note: ProjectRecord) => !!rendered && owned(note) && note.meta.revision === intent.previous_revision + 1 &&
      note.meta.title === rendered.title && note.meta.owner === rendered.owner && note.body === rendered.body &&
      Object.entries(rendered.data).every(([name, value]) => same(note.meta.data[name], value)) &&
      Object.entries(rendered.artifacts).every(([file, sha256]) => existsSync(safePath(root, file)) && hash(readFileSync(safePath(root, file))) === sha256) &&
      validateCornellNote(root, note.meta.id).ok;
    const finish = (note: ProjectRecord) => {
      atomicWrite(resultPath, `${JSON.stringify({ schema_version: 1, request_hash: requestHash, proof: controlledCornellResult(compiled, note) }, null, 2)}\n`);
      return note;
    };
    if (existsSync(resultPath)) {
      const result = read(resultPath);
      if (typeof result.proof?.note_id !== 'string') throw new ControlledCornellWriteError('The research completion checkpoint has no valid backend record identity.');
      const note = getRecord(root, result.proof.note_id);
      if (result.schema_version !== 1 || result.request_hash !== requestHash || !matchesRendered(note) ||
          !same(result.proof, controlledCornellResult(compiled, note)))
        throw new ControlledCornellWriteError('The completed research write no longer matches its recorded files and record. Current edits are preserved.');
      return note;
    }
    // A record may commit immediately before its response/result is lost.
    // Reconcile only the exact rendered record and bytes prepared beforehand.
    const candidates = previous ? [getRecord(root, previous.meta.id)] : loadRecords(root).filter(note =>
      note.meta.data.artifact_path === path && !intent.before_note_ids.includes(note.meta.id));
    const completed = candidates.filter(matchesRendered);
    if (completed.length > 1) throw new ControlledCornellWriteError('Multiple research records match one unfinished write intent; backend reconciliation is required.');
    if (completed[0]) return finish(completed[0]);
    if (previous && (!owned(previous) || evidenceRecordFingerprint(previous) !== saved!.record_fingerprint ||
        previous.meta.revision !== intent.previous_revision))
      throw new ControlledCornellWriteError('The unfinished research correction differs from both its prior receipt and exact prepared result. Current work is preserved.');
    const policy: CornellWritePolicy = {
      recover_creation: !previous && !!rendered && Object.values(intent.before_artifacts).every(value => value === null),
      recover_artifacts: rendered?.artifacts,
      ...(recovery && saved ? { recover_owned_artifacts: () => authenticateControlledCornellOwnedOverwrite(root, saved, recovery!,
        // These hashes are owned by this exact immutable rendering checkpoint, never a worker argument.
        rendered?.artifacts) } : {}),
      prepare(value) {
        if (options.validated_artifacts && Object.entries(options.validated_artifacts).some(([path, digest]) => value.artifacts[path] !== digest))
          throw new ControlledCornellWriteError('The durable Cornell rendering differs from its actual pinned-validator receipt. No generated files were replaced.');
        const next = { schema_version: 1, request_hash: requestHash, rendered: value };
        if (existsSync(renderPath)) {
          if (!same(read(renderPath), next)) throw new ControlledCornellWriteError('Research rendering changed while recovering the same operation.');
        } else atomicWrite(renderPath, `${JSON.stringify(next, null, 2)}\n`);
      },
    };
    const note = previous ? reviseCornellNote(root, previous.meta.id, compiled.note, intent.previous_revision,
      'Backend-bound research correction from the current task; prior record and artifact bytes remain in immutable revision history.', policy)
      : createCornellNote(root, compiled.note, policy);
    return finish(note);
    } catch (error) {
      if (error instanceof ControlledCornellWriteError) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (typeof code === 'string' && ['EIO', 'ENOSPC', 'ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(code))
        throw new ControlledCornellWriteError('Research persistence was interrupted. The backend retains its prepared operation and must reconcile the exact result before another write.', { cause: error });
      throw error;
    }
  });
}
