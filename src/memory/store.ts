import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { syncDirectorySync } from '../storage/fs-sync.js';

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const kindSchema = z.enum(['context', 'decision', 'lesson']);
const lifecycle = { expiresAt: z.iso.datetime().optional(), supersedes: z.array(idSchema).optional() };
const inputSchema = z.strictObject({ id: idSchema, type: kindSchema, scope: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1), tags: z.array(z.string().min(1)), ...lifecycle, body: z.string().min(1) });
const headerSchema = z.strictObject({ id: idSchema, type: kindSchema, status: z.literal('approved'), scope: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1), tags: z.array(z.string().min(1)), updatedAt: z.iso.datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), ...lifecycle });
export type MemoryInput = z.infer<typeof inputSchema>;
export interface MemoryRecord { header: z.infer<typeof headerSchema>; body: string; revision: string }
export class MemoryConflict extends Error { constructor() { super('Memory revision conflict'); this.name = 'MemoryConflict'; } }
const sha = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
/** Record folders under the memory root; other files there (`feedback/`, `.cache/`) must not reuse these names. */
export const memoryFolders = { context: 'context', decision: 'decisions', lesson: 'lessons' } as const;
const folders = memoryFolders;
/** Plain substring search over a record's id, scope, tags and body, case-insensitive. */
export const matchesText = (record: MemoryRecord, query: string) =>
  `${record.header.id} ${record.header.scope} ${record.header.tags.join(' ')} ${record.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());

/** Shared Markdown memory. The SQLite database and root must be shared by all cooperating hosts.
 * This is not a sandbox; uncooperative file writers can race it. */
export class MemoryStore {
  readonly root: string;
  private readonly db: DatabaseSync;
  constructor(root: string, readonly coordinationDatabase: string) {
    // Never silently recreate an unavailable configured root.
    this.root = realpathSync.native(root);
    if (!lstatSync(this.root).isDirectory()) throw new Error('Memory root is not a directory');
    this.db = new DatabaseSync(coordinationDatabase);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  }
  close() { this.db.close(); }
  /** Run a change to files under the root while holding the same cross-process lock record writes take. */
  locked<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private file(type: z.infer<typeof kindSchema>, id: string, createDirectory = false): string {
    kindSchema.parse(type); idSchema.parse(id);
    const directory = path.join(this.root, folders[type]);
    if (createDirectory && !existsSync(directory)) mkdirSync(directory);
    if (existsSync(directory)) {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Memory directory is not a real directory');
    }
    const target = path.join(directory, `${id}.md`);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Memory record cannot be a symlink');
    return target;
  }
  private decode(bytes: string, type: z.infer<typeof kindSchema>, id: string): MemoryRecord {
    const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/.exec(bytes);
    if (!match) throw new Error('Malformed memory frontmatter');
    const header = headerSchema.parse(JSON.parse(match[1]!) as unknown), body = match[2]!;
    if (header.id !== id || header.type !== type || sha(body) !== header.contentHash) throw new Error('Memory record hash or identity mismatch');
    return { header, body, revision: sha(bytes) };
  }
  read(type: z.infer<typeof kindSchema>, id: string): MemoryRecord | undefined {
    const file = this.file(type, id);
    try { return this.decode(readFileSync(file, 'utf8'), type, id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  /** Returns approved, integrity-checked records matching all supplied filters. */
  search(filters: { query?: string; tags?: string[]; scope?: string; types?: Array<z.infer<typeof kindSchema>> } = {}): MemoryRecord[] {
    const types = filters.types ?? ['context', 'decision', 'lesson'];
    const records: MemoryRecord[] = [];
    for (const type of types) {
      kindSchema.parse(type);
      const directory = path.join(this.root, folders[type]);
      if (!existsSync(directory)) continue;
      const info = lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Memory directory is not a real directory');
      for (const filename of readdirSync(directory).sort()) {
        if (!filename.endsWith('.md')) continue;
        const id = filename.slice(0, -3);
        if (!idSchema.safeParse(id).success) continue;
        const record = this.read(type, id);
        if (!record) continue;
        if (filters.scope && record.header.scope !== filters.scope) continue;
        if (filters.tags && !filters.tags.every(tag => record.header.tags.includes(tag))) continue;
        if (filters.query && !matchesText(record, filters.query)) continue;
        records.push(record);
      }
    }
    return records;
  }
  /** Only the trusted application layer may grant project write or attest a user confirmation. */
  write(input: MemoryInput, expectedRevision: string | null, authorization: { projectWrite: boolean; confirmedByUser: boolean }): MemoryRecord {
    if (input.type === 'lesson') throw new Error('Lessons must be promoted from a proposal');
    return this.writeApproved(input, expectedRevision, authorization);
  }
  /** Called by proposal service after an explicit trusted user approval. */
  promoteLesson(proposal: { proposalId: string; approvalId: string; record: MemoryInput }, expectedRevision: string | null,
    authorization: { projectWrite: boolean; confirmedByUser: boolean }): MemoryRecord {
    if (proposal.record.type !== 'lesson') throw new Error('Proposal is not a lesson');
    return this.promoteProposal(proposal, expectedRevision, authorization);
  }
  /** A proposal of any type, promoted after an explicit trusted user approval; its receipts join the record's sources. */
  promoteProposal(proposal: { proposalId: string; approvalId: string; record: MemoryInput }, expectedRevision: string | null,
    authorization: { projectWrite: boolean; confirmedByUser: boolean }): MemoryRecord {
    idSchema.parse(proposal.proposalId); idSchema.parse(proposal.approvalId);
    if (!authorization.confirmedByUser) throw new Error('User confirmation required to promote a proposal');
    return this.writeApproved({ ...proposal.record, sources: [...proposal.record.sources, `proposal:${proposal.proposalId}`, `approval:${proposal.approvalId}`] }, expectedRevision, authorization);
  }
  /**
   * The user edits a record that is already approved (lessons included: their provenance stays in the sources). Creating
   * a record goes through `write` or a proposal, so the expected revision must name an existing one.
   */
  update(input: MemoryInput, expectedRevision: string, authorization: { projectWrite: boolean; confirmedByUser: boolean }): MemoryRecord {
    if (!this.read(input.type, input.id)) throw new Error('Memory record does not exist');
    return this.writeApproved(input, expectedRevision, authorization);
  }
  /** Remove an approved record the user confirmed; a record another one still supersedes is kept so the chain stays valid. */
  remove(type: z.infer<typeof kindSchema>, id: string, expectedRevision: string, authorization: { projectWrite: boolean; confirmedByUser: boolean }): void {
    if (!authorization.projectWrite || !authorization.confirmedByUser) throw new Error('User confirmation and project memory write permission required');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(type, id);
      if (!current) throw new Error('Memory record does not exist');
      if (current.revision !== expectedRevision) throw new MemoryConflict();
      const successor = this.search({ types: [type] }).find(record => record.header.supersedes?.includes(id));
      if (successor) throw new Error(`Bản ghi ${successor.header.id} đang thay thế bản ghi này; xóa hoặc sửa ${successor.header.id} trước`);
      const file = this.file(type, id);
      unlinkSync(file); syncDirectorySync(path.dirname(file));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private writeApproved(input: MemoryInput, expectedRevision: string | null, authorization: { projectWrite: boolean; confirmedByUser: boolean }): MemoryRecord {
    const value = inputSchema.parse(input);
    if (!authorization.projectWrite) throw new Error('Project memory write permission required');
    if (value.type !== 'context' && !authorization.confirmedByUser) throw new Error('User confirmation required for decisions and lessons');
    this.db.exec('BEGIN IMMEDIATE');
    let temporary: string | undefined;
    try {
      const current = this.read(value.type, value.id);
      if ((current?.revision ?? null) !== expectedRevision) throw new MemoryConflict();
      const supersedes = value.supersedes ?? [];
      const visit = (id: string, seen = new Set<string>()): void => {
        if (id === value.id) throw new Error('Memory supersession cannot contain a cycle');
        if (seen.has(id)) return; seen.add(id);
        const record = this.read(value.type, id); if (!record) throw new Error(`Superseded memory does not exist: ${id}`);
        for (const parent of record.header.supersedes ?? []) visit(parent, seen);
      };
      for (const id of supersedes) visit(id);
      const file = this.file(value.type, value.id, true);
      const header = headerSchema.parse({ id: value.id, type: value.type, status: 'approved', scope: value.scope,
        sources: value.sources, tags: value.tags, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}), ...(value.supersedes ? { supersedes: value.supersedes } : {}), updatedAt: new Date().toISOString(), contentHash: sha(value.body) });
      // A JSON object is valid YAML frontmatter and avoids unsafe YAML parsing.
      const bytes = `---\n${JSON.stringify(header)}\n---\n${value.body}`;
      temporary = `${file}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file); temporary = undefined;
      syncDirectorySync(path.dirname(file));
      this.db.exec('COMMIT');
      return this.decode(bytes, value.type, value.id);
    } catch (error) {
      if (temporary) { try { unlinkSync(temporary); } catch { /* preserve original error */ } }
      this.db.exec('ROLLBACK'); throw error;
    }
  }
}
