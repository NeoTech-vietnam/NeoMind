import path from 'node:path';
import { isProjectMetadataPath } from '../storage/project-dir.js';
export interface ScopedReviewer { id: string; required: boolean; scopes: string[] }
export interface ImpactSelection { reviewerIds: string[]; reason: 'scoped' | 'unknown-impact' }
function normalize(value: string): string | undefined {
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes('*')) return undefined;
  const result = path.posix.normalize(value);
  if (result === '..' || result.startsWith('../')) return undefined;
  return result.replace(/\/$/, '');
}
function overlaps(a: string, b: string): boolean {
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
/** Version of the rule below; impact receipts record it so a later rule change cannot silently reinterpret them. */
export const IMPACT_RULE_VERSION = 1;
const sharedFiles = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lockb',
  'tsconfig.json', 'jsconfig.json', 'babel.config.js', '.babelrc', 'makefile', 'cmakelists.txt', 'dockerfile', 'docker-compose.yml', 'pyproject.toml',
  'setup.py', 'setup.cfg', 'requirements.txt', 'pipfile', 'pipfile.lock', 'poetry.lock', 'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'gemfile',
  'gemfile.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', '.gitmodules', '.gitattributes']);
/**
 * Changes that can affect code outside their own directory (dependencies, build and tool configuration, CI, NeoMind
 * metadata). Any of these makes scoped impact unknown, so every required reviewer runs again.
 */
export function sharedImpactPaths(changed: string[]): string[] {
  return changed.filter(file => {
    const name = path.posix.basename(file).toLowerCase();
    return sharedFiles.has(name) || /^tsconfig\..+\.json$/.test(name) || /\.config\.(?:[cm]?[jt]s|json)$/.test(name) || /^requirements.*\.txt$/.test(name) ||
      file.startsWith('.github/') || isProjectMetadataPath(file);
  });
}
/** Caller must establish affected paths, including dependencies. Unverified impact reruns every required reviewer. */
export function selectReviewersForChanges(reviewers: ScopedReviewer[], changedPaths: string[] | null,
  priorFindingReviewers: string[], impactVerified: boolean): ImpactSelection {
  if (new Set(reviewers.map(r => r.id)).size !== reviewers.length) throw new Error('Duplicate reviewer ID');
  const ids = new Set(reviewers.map(r => r.id));
  if (priorFindingReviewers.some(id => !ids.has(id))) throw new Error('Unknown finding reviewer');
  const paths = changedPaths?.map(normalize);
  const scoped = reviewers.map(reviewer => ({ reviewer, scopes: reviewer.scopes.map(normalize) }));
  const unknown = !impactVerified || !paths?.length || paths.some(value => value === undefined) ||
    scoped.some(item => !item.scopes.length || item.scopes.some(value => value === undefined)) ||
    !!paths?.some(changed => changed !== undefined && !scoped.some(item => item.scopes.some(scope => scope !== undefined && overlaps(scope, changed))));
  if (unknown) return { reviewerIds: reviewers.filter(r => r.required || priorFindingReviewers.includes(r.id)).map(r => r.id), reason: 'unknown-impact' };
  return { reviewerIds: scoped.filter(({ reviewer, scopes }) => priorFindingReviewers.includes(reviewer.id) ||
    scopes.some(scope => paths!.some(changed => overlaps(scope!, changed!)))).map(item => item.reviewer.id), reason: 'scoped' };
}
