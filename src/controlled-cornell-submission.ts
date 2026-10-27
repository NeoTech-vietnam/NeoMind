import { z } from 'zod';
import { cornellResearchSchema } from './cornell-workflow.js';
import { controlledCornellResearchSchema } from './controlled-cornell-sources.js';
import { ControlledPayloadError } from './controlled-payload.js';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message: string): never => { throw new ControlledPayloadError('INVALID_PAYLOAD', message); };
function alias(value: Record<string, any>, canonical: string, alternative: string) {
  if (value[canonical] !== undefined && value[alternative] !== undefined && JSON.stringify(value[canonical]) !== JSON.stringify(value[alternative]))
    invalid(`Conflicting Cornell ${canonical} and ${alternative} fields; supply one professional value.`);
  const result = { ...value, ...(value[canonical] === undefined && value[alternative] !== undefined ? { [canonical]: value[alternative] } : {}) };
  delete result[alternative]; return result;
}
const identifier = (value: unknown, prefix: string, index: number) => typeof value === 'string' && new RegExp(`^${prefix}[1-9][0-9]*$`, 'i').test(value)
  ? value.toUpperCase() : `${prefix}${index + 1}`;

/** Only representation and backend metadata are normalized. Answers, titles,
 * claim classifications and multi-objective relationships remain author input. */
export function normalizeControlledCornellSubmission(value: Record<string, any>, allowObserved = true, allowStarter = true, backendDate?: string) {
  const input = structuredClone(value);
  if (input.date === undefined) {
    if (backendDate === undefined) invalid('An omitted Cornell date requires the backend-bound saved workflow date.');
    input.date = backendDate;
  }
  if (typeof input.constraints === 'string') input.constraints = [input.constraints];
  const objectives = new Map<string, string>(), suppliedObjectiveLabels = new Set<string>();
  if (Array.isArray(input.learning_objectives)) input.learning_objectives = input.learning_objectives.map((entry: any, index: number) => {
    const supplied = typeof entry === 'string' ? { text: entry } : entry;
    if (!object(supplied)) return supplied;
    if (typeof supplied.id === 'string') {
      const label = supplied.id.toUpperCase();
      if (suppliedObjectiveLabels.has(label)) invalid('Cornell learning objectives must have distinct supplied labels; duplicate labels cannot be mapped safely.');
      suppliedObjectiveLabels.add(label);
    }
    const id = identifier(supplied.id, 'O', index);
    if ([...objectives.values()].includes(id)) invalid('Cornell learning objectives must have distinct identities.');
    objectives.set(id, id);
    if (typeof supplied.id === 'string') objectives.set(supplied.id.toUpperCase(), id);
    return { ...supplied, id };
  });
  const objectiveIds: string[] = Array.isArray(input.learning_objectives) ? input.learning_objectives.map((entry: any) => entry.id) : [];
  const questions = (entries: unknown, prefix: 'Q' | 'P') => Array.isArray(entries) ? entries.map((entry: any, index) => {
    if (!object(entry)) return entry;
    const question = alias(entry, 'prompt', 'question');
    question.id = identifier(question.id, prefix, index);
    if (question.objective_ids !== undefined && question.objective_indexes !== undefined)
      invalid('Use objective_ids or objective_indexes, not both.');
    if (question.objective_indexes !== undefined) {
      question.objective_ids = question.objective_indexes.map((at: number) => {
        if (!Number.isInteger(at) || at < 1 || !objectiveIds[at - 1]) invalid('objective_indexes must reference existing learning objectives using one-based integers.');
        return objectiveIds[at - 1];
      });
      delete question.objective_indexes;
    } else if (question.objective_ids === undefined && objectiveIds.length === 1) question.objective_ids = [objectiveIds[0]];
    else if (question.objective_ids === undefined)
      invalid('With multiple learning objectives, each question needs objective_indexes such as [1,2], or explicit objective_ids. The backend cannot guess the professional relationship.');
    if (Array.isArray(question.objective_ids)) question.objective_ids = question.objective_ids.map((id: string) => {
      const normalized = typeof id === 'string' ? objectives.get(id.toUpperCase()) : undefined;
      if (!normalized) invalid('A question references an unknown learning objective; use its one-based objective_indexes.');
      return normalized;
    });
    return question;
  }) : entries;
  input.questions = questions(input.questions, 'Q');
  if (object(input.practice)) input.practice.questions = questions(input.practice.questions, 'P');
  if (Array.isArray(input.explanations)) input.explanations = input.explanations.map((entry: any) => object(entry) ? alias(entry, 'heading', 'title') : entry);
  const sourceIds = new Set<string>();
  if (Array.isArray(input.sources)) input.sources = input.sources.map((entry: any, index: number) => {
    if (!object(entry)) return entry;
    if (entry.id !== undefined && (typeof entry.id !== 'string' || !/^S[1-9][0-9]*$/i.test(entry.id)))
      invalid('Source IDs must use S1, S2, ... or be omitted for backend assignment. Narrative citation relationships cannot be guessed or rewritten.');
    const id = identifier(entry.id, 'S', index);
    if (sourceIds.has(id)) invalid('Cornell sources must have distinct citation identities.');
    sourceIds.add(id);
    return { ...alias(entry, 'uri', 'url'), id };
  });
  return controlledCornellResearchSchema(allowObserved, allowStarter).parse(input);
}

