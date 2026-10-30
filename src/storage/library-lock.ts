import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stateBase } from '../platform/state-dir.js';

const queues = new Map<string, Promise<unknown>>();
const connections = new Map<string, DatabaseSync>();

export class RevisionConflict extends Error {
  constructor(message: string) { super(message); this.name = 'RevisionConflict'; }
}

function lockDatabase(root: string): string {
  const resolved = path.resolve(root), key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const directory = path.join(stateBase(), 'neomind', 'locks');
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.sqlite`);
}

/**
 * Serialize library mutations across processes (editor, CLI) and within this one. The cross-process lock is a SQLite
 * write transaction, which the OS releases if its owner dies, so a crashed writer never leaves a stale lock behind.
 */
export function withLibraryLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const file = lockDatabase(root);
  const run = async () => {
    let database = connections.get(file);
    if (!database) { database = new DatabaseSync(file); database.exec('PRAGMA busy_timeout = 10000'); connections.set(file, database); }
    try { database.exec('BEGIN IMMEDIATE'); }
    catch (error) { throw new Error(`Thư viện flow/profile đang bận ở process khác; thử lại sau (${error instanceof Error ? error.message : String(error)})`); }
    try { return await operation(); } finally { database.exec('COMMIT'); }
  };
  const result = (queues.get(file) ?? Promise.resolve()).then(run, run);
  queues.set(file, result.catch(() => undefined));
  return result;
}

export function revisionOf(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
