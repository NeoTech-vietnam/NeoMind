import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, now, safePath } from './storage.js';
import { runCommand } from './command-runner.js';
import { controlledPythonExecutable } from './controlled-runtime-context.js';
import { assertCornellFormatProfile, cornellFormatRendererRevision } from './cornell-format-profile.js';
import { previewCornellArtifacts } from './notes.js';
import type { CompiledCornellResearch } from './cornell-workflow.js';
import { renderCornellClaimLabels } from './cornell-content.js';

export interface CornellCanonicalReceipt {
  schema_version: 1; renderer_revision: number; validator_sha256: string;
  input_hash: string; artifact_hashes: Record<string, string>; generation: string;
  validated_at: string; exit_code: 0;
}
export interface CornellCompilerFailure {
  generation: string; code: 'CORNELL_CANONICAL_INVALID' | 'CORNELL_VALIDATOR_UNAVAILABLE';
  owner: 'runtime' | 'content' | 'environment'; message: string;
  renderer_revision: number; validator_sha256: string; input_hash: string;
  artifact_hashes: Record<string, string>; diagnostics: string[];
}
export class CornellCanonicalError extends Error {
  constructor(readonly failure: CornellCompilerFailure) { super(failure.message); }
  get code() { return this.failure.code; }
}
/** Ownership evidence only, called after the authoritative validator has reported unbalanced fences. */
function hasUnclosedSourceFence(value: string): boolean {
  let opening: { marker: string; width: number } | undefined;
  for (const line of value.split(/\r?\n/)) {
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!opening) opening = { marker: marker[0]!, width: marker.length };
    else if (marker[0] === opening.marker && marker.length >= opening.width) opening = undefined;
  }
  return !!opening;
}
export function controlledCornellGeneration(root: string, compiled: CompiledCornellResearch) {
  const profile = compiled.note.format_profile;
  if (!profile) return undefined;
  assertCornellFormatProfile(root, profile);
  const contents = previewCornellArtifacts(root, compiled.note);
  if (!compiled.note.path || !Object.hasOwn(contents, compiled.note.path))
    throw new Error('The controlled Cornell rendering lacks its backend-bound primary artifact path.');
  const identity = { renderer_revision: cornellFormatRendererRevision(profile), validator_sha256: profile.validator.sha256,
    input_hash: compiled.input_hash, artifact_hashes: Object.fromEntries(Object.entries(contents).map(([path, body]) => [path, hash(body)])) };
  return { ...identity, generation: hash(JSON.stringify(identity)), contents };
}
/** The pinned validator is the authority. No Python rule implementation is duplicated here. */
export async function validateControlledCornell(root: string, compiled: CompiledCornellResearch,
  options: { signal?: AbortSignal; previous_failures?: readonly CornellCompilerFailure[];
    explanation_headings?: readonly string[]; semantic_input?: { topic?: string; explanations?: readonly { heading: string; body: string }[]; [key: string]: unknown } } = {}): Promise<CornellCanonicalReceipt | undefined> {
  const current = controlledCornellGeneration(root, compiled);
  if (!current) return undefined; // Generic research does not acquire a Python dependency.
  const { contents: _contents, ...identity } = current;
  const previous = options.previous_failures?.find(failure => failure.generation === current.generation && failure.owner === 'runtime');
  if (previous) throw new CornellCanonicalError(previous);
  const failure = (owner: CornellCompilerFailure['owner'], code: CornellCompilerFailure['code'], message: string, diagnostics: string[] = []) =>
    new CornellCanonicalError({ ...identity, owner, code, message, diagnostics });
  const python = controlledPythonExecutable();
  if (!python) throw failure('environment', 'CORNELL_VALIDATOR_UNAVAILABLE', 'The pinned Cornell validator requires an available Python interpreter on the enabled Bridge PATH. No generated files were written.');
  const folder = mkdtempSync(join(tmpdir(), 'neomind-cornell-validation-'));
  try {
    const validator = join(folder, 'validate.py'), note = join(folder, 'note.md');
    const validatorBytes = readFileSync(safePath(root, compiled.note.format_profile!.validator.path));
    if (hash(validatorBytes) !== current.validator_sha256) throw failure('runtime', 'CORNELL_CANONICAL_INVALID', 'The approved validator changed before execution. Preserve its frozen fingerprint; no generated files were written.');
    writeFileSync(validator, validatorBytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(note, current.contents[compiled.note.path!]!, { flag: 'wx', mode: 0o600 });
    const result = await runCommand({ command: [python, '-I', '-B', validator, note], cwd: folder,
      signal: options.signal, timeout_ms: 10000, max_output_bytes: 16000 });
    if (result.cancelled || result.timed_out || result.output_limited || result.error || result.exit_code === null)
      throw failure('environment', 'CORNELL_VALIDATOR_UNAVAILABLE', 'The pinned Cornell validation process did not complete successfully. No generated files were written; reconcile the environment before retrying.');
    if (result.exit_code !== 0) {
      // Only structured source fields can establish content ownership. Validator prose alone never assigns blame.
      const headings = new Set(options.semantic_input?.explanations?.map(item => item.heading) ?? options.explanation_headings ?? []);
      const missing = [...headings].flatMap(heading => {
        const letter = /^Strategy ([A-Z])(?:\b|:)/.exec(heading)?.[1];
        if (!letter || /^Strategy [A-Z] (?:Flow|Worked Example Flow)$/.test(heading)) return [];
        return [`Strategy ${letter} Flow`, `Strategy ${letter} Worked Example Flow`].filter(required => !headings.has(required));
      });
      const diagnostics = result.stdout.split(/\r?\n/).filter(line => /^  - /.test(line)).map(line => line.slice(4, 504)).slice(0, 24);
      // Attribute an actual validator finding to a professional field only when its exact supplied bytes survived rendering.
      // These checks do not decide validity: a successful canonical validator result above remains the only pass authority.
      const sourceFields: string[] = [];
      const renderedBody = current.contents[compiled.note.path!]!;
      if (diagnostics.includes('missing or invalid Topic heading') && options.semantic_input?.topic === compiled.note.topic)
        sourceFields.push('topic');
      for (const [index, explanation] of (options.semantic_input?.explanations ?? []).entries()) {
        if (!renderedBody.includes(explanation.body) && !renderedBody.includes(renderCornellClaimLabels(explanation.body))) continue;
        const flow = /^Strategy ([A-Z]) (Flow|Worked Example Flow)$/.exec(explanation.heading);
        if (flow) {
          const prefix = `Strategy ${flow[1]} ${flow[2] === 'Flow' ? 'flow' : 'worked-example flow'}`;
          if (diagnostics.some(diagnostic => diagnostic === `${prefix} must contain one Mermaid fence only` || diagnostic === `${prefix} lacks Mermaid classDef styling`))
            sourceFields.push(`explanations[${index}].body`);
        }
      }
      // The validator also scans literal Markdown inside fences. Preserve it, and attribute its observed rejection to its source field.
      const inspect = (value: unknown, path: string, depth = 0): void => {
        if (depth > 6) return;
        if (typeof value === 'string') {
          if (!renderedBody.includes(value) && !renderedBody.includes(renderCornellClaimLabels(value))) return;
          if (diagnostics.includes('raw HTML style block found; use Mermaid classDef') && /<style\b/i.test(value) ||
              diagnostics.includes('unbalanced Markdown code fences') && hasUnclosedSourceFence(value))
            sourceFields.push(path);
          if ([...value.matchAll(/^## Strategy ([A-Z])(?:\b|:)/gm)].some(match => diagnostics.some(diagnostic =>
              /^strategies missing (?:worked-example )?Mermaid flows: /.test(diagnostic) && diagnostic.split(': ')[1]?.split(', ').includes(match[1]!))))
            sourceFields.push(path);
          const orphan = /^Strategy ([A-Z]) (?:Flow|Worked Example Flow)$/.exec(value);
          if (orphan && diagnostics.some(diagnostic => /^(?:worked-example )?flows without matching strategies: /.test(diagnostic) &&
              diagnostic.split(': ')[1]?.split(', ').includes(orphan[1]!))) sourceFields.push(path);
        } else if (Array.isArray(value)) value.slice(0, 64).forEach((item, index) => inspect(item, `${path}[${index}]`, depth + 1));
        else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value).slice(0, 64))
          inspect(item, path ? `${path}.${key}` : key, depth + 1);
      };
      inspect(options.semantic_input, '');
      throw failure(missing.length || sourceFields.length ? 'content' : 'runtime', 'CORNELL_CANONICAL_INVALID', missing.length
        ? `The semantic explanations omit required flow sections: ${missing.join(', ')}. Correct those explanations; no generated files were written.`
        : sourceFields.length ? `The pinned validator rejected unchanged professional content in ${[...new Set(sourceFields)].join(', ')}. Findings: ${diagnostics.slice(0, 6).join('; ')}. Correct those fields; no generated files were written.`
        : 'The pinned validator rejected this exact compiler generation. Runtime must reconcile the source-to-render mapping before another unchanged model attempt; no generated files were written.', diagnostics);
    }
    return { schema_version: 1, ...identity, validated_at: now(), exit_code: 0 };
  } finally {
    // This exact directory was created above; no project-relative or worker-provided path is deleted.
    rmSync(folder, { recursive: true, force: true });
  }
}
/** Recheck the exact bytes after every await, before the synchronous durable writer. */
export function assertControlledCornellValidationCurrent(root: string, compiled: CompiledCornellResearch, proof?: CornellCanonicalReceipt) {
  const current = controlledCornellGeneration(root, compiled);
  if (current ? !proof || proof.generation !== current.generation || proof.exit_code !== 0 : !!proof)
    throw new Error('The Cornell rendering changed after canonical validation; current artifacts are preserved.');
}
