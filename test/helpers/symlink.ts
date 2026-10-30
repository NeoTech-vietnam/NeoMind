import { symlink } from 'node:fs/promises';
import type { TestContext } from 'node:test';

/** File symlinks need Developer Mode or elevation on Windows; report and return false instead of failing there. */
export async function fileSymlink(t: TestContext, target: string, link: string): Promise<boolean> {
  try { await symlink(target, link, 'file'); return true; }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.diagnostic('File symlink privilege unavailable on this Windows host; symlink assertions skipped');
    return false;
  }
}
