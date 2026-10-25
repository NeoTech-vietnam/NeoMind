import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { z } from 'zod';
import { cornellResearchSchema, type CompiledCornellResearch } from './cornell-workflow.js';
import { validateCornellNote, type CornellSource } from './notes.js';
import { atomicWrite, hash, loadRecords, now, safePath, withOperationLock } from './storage.js';
import type { ProjectRecord } from './types.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';

// Public modules can reach this helper through the engineering/controller graph
// while Cornell's module is still initializing. Resolve its authoritative schema
// only when an actual caller parses or advertises the worker tool.
const semanticSource = z.lazy(() => cornellResearchSchema.shape.sources.element.omit({ record_id: true, sha256: true, retrieved_at: true })
  .extend({ uri: z.string().min(1).max(2000).describe('A readable project file, HTTPS reference, or exact record: URI supplied by the runtime. Backend resolves provenance; do not invent record IDs, hashes or retrieval times.') }).strict());
export const controlledCornellSourceSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { record_id: _record, sha256: _hash, retrieved_at: _time, ...semantic } = value as Record<string, unknown>;
  return semantic;
}, semanticSource);
const semanticPractice = z.lazy(() => {
  const [runnable, manual] = cornellResearchSchema.shape.practice.options;
  const starter = runnable.shape.starter.describe('Optional learner starter content requests a backend-owned practice-solution.md inside the fixed Cornell directory. Do not supply a filesystem path.');
  return z.union([runnable.omit({ solution_path: true }).extend({ starter }), manual.omit({ solution_path: true }).extend({ starter })]);
});
function semanticPracticeInput(value: unknown, allowStarter: boolean): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { solution_path: _untrustedPath, ...semantic } = value as Record<string, unknown>;
  if (allowStarter) return semantic;
  const { starter: _unplannedStarter, ...practice } = semantic;
  return practice;
}
export const controlledCornellPracticeSchema = z.preprocess(value => semanticPracticeInput(value, true), semanticPractice);
const controlledPracticeWithoutStarter = z.preprocess(value => semanticPracticeInput(value, false), z.lazy(() => {
  const [runnable, manual] = cornellResearchSchema.shape.practice.options;
  return z.union([runnable.omit({ solution_path: true, starter: true }), manual.omit({ solution_path: true, starter: true })]);
}));
const semanticWorkedExample = z.lazy(() => cornellResearchSchema.shape.worked_example.omit({ evidence_ids: true })
  .extend({ observed: cornellResearchSchema.shape.worked_example.shape.observed.describe('Omit this field until the runtime has current passing independent check evidence. Before execution, provide expected only; do not put "not executed" or a predicted result in observed. Backend supplies evidence identities privately.') }));
function semanticWorkedInput(value: unknown, allowObserved: boolean): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { evidence_ids: _untrustedEvidence, ...semantic } = value as Record<string, unknown>;
  if (allowObserved) return semantic;
  const { observed: _deferredObservation, ...expected } = semantic;
  return expected;
}
const controlledWorkedExample = z.preprocess(value => semanticWorkedInput(value, true), semanticWorkedExample);
const controlledExpectedWorkedExample = z.preprocess(value => semanticWorkedInput(value, false),
  z.lazy(() => cornellResearchSchema.shape.worked_example.omit({ evidence_ids: true, observed: true })));
// The SDK must receive an actual root object to advertise its fields; resolve
// this factory only at server creation, after the module graph has initialized.
export function controlledCornellResearchSchema(allowObserved = true, allowStarter = true) {
  return cornellResearchSchema.omit({ schema_version: true, requirement_id: true, expected_requirement_revision: true,
    workflow_id: true, task_id: true, owner: true, output_dir: true })
    .extend({ schema_version: z.preprocess(() => 1, z.literal(1).default(1))
      .describe('Backend-owned format version; omit this field and the runtime supplies version 1.'),
      sources: z.array(controlledCornellSourceSchema).min(1).max(64), practice: allowStarter ? controlledCornellPracticeSchema : controlledPracticeWithoutStarter,
      methods: cornellResearchSchema.shape.methods.describe(`${cornellResearchSchema.shape.methods.description} The compiled research narrative must include inline [S1], [S2], etc. citations referring to the source IDs declared in sources. These are source labels, not runtime record identities.`),
      worked_example: allowObserved ? controlledWorkedExample : controlledExpectedWorkedExample });
}

/** Starter content requests the worksheet; no model-provided path ever reaches the writer. */
export function bindControlledCornellPractice(input: unknown, directory: string, allowStarter = true) {
  const practice = controlledCornellPracticeSchema.parse(semanticPracticeInput(input, allowStarter));
  return { ...practice, ...(practice.starter !== undefined ? { solution_path: `${directory}/practice-solution.md` } : {}) };
}

