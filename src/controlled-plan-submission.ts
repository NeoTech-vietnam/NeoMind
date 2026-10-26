import { z } from 'zod';
import { controlledExecutionDeclarationSchema } from './controlled-execution.js';

const compiler = 'cornell_research_compile';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function advertised(schema: z.ZodType) {
  const { $schema: _draft, ...metadata } = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' });
  return metadata;
}

function checkCommand(input: unknown): unknown {
  if (!object(input)) return input;
  const result = { ...input };
  if (Object.hasOwn(result, 'argv')) {
    if (Object.hasOwn(result, 'command') && !same(result.command, result.argv))
      throw new Error('Check command and argv disagree; preserve the requested command and resolve this ambiguity.');
    result.command = result.argv; delete result.argv;
  }
  if (Array.isArray(result.negative_controls)) result.negative_controls = result.negative_controls.map(checkCommand);
  return result;
}

/** Accept only the exact argv/command spelling equivalence, then apply the
 * original strict check schema. The advertised interface stays canonical. */
export function controlledPlanCheckSubmissionSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return z.preprocess((value, context) => {
    try { return checkCommand(value); }
    catch { context.addIssue({ code: 'custom', message: 'Check command and argv disagree. Supply one exact canonical command without conflicting aliases.' }); return z.NEVER; }
  }, schema).meta(advertised(schema));
}

function nativeCompilerStep(input: unknown): unknown {
  if (!object(input)) return input;
  const command = input.command;
  if (input.tool !== compiler && !(Array.isArray(command) && command[0] === compiler)) return input;
  const allowed = new Set(['title', 'command', 'input_paths', 'output_paths', 'timeout_ms', 'max_output_bytes', 'tool', 'input_path', 'parameters', 'outputs']);
  if (Object.keys(input).some(name => !allowed.has(name)) || input.tool !== undefined && input.tool !== compiler ||
      command !== undefined && (!Array.isArray(command) || command[0] !== compiler || command.length > 2 || command.some(part => typeof part !== 'string')))
    throw new Error('Native Cornell operation contains unsupported or conflicting metadata.');
  if (input.parameters !== undefined && (!object(input.parameters) || Object.keys(input.parameters).some(name => name !== 'input_path')))
    throw new Error('Native Cornell parameters can name only the prepared JSON input_path.');
  const sources = [input.input_path, object(input.parameters) ? input.parameters.input_path : undefined, Array.isArray(command) ? command[1] : undefined]
    .filter(value => value !== undefined);
  if (sources.some(value => typeof value !== 'string' || !value) || new Set(sources).size > 1)
    throw new Error('Native Cornell source aliases disagree.');
  if (input.outputs !== undefined && input.output_paths !== undefined && !same(input.outputs, input.output_paths))
    throw new Error('Native Cornell output aliases disagree.');
  const { tool: _tool, input_path: _source, parameters: _parameters, outputs: _outputs, ...canonical } = input;
  const source = sources[0];
  return { ...canonical, command: [compiler, ...(source === undefined ? [] : [source])],
    ...(input.input_paths === undefined ? { input_paths: source === undefined ? [] : [source] }
      : Array.isArray(input.input_paths) && source !== undefined ? { input_paths: [...new Set([...input.input_paths, source])] } : {}),
    output_paths: input.output_paths ?? input.outputs };
}

/** Native compiler spellings are an ingress marker only. Full plan
 * normalization must bind its exact Cornell destination before removing the
 * marker; it is never authorized as an operating-system command. */
export function controlledPlanExecutionStepSubmissionSchema() {
  const canonical = controlledExecutionDeclarationSchema.extend({
    title: controlledExecutionDeclarationSchema.shape.title.describe('A concise professional operation title, reused by the Implementer task_run call. No invocation or assignment identity is supplied.'),
    command: controlledExecutionDeclarationSchema.shape.command.describe('Required direct OS argument array, for example ["node","scripts/producer.cjs"]. Use command, not argv. Node -e/--eval, shell wrappers and native tools are unavailable. Prepared JSON is supplied later by task_run input_path as stdin, not a stdin_path field or shell redirection.'),
    output_paths: controlledExecutionDeclarationSchema.shape.output_paths.describe('Required exact new producer-created files, for example ["generated/result.json"]. This is output_paths, not outputs or baseline_paths. The files must belong to the declared producer scope; existing files are preserved.'),
  });
  const ingress = canonical.extend({ command: z.array(z.string().min(1).max(8000)).min(1).max(128) })
    .superRefine((value, context) => {
      if (value.command.length < 2 && value.command[0] !== compiler)
        context.addIssue({ code: 'custom', path: ['command'], message: 'Producer commands require their exact script or fixed version argument.' });
    });
  return z.preprocess((value, context) => {
    try { return nativeCompilerStep(value); }
    catch { context.addIssue({ code: 'custom', message: 'Native Cornell metadata is ambiguous. Use its bound compiler with one source and exact fixed outputs; do not add commands or arbitrary parameters.' }); return z.NEVER; }
  }, ingress).meta(advertised(canonical));
}
