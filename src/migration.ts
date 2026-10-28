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
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { legacyManagedRoots, managedRoot, retryWindowsFileOperation, validateMetadata, readConfig } from './storage.js';
import { nativeAutomationPolicy, readAutomationPolicy } from './manager.js';
import { assertNoLiveHost } from './host-authority.js';
import { canonicalManagedPath, readStorageLayout, ensureRequestInLayout, groupedRecordPath, recordRequest, managedRecordDirectories,
  writeRequestFolder, type StorageLayout } from './storage-layout.js';
import type { ProjectRecord } from './types.js';

// Receipt states that represent native work that has not settled. Migrating while
// any of these is present risks losing or corrupting an in-flight invocation.
const settledNativeStates = ['completed', 'failed', 'interrupted', 'blocked', 'orphaned'];

export interface StorageMigration {
  root: string;
  from: string;
  to: string;
  moved: boolean;
  backup?: string;
  records_relocated?: number;
  migration_id?: string;
  workforce_activated?: boolean;
}
export interface StorageMigrationOptions { activate_workforce?: boolean }

interface MigrationFile { path: string; sha256: string; bytes: number }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface MigrationJournal {
  schema_version: 1; id: string; owner_pid: number; original_root: string;
  phase: 'preparing' | 'prepared' | 'completed'; staged_files?: MigrationFile[];
}
function journalPath(base: string) { return join(base, '.workforce-migration.json'); }
function saveJournal(base: string, journal: MigrationJournal): void {
  const path = journalPath(base), temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx' }); renameSync(temporary, path);
}
function migrationPaths(base: string, id: string, originalRoot: string) {
  if (!/^[a-f0-9-]{36}$/.test(id) || ![managedRoot, ...legacyManagedRoots].includes(originalRoot))
    throw new Error('Invalid migration checkpoint identity.');
  return { stage: join(base, `.workforce-staging-${id}`), backup: join(base, '.workforce-backups', id, originalRoot),
    source: join(base, originalRoot), target: join(base, managedRoot) };
}
/** Resume only our proven absent owner's root-switch checkpoint; no model or identity guesses. */
function recoverInterruptedMigration(base: string): void {
  const path = journalPath(base);
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
    throw new Error('Invalid storage migration checkpoint.');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as MigrationJournal;
  if (journal?.schema_version !== 1 || !Number.isSafeInteger(journal.owner_pid) || journal.owner_pid < 1 ||
      !['preparing', 'prepared', 'completed'].includes(journal.phase)) throw new Error('Invalid storage migration checkpoint.');
  if (journal.phase === 'completed') return;
  try { process.kill(journal.owner_pid, 0); throw new Error('Storage migration owner is still active.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const paths = migrationPaths(base, journal.id, journal.original_root);
  const gates = [managedRoot, ...legacyManagedRoots].map(name => join(base, `${name}-migration.lock`));
  for (const gate of gates) {
    if (!existsSync(gate)) continue;
    const lease = JSON.parse(readFileSync(gate, 'utf8'));
    if (lease.id !== journal.id || lease.pid !== journal.owner_pid) throw new Error('Storage migration lock identity differs from checkpoint.');
  }
  if (existsSync(paths.backup)) {
    if (journal.phase !== 'prepared' || !Array.isArray(journal.staged_files)) throw new Error('Migration switch lacks its verified staging baseline.');
    const candidate = existsSync(paths.target) ? paths.target : paths.stage;
    if (!existsSync(candidate) || JSON.stringify(inventory(candidate)) !== JSON.stringify(journal.staged_files))
      throw new Error('Interrupted migration stage changed; preserve checkpoint for recovery.');
    if (candidate === paths.stage) retryWindowsFileOperation(() => renameSync(paths.stage, paths.target));
  } else if (!existsSync(paths.source)) throw new Error('Interrupted migration source and backup are both unavailable.');
  // A pre-switch interruption leaves its unchanged source active; a completed switch is now verified.
  saveJournal(base, { ...journal, phase: 'completed' });
  for (const gate of gates) if (existsSync(gate)) unlinkSync(gate);
}
function inventory(directory: string, prefix = ''): MigrationFile[] {
  const results: MigrationFile[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = [prefix, entry.name].filter(Boolean).join('/'), target = join(directory, path), info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error('Migration cannot follow linked managed paths.');
    if (info.isDirectory()) results.push(...inventory(directory, path));
    else {
      if (!info.isFile() || info.nlink !== 1) throw new Error('Migration requires ordinary unlinked managed files.');
      const bytes = readFileSync(target); results.push({ path, sha256: digest(bytes), bytes: bytes.length });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}
function unchanged(directory: string, files: MigrationFile[], layout?: StorageLayout): void {
  for (const file of files) {
    const moved = layout?.relocations.find(item => canonicalManagedPath(item.from) === `${managedRoot}/${file.path}`);
    const path = join(directory, moved ? moved.to.slice(managedRoot.length + 1) : file.path);
    if (!existsSync(path) || !lstatSync(path).isFile() || digest(readFileSync(path)) !== file.sha256)
      throw new Error(`Migration input changed or staged bytes differ: ${file.path}`);
  }
}
function groupRecords(base: string, stage: string, originalRoot: string): StorageLayout {
  const layout = readStorageLayout(base, relative(base, stage)), records: ProjectRecord[] = [];
  const flat = join(stage, 'records');
  if (!existsSync(flat)) return layout;
  const read = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) read(path);
      else if (entry.name.endsWith('.md')) {
        const source = readFileSync(path, 'utf8'), match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
        if (!match) throw new Error(`Malformed engineering record during migration: ${entry.name}`);
        const meta = validateMetadata(parse(match[1]!));
        if (!meta || !/^[A-Z][A-Z0-9-]+$/.test(meta.id) || !meta.data || !Array.isArray(meta.links) ||
            records.some(item => item.meta.id === meta.id)) throw new Error('Invalid or duplicate migration record identity.');
        records.push({ meta, body: match[2]!, path: `${originalRoot}/${relative(stage, path).replaceAll('\\', '/')}` });
      }
    }
  };
  // Include already-grouped context when an older partially-upgraded project
  // also contains flat records. Membership follows real links, never filenames.
  for (const directory of managedRecordDirectories(base, relative(base, stage))) {
    const path = join(base, directory);
    if (existsSync(path)) read(path);
  }
  for (const record of records.filter(item => ['manager-workflow', 'lightweight-workflow', 'workforce-request'].includes(String(item.meta.data.kind))))
    ensureRequestInLayout(layout, record);
  for (const record of records.filter(item => item.path.startsWith(`${originalRoot}/records/`))) {
    const request = recordRequest(layout, record, records), to = groupedRecordPath(record, request, !request);
    const source = join(stage, record.path.slice(originalRoot.length + 1)), target = join(stage, to.slice(managedRoot.length + 1));
    mkdirSync(dirname(target), { recursive: true }); renameSync(source, target);
    layout.relocations.push({ from: record.path, to, record_id: record.meta.id });
  }
  for (const request of layout.requests) writeRequestFolder(base, relative(base, stage), request);
  return layout;
}

/**
 * Stage a byte-preserving WorkForce layout, then switch roots under a writer
 * fence. Historical record identity paths resolve through the relocation map.
 * A verified original tree stays outside active record discovery for rollback.
 */
export function migrateStorage(root: string, options: StorageMigrationOptions = {}): StorageMigration {
  if (!existsSync(resolve(root))) throw new Error(`Project root does not exist: ${root}`);
  const base = realpathSync(resolve(root));
  recoverInterruptedMigration(base);
  const gates = [managedRoot, ...legacyManagedRoots].map(name => join(base, `${name}-migration.lock`));
  if (gates.some(gate => existsSync(gate)))
    throw new Error('Storage migration lock exists; inspect the active or interrupted migration before retrying.');
  const present = [managedRoot, ...legacyManagedRoots].filter((name) => existsSync(join(base, name)));
  if (present.length > 1)
    throw new Error('Both the legacy and NeoMind storage roots exist. Resolve conflicting roots before migrating; migration never merges or overwrites.');
  if (!present.length) throw new Error('No legacy storage root was found to migrate.');
  const originalRoot = present[0]!, legacy = join(base, originalRoot);
  const target = join(base, managedRoot);
  const legacyExists = existsSync(legacy);
  const targetExists = existsSync(target);
  const activation = options.activate_workforce === true ? {
    config: { ...readConfig(base), execution_engine: 'opencode', copilot_integration: 'local' },
    automation: { ...(existsSync(join(legacy, 'automation.json')) ? readAutomationPolicy(base) : nativeAutomationPolicy()), execution_mode: 'neomind-controlled' },
  } : undefined;
  const activationNeeded = activation && (
    JSON.stringify(activation.config) !== JSON.stringify(JSON.parse(readFileSync(join(legacy, 'config.json'), 'utf8'))) ||
    !existsSync(join(legacy, 'automation.json')) ||
    JSON.stringify(activation.automation) !== JSON.stringify(JSON.parse(readFileSync(join(legacy, 'automation.json'), 'utf8')))
  );

  if (legacyExists && targetExists && legacy !== target)
    throw new Error(
      'Both the legacy and NeoMind storage roots exist. Resolve the dual root by hand before migrating; migration will never merge or overwrite either directory.',
    );

  // Only ever move a real in-place directory. A link, junction, or non-directory
  // could redirect the move outside the project or destroy the link target.
  const stat = lstatSync(legacy);
  if (stat.isSymbolicLink())
    throw new Error('The legacy storage root is a symbolic link; refusing to migrate a linked directory.');
  if (!stat.isDirectory()) throw new Error('The legacy storage root is not a directory.');
  if ((process.platform === 'win32' ? realpathSync(legacy).toLowerCase() : realpathSync(legacy)) !==
      (process.platform === 'win32' ? legacy.toLowerCase() : legacy))
    throw new Error('The legacy storage root resolves through a link or junction; refusing to migrate.');
  if (legacy === target && !activationNeeded && !inventory(legacy).some(file => /^records\/.*\.md$/.test(file.path)))
    return { root: base, from: legacy, to: target, moved: false, ...(activation ? { workforce_activated: true } : {}) };

  // External gate survives the rename. Existing writers hold their own locks;
  // new core operations fail before resolving a path into either storage root.
  const id = randomUUID(), descriptors: Array<{ path: string; fd: number }> = [];
  try { for (const path of gates) { const fd = openSync(path, 'wx'); descriptors.push({ path, fd });
      writeFileSync(fd, JSON.stringify({ id, pid: process.pid, at: new Date().toISOString() })); } }
  catch (error) {
    for (const item of descriptors) { closeSync(item.fd); unlinkSync(item.path); }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('Storage migration lock exists; inspect the active or interrupted migration before retrying.');
  }
  const { stage, backup } = migrationPaths(base, id, originalRoot);
  const journal: MigrationJournal = { schema_version: 1, id, owner_pid: process.pid, original_root: originalRoot, phase: 'preparing' };
  let sourceMoved = false, committed = false, journalWritten = false;
  try {
    assertNoLiveHost(base);
    assertNoActiveLocks(legacy);
    assertNoActiveNativeWork(legacy);
    saveJournal(base, journal); journalWritten = true;
    const files = inventory(legacy);
    mkdirSync(stage, { recursive: true });
    for (const file of files) { const destination = join(stage, file.path); mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(legacy, file.path), destination); }
    const layout = groupRecords(base, stage, originalRoot);
    writeFileSync(join(stage, 'storage-layout.json'), JSON.stringify(layout, null, 2) + '\n');
    const configChanges: Array<{ path: string; before_sha256: string | null; after_sha256: string }> = [];
    if (activation) for (const [path, value] of [['config.json', activation.config], ['automation.json', activation.automation]] as const) {
      const destination = join(stage, path), previous = existsSync(destination) ? readFileSync(destination) : undefined;
      if (previous && JSON.stringify(JSON.parse(previous.toString('utf8'))) === JSON.stringify(value)) continue;
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      writeFileSync(destination, bytes);
      configChanges.push({ path, before_sha256: previous ? digest(previous) : null, after_sha256: digest(bytes) });
    }
    unchanged(stage, files.filter(file => file.path !== 'storage-layout.json' && !configChanges.some(change => change.path === file.path)), layout);
    const receipt = { schema_version: 1, id, from: originalRoot, to: managedRoot, created_at: new Date().toISOString(), files,
      relocations: layout.relocations, config_changes: configChanges, backup: relative(base, backup).replaceAll('\\', '/') };
    mkdirSync(join(stage, 'migrations'), { recursive: true });
    writeFileSync(join(stage, 'migrations', `${id}.json`), JSON.stringify(receipt, null, 2) + '\n');
    // Recheck source immediately before switching ownership; the backup remains outside active discovery.
    if (JSON.stringify(inventory(legacy)) !== JSON.stringify(files)) throw new Error('Migration source changed during staging.');
    journal.phase = 'prepared'; journal.staged_files = inventory(stage); saveJournal(base, journal);
    mkdirSync(dirname(backup), { recursive: true });
    retryWindowsFileOperation(() => renameSync(legacy, backup)); sourceMoved = true;
    retryWindowsFileOperation(() => renameSync(stage, target)); committed = true;
    saveJournal(base, { ...journal, phase: 'completed' });
    return { root: base, from: legacy, to: target, moved: true, backup, migration_id: id, records_relocated: layout.relocations.length,
      ...(activation ? { workforce_activated: true } : {}) };
  } catch (error) {
    if (sourceMoved && !committed && !existsSync(legacy)) retryWindowsFileOperation(() => renameSync(backup, legacy));
    if (journalWritten) saveJournal(base, { ...journal, phase: 'completed' });
    throw error;
  } finally {
    for (const item of descriptors) { closeSync(item.fd); unlinkSync(item.path); }
  }
}

