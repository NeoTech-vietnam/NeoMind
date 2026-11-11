import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { authoringProject } from '../runtime/flow-authoring.js';
import { replaceText } from './atomic-json.js';
import { FlowLibrary } from './flow-library.js';
import { RevisionConflict, withLibraryLock } from './library-lock.js';
import { ProfileLibrary } from './profile-library.js';
import { projectDir } from './project-dir.js';
import { skillCatalog, skillCompanions, skillMetadata, resolveSkill } from './skill-catalog.js';

/**
 * Authoring for project-owned skills in `neomind/skills/<id>/`. Skills under `.claude/skills` belong to Claude Code and
 * stay read-only here. A run never reads this module: it pins skill bytes by SHA-256 when the run is created, so editing
 * a skill only affects profiles and flows whose pins are refreshed (repinSkill) and published again.
 */
export const SKILLS_FOLDER = 'neomind/skills';
export const skillIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
// Companion files are plain text kept beside SKILL.md; bounded so an editor round trip stays small.
const MAX_TEXT_BYTES = 256 * 1024;
const companionSchema = z.string().min(1).max(260).regex(/^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.?(?:[\\/]|$)).+$/, 'File path must stay inside the skill folder');

export type SkillActor = { kind: 'human' } | { kind: 'ai'; sessionId?: string | undefined };
export const skillActorSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('human') }), z.strictObject({ kind: z.literal('ai'), sessionId: z.string().min(1).optional() })]);

export class SkillInUse extends Error {
  constructor(message: string, readonly usage: SkillUsage) { super(message); this.name = 'SkillInUse'; }
}

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const skillPath = (id: string) => `${SKILLS_FOLDER}/${skillIdSchema.parse(id)}/SKILL.md`;
const samePath = (a: string, b: string) => a.replaceAll('\\', '/') === b.replaceAll('\\', '/');

async function allowed(root: string, actor: SkillActor) {
  if (actor.kind === 'ai' && (await authoringProject(root)).ai?.skillEdit === 'deny') throw new Error('AI skill editing is disabled by project policy (ai.skillEdit: deny)');
}

/** Refuse symlinks on the way to the skill folder so a write can never land outside the project. */
async function rejectLinks(root: string, relative: string) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink is not allowed in the skill library: ${path.relative(root, current)}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
async function folder(root: string, id: string) {
  const base = await realpath(root), relative = `${SKILLS_FOLDER}/${skillIdSchema.parse(id)}`;
  await rejectLinks(base, relative);
  return { base, relative, directory: path.join(base, ...relative.split('/')) };
}
function decode(bytes: Buffer, name: string) {
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`${name} exceeds ${MAX_TEXT_BYTES} bytes`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${name} is not UTF-8 text`); }
}
function checkText(text: string, name: string) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error(`${name} exceeds ${MAX_TEXT_BYTES} bytes`);
  if (text.includes('\0')) throw new Error(`${name} must be text`);
}

/** Split a SKILL.md into its frontmatter fields and Markdown body; other frontmatter keys (allowed-tools…) are kept. */
export function parseSkillDocument(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  let value: unknown;
  try { value = parse(match[1]!); } catch { value = undefined; }
  return { frontmatter: value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}, body: content.slice(match[0].length) };
}
/** Claude's SKILL.md layout: YAML frontmatter with name and description, then the Markdown instructions. */
export function skillDocument(input: { name: string; description: string; body: string; frontmatter?: Record<string, unknown> | undefined }): string {
  const frontmatter = { ...input.frontmatter, name: input.name.trim(), description: input.description.trim() };
  const body = input.body.replace(/^\r?\n/, '');
  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.endsWith('\n') || !body ? body : `${body}\n`}`;
}

/** The text a run adds to a step's prompt for this skill, as LocalRun.prompt writes it. */
export function skillPromptText(skill: { id: string; name?: string | undefined; content: string; files?: string[] | undefined }): string {
  return `${skill.name ? `Skill ${skill.name} (${skill.id}):` : `Skill ${skill.id}:`}\n${skill.content}${skill.files?.length ? `\nCompanion files (read only if needed and permitted): ${skill.files.join(', ')}` : ''}`;
}

/** Templates offered when creating a skill from the editor or a session. */
export const skillTemplates = {
  empty: { description: '', body: '# Khi nào dùng\n\n# Cách làm\n' },
  'review-checklist': { description: 'Checklist khi review thay đổi code', body: '# Checklist review\n\n- Thay đổi đúng yêu cầu và kế hoạch đã duyệt\n- Có test cho hành vi mới và lỗi đã sửa\n- Không đổi hành vi ngoài phạm vi\n- Trích dẫn file và dòng làm bằng chứng cho mỗi kết luận\n' },
} as const;
export type SkillTemplate = keyof typeof skillTemplates;

