import { execFileSync } from 'node:child_process';
import { gitConfigEnv } from '../workspace/git-env.js';
import { activeMemory, semanticScores } from '../memory/retrieval.js';
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
export function taskPaths(task: string): string[] {
  const paths = task.match(/(?:^|[\s`'"(])((?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]+\/?)/gu) ?? [];
  return [...new Set(paths.map(value => value.trim().replace(/^[`'"(]/, '').replace(/\/$/, ''))
    .filter(value => value.split('/').every(part => part !== '.' && part !== '..') && !value.includes('://')))];
}

export function inferProjectPaths(projectRoot: string, task: string): string[] {
  const explicit = taskPaths(task), words = new Set(task.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
  const env: NodeJS.ProcessEnv = { ...process.env, ...gitConfigEnv, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const files = execFileSync('git', ['-C', projectRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
  const inferred = files.filter(file => file.split('/').some(component => { const name = component.toLocaleLowerCase(); return words.has(name) || words.has(name.replace(/\.[^.]+$/, '')); }));
  return [...new Set([...explicit, ...inferred.sort()])].slice(0, 32);
}

export function memoryForRun(projectRoot: string, database: string, task: string, policy: ProjectConfig['memorySelection'] = {}): { root: string; records: MemoryRecord[]; inferredPaths?: string[]; reasons?: Record<string, string>; excluded?: { id: string; reason: string }[] } | undefined {
  const memory = openProjectMemory(projectRoot, database); if (!memory) return undefined;
  try {
    const words = [...new Set(task.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(word => word.length > 2))];
    const paths = policy.inferTaskPaths ? inferProjectPaths(projectRoot, task) : [];
    const withinScope = (recordScope: string, selected: string) => recordScope === selected || recordScope.startsWith(`${selected.replace(/\/$/, '')}/`);
    const { active, excluded } = activeMemory(memory.store.search());
    const eligible = active.filter(record => (!policy.scopes?.length || policy.scopes.some(scope => withinScope(record.header.scope, scope))) && (!policy.tags?.length || policy.tags.every(tag => record.header.tags.includes(tag)))
      && (!paths.length || record.header.scope === 'project' || paths.some(file => withinScope(file, record.header.scope) || withinScope(record.header.scope, file))));
    const semantic = policy.retrievalMode && policy.retrievalMode !== 'lexical' ? semanticScores(eligible, task) : [];
    const ranked = eligible.map((record, index) => ({ record, score: words.filter(word => `${record.header.id} ${record.header.tags.join(' ')} ${record.body}`.toLocaleLowerCase().includes(word)).length + (semantic[index] ?? 0) * (policy.retrievalMode === 'semantic' ? 100 : 2) }))
      .filter(item => !policy.requireTaskMatch || item.score > 0);
    ranked.sort((a, b) => b.score - a.score || a.record.header.id.localeCompare(b.record.header.id));
    let bytes = 0;
    const records: MemoryRecord[] = [], reasons: Record<string, string> = {};
    for (const { record, score } of ranked) {
      if (records.length >= (policy.maxRecords ?? 30)) break;
      const size = Buffer.byteLength(record.body);
      if (bytes + size > (policy.maxBodyBytes ?? 16000)) continue;
      bytes += size; records.push(record);
      if (policy.retrievalMode && policy.retrievalMode !== 'lexical') reasons[`${record.header.type}/${record.header.id}`] = `${policy.retrievalMode === 'semantic' ? 'LSA cục bộ' : 'Từ khóa + LSA'}: score ${score.toFixed(3)}`;
    }
    return { root: memory.root, records, reasons, ...(excluded.length ? { excluded } : {}), ...(policy.inferTaskPaths ? { inferredPaths: paths } : {}) };
  } finally { memory.store.close(); }
}

/** Persist only records fully included in the prompt; metadata and displayed text describe the same immutable snapshot. */
export function formatMemorySnapshot(memory: { root: string; records: MemoryRecord[]; inferredPaths?: string[]; reasons?: Record<string, string>; excluded?: { id: string; reason: string }[] }, task: string, selectionPolicy?: ProjectConfig['memorySelection']) {
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
      sources: record.header.sources, selectionReason: memory.reasons?.[`${record.header.type}/${record.header.id}`] ?? (matches.length ? `Khớp từ khóa task: ${matches.join(', ')}` : 'Được chọn trong giới hạn context còn lại') });
  }
  return { root: memory.root, text: sections.join('\n\n'), records, ...(memory.excluded?.length ? { excluded: memory.excluded } : {}), ...(memory.inferredPaths ? { inferredPaths: memory.inferredPaths } : {}), ...(selectionPolicy ? { selectionPolicy: structuredClone(selectionPolicy) } : {}) };
}
