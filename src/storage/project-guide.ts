import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LEGACY_PROJECT_DIR, PROJECT_DIR } from './project-dir.js';
import { FLOW_AUTHORING_SKILL } from './project-guide-skill.js';

/**
 * The flow-authoring skill NeoMind installs into a project it configures, where Claude Code (and anyone reading
 * `.claude/skills`) finds the runtime rules before authoring a flow. Repositories that never use NeoMind do not get it.
 */
export const PROJECT_GUIDE_PATH = '.claude/skills/neomind-flow-authoring/SKILL.md';
export type ProjectGuideStatus = 'created' | 'up-to-date' | 'modified-kept' | 'replaced';
export interface ProjectGuideResult { path: string; status: ProjectGuideStatus }

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
// A checkout with autocrlf turns the committed file into CRLF; that is still the same guide.
const sameGuide = (text: string) => text.replace(/\r\n/g, '\n') === FLOW_AUTHORING_SKILL;
function readGuide(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); } catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
}

/**
 * Write the guide into `projectRoot`. A guide the user changed is kept unless `force`; the write never follows a
 * symlink and never replaces a file another writer created meanwhile. Synchronous so the first-write hook below also
 * works from the synchronous memory path.
 */
export function installProjectGuide(projectRoot: string, options: { force?: boolean | undefined } = {}): ProjectGuideResult {
  const parts = PROJECT_GUIDE_PATH.split('/'), target = path.join(projectRoot, ...parts);
  let current = projectRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) throw new Error(`Không ghi ${PROJECT_GUIDE_PATH} qua symlink: ${path.relative(projectRoot, current)}`);
    if (index === parts.length - 1) break;
    if (!info) { try { mkdirSync(current); } catch (error) { if (errorCode(error) !== 'EEXIST') throw error; } }
    else if (!info.isDirectory()) throw new Error(`${path.relative(projectRoot, current)} không phải thư mục`);
  }
  const existing = readGuide(target);
  if (existing !== undefined && sameGuide(existing)) return { path: PROJECT_GUIDE_PATH, status: 'up-to-date' };
  if (existing !== undefined && !options.force) return { path: PROJECT_GUIDE_PATH, status: 'modified-kept' };
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, FLOW_AUTHORING_SKILL, { encoding: 'utf8', flag: 'wx' });
    if (existing !== undefined) { renameSync(temporary, target); return { path: PROJECT_GUIDE_PATH, status: 'replaced' }; }
    // A hard link never replaces: a file that appeared since the read above is someone else's and stays.
    try { linkSync(temporary, target); return { path: PROJECT_GUIDE_PATH, status: 'created' }; }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      return { path: PROJECT_GUIDE_PATH, status: sameGuide(readGuide(target) ?? '') ? 'up-to-date' : 'modified-kept' };
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}

/**
 * Call after a write created NeoMind's folder in a project, with what `mkdir(…, { recursive: true })` returned (the
 * first folder it created) or the folder itself. Creating that folder is the project being configured for the first
 * time, so the guide is installed then and only then: later writes, and projects whose folder already exists, leave
 * `.claude/` alone. A failure only warns, because the write that created the folder must not fail over the guide.
 */
export function projectDirCreated(created: string | undefined): void {
  if (!created || ![PROJECT_DIR, LEGACY_PROJECT_DIR].includes(path.basename(created))) return;
  try { installProjectGuide(path.dirname(created)); }
  catch (error) { console.warn(`NeoMind: không cài được ${PROJECT_GUIDE_PATH} (${error instanceof Error ? error.message : String(error)})`); }
}