/** One skill with its text, companion files and whether this editor may change it. */
export async function getSkill(root: string, id: string, source: 'neomind' | 'claude' = 'neomind') {
  const relative = source === 'neomind' ? skillPath(id) : `.claude/skills/${skillIdSchema.parse(id)}/SKILL.md`;
  if (source === 'neomind') await folder(root, id);
  const { bytes } = await resolveSkill(root, { id, path: relative, sha256: '0'.repeat(64) });
  const content = decode(bytes, 'SKILL.md'), { frontmatter, body } = parseSkillDocument(content), meta = skillMetadata(content, id);
  const files = await skillCompanions(root, relative), prefix = relative.slice(0, -'SKILL.md'.length);
  return { id, path: relative, source, editable: source === 'neomind', sha256: sha(bytes), content, name: meta.name, description: meta.description, body, frontmatter,
    files: files.map(file => file.slice(prefix.length)),
    prompt: skillPromptText({ id, name: meta.name, content, files }) };
}

export type CreateSkillInput = { id: string; name: string; description?: string | undefined; body?: string | undefined; template?: SkillTemplate | undefined };
export async function createSkill(root: string, input: CreateSkillInput, actor: SkillActor = { kind: 'human' }) {
  await allowed(root, actor);
  const id = skillIdSchema.parse(input.id), template = skillTemplates[input.template ?? 'empty'];
  if (!input.name.trim()) throw new Error('A name is required for a new skill');
  const content = skillDocument({ name: input.name, description: input.description ?? template.description, body: input.body ?? template.body });
  checkText(content, 'SKILL.md');
  await withLibraryLock(path.join(root, SKILLS_FOLDER), async () => {
    const { base, directory } = await folder(root, id);
    // A step pins skills by ID, so an ID taken by a Claude skill would make the two indistinguishable in a profile.
    for (const existing of [directory, path.join(base, '.claude', 'skills', id)]) {
      try { await lstat(existing); throw new Error(`Skill ${id} already exists`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory);
    await replaceText(path.join(directory, 'SKILL.md'), content);
  });
  return getSkill(root, id);
}

export type UpdateSkillInput = { expectedSha256: string; name?: string | undefined; description?: string | undefined; body?: string | undefined; content?: string | undefined };
/** Rewrite SKILL.md if it still has the hash the caller read. Pins elsewhere are not changed; see repinSkill. */
export async function updateSkill(root: string, id: string, input: UpdateSkillInput, actor: SkillActor = { kind: 'human' }) {
  await allowed(root, actor);
  if (input.content !== undefined && (input.name !== undefined || input.description !== undefined || input.body !== undefined)) throw new Error('Give either content or name/description/body');
  await withLibraryLock(path.join(root, SKILLS_FOLDER), async () => {
    const current = await getSkill(root, id);
    if (current.sha256 !== input.expectedSha256) throw new RevisionConflict(`Skill ${id} đã bị sửa ở nơi khác; tải lại trước khi lưu`);
    const content = input.content ?? skillDocument({ frontmatter: current.frontmatter, name: input.name ?? current.name, description: input.description ?? current.description, body: input.body ?? current.body });
    checkText(content, 'SKILL.md');
    if (!skillMetadata(content, '').name) throw new Error('SKILL.md needs a name in its frontmatter');
    const { directory } = await folder(root, id);
    await replaceText(path.join(directory, 'SKILL.md'), content);
  });
  const skill = await getSkill(root, id);
  return { skill, usage: await skillUsage(root, skill.path) };
}

/** Delete a skill folder. A skill that profiles or flows still pin is kept unless `force`, and the refusal lists them. */
export async function deleteSkill(root: string, id: string, options: { force?: boolean | undefined } = {}, actor: SkillActor = { kind: 'human' }) {
  await allowed(root, actor);
  const usage = await skillUsage(root, skillPath(id));
  if (usageCount(usage) && !options.force) throw new SkillInUse(`Skill ${id} đang được dùng ở ${usageCount(usage)} nơi; bỏ ghim trước hoặc xóa với force`, usage);
  await withLibraryLock(path.join(root, SKILLS_FOLDER), async () => {
    const { directory } = await folder(root, id);
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Skill ${id} is not a folder`);
    await rm(directory, { recursive: true });
  });
  return { deleted: true, usage };
}

async function companionTarget(root: string, id: string, file: string) {
  const name = companionSchema.parse(file).replaceAll('\\', '/');
  if (name === 'SKILL.md') throw new Error('Edit SKILL.md with updateSkill');
  const { base, relative } = await folder(root, id);
  await rejectLinks(base, `${relative}/${name}`);
  return path.join(base, ...relative.split('/'), ...name.split('/'));
}
export async function readSkillFile(root: string, id: string, file: string) {
  const bytes = await readFile(await companionTarget(root, id, file));
  return { path: file, content: decode(bytes, file), sha256: sha(bytes) };
}
/** Create (expectedSha256 null) or replace a text companion file; the SKILL.md hash is unchanged by companions. */
export async function writeSkillFile(root: string, id: string, file: string, content: string, expectedSha256: string | null, actor: SkillActor = { kind: 'human' }) {
  await allowed(root, actor); checkText(content, file);
  return withLibraryLock(path.join(root, SKILLS_FOLDER), async () => {
    await getSkill(root, id);
    const target = await companionTarget(root, id, file);
    let current: string | null = null;
    try { current = sha(await readFile(target)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== expectedSha256) throw new RevisionConflict(current === null ? `File ${file} không còn tồn tại` : expectedSha256 === null ? `File ${file} đã tồn tại` : `File ${file} đã bị sửa ở nơi khác; tải lại trước khi lưu`);
    await mkdir(path.dirname(target), { recursive: true });
    await replaceText(target, content);
    return { path: file, sha256: sha(content) };
  });
}
export async function deleteSkillFile(root: string, id: string, file: string, actor: SkillActor = { kind: 'human' }) {
  await allowed(root, actor);
  return withLibraryLock(path.join(root, SKILLS_FOLDER), async () => {
    const target = await companionTarget(root, id, file), { directory } = await folder(root, id);
    await rm(target);
    // Remove folders the deletion left empty, up to the skill folder itself.
    for (let parent = path.dirname(target); parent.startsWith(directory) && parent !== directory; parent = path.dirname(parent)) {
      if ((await readdir(parent)).length) break;
      await rmdir(parent);
    }
    return { deleted: true };
  });
}

type Pin = { sha256: string; stale: boolean };
export type SkillUsage = {
  sha256: string | null;
  profiles: { profileId: string; name: string; revision: string | null; draft: Pin | null; latest: (Pin & { version: number }) | null }[];
  flows: { flowId: string; name: string; revision: string | null; draft: { nodeId: string; label: string; sha256: string; stale: boolean }[]; published: { nodeId: string; label: string; sha256: string; stale: boolean }[]; publishedVersion: number | null }[];
};
export const usageCount = (usage: SkillUsage) => usage.profiles.filter(item => item.draft || item.latest).length + usage.flows.reduce((sum, item) => sum + new Set([...item.draft, ...item.published].map(ref => ref.nodeId)).size, 0);
export const staleCount = (usage: SkillUsage) => usage.profiles.filter(item => item.draft?.stale).length + usage.flows.reduce((sum, item) => sum + item.draft.filter(ref => ref.stale).length, 0);

type Raw = Record<string, unknown>;
const records = (value: unknown): Raw[] => Array.isArray(value) ? value.filter((item): item is Raw => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
/** Every skill reference list of a flow document, with the step it belongs to; drafts may be incomplete, so read loosely. */
function flowSkillLists(flow: unknown) {
  const nodes = records(((flow as Raw | null)?.definition as Raw | undefined)?.nodes), lists: { nodeId: string; label: string; refs: Raw[] }[] = [];
  for (const node of nodes) {
    const nodeId = String(node.id ?? ''), label = String(node.label ?? nodeId);
    if ((node.type === 'agent_task' || node.type === 'integration') && Array.isArray(node.skillsOverride)) lists.push({ nodeId, label, refs: records(node.skillsOverride) });
    if (node.type === 'review_group') for (const reviewer of records(node.reviewers)) if (Array.isArray(reviewer.skillsOverride)) lists.push({ nodeId: `${nodeId}/${String(reviewer.id ?? '')}`, label: `${label} · ${String(reviewer.id ?? '')}`, refs: records(reviewer.skillsOverride) });
  }
  return lists;
}

/** Profiles (draft and latest version) and flow steps (draft and latest version) that pin the skill at `skill`. */
export async function skillUsage(root: string, skill: string): Promise<SkillUsage> {
  let current: string | null = null;
  try { current = sha((await resolveSkill(root, { id: 'x', path: skill, sha256: '0'.repeat(64) })).bytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const pin = (ref: Raw | undefined): Pin | null => ref && typeof ref.sha256 === 'string' ? { sha256: ref.sha256, stale: ref.sha256 !== current } : null;
  const find = (refs: unknown) => records(refs).find(ref => typeof ref.path === 'string' && samePath(ref.path, skill));
  const profiles = new ProfileLibrary(path.join(projectDir(root), 'profiles')), flows = new FlowLibrary(path.join(projectDir(root), 'flows'));
  const result: SkillUsage = { sha256: current, profiles: [], flows: [] };
  for (const item of await profiles.list()) {
    const draft = await profiles.readDraftWithRevision(item.profileId).catch(() => null), versions = await profiles.versions(item.profileId).catch(() => []);
    const version = versions.at(-1), latest = version === undefined ? null : await profiles.readVersion(item.profileId, version).catch(() => null);
    const draftPin = pin(find((draft?.draft as Raw | undefined)?.skills)), latestPin = pin(find(latest?.skills));
    if (draftPin || latestPin) result.profiles.push({ profileId: item.profileId, name: item.name, revision: draft?.revision ?? null, draft: draftPin, latest: latestPin && version !== undefined ? { ...latestPin, version } : null });
  }
  for (const item of await flows.list()) {
    const draft = await flows.readDraftWithRevision(item.flowId).catch(() => null), versions = await flows.versions(item.flowId).catch(() => []);
    const version = versions.at(-1), latest = version === undefined ? null : await flows.readVersion(item.flowId, version).catch(() => null);
    const refs = (flow: unknown) => flowSkillLists(flow).flatMap(list => { const ref = find(list.refs), value = pin(ref); return value ? [{ nodeId: list.nodeId, label: list.label, ...value }] : []; });
    const draftRefs = refs(draft?.draft), publishedRefs = refs(latest);
    if (draftRefs.length || publishedRefs.length) result.flows.push({ flowId: item.flowId, name: item.name, revision: draft?.revision ?? null, draft: draftRefs, published: publishedRefs, publishedVersion: version ?? null });
  }
  return result;
}

/**
 * Pin the skill's current hash in every profile draft and flow draft that pins an older one. Published versions keep
 * their pins; the author publishes the drafts when ready. Each draft is compare-and-swapped against the revision read.
 */
export async function repinSkill(root: string, skill: string) {
  const current = sha((await resolveSkill(root, { id: 'x', path: skill, sha256: '0'.repeat(64) })).bytes);
  const profiles = new ProfileLibrary(path.join(projectDir(root), 'profiles')), flows = new FlowLibrary(path.join(projectDir(root), 'flows'));
  const repin = (refs: Raw[]) => { let changed = 0; for (const ref of refs) if (typeof ref.path === 'string' && samePath(ref.path, skill) && ref.sha256 !== current) { ref.sha256 = current; changed++; } return changed; };
  const result: { sha256: string; profiles: { profileId: string; revision?: string; error?: string }[]; flows: { flowId: string; changed: number; revision?: string; error?: string }[] } = { sha256: current, profiles: [], flows: [] };
  for (const item of await profiles.list()) {
    try {
      const { draft, revision } = await profiles.readDraftWithRevision(item.profileId);
      if (!draft || typeof draft !== 'object' || !repin(records((draft as Raw).skills))) continue;
      result.profiles.push({ profileId: item.profileId, revision: await profiles.saveDraft(item.profileId, draft, revision) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.profiles.push({ profileId: item.profileId, error: error instanceof Error ? error.message : String(error) }); }
  }
  for (const item of await flows.list()) {
    try {
      const { draft, revision } = await flows.readDraftWithRevision(item.flowId);
      const changed = flowSkillLists(draft).reduce((sum, list) => sum + repin(list.refs), 0);
      if (!changed) continue;
      result.flows.push({ flowId: item.flowId, changed, revision: await flows.saveDraft(item.flowId, draft, revision) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.flows.push({ flowId: item.flowId, changed: 0, error: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}

/** Catalog entries with how many places pin each skill and how many of those pins are outdated. */
export async function skillLibrary(root: string) {
  const catalog = await skillCatalog(root);
  return Promise.all(catalog.map(async skill => {
    const usage = await skillUsage(root, skill.path);
    return { ...skill, editable: skill.source === 'neomind', used: usageCount(usage), stale: staleCount(usage) };
  }));
}