/** Roll back only before any post-migration file write; retain both trees outside active discovery. */
export function rollbackStorageMigration(root: string, id: string): StorageMigration {
  const base = realpathSync(resolve(root));
  recoverInterruptedMigration(base);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid migration identity.');
  const journal = JSON.parse(readFileSync(journalPath(base), 'utf8')) as MigrationJournal;
  if (journal.id !== id || journal.phase !== 'completed' || !journal.staged_files)
    throw new Error('Rollback requires the latest completed migration baseline.');
  const paths = migrationPaths(base, id, journal.original_root);
  const gates = [managedRoot, ...legacyManagedRoots].map(name => join(base, `${name}-migration.lock`));
  if (gates.some(path => existsSync(path))) throw new Error('Storage migration lock exists.');
  assertNoActiveLocks(paths.target); assertNoActiveNativeWork(paths.target);
  if (JSON.stringify(inventory(paths.target)) !== JSON.stringify(journal.staged_files))
    throw new Error('New WorkForce writes exist; preserve them and use forward recovery instead of rollback.');
  const receipt = JSON.parse(readFileSync(join(paths.target, 'migrations', `${id}.json`), 'utf8'));
  unchanged(paths.backup, receipt.files);
  if (paths.source !== paths.target && existsSync(paths.source)) throw new Error('Rollback source root already exists.');
  const preserved = join(dirname(paths.backup), 'workforce-after-rollback');
  if (existsSync(preserved)) throw new Error('Rollback checkpoint already exists.');
  const leases: Array<{ path: string; fd: number }> = [];
  let moved = false;
  try {
    for (const path of gates) { const fd = openSync(path, 'wx'); leases.push({ path, fd }); writeFileSync(fd, JSON.stringify({ id, pid: process.pid })); }
    // Capture again under the writer fence before either root moves.
    if (JSON.stringify(inventory(paths.target)) !== JSON.stringify(journal.staged_files)) throw new Error('WorkForce changed before rollback.');
    retryWindowsFileOperation(() => renameSync(paths.target, preserved)); moved = true;
    retryWindowsFileOperation(() => renameSync(paths.backup, paths.source));
    return { root: base, from: paths.target, to: paths.source, moved: true, backup: preserved, migration_id: id };
  } catch (error) {
    if (moved && !existsSync(paths.target) && existsSync(preserved)) retryWindowsFileOperation(() => renameSync(preserved, paths.target));
    throw error;
  } finally { for (const lease of leases) { closeSync(lease.fd); unlinkSync(lease.path); } }
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
