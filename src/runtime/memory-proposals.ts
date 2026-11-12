import { readdirSync } from 'node:fs';
import { z } from 'zod';
import { LessonProposals, type LessonProposal } from '../memory/proposals.js';
import type { MemoryRecord, MemoryStore } from '../memory/store.js';
import { hashJson } from '../domain/resolve.js';
import { ruleCriterion } from '../domain/rules.js';
import { reviewEvidenceSchema, type ReviewEvidence } from '../core/review-evidence.js';
import { clipText, compactLegacyLessonBody, legacyLessonHeader, referenceLabels, repairLessonBody } from '../memory/lesson-body.js';
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

/**
 * The finding a repair round fixed, from the reviewer output that requested the round: the last `needs_changes` output
 * listing it before the round started. Undefined when the journal holds no such output with evidence.
 */
export function repairedFinding(events: RunEvent[], findingId: string): { nodeId: string; sequence: number; finding: ReviewEvidence['findings'][number] } | undefined {
  let candidate: { nodeId: string; sequence: number; finding: ReviewEvidence['findings'][number] } | undefined;
  for (const event of events) {
    if (event.type === 'repair_round_started' && candidate && (event.payload as { findingIds?: string[] }).findingIds?.includes(findingId)) return candidate;
    if (event.type !== 'reviewer_output') continue;
    const payload = event.payload as { nodeId?: unknown; evidence?: unknown; result?: { findingIds?: string[] } };
    const evidence = reviewEvidenceSchema.safeParse(payload.evidence), finding = evidence.success ? evidence.data.findings.find(item => item.id === findingId) : undefined;
    if (finding && typeof payload.nodeId === 'string') candidate = { nodeId: payload.nodeId, sequence: event.sequence, finding };
  }
  return candidate;
}

/**
 * The short body for an old-format repair lesson. The embedded evidence was cut at 5000 characters, so a finding listed
 * late is often missing from it; `events` (the source run's journal, when it still exists) hold the reviewer's full output.
 */
export function compactLegacyLesson(body: string, events: RunEvent[] | undefined): string | undefined {
  const fromText = compactLegacyLessonBody(body);
  if (fromText) return fromText.body;
  const header = legacyLessonHeader(body), found = header && events ? repairedFinding(events, header.findingId) : undefined;
  return header && found ? repairLessonBody({ runId: header.runId, nodeId: found.nodeId, finding: found.finding }) : undefined;
}

/**
 * Proposals a finished (or cancelled) run suggests besides repaired review findings: the user's plan feedback, project
 * rules a reviewer found violated, and the reasons the run was blocked. They are only proposals: nothing reaches shared
 * memory before the user approves it. At most `maxAutoProposalsPerRun`, and the same text is proposed once per run.
 */
export function proposeFromRun(input: { directory: string; runId: string; task: string; report: RecoveryReport; events: RunEvent[]; rules?: { id: string; text: string }[] }): string[] {
  const store = new LessonProposals(input.directory), existing = proposalIds(input.directory).map(id => store.read(id));
  const seen = new Set(existing.map(item => memoryFingerprint(item.record)));
  let budget = maxAutoProposalsPerRun - existing.filter(item => item.origin !== 'user_note').length;
  const created: string[] = [], task = clipText(input.task.split('\n')[0]!, 120);
  const add = (origin: NonNullable<LessonProposal['origin']>, type: Kind, body: string, tags: string[], sources: string[], reason: string) => {
    const key = memoryFingerprint({ type, body });
    if (budget <= 0 || seen.has(key)) return;
    const proposalId = contentId(type, { runId: input.runId, key });
    store.create({ proposalId, runId: input.runId, createdAt: new Date().toISOString(), origin, reason,
      record: { id: proposalId, type, scope: 'project', sources: [`run:${input.runId}`, ...sources], tags, body } });
    seen.add(key); budget--; created.push(proposalId);
  };
  // Every body is a title line plus a few short lines (at most `maxLessonBodyLength`); evidence stays in the run, cited by the sources.
  // NeoMind's own plan-rule revisions were fixed within the run and are not the user's preference.
  for (const revision of input.report.planRevisions.filter(item => item.author !== 'neomind').slice(0, 3)) add('plan_revision', 'decision',
    `When planning, the user asked: ${clipText(revision.feedback, 600)}\n(Original task: ${task})`, ['plan-feedback'],
    [`run:${input.runId}/plan:${revision.planId}@${revision.version}`], 'You asked for plan changes in this run; keep this if the request holds for later runs.');
  const rules = new Map((input.rules ?? []).map(rule => [ruleCriterion(rule), rule]));
  const violated = new Set<string>();
  for (const event of input.events) {
    if (event.type !== 'reviewer_output' || !rules.size) continue;
    const evidence = reviewEvidenceSchema.safeParse((event.payload as { evidence?: unknown }).evidence);
    for (const finding of evidence.success ? evidence.data.findings : []) {
      const rule = rules.get(finding.criterion);
      if (!rule || violated.has(rule.id)) continue;
      violated.add(rule.id);
      const { files } = referenceLabels(finding.references);
      add('review_rule', 'lesson', `Follow rule ${rule.id}: ${clipText(rule.text, 200)}\nProblem the reviewer found: ${clipText(finding.explanation, 400)}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`,
        ['rule', 'review'], [`run:${input.runId}/event:${event.sequence}`], `The reviewer found rule ${rule.id} violated; keep this so later agents avoid repeating it.`);
    }
  }
  const reasons = new Set<string>();
  for (const event of input.events) {
    if (event.type !== 'runtime_state') continue;
    const state = event.payload as { phase?: string; reason?: string };
    if (state.phase !== 'blocked' || !state.reason?.trim() || reasons.has(state.reason) || reasons.size >= 2) continue;
    reasons.add(state.reason);
    add('run_stopped', 'lesson', `Run blocked: ${clipText(state.reason, 500)}\n(Original task: ${task})`, ['blocked'],
      [`run:${input.runId}/event:${event.sequence}`], 'The run was blocked at this step; keep this if the cause will recur in other runs.');
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
