import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MemoryStore, type MemoryRecord } from './store.js';
import { hashJson } from '../domain/resolve.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const proposalSchema = z.strictObject({ proposalId: id, runId: id, createdAt: z.iso.datetime(),
  record: z.strictObject({ id, type: z.literal('lesson'), scope: z.string().min(1), sources: z.array(z.string().min(1)).min(1),
    tags: z.array(z.string().min(1)), body: z.string().min(1) }) });
const approvalSchema = z.strictObject({ approvalId: id, proposalId: id, proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), actor: z.string().min(1), approvedAt: z.iso.datetime() });
export type LessonProposal = z.infer<typeof proposalSchema>;
export type LessonApproval = z.infer<typeof approvalSchema>;

/** Immutable proposals and user approval receipts live with run artifacts, outside approved memory. */
export class LessonProposals {
  private readonly root: string;
  constructor(runArtifactRoot: string) {
    this.root = realpathSync.native(runArtifactRoot);
    if (!lstatSync(this.root).isDirectory()) throw new Error('Run artifact root is not a directory');
  }
  private path(itemId: string, kind: 'proposal' | 'approval'): string {
    const file = path.join(this.root, `${id.parse(itemId)}.${kind}.json`);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Artifact cannot be a symlink');
    return file;
  }
  private persist(file: string, value: unknown): void {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    const dir = openSync(this.root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  create(input: LessonProposal): void {
    const value = proposalSchema.parse(input);
    this.persist(this.path(value.proposalId, 'proposal'), value);
  }
  read(proposalId: string): LessonProposal {
    const proposal = proposalSchema.parse(JSON.parse(readFileSync(this.path(proposalId, 'proposal'), 'utf8')) as unknown);
    if (proposal.proposalId !== proposalId) throw new Error('Proposal identity mismatch');
    return proposal;
  }
  /** The caller must only provide confirmation after a trusted user action. */
  approve(proposalId: string, approvalId: string, actor: string, expectedRevision: string | null,
    authorization: { projectWrite: boolean; confirmedByUser: boolean }, expectedProposalHash?: string): LessonApproval {
    if (!authorization.projectWrite || !authorization.confirmedByUser) throw new Error('User confirmation and project memory write permission required');
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
    if (hash(proposal) !== approval.proposalHash) throw new Error('Approved proposal changed');
    return store.promoteLesson({ proposalId: proposal.proposalId, approvalId, record: proposal.record }, approval.expectedRevision,
      { projectWrite: true, confirmedByUser: true });
  }
}
