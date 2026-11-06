import path from 'node:path';
import { flowSchema, profileSchema, type Flow, type Profile } from '../domain/schema.js';
import { templates } from '../domain/templates.js';
import { FlowLibrary, flowAuthorSchema, type FlowAuthor } from '../storage/flow-library.js';
import { ProfileLibrary } from '../storage/profile-library.js';
import { projectDir } from '../storage/project-dir.js';
import { builtinProfile } from './project.js';
import { authoringProject } from './flow-authoring.js';
import { skillStatus } from '../storage/skill-catalog.js';

const profiles = (root: string) => new ProfileLibrary(path.join(projectDir(root), 'profiles'));
const flows = (root: string) => new FlowLibrary(path.join(projectDir(root), 'flows'));

export async function getProfile(root: string, profileId: string) {
  const store = profiles(root), exists = (await store.list()).some(item => item.profileId === profileId);
  if (!exists) {
    const builtin = builtinProfile(profileId); if (!builtin) throw new Error('Profile not found');
    return { draft: builtin, revision: null, metadata: { profileId, name: builtin.name, archived: false, builtin: true }, versions: [{ version: 1, author: { kind: 'human' as const } }] };
  }
  const draft = await store.readDraftWithRevision(profileId), metadata = await store.metadata(profileId);
  const versions = await Promise.all((await store.versions(profileId)).map(async version => {
    const saved = await store.readVersion(profileId, version);
    return { version, createdAt: saved.createdAt, author: saved.author ?? { kind: 'human' as const } };
  }));
  return { ...draft, metadata, versions };
}
export async function getProfileVersion(root: string, profileId: string, version: number) {
  const store = profiles(root), exists = (await store.list()).some(item => item.profileId === profileId);
  if (exists) return store.readVersion(profileId, version);
  const builtin = builtinProfile(profileId);
  if (!builtin || builtin.version !== version) throw new Error('Profile version not found');
  return builtin;
}
export async function profileSkillStatus(root: string, profileId: string) {
  const profile = profileSchema.parse((await getProfile(root, profileId)).draft);
  return skillStatus(root, profile.skills);
}

export type DraftProfileInput = { profileId: string; name?: string | undefined; from?: { profileId: string } | undefined; draft?: unknown; expectedRevision?: string | undefined };
export async function draftProfile(root: string, input: DraftProfileInput) {
  const project = await authoringProject(root);
  if (project.ai?.profilePublish === 'deny') throw new Error('AI profile drafting is disabled by project policy');
  const store = profiles(root), exists = (await store.list()).some(item => item.profileId === input.profileId);
  let draft: unknown;
  if (exists) {
    if (input.from) throw new Error('from is only allowed when creating a profile');
    if (!input.expectedRevision) throw new Error('expectedRevision is required to update a draft');
    draft = input.draft ?? (await store.readDraftWithRevision(input.profileId)).draft;
  } else if (input.draft !== undefined) draft = input.draft;
  else if (input.from) draft = (await getProfile(root, input.from.profileId)).draft;
  else throw new Error('Provide a draft or a source profile');
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Draft must be an object');
  const document = { ...draft, profileId: input.profileId, ...(input.name ? { name: input.name } : {}), ...(!exists ? { version: 1, name: input.name ?? (draft as { name?: unknown }).name } : {}) };
  if (!exists) {
    if (typeof document.name !== 'string' || !document.name.trim()) throw new Error('A name is required for a new profile');
    await store.create(input.profileId, document.name);
  }
  const revision = exists && input.name ? await store.saveDraftWithName(input.profileId, document, input.expectedRevision!, input.name)
    : await store.saveDraft(input.profileId, document, exists ? input.expectedRevision : null);
  const parsed = profileSchema.safeParse(document);
  return { revision, diagnostics: parsed.success ? [] : parsed.error.issues.map(issue => ({ code: 'schema', message: `${issue.path.join('.')}: ${issue.message}` })) };
}

export async function publishProfile(root: string, profileId: string, input: { author: FlowAuthor; expectedRevision?: string }) {
  const author = flowAuthorSchema.parse(input.author), project = await authoringProject(root);
  if (author.kind === 'ai' && (project.ai?.profilePublish === 'deny' || project.ai?.profilePublish === 'draft-only')) throw new Error('AI profile publishing is disabled by project policy');
  if (author.kind === 'ai' && !input.expectedRevision) throw new Error('expectedRevision is required for AI publishing');
  return profiles(root).publish(profileId, input.expectedRevision, author);
}

function refs(flow: Flow, profileId: string) {
  return flow.definition.nodes.flatMap(node => {
    if ((node.type === 'agent_task' || node.type === 'integration') && node.profileId === profileId && node.profileVersion) return [{ nodeId: node.id, label: node.label, version: node.profileVersion }];
    if (node.type === 'review_group') return node.reviewers.filter(item => item.profileId === profileId).map(item => ({ nodeId: node.id, label: `${node.label} · ${item.id}`, version: item.profileVersion }));
    return [];
  });
}

/** Read draft and latest published references without changing either. */
export async function profileUsage(root: string, profileId: string) {
  const store = flows(root), result: { flowId: string; name: string; archived: boolean; revision: string | null; draft: ReturnType<typeof refs>; draftValid: boolean; published: ReturnType<typeof refs>; publishedVersion: number | null; builtin?: boolean }[] = [], listed = await store.list();
  for (const item of listed) {
    const raw = await store.readDraftWithRevision(item.flowId), parsed = flowSchema.safeParse(raw.draft);
    const versions = await store.versions(item.flowId), latest = versions.at(-1);
    const published = latest === undefined ? null : await store.readVersion(item.flowId, latest);
    result.push({ flowId: item.flowId, name: item.name, archived: item.archived, revision: raw.revision,
      draft: parsed.success ? refs(parsed.data, profileId) : [], draftValid: parsed.success,
      published: published ? refs(published, profileId) : [], publishedVersion: latest ?? null });
  }
  for (const [flowId, flow] of Object.entries(templates)) if (!listed.some(item => item.flowId === flowId)) {
    const used = refs(flow, profileId); if (used.length) result.push({ flowId, name: flow.name, archived: false, revision: null, draft: [], draftValid: false, published: used, publishedVersion: flow.version, builtin: true });
  }
  return result;
}

/** Compare-and-swap every selected draft; published versions remain immutable. */
export async function migrateProfile(root: string, profileId: string, version: number, selected: { flowId: string; expectedRevision: string }[]) {
  await getProfileVersion(root, profileId, version);
  if (new Set(selected.map(item => item.flowId)).size !== selected.length) throw new Error('Duplicate flow ID');
  const flowStore = flows(root), results: { flowId: string; revision?: string; changed?: number; error?: string }[] = [];
  for (const item of selected) {
    try {
      const data = await flowStore.readDraftWithRevision(item.flowId), flow = flowSchema.parse(data.draft); let changed = 0;
      for (const node of flow.definition.nodes) {
        if ((node.type === 'agent_task' || node.type === 'integration') && node.profileId === profileId && node.profileVersion !== version) { node.profileVersion = version; changed++; }
        if (node.type === 'review_group') for (const reviewer of node.reviewers) if (reviewer.profileId === profileId && reviewer.profileVersion !== version) { reviewer.profileVersion = version; changed++; }
      }
      const revision = await flowStore.saveDraft(item.flowId, flow, item.expectedRevision);
      results.push({ flowId: item.flowId, revision, changed });
    } catch (error) { results.push({ flowId: item.flowId, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { results };
}
