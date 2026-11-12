import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { replaceJson } from '../storage/atomic-json.js';
import { withLibraryLock } from '../storage/library-lock.js';
import { projectDir } from '../storage/project-dir.js';
import { installGuideReference, installProjectGuide, type GuideReferenceResult, type ProjectGuideResult } from '../storage/project-guide.js';
import { readProject } from './project.js';

export interface ProjectInitResult {
  project: string;
  directory: { path: string; status: 'created' | 'existing' };
  projectJson: { path: string; status: 'created' | 'existing' };
  guide: ProjectGuideResult;
  /** The guide's reference in AGENTS.md, which `force` never rewrites. */
  agents: GuideReferenceResult;
  /** Only when AGENTS.md was created next to an existing CLAUDE.md. */
  claude?: GuideReferenceResult;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * `neomind init`: set a repository up for NeoMind explicitly instead of on its first write. Creates NeoMind's folder and
 * a project.json holding the defaults a missing one reads as (so nothing about the project changes, it only becomes
 * visible and editable), installs the flow-authoring guide and names it in AGENTS.md. Idempotent: an existing folder,
 * project.json, a guide the user edited and a reference already in AGENTS.md are kept; `force` rewrites only the guide.
 */
export async function initProject(projectRoot: string, options: { force?: boolean | undefined } = {}): Promise<ProjectInitResult> {
  const root = await realpath(projectRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error(`${projectRoot} không phải thư mục`);
  const directory = projectDir(root), relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
  let created = false;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${relative(directory)} phải là thư mục thật, không phải symlink`);
  } catch (error) {
    if (!missing(error)) throw error;
    try { await mkdir(directory); created = true; } catch (inner) { if ((inner as NodeJS.ErrnoException).code !== 'EEXIST') throw inner; }
  }
  const file = path.join(directory, 'project.json');
  // Same lock as the other project.json writers (memory selection), so a concurrent editor save is not overwritten.
  const projectJson = await withLibraryLock(directory, async () => {
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new Error(`Không ghi cấu hình qua symlink: ${relative(file)}`);
      return 'existing' as const;
    } catch (error) { if (!missing(error)) throw error; }
    await replaceJson(file, await readProject(root));
    return 'created' as const;
  });
  const guide = installProjectGuide(root, options), [agents, claude] = installGuideReference(root);
  return { project: root, directory: { path: relative(directory), status: created ? 'created' : 'existing' },
    projectJson: { path: relative(file), status: projectJson }, guide, agents: agents!, ...(claude ? { claude } : {}) };
}
