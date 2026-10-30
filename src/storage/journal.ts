import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const runEventSchema = z.strictObject({
  schemaVersion: z.literal(1), eventId: z.string().min(1), runId: z.string().min(1),
  sequence: z.number().int().min(1), requestId: z.string().min(1),
  type: z.string().min(1), timestamp: z.iso.datetime(), payload: z.json(),
});
export type RunEvent = z.infer<typeof runEventSchema>;
export type NewRunEvent = Omit<RunEvent, 'sequence'>;

export class JournalCorruption extends Error {
  constructor(message: string) { super(message); this.name = 'JournalCorruption'; }
}

function decode(data: Buffer, runId: string): { events: RunEvent[]; validBytes: number } {
  const lastNewline = data.lastIndexOf(0x0a);
  // An interrupted append may leave bytes after the last complete newline.
  const validBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, validBytes)); }
  catch { throw new JournalCorruption('Invalid UTF-8 in complete journal data'); }
  const lines = text.split('\n');
  lines.pop();
  const events: RunEvent[] = [];
  const eventIds = new Set<string>();
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new JournalCorruption(`Invalid JSON at complete line ${index + 1}`); }
    const parsed = runEventSchema.safeParse(value);
    if (!parsed.success) throw new JournalCorruption(`Invalid event schema at complete line ${index + 1}`);
    const event = parsed.data;
    if (event.runId !== runId || event.sequence !== index + 1 || eventIds.has(event.eventId)) {
      throw new JournalCorruption(`Wrong run, sequence or duplicate event ID at line ${index + 1}`);
    }
    eventIds.add(event.eventId); events.push(event);
  }
  return { events, validBytes };
}

/**
 * Append-only journal for one externally coordinated writer. This class is not a lock:
 * callers must hold an exclusive cross-process run-owner lease before writing.
 */
export class SingleOwnerJournal {
  constructor(readonly file: string, readonly runId: string) {}

  async read(): Promise<RunEvent[]> {
    try { return decode(await readFile(this.file), this.runId).events; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async append(input: NewRunEvent, expectedSequence: number): Promise<RunEvent> {
    if (input.runId !== this.runId) throw new Error('Run ID does not match journal');
    await mkdir(path.dirname(this.file), { recursive: true });
    // Not append mode: Windows cannot truncate an append-only handle, so writes use an explicit offset.
    const handle = await open(this.file, constants.O_RDWR | constants.O_CREAT);
    try {
      const bytes = await handle.readFile();
      const { events, validBytes } = decode(bytes, this.runId);
      if (events.length !== expectedSequence) throw new Error('Journal sequence conflict');
      if (events.some(e => e.eventId === input.eventId)) throw new Error('Duplicate event ID');
      const event = runEventSchema.parse({ ...input, sequence: events.length + 1 });
      if (validBytes !== bytes.length) await handle.truncate(validBytes);
      const line = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      for (let offset = 0; offset < line.length;) offset += (await handle.write(line, offset, line.length - offset, validBytes + offset)).bytesWritten;
      await handle.sync();
      return event;
    } finally { await handle.close(); }
  }
}
