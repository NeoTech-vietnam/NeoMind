import { ProjectMemoryRegistry } from '../memory/registry.js';
import { resolveDefaultMemoryRoot } from '../memory/project-root.js';
import { MemoryStore, type MemoryRecord } from '../memory/store.js';
import type { ProjectConfig } from '../domain/schema.js';

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
export function memoryForRun(projectRoot: string, database: string, task: string, policy: ProjectConfig['memorySelection'] = {}): { root: string; records: MemoryRecord[] } | undefined {
  const memory = openProjectMemory(projectRoot, database); if (!memory) return undefined;
  try {
    const words = [...new Set(task.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(word => word.length > 2))];
    const withinScope = (recordScope: string, selected: string) => recordScope === selected || recordScope.startsWith(`${selected.replace(/\/$/, '')}/`);
    const ranked = memory.store.search().filter(record => (!policy.scopes?.length || policy.scopes.some(scope => withinScope(record.header.scope, scope))) && (!policy.tags?.length || policy.tags.every(tag => record.header.tags.includes(tag))))
      .map(record => ({ record, score: words.filter(word => `${record.header.id} ${record.header.tags.join(' ')} ${record.body}`.toLocaleLowerCase().includes(word)).length }))
      .filter(item => !policy.requireTaskMatch || item.score > 0);
    ranked.sort((a, b) => b.score - a.score || a.record.header.id.localeCompare(b.record.header.id));
    let bytes = 0;
    const records: MemoryRecord[] = [];
    for (const { record } of ranked) {
      if (records.length >= (policy.maxRecords ?? 30)) break;
      const size = Buffer.byteLength(record.body);
      if (bytes + size > (policy.maxBodyBytes ?? 16000)) continue;
      bytes += size; records.push(record);
    }
    return { root: memory.root, records };
  } finally { memory.store.close(); }
}

/** Persist only records fully included in the prompt; metadata and displayed text describe the same immutable snapshot. */
export function formatMemorySnapshot(memory: { root: string; records: MemoryRecord[] }, task: string, selectionPolicy?: ProjectConfig['memorySelection']) {
  const words = [...new Set(task.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(word => word.length > 2))];
  const sections: string[] = [], records: { id: string; type: 'context' | 'decision' | 'lesson'; scope: string; revision: string; sources: string[]; selectionReason: string }[] = [];
  let length = 0;
  for (const record of memory.records) {
    const section = `[${record.header.type}:${record.header.id} revision=${record.revision}]\nSources: ${record.header.sources.join(', ')}\n${record.body}`;
    const added = section.length + (sections.length ? 2 : 0);
    if (length + added > 40000) continue;
    const searchable = `${record.header.id} ${record.header.tags.join(' ')} ${record.body}`.toLocaleLowerCase();
    const matches = words.filter(word => searchable.includes(word));
    sections.push(section); length += added;
    records.push({ id: record.header.id, type: record.header.type, scope: record.header.scope, revision: record.revision,
      sources: record.header.sources, selectionReason: matches.length ? `Khớp từ khóa task: ${matches.join(', ')}` : 'Được chọn trong giới hạn context còn lại' });
  }
  return { root: memory.root, text: sections.join('\n\n'), records, ...(selectionPolicy ? { selectionPolicy: structuredClone(selectionPolicy) } : {}) };
}
