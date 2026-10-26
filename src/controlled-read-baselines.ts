import { controlledPublicReferencePath, controlledSkillInputPath, type ControlledPlan } from './controlled-tools.js';
import { lstatSync } from 'node:fs';
import { validateProcedurePath } from './procedures.js';

const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const covers = (path: string, scopes: readonly string[]) => scopes.some(scope =>
  key(path) === key(scope) || key(path).startsWith(`${key(scope)}/`));

/** Read/check provenance only: this never changes task or worker write authority. */
export function controlledReadBaselineAllowed(plan: Pick<ControlledPlan,
  'allowed_paths' | 'verification_paths' | 'preservation_paths' | 'input_paths'>, path: string): boolean {
  if (covers(path, [...plan.allowed_paths, ...plan.verification_paths])) return true;
  // Preservation is not permission to capture private configuration/credentials.
  if (controlledPublicReferencePath(path) && covers(path, plan.preservation_paths ?? [])) return true;
  // Hidden inputs retain exact-file approval and the existing safe skill-asset policy.
  return !!plan.input_paths?.includes(path) && controlledSkillInputPath(path);
}

/** New readonly admissions are exact files, so recursive capture cannot expose private descendants. */
export function assertControlledReadBaseline(root: string, plan: Parameters<typeof controlledReadBaselineAllowed>[0], path: string): void {
  if (!controlledReadBaselineAllowed(plan, path))
    throw new Error('Check baseline exceeds declared write scopes, public preservation paths and exact approved skill inputs. Read-only dependencies belong in preservation_paths or exact approved input_paths; do not grant write scope to make them readable.');
  if (covers(path, [...plan.allowed_paths, ...plan.verification_paths])) return;
  const info = lstatSync(validateProcedurePath(root, path));
  if (!info.isFile() || info.nlink !== 1)
    throw new Error('Read-only check baselines must name exact existing ordinary unlinked files, not directories. Preserve the intended tree but list only the required public files or exact approved skill inputs in baseline_paths.');
}
