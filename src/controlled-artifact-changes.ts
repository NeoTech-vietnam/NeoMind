import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from './routing.js';
import { atomicWrite, hash, safePath } from './storage.js';
import { workspaceFileBytes, assertWorkspaceEditablePath } from './workspace.js';
import { controlledFingerprints } from './controlled-acceptance.js';
import type { ControlledContract, ControlledSnapshot } from './controlled-workflow.js';

export interface ControlledArtifactPage { path?: string; start_char?: number; max_chars?: number }
export interface ControlledArtifactChangeRead {
  before_sha256: string; current_sha256: string; evidence_sha256: string;
}
export type ControlledArtifactChangeReads = Record<string, ControlledArtifactChangeRead>;
export interface ControlledArtifactChangeCoverage extends ControlledArtifactChangeRead {
  total: number; ranges: [number, number][];
}
export type ControlledArtifactChangeCoverageMap = Record<string, ControlledArtifactChangeCoverage>;

const digest = /^[a-f0-9]{64}$/;
function textBoundary(text: string, index: number): number {
  const at = Math.max(0, Math.min(index, text.length));
  return at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!) ? at - 1 : at;
}
const textPrefix = (text: string, length: number) => text.slice(0, textBoundary(text, length));

function unlinkedTarget(root: string, path: string): string {
  const target = safePath(root, path);
  for (let cursor = target; cursor !== resolve(root); cursor = dirname(cursor))
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw Error('Linked artifact history is unavailable.');
  return target;
}
function ordinary(root: string, path: string, limit: number): Buffer {
  const target = unlinkedTarget(root, path);
  const info = lstatSync(target);
  if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw Error('Artifact history is not a bounded ordinary file.');
  return readFileSync(target);
}

function originalPath(run: Pick<ControlledSnapshot, 'workflow_id' | 'epoch_id'>, path: string, expected: string): string {
  return `.neomind/controlled/workflows/${hash(run.workflow_id)}.${run.epoch_id}.producer-originals/${hash(path)}.${expected}.utf8`;
}

/** Capture only eligible existing text files from the already bounded output
 * baseline. The sealed contract hashes authenticate these private before bytes.
 * This is independent of which producer tool runs or whether inference finishes. */
export function retainControlledProducerOriginals(root: string, run: Pick<ControlledSnapshot, 'workflow_id' | 'epoch_id'>,
  baselines: Record<string, string | null>): void {
  for (const [path, expected] of Object.entries(baselines)) {
    if (expected === null) continue;
    let bytes: Buffer | null;
    try { bytes = workspaceFileBytes(root, path, 'workforce-product'); }
    catch { continue; } // Non-text/large artifacts keep their existing verification path.
    if (bytes === null || hash(bytes) !== expected) throw Error('An editable original changed before its immutable plan snapshot. Preserve the current edit.');
    const target = originalPath(run, path, expected);
    if (existsSync(safePath(root, target))) {
      if (hash(ordinary(root, target, 128 * 1024)) !== expected) throw Error('An immutable editable-output original was changed.');
    } else atomicWrite(unlinkedTarget(root, target), bytes);
  }
}

function originalBytes(root: string, run: ControlledSnapshot, path: string,
  expected: string): { bytes: Buffer; proof: string } | undefined {
  try {
    const target = originalPath(run, path, expected), bytes = ordinary(root, target, 128 * 1024);
    if (hash(bytes) === expected) return { bytes, proof: hash(canonicalJson({ source: 'immutable-plan-original', path: target, sha256: expected })) };
  } catch { /* Missing/corrupted original content is never replaced by later bytes. */ }
}

/** Existing binary or oversized execution artifacts retain their established
 * verification methods; this text-read proof must not create an impossible gate. */
export function controlledTextChangeAssessmentPaths(root: string, contract: ControlledContract): string[] {
  return Object.entries(contract.producer_baselines ?? {}).flatMap(([path, expected]) => {
    if (expected === null) return [];
    try { const current = workspaceFileBytes(root, path, 'workforce-product');
      return current !== null && hash(current) !== expected ? [path] : []; }
    catch { return []; }
  });
}

