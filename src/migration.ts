import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { legacyManagedRoot, managedRoot, retryWindowsFileOperation } from './storage.js';

// Receipt states that represent native work that has not settled. Migrating while
// any of these is present risks losing or corrupting an in-flight invocation.
const settledNativeStates = ['completed', 'failed', 'interrupted', 'blocked', 'orphaned'];

export interface StorageMigration {
  root: string;
  from: string;
  to: string;
  moved: boolean;
}

/**
 * Move a project's legacy managed directory to its new physical name without
 * rewriting a single file. The rename preserves every byte and logical
 * path value; only the top-level directory name changes. The operation refuses
 * to run whenever moving the directory could lose data or interrupt live work:
 * dual roots, links or junctions, any lock file, or an unsettled native receipt.
 */
export function migrateStorage(root: string): StorageMigration {
  if (!existsSync(resolve(root))) throw new Error(`Project root does not exist: ${root}`);
  const base = realpathSync(resolve(root));
  const gate = join(base, '.taskforces-migration.lock');
  if (existsSync(gate))
    throw new Error('Storage migration lock exists; inspect the active or interrupted migration before retrying.');
  const legacy = join(base, legacyManagedRoot);
  const target = join(base, managedRoot);
  const legacyExists = existsSync(legacy);
  const targetExists = existsSync(target);

  if (legacyExists && targetExists)
    throw new Error(
      'Both the legacy and TaskForces storage roots exist. Resolve the dual root by hand before migrating; migration will never merge or overwrite either directory.',
    );
  if (!legacyExists) {
    if (targetExists) {
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory())
        throw new Error('TaskForces storage root must be a real directory, not a link or junction.');
      return { root: base, from: legacy, to: target, moved: false };
    }
    throw new Error('No legacy storage root was found to migrate.');
  }

  // Only ever move a real in-place directory. A link, junction, or non-directory
  // could redirect the move outside the project or destroy the link target.
  const stat = lstatSync(legacy);
  if (stat.isSymbolicLink())
    throw new Error('The legacy storage root is a symbolic link; refusing to migrate a linked directory.');
  if (!stat.isDirectory()) throw new Error('The legacy storage root is not a directory.');
  if ((process.platform === 'win32' ? realpathSync(legacy).toLowerCase() : realpathSync(legacy)) !==
      (process.platform === 'win32' ? legacy.toLowerCase() : legacy))
    throw new Error('The legacy storage root resolves through a link or junction; refusing to migrate.');

  // External gate survives the rename. Existing writers hold their own locks;
  // new core operations fail before resolving a path into either storage root.
  let fd: number;
  try { fd = openSync(gate, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('Storage migration lock exists; inspect the active or interrupted migration before retrying.');
  }
  try {
    assertNoActiveLocks(legacy);
    assertNoActiveNativeWork(legacy);
    if (existsSync(target)) throw new Error('Both storage roots exist; migration never overwrites.');
    // No copy fallback: signed bytes remain untouched or the rename fails.
    retryWindowsFileOperation(() => renameSync(legacy, target));
  } finally {
    closeSync(fd);
    unlinkSync(gate);
  }
  return { root: base, from: legacy, to: target, moved: true };
}

function assertNoActiveLocks(legacy: string): void {
  if (existsSync(join(legacy, 'write.lock')))
    throw new Error(
      'A project write lock is present. A live or malformed lock must be resolved before migration; migration will not remove it.',
    );
  for (const sub of ['operations', 'tools']) {
    const directory = join(legacy, sub);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith('.lock'))
        throw new Error(
          `A lock is present at ${sub}/${entry.name}. Resolve active or malformed locks before migration.`,
        );
  }
}

function assertNoActiveNativeWork(legacy: string): void {
  const receipts = join(legacy, 'native', 'receipts');
  if (!existsSync(receipts)) return;
  for (const entry of readdirSync(receipts, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(join(receipts, entry.name), 'utf8')).state;
    } catch {
      throw new Error(
        `Native receipt ${entry.name} could not be read; refusing to migrate while native state is indeterminate.`,
      );
    }
    if (typeof state !== 'string' || !settledNativeStates.includes(state))
      throw new Error(
        `Native invocation ${entry.name} is still active (state ${String(state)}); stop or settle it before migrating.`,
      );
  }
}
