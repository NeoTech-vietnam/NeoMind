import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

export interface ControlledPlanRequestDefaults {
  /** Backend-selected professional metadata from the actual saved workflow. */
  title: string;
  objective: string;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = isDeepStrictEqual;
const aliases = ['intent', 'summary', 'implementation_instructions', 'verification_instructions', 'negative_controls'] as const;
class PlanRequestError extends Error {
  constructor(public readonly path: (string | number)[], message: string) { super(message); }
}
function fail(path: (string | number)[], message: string): never { throw new PlanRequestError(path, message); }
function narrative(value: unknown, path: (string | number)[]): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000)
    fail(path, 'Professional narrative must be a nonempty string of at most 8000 characters.');
  return value;
}
function namedCheck(value: unknown, path: (string | number)[], notes: string[], negative: boolean): unknown {
  if (!object(value)) return value;
  const result = { ...value };
  if (Object.hasOwn(result, 'name')) {
    if (Object.hasOwn(result, 'title') && !same(result.title, result.name))
      fail([...path, 'name'], 'Check name and title disagree. Supply one unambiguous professional title.');
    result.title = result.name; delete result.name;
  }
  if (Object.hasOwn(result, 'argv')) {
    if (Object.hasOwn(result, 'command') && !same(result.command, result.argv))
      fail([...path, 'argv'], 'Check argv and command disagree. Supply one exact argument array.');
    result.command = result.argv; delete result.argv;
  }
  if (negative && Object.hasOwn(result, 'fixture_description')) {
    const description = narrative(result.fixture_description, [...path, 'fixture_description']);
    notes.push(`Negative control ${typeof result.title === 'string' ? result.title : path.join('.')}: ${description}`);
    delete result.fixture_description;
  }
  if (Array.isArray(result.negative_controls)) result.negative_controls = result.negative_controls.map((entry, index) =>
    namedCheck(entry, [...path, 'negative_controls', index], notes, true));
  return result;
}
function checker(command: unknown): string | undefined {
  return Array.isArray(command) && command.length >= 2 && typeof command[0] === 'string' && typeof command[1] === 'string'
    ? JSON.stringify(command.slice(0, 2)) : undefined;
}

/** Compatibility normalization changes request assembly, never execution scope,
 * credentials, model verdicts or the strict immutable plan contract. */
function normalizeRequest(value: unknown, defaults?: Readonly<ControlledPlanRequestDefaults>): unknown {
  if (!object(value)) return value;
  const result = { ...value }, notes: string[] = [];
  if (defaults && result.title === undefined) result.title = defaults.title;
  if (defaults && result.objective === undefined) result.objective = defaults.objective;
  if (Object.hasOwn(result, 'summary')) {
    const summary = narrative(result.summary, ['summary']);
    if (result.rationale !== undefined && !same(result.rationale, summary))
      fail(['summary'], 'Summary and rationale disagree. Supply one unambiguous professional rationale.');
    result.rationale = summary; delete result.summary;
  }
  if (Object.hasOwn(result, 'intent')) {
    notes.push(`Intent: ${narrative(result.intent, ['intent'])}`); delete result.intent;
  }
  for (const field of ['implementation_instructions', 'verification_instructions'] as const) {
    if (!Object.hasOwn(result, field)) continue;
    const entries = result[field];
    if (!Array.isArray(entries) || entries.length > 64)
      fail([field], 'Professional instructions must be an array of at most 64 nonempty strings.');
    const retained = entries.map((entry, index) => narrative(entry, [field, index]));
    if (retained.length) notes.push(`${field === 'implementation_instructions' ? 'Implementation' : 'Verification'} instructions:\n${retained.map(entry => `- ${entry}`).join('\n')}`);
    delete result[field];
  }
  if (Array.isArray(result.checks)) result.checks = result.checks.map((entry, index) => namedCheck(entry, ['checks', index], notes, false));
  if (Object.hasOwn(result, 'negative_controls')) {
    const entries = result.negative_controls;
    if (!Array.isArray(entries) || entries.length > 256)
      fail(['negative_controls'], 'Top-level negative controls must be a bounded array associated with one exact checker each.');
    for (const [index, entry] of entries.entries()) {
      const normalized = namedCheck(entry, ['negative_controls', index], notes, true);
      const match = object(normalized) ? checker(normalized.command) : undefined;
      const candidates = Array.isArray(result.checks) ? result.checks.filter(candidate => object(candidate) && match !== undefined && checker(candidate.command) === match) : [];
      if (candidates.length !== 1)
        fail(['negative_controls', index], 'A top-level negative control must match exactly one positive check by executable and checker script. Keep ambiguous controls within their intended checks.');
      const target = candidates[0] as Record<string, unknown>;
      if (target.negative_controls !== undefined && !Array.isArray(target.negative_controls))
        fail(['negative_controls', index], 'The matched check must declare its negative controls as an array.');
      const existing = [...(target.negative_controls as unknown[] | undefined ?? [])];
      if (!existing.some(candidate => same(candidate, normalized))) {
        if (object(normalized) && existing.some(candidate => object(candidate) && candidate.title === normalized.title))
          fail(['negative_controls', index], 'A negative-control title has conflicting declarations. Preserve one exact command and expectation.');
        existing.push(normalized);
      }
      target.negative_controls = existing;
    }
    delete result.negative_controls;
  }
  if (notes.length && typeof result.rationale === 'string') {
    narrative(result.rationale, ['rationale']);
    result.rationale += `\n\n${notes.join('\n\n')}`;
  }
  // Missing rationale remains a professional-content error. Compatibility
  // notes and the saved user requirement are never invented as approval.
  return result;
}

/** The SDK receives a root object with canonical typed advertisement. Known
 * ingress aliases are validated before the same strict canonical parser used
 * for prepared JSON; neither path can inject runtime identity or merge data. */
export function controlledPlanRequestSchemas<T extends z.ZodRawShape>(canonical: z.ZodObject<T>, input?: ControlledPlanRequestDefaults) {
  const defaults = input === undefined ? undefined : Object.freeze({ ...input });
  const parseSchema = z.preprocess((value, refinement) => {
    try { return normalizeRequest(value, defaults); }
    catch (error) {
      if (!(error instanceof PlanRequestError)) throw error;
      refinement.addIssue({ code: 'custom', path: error.path, message: error.message });
      return z.NEVER;
    }
  }, canonical);
  const raw = Object.fromEntries([...Object.keys(canonical.shape), ...aliases].map(name => [name, z.unknown().optional()]));
  const { $schema: _draft, ...advertisement } = z.toJSONSchema(canonical, { io: 'input', target: 'draft-7' });
  const schema = z.strictObject(raw).superRefine((value, refinement) => {
    const parsed = parseSchema.safeParse(value);
    if (!parsed.success) for (const issue of parsed.error.issues)
      refinement.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }).meta({ ...advertisement, required: (advertisement.required ?? []).filter(name => !defaults || name !== 'title' && name !== 'objective') });
  return { schema, parseSchema };
}