/** A complete single replacement hunk: bounded linear work, no subprocess/dependency.
 * It preserves every removed/added line; it is not claimed to be a minimal diff. */
function changeDiff(path: string, before: string, current: string): string {
  if (before === current) return '';
  const left = before.replace(/\r\n/g, '\n').split('\n'), right = current.replace(/\r\n/g, '\n').split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  while (suffix < left.length - prefix && suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3), leftEnd = Math.min(left.length, left.length - suffix + 3),
    rightEnd = Math.min(right.length, right.length - suffix + 3);
  return [`--- before/${path}`, `+++ current/${path}`, `@@ -${start + 1},${leftEnd - start} +${start + 1},${rightEnd - start} @@`,
    ...left.slice(start, prefix).map(line => ` ${line}`),
    ...left.slice(prefix, left.length - suffix).map(line => `-${line}`),
    ...right.slice(prefix, right.length - suffix).map(line => `+${line}`),
    ...left.slice(left.length - suffix, leftEnd).map(line => ` ${line}`)].join('\n');
}

/** Caller supplies the already-authenticated journal and immutable contract from
 * controlledContractForTask. This adds read-only facts, never a semantic verdict. */
export function controlledArtifactChanges(root: string, run: ControlledSnapshot, contract: ControlledContract,
  options: ControlledArtifactPage = {}) {
  const max = options.max_chars ?? 64000, start = options.start_char ?? 0;
  if (!Number.isSafeInteger(max) || max < 128 || max > 64000 || !Number.isSafeInteger(start) || start < 0 ||
      start > 2 * 1024 * 1024 || start && !options.path)
    throw Error('Select an assigned output path when paging its original text; use start_char >= 0 and max_chars 128..64000.');
  if (contract.workflow_id !== run.workflow_id || contract.epoch_id !== run.epoch_id)
    throw Error('Artifact change evidence belongs to another request.');
  const baseline = contract.producer_baselines;
  if (!baseline) return { available: false, baseline_source: 'unavailable-legacy-contract' as const,
    reason: 'NO_ORIGINAL_EDITABLE_BASELINE', files: [], coverage: 'This historical contract did not capture editable-output baselines. No later bytes are substituted as its original state.' };
  if (options.path) assertWorkspaceEditablePath(options.path, 'workforce-product');
  const fold = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const covers = (path: string) => contract.plan.outputs.some(scope => fold(path) === fold(scope) || fold(path).startsWith(`${fold(scope)}/`));
  if (options.path && !covers(options.path)) throw Error('Choose an assigned output file for original-content evidence.');
  let remaining = max;
  // New files have no old content to inspect. Do not let their already-readable
  // source text consume the original-content budget of edited existing outputs.
  const selectedPath = options.path && (Object.keys(baseline).find(path => path === options.path) ??
    Object.keys(baseline).find(path => fold(path) === fold(options.path!)) ?? options.path);
  const allCandidates = selectedPath ? [selectedPath] : Object.keys(baseline);
  const candidates = allCandidates.filter(path => {
    try { assertWorkspaceEditablePath(path, 'workforce-product'); return true; } catch { return false; }
  });
  // Reuse the bounded streaming fingerprint primitive. Never retain every
  // candidate's bytes merely to prioritize a much smaller visible projection.
  let currentHashes: Record<string, string> = {};
  try { currentHashes = controlledFingerprints(root, candidates); } catch { /* A scoped page can still inspect an available file. */ }
  const priorities = new Map(candidates.map(path => [path, baseline[path] !== null && currentHashes[path] !== baseline[path]
    ? 0 : baseline[path] === null ? 2 : 1]));
  const paths = candidates.sort((a, b) => priorities.get(a)! - priorities.get(b)!);
  const files = paths.slice(0, 64).map(path => {
    // A child absent from the bounded original directory capture is new; this
    // does not turn an existing directory itself into a new-file baseline.
    const expected = Object.hasOwn(baseline, path) ? baseline[path]! : null;
    const unavailable = (reason: string, currentHash: string | null = null, textSupported = false) => ({ path, available: false,
      before_sha256: expected ?? null, current_sha256: currentHash, change: 'unavailable' as const,
      original_text: null, diff: null, history_authenticated: false, text_supported: textSupported, truncated: false, reason });
    if (expected !== null && !digest.test(expected ?? '')) return unavailable('BASELINE_NOT_CAPTURED');
    try {
      const observed = currentHashes[path];
      const currentHash = observed === 'missing' ? null : digest.test(observed ?? '') ? observed! : null;
      if (observed === undefined) return unavailable('CURRENT_METADATA_UNAVAILABLE');
      if (expected === null) return { path, available: true, before_sha256: null, current_sha256: currentHash,
        change: 'added' as const, original_text: '', diff: '', history_authenticated: true, text_supported: false,
        original_start_char: 0, original_end_char: 0, original_total_chars: 0, original_complete: true,
        next_start_char: null, diff_complete: true, truncated: false,
        evidence_sha256: hash(canonicalJson({ contract_hash: run.contract_hash, path, before: null,
          current: currentHash, original_proof: 'new-at-plan' })) };
      let current: Buffer | null;
      try { current = workspaceFileBytes(root, path, 'workforce-product'); }
      catch { return unavailable('NOT_A_BOUNDED_TEXT_OUTPUT', currentHash); }
      if ((current === null ? null : hash(current)) !== currentHash) return unavailable('CURRENT_CONTENT_CHANGED_DURING_OBSERVATION', currentHash, true);
      const original = expected === null ? { bytes: Buffer.alloc(0), proof: 'new-at-plan' }
        : currentHash === expected ? { bytes: current!, proof: 'current-matches-immutable-original' }
        : originalBytes(root, run, path, expected);
      if (!original) return unavailable('ORIGINAL_BASELINE_UNAVAILABLE', currentHash, true);
      const decode = (bytes: Buffer) => { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (text.includes('\0')) throw Error('Binary text cannot support this content assessment.'); return text; };
      const before = decode(original.bytes), after = current === null ? '' : decode(current);
      const fullDiff = expected === null ? '' : changeDiff(path, before, after), offset = options.path ? textBoundary(before, start) : 0;
      const text = before.slice(offset, textBoundary(before, offset + remaining)); remaining -= text.length;
      const diff = textPrefix(fullDiff, remaining); remaining -= diff.length;
      const originalEnd = offset + text.length;
      return { path, available: true, before_sha256: expected, current_sha256: currentHash,
        change: expected === null ? 'added' as const : currentHash === expected ? 'unchanged' as const : current === null ? 'deleted' as const : 'modified' as const,
        original_text: text, diff, history_authenticated: true, text_supported: true,
        original_start_char: offset, original_end_char: originalEnd, original_total_chars: before.length,
        original_complete: offset === 0 && originalEnd === before.length,
        next_start_char: originalEnd < before.length ? originalEnd : null,
        diff_complete: diff.length === fullDiff.length, truncated: offset !== 0 || originalEnd < before.length || diff.length < fullDiff.length,
        evidence_sha256: hash(canonicalJson({ contract_hash: run.contract_hash, path, before: expected,
          current: currentHash, original_proof: original.proof })) };
    } catch { return unavailable('ORIGINAL_OR_CURRENT_TEXT_UNAVAILABLE'); }
  });
  const value = { available: files.every(file => file.available), baseline_source: 'immutable-plan-and-original-snapshots' as const,
    files, character_budget: 64000, text_page_limit: max, file_count: candidates.length, displayed_count: files.length,
    private_path_count: allCandidates.length - candidates.length,
    omitted_count: candidates.length - files.length, truncated: files.some(file => file.truncated) || candidates.length > files.length,
    coverage: 'Declared output scopes only, using their original bounded file capture. Editable-file originals are distinct from unchanged protected inputs. Read all original pages and the complete current output before judging preservation; unavailable evidence cannot support a preservation pass.' };
  // The budget applies to the encoded whole projection, not just source text.
  // Every shortening updates the public cursor and completeness observation.
  while (JSON.stringify(value).length > 64000 && value.files.length) {
    const excess = JSON.stringify(value).length - 64000, file = value.files.findLast(item => item.available &&
      'original_end_char' in item && ((item.diff?.length ?? 0) || (item.original_text?.length ?? 0)));
    if (file && 'original_end_char' in file) {
      if (file.diff.length) { file.diff = textPrefix(file.diff, Math.max(0, file.diff.length - excess)); file.diff_complete = false; }
      else {
        file.original_text = textPrefix(file.original_text, Math.max(0, file.original_text.length - excess));
        file.original_end_char = file.original_start_char + file.original_text.length;
        file.original_complete = file.original_start_char === 0 && file.original_end_char === file.original_total_chars;
        file.next_start_char = file.original_end_char < file.original_total_chars ? file.original_end_char : null;
      }
      file.truncated = true; value.truncated = true;
    } else { value.files.pop(); value.displayed_count--; value.omitted_count++; value.truncated = true; }
  }
  value.available = value.files.every(file => file.available);
  return value;
}

