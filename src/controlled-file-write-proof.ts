import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hash, safePath } from './storage.js';

export interface ControlledFileWriteEntry { operation: string; path: string; previous_hash: string | null; sha256: string }
/** Read-only verification shared by file-write recovery and producer repair.
 * The mutable summary flag alone never authorizes replacing generated output. */
export function controlledFileWriteProof(root: string, invocation: string, bindingHash: string,
  entry: ControlledFileWriteEntry, requireCompletion = true) {
  if (!/^[a-f0-9]{64}$/.test(bindingHash) || !/^[a-f0-9]{64}$/.test(entry.operation) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.previous_hash !== null && !/^[a-f0-9]{64}$/.test(entry.previous_hash) ||
      entry.operation !== hash(JSON.stringify({ binding_hash: bindingHash, path: entry.path, previous_hash: entry.previous_hash, sha256: entry.sha256 })))
    throw new Error('The file operation identity differs from its bound write.');
  const folder = `.neomind/controlled-tools/${hash(invocation)}/writes/${entry.operation}`;
  const read = (name: string, limit = 128 * 1024) => {
    const path = `${folder}/${name}`, target = safePath(root, path);
    for (let cursor = target; cursor !== resolve(root); cursor = dirname(cursor))
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('File operation proof cannot follow links.');
    const info = lstatSync(target);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('File operation proof is not a bounded ordinary file.');
    return readFileSync(target);
  };
  const intent = { schema_version: 1, operation: entry.operation, binding_hash: bindingHash, path: entry.path,
    previous_hash: entry.previous_hash, sha256: entry.sha256 };
  const intentBytes = read('intent.json', 8192), next = read('next.utf8');
  const previous = entry.previous_hash === null ? undefined : read('previous.utf8');
  if (intentBytes.toString('utf8') !== `${JSON.stringify(intent, null, 2)}\n` || hash(next) !== entry.sha256 ||
      previous && hash(previous) !== entry.previous_hash) throw new Error('File operation history differs from its declared content.');
  const completion = `${JSON.stringify({ ...intent, kind: 'completed-controlled-file-write' }, null, 2)}\n`;
  const completionPath = `${folder}/completion.json`;
  if (requireCompletion || existsSync(safePath(root, completionPath))) {
    if (read('completion.json', 8192).toString('utf8') !== completion) throw new Error('File operation completion changed.');
  }
  return { completion, completion_path: completionPath, intent_sha256: hash(intentBytes), next_sha256: hash(next),
    ...(previous ? { previous_sha256: hash(previous) } : {}) };
}
