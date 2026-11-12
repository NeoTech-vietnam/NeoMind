import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitConfigEnv } from '../workspace/git-env.js';
import { activeMemory, semanticScores } from '../memory/retrieval.js';
import { ProjectMemoryRegistry } from '../memory/registry.js';
import { defaultMemoryLocation, resolveDefaultMemoryRoot } from '../memory/project-root.js';
import { MemoryStore, type MemoryRecord } from '../memory/store.js';
import type { MemoryRatingTotals } from '../memory/feedback.js';
import { openMemoryIndex } from '../memory/index-cache.js';
import type { Flow, ProjectConfig, StepMemory } from '../domain/schema.js';
import type { RuntimeContext } from '../core/runtime-state.js';

/**
 * The project's memory store. A configured root must exist (it is never silently recreated). Without one, memory lives
 * in the repository's `neomind/memory`: reading a project that has none yet finds no memory, and `create` (a write)
 * creates the folder.
 */
export function openProjectMemory(projectRoot: string, database: string, create = false): { root: string; store: MemoryStore } | undefined {
  const registry = new ProjectMemoryRegistry(database);
  let configured: string | undefined;
  try { configured = registry.resolve(projectRoot); } finally { registry.close(); }
  let root = configured;
  if (!root) {
    try { root = resolveDefaultMemoryRoot(projectRoot, create); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  return { root, store: new MemoryStore(root, database) };
}

/** Where the project's memory is, for the user: a configured folder, or the default inside the repository (committed with it). */
export function memoryLocation(projectRoot: string, database: string) {
  const registry = new ProjectMemoryRegistry(database);
  let configured: string | undefined;
  try { configured = registry.resolve(projectRoot); } finally { registry.close(); }
  const fallback = defaultMemoryLocation(projectRoot), root = configured ?? fallback;
  const relative = path.relative(path.dirname(path.dirname(fallback)), root);
  const inRepository = !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  let exists = !!configured;
  if (!configured) { try { resolveDefaultMemoryRoot(projectRoot); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  return { root, configured: !!configured, isDefault: !configured || root === fallback, exists, inRepository, ...(inRepository ? { relativePath: relative.split(path.sep).join('/') } : {}) };
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

/** Feedback moves a record up or down by at most this much, so ratings refine the ranking without overriding the task. */
const maxFeedbackBonus = 5;
type Kind = 'context' | 'decision' | 'lesson';

export function memoryForRun(projectRoot: string, database: string, task: string, policy: ProjectConfig['memorySelection'] = {}, projectId?: string): { root: string; records: MemoryRecord[]; inferredPaths?: string[]; reasons?: Record<string, string>; excluded?: { id: string; reason: string }[]; feedback?: Record<string, number> } | undefined {
  const memory = openProjectMemory(projectRoot, database); if (!memory) return undefined;
  try {
    const words = [...new Set(task.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(word => word.length > 2))];
    const paths = policy.inferTaskPaths ? inferProjectPaths(projectRoot, task) : [];
    const withinScope = (recordScope: string, selected: string) => recordScope === selected || recordScope.startsWith(`${selected.replace(/\/$/, '')}/`);
    // Older repair lessons carry the project id as scope; like `project` they apply to the whole repository.
    const scopeOf = (record: MemoryRecord) => projectId && record.header.scope === projectId ? 'project' : record.header.scope;
    const { active, excluded } = activeMemory(memory.store.search());
    const eligible = active.filter(record => (!policy.scopes?.length || policy.scopes.some(scope => withinScope(scopeOf(record), scope))) && (!policy.tags?.length || policy.tags.every(tag => record.header.tags.includes(tag)))
      && (!paths.length || scopeOf(record) === 'project' || paths.some(file => withinScope(file, record.header.scope) || withinScope(record.header.scope, file))));
    const semantic = policy.retrievalMode && policy.retrievalMode !== 'lexical' ? semanticScores(eligible, task) : [];
    // Ratings from earlier runs (Hữu ích / Không liên quan / Sai) shift the order; a record nobody rated keeps its task score.
    const stats = memoryRatingTotals(memory.store), feedback: Record<string, number> = {};
    const bonus = (record: MemoryRecord) => Math.max(-maxFeedbackBonus, Math.min(maxFeedbackBonus, stats.get(`${record.header.type}/${record.header.id}`)?.score ?? 0));
    const ranked = eligible.map((record, index) => ({ record, score: words.filter(word => `${record.header.id} ${record.header.tags.join(' ')} ${record.body}`.toLocaleLowerCase().includes(word)).length + (semantic[index] ?? 0) * (policy.retrievalMode === 'semantic' ? 100 : 2) }))
      .filter(item => !policy.requireTaskMatch || item.score > 0).map(item => ({ ...item, score: item.score + bonus(item.record) }));
    ranked.sort((a, b) => b.score - a.score || a.record.header.id.localeCompare(b.record.header.id));
    let bytes = 0;
    const records: MemoryRecord[] = [], reasons: Record<string, string> = {};
    for (const { record, score } of ranked) {
      if (records.length >= (policy.maxRecords ?? 30)) break;
      const size = Buffer.byteLength(record.body);
      if (bytes + size > (policy.maxBodyBytes ?? 16000)) continue;
      bytes += size; records.push(record);
      if (policy.retrievalMode && policy.retrievalMode !== 'lexical') reasons[`${record.header.type}/${record.header.id}`] = `${policy.retrievalMode === 'semantic' ? 'LSA cục bộ' : 'Từ khóa + LSA'}: score ${score.toFixed(3)}`;
      if (bonus(record)) feedback[`${record.header.type}/${record.header.id}`] = bonus(record);
    }
    return { root: memory.root, records, reasons, ...(excluded.length ? { excluded } : {}), ...(policy.inferTaskPaths ? { inferredPaths: paths } : {}), ...(Object.keys(feedback).length ? { feedback } : {}) };
  } finally { memory.store.close(); }
}

/** Rating totals per record key, from the memory's rebuildable cache over `feedback/*.jsonl`. */
export function memoryRatingTotals(store: MemoryStore): Map<string, MemoryRatingTotals> {
  const index = openMemoryIndex(store);
  try { return index.ratings(); } finally { index.close(); }
}

/** One record's block in a prompt; a step that receives only some records gets exactly these blocks. */
const memorySection = (record: MemoryRecord) => `[${record.header.type}:${record.header.id} revision=${record.revision}]\nSources: ${record.header.sources.join(', ')}\n${record.body}`;

/** Persist only records fully included in the prompt; metadata and displayed text describe the same immutable snapshot. */
export function formatMemorySnapshot(memory: { root: string; records: MemoryRecord[]; inferredPaths?: string[]; reasons?: Record<string, string>; excluded?: { id: string; reason: string }[]; feedback?: Record<string, number> }, task: string, selectionPolicy?: ProjectConfig['memorySelection']) {
  const words = [...new Set(task.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(word => word.length > 2))];
  const sections: string[] = [], records: { id: string; type: Kind; scope: string; revision: string; sources: string[]; selectionReason: string; tags: string[]; text: string }[] = [];
  let length = 0;
  for (const record of memory.records) {
    const section = memorySection(record);
    const added = section.length + (sections.length ? 2 : 0);
    if (length + added > 40000) continue;
    const searchable = `${record.header.id} ${record.header.tags.join(' ')} ${record.body}`.toLocaleLowerCase();
    const matches = words.filter(word => searchable.includes(word)), key = `${record.header.type}/${record.header.id}`, rated = memory.feedback?.[key];
    sections.push(section); length += added;
    const reason = memory.reasons?.[key] ?? (matches.length ? `Khớp từ khóa task: ${matches.join(', ')}` : 'Được chọn trong giới hạn context còn lại');
    // Tags and the record's own block let each step take a subset of the pinned set without reading memory again.
    records.push({ id: record.header.id, type: record.header.type, scope: record.header.scope, revision: record.revision,
      sources: record.header.sources, selectionReason: rated ? `${reason}; phản hồi người dùng ${rated > 0 ? '+' : ''}${rated}` : reason, tags: record.header.tags, text: section });
  }
  return { root: memory.root, text: sections.join('\n\n'), records, ...(memory.excluded?.length ? { excluded: memory.excluded } : {}), ...(memory.inferredPaths ? { inferredPaths: memory.inferredPaths } : {}), ...(selectionPolicy ? { selectionPolicy: structuredClone(selectionPolicy) } : {}) };
}

/** Role of an agent step, for its default memory: planning and research see everything, reviewers decisions and lessons. */
export type StepRole = 'plan' | 'read' | 'write' | 'review';
export const roleMemoryDefaults: Record<StepRole, StepMemory> = {
  plan: { types: ['context', 'decision', 'lesson'] }, read: { types: ['context', 'decision', 'lesson'] },
  write: { types: ['context', 'decision', 'lesson'] }, review: { types: ['decision', 'lesson'] },
};
export type StepMemoryPolicy = { role: StepRole; config: StepMemory; source: 'step' | 'role' };

/**
 * The memory settings of one step (`nodeId` or `nodeId/reviewerId`): its own `memory` field, or the role default when the
 * flow opts into role defaults (`memoryDefaults: "role"`, flows created from templates). Undefined keeps the shared block
 * every step of older flows receives.
 */
export function stepMemoryPolicy(flow: Flow, key: string): StepMemoryPolicy | undefined {
  const [nodeId, reviewerId] = key.split('/'), node = flow.definition.nodes.find(item => item.id === nodeId);
  let role: StepRole, own: StepMemory | undefined;
  if (node?.type === 'review_group') { const reviewer = node.reviewers.find(item => item.id === reviewerId); if (!reviewer) return undefined; role = 'review'; own = reviewer.memory; }
  else if (node?.type === 'agent_task') { role = node.outputContract === 'plan' ? 'plan' : node.permissions.write ? 'write' : 'read'; own = node.memory; }
  else if (node?.type === 'integration') { role = 'write'; own = node.memory; }
  else return undefined;
  if (own) return { role, config: own, source: 'step' };
  return flow.definition.memoryDefaults === 'role' ? { role, config: roleMemoryDefaults[role], source: 'role' } : undefined;
}

/** Records that apply to a write step: project-wide ones and those whose scope overlaps a directory the plan may change. */
function inPlanScope(scope: string, planScope: string[], projectId?: string): boolean {
  const clean = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const record = clean(scope), within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);
  if (record === 'project' || record === projectId || record === '.' || !record) return true;
  return planScope.map(clean).some(allowed => allowed === '.' || !allowed || within(record, allowed) || within(allowed, record));
}

/**
 * The pinned memory one step receives. Steps only filter the set pinned when the run was created, so a step never sees a
 * record the run did not pin and replay shows the same text. Undefined means the step gets the run's whole memory block
 * (older flows, or a run pinned before records carried their own blocks).
 */
export function stepMemory(memory: RuntimeContext['memory'], policy: StepMemoryPolicy | undefined, options: { planScope?: string[] | undefined; projectId?: string } = {}) {
  if (!memory || !policy || memory.records?.some(record => record.text === undefined)) return undefined;
  const { config, role } = policy, types = config.types ?? ['context', 'decision', 'lesson'];
  const records = config.off ? [] : (memory.records ?? []).filter(record => types.includes(record.type) && (!config.tags?.length || config.tags.every(tag => record.tags?.includes(tag)))
    && (role !== 'write' || !options.planScope || inPlanScope(record.scope, options.planScope, options.projectId))).slice(0, config.maxRecords ?? 30);
  return { text: records.map(record => record.text!).join('\n\n'), records };
}

/** Plain-language summary of a step's memory filter, for the run detail. */
export function describeStepMemory(policy: StepMemoryPolicy | undefined): string {
  if (!policy) return 'Toàn bộ memory đã ghim của run';
  const { config, source, role } = policy;
  if (config.off) return 'Bước này tắt memory';
  const names: Record<Kind, string> = { context: 'context', decision: 'quyết định', lesson: 'lesson' };
  return [`${source === 'role' ? `Mặc định vai trò ${role}` : 'Cấu hình riêng của bước'}: ${(config.types ?? ['context', 'decision', 'lesson']).map(type => names[type]).join(', ')}`,
    ...(config.tags?.length ? [`tag ${config.tags.join(', ')}`] : []), ...(config.maxRecords !== undefined ? [`tối đa ${config.maxRecords} bản ghi`] : []),
    ...(role === 'write' ? ['khớp phạm vi kế hoạch'] : [])].join(' · ');
}
