import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MemoryStore, type MemoryRecord } from './store.js';
import { hashJson } from '../domain/resolve.js';
import { syncDirectorySync } from '../storage/fs-sync.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const proposalSchema = z.strictObject({ proposalId: id, runId: id, createdAt: z.iso.datetime(), version: z.number().int().positive().optional(),
  record: z.strictObject({ id, type: z.literal('lesson'), scope: z.string().min(1), sources: z.array(z.string().min(1)).min(1),
    tags: z.array(z.string().min(1)), body: z.string().min(1) }) });
const approvalSchema = z.strictObject({ approvalId: id, proposalId: id, proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), actor: z.string().min(1), approvedAt: z.iso.datetime() });
const rejectionSchema = z.strictObject({ proposalId: id, proposalHash: z.string().regex(/^[a-f0-9]{64}$/), actor: z.string().min(1), rejectedAt: z.iso.datetime() });
const revisionSchema = z.strictObject({ version: z.number().int().min(2), previousHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposal: proposalSchema, editedAt: z.iso.datetime(), actor: z.string().min(1) });
export type LessonProposal = z.infer<typeof proposalSchema>;
export type LessonApproval = z.infer<typeof approvalSchema>;

/** Immutable proposals and user approval receipts live with run artifacts, outside approved memory. */
export class LessonProposals {
  private readonly root: string;
  constructor(runArtifactRoot: string) {
    this.root = realpathSync.native(runArtifactRoot);
    if (!lstatSync(this.root).isDirectory()) throw new Error('Run artifact root is not a directory');
  }
  private path(itemId: string, kind: 'proposal' | 'approval' | 'rejection'): string {
    const file = path.join(this.root, `${id.parse(itemId)}.${kind}.json`);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Artifact cannot be a symlink');
    return file;
  }
  private persist(file: string, value: unknown): void {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectorySync(this.root);
  }
  create(input: LessonProposal): void {
    const value = proposalSchema.parse(input);
    if (value.version !== undefined && value.version !== 1) throw new Error('A new proposal starts at version 1');
    this.persist(this.path(value.proposalId, 'proposal'), value);
  }
  readVersion(proposalId: string): { proposal: LessonProposal; version: number } {
    let proposal = proposalSchema.parse(JSON.parse(readFileSync(this.path(proposalId, 'proposal'), 'utf8')) as unknown);
    if (proposal.proposalId !== proposalId || (proposal.version !== undefined && proposal.version !== 1)) throw new Error('Proposal identity mismatch');
    const prefix = `${id.parse(proposalId)}.revision-`;
    const files = readdirSync(this.root).filter(file => file.startsWith(prefix) && /^\d{6}\.json$/.test(file.slice(prefix.length))).sort();
    for (const [index, name] of files.entries()) {
      const file = path.join(this.root, name);
      if (lstatSync(file).isSymbolicLink()) throw new Error('Artifact cannot be a symlink');
      const revision = revisionSchema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
      if (revision.version !== index + 2 || (revision.proposal.version !== undefined && revision.proposal.version !== revision.version) || name !== `${prefix}${String(revision.version).padStart(6, '0')}.json` || revision.previousHash !== hashJson(proposal)
        || revision.proposal.proposalId !== proposalId || revision.proposal.runId !== proposal.runId || revision.proposal.record.id !== proposal.record.id) throw new Error('Invalid proposal revision chain');
      proposal = revision.proposal;
    }
    return { proposal, version: files.length + 1 };
  }
  read(proposalId: string): LessonProposal { return this.readVersion(proposalId).proposal; }
  /** Append a new immutable revision; the expected hash binds the edit to what the user saw. */
  revise(proposalId: string, expectedHash: string, body: string, authorization: { confirmedByUser: boolean }) {
    if (!authorization.confirmedByUser) throw new Error('User confirmation required');
    if (this.rejection(proposalId)) throw new Error('Proposal was rejected');
    const previous = this.read(proposalId);
    if (hashJson(previous) !== expectedHash) throw new Error('Proposal changed since it was displayed');
    const prefix = `${id.parse(proposalId)}.revision-`;
    const version = readdirSync(this.root).filter(file => file.startsWith(prefix) && /^\d{6}\.json$/.test(file.slice(prefix.length))).length + 2;
    if (version > 999999) throw new Error('Too many proposal revisions');
    const proposal = proposalSchema.parse({ ...previous, version, record: { ...previous.record, body } });
    const revision = revisionSchema.parse({ version, previousHash: expectedHash, proposal, editedAt: new Date().toISOString(), actor: 'local-user' });
    this.persist(path.join(this.root, `${prefix}${String(version).padStart(6, '0')}.json`), revision);
    return { proposal, version, proposalHash: hashJson(proposal) };
  }
  rejection(proposalId: string) {
    try {
      const value = rejectionSchema.parse(JSON.parse(readFileSync(this.path(proposalId, 'rejection'), 'utf8')) as unknown);
      if (value.proposalId !== proposalId || value.proposalHash !== hashJson(this.read(proposalId))) throw new Error('Rejection does not match proposal');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  reject(proposalId: string, expectedProposalHash: string, authorization: { confirmedByUser: boolean }) {
    if (!authorization.confirmedByUser) throw new Error('User confirmation required');
    const proposal = this.read(proposalId), proposalHash = hashJson(proposal);
    if (proposalHash !== expectedProposalHash) throw new Error('Proposal changed since it was displayed');
    const receipt = rejectionSchema.parse({ proposalId, proposalHash, actor: 'local-user', rejectedAt: new Date().toISOString() });
    this.persist(this.path(proposalId, 'rejection'), receipt); return receipt;
  }
  /** The caller must only provide confirmation after a trusted user action. */
  approve(proposalId: string, approvalId: string, actor: string, expectedRevision: string | null,
    authorization: { projectWrite: boolean; confirmedByUser: boolean }, expectedProposalHash?: string): LessonApproval {
    if (!authorization.projectWrite || !authorization.confirmedByUser) throw new Error('User confirmation and project memory write permission required');
    if (this.rejection(proposalId)) throw new Error('Proposal was rejected');
    const proposal = this.read(proposalId);
    if (expectedProposalHash !== undefined && hashJson(proposal) !== expectedProposalHash) throw new Error('Proposal changed since it was displayed');
    const approval = approvalSchema.parse({ approvalId, proposalId, proposalHash: hash(proposal), expectedRevision, actor,
      approvedAt: new Date().toISOString() });
    this.persist(this.path(approvalId, 'approval'), approval);
    return approval;
  }
  promote(approvalId: string, store: MemoryStore, authorization: { projectWrite: boolean }): MemoryRecord {
    if (!authorization.projectWrite) throw new Error('Project memory write permission required');
    const approval = approvalSchema.parse(JSON.parse(readFileSync(this.path(approvalId, 'approval'), 'utf8')) as unknown);
    if (approval.approvalId !== approvalId) throw new Error('Approval identity mismatch');
    const proposal = this.read(approval.proposalId);
    if (this.rejection(approval.proposalId)) throw new Error('Proposal was rejected');
    if (hash(proposal) !== approval.proposalHash) throw new Error('Approved proposal changed');
    return store.promoteLesson({ proposalId: proposal.proposalId, approvalId, record: proposal.record }, approval.expectedRevision,
      { projectWrite: true, confirmedByUser: true });
  }
}
