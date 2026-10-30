import { closeSync, fsyncSync, openSync } from 'node:fs';

/** Persist a directory entry change. Windows cannot open or flush a directory handle; NTFS journals metadata itself. */
export function syncDirectorySync(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
