import { controlledPublicReferencePath, controlledSkillInputPath, ControlledToolError, type ControlledPlan } from './controlled-tools.js';
import { validateProcedurePath, validateProcedureDefinition } from './procedures.js';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { validateControlledExecutionDeclaration } from './controlled-execution.js';
import { controlledPlanExecutionStepSubmissionSchema } from './controlled-plan-submission.js';

const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const covers = (path: string, scopes: string[]) => scopes.some(scope => key(path) === key(scope) || key(path).startsWith(`${key(scope)}/`));
const unique = (values: string[]) => [...new Map(values.map(value => [key(value), value])).values()];
const consultationRuntimeRoles = { explorer: 'codebase-analyst', planner: 'requirements', architect: 'architect',
  researcher: 'researcher', curator: 'curator', 'component-owner': 'component-owner' } as const;
/** Fresh user opt-in is an action request, not a historical contract keyword.
 * Keep the legacy criteria matcher unchanged for committed obligations. */
export function controlledRegistrationRequested(request: string): boolean {
  return request.split(/[!?;\n]+|\.(?=\s|$)|\bbut\b/i).some(clause =>
    /\bregister\b[\s\S]*\bprocedure\b/i.test(clause) &&
    !/\b(?:do\s+not|don't|never|must\s+not|should\s+not|no\s+need\s+to|not\s+to)\s+(?:automatically\s+)?register\b/i.test(clause));
}
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
  const validated = new Set<string>();
  const checked = (path: string) => { if (!validated.has(path)) { validateProcedurePath(root, path); validated.add(path); } return path; };
  for (const path of [...plan.allowed_paths, ...plan.verification_paths]) checked(path);
  const ordinary = (path: string, json = false) => {
    checked(path);
    const target = validateProcedurePath(root, path);
    let info;
    try { info = lstatSync(target); } catch { throw new Error('Read-only compiler and skill inputs must name exact existing ordinary files.'); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || json && (info.size > 1024 * 1024 || !/\.json$/i.test(path)))
      throw new Error('Read-only compiler and skill inputs must be ordinary unlinked files; prepared JSON is bounded to 1 MiB.');
    if (json) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(target)), value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value) || text.includes('\0')) throw new Error('not object');
      } catch { throw new Error('A native compiler input_path must contain an existing valid UTF-8 JSON object.'); }
    }
  };
  const promoted: string[] = [];
  if (plan.preservation_paths !== undefined) plan.preservation_paths = plan.preservation_paths.filter(path => {
    checked(path);
    if (controlledSkillInputPath(path)) { ordinary(path); promoted.push(path); return false; }
    if (!controlledPublicReferencePath(path))
      throw new Error('Preservation cannot approve private configuration or broad hidden directories. Only exact allowed skill assets/scripts can become read-only inputs.');
    return true;
  });
  plan.input_paths = unique([...(plan.input_paths ?? []), ...promoted].flatMap(path => {
    checked(path);
    if (controlledSkillInputPath(path)) return [path];
    if (controlledPublicReferencePath(path)) return [];
    throw new Error('input_paths cannot approve private configuration, credentials or hidden directories. Use only exact allowed skill assets/scripts; ordinary public source paths are already readable.');
  }));
  const checkerInputs = (command: string[]) => {
    const compiler = 'request_kind' in plan && !committedChecks.some(saved => JSON.stringify(saved.command) === JSON.stringify(command)) &&
      /^(?:[a-z0-9_]+-)*(?:gcc|g\+\+|clang|clang\+\+)(?:-\d+(?:\.\d+)*)?$/i.test(command[0]!.replaceAll('\\', '/').split('/').at(-1)!.replace(/\.exe$/i, ''));
    // GCC/Clang -o names a generated artifact, not an inferred checker input.
    // Explicit and historically committed baseline membership is retained.
    return command.slice(1).filter((path, index) => !(compiler && command[index] === '-o') && covers(path, plan.verification_paths)).map(checked);
  };
  const verifierReferences = new Set(plan.checks.flatMap(check => [check.command, ...(check.negative_controls ?? []).map(negative => negative.command)])
    .flatMap(command => checkerInputs(command).map(key)));
  const verifierOutputs = new Set<string>();
  plan.outputs = plan.outputs.filter(path => {
    checked(path);
    if (!covers(path, plan.verification_paths)) return true;
    if (!verifierReferences.has(key(path)))
      throw new Error('A verifier-owned promised output is not referenced by any actual check command. Resolve its ownership without dropping the deliverable.');
    if (plan.evidence_report_paths?.some(report => key(report) === key(path)))
      throw new Error('A final factual report cannot also be classified as a verifier execution artifact.');
    verifierOutputs.add(key(path)); return false;
  });
  plan.documentation_paths = (plan.documentation_paths ?? []).filter(path => !verifierOutputs.has(key(checked(path))));
  const retainCompilerSource = (path: string) => {
    if (!plan.cornell_output_dir || !controlledPublicReferencePath(checked(plan.cornell_output_dir)))
      throw new Error('A retained Cornell source requires its actual bound output directory.');
    if (typeof path !== 'string' || !controlledPublicReferencePath(checked(path)) || covers(path, [...plan.allowed_paths, ...plan.verification_paths]) ||
        [...plan.allowed_paths, ...plan.verification_paths].some(scope => covers(scope, [path])))
      throw new Error('Prepared native Cornell sources must remain public read-only JSON outside every producer and checker write scope.');
    if (plan.cornell_input_path !== undefined && key(plan.cornell_input_path) !== key(path))
      throw new Error('Native Cornell compilation names conflicting prepared sources; preserve the original binding instead of choosing one.');
    ordinary(path, true);
    const bound = plan.cornell_input_path ?? path;
    plan.cornell_input_path = bound;
    plan.preservation_paths = unique([...(plan.preservation_paths ?? []).map(existing => key(existing) === key(bound) ? bound : existing), bound]);
  };
  // Source paths are semantic input. Queued plans retain and revalidate the
  // canonical path after any legacy native marker is gone; hashes and runtime
  // identity remain exclusively backend-owned.
  if (plan.cornell_input_path !== undefined) retainCompilerSource(plan.cornell_input_path);
  let nativeOutputs: string[] | undefined;
  if (plan.execution_steps !== undefined) plan.execution_steps = plan.execution_steps.map(step => controlledPlanExecutionStepSubmissionSchema().parse(step)).filter(step => {
    if (step.command[0] !== 'cornell_research_compile') return true;
    const directory = plan.cornell_output_dir;
    if (!directory || !controlledPublicReferencePath(checked(directory)))
      throw new Error('A native Cornell execution marker requires the actual bound Cornell output directory.');
    const fixed = ['note.md', 'exercises.md', 'answers.md'].map(name => `${directory}/${name}`);
    const worksheet = `${directory}/practice-solution.md`;
    const allowed = [...fixed, ...(plan.outputs.includes(worksheet) ? [worksheet] : [])];
    if (nativeOutputs || step.command.length > 2 || step.timeout_ms !== undefined || step.max_output_bytes !== undefined ||
        fixed.some(path => !step.output_paths.includes(path)) ||
        step.output_paths.some(path => !allowed.includes(checked(path)) || !plan.outputs.includes(path)) ||
        fixed.some(path => !covers(path, plan.allowed_paths) || covers(path, plan.verification_paths)))
      throw new Error('A native Cornell marker must describe one bound compiler with exactly its declared note, exercises and answers, without OS execution options or extra outputs.');
    const sources = unique([...step.input_paths, ...(step.command[1] ? [step.command[1]] : [])]);
    if (sources.length > 1) throw new Error('Native Cornell compilation requires one unambiguous prepared JSON source, not multiple competing inputs.');
    if (sources.length) retainCompilerSource(sources[0]!);
    nativeOutputs = unique(step.output_paths);
    return false;
  });
  const titles = new Set<string>();
  const operationOutputs: string[] = [];
  for (const step of plan.execution_steps ?? []) {
    if (titles.has(step.title)) throw new Error('Each execution_steps title must be unique.');
    titles.add(step.title);
    if (nativeOutputs && step.output_paths.some(path => nativeOutputs!.some(native => covers(path, [native]) || covers(native, [path]))))
      throw new Error('Native Cornell compilation and a local producer operation cannot both own the same output artifacts.');
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
