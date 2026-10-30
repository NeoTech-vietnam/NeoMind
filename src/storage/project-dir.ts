import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * NeoMind's folder inside a project (project.json, flows, profiles, memory). It is `neomind/` so tools that hide
 * dot-folders (Obsidian) can see flows and canvas boards; projects created before keep working from `.neomind/`
 * until they are migrated.
 */
export const PROJECT_DIR = 'neomind';
export const LEGACY_PROJECT_DIR = '.neomind';
const markers = ['project.json', 'flows', 'profiles', 'memory'];

/** A `neomind/` folder is NeoMind's when it is empty or holds NeoMind data, never a project's own `neomind` source folder. */
function isNeoMindFolder(directory: string): boolean {
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory()) return false;
    const names = readdirSync(directory);
    return names.length === 0 || names.some(name => markers.includes(name));
  } catch { return false; }
}

/** NeoMind's folder in `projectRoot`: `neomind/`, a legacy `.neomind/` that has not been migrated, or `neomind/` for a new project. */
export function projectDir(projectRoot: string): string {
  const current = path.join(projectRoot, PROJECT_DIR), legacy = path.join(projectRoot, LEGACY_PROJECT_DIR);
  if (isNeoMindFolder(current)) return current;
  if (existsSync(legacy)) return legacy;
  // A project's own `neomind/` folder is left alone; NeoMind then keeps its data in `.neomind/`.
  return existsSync(current) ? legacy : current;
}

/** True for paths (repository-relative, `/`-separated) inside either NeoMind folder name. */
export function isProjectMetadataPath(file: string): boolean {
  return [PROJECT_DIR, LEGACY_PROJECT_DIR].some(name => file === name || file.startsWith(`${name}/`));
}

/** Rename a legacy `.neomind/` to `neomind/`. Git sees the move as a rename once the result is committed. */
export async function migrateProjectDir(projectRoot: string): Promise<{ migrated: boolean; directory: string }> {
  const current = path.join(projectRoot, PROJECT_DIR), legacy = path.join(projectRoot, LEGACY_PROJECT_DIR);
  if (!existsSync(legacy)) return { migrated: false, directory: projectDir(projectRoot) };
  if (lstatSync(legacy).isSymbolicLink()) throw new Error(`${LEGACY_PROJECT_DIR} là symlink; chuyển tay để tránh di chuyển nhầm dữ liệu`);
  if (existsSync(current)) throw new Error(`Đã có cả ${PROJECT_DIR}/ và ${LEGACY_PROJECT_DIR}/; gộp tay rồi xóa ${LEGACY_PROJECT_DIR}/`);
  await rename(legacy, current);
  return { migrated: true, directory: current };
}