/** Observation content remains professional input; evidence identity is exclusively backend-owned. */
export function bindControlledCornellDemonstration(input: unknown, evidenceIds: readonly string[], allowObserved = true) {
  const worked = controlledWorkedExample.parse(semanticWorkedInput(input, allowObserved));
  const boundEvidence = allowObserved ? [...evidenceIds] : [];
  if (worked.observed && !boundEvidence.length)
    throw new Error('No current passing independent check is available for an observed demonstration. Omit worked_example.observed and provide expected only until verification runs. The backend supplies evidence identities; never invent or request record IDs.');
  return { ...worked, evidence_ids: boundEvidence };
}

export interface ControlledCornellSourceContext {
  workflow_id: string; epoch_id: string; task_id: string; requirement_ids: readonly string[];
  evidence: readonly { evidence_id: string; log_path: string }[];
  saved_results?: readonly ControlledCornellResult[];
  file_allowed(path: string): boolean;
}
export interface ControlledCornellResult {
  note_id: string; input_hash: string; compiled_note_hash: string;
  record_fingerprint: string; artifact_hashes: Record<string, string>;
}
export function controlledCornellResult(compiled: CompiledCornellResearch, note: ProjectRecord): ControlledCornellResult {
  return { note_id: note.meta.id, input_hash: compiled.input_hash, compiled_note_hash: hash(JSON.stringify(compiled.note)),
    record_fingerprint: evidenceRecordFingerprint(note), artifact_hashes: structuredClone(note.meta.data.artifact_hashes as Record<string, string>) };
}
function regularSource(root: string, path: string): Buffer {
  if (path !== posix.normalize(path) || path === '.' || path.startsWith('/') || path.startsWith('../') || /[\\:*?\x00-\x1f]/.test(path) ||
      path.split('/').some(part => !part || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error('Source files require canonical project-relative paths.');
  let current = resolve(root);
  for (const component of path.split('/')) {
    current = resolve(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Source provenance cannot follow linked files or directories.');
  }
  const file = safePath(root, path), info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024)
    throw new Error('Source provenance requires a bounded ordinary unlinked file.');
  return readFileSync(file);
}
function observedAt(root: string, context: ControlledCornellSourceContext, descriptors: unknown): string {
  const digest = hash(JSON.stringify({ workflow_id: context.workflow_id, epoch_id: context.epoch_id, descriptors }));
  const path = safePath(root, `.neomind/controlled/source-observations/${digest}.json`);
  return withOperationLock(root, `cornell-source-${digest.slice(0, 32)}`, () => {
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value.schema_version !== 1 || value.observation_hash !== digest ||
          typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at)))
        throw new Error('Saved source observation metadata requires runtime reconciliation.');
      return value.observed_at as string;
    }
    const timestamp = now();
    atomicWrite(path, JSON.stringify({ schema_version: 1, observation_hash: digest, observed_at: timestamp }) + '\n');
    return timestamp;
  });
}
/** Model citations select content. All record bindings, byte hashes and observation times are backend-owned. */
export function normalizeControlledCornellSources(root: string, input: unknown, context: ControlledCornellSourceContext) {
  const semantic = z.array(controlledCornellSourceSchema).min(1).max(64).parse(input);
  const used = new Set(semantic.map(source => source.id));
  if (used.size !== semantic.length) throw new Error('Research source citation IDs must be unique.');
  const records = new Map(loadRecords(root).map(record => [record.meta.id, record]));
  const allowed = new Set([...context.requirement_ids, ...context.evidence.map(item => item.evidence_id)]);
  const evidence = new Map(context.evidence.map(item => [item.evidence_id, item]));
  const recordAt = (id: string): ProjectRecord => {
    if (id === context.workflow_id || id === context.task_id)
      throw new Error('Cite an immutable requirement or current execution evidence instead of mutable workflow/task lifecycle records.');
    const record = records.get(id);
    if (!record || !allowed.has(id) || record.meta.status === 'superseded')
      throw new Error('The source record is not a current record supplied by this workflow.');
    if (evidence.has(id) && (record.meta.type !== 'evidence' || record.meta.data.workflow_id !== context.workflow_id ||
        record.meta.data.task_id !== context.task_id || record.meta.data.result !== 'pass' ||
        record.meta.data.log_path !== evidence.get(id)!.log_path))
      throw new Error('The source evidence does not match this workflow and execution task.');
    return record;
  };
  const localFiles: string[] = [], unfetched: string[] = [], fingerprints: unknown[] = [];
  const sources: Omit<CornellSource, 'retrieved_at'>[] = semantic.map(source => {
    const currentEvidence = context.evidence.find(item => item.log_path === source.uri);
    const recordId = currentEvidence?.evidence_id ?? (source.uri.startsWith('record:') ? source.uri.slice('record:'.length) : undefined);
    if (recordId !== undefined) {
      const record = recordAt(recordId);
      fingerprints.push({ id: source.id, record_id: recordId, fingerprint: hash(JSON.stringify(record)) });
      return { ...source, uri: `record:${recordId}`, record_id: recordId };
    }
    if (/^https?:\/\//i.test(source.uri)) {
      const url = new URL(source.uri);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('External citations require HTTPS without embedded credentials.');
      unfetched.push(source.id);
      const limitation = 'Runtime recorded this reference; URL content was not fetched or verified.';
      const budget = 1000 - limitation.length - 2;
      const suppliedLocator = source.locator && source.locator.length > budget ? `${source.locator.slice(0, budget - 1)}…` : source.locator;
      return { ...source, uri: url.href, locator: suppliedLocator ? `${suppliedLocator}; ${limitation}` : limitation };
    }
    if (!context.file_allowed(source.uri)) throw new Error('The source is private, foreign or outside this session\'s approved readable files.');
    const digest = hash(regularSource(root, source.uri));
    localFiles.push(source.uri); fingerprints.push({ id: source.id, uri: source.uri, sha256: digest });
    return { ...source, sha256: digest }; // A file URI can never acquire an unrelated record binding.
  });
  for (const item of context.evidence) if (sources.length < 64 && !sources.some(source => source.record_id === item.evidence_id)) {
    const record = recordAt(item.evidence_id);
    let number = 1; while (used.has(`S${number}`)) number++;
    const id = `S${number}`; used.add(id);
    sources.push({ id, title: `Current passing verification: ${record.meta.title}`, uri: `record:${item.evidence_id}`,
      record_id: item.evidence_id, locator: 'Backend-added current positive execution evidence.' });
    fingerprints.push({ id, record_id: item.evidence_id, fingerprint: hash(JSON.stringify(record)) });
  }
  const timestamp = observedAt(root, context, { sources, fingerprints });
  return { sources: sources.map(source => ({ ...source, retrieved_at: timestamp })),
    approved_source_files: [...new Set(localFiles)], unfetched_sources: unfetched };
}

