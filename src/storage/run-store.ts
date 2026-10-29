import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

/** Local run state root is explicitly supplied; paths never derive from project-controlled names. */
export class RunStore {
  private constructor(private readonly root: string) {}
  static async open(root: string): Promise<RunStore> {
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory()) throw new Error('Run state root must be a directory');
    return new RunStore(canonical);
  }
  private directory(runId: string) { return path.join(this.root, idSchema.parse(runId)); }
  async create(runId: string): Promise<string> {
    const dir = this.directory(runId);
    await mkdir(dir, { mode: 0o700 }); // exclusive: never replace a previous run
    return path.join(dir, 'events.jsonl');
  }
  async journal(runId: string): Promise<string> {
    const dir = this.directory(runId), stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Run directory is not a real directory');
    const file = path.join(dir, 'events.jsonl');
    try { if ((await lstat(file)).isSymbolicLink()) throw new Error('Run journal cannot be a symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return file;
  }
  async list(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && idSchema.safeParse(entry.name).success).map(entry => entry.name).sort();
  }
}
