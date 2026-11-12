import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashJson } from '../domain/resolve.js';
import { memorySelectionSchema, projectSchema, type ProjectConfig } from '../domain/schema.js';
import { replaceJson } from '../storage/atomic-json.js';
import { RevisionConflict, withLibraryLock } from '../storage/library-lock.js';
import { projectDir } from '../storage/project-dir.js';
import { projectDirCreated } from '../storage/project-guide.js';
import { readProject } from './project.js';

/** Read the whole project's revision so changing any other field prevents a stale editor from overwriting it. */
export async function readMemorySelection(projectRoot: string) {
  const project = await readProject(projectRoot);
  return { selection: project.memorySelection ?? {}, revision: hashJson(project) };
}

export async function writeMemorySelection(projectRoot: string, selection: unknown, expectedRevision: string) {
  const directory = projectDir(projectRoot), file = path.join(directory, 'project.json');
  return withLibraryLock(directory, async () => {
    const config = await readProject(projectRoot);
    if (hashJson(config) !== expectedRevision) throw new RevisionConflict('Project config revision conflict; tải lại cấu hình trước khi lưu');
    const safeSelection = memorySelectionSchema.parse(selection);
    const next: ProjectConfig = projectSchema.parse({ ...config, memorySelection: safeSelection });
    projectDirCreated(await mkdir(directory, { recursive: true }));
    for (const target of [directory, file]) {
      try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`Không ghi cấu hình qua symlink: ${target}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // A cooperating writer uses the same lock; re-read immediately before replace to detect other editors.
    try { JSON.parse(await readFile(file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (hashJson(await readProject(projectRoot)) !== expectedRevision) throw new RevisionConflict('Project config revision conflict; tải lại cấu hình trước khi lưu');
    await replaceJson(file, next);
    return { selection: safeSelection, revision: hashJson(next) };
  });
}
