import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LEGACY_PROJECT_DIR, PROJECT_DIR } from './project-dir.js';
import { FLOW_AUTHORING_SKILL } from './project-guide-skill.js';

/**
 * The flow-authoring skill NeoMind installs into a project it configures, where agents find the runtime rules before
 * authoring a flow. Repositories that never use NeoMind do not get it. It goes to two places: `.agents/skills`, the
 * Agent Skills convention Codex and OpenCode scan, and `.claude/skills`, which Claude Code reads. No symlink between
 * them (Windows), so each copy is kept or replaced on its own.
 */
export const PROJECT_GUIDE_PATH = '.claude/skills/neomind-flow-authoring/SKILL.md';
export const SHARED_GUIDE_PATH = '.agents/skills/neomind-flow-authoring/SKILL.md';
export const PROJECT_GUIDE_PATHS = [SHARED_GUIDE_PATH, PROJECT_GUIDE_PATH] as const;
export type ProjectGuideStatus = 'created' | 'up-to-date' | 'modified-kept' | 'replaced';
export interface ProjectGuideResult { path: string; status: ProjectGuideStatus }

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
// A checkout with autocrlf turns the committed file into CRLF; that is still the same guide.
const sameGuide = (text: string) => text.replace(/\r\n/g, '\n') === FLOW_AUTHORING_SKILL;
function readGuide(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); } catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
}

/**
 * Write the guide into `projectRoot` at `guidePath`. A guide the user changed is kept unless `force`; the write never
 * follows a symlink and never replaces a file another writer created meanwhile. Synchronous so the first-write hook
 * below also works from the synchronous memory path.
 */
export function installProjectGuideAt(projectRoot: string, guidePath: string, options: { force?: boolean | undefined } = {}): ProjectGuideResult {
  const parts = guidePath.split('/'), target = path.join(projectRoot, ...parts);
  let current = projectRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) throw new Error(`Không ghi ${guidePath} qua symlink: ${path.relative(projectRoot, current)}`);
    if (index === parts.length - 1) break;
    if (!info) { try { mkdirSync(current); } catch (error) { if (errorCode(error) !== 'EEXIST') throw error; } }
    else if (!info.isDirectory()) throw new Error(`${path.relative(projectRoot, current)} không phải thư mục`);
  }
  const existing = readGuide(target);
  if (existing !== undefined && sameGuide(existing)) return { path: guidePath, status: 'up-to-date' };
  if (existing !== undefined && !options.force) return { path: guidePath, status: 'modified-kept' };
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, FLOW_AUTHORING_SKILL, { encoding: 'utf8', flag: 'wx' });
    if (existing !== undefined) { renameSync(temporary, target); return { path: guidePath, status: 'replaced' }; }
    // A hard link never replaces: a file that appeared since the read above is someone else's and stays.
    try { linkSync(temporary, target); return { path: guidePath, status: 'created' }; }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      return { path: guidePath, status: sameGuide(readGuide(target) ?? '') ? 'up-to-date' : 'modified-kept' };
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}

/** Both copies of the guide, `.agents/skills` first; each one is kept, created or replaced independently. */
export function installProjectGuide(projectRoot: string, options: { force?: boolean | undefined } = {}): ProjectGuideResult[] {
  return PROJECT_GUIDE_PATHS.map(guidePath => installProjectGuideAt(projectRoot, guidePath, options));
}

/**
 * Agents see only a skill's description and decide on their own whether to read it, so the guide is also named in the
 * project's agent instructions. The line is the one NeoMind's own AGENTS.md uses; it keeps pointing at the
 * `.claude/skills` copy, which exists in every project NeoMind configured, whichever version installed it.
 */
export const AGENTS_FILE = 'AGENTS.md';
export const CLAUDE_FILE = 'CLAUDE.md';
export const GUIDE_REFERENCE = `- Authoring NeoMind flows: read ${PROJECT_GUIDE_PATH} first.`;
export type GuideReferenceStatus = 'created' | 'appended' | 'present';
export interface GuideReferenceResult { path: string; status: GuideReferenceStatus }

// UTF-16 files keep their encoding; anything else is handled as latin1, which round-trips every byte, so a UTF-8 file
// (with or without BOM) or any other ASCII-compatible one is only ever extended by the ASCII text added here.
type Codec = 'latin1' | 'utf16le' | 'utf16be';
function decode(bytes: Buffer): { text: string; codec: Codec } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.toString('utf16le'), codec: 'utf16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: Buffer.from(bytes).swap16().toString('utf16le'), codec: 'utf16be' };
  return { text: bytes.toString('latin1'), codec: 'latin1' };
}
function encode(text: string, codec: Codec): Buffer {
  if (codec === 'latin1') return Buffer.from(text, 'latin1');
  const bytes = Buffer.from(text, 'utf16le');
  return codec === 'utf16be' ? bytes.swap16() : bytes;
}

