import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash, safePath } from './storage.js';

const templateHash = '143d7be4ea4d7e00fcc3067b7843939cdfe63e14d4dcf11411c99a52c8eb6a37';
const validatorHash = '052b08835e19d17fd06dc7450251926400dff960c0893ef9113cd07cf5e8b5e0';
export const cornellProjectHeadings = ['### Problem Description', '#### Constraints', '#### Function Contract',
  '### Cue Column (Questions, Keywords, or Prompts)', '### Notes Section (Main Notes)', '### Summary Section (Summary of Notes)'] as const;
/** Backend provenance, never a research tool argument or a model-selected template. */
export interface CornellFormatProfile {
  schema_version: 1; id: 'leetcode-cornell-v1';
  template: { path: string; sha256: string }; validator: { path: string; sha256: string };
}
/** A changed renderer cannot replay an older generation of the same research. */
export function cornellFormatRendererRevision(profile: CornellFormatProfile): number {
  if (profile.id !== 'leetcode-cornell-v1') throw new CornellFormatProfileError('Unsupported Cornell rendering profile.');
  return 2;
}
/** Format-owned heading levels only; supplied narrative and literal code stay untouched. */
export function cornellExplanationHeading(profile: CornellFormatProfile | undefined, heading: string): string {
  const strategy = profile && /^Strategy [A-Z](?:\b|:)/.test(heading) &&
    !/^Strategy [A-Z] (?:Flow|Worked Example Flow)$/.test(heading);
  return `${strategy ? '##' : '###'} ${heading}`;
}
export class CornellFormatProfileError extends Error {
  readonly code = 'CORNELL_FORMAT_PROFILE_UNSUPPORTED';
}
function approved(path: string): boolean {
  return /^\.(?:agents|github)\/skills\/[^/]+\/(?:assets|scripts)\/.+\.(?:md|py)$/.test(path) &&
    !/[\\:*?\x00-\x1f]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part));
}
function assetBytes(root: string, path: string): Buffer {
  if (!approved(path)) throw new CornellFormatProfileError('Cornell format profiles require declared ordinary skill asset/script inputs.');
  try {
    let current = resolve(root);
    for (const part of path.split('/')) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new CornellFormatProfileError('Cornell format assets cannot follow linked files or directories.');
    }
    const file = safePath(root, path), stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024)
      throw new CornellFormatProfileError('Cornell format assets must be bounded ordinary unlinked files.');
    return readFileSync(file);
  } catch (cause) {
    if (cause instanceof CornellFormatProfileError) throw cause;
    throw new CornellFormatProfileError('A declared Cornell format asset is missing or unreadable. Restore its exact approved source fingerprint; do not rewrite research or rebaseline the format.', { cause });
  }
}
export function assertCornellFormatProfile(root: string, value: unknown): asserts value is CornellFormatProfile {
  const profile = value as CornellFormatProfile | undefined;
  if (!profile || profile.schema_version !== 1 || profile.id !== 'leetcode-cornell-v1' ||
      Object.keys(profile).some(key => !['schema_version', 'id', 'template', 'validator'].includes(key)) ||
      profile.template?.sha256 !== templateHash || profile.validator?.sha256 !== validatorHash ||
      Object.keys(profile.template).some(key => !['path', 'sha256'].includes(key)) ||
      Object.keys(profile.validator).some(key => !['path', 'sha256'].includes(key)) ||
      typeof profile.template.path !== 'string' || typeof profile.validator.path !== 'string' ||
      profile.template.path === profile.validator.path || hash(assetBytes(root, profile.template.path)) !== templateHash ||
      hash(assetBytes(root, profile.validator.path)) !== validatorHash)
    throw new CornellFormatProfileError('The declared Cornell template/validator pair is unsupported or changed. Preserve the approved source fingerprints; do not rebaseline or guess a replacement format.');
}

/** Select only a reviewed exact content pair already declared and frozen by this task.
 * No task number, destination, repository path or criterion prose participates. */
export function resolveControlledCornellFormatProfile(root: string, contract: {
  plan: { input_paths?: readonly string[] }; preserved_hashes: Record<string, string>;
}): CornellFormatProfile | undefined {
  const inputs = [...new Set(contract.plan.input_paths ?? [])];
  const templates = inputs.filter(path => approved(path) && contract.preserved_hashes[path] === templateHash);
  const validators = inputs.filter(path => approved(path) && contract.preserved_hashes[path] === validatorHash);
  if (!templates.length && !validators.length) return undefined; // Unrelated/default research is unchanged.
  if (templates.length !== 1 || validators.length !== 1)
    throw new CornellFormatProfileError('A recognized Cornell format input requires exactly one complete approved template/validator fingerprint pair. Declare and preserve both inputs; do not guess the missing format.');
  const profile: CornellFormatProfile = { schema_version: 1, id: 'leetcode-cornell-v1',
    template: { path: templates[0]!, sha256: templateHash }, validator: { path: validators[0]!, sha256: validatorHash } };
  assertCornellFormatProfile(root, profile);
  return profile;
}

/** Select trusted template fragments before inserting any supplied prose or literal code. */
export function cornellFormatLayout(profile: CornellFormatProfile, date: string) {
  if (profile.id !== 'leetcode-cornell-v1') throw new CornellFormatProfileError('Unsupported Cornell rendering profile.');
  const [year, month, day] = date.split('-');
  return { date: `${day}/${month}/${year}`,
    context_heading: '## Context and Constraints\n\n### Problem Description',
    constraints_heading: '#### Constraints\n\n',
    cue_heading: '## Cue Column\n\n### Cue Column (Questions, Keywords, or Prompts)',
    notes_heading: '## Main Notes\n\n### Notes Section (Main Notes)',
    summary_heading: '## Summary\n\n### Summary Section (Summary of Notes)',
  };
}

export function cornellFormatProfileProblems(root: string, profile: unknown, body: string): string[] {
  try { assertCornellFormatProfile(root, profile); }
  catch { return ['Cornell format profile sources are unsupported, missing or changed.']; }
  const problems: string[] = [];
  if (!/^## Date: \d{2}\/\d{2}\/\d{4}$/m.test(body)) problems.push('Cornell format profile requires the exact DD/MM/YYYY Date heading.');
  for (const heading of cornellProjectHeadings)
    if (body.split(/\r?\n/).filter(line => line === heading).length !== 1) problems.push(`Cornell format profile requires exactly one ${heading}.`);
  return problems;
}
