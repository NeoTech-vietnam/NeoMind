import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { hasCurrentReview, recordFingerprint } from './engineering.js';
import { normalizeCornellOwnership, prepareRecipe, type RecipeInput } from './recipes.js';
import { validateCornellNote, type CornellInput } from './notes.js';
import { atomicWrite, getRecord, hash, loadRecords, now, readConfig, safePath, withOperationLock } from './storage.js';
import type { ProjectRecord } from './types.js';
import { hasUnfinishedCornellProse } from './cornell-content.js';

const prose = z.string().trim().min(8).max(32_000).refine(value => !hasUnfinishedCornellProse(value), 'Complete substantive prose is required.')
  .describe('Complete substantive prose. Discussion of TODO or placeholder validation is allowed; unfinished markers, filler and unexpanded template tokens are not.');
const objective = z.object({ id: z.string().regex(/^O[1-9][0-9]*$/), text: prose }).strict();
const question = (prefix: string) => z.object({ id: z.string().regex(new RegExp(`^${prefix}[1-9][0-9]*$`)), prompt: prose,
  objective_ids: z.array(z.string().regex(/^O[1-9][0-9]*$/)).min(1).max(32), answer: prose }).strict();
const practiceCommand = z.array(z.string().min(1)).min(1).max(64)
  .describe('Runnable argument vector, documented but never executed by the research compiler. May accompany descriptive procedure steps.');
const practiceProcedure = z.array(prose).min(1).max(32)
  .describe('Complete human-readable practice steps. May accompany a runnable command or define manual practice on their own.');
const practiceBase = z.object({ questions: z.array(question('P')).min(1).max(40),
  solution_path: z.string().optional(), starter: z.string().max(64_000).optional() });
