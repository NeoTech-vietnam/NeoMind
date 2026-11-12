import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { skillReferenceSchema, type Profile } from '../domain/schema.js';

export type SkillReference = Profile['skills'][number];
/**
 * Where a project keeps skills: `neomind/skills` (edited in NeoMind), `.agents/skills` (the Agent Skills convention
 * Codex and OpenCode scan) and `.claude/skills` (Claude Code). The last two are read-only here. Listed in the order a
 * duplicate ID is resolved: a pin holds a path, so the order only decides which copy the catalog offers.
 */
export type SkillSource = 'neomind' | 'agents' | 'claude';
export const SKILL_FOLDERS: Record<SkillSource, string> = { neomind: 'neomind/skills', agents: '.agents/skills', claude: '.claude/skills' };
export const skillSource = (value: unknown): SkillSource => value === 'agents' || value === 'claude' ? value : 'neomind';
/** Copies of the same skill ID in lower-priority sources, which the catalog lists behind the entry it offers. */
export type ShadowedSkill = { path: string; source: SkillSource; sha256: string };
export type CatalogSkill = SkillReference & { name: string; description: string; source: SkillSource; shadowed?: ShadowedSkill[] };

/** Frontmatter is descriptive data; it never changes the permissions of a run. */
export function skillMetadata(content: string, fallback: string): { name: string; description: string } {
  const match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { name: fallback, description: '' };
  try {
    const value: unknown = parse(match[1]!);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { name: fallback, description: '' };
    const record = value as Record<string, unknown>;
    return { name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : fallback,
      description: typeof record.description === 'string' ? record.description.trim() : '' };
  } catch { return { name: fallback, description: '' }; }
}

/** Resolve each reference before reading; a symlink must never escape the project. */
export async function resolveSkill(root: string, reference: SkillReference): Promise<{ path: string; bytes: Buffer }> {
  const ref = skillReferenceSchema.parse({ id: reference.id, path: reference.path, sha256: reference.sha256 }), base = await realpath(root);
  const target = await realpath(path.resolve(base, ref.path.replaceAll('\\', '/')));
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Skill path escapes project root: ${ref.path}`);
  return { path: target, bytes: await readFile(target) };
}

/**
 * Discover project-owned skill folders without following directory symlinks. One entry per ID: a skill also found in a
 * lower-priority source is listed once, with the other copies in `shadowed` so the editor can warn about them.
 */
export async function skillCatalog(root: string): Promise<CatalogSkill[]> {
  const result: CatalogSkill[] = [];
  for (const [source, folder] of Object.entries(SKILL_FOLDERS) as [SkillSource, string][]) {
    let entries;
    try { entries = await readdir(path.join(root, folder), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${folder}/${entry.name}/SKILL.md`, ref = { id: entry.name, path: relative, sha256: '0'.repeat(64) };
      if (!skillReferenceSchema.safeParse(ref).success) continue;
      try {
        const { bytes } = await resolveSkill(root, ref), sha256 = createHash('sha256').update(bytes).digest('hex');
        const listed = result.find(skill => skill.id === ref.id);
        if (listed) { (listed.shadowed ??= []).push({ path: relative, source, sha256 }); continue; }
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        result.push({ ...ref, sha256, ...skillMetadata(content, entry.name), source });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  // Listed as before .agents/skills existed: Claude Code's skills first, the project's own last (sort is stable).
  const listing: SkillSource[] = ['claude', 'agents', 'neomind'];
  return result.sort((a, b) => listing.indexOf(a.source) - listing.indexOf(b.source));
}

export async function skillStatus(root: string, refs: SkillReference[]) {
  return Promise.all(refs.map(async ref => {
    try { const { bytes } = await resolveSkill(root, ref); const sha256 = createHash('sha256').update(bytes).digest('hex'); return { ...ref, status: sha256 === ref.sha256 ? 'ok' as const : 'changed' as const, currentSha256: sha256 }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...ref, status: 'missing' as const }; throw error; }
  }));
}

/** List companion files only; do not read or follow their symlinks. */
export async function skillCompanions(root: string, skillPath: string): Promise<string[]> {
  if (path.basename(skillPath.replaceAll('\\', '/')) !== 'SKILL.md') return [];
  const base = await realpath(root), folder = path.dirname(skillPath.replaceAll('\\', '/')), result: string[] = [];
  const directory = await realpath(path.resolve(base, folder)), relative = path.relative(base, directory);
  if (!relative) return [];
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Skill path escapes project root: ${skillPath}`);
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(base, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && child !== skillPath.replaceAll('\\', '/')) result.push(child);
    }
  }
  await walk(folder); return result;
}
