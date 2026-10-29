import { ProjectMemoryRegistry } from '../memory/registry.js';
import { resolveDefaultMemoryRoot } from '../memory/project-root.js';
import { MemoryStore, type MemoryRecord } from '../memory/store.js';

export function openProjectMemory(projectRoot: string, database: string): { root: string; store: MemoryStore } | undefined {
  const registry = new ProjectMemoryRegistry(database);
  let configured: string | undefined;
  try { configured = registry.resolve(projectRoot); } finally { registry.close(); }
  let root = configured;
  if (!root) {
    try { root = resolveDefaultMemoryRoot(projectRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  return { root, store: new MemoryStore(root, database) };
}

/** Pin approved records and their revisions as run context, without changing shared memory. */
export function memoryForRun(projectRoot: string, database: string, task: string): { root: string; records: MemoryRecord[] } | undefined {
  const memory = openProjectMemory(projectRoot, database); if (!memory) return undefined;
  try {
    const words = [...new Set(task.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(word => word.length > 2))];
    const ranked = memory.store.search().map(record => ({ record, score: words.filter(word => `${record.header.id} ${record.header.tags.join(' ')} ${record.body}`.toLocaleLowerCase().includes(word)).length }));
    ranked.sort((a, b) => b.score - a.score || a.record.header.id.localeCompare(b.record.header.id));
    let bytes = 0;
    const records = ranked.filter(({ record }) => { const size = Buffer.byteLength(record.body); if (bytes + size > 16000) return false; bytes += size; return true; }).slice(0, 30).map(item => item.record);
    return { root: memory.root, records };
  } finally { memory.store.close(); }
}