/** The advertised shape describes professional content; omitted identifiers and
 * the current date are backend-owned. Legacy canonical requests remain valid. */
export function controlledCornellSubmissionSchema(allowObserved = true, allowStarter = true) {
  const canonical = controlledCornellResearchSchema(allowObserved, allowStarter);
  const question = cornellResearchSchema.shape.questions.element.omit({ id: true, prompt: true, objective_ids: true }).extend({
    id: z.string().optional().describe('Optional legacy label. Backend assigns a stable question ID when omitted.'),
    prompt: cornellResearchSchema.shape.questions.element.shape.prompt.optional(),
    question: cornellResearchSchema.shape.questions.element.shape.prompt.optional().describe('Accepted alias for prompt; do not supply conflicting values.'),
    objective_ids: z.array(z.string()).min(1).max(32).optional(),
    objective_indexes: z.array(z.number().int().min(1).max(32)).min(1).max(32).optional()
      .describe('One-based indexes into learning_objectives; required for multi-objective notes unless objective_ids are supplied. With exactly one objective, backend binds it automatically.'),
  });
  const source = cornellResearchSchema.shape.sources.element.omit({ id: true, uri: true, record_id: true, sha256: true, retrieved_at: true }).extend({
    id: z.string().optional().describe('Optional legacy source label; backend supplies S1, S2, ... by source order.'),
    uri: z.string().min(1).max(2000).optional(), url: z.string().min(1).max(2000).optional().describe('Accepted alias for uri; copy the exact inspected source address.'),
  });
  const practiceOptions = cornellResearchSchema.shape.practice.options.map(option => option.omit({ solution_path: true, starter: true })
    .extend({ questions: z.array(question).min(1).max(40), ...(allowStarter ? { starter: z.string().max(64_000).optional() } : {}) }));
  const practice = z.preprocess(value => {
    if (!object(value)) return value;
    const { solution_path: _path, starter: _starter, ...semantic } = value;
    return allowStarter && _starter !== undefined ? { ...semantic, starter: _starter } : semantic;
  }, z.union(practiceOptions));
  return canonical.extend({
    date: canonical.shape.date.optional().describe('Omit for the backend-bound saved workflow date, stable across retries and restarts; supply YYYY-MM-DD only for an explicit historical note.'),
    constraints: z.union([canonical.shape.constraints, canonical.shape.constraints.element]),
    learning_objectives: z.array(z.union([cornellResearchSchema.shape.learning_objectives.element.omit({ id: true }).extend({
      id: z.string().optional().describe('Optional legacy label; backend assigns O1, O2, ... when omitted.'),
    }), cornellResearchSchema.shape.learning_objectives.element.shape.text])).min(1).max(32),
    explanations: z.array(cornellResearchSchema.shape.explanations.element.omit({ heading: true }).extend({
      heading: cornellResearchSchema.shape.explanations.element.shape.heading.optional(),
      title: cornellResearchSchema.shape.explanations.element.shape.heading.optional().describe('Accepted alias for heading.'),
    })).min(1).max(32),
    questions: z.array(question).min(1).max(40), practice,
    sources: z.array(z.preprocess(value => {
      if (!object(value)) return value;
      const { record_id: _id, sha256: _hash, retrieved_at: _time, ...semantic } = value; return semantic;
    }, source)).min(1).max(64),
  });
}

export const controlledCornellSubmissionGuide = ' Supply complete professional research, not title/notes shorthand. Backend supplies date and O/Q/P/S labels. ' +
  'Shape: {topic,context,constraints:[text],abstract,learning_objectives:[text],methods,explanations:[{heading,body}],results,discussion,' +
  'questions:[{prompt,answer,objective_indexes:[1]}],worked_example:{body,expected},practice:{questions:[{prompt,answer,objective_indexes:[1]}],procedure:[text]},' +
  'sources:[{title,uri}],failure_cases:[text],summary}. All narrative text must be substantive; methods/explanation bodies/results/discussion need an honest ' +
  '[source-reported], [inferred] or [expected] claim basis and an inline [S1] citation matching source order. Do not fabricate observed results. ' +
  'Provide both prompts and complete answers; objective_indexes are one-based and explicitly map each question to its intended learning objectives. ' +
  'Source uri is an exact inspected project-relative path or HTTPS reference; source titles are required. Explanation heading/title is required. ' +
  'Do not guess input_path: that form requires an existing readable JSON file. Empty {} is valid only when the backend explicitly binds a prepared primary source.';
