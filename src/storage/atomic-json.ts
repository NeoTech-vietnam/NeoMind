import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * Windows refuses to replace a file another process has open (EPERM/EACCES/EBUSY), e.g. an editor reading a draft while
 * the CLI saves it. Those failures are transient; retry briefly instead of failing the write.
 */
async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 40) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * (attempt + 1), 100)));
    }
  }
}

/** Write JSON to a temporary file and atomically replace `file` with it. */
export async function replaceJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new Error('Value is not JSON serializable');
  try { await writeFile(temporary, `${text}\n`, { encoding: 'utf8', flag: 'wx' }); await replaceFile(temporary, file); }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}
