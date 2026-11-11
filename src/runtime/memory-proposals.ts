import { readdirSync } from 'node:fs';
import { z } from 'zod';
import { LessonProposals, type LessonProposal } from '../memory/proposals.js';
import type { MemoryRecord, MemoryStore } from '../memory/store.js';
import { hashJson } from '../domain/resolve.js';
import { ruleCriterion } from '../domain/rules.js';
import { reviewEvidenceSchema } from '../core/review-evidence.js';
import type { RecoveryReport } from '../core/recovery.js';
import type { RunEvent } from '../storage/journal.js';

/** Proposals NeoMind derives from one run on its own; the user's own "remember this" notes have a separate, larger cap. */
export const maxAutoProposalsPerRun = 8;
export const maxUserNotesPerRun = 20;
type Kind = 'context' | 'decision' | 'lesson';

/** Two proposals or records say the same thing when type and normalized text match; scope and tags do not matter. */
export const memoryFingerprint = (record: { type: Kind; body: string }) => JSON.stringify([record.type, record.body.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()]);
/** IDs derived from content, so proposing the same thing again from the same run is a no-op. */
export const contentId = (prefix: string, value: unknown) => `${prefix}-${hashJson(value).slice(0, 24)}`;

export function proposalIds(directory: string): string[] {
  return readdirSync(directory).filter(file => file.endsWith('.proposal.json')).map(file => file.slice(0, -'.proposal.json'.length)).sort();
}

export interface ProposalState {
  proposal: LessonProposal; version: number; proposalHash: string; runId: string | null;
  expectedRevision: string | null; promoted: boolean; rejected: boolean;
}
/** Every proposal stored in one directory (a run's artifacts or the project's own queue) with its review state. */
export function proposalStates(directory: string, runId: string | null, store: MemoryStore | undefined): ProposalState[] {
  const proposals = new LessonProposals(directory);
  return proposalIds(directory).map(id => {
    const { proposal, version } = proposals.readVersion(id), current = store?.read(proposal.record.type, proposal.record.id);
    return { proposal, version, proposalHash: hashJson(proposal), runId, expectedRevision: current?.revision ?? null,
      promoted: current?.header.sources.includes(`proposal:${proposal.proposalId}`) ?? false, rejected: !!proposals.rejection(proposal.proposalId) };
  });
}

/** The approved record that already says what a proposal says, if any. */
export function duplicateRecord(records: MemoryRecord[], record: { type: Kind; body: string }): MemoryRecord | undefined {
  const key = memoryFingerprint(record);
  return records.find(item => memoryFingerprint({ type: item.header.type, body: item.body }) === key);
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;

/**
 * Proposals a finished (or cancelled) run suggests besides repaired review findings: the user's plan feedback, project
 * rules a reviewer found violated, and the reasons the run was blocked. They are only proposals: nothing reaches shared
 * memory before the user approves it. At most `maxAutoProposalsPerRun`, and the same text is proposed once per run.
 */
export function proposeFromRun(input: { directory: string; runId: string; task: string; report: RecoveryReport; events: RunEvent[]; rules?: { id: string; text: string }[] }): string[] {
  const store = new LessonProposals(input.directory), existing = proposalIds(input.directory).map(id => store.read(id));
  const seen = new Set(existing.map(item => memoryFingerprint(item.record)));
  let budget = maxAutoProposalsPerRun - existing.filter(item => item.origin !== 'user_note').length;
  const created: string[] = [], task = clip(input.task.split('\n')[0]!.trim(), 200);
  const add = (origin: NonNullable<LessonProposal['origin']>, type: Kind, body: string, tags: string[], sources: string[], reason: string) => {
    const key = memoryFingerprint({ type, body });
    if (budget <= 0 || seen.has(key)) return;
    const proposalId = contentId(type, { runId: input.runId, key });
    store.create({ proposalId, runId: input.runId, createdAt: new Date().toISOString(), origin, reason,
      record: { id: proposalId, type, scope: 'project', sources: [`run:${input.runId}`, ...sources], tags, body } });
    seen.add(key); budget--; created.push(proposalId);
  };
  for (const revision of input.report.planRevisions.slice(0, 3)) add('plan_revision', 'decision',
    `Khi lập kế hoạch, người dùng yêu cầu: ${clip(revision.feedback.trim(), 2000)}\n\n(Task gốc: ${task})`, ['plan-feedback'],
    [`run:${input.runId}/plan:${revision.planId}@${revision.version}`], 'Bạn đã yêu cầu sửa kế hoạch trong run này; ghi lại nếu yêu cầu đúng cho các run sau.');
  const rules = new Map((input.rules ?? []).map(rule => [ruleCriterion(rule), rule]));
  const violated = new Set<string>();
  for (const event of input.events) {
    if (event.type !== 'reviewer_output' || !rules.size) continue;
    const evidence = reviewEvidenceSchema.safeParse((event.payload as { evidence?: unknown }).evidence);
    for (const finding of evidence.success ? evidence.data.findings : []) {
      const rule = rules.get(finding.criterion);
      if (!rule || violated.has(rule.id)) continue;
      violated.add(rule.id);
      add('review_rule', 'lesson', `Rule ${rule.id} của project (${clip(rule.text, 400)}) đã bị vi phạm và reviewer yêu cầu sửa: ${clip(finding.explanation, 1500)}`,
        ['rule', 'review'], [`run:${input.runId}/event:${event.sequence}`], `Reviewer thấy rule ${rule.id} bị vi phạm; ghi lại để agent sau tránh lặp lại.`);
    }
  }
  const reasons = new Set<string>();
  for (const event of input.events) {
    if (event.type !== 'runtime_state') continue;
    const state = event.payload as { phase?: string; reason?: string };
    if (state.phase !== 'blocked' || !state.reason?.trim() || reasons.has(state.reason) || reasons.size >= 2) continue;
    reasons.add(state.reason);
    add('run_stopped', 'lesson', `Một run bị chặn với lý do: ${clip(state.reason.trim(), 1500)}\n\n(Task gốc: ${task})`, ['blocked'],
      [`run:${input.runId}/event:${event.sequence}`], 'Run bị chặn ở bước này; ghi lại nếu nguyên nhân sẽ lặp lại ở run khác.');
  }
  return created;
}

export const proposalInputSchema = z.strictObject({ type: z.enum(['context', 'decision', 'lesson']), scope: z.string().min(1).max(500).default('project'),
  tags: z.array(z.string().min(1).max(80)).max(20).default([]), body: z.string().trim().min(1).max(30000), sources: z.array(z.string().min(1).max(500)).min(1).max(20),
  reason: z.string().trim().min(1).max(2000), supersedes: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)).optional() });
export type ProposalInput = z.input<typeof proposalInputSchema>;

/** A readable record id from the first words of a note, made unique with a short random suffix. */
export function noteId(body: string, suffix: string): string {
  const slug = body.normalize('NFKD').replace(/\p{M}/gu, '').replace(/đ/gu, 'd').replace(/Đ/gu, 'D').toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 6).join('-').slice(0, 60).replace(/-+$/, '');
  return `${slug || 'note'}-${suffix}`.replace(/^-/, '');
}
