import { effectiveBinding } from './run-binding.js';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CodexReadOnlyAdapter } from '../adapters/codex-readonly.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { flowSchema, projectPolicySchema } from '../domain/schema.js';
import { captureBaseline } from '../workspace/baseline.js';
import { WorkspaceCoordinator, type WorkspaceLease } from '../storage/coordination.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { evaluateReviews, type ReviewAssessment } from './review.js';
import { replayRun } from './recovery.js';
import { validateMaterializedRun } from '../domain/materialize.js';
import { assessReviewEvidence, reviewEvidenceSchema } from './review-evidence.js';
import type { WorkerScope } from '../adapters/systemd-scope.js';

export interface ReviewWorkspace { workspace: string; lease: WorkspaceLease; coordinator: WorkspaceCoordinator }
const outputSchema = z.strictObject({ verdict: z.enum(['pass', 'needs_changes', 'blocked', 'inconclusive']), findingIds: z.array(z.string().min(1)), summary: z.string().min(1) });
export const evidencedReviewSchema = outputSchema.extend({ evidence: reviewEvidenceSchema });
/** Reviewer execution is read-only; callers serialize journal transitions and verify evidence separately. */
export class CodexReviewDispatch {
  constructor(private readonly journal: OwnedJournal, private readonly adapter: CodexReadOnlyAdapter) {}
  usesJournal(journal: OwnedJournal) { return this.journal === journal; }
  private async verifyWorkspace(nodeId: string, baselineHash: string, context: ReviewWorkspace): Promise<void> {
    const events = await this.journal.read(), report = replayRun(events), { flow } = z.object({ flow: flowSchema }).parse(events[0]?.payload);
    const node = flow.definition.nodes.find(item => item.id === nodeId);
    const producer = node?.type === 'review_group' ? [...report.attempts].reverse().find(item => item.nodeId === node.targetNodeId && item.status === 'completed' && item.baselineHash === baselineHash) : undefined;
    const workspace = await realpath(context.workspace);
    if (!producer || producer.workspace !== workspace || producer.workspaceFence !== context.lease.fence ||
        context.lease.workspace !== workspace || context.lease.runId !== this.journal.runId || !context.coordinator.isCurrent(context.lease)) throw new Error('Review workspace or producer lease does not match');
    if ((await captureBaseline(workspace)).baselineHash !== baselineHash) throw new Error('Review baseline changed');
  }
  private async append(type: string, payload: unknown, requestId: string = randomUUID()) {
    const events = await this.journal.read();
    const event = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.journal.runId, requestId,
      type, timestamp: new Date().toISOString(), payload: z.json().parse(payload) };
    replayRun([...events, { ...event, sequence: events.length + 1 }]); await this.journal.append(event, events.length);
  }
  async dispatch(nodeId: string, reviewerId: string, threadId: string, prompt: string, effort: string,
    attemptId: string, requestId: string, baselineHash: string, context: ReviewWorkspace, authorized: boolean, scope?: WorkerScope): Promise<string> {
    if (!authorized) throw new Error('Explicit user continuation required');
    await this.verifyWorkspace(nodeId, baselineHash, context);
    const events = await this.journal.read(), report = replayRun(events);
    const created = z.object({ flow: flowSchema, policy: projectPolicySchema }).parse(events[0]?.payload);
    const node = created.flow.definition.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'review_group' || !node.reviewers.some(item => item.id === reviewerId)) throw new Error('Unknown reviewer');
    if (report.attempts.filter(item => item.status === 'unresolved').length >= Math.min(created.flow.definition.limits.maxConcurrency, created.policy.maxConcurrency)) throw new Error('Run concurrency limit reached');
    const payload = z.object({ snapshot: z.json().optional() }).parse(events[0]?.payload);
    const binding = payload.snapshot ? effectiveBinding(validateMaterializedRun(payload.snapshot), report.bindingSelections, `${nodeId}/${reviewerId}`) : undefined;
    if (payload.snapshot && !binding) throw new Error('Missing reviewer run binding');
    if (binding) { if (binding.reasoning !== effort) throw new Error('Reasoning does not match run binding'); this.adapter.assertBound(threadId, binding, await realpath(context.workspace)); }
    if (report.reviewerOutputs.some(item => item.nodeId === nodeId && item.result.reviewerId === reviewerId)) throw new Error('Reviewer already completed');
    if (scope && (!this.adapter.usesTransport(scope.transport) || !await scope.isActive())) throw new Error('Verified reviewer worker scope is required');
    const producer = [...report.attempts].reverse().find(item => item.nodeId === node.targetNodeId && item.status === 'completed' && item.baselineHash === baselineHash);
    if (!producer || producer.sessionId === threadId || report.attempts.some(item => item.nodeId === nodeId && item.reviewerId && item.reviewerId !== reviewerId && item.sessionId === threadId && item.round === report.repairRounds.length)) throw new Error('Review requires a completed producer and independent session');
    if (report.graph.nodes[nodeId]?.status === 'ready') await this.append('node_claimed', { nodeId });
    await this.append('dispatch_intent', { nodeId, sessionId: threadId, attemptId }, requestId);
    if (scope) await this.append('worker_scope_bound', { attemptId, unit: scope.identity.unit, controlGroup: scope.identity.controlGroup }, requestId);
    await this.append('reviewer_dispatch_bound', { attemptId, reviewerId, baselineHash }, requestId);
    let turnId: string;
    try { turnId = binding ? await this.adapter.startBoundTurn(threadId, prompt, binding, z.toJSONSchema(evidencedReviewSchema)) : await this.adapter.startTurn(threadId, prompt, effort, z.toJSONSchema(outputSchema)); }
    catch (error) { await this.append('dispatch_receipt', { attemptId, status: 'unknown' }, requestId); throw error; }
    await this.append('codex_turn_bound', { attemptId, turnId }, requestId);
    await this.append('dispatch_receipt', { attemptId, status: 'accepted' }, requestId);
    return turnId;
  }
  async record(nodeId: string, reviewerId: string, baselineHash: string, attemptId: string, turn: TurnResult, context: ReviewWorkspace): Promise<void> {
    await this.verifyWorkspace(nodeId, baselineHash, context);
    const report = replayRun(await this.journal.read()), attempt = report.attempts.find(item => item.attemptId === attemptId);
    if (!attempt || attempt.nodeId !== nodeId || attempt.sessionId !== turn.threadId || attempt.runnerTurnId !== turn.turnId ||
        attempt.status !== 'unresolved' || attempt.reviewerId !== reviewerId || attempt.reviewBaselineHash !== baselineHash || turn.status !== 'completed' || !turn.messages.length) throw new Error('Review output does not match completed turn');
    const materialized = z.object({ snapshot: z.json().optional() }).parse((await this.journal.read())[0]?.payload).snapshot !== undefined;
    const output = (materialized ? evidencedReviewSchema : outputSchema).parse(JSON.parse(turn.messages[turn.messages.length - 1]!) as unknown);
    const { summary, ...result } = output;
    const evidence = 'evidence' in output ? output.evidence : undefined;
    await this.append('reviewer_output', { nodeId, attemptId, summary, ...(evidence ? { evidence } : {}), result: { reviewerId, sessionId: turn.threadId, baselineHash, verdict: result.verdict, findingIds: result.findingIds } });
  }
  /** Assessments come from trusted core checks; reviewer output is never self-validating. */
  async finish(nodeId: string, producerSessionId: string, baselineHash: string, assessments: Record<string, ReviewAssessment>, context: ReviewWorkspace) {
    await this.verifyWorkspace(nodeId, baselineHash, context);
    const events = await this.journal.read(), report = replayRun(events);
    const { flow } = z.object({ flow: flowSchema }).parse(events[0]?.payload);
    const node = flow.definition.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'review_group') throw new Error('Not a review group');
    if (z.object({ snapshot: z.json().optional() }).parse(events[0]?.payload).snapshot) {
      assessments = {};
      const criteria = [...new Set([...node.criteria, ...report.approvals.flatMap(item => item.plan.acceptanceCriteria)])];
      for (const output of report.reviewerOutputs.filter(item => item.nodeId === nodeId)) assessments[output.result.reviewerId] = await assessReviewEvidence({ workspace: context.workspace, criteria, evidence: output.evidence, findingIds: output.result.findingIds, baselineHash, checks: report.checks, artifacts: report.artifacts.filter(item => item.nodeId === node.targetNodeId && item.baselineHash === baselineHash) });
      await this.verifyWorkspace(nodeId, baselineHash, context);
    }
    if (report.unresolvedCheckIds.length) throw new Error('A check has an unresolved outcome');
    const results = report.reviewerOutputs.filter(item => item.nodeId === nodeId).map(item => item.result);
    const decision = evaluateReviews(node.reviewers.map(r => ({ id: r.id, required: r.required })), results, assessments, baselineHash, producerSessionId);
    if (decision.decision !== 'pass') return decision;
    const approvedChecks = report.approvals.flatMap(item => item.plan.checks);
    for (const command of approvedChecks) {
      if (!report.checks.some(check => check.command === command && check.baselineHash === baselineHash && check.status === 'passed')) {
        throw new Error(`Approved check has not passed for this baseline: ${command}`);
      }
    }
    await this.append('review_accepted', { nodeId, baselineHash, producerSessionId, results, assessments });
    await this.append('node_completed', { nodeId, outcome: 'pass' }); return decision;
  }
}