/** Reconcile a fully persisted same-input note only; partial/conflicting artifacts remain untouched. */
export function existingControlledCornellNote(root: string, compiled: CompiledCornellResearch, context: ControlledCornellSourceContext) {
  const saved = context.saved_results?.find(result => result.input_hash === compiled.input_hash && result.compiled_note_hash === hash(JSON.stringify(compiled.note)));
  if (!saved) return undefined; // A copied input_hash on an arbitrary note is never a backend completion receipt.
  const ids = compiled.note.demonstration.evidence_ids ?? [];
  if (context.evidence.length) {
    if (!ids.length || context.evidence.some(item => !ids.includes(item.evidence_id))) return undefined;
  } else if (ids.length || compiled.note.demonstration.observed) return undefined;
  // Before the Verifier, an exact saved expected-only bundle is replayable;
  // it still must satisfy every record fingerprint and artifact check below.
  const records = new Map(loadRecords(root).map(record => [record.meta.id, record]));
  if (ids.some(id => {
    const record = records.get(id);
    return record?.meta.type !== 'evidence' || record.meta.data.workflow_id !== context.workflow_id || record.meta.data.task_id !== context.task_id;
  })) return undefined;
  const candidates = [...records.values()].filter(record => {
    const data = record.meta.data, research = data.research as { input_hash?: string } | undefined,
      practice = data.practice as { exercise_path?: string; answer_path?: string } | undefined;
    return record.meta.id === saved.note_id && evidenceRecordFingerprint(record) === saved.record_fingerprint &&
      data.artifact_hashes && typeof data.artifact_hashes === 'object' &&
      Object.keys(data.artifact_hashes).length === Object.keys(saved.artifact_hashes).length &&
      Object.entries(saved.artifact_hashes).every(([path, digest]) => (data.artifact_hashes as Record<string, string>)[path] === digest) &&
      record.meta.type === 'knowledge' && data.format === 'cornell-v1' && data.workflow_id === context.workflow_id &&
      research?.input_hash === compiled.input_hash && data.artifact_path === compiled.note.path &&
      practice?.exercise_path === compiled.note.practice.exercise_path && practice?.answer_path === compiled.note.practice.answer_path &&
      (compiled.note.requirement_ids ?? []).every(id => record.meta.links.some(link => link.type === 'documents' && link.target === id)) &&
      ids.every(id => record.meta.links.some(link => link.type === 'references' && link.target === id));
  });
  if (candidates.length > 1) throw new Error('Multiple same-input Cornell records require runtime reconciliation.');
  const candidate = candidates[0];
  return candidate && validateCornellNote(root, candidate.meta.id).ok ? candidate : undefined;
}
