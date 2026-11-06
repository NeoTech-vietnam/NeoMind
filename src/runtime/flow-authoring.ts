import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileFlow, type Diagnostic } from '../domain/compiler.js';
import { diffFlows, type FlowDiff } from '../domain/flow-diff.js';
import { flowSchema, nodeSchema, profileSchema, projectSchema, type Flow } from '../domain/schema.js';
import { defaultProject, newFlowFromTemplate, templates } from '../domain/templates.js';
import { FlowLibrary, flowAuthorSchema, type FlowAuthor, type StoredFlowVersion } from '../storage/flow-library.js';
import { ProfileLibrary } from '../storage/profile-library.js';
import { projectDir } from '../storage/project-dir.js';
import { builtinProfile, defaultRoles, readProjectRules } from './project.js';
import { ESTIMATE_MIN_RUNS, type StatsGroup } from './run-stats.js';

export { diffFlows } from '../domain/flow-diff.js';

function library(root: string) { return new FlowLibrary(path.join(projectDir(root), 'flows')); }
export async function authoringProject(root: string) {
  try { return projectSchema.parse(JSON.parse(await readFile(path.join(projectDir(root), 'project.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...structuredClone(defaultProject), roleDefaults: structuredClone(defaultRoles) }; throw error; }
}
function plainVersion(version: StoredFlowVersion): Flow {
  const { semanticHash: _semantic, contentHash: _content, createdAt: _created, author: _author, ...flow } = version;
  return flow;
}
async function latest(store: FlowLibrary, flowId: string): Promise<Flow | null> {
  const versions = await store.versions(flowId), version = versions.at(-1);
  return version === undefined ? null : plainVersion(await store.readVersion(flowId, version));
}
async function builtinFlow(store: FlowLibrary, flowId: string): Promise<Flow | null> {
  if ((await store.list()).some(item => item.flowId === flowId) || !Object.hasOwn(templates, flowId)) return null;
  return structuredClone(templates[flowId as keyof typeof templates]);
}

/** Information an author needs without reading project files manually. */
export async function flowBlocks(root: string) {
  const project = await authoringProject(root), store = library(root);
  const profiles = new ProfileLibrary(path.join(projectDir(root), 'profiles')), flows = await store.list();
  const profileSummaries = await Promise.all((await profiles.list()).map(async metadata => {
    try { const parsed = profileSchema.safeParse(await profiles.readDraft(metadata.profileId)); return parsed.success ? { ...metadata, version: parsed.data.version, requestedPermissions: parsed.data.requestedPermissions, skills: parsed.data.skills.map(skill => skill.id) } : metadata; }
    catch { return metadata; }
  }));
  const flowBindings = await Promise.all(flows.filter(item => !item.archived).map(async item => {
    try { const parsed = flowSchema.safeParse(await store.readDraft(item.flowId)); return parsed.success ? { flowId: item.flowId, bindings: parsed.data.definition.bindings } : null; }
    catch { return null; }
  }));
  return { nodeTypes: nodeSchema.options.map(option => option.shape.type.value), templates: Object.keys(templates),
    profiles: profileSummaries, builtinProfiles: [builtinProfile('implementer'), builtinProfile('verifier')], flowBindings: flowBindings.filter(item => item !== null),
    roleDefaults: project.roleDefaults, bindings: templates.dev.definition.bindings, policy: project.policy, ai: project.ai ?? {},
    flows, example: templates.dev,
    // Rules apply to every run whatever the flow; listed so an author knows reviews will judge them.
    rules: { appliesToEveryRun: true, ...(await readProjectRules(root) ?? { rules: [], warnings: [] }) } };
}

export async function getFlow(root: string, flowId: string) {
  const store = library(root), builtin = await builtinFlow(store, flowId);
  if (builtin) return { draft: builtin, revision: null, metadata: { flowId, name: builtin.name, archived: false, builtin: true }, versions: [{ version: builtin.version, author: { kind: 'human' as const } }] };
  const draft = await store.readDraftWithRevision(flowId), metadata = await store.metadata(flowId);
  const versions = await Promise.all((await store.versions(flowId)).map(async version => {
    const stored = await store.readVersion(flowId, version);
    return { version, createdAt: stored.createdAt, author: stored.author ?? { kind: 'human' as const } };
  }));
  return { ...draft, metadata, versions };
}

export type DraftFlowInput = { flowId: string; name?: string | undefined; from?: { template: keyof typeof templates } | { flowId: string } | undefined; draft?: unknown; expectedRevision?: string | undefined };
/** AI draft updates require the revision the caller observed; incomplete drafts remain editable. */
export async function draftFlow(root: string, input: DraftFlowInput) {
  const project = await authoringProject(root);
  if (project.ai?.flowPublish === 'deny') throw new Error('AI flow drafting is disabled by project policy');
  const store = library(root), exists = (await store.list()).some(item => item.flowId === input.flowId);
  let draft: unknown;
  if (exists) {
    if (input.from) throw new Error('from is only allowed when creating a flow');
    if (!input.expectedRevision) throw new Error('expectedRevision is required to update a draft');
    draft = input.draft ?? (await store.readDraftWithRevision(input.flowId)).draft;
  } else {
    if (input.expectedRevision) throw new Error('expectedRevision is not valid for a new flow');
    if (input.draft !== undefined) draft = input.draft;
    else if (input.from && 'template' in input.from) {
      if (!Object.hasOwn(templates, input.from.template)) throw new Error('Unknown template');
      draft = newFlowFromTemplate(input.from.template);
    } else if (input.from && 'flowId' in input.from) draft = await builtinFlow(store, input.from.flowId) ?? structuredClone(await store.readDraft(input.from.flowId));
    else throw new Error('Provide a draft or a source flow/template');
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Draft must be an object');
  const document = { ...draft, flowId: input.flowId, ...(input.name ? { name: input.name } : {}), ...(!exists ? { version: 1, name: input.name ?? (draft as { name?: unknown }).name } : {}) };
  if (!exists) {
    if (typeof document.name !== 'string' || !document.name.trim()) throw new Error('A name is required for a new flow');
    await store.create(input.flowId, document.name);
  }
  const revision = exists && input.name ? await store.saveDraftWithName(input.flowId, document, input.expectedRevision!, input.name)
    : await store.saveDraft(input.flowId, document, exists ? input.expectedRevision : null);
  const compiled = compileFlow(document, project.policy, { aiAuthored: true });
  return { revision, diagnostics: compiled.ok ? [] : compiled.diagnostics };
}

export async function validateFlow(root: string, flowId: string, draft?: unknown): Promise<{ valid: boolean; diagnostics: Diagnostic[]; diff: FlowDiff | null }> {
  const project = await authoringProject(root), store = library(root), builtin = await builtinFlow(store, flowId), current = draft ?? builtin ?? (await store.readDraftWithRevision(flowId)).draft;
  const compiled = compileFlow(current, project.policy, { aiAuthored: true }), parsed = flowSchema.safeParse(current);
  const previous = builtin ?? await latest(store, flowId);
  return { valid: compiled.ok, diagnostics: compiled.ok ? [] : compiled.diagnostics, diff: parsed.success ? diffFlows(previous, parsed.data) : null };
}

export async function flowDiff(root: string, flowId: string, draft?: unknown): Promise<FlowDiff> {
  const store = library(root), builtin = await builtinFlow(store, flowId), current = flowSchema.parse(draft ?? builtin ?? (await store.readDraftWithRevision(flowId)).draft), previous = builtin ?? await latest(store, flowId);
  return diffFlows(previous, current);
}

export async function publishFlow(root: string, flowId: string, input: { author: FlowAuthor; expectedRevision?: string }) {
  const author = flowAuthorSchema.parse(input.author), project = await authoringProject(root);
  if (author.kind === 'ai' && (project.ai?.flowPublish === 'deny' || project.ai?.flowPublish === 'draft-only')) throw new Error('AI flow publishing is disabled by project policy');
  if (author.kind === 'ai' && !input.expectedRevision) throw new Error('expectedRevision is required for AI publishing');
  return library(root).publish(flowId, project.policy, input.expectedRevision, author);
}

/** Deterministic initial recommendation; it does not start a run. */
/**
 * Recommend a flow by static rules. With run statistics, candidates that have enough finished runs are ranked by delivery
 * rate, then median tokens; the rule-based choice stays unless the user picks an alternative.
 */
export async function assess(root: string, task: string, stats?: { byFlow: StatsGroup[] }) {
  if (!task.trim()) throw new Error('task is required');
  const project = await authoringProject(root), query = task.toLocaleLowerCase();
  let flowId: string = /nghiên cứu|tìm hiểu|so sánh|research|investigat|compar/.test(query) ? 'research'
    : /song song|độc lập|parallel|independent/.test(query) ? 'parallel'
    : /một file|1 file|sửa chữ|typo|cấu hình|single file/.test(query) && compileFlow(templates.fast, project.policy).ok ? 'fast' : 'dev';
  const reasons = [`Quy tắc theo mô tả chọn ${flowId}.`];
  const tokens = new Set(query.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const score = (text: string) => [...new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(word => tokens.has(word)).length;
  let best = score(`${templates[flowId as keyof typeof templates].name} ${templates[flowId as keyof typeof templates].description}`);
  const store = library(root), projectFlows = await store.list();
  const availableProjects = new Map<string, Flow>();
  for (const item of projectFlows) {
    if (item.archived) continue;
    let published: Flow | null;
    try { published = await latest(store, item.flowId); } catch { continue; }
    if (!published || !compileFlow(published, project.policy).ok) continue;
    availableProjects.set(item.flowId, published);
    const value = score(`${item.name} ${published.description}`);
    if (value > best) { best = value; flowId = item.flowId; reasons.push(`Flow project ${item.name} khớp mô tả hơn.`); }
  }
  const available = (id: string) => projectFlows.some(item => item.flowId === id) ? availableProjects.has(id)
    : Object.hasOwn(templates, id) && compileFlow(templates[id as keyof typeof templates], project.policy).ok;
  if (!available(flowId)) reasons.push(`Flow ${flowId} chưa sẵn sàng hoặc không phù hợp policy; cần chọn flow khác hoặc tạo mới.`);
  let suggestedChecks: string[] = [];
  try { const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: { test?: unknown } }; if (typeof pkg.scripts?.test === 'string') suggestedChecks = ['npm test']; } catch { /* No readable package script to recommend. */ }
  let alternatives = [...new Set([...Object.keys(templates), ...availableProjects.keys()])].filter(id => id !== flowId && available(id));
  const measured = (id: string) => { const item = stats?.byFlow.find(group => group.key === id); return item && item.completed >= ESTIMATE_MIN_RUNS ? item : undefined; };
  if (stats) {
    const score = (id: string) => measured(id)?.deliveryRate ?? -1, tokens = (id: string) => measured(id)?.tokens.median ?? Infinity;
    alternatives = [...alternatives].sort((a, b) => score(b) - score(a) || tokens(a) - tokens(b));
    const own = measured(flowId);
    if (own) reasons.push(`Thống kê ${flowId}: giao ${Math.round((own.deliveryRate ?? 0) * 100)}% trong ${own.runs} run, trung vị ${Math.round(own.tokens.median ?? 0)} token.`);
    const better = alternatives.find(id => (measured(id)?.deliveryRate ?? -1) > (own?.deliveryRate ?? 1));
    if (better) reasons.push(`${better} có tỷ lệ giao cao hơn theo thống kê; cân nhắc nếu việc phù hợp.`);
  }
  const statistics = stats ? Object.fromEntries([flowId, ...alternatives].flatMap(id => { const item = measured(id); return item ? [[id, { runs: item.runs, deliveryRate: item.deliveryRate, medianTokens: item.tokens.median, medianActiveSeconds: item.activeSeconds.median }]] : []; })) : undefined;
  return { flowId, available: available(flowId), reasons, alternatives, suggestedChecks, ...(statistics ? { statistics } : {}) };
}
