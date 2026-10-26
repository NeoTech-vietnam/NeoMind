import { lstatSync, readFileSync } from 'node:fs';
import { assertControlledPayloadCurrent } from './controlled-payload.js';
import { resolveControlledCornellFormatProfile } from './cornell-format-profile.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import { getRecord, hash, safePath } from './storage.js';
import type { ControlledCornellResult } from './controlled-cornell-sources.js';

/** Trusted assignment guidance derived from the same frozen format contract as compilation.
 * It exposes an old semantic input path only after current provenance/read-scope checks. */
export function controlledCornellFormatContext(root: string, contract: {
  plan: { input_paths?: readonly string[]; cornell_output_dir?: string; cornell_input_path?: string }; preserved_hashes: Record<string, string>;
}, results: readonly ControlledCornellResult[], access: { sourceAllowed(path: string): boolean; read_only?: boolean }): string {
  const profile = resolveControlledCornellFormatProfile(root, contract);
  if (!profile || !contract.plan.cornell_output_dir) return '';
  if (access.read_only) return `Current backend format capability is active: ${profile.id}, verified against this task's declared approved template and validator fingerprints. ` +
    'The backend accepts professional JSON dates in ISO YYYY-MM-DD and renders DD/MM/YYYY plus the exact approved project headings, preserving research sections and separate exercises/answers. ' +
    'The earlier generic ISO-date renderer is not the active capability now; this does not mean existing saved artifacts have already been regenerated. ' +
    'This diagnosis session is read-only and has no compiler operation. Only a separately dispatched producer session can compile or regenerate the managed bundle. Do not call a compiler, edit artifacts or supply a model format/profile argument here. ' +
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
  const result = results.findLast(item => Object.hasOwn(item.artifact_hashes, `${contract.plan.cornell_output_dir}/note.md`));
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
    'Keep the professional JSON date in ISO YYYY-MM-DD; the backend renderer displays DD/MM/YYYY and the exact approved project headings while preserving research sections and separate exercises/answers. ' +
    'The earlier generic ISO-date rendering is not the active renderer now. Do not add a model format/profile argument or edit generated note.md, exercises.md or answers.md directly. ' +
    (boundPath ? 'The primary semantic source is already fixed by the immutable contract. Call cornell_research_compile({}) so the backend loads and rechecks that source; do not submit copied research fields. ' +
      (boundSourceCurrent ? `Its current readable source is ${JSON.stringify(boundPath)}. ` : 'Its current bytes have not been confirmed for this guidance; preserve it for backend reconciliation instead of guessing a replacement path. ')
      : sourcePath ? `The latest backend-compiled semantic input is still current and readable at ${JSON.stringify(sourcePath)}. Reuse it with cornell_research_compile({input_path:${JSON.stringify(sourcePath)}}); do not reconstruct or copy its research prose into another payload. `
      : 'No prior semantic input path has passed current provenance and read-scope checks. Read existing research data if needed and use the declared research input shape; do not guess a saved source path. ') +
    'This render compatibility does not establish execution success, verifier verdict or workflow acceptance. Save the actual producer result; fresh independent checks and required review still apply.';
}