/** `text` with the reference added: as the last item of an existing `## References` section, else as a new section. */
function withReference(text: string): string {
  const newline = text.indexOf('\n'), eol = newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
  if (text && !text.endsWith('\n')) text += eol;
  const cr = eol === '\r\n' ? '\r' : '', lines = text.split('\n');
  let fence = false, heading = -1, end = lines.length - 1;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (heading < 0 && /^##[ \t]+References[ \t]*$/i.test(line)) heading = index;
    else if (heading >= 0 && /^#{1,2}[ \t]/.test(line)) { end = index; break; }
  }
  if (heading < 0) {
    const gap = !text || text === eol || text.endsWith(`${eol}${eol}`) ? '' : eol;
    return `${text}${gap}## References${eol}${eol}${GUIDE_REFERENCE}${eol}`;
  }
  let last = heading;
  for (let index = heading + 1; index < end; index++) if (lines[index]!.trim()) last = index;
  lines.splice(last + 1, 0, ...(last === heading ? [cr] : []), `${GUIDE_REFERENCE}${cr}`);
  return lines.join('\n');
}

// A line naming either copy (or one the user moved elsewhere) already points agents at the guide.
const mentionsGuide = (text: string) => text.includes('neomind-flow-authoring/SKILL.md');
// Claude Code reads CLAUDE.md; one that imports AGENTS.md already shows the reference.
const importsAgents = (text: string) => /(^|\s)@(\.\/)?AGENTS\.md(\s|$)/m.test(text);

function fileBytes(projectRoot: string, name: string): { bytes: Buffer; mode: number } | undefined {
  const file = path.join(projectRoot, name);
  let info;
  try { info = lstatSync(file); } catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
  if (info.isSymbolicLink()) throw new Error(`Không ghi ${name} qua symlink`);
  if (!info.isFile()) throw new Error(`${name} không phải file`);
  return { bytes: readFileSync(file), mode: info.mode & 0o777 };
}

/**
 * Add the reference to `name` unless it already names the guide; `create` writes a file holding only the reference
 * section when there is none. Same write rules as the guide: no symlinks, a new file never replaces one another writer
 * created meanwhile, and an existing file is swapped in by rename only if it still has the bytes that were read.
 */
function addReference(projectRoot: string, name: string, create: boolean, present = mentionsGuide): GuideReferenceResult | undefined {
  const target = path.join(projectRoot, name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = fileBytes(projectRoot, name);
    if (!existing && !create) return undefined;
    const decoded = existing ? decode(existing.bytes) : { text: '', codec: 'latin1' as const };
    if (existing && present(decoded.text)) return { path: name, status: 'present' };
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, encode(withReference(decoded.text), decoded.codec), { flag: 'wx', ...(existing ? { mode: existing.mode } : {}) });
      if (!existing) {
        try { linkSync(temporary, target); return { path: name, status: 'created' }; }
        catch (error) { if (errorCode(error) !== 'EEXIST') throw error; continue; }
      }
      if (!fileBytes(projectRoot, name)?.bytes.equals(existing.bytes)) continue;
      renameSync(temporary, target);
      return { path: name, status: 'appended' };
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
  }
  throw new Error(`${name} đổi liên tục trong lúc thêm tham chiếu tới ${PROJECT_GUIDE_PATH}`);
}

/**
 * Make sure the project's agent instructions point at the guide: AGENTS.md gets the reference (created when missing).
 * When AGENTS.md is created next to an existing CLAUDE.md, that CLAUDE.md gets the reference too unless it already
 * imports AGENTS.md, since Claude Code does not read the AGENTS.md created for Codex. User content is only appended to.
 */
export function installGuideReference(projectRoot: string): GuideReferenceResult[] {
  const agents = addReference(projectRoot, AGENTS_FILE, true)!;
  if (agents.status !== 'created') return [agents];
  const claude = addReference(projectRoot, CLAUDE_FILE, false, text => mentionsGuide(text) || importsAgents(text));
  return claude ? [agents, claude] : [agents];
}

/**
 * Call after a write created NeoMind's folder in a project, with what `mkdir(…, { recursive: true })` returned (the
 * first folder it created) or the folder itself. Creating that folder is the project being configured for the first
 * time, so the guide and its reference in AGENTS.md are installed then and only then: later writes, and projects whose
 * folder already exists, leave `.claude/` and AGENTS.md alone. A failure only warns, because the write that created the
 * folder must not fail over the guide.
 */
export function projectDirCreated(created: string | undefined): void {
  if (!created || ![PROJECT_DIR, LEGACY_PROJECT_DIR].includes(path.basename(created))) return;
  const warn = (what: string, error: unknown) => console.warn(`NeoMind: không cài được ${what} (${error instanceof Error ? error.message : String(error)})`);
  for (const guidePath of PROJECT_GUIDE_PATHS) {
    try { installProjectGuideAt(path.dirname(created), guidePath); } catch (error) { warn(guidePath, error); }
  }
  try { installGuideReference(path.dirname(created)); } catch (error) { warn(`tham chiếu skill trong ${AGENTS_FILE}`, error); }
}
