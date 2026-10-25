import { controlledPublicReferencePath, controlledSkillInputPath, ControlledToolError, type ControlledPlan } from './controlled-tools.js';
import { validateProcedurePath, validateProcedureDefinition } from './procedures.js';
import { existsSync } from 'node:fs';
import { validateControlledExecutionDeclaration } from './controlled-execution.js';

const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const covers = (path: string, scopes: string[]) => scopes.some(scope => key(path) === key(scope) || key(path).startsWith(`${key(scope)}/`));
const unique = (values: string[]) => [...new Map(values.map(value => [key(value), value])).values()];
const consultationRuntimeRoles = { explorer: 'codebase-analyst', planner: 'requirements', architect: 'architect',
  researcher: 'researcher', curator: 'curator', 'component-owner': 'component-owner' } as const;
/** The same exact resolver validates new plans and dispatches frozen consultations. */
export function controlledConsultationRole(role: unknown) {
  if (typeof role !== 'string' || !Object.hasOwn(consultationRuntimeRoles, role))
    throw new ControlledToolError('UNSUPPORTED_SPECIALIST_ROLE', 'Unsupported consultation role. Use only explorer, planner, architect, researcher, curator or component-owner. Reviewer and Verifier are backend-owned stages; preserve their required pre-check, independent verification and final review gates instead of requesting them as consultations.');
  return consultationRuntimeRoles[role as keyof typeof consultationRuntimeRoles];
}
/**
 * Submission-only metadata normalization. Existing frozen contracts are never
 * read through this function. Scope, commands, controls and acceptance stay the
 * caller's substantive plan; the backend supplies redundant path bookkeeping.
 */
export function normalizeControlledPlanInput(root: string, input: ControlledPlan,
  committedChecks: readonly { command: string[]; baseline_paths: string[] }[] = []): ControlledPlan {
  const plan = structuredClone(input);
  // Directory scope notation is equivalent with or without a final separator.
  // Preserve internal components for path validation; exact file paths stay exact.
  for (const field of ['allowed_paths', 'verification_paths', 'preservation_paths'] as const)
    if (plan[field]) plan[field] = plan[field].map(path => path.replace(/\/+$/, ''));
  const titles = new Set<string>();
  const operationOutputs: string[] = [];
  for (const step of plan.execution_steps ?? []) {
    if (titles.has(step.title)) throw new Error('Each execution_steps title must be unique.');
    titles.add(step.title);
    if (step.output_paths.some(path => operationOutputs.some(other => covers(path, [other]) || covers(other, [path]))))
      throw new Error('execution_steps cannot create overlapping output files across operations.');
    operationOutputs.push(...step.output_paths);
    validateControlledExecutionDeclaration(root, { stage: 'implementation', role: 'developer',
      implementation_paths: plan.allowed_paths, verification_paths: plan.verification_paths,
      read_paths: ['.'], approved_inputs: plan.input_paths ?? [], protected_paths: plan.preservation_paths ?? [] }, step);
    if (step.output_paths.some(path => !plan.outputs.includes(path)))
      throw new Error('execution_steps output_paths must name declared producer outputs.');
  }
  for (const specialist of plan.specialists ?? []) controlledConsultationRole(specialist.role);
  const validated = new Set<string>();
  const checked = (path: string) => { if (!validated.has(path)) { validateProcedurePath(root, path); validated.add(path); } return path; };
  plan.input_paths = unique((plan.input_paths ?? []).flatMap(path => {
    checked(path);
    if (controlledSkillInputPath(path)) return [path];
    if (controlledPublicReferencePath(path)) return [];
    throw new Error('input_paths cannot approve private configuration, credentials or hidden directories. Use only exact allowed skill assets/scripts; ordinary public source paths are already readable.');
  }));
  const checkerInputs = (command: string[]) => command.slice(1).filter(path => covers(path, plan.verification_paths)).map(checked);
  const outputs = plan.outputs.map(checked);
  for (const check of plan.checks) {
    const committed = committedChecks.find(saved => JSON.stringify(saved.command) === JSON.stringify(check.command));
    const checker = checkerInputs(check.command);
    // A continuation retains exact committed baseline membership rather than
    // asking the model to reproduce it or silently widening an older contract.
    check.baseline_paths = committed ? committed.baseline_paths.map(checked)
      : unique([...(check.baseline_paths ?? []).map(checked), ...outputs, ...checker]);
    for (const negative of check.negative_controls ?? [])
      negative.baseline_paths = unique([...(negative.baseline_paths ?? []).map(checked), ...checker, ...checkerInputs(negative.command)]);
  }
  if (plan.procedure_candidate) {
    // Preview identities stay internal and are discarded; actual registration
    // still issues its workflow-owned identity after independently checked work.
    const candidate = validateProcedureDefinition(root, { ...plan.procedure_candidate,
      id: 'controlled-plan-preview', version: '1.0.0', author: 'backend-plan-preflight' });
    for (const path of [candidate.script, candidate.verification_script, ...candidate.dependencies]) checked(path);
    if (!candidate.effects.write_roots.length)
      throw new Error('procedure_candidate.outputs are future generated artifacts and require nonempty effects.write_roots; delivered tooling files are tool inputs, not procedure outputs.');
    const templated = (path: string) => /\{[^{}]+\}/.test(path);
    const inputs = new Set([candidate.script, candidate.verification_script, ...candidate.dependencies, ...plan.outputs, ...(plan.input_paths ?? [])].map(key));
    for (const output of candidate.outputs) {
      if (templated(output.path)) continue; // Parameter-dependent containment is enforced by the actual runner.
      const path = checked(output.path);
      if (inputs.has(key(path)))
        throw new Error('procedure_candidate.outputs must describe future generated artifacts, not delivered tooling, executable scripts or readonly tool inputs.');
      if (existsSync(validateProcedurePath(root, path)))
        throw new Error('A fixed procedure output already exists. Declare a new generated destination instead of overwriting existing authored files.');
      if (candidate.effects.write_roots.every(root => !templated(root)) && !covers(path, candidate.effects.write_roots))
        throw new Error('A fixed procedure output lies outside every literal effects.write_roots entry. Preserve the intended scope and use a compatible generated destination.');
    }
  }
  return plan;
}
