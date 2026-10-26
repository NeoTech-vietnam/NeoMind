import { createHash } from 'node:crypto';

/** Post-execution freshness of the already approved checker scope, not a sandbox
 * or an assertion about every dependency actually loaded by the process. */
export interface ControlledCheckerScope {
  schema_version: 1; roots: string[]; files: Record<string, string>; sha256: string;
}
const rootsFor = (roots: readonly string[]) => [...new Set(roots)].sort();
function digest(roots: string[], files: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify({ schema_version: 1, roots,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })).digest('hex');
}
function valid(value: ControlledCheckerScope | undefined): value is ControlledCheckerScope {
  return !!value && value.schema_version === 1 && Array.isArray(value.roots) && value.roots.length <= 128 &&
    value.roots.every(root => typeof root === 'string') && JSON.stringify(value.roots) === JSON.stringify(rootsFor(value.roots)) &&
    !!value.files && typeof value.files === 'object' && !Array.isArray(value.files) && Object.keys(value.files).length <= 4096 &&
    Object.entries(value.files).every(([path, hash]) => value.roots.some(root => path === root || path.startsWith(`${root}/`)) &&
      typeof hash === 'string' && (hash === 'missing' || /^[a-f0-9]{64}$/.test(hash))) && value.sha256 === digest(value.roots, value.files);
}
/** Capture uses the existing bounded fingerprint authority, including missing
 * roots. Explicit roots preserve the identity of otherwise empty scopes. */
export function captureControlledCheckerScope(roots: readonly string[], capture: (paths: string[]) => Record<string, string>): ControlledCheckerScope {
  const selected = rootsFor(roots), files = capture(selected);
  const result: ControlledCheckerScope = { schema_version: 1, roots: selected, files, sha256: digest(selected, files) };
  if (!valid(result)) throw new Error('The approved checker-scope freshness envelope is invalid.');
  return result;
}
export function controlledCheckerScopeCurrent(saved: ControlledCheckerScope | undefined, current: ControlledCheckerScope): boolean {
  return valid(saved) && valid(current) && saved.sha256 === current.sha256 &&
    JSON.stringify(saved.roots) === JSON.stringify(current.roots);
}
/** Project a copy; historical execution and receipt bytes remain unchanged. */
export function projectControlledCheckerScope<T extends { passed: boolean; checker_scope?: ControlledCheckerScope }>(check: T, current: ControlledCheckerScope) {
  const checker_scope_current = controlledCheckerScopeCurrent(check.checker_scope, current);
  return { ...check, observed_passed: check.passed, checker_scope_current, passed: check.passed && checker_scope_current };
}
