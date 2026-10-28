import { lstatSync, readFileSync } from 'node:fs';
import { assertControlledPayloadCurrent } from './controlled-payload.js';
import { cornellFormatRendererRevision, resolveControlledCornellFormatProfile } from './cornell-format-profile.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import { getRecord, hash, safePath } from './storage.js';
import type { ControlledCornellResult } from './controlled-cornell-sources.js';

/** Trusted assignment guidance derived from the same frozen format contract as compilation.
 * It exposes an old semantic input path only after current provenance/read-scope checks. */
export function controlledCornellFormatContext(root: string, contract: {
  plan: { input_paths?: readonly string[]; outputs?: readonly string[]; cornell_output_dir?: string; cornell_input_path?: string }; preserved_hashes: Record<string, string>;
}, results: readonly ControlledCornellResult[], access: { sourceAllowed(path: string): boolean; read_only?: boolean }): string {
  const profile = resolveControlledCornellFormatProfile(root, contract);
  if (!profile || !contract.plan.cornell_output_dir) return '';
  const separateNotes = (contract.plan.outputs ?? []).filter(path => /(?:^|\/)\d+_note\.md$/.test(path) && path !== `${contract.plan.cornell_output_dir}/note.md`);
  const separateFormat = separateNotes.length ? `The native compiler's format/validation receipt covers its primary trio only; it does not certify separate curriculum notes ${JSON.stringify(separateNotes)}. ` +
    `Those declared notes retain their own approved project-format requirement. Use a template-backed producer reading ${JSON.stringify(profile.template.path)}; do not freehand or shorten the headings/layout. ` +
    'Populate substantive problem-specific template fields, remove template author comments and unresolved tokens, preserve styled strategy and worked-example Mermaid sections, and specialize generic diagram labels to the actual algorithm and example. ' +
    `Run the existing pinned validator ${JSON.stringify(profile.validator.path)} on each generated curriculum note before publishing; a successful primary trio is not evidence that these other files pass. ` : '';
  const rendererRevision = cornellFormatRendererRevision(profile);
  const result = results.findLast(item => Object.hasOwn(item.artifact_hashes, `${contract.plan.cornell_output_dir}/note.md`));
  let generatedRevision: number | 'not-recorded' = 'not-recorded', artifactsCurrent = false;
  if (result) {
    try {
      const note = getRecord(root, result.note_id);
      const research = note.meta.data.research as { format_renderer_revision?: unknown } | undefined;
      if (typeof research?.format_renderer_revision === 'number') generatedRevision = research.format_renderer_revision;
      artifactsCurrent = evidenceRecordFingerprint(note) === result.record_fingerprint &&
        Object.entries(result.artifact_hashes).every(([path, digest]) => hash(readFileSync(safePath(root, path))) === digest);
    } catch { /* Missing or changed artifacts never inherit an old validation receipt. */ }
  }
  const proof = result?.canonical_validation;
  const receiptIdentity = proof && { renderer_revision: proof.renderer_revision, validator_sha256: proof.validator_sha256,
    input_hash: proof.input_hash, artifact_hashes: proof.artifact_hashes };
  const receiptCurrent = !!proof && artifactsCurrent && proof.schema_version === 1 && proof.exit_code === 0 &&
    proof.input_hash === result!.input_hash && proof.renderer_revision === generatedRevision &&
    proof.validator_sha256 === profile.validator.sha256 && proof.generation === hash(JSON.stringify(receiptIdentity)) &&
    Object.keys(proof.artifact_hashes).length === Object.keys(result!.artifact_hashes).length &&
    Object.entries(result!.artifact_hashes).every(([path, digest]) => proof.artifact_hashes[path] === digest);
  const provenance = `Current backend renderer revision: ${rendererRevision}. Saved bundle provenance: ${JSON.stringify({
    saved_bundle_present: !!result, generated_renderer_revision: generatedRevision, artifacts_current: artifactsCurrent,
    canonical_validation: !proof ? 'not-recorded' : !receiptCurrent ? 'stale-or-unavailable'
      : proof.renderer_revision === rendererRevision ? 'passed-current-generation' : 'passed-older-renderer',
    ...(proof ? { validated_renderer_revision: proof.renderer_revision, validation_generation: proof.generation } : {}),
  })}. A current renderer capability is separate from the stored generation and its actual pinned-validator receipt. `;
  if (access.read_only) return `Current backend format capability is active: ${profile.id}, verified against this task's declared approved template and validator fingerprints. ` +
    provenance + separateFormat +
    'The backend accepts professional JSON dates in ISO YYYY-MM-DD and renders DD/MM/YYYY plus the exact approved project headings, preserving research sections and separate exercises/answers. ' +
    'The earlier generic ISO-date renderer is not the active capability now; this does not mean existing saved artifacts have already been regenerated. ' +
    'This diagnosis session is read-only and has no compiler operation. A separately dispatched producer session handles ordinary content compilation or regeneration; trusted runtime maintenance can reconcile its own faulty renderer from the exact retained source. Do not call a compiler, edit artifacts or supply a model format/profile argument here. ' +
    'Use the available read-only evidence to classify the actual current failure and state a bounded repair direction. Current format capability alone establishes neither execution success nor verifier verdict nor workflow acceptance.';
  const boundPath = contract.plan.cornell_input_path;
  let boundSourceCurrent = false;
  if (boundPath && access.sourceAllowed(boundPath)) {
    try {
      assertControlledPayloadCurrent(root, { path: boundPath, sha256: contract.preserved_hashes[boundPath]!,
        size_bytes: lstatSync(safePath(root, boundPath)).size });
      boundSourceCurrent = true;
    } catch { /* Never replace the immutable bound source with reconstructed prose. */ }
  }
  let sourcePath: string | undefined;
  const source = result?.payload_source;
  if (source && result && typeof source.path === 'string' && access.sourceAllowed(source.path)) {
    try {
      assertControlledPayloadCurrent(root, source);
      const note = getRecord(root, result.note_id);
      if (evidenceRecordFingerprint(note) === result.record_fingerprint &&
          Object.entries(result.artifact_hashes).every(([path, digest]) => hash(readFileSync(safePath(root, path))) === digest))
        sourcePath = source.path;
    } catch { /* Stale or unavailable old input is never advertised as an authorized replay. */ }
  }
  return `Backend format compatibility is active: ${profile.id}, bound to this task's declared approved template and validator fingerprints. ` +
    provenance + separateFormat +
    'Keep the professional JSON date in ISO YYYY-MM-DD; the backend renderer displays DD/MM/YYYY and the exact approved project headings while preserving research sections and separate exercises/answers. ' +
    'The earlier generic ISO-date rendering is not the active renderer now. Do not add a model format/profile argument or edit generated note.md, exercises.md or answers.md directly. ' +
    (boundPath ? 'The primary semantic source is already fixed by the immutable contract. Call cornell_research_compile({}) so the backend loads and rechecks that source; do not submit copied research fields. ' +
      (boundSourceCurrent ? `Its current readable source is ${JSON.stringify(boundPath)}. ` : 'Its current bytes have not been confirmed for this guidance; preserve it for backend reconciliation instead of guessing a replacement path. ')
      : sourcePath ? `The latest backend-compiled semantic input is still current and readable at ${JSON.stringify(sourcePath)}. Reuse it with cornell_research_compile({input_path:${JSON.stringify(sourcePath)}}); do not reconstruct or copy its research prose into another payload. `
      : 'No prior semantic input path has passed current provenance and read-scope checks. Read existing research data if needed and use the declared research input shape; do not guess a saved source path. ') +
    'This render compatibility does not establish execution success, verifier verdict or workflow acceptance. Save the actual producer result; fresh independent checks and required review still apply.';
}
