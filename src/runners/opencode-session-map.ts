import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const logicalId = z.string().uuid();
const schema = z.strictObject({ version: z.literal(1), logicalId, sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  workspace: z.string().min(1), provider: z.string().min(1), model: z.string().min(1) });
export type OpenCodeSessionMapping = z.infer<typeof schema>;

/** Mapping is committed before a prompt so an interrupted dispatch can never silently resume a different session. */
export class OpenCodeSessionMap {
  constructor(private readonly directory: string) {}
  private file(id: string) { return path.join(this.directory, `${logicalId.parse(id)}.json`); }
  async get(id: string): Promise<OpenCodeSessionMapping | undefined> {
    let raw: string;
    try { raw = await readFile(this.file(id), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const result = schema.parse(JSON.parse(raw));
    if (result.logicalId !== id) throw new Error('OpenCode session mapping identity mismatch');
    return result;
  }
  async create(value: OpenCodeSessionMapping): Promise<void> {
    const checked = schema.parse(value), target = this.file(checked.logicalId);
    await mkdir(this.directory, { recursive: true });
    const temp = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(checked), { flag: 'wx', mode: 0o600 });
      // link() fails if the mapping exists, so two dispatches cannot both claim one logical session.
      await link(temp, target);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