// An explicit union preserves the at-least-one requirement in advertised JSON
// Schema as well as runtime validation. Both fields are useful learner content.
const practice = z.union([
  practiceBase.extend({ command: practiceCommand, procedure: practiceProcedure.optional() }).strict(),
  practiceBase.extend({ command: practiceCommand.optional(), procedure: practiceProcedure }).strict(),
]).describe('Provide a runnable command, descriptive procedure steps, or both. At least one is required; all supplied steps are preserved.');
const source = z.object({ id: z.string().regex(/^S[1-9][0-9]*$/), title: prose, uri: z.string().min(1).max(2_000),
  retrieved_at: z.string().datetime({ offset: true }), locator: z.string().max(1_000).optional(), record_id: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const cornellResearchSchema = z.object({
  schema_version: z.literal(1), requirement_id: z.string().min(1), expected_requirement_revision: z.number().int().positive(),
  workflow_id: z.string().optional(), task_id: z.string().optional(), owner: z.string().optional(),
  topic: prose, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), output_dir: z.string().min(1),
  context: prose, constraints: z.array(prose).min(1).max(32), abstract: prose,
  learning_objectives: z.array(objective).min(1).max(32), methods: prose,
  explanations: z.array(z.object({ heading: prose, body: prose }).strict()).min(1).max(32),
  results: prose, discussion: prose, questions: z.array(question('Q')).min(1).max(40),
  worked_example: z.object({ body: prose, expected: prose, command: z.array(z.string().min(1)).min(1).max(64).optional(),
    observed: prose.optional(), evidence_ids: z.array(z.string()).max(32).optional() }).strict(),
  practice,
  sources: z.array(source).min(1).max(64), failure_cases: z.array(prose).min(1).max(32), summary: prose,
}).strict();
export type CornellResearchInput = z.infer<typeof cornellResearchSchema>;
export interface CompiledCornellResearch { input_hash: string; note: CornellInput; recipe_input: RecipeInput }
export interface PreparedCornellResearch extends CompiledCornellResearch {
  status: 'prepared' | 'reused'; recipe_instance: ProjectRecord; existing_note_id?: string;
}

export function cornellCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(cornellCanonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${cornellCanonical(item)}`).join(',')}}`;
}
function visiblePath(root: string, value: string): string {
  if (!value || value.includes('\\') || isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')))
    throw new Error('Cornell paths must be canonical visible relative paths.');
  if (relative(resolve(root), safePath(root, value)).replaceAll('\\', '/') !== value) throw new Error('Cornell path is not canonical.');
  return value;
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} IDs must be distinct.`);
}

/** Compile supplied research, never synthesize facts or execute its commands. */
export function compileCornellResearch(root: string, value: CornellResearchInput): CompiledCornellResearch {
  if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new Error('Research input exceeds 512 KiB.');
  const input = cornellResearchSchema.parse(value);
  const requirement = getRecord(root, input.requirement_id);
  if (requirement.meta.type !== 'requirement' || requirement.meta.revision !== input.expected_requirement_revision)
    throw new Error('Research requires the exact current requirement revision.');
  if (new Date(input.date).toISOString().slice(0, 10) !== input.date) throw new Error('Research date must be a valid explicit calendar date.');
  visiblePath(root, input.output_dir);
  if (input.practice.solution_path) visiblePath(root, input.practice.solution_path);
  unique(input.learning_objectives.map(item => item.id), 'Objective');
  unique(input.questions.map(item => item.id), 'Question'); unique(input.practice.questions.map(item => item.id), 'Practice');
  unique(input.sources.map(item => item.id), 'Source');
  const objectives = new Set(input.learning_objectives.map(item => item.id));
  const assessed = new Set<string>();
  for (const item of [...input.questions, ...input.practice.questions]) {
    unique(item.objective_ids, `${item.id} objective`);
    for (const id of item.objective_ids) {
      if (!objectives.has(id)) throw new Error(`${item.id} references unknown objective ${id}.`);
      assessed.add(id);
    }
  }
  if ([...objectives].some(id => !assessed.has(id))) throw new Error('Every learning objective needs a mapped question or exercise.');
  const sourceIds = new Set(input.sources.map(item => item.id));
  for (const match of JSON.stringify(input).matchAll(/\[(S[1-9][0-9]*)\]/g))
    if (!sourceIds.has(match[1]!)) throw new Error(`Unknown source citation [${match[1]}].`);
  for (const item of input.sources) {
    if (!item.record_id && !/^https:\/\//.test(item.uri)) {
      visiblePath(root, item.uri);
      const digest = hash(readFileSync(safePath(root, item.uri)));
      if (item.sha256 && item.sha256 !== digest) throw new Error('Research source hash changed.');
      item.sha256 = digest;
    } else if (item.record_id) {
      const sourceRecord = getRecord(root, item.record_id);
      if (sourceRecord.meta.status === 'superseded') throw new Error('Superseded records are historical context, not current research sources.');
    }
  }
  const fingerprint = recordFingerprint(requirement);
  const inputHash = hash(cornellCanonical({ input, requirement_fingerprint: fingerprint }));
  const questions = (items: CornellResearchInput['questions']) => items.map(item => `### ${item.id}: ${item.prompt}\n\nObjectives: ${item.objective_ids.join(', ')}\n`).join('\n');
  const answers = [...input.questions, ...input.practice.questions].map(item => `## ${item.id}\n\n${item.answer}\n`).join('\n');
  const compiled: CornellInput = {
    topic: input.topic, kind: 'research-note', date: input.date, owner: input.owner ?? 'curator',
    path: `${input.output_dir}/note.md`, workflow_id: input.workflow_id,
    requirement_ids: [requirement.meta.id], context: input.context, constraints: input.constraints,
    cues: input.questions.map(item => `${item.id} (${item.objective_ids.join(', ')}): ${item.prompt}`),
    main_notes: `### Methods\n\n${input.methods}\n\n${input.explanations.map(item => `### ${item.heading}\n\n${item.body}`).join('\n\n')}\n\n### Results\n\n${input.results}\n\n### Discussion\n\n${input.discussion}\n\n### Research Questions\n\n${questions(input.questions)}`,
    demonstration: input.worked_example, sources: input.sources, failure_cases: input.failure_cases, summary: input.summary,
    practice: { exercise_path: `${input.output_dir}/exercises.md`, answer_path: `${input.output_dir}/answers.md`,
      exercise: `# Research and practice questions\n\nAnswer the research questions before consulting the separate answer file. Explain the assumptions and reasoning in your own words.\n\n${questions(input.questions)}\n## Practice\n\n${questions(input.practice.questions)}` +
        (input.practice.command && input.practice.procedure ? `\n### Practice steps\n\n${input.practice.procedure.map((step, index) => `${index + 1}. ${step}`).join('\n\n')}\n` : ''),
      answer: `# Answers and reasoning\n\nThese supplied reference answers support comparison; completing the learner's exercises is not claimed.\n\n${answers}`,
      ...(input.practice.command ? { command: input.practice.command } : { mode: 'manual', procedure: input.practice.procedure }),
      ...(input.practice.solution_path ? { solution_path: input.practice.solution_path, starter: input.practice.starter } : {}) },
    research: { schema_version: 1, input_hash: inputHash, requirement_id: requirement.meta.id,
      requirement_revision: requirement.meta.revision, requirement_fingerprint: fingerprint,
      abstract: input.abstract, learning_objectives: input.learning_objectives },
  };
  const ownership = normalizeCornellOwnership(root, compiled, { workflow_id: input.workflow_id, task_id: input.task_id, requirement_ids: [requirement.meta.id] });
  if (!ownership.workflow_id) throw new Error('Research preparation requires an existing explicitly bound manager workflow.');
  const note = ownership.note;
  const recipe_input: RecipeInput = { recipe_id: 'cornell-evidence-note', parameters: { note }, requirement_ids: [requirement.meta.id],
    workflow_id: ownership.workflow_id, ...(input.task_id ? { task_id: input.task_id } : {}), ...(input.owner ? { owner: input.owner } : {}) };
  return { input_hash: inputHash, note, recipe_input };
}

export function prepareCornellResearch(root: string, input: CornellResearchInput): PreparedCornellResearch {
  const compiled = compileCornellResearch(root, input);
  const recipe_instance = prepareRecipe(root, compiled.recipe_input);
  const noteId = recipe_instance.meta.data.note_id;
  if (typeof noteId === 'string') {
    if (!validateCornellNote(root, noteId).ok) throw new Error('Existing research note is stale; use the reviewed revision workflow.');
    return { ...compiled, status: 'reused', recipe_instance, existing_note_id: noteId };
  }
  return { ...compiled, status: 'prepared', recipe_instance };
}

export interface CornellDestination { schema_version: 1; directory: string; notes_root?: string }
const destinationSchema = z.object({ schema_version: z.literal(1), directory: z.string().min(1), notes_root: z.string().optional() }).strict();
const destinationPath = '.neomind/cornell.json';
export function readCornellDestination(root: string): CornellDestination {
  readConfig(root);
  const path = safePath(root, destinationPath);
  const destination = existsSync(path) ? destinationSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : { schema_version: 1 as const, directory: '00_note/NeoMind' };
  const base = destination.notes_root ?? root;
  if (destination.notes_root && (!isAbsolute(base) || !lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()))
    throw new Error('Notes root must remain an explicit existing local directory without a link.');
  visiblePath(base, destination.directory);
  return destination;
}
export function configureCornellDestination(root: string, input: { directory?: string; notes_root?: string }): CornellDestination {
  const supplied = z.object({ directory: z.string().optional(), notes_root: z.string().optional() }).strict().parse(input);
  const current = readCornellDestination(root);
  const destination: CornellDestination = { ...current, ...supplied };
  if (destination.notes_root) {
    if (!isAbsolute(destination.notes_root) || !lstatSync(destination.notes_root).isDirectory() || lstatSync(destination.notes_root).isSymbolicLink())
      throw new Error('Notes root must be an explicit existing local directory without a link.');
    destination.notes_root = realpathSync.native(destination.notes_root);
  }
  visiblePath(destination.notes_root ?? root, destination.directory);
  atomicWrite(safePath(root, destinationPath), JSON.stringify(destination, null, 2) + '\n');
  return destination;
}

export interface CornellExportFile { path: string; sha256: string; bytes: number; content_base64: string; source_path?: string; source_sha256?: string }
export interface CornellExportInput { note_id: string; expected_revision: number; include_paths?: string[] }
export interface CornellExportPlan {
  schema_version: 1; status: 'ready' | 'blocked'; problems: string[]; plan_hash: string;
  input: CornellExportInput; project_id: string; note_fingerprint: string; workflow_id: string;
  requirements: { id: string; revision: number; fingerprint: string }[];
  reviews_hash: string; destination: CornellDestination; notes_root: string; bundle_directory: string;
  files: CornellExportFile[];
}
export interface CornellExportReceipt { schema_version: 1; plan_hash: string; note_id: string; status: 'writing' | 'completed'; files: { path: string; sha256: string }[]; completed_at?: string }
const digest = /^[a-f0-9]{64}$/;
const planPath = (id: string) => `.neomind/cornell-exports/plans/${id}.json`;
const receiptPath = (id: string) => `.neomind/cornell-exports/receipts/${id}.json`;
const portable = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
function regular(root: string, path: string): Buffer {
  const target = safePath(root, visiblePath(root, path));
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Export requires bounded regular files without links.');
  noLinks(root, path);
  return readFileSync(target);
}
function noLinks(root: string, path: string): string {
  let current = resolve(root);
  for (const part of path.split('/')) {
    current = resolve(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Notes paths cannot follow links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}
function buildExport(root: string, input: CornellExportInput): CornellExportPlan {
  const request = z.object({ note_id: z.string().min(1), expected_revision: z.number().int().positive(), include_paths: z.array(z.string()).max(64).optional() }).strict().parse(input);
  const config = readConfig(root), note = getRecord(root, request.note_id);
  if (note.meta.type !== 'knowledge' || note.meta.data.format !== 'cornell-v1' || note.meta.status === 'superseded' || note.meta.revision !== request.expected_revision)
    throw new Error('Export requires the current Cornell note revision.');
  const workflowId = note.meta.data.workflow_id;
  if (typeof workflowId !== 'string' || getRecord(root, workflowId).meta.data.kind !== 'manager-workflow') throw new Error('Export requires an existing note workflow.');
  const requirements = note.meta.links.filter(link => link.type === 'documents').map(link => getRecord(root, link.target)).filter(record => record.meta.type === 'requirement');
  if (!requirements.length || requirements.some(record => (record.meta.data.workflow_id ?? record.meta.data.intake_workflow_id) !== workflowId))
    throw new Error('Export requires same-workflow requirement bindings.');
  const problems = validateCornellNote(root, note.meta.id).problems;
  if (!hasCurrentReview(root, note.meta.id)) problems.push('A current independent note review is required. Review this exact validated note before applying its export.');
  const research = note.meta.data.research as CornellInput['research'];
  if (research && (!requirements.some(record => record.meta.id === research.requirement_id && recordFingerprint(record) === research.requirement_fingerprint)))
    problems.push('Research requirement fingerprint changed.');
  const destination = readCornellDestination(root), notesRoot = realpathSync.native(destination.notes_root ?? root);
  visiblePath(notesRoot, destination.directory); noLinks(notesRoot, destination.directory);
  const reviews = loadRecords(root).filter(record => record.meta.type === 'review' && record.meta.links.some(link => link.type === 'reviews' && link.target === note.meta.id))
    .map(record => ({ id: record.meta.id, revision: record.meta.revision, fingerprint: recordFingerprint(record) })).sort((a, b) => a.id.localeCompare(b.id));
  const sourcePaths = [...new Set([...Object.keys(note.meta.data.artifact_hashes as Record<string, string>), ...(request.include_paths ?? [])])].sort();
  if (sourcePaths.length > 100) throw new Error('Export supports at most 100 files.');
  const contents = sourcePaths.map(path => {
    if (/(?:^|\/)(?:secrets?|credentials?|.*\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(path)) throw new Error('Sensitive paths cannot be exported.');
    const content = regular(root, path);
    return { path, content, source_hash: hash(content) };
  });
  const practice = note.meta.data.practice as { solution_path?: string };
  const sourceIdentity = { note_id: note.meta.id, revision: note.meta.revision, fingerprint: recordFingerprint(note),
    requirements: requirements.map(record => ({ id: record.meta.id, revision: record.meta.revision, fingerprint: recordFingerprint(record) })),
    reviews_hash: hash(cornellCanonical(reviews)), files: contents.map(item => [item.path, item.source_hash]), destination };
  const bundle = `${destination.directory}/${portable(config.project_id)}/${portable(requirements[0]!.meta.id)}/${portable(note.meta.id)}/r${note.meta.revision}-${hash(cornellCanonical(sourceIdentity)).slice(0, 16)}`;
  const files: CornellExportFile[] = contents.map(item => {
    let content = item.content;
    if (item.path === note.meta.data.artifact_path && practice?.solution_path && !sourcePaths.includes(practice.solution_path)) {
      const link = relative(dirname(safePath(root, item.path)), safePath(root, practice.solution_path)).replaceAll('\\', '/');
      content = Buffer.from(content.toString('utf8').replace(` · [Your solution](${link})`, ' · Your authored solution remains in the source workspace.'));
    }
    return { path: `${bundle}/${item.path}`, sha256: hash(content), bytes: content.length, content_base64: content.toString('base64'), source_path: item.path, source_sha256: item.source_hash };
  });
  function add(path: string, body: string): void { const content = Buffer.from(body); files.push({ path: `${bundle}/${path}`, sha256: hash(content), bytes: content.length, content_base64: content.toString('base64') }); }
  add('README.md', `# ${note.meta.title}\n\n[Read the note](${note.meta.data.artifact_path})\n\nThis immutable local copy contains the reviewed note and its generated exercises and answers. Authored solutions stay in the source workspace unless explicitly included. Commands describe the originating project; copying files does not establish execution in this notes repository.\n`);
  const { destination: _localDestination, ...portableIdentity } = sourceIdentity;
  add('provenance.json', JSON.stringify({ schema_version: 1, project_id: config.project_id, ...portableIdentity,
    assurance: 'source-note-review; local copy does not add execution or acceptance evidence' }, null, 2) + '\n');
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length)
    throw new Error('Export paths collide with a generated bundle file or another attachment. Choose distinct filenames.');
  if (files.reduce((sum, file) => sum + file.bytes, 0) > 8 * 1024 * 1024) throw new Error('Export bundle exceeds 8 MiB.');
  // Keep existing relative links. Missing dependencies must be explicitly included.
  const exported = new Set(files.map(file => file.path));
  for (const file of files.filter(file => file.path.endsWith('.md'))) {
    for (const match of Buffer.from(file.content_base64, 'base64').toString('utf8').matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const uri = match[1]!.replace(/^<|>$/g, '').split('#')[0]!;
      if (!uri || /^https:\/\//.test(uri)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) { problems.push('An exported link uses an unsupported scheme.'); continue; }
      const resolved = relative(notesRoot, resolve(notesRoot, dirname(file.path), decodeURIComponent(uri))).replaceAll('\\', '/');
      if (!exported.has(resolved)) problems.push(`Export link requires an explicitly included file: ${uri}`);
    }
  }
  const base = { schema_version: 1 as const, status: problems.length ? 'blocked' as const : 'ready' as const,
    problems: [...new Set(problems)], input: request, project_id: config.project_id, note_fingerprint: sourceIdentity.fingerprint,
    workflow_id: workflowId, requirements: sourceIdentity.requirements, reviews_hash: sourceIdentity.reviews_hash,
    destination, notes_root: notesRoot, bundle_directory: bundle, files };
  return { ...base, plan_hash: hash(cornellCanonical(base)) };
}

/** Prepare exact bytes and provenance locally; target notes remain untouched. */
export function prepareCornellExport(root: string, input: CornellExportInput): CornellExportPlan {
  const plan = buildExport(root, input);
  if (plan.status === 'ready') atomicWrite(safePath(root, planPath(plan.plan_hash)), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}
export function readCornellExportPlan(root: string, planHash: string): CornellExportPlan {
  if (!digest.test(planHash)) throw new Error('Export plan hash must be SHA-256.');
  const data = readFileSync(safePath(root, planPath(planHash)), 'utf8');
  if (Buffer.byteLength(data) > 12 * 1024 * 1024) throw new Error('Export plan is too large.');
  const plan = JSON.parse(data) as CornellExportPlan;
  const { plan_hash, ...base } = plan;
  if (plan_hash !== planHash || hash(cornellCanonical(base)) !== planHash || plan.status !== 'ready') throw new Error('Export plan is invalid or changed.');
  return plan;
}
function currentPlan(root: string, planHash: string): CornellExportPlan {
  const plan = readCornellExportPlan(root, planHash), current = buildExport(root, plan.input);
  if (current.status !== 'ready' || current.plan_hash !== planHash) throw new Error('Export source, requirement, review or destination changed; prepare a fresh preview.');
  return plan;
}
export function applyCornellExport(root: string, input: { plan_hash: string }): CornellExportReceipt {
  const request = z.object({ plan_hash: z.string().regex(digest) }).strict().parse(input);
  return withOperationLock(root, `cornell-export-${request.plan_hash.slice(0, 40)}`, () => {
    const plan = currentPlan(root, request.plan_hash), statePath = safePath(root, receiptPath(plan.plan_hash));
    const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as CornellExportReceipt : null;
    const bundle = noLinks(plan.notes_root, plan.bundle_directory);
    if (!previous && existsSync(bundle)) throw new Error('Preserve existing target directory; prepare a different immutable revision.');
    const receipt: CornellExportReceipt = previous ?? { schema_version: 1, plan_hash: plan.plan_hash, note_id: plan.input.note_id, status: 'writing', files: plan.files.map(file => ({ path: file.path, sha256: file.sha256 })) };
    if (receipt.plan_hash !== plan.plan_hash || cornellCanonical(receipt.files) !== cornellCanonical(plan.files.map(file => ({ path: file.path, sha256: file.sha256 })))) throw new Error('Export receipt is invalid.');
    // Preflight every existing file before adding any new one; authored bytes are never replaced.
    for (const file of plan.files) {
      const path = noLinks(plan.notes_root, file.path);
      if (existsSync(path) && (!lstatSync(path).isFile() || hash(readFileSync(path)) !== file.sha256)) throw new Error('Preserve changed target notes or solutions; export to a new revision.');
    }
    atomicWrite(statePath, JSON.stringify(receipt, null, 2) + '\n');
    mkdirSync(dirname(bundle), { recursive: true }); noLinks(plan.notes_root, plan.bundle_directory);
    if (!previous) mkdirSync(bundle);
    for (const file of plan.files) {
      currentPlan(root, plan.plan_hash);
      const path = noLinks(plan.notes_root, file.path);
      if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); noLinks(plan.notes_root, file.path); writeFileSync(path, Buffer.from(file.content_base64, 'base64'), { flag: 'wx' }); }
    }
    currentPlan(root, plan.plan_hash);
    for (const file of plan.files) if (hash(regular(plan.notes_root, file.path)) !== file.sha256) throw new Error('Export verification failed; preserve the partial copy and inspect it.');
    if (receipt.status !== 'completed') { receipt.status = 'completed'; receipt.completed_at = now(); atomicWrite(statePath, JSON.stringify(receipt, null, 2) + '\n'); }
    return receipt;
  });
}
/** Publication consumes only a current, completely copied, hash-verified export. */
export function verifiedCornellExport(root: string, planHash: string): { plan: CornellExportPlan; receipt: CornellExportReceipt } {
  const plan = currentPlan(root, planHash);
  const receipt = JSON.parse(readFileSync(safePath(root, receiptPath(planHash)), 'utf8')) as CornellExportReceipt;
  if (receipt.status !== 'completed' || receipt.plan_hash !== planHash) throw new Error('Apply and verify the local export before publication.');
  for (const file of plan.files) if (hash(regular(plan.notes_root, file.path)) !== file.sha256) throw new Error('Exported notes changed; preserve edits and prepare a new revision.');
  return { plan, receipt };
}