/** Only bytes actually supplied in the inline prompt or a bound evidence reply
 * count as observed original text. The model supplies no proof or internal ID. */
export function artifactChangeReadCoverage(value: unknown): ControlledArtifactChangeCoverageMap {
  if (!value || typeof value !== 'object' || !('files' in value) || !Array.isArray(value.files)) return {};
  const result: ControlledArtifactChangeCoverageMap = {};
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || file.available !== true || file.history_authenticated !== true ||
        !digest.test(file.before_sha256 ?? '') || !digest.test(file.current_sha256 ?? '') || !digest.test(file.evidence_sha256 ?? '') ||
        typeof file.original_text !== 'string' || !Number.isSafeInteger(file.original_start_char) || !Number.isSafeInteger(file.original_end_char) ||
        !Number.isSafeInteger(file.original_total_chars) || file.original_start_char < 0 || file.original_end_char < file.original_start_char ||
        file.original_end_char > file.original_total_chars || file.original_text.length !== file.original_end_char - file.original_start_char) continue;
    result[file.path] = { before_sha256: file.before_sha256, current_sha256: file.current_sha256,
      evidence_sha256: file.evidence_sha256, total: file.original_total_chars,
      ranges: [[file.original_start_char, file.original_end_char]] };
  }
  return result;
}

export function mergeArtifactChangeReadCoverage(previous: ControlledArtifactChangeCoverageMap,
  observed: ControlledArtifactChangeCoverageMap): ControlledArtifactChangeCoverageMap {
  const result = structuredClone(previous);
  for (const [path, read] of Object.entries(observed)) {
    const prior = result[path], same = prior && prior.before_sha256 === read.before_sha256 &&
      prior.current_sha256 === read.current_sha256 && prior.evidence_sha256 === read.evidence_sha256 && prior.total === read.total;
    const ranges = [...(same ? prior.ranges : []), ...read.ranges].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) { const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]); }
    result[path] = { ...read, ranges: merged };
  }
  return result;
}

export function completeArtifactChangeReads(coverage: ControlledArtifactChangeCoverageMap): ControlledArtifactChangeReads {
  return Object.fromEntries(Object.entries(coverage).flatMap(([path, read]) =>
    read.ranges.length === 1 && read.ranges[0]![0] === 0 && read.ranges[0]![1] === read.total
      ? [[path, { before_sha256: read.before_sha256, current_sha256: read.current_sha256, evidence_sha256: read.evidence_sha256 }]] : []));
}
