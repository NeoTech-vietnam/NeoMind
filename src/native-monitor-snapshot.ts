/** One synchronous read projection. Never pass this snapshot to execution or
 * acceptance operations; each subsequent view constructs a fresh instance. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash, loadRecords, safePath } from './storage.js';
import type { ProjectRecord } from './types.js';

export class NativeMonitorSnapshot {
  private inventory?: ProjectRecord[];
  private hashes = new Map<string, string | null>();
  private key: string;
  constructor(private root: string) { this.key = this.rootKey(root); }
  private rootKey(root: string) { const path = resolve(root); return process.platform === 'win32' ? path.toLowerCase() : path; }
  assertRoot(root: string) { if (this.rootKey(root) !== this.key) throw new Error('A monitor snapshot belongs to one project.'); }
  records() { return this.inventory ??= loadRecords(this.root); }
  fingerprints(paths: string[]): Record<string, string | null> {
    return Object.fromEntries(paths.map(path => {
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (!this.hashes.has(key)) {
        const file = safePath(this.root, path);
        if (!existsSync(file)) this.hashes.set(key, null);
        else {
          const info = lstatSync(file);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 20 * 1024 * 1024)
            throw new Error('Native monitor inputs require bounded ordinary unlinked files.');
          this.hashes.set(key, hash(readFileSync(file)));
        }
      }
      return [path, this.hashes.get(key)!];
    }));
  }
}
