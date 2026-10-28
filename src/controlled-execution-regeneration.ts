import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atomicWrite, hash, safePath, withOperationLock } from './storage.js';
import { workspacePathLockKey } from './workspace.js';
import { validateProcedurePath } from './procedures.js';
import { ControlledExecutionError, type ControlledExecutionBinding } from './controlled-execution.js';
import { controlledFileWriteProof } from './controlled-file-write-proof.js';

const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const covers = (path: string, scopes: readonly string[]) => scopes.some(scope => key(path) === key(scope) || key(path).startsWith(`${key(scope)}/`));
/** Private worker journal, never caller-supplied repair IDs or replacement hashes. */
export function authorizedControlledExecutionRepair(root: string, invocationId: string,
  before: Record<string, string>, current: Record<string, string>, binding: ControlledExecutionBinding,
  repairInvocations: readonly string[] = [invocationId]) {
  const path = `.neomind/controlled-tools/${hash(invocationId)}/state.json`;
  if (!existsSync(safePath(root, path))) return undefined;
  const state = JSON.parse(readFileSync(safePath(root, path), 'utf8'));
  if (state.schema_version !== 1 || !state.reads || !Array.isArray(state.writes)) return undefined;
  const changed = Object.keys(before).filter(path => before[path] !== current[path]);
  if (!changed.length || Object.keys(current).length !== Object.keys(before).length) return undefined;
  const journals = repairInvocations.map(id => ({ id, path: `.neomind/controlled-tools/${hash(id)}/state.json` })).filter(item => existsSync(safePath(root, item.path)))
    .map(item => ({ ...item, bytes: readFileSync(safePath(root, item.path)) }))
    .map(item => ({ ...item, state: JSON.parse(item.bytes.toString('utf8')) }));
  if (journals.some(item => item.state.schema_version !== 1 || !Array.isArray(item.state.writes))) return undefined;
  const operations: string[] = [];
  for (const path of changed) {
    if (!covers(path, binding.implementation_paths) || covers(path, [...binding.verification_paths,
      ...(binding.protected_paths ?? []), ...Object.keys(binding.preserved_hashes ?? {})]) ||
        state.reads[key(path)] !== current[path]) return undefined;
    let digest = before[path];
    for (const journal of journals) for (const write of journal.state.writes ?? []) if (key(write.path ?? '') === key(path) && write.completed === true && write.previous_hash === digest) {
      try { controlledFileWriteProof(root, journal.id, journal.state.binding_hash, write); }
      catch { return undefined; }
      digest = write.sha256; operations.push(write.operation);
    }
    if (digest !== current[path]) return undefined;
  }
  return { journal_path: path, journal_sha256: hash(readFileSync(safePath(root, path))), changed_paths: changed, operations,
    write_journals: journals.map(item => ({ path: item.path, sha256: hash(item.bytes) })) };
}

/** Archive every exact backend-created output before removing any live file.
 * A durable owning operation must already exist; partial work stays uncertain. */
export function archiveControlledRegenerationOutputs(root: string, directory: string,
  expected: Record<string, string>, binding: ControlledExecutionBinding) {
  if (!/^\.neomind\/controlled\/executions\/[a-f0-9-]{36}\/regeneration$/.test(directory))
    throw new ControlledExecutionError('INVALID_EXECUTION', 'Regeneration requires a backend-owned archive.');
  const archivePath = (path: string) => {
    for (let current = safePath(root, directory); current !== resolve(root); current = dirname(current)) {
      if (existsSync(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()))
        throw new ControlledExecutionError('INPUT_CHANGED', 'Regeneration archive ancestors must be ordinary backend directories.');
    }
    return safePath(root, path);
  };
  const read = (path: string) => {
    if (!covers(path, binding.implementation_paths) || covers(path, [...binding.verification_paths,
      ...(binding.protected_paths ?? []), ...Object.keys(binding.preserved_hashes ?? {})]))
      throw new ControlledExecutionError('SCOPE_DENIED', 'Regeneration cannot replace another owner or protected artifact.');
    const target = validateProcedurePath(root, path), info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 10 * 1024 * 1024)
      throw new ControlledExecutionError('INPUT_CHANGED', 'A previously generated output is no longer a bounded ordinary file.');
    const bytes = readFileSync(target);
    if (bytes.length > 10 * 1024 * 1024 || hash(bytes) !== expected[path])
      throw new ControlledExecutionError('INPUT_CHANGED', 'A previously generated output changed outside its saved execution.');
    return bytes;
  };
  const outputs = Object.keys(expected);
  const locked = <T>(index: number, operation: () => T): T => index === outputs.length ? operation()
    : withOperationLock(root, workspacePathLockKey(outputs[index]!), () => locked(index + 1, operation));
  return locked(0, () => {
    // Validate the whole set before preserving or removing any live artifact.
    const files = outputs.map(path => ({ path, bytes: read(path), archive_path: `${directory}/${hash(path)}.bin` }));
    for (const file of files) {
      atomicWrite(archivePath(file.archive_path), file.bytes);
      if (!readFileSync(archivePath(file.archive_path)).equals(file.bytes))
        throw new ControlledExecutionError('INPUT_CHANGED', 'A regeneration archive failed its content check.');
    }
    const manifest = files.map(file => ({ path: file.path, sha256: expected[file.path]!, bytes: file.bytes.length, archive_path: file.archive_path }));
    const manifestPath = `${directory}/manifest.json`;
    atomicWrite(archivePath(manifestPath), JSON.stringify({ schema_version: 1, files: manifest }, null, 2) + '\n');
    for (const file of files) read(file.path);
    for (const file of files) { read(file.path); unlinkSync(validateProcedurePath(root, file.path)); }
    atomicWrite(archivePath(`${directory}/removed.json`), JSON.stringify({ schema_version: 1, files: manifest, removed: true }, null, 2) + '\n');
    return { manifest_path: manifestPath, manifest_sha256: hash(readFileSync(safePath(root, manifestPath))), files: manifest };
  });
}
