import { lstatSync } from 'node:fs';
import { validateProcedurePath } from './procedures.js';
import { controlledReadBaselineAllowed } from './controlled-read-baselines.js';
import { ControlledToolError, controlledPublicReferencePath, controlledSkillInputPath, type ControlledPlan } from './controlled-tools.js';

type Scope = Pick<ControlledPlan, 'allowed_paths' | 'verification_paths' | 'preservation_paths' | 'input_paths'>;
type InputOwner = 'developer' | 'verifier' | 'protected-acceptance';
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const covers = (path: string, scopes: readonly string[]) => scopes.some(scope =>
  key(path) === key(scope) || key(path).startsWith(`${key(scope)}/`));

/** Check the complete selected positive/negative group before capturing inputs
 * or executing a command. This admits no paths, creates no semantic fixtures,
 * and changes neither the immutable commands nor either role's write scope. */
export function assertControlledCheckInputs(root: string, plan: Scope,
  checks: readonly { baseline_paths: readonly string[] }[]): void {
  const paths = [...new Set(checks.flatMap(check => [...check.baseline_paths]))];
  // Resolve authority for every path before probing any filesystem state. A
  // private or undeclared path must not become an existence-discovery oracle.
  for (const path of paths) {
    if (!controlledReadBaselineAllowed(plan, path))
      throw new ControlledToolError('SCOPE_DENIED', 'A check input is outside the immutable check scopes and approved read-only inputs. Preserve the contract and report the unsupported input; do not widen file permissions.');
    if (!controlledPublicReferencePath(path) && !(plan.input_paths?.includes(path) && controlledSkillInputPath(path)))
      throw new ControlledToolError('PRIVATE_PATH', 'Private runtime, client configuration and credentials cannot be used as check inputs.');
  }
  const missing: { path: string; owner: InputOwner }[] = [];
  for (const path of paths) {
    let absolute: string;
    try { absolute = validateProcedurePath(root, path); }
    catch { throw new ControlledToolError('INVALID_PATH', 'Check inputs require canonical project-relative paths without links or traversal.'); }
    const owner: InputOwner = covers(path, plan.verification_paths) ? 'verifier'
      : covers(path, plan.allowed_paths) ? 'developer' : 'protected-acceptance';
    try {
      const info = lstatSync(absolute);
      if ((!info.isFile() && !info.isDirectory()) || info.isSymbolicLink() || info.isFile() && info.nlink !== 1 ||
          owner === 'protected-acceptance' && !info.isFile())
        throw new ControlledToolError('INVALID_FILE', 'Check inputs must be ordinary unlinked files or owned fixture directories; read-only dependencies must be exact files.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof ControlledToolError) throw error;
        throw new ControlledToolError('INVALID_FILE', 'A declared check input could not be inspected as an ordinary project file or fixture directory.');
      }
      missing.push({ path, owner });
    }
  }
  if (!missing.length) return;
  const groups: Partial<Record<InputOwner, string[]>> = {};
  for (const item of missing) (groups[item.owner] ??= []).push(item.path);
  const owners = new Set(missing.map(item => item.owner));
  const target_owner = owners.size === 1 ? missing[0]!.owner : 'protected-acceptance';
  const next_action = target_owner === 'verifier'
    ? 'Prepare the listed checker scripts and deliberately invalid fixtures inside your assigned verification_paths, then retry check_run. Preserve the selected commands and existing evidence.'
    : target_owner === 'developer'
      ? 'Report the missing producer outputs as an implementation failure. The Verifier must not create or rewrite producer files; the runtime routes the producer repair.'
      : 'Preserve producer and read-only inputs. Report missing producer outputs or unavailable read-only dependencies to the runtime; prepare only missing paths explicitly owned by the Verifier.';
  throw new ControlledToolError('CHECK_INPUT_MISSING',
    `The selected check group has missing required inputs, grouped by owner: ${JSON.stringify(groups)}. ${next_action}`,
    { target_owner, next_action, missing_paths: missing.map(item => item.path) });
}
