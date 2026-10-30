import { z } from 'zod';
import { validateMaterializedRun } from '../domain/materialize.js';
import { hashJson } from '../domain/resolve.js';
import { flowSchema, projectPolicySchema } from '../domain/schema.js';
import { approvalMatches, approvalSchema, planSchema, type Approval, type Plan } from '../domain/approval.js';
import { GraphScheduler, type Outcome, type SchedulerSnapshot } from './graph-scheduler.js';
import { evaluateReviews } from './review.js';
import { runEventSchema, type RunEvent } from '../storage/journal.js';
import { allocateRepairRound, type BudgetState } from './budget.js';
import { reviewEvidenceSchema, type ReviewEvidence } from './review-evidence.js';
import { runtimeArtifactSchema, runtimeContextSchema, runtimeStateSchema, type RuntimeArtifact, type RuntimeContext, type RuntimeState } from './runtime-state.js';
import { tokenUsageSchema, type TokenUsage } from './usage.js';
import { evaluateCondition } from './condition.js';
import type { BindingValues } from '../domain/resolve.js';
import { scopeBindingIdentity } from '../adapters/worker-scope.js';
import { branchLayout } from '../domain/branches.js';
import { IMPACT_RULE_VERSION, selectReviewersForChanges, sharedImpactPaths } from './review-impact.js';

const createdSchema = z.strictObject({ flow: z.unknown(), policy: projectPolicySchema, snapshot: z.json().optional() });
const nodeSchema = z.strictObject({ nodeId: z.string().min(1), writeScopes: z.array(z.string().min(1)).optional() });
const outcomeSchema = z.enum(['completed', 'pass', 'needs_changes', 'blocked', 'true', 'false']);
const intentSchema = z.strictObject({ nodeId: z.string().min(1), attemptId: z.string().min(1), sessionId: z.string().min(1) });
const receiptSchema = z.strictObject({ attemptId: z.string().min(1), status: z.enum(['accepted', 'unknown', 'rejected']) });
const finishedSchema = z.strictObject({ attemptId: z.string().min(1), status: z.enum(['completed', 'stopped']), baselineHash: z.string().min(1).optional() });
const gitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const commitIntentSchema = z.strictObject({ nodeId: z.string().min(1), reviewNodeId: z.string().min(1),
  baselineHash: z.string().min(1), expectedParent: gitObject, expectedTree: gitObject, workspaceTree: gitObject.optional() });
const commitReceiptSchema = z.strictObject({ nodeId: z.string().min(1), baselineHash: z.string().min(1),
  parent: gitObject, tree: gitObject, commit: gitObject });
const reviewResultSchema = z.strictObject({ reviewerId: z.string().min(1), sessionId: z.string().min(1),
  baselineHash: z.string().min(1), verdict: z.enum(['pass', 'needs_changes', 'blocked', 'inconclusive']), findingIds: z.array(z.string()) });
const reviewAssessmentSchema = z.strictObject({ evidenceValidated: z.boolean(), criteriaCovered: z.boolean(),
  verifiedFindingIds: z.array(z.string()), unresolvedDisagreement: z.boolean(), mandatoryCriteriaFailed: z.boolean() });

/** Conservative lexical scope check; wildcard expansion is not treated as evidence. */
function insideScope(child: string, parent: string): boolean {
  const normalize = (value: string): string | null => {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) return null;
    return normalized;
  };
  const a = normalize(child), b = normalize(parent);
  if (!a || !b) return false;
  if (b === '.') return true;
  return a === b || (!b.includes('*') && a.startsWith(`${b}/`));
}

export interface RecoveredAttempt {
  round: number;
  nodeId: string; attemptId: string; sessionId: string; requestId: string;
  receipt: 'missing' | 'accepted' | 'unknown' | 'rejected';
  status: 'unresolved' | 'completed' | 'stopped';
  baselineHash?: string; runnerTurnId?: string; workspace?: string; workspaceFence?: number; reviewerId?: string; reviewBaselineHash?: string; workerUnit?: string; workerControlGroup?: string;
  readonlyBaselineHash?: string;
  /** Produced by core (integration merge), not by a runner session. */
  core?: true;
}
/** Proof that a reviewer's pass at an earlier baseline still applies: nothing it reviewed changed and nothing shared changed. */
export interface ImpactReceipt { fromBaselineHash: string; oldTree: string; newTree: string; changedPaths: string[]; scopes: string[]; ruleVersion: number }
export interface RecoveredBranchWorkspace { nodeId: string; requestId: string; workspace: string; baseCommit: string; hostId?: string; fence?: number }
export interface RecoveredIntegration { nodeId: string; requestId: string; baseCommit: string; branches: { nodeId: string; commit: string; tree: string; baselineHash: string }[]; mergedTree: string; conflicts: string[]; baselineHash?: string }
export interface RecoveredCommit { nodeId: string; requestId: string; baselineHash: string; expectedParent: string; expectedTree: string; workspaceTree?: string; confirmed: boolean; workspace?: string; workspaceFence?: number; commit?: string }
export interface RecoveryReport {
  bindingSelections: { key: string; values: BindingValues; reason: string }[];
  timeExtensionsMs: number;
  usage: { totalTokens: number | null; partial: boolean; reportedAttemptIds: string[]; bySession: Record<string, TokenUsage>; costUSD: null };
  reviewValidationRetries: { nodeId: string; round: number; reviewerIds: string[] }[];
  planRevisions: { planningNodeId: string; planId: string; version: number; feedback: string }[];
  artifacts: RuntimeArtifact[];
  continuationBaselines: string[];
  runtimeContext?: RuntimeContext;
  runtimeState?: RuntimeState;
  repairRounds: { roundId: string; scopeId: string; baselineHash: string; findingIds: string[]; reviewedTree?: string }[];
  graph: SchedulerSnapshot;
  plans: { nodeId: string; attemptId: string; plan: Plan }[];
  approvals: { nodeId: string; plan: Plan; approval: Approval }[];
  reviewerOutputs: { nodeId: string; attemptId: string; summary: string; evidence?: ReviewEvidence; result: z.infer<typeof reviewResultSchema>; carried?: ImpactReceipt }[];
  acceptedReviews: { nodeId: string; baselineHash: string }[];
  checks: { checkId: string; requestId: string; command: string; baselineHash: string; status: 'unresolved' | 'passed' | 'failed' | 'abandoned'; outputHash?: string; workerUnit?: string; workerControlGroup?: string; workspace: string; workspaceFence: number }[];
  unresolvedCheckIds: string[];
  attempts: RecoveredAttempt[];
  unresolvedAttemptIds: string[];
  commits: RecoveredCommit[];
  unresolvedCommitNodeIds: string[];
  branchWorkspaces: RecoveredBranchWorkspace[];
  integrations: RecoveredIntegration[];
  unresolvedIntegrationNodeIds: string[];
  /** Commit nodes where the user chose to include the imported uncommitted changes. */
  includeImportedCommitNodeIds: string[];
  /** A flow without a commit hands its changes to the user: the patch applied (or being applied) to the checkout. */
  checkoutApply?: { tree: string; paths: string[]; patchHash: string; applied: boolean };
  /** Removal of a finished run's worktrees: refs written first to keep its commits, files knowingly discarded, and whether it finished. */
  workspaceCleanup?: { workspaces: string[]; refs: { ref: string; commit: string }[]; discarded: string[]; cleaned: boolean };
  /** Per review group, the reviewer outputs of the round the latest repair replaced. */
  priorReviewerOutputs: Record<string, RecoveryReport['reviewerOutputs']>;
  requiresUserContinue: true;
}

/**
 * Reconstructs graph state without dispatching or retrying effects. This is a
 * deliberately limited event vocabulary; unknown events fail closed. The
 * caller must reconcile live runtime and workspace before allowing dispatch.
 */
export function replayRun(events: RunEvent[]): RecoveryReport {
  const first = events[0];
  if (!first || first.type !== 'run_created' || first.sequence !== 1) throw new Error('Journal must begin with run_created');
  const seenEvents = new Set<string>();
  for (const [index, event] of events.entries()) {
    runEventSchema.parse(event);
    if (event.runId !== first.runId || event.sequence !== index + 1 || seenEvents.has(event.eventId)) throw new Error('Invalid run, sequence or duplicate event ID');
    seenEvents.add(event.eventId);
  }
  const initial = createdSchema.parse(first.payload);
  const flow = flowSchema.parse(initial.flow);
  if (initial.snapshot) {
    const snapshot = validateMaterializedRun(initial.snapshot);
    if (hashJson(snapshot.configuration.flow) !== hashJson(flow) || hashJson(snapshot.policy) !== hashJson(initial.policy)) throw new Error('Run snapshot does not match flow or policy');
  }
  const scheduler = new GraphScheduler(initial.flow, initial.policy);
  const attempts = new Map<string, RecoveredAttempt>();
  const repairRounds: RecoveryReport['repairRounds'] = [];
  const continuationBaselines: string[] = [];
  const artifacts: RuntimeArtifact[] = [];
  const planRevisions: RecoveryReport['planRevisions'] = [];
  const reviewValidationRetries: RecoveryReport['reviewValidationRetries'] = [];
  const usageBySession: Record<string, TokenUsage> = {}, usageAttempts = new Set<string>(); let usageReset = false;
  let timeExtensionsMs = 0;
  const bindingSelections: RecoveryReport['bindingSelections'] = [];
  let runtimeContext: RuntimeContext | undefined, runtimeState: RuntimeState | undefined;
  let budget: BudgetState = { runRoundsUsed: 0, scopesUsed: {}, allocations: {} };
  const requests = new Set<string>();
  const plans = new Map<string, { nodeId: string; attemptId: string; plan: Plan }>();
  const approvals: { nodeId: string; plan: Plan; approval: Approval }[] = [];
  const approvedNodes = new Set<string>();
  const approvedScopes: string[][] = [];
  const reviewerOutputs: RecoveryReport['reviewerOutputs'] = [];
  const checks = new Map<string, { checkId: string; requestId: string; command: string; baselineHash: string; status: 'unresolved' | 'passed' | 'failed' | 'abandoned'; outputHash?: string; workerUnit?: string; workerControlGroup?: string; workspace: string; workspaceFence: number }>();
  const acceptedReviews = new Map<string, string>();
  const commits = new Map<string, RecoveredCommit>();
  const layout = branchLayout(flow), branchWorkspaces = new Map<string, RecoveredBranchWorkspace>(), integrations = new Map<string, RecoveredIntegration>();
  const includeImported = new Set<string>();
  let checkoutApply: RecoveryReport['checkoutApply'];
  let workspaceCleanup: RecoveryReport['workspaceCleanup'];
  /** Reviewer outputs from the round a repair replaced; only these may be carried forward. */
  const priorOutputs = new Map<string, RecoveryReport['reviewerOutputs']>();
  for (const event of events.slice(1)) {
    if (event.runId !== first.runId) throw new Error('Journal contains another run');
    switch (event.type) {
      case 'binding_fallback_selected': {
        const payload = z.strictObject({ key: z.string().min(1), values: z.strictObject({ runner: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), reasoning: z.string().min(1) }), reason: z.string().min(1) }).parse(event.payload);
        const snapshot = initial.snapshot ? validateMaterializedRun(initial.snapshot) : undefined, binding = snapshot?.configuration.bindings[payload.key];
        if (!binding || !binding.fallback.some(candidate => hashJson(candidate) === hashJson(payload.values)) || [...attempts.values()].some(item => item.nodeId === payload.key.split('/')[0] && item.status === 'unresolved')) throw new Error('Fallback is outside the snapshot allowlist or the step is active');
        bindingSelections.push(payload); break;
      }
      case 'runtime_time_extended': {
        const { seconds } = z.strictObject({ seconds: z.number().int().positive().max(86400) }).parse(event.payload);
        if (!runtimeContext || !runtimeState || !['paused', 'blocked', 'recovering'].includes(runtimeState.phase) || [...attempts.values()].some(item => item.status === 'unresolved')) throw new Error('Time extension requires a stopped run');
        timeExtensionsMs += seconds * 1000; break;
      }
      case 'condition_evaluated': {
        const payload = z.strictObject({ nodeId: z.string().min(1), value: z.boolean() }).parse(event.payload), node = flow.definition.nodes.find(item => item.id === payload.nodeId);
        if (node?.type !== 'condition') throw new Error('Not a condition node');
        const value = evaluateCondition(node, { nodes: scheduler.snapshot().nodes, incomingIds: flow.definition.edges.filter(edge => edge.to === node.id).map(edge => edge.from), checks: [...checks.values()], acceptedReviewCount: acceptedReviews.size, repairRounds: repairRounds.length });
        if (value !== payload.value) throw new Error('Condition result does not match durable facts');
        scheduler.claim(node.id); scheduler.complete(node.id, value ? 'true' : 'false'); break;
      }
      case 'readonly_baseline_bound': {
        const payload = z.strictObject({ attemptId: z.string().min(1), baselineHash: z.string().min(1) }).parse(event.payload), attempt = attempts.get(payload.attemptId);
        const node = flow.definition.nodes.find(item => item.id === attempt?.nodeId);
        if (!attempt || attempt.requestId !== event.requestId || attempt.readonlyBaselineHash || node?.type !== 'agent_task' || node.permissions.write) throw new Error('Invalid read-only baseline binding');
        attempt.readonlyBaselineHash = payload.baselineHash; break;
      }
      case 'usage_observed': {
        const payload = z.strictObject({ attemptId: z.string().min(1), threadId: z.string().min(1), turnId: z.string().min(1), total: tokenUsageSchema }).parse(event.payload);
        const attempt = attempts.get(payload.attemptId);
        if (!attempt || attempt.sessionId !== payload.threadId || attempt.runnerTurnId !== payload.turnId) throw new Error('Usage does not match a dispatched turn');
        const previous = usageBySession[payload.threadId];
        if (previous && previous.totalTokens > payload.total.totalTokens) usageReset = true;
        else usageBySession[payload.threadId] = payload.total;
        usageAttempts.add(payload.attemptId); break;
      }
      case 'git_commit_abandoned': {
        const { nodeId } = z.strictObject({ nodeId: z.string().min(1) }).parse(event.payload), commit = commits.get(nodeId);
        if (!commit || commit.confirmed || commit.requestId !== event.requestId) throw new Error('No unresolved Git intent to abandon');
        commits.delete(nodeId); scheduler.requeue(nodeId); break;
      }
      case 'producer_baseline_updated': {
        const payload = z.strictObject({ attemptId: z.string().min(1), baselineHash: z.string().min(1) }).parse(event.payload);
        const attempt = attempts.get(payload.attemptId);
        if (!attempt || attempt.status !== 'completed' || !attempt.baselineHash || !continuationBaselines.includes(payload.baselineHash) || commits.size || [...attempts.values()].some(item => item.status === 'unresolved') || [...checks.values()].some(item => item.status === 'unresolved')) throw new Error('Producer baseline cannot be updated');
        attempt.baselineHash = payload.baselineHash;
        for (const node of flow.definition.nodes) if (node.type === 'review_group' && node.targetNodeId === attempt.nodeId) {
          acceptedReviews.delete(node.id);
          for (let index = reviewerOutputs.length - 1; index >= 0; index--) if (reviewerOutputs[index]?.nodeId === node.id) reviewerOutputs.splice(index, 1);
          scheduler.invalidateFrom(node.id);
        }
        break;
      }
      case 'review_retry_requested': {
        const { nodeId, reason, reviewerIds } = z.strictObject({ nodeId: z.string().min(1), reason: z.enum(['user', 'validation']).default('user'), reviewerIds: z.array(z.string().min(1)).optional() }).parse(event.payload);
        if (flow.definition.nodes.find(item => item.id === nodeId)?.type !== 'review_group' || acceptedReviews.has(nodeId) || !['running', 'ready'].includes(scheduler.snapshot().nodes[nodeId]?.status ?? '') || [...attempts.values()].some(item => item.nodeId === nodeId && item.status === 'unresolved')) throw new Error('Review cannot be retried in its current state');
        if (reason === 'validation') {
          if (!reviewerIds?.length || reviewValidationRetries.some(item => item.nodeId === nodeId && item.round === repairRounds.length)) throw new Error('Review output validation retry exhausted');
          reviewValidationRetries.push({ nodeId, round: repairRounds.length, reviewerIds });
        }
        for (let index = reviewerOutputs.length - 1; index >= 0; index--) { const output = reviewerOutputs[index]; if (output?.nodeId === nodeId && (!reviewerIds || reviewerIds.includes(output.result.reviewerId))) reviewerOutputs.splice(index, 1); }
        break;
      }
      case 'plan_revision_requested': {
        const request = z.strictObject({ planningNodeId: z.string().min(1), planId: z.string().min(1), version: z.number().int().positive(), feedback: z.string().min(1).max(10000) }).parse(event.payload);
        const previous = plans.get(request.planningNodeId);
        if (!previous || previous.plan.planId !== request.planId || previous.plan.version + 1 !== request.version || approvals.length || [...attempts.values()].some(item => item.status === 'unresolved')) throw new Error('Plan revision does not match an unapproved plan');
        scheduler.replan(request.planningNodeId); plans.delete(request.planningNodeId); planRevisions.push(request); break;
      }
      case 'runtime_artifact': {
        const artifact = runtimeArtifactSchema.parse(event.payload);
        if (artifact.attemptId) { const attempt = attempts.get(artifact.attemptId); if (!attempt || attempt.nodeId !== artifact.nodeId || artifact.baselineHash !== (attempt.baselineHash ?? attempt.readonlyBaselineHash)) throw new Error('Artifact does not match producer baseline'); }
        artifacts.push(artifact); break;
      }
      case 'node_requeued': {
        const { nodeId } = z.strictObject({ nodeId: z.string().min(1) }).parse(event.payload);
        if ([...attempts.values()].some(attempt => attempt.nodeId === nodeId && attempt.status === 'unresolved') || [...commits.values()].some(item => item.nodeId === nodeId && !item.confirmed) || [...checks.values()].some(item => item.status === 'unresolved')) throw new Error('Cannot requeue unresolved work');
        scheduler.requeue(nodeId); break;
      }
      case 'continuation_baseline': {
        const { baselineHash } = z.strictObject({ baselineHash: z.string().min(1) }).parse(event.payload);
        if (!runtimeContext || !approvals.length || [...attempts.values()].some(item => item.status === 'unresolved')) throw new Error('Continuation requires reconciled work and approved scope');
        continuationBaselines.push(baselineHash); break;
      }
      case 'runtime_context': {
        if (runtimeContext || attempts.size) throw new Error('Runtime context must be recorded once before dispatch');
        runtimeContext = runtimeContextSchema.parse(event.payload);
        if (runtimeContext.lease.runId !== first.runId || runtimeContext.lease.workspace !== runtimeContext.workspace) throw new Error('Runtime context lease mismatch');
        break;
      }
      case 'runtime_state': {
        const next = runtimeStateSchema.parse(event.payload);
        if (!runtimeContext || next.activeMs < (runtimeState?.activeMs ?? 0)) throw new Error('Invalid runtime checkpoint');
        runtimeState = next; break;
      }
      case 'repair_round_started': {
        const payload = z.strictObject({ roundId: z.string().min(1), scopeId: z.string().min(1), baselineHash: z.string().min(1), findingIds: z.array(z.string().min(1)).min(1), reviewedTree: gitObject.optional() }).parse(event.payload);
        const scope = flow.definition.nodes.find(node => node.id === payload.scopeId);
        if (scope?.type !== 'repair_scope' || repairRounds.some(round => round.roundId === payload.roundId)) throw new Error('Invalid repair round');
        const outputs = reviewerOutputs.filter(item => item.nodeId === scope.targetReviewId);
        if (!payload.findingIds.every(id => outputs.some(item => item.result.baselineHash === payload.baselineHash && item.result.verdict === 'needs_changes' && item.result.findingIds.includes(id)))) throw new Error('Repair findings do not match current review');
        budget = allocateRepairRound(budget, payload.roundId, [scope.id], Math.min(flow.definition.limits.maxRepairRounds, initial.policy.maxRepairRounds), { [scope.id]: scope.maxRounds });
        if ([...attempts.values()].some(attempt => attempt.status === 'unresolved')) throw new Error('Cannot repair while attempts are unresolved');
        scheduler.repair(scope.id);
        priorOutputs.set(scope.targetReviewId, outputs.filter(item => item.result.baselineHash === payload.baselineHash));
        for (let index = reviewerOutputs.length - 1; index >= 0; index--) if (reviewerOutputs[index]?.nodeId === scope.targetReviewId) reviewerOutputs.splice(index, 1);
        acceptedReviews.delete(scope.targetReviewId);
        const { reviewedTree, ...round } = payload; repairRounds.push(reviewedTree ? { ...round, reviewedTree } : round); break;
      }
      case 'node_claimed': {
        const { nodeId, writeScopes } = nodeSchema.parse(event.payload);
        const node = flow.definition.nodes.find(n => n.id === nodeId);
        const writer = node?.type === 'integration' || (node?.type === 'agent_task' && node.permissions.write);
        if (writer && (node?.type === 'agent_task' || node?.type === 'integration')) {
          if (!writeScopes?.length || !writeScopes.every(scope => node.writeScopes.some(allowed => insideScope(scope, allowed)))) {
            throw new Error(`Writer ${nodeId} lacks a valid declared scope`);
          }
          if (initial.policy.requireApprovalBeforeWrite && !approvedScopes.some(scopes =>
            writeScopes.every(scope => scopes.some(approved => insideScope(scope, approved))))) {
            throw new Error(`Writer ${nodeId} is outside the approved scope`);
          }
        }
        scheduler.claim(nodeId); break;
      }
      case 'node_completed': {
        const { nodeId, outcome } = z.strictObject({ nodeId: z.string().min(1), outcome: outcomeSchema }).parse(event.payload);
        const node = flow.definition.nodes.find(n => n.id === nodeId);
        if ([...attempts.values()].some(a => a.nodeId === nodeId && a.status === 'unresolved' && a.receipt !== 'rejected')) {
          throw new Error(`Cannot complete node ${nodeId} with unresolved attempts`);
        }
        if (node?.type === 'agent_task' &&
            ![...attempts.values()].some(a => a.nodeId === nodeId && a.status === 'completed')) {
          throw new Error(`Cannot complete agent node ${nodeId} without a completed attempt`);
        }
        if (node?.type === 'integration') {
          const latest = [...attempts.values()].filter(a => a.nodeId === nodeId).at(-1);
          if (!integrations.get(nodeId)?.baselineHash || latest?.status !== 'completed' || !latest.baselineHash) throw new Error(`Cannot complete integration ${nodeId} without an applied merge and a completed result`);
        }
        if (node?.type === 'approval' && outcome === 'pass' && !approvedNodes.has(nodeId)) {
          throw new Error(`Cannot pass approval node ${nodeId} without a matching user approval`);
        }
        if (node?.type === 'review_group' && outcome === 'pass' && !acceptedReviews.has(nodeId)) {
          throw new Error(`Cannot pass review node ${nodeId} without accepted review evidence`);
        }
        if (node?.type === 'git_commit' && outcome === 'completed' && !commits.get(nodeId)?.confirmed) {
          throw new Error(`Cannot complete Git node ${nodeId} without a matching commit receipt`);
        }
        scheduler.complete(nodeId, outcome as Outcome); break;
      }
      case 'node_failed': {
        const { nodeId, reason } = z.strictObject({ nodeId: z.string().min(1), reason: z.string().min(1) }).parse(event.payload);
        if ([...attempts.values()].some(a => a.nodeId === nodeId && a.status === 'unresolved' && a.receipt !== 'rejected')) {
          throw new Error(`Cannot fail node ${nodeId} with unresolved attempts`);
        }
        scheduler.fail(nodeId, reason); break;
      }
      case 'dispatch_intent': {
        const intent = intentSchema.parse(event.payload);
        if (attempts.has(intent.attemptId) || requests.has(event.requestId)) throw new Error('Duplicate attempt or dispatch request');
        if (scheduler.snapshot().nodes[intent.nodeId]?.status !== 'running') throw new Error('Dispatch intent requires a claimed node');
        attempts.set(intent.attemptId, { ...intent, round: repairRounds.length, requestId: event.requestId, receipt: 'missing', status: 'unresolved' });
        requests.add(event.requestId); break;
      }
      case 'plan_proposed': {
        const payload = z.strictObject({ nodeId: z.string().min(1), attemptId: z.string().min(1), plan: planSchema }).parse(event.payload);
        const attempt = attempts.get(payload.attemptId);
        const revision = [...planRevisions].reverse().find(item => item.planningNodeId === payload.nodeId);
        if (revision && (payload.plan.planId !== revision.planId || payload.plan.version !== revision.version)) throw new Error('Plan version does not match the requested revision');
        const node = flow.definition.nodes.find(n => n.id === payload.nodeId);
        if (node?.type !== 'agent_task' || node.outputContract !== 'plan' || !attempt || attempt.nodeId !== node.id ||
            (attempt.status !== 'completed' && attempt.status !== 'unresolved') || !attempt.runnerTurnId || attempt.receipt === 'rejected' || plans.has(node.id)) throw new Error('Plan must come from a valid planning attempt');
        attempt.status = 'completed'; plans.set(node.id, payload); break;
      }
      case 'approval_recorded': {
        const payload = z.strictObject({ nodeId: z.string().min(1), plan: planSchema, approval: approvalSchema }).parse(event.payload);
        const node = flow.definition.nodes.find(n => n.id === payload.nodeId);
        if (node?.type !== 'approval' || scheduler.snapshot().nodes[payload.nodeId]?.status !== 'running') {
          throw new Error('Approval must refer to a claimed approval node');
        }
        const predecessors = flow.definition.edges.filter(edge => edge.to === payload.nodeId).map(edge => plans.get(edge.from)).filter(item => item !== undefined);
        if (predecessors.length && !predecessors.some(item => JSON.stringify(item.plan) === JSON.stringify(payload.plan))) throw new Error('Approval does not match proposed plan');
        if (!approvalMatches(payload.approval, payload.plan, initial.policy)) throw new Error('Approval does not match plan and policy');
        // NeoMind approves only an approval node the flow marked automatic, and only when the run's policy allowed it.
        if (payload.approval.source === 'flow' && (node.mode !== 'auto' || initial.policy.allowAutoApproval === false)) throw new Error('Automatic approval is not allowed for this approval node');
        approvals.push(payload); approvedNodes.add(payload.nodeId); approvedScopes.push(payload.plan.scope); break;
      }
      case 'check_intent': {
        const payload = z.strictObject({ checkId: z.string().min(1), command: z.string().min(1), baselineHash: z.string().min(1), workspace: z.string().min(1), workspaceFence: z.number().int().positive() }).parse(event.payload);
        if (checks.has(payload.checkId) || requests.has(event.requestId)) throw new Error('Duplicate check intent');
        checks.set(payload.checkId, { ...payload, requestId: event.requestId, status: 'unresolved' }); requests.add(event.requestId); break;
      }
      case 'check_scope_bound': {
        const binding = z.strictObject({ checkId: z.string().min(1), ...scopeBindingIdentity }).parse(event.payload);
        const check = checks.get(binding.checkId);
        if (!check || check.status !== 'unresolved' || check.workerUnit || check.requestId !== event.requestId) throw new Error('Unexpected check scope binding');
        check.workerUnit = binding.unit; check.workerControlGroup = binding.controlGroup; break;
      }
      case 'check_abandoned': {
        const payload = z.strictObject({ checkId: z.string().min(1) }).parse(event.payload), check = checks.get(payload.checkId);
        if (!check || check.status !== 'unresolved' || check.requestId !== event.requestId || !check.workerUnit) throw new Error('Unexpected check reconciliation');
        check.status = 'abandoned'; break;
      }
      case 'check_finished': {
        const payload = z.strictObject({ checkId: z.string().min(1), exitCode: z.number().int(), outputHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(event.payload);
        const check = checks.get(payload.checkId);
        if (!check || check.status !== 'unresolved' || check.requestId !== event.requestId) throw new Error('Unexpected check result');
        check.status = payload.exitCode === 0 ? 'passed' : 'failed'; check.outputHash = payload.outputHash; break;
      }
      case 'reviewer_output': {
        const payload = z.strictObject({ nodeId: z.string().min(1), attemptId: z.string().min(1), summary: z.string().min(1), evidence: reviewEvidenceSchema.optional(), result: reviewResultSchema }).parse(event.payload);
        const node = flow.definition.nodes.find(n => n.id === payload.nodeId), attempt = attempts.get(payload.attemptId);
        if (node?.type !== 'review_group' || !node.reviewers.some(r => r.id === payload.result.reviewerId) || !attempt ||
            attempt.nodeId !== node.id || (attempt.status !== 'completed' && attempt.status !== 'unresolved') || !attempt.runnerTurnId || attempt.receipt === 'rejected' || attempt.sessionId !== payload.result.sessionId || attempt.reviewerId !== payload.result.reviewerId ||
            attempt.reviewBaselineHash !== payload.result.baselineHash ||
            reviewerOutputs.some(item => item.attemptId === payload.attemptId || item.nodeId === node.id && item.result.reviewerId === payload.result.reviewerId)) throw new Error('Invalid reviewer output');
        attempt.status = 'completed'; reviewerOutputs.push({ nodeId: payload.nodeId, attemptId: payload.attemptId, summary: payload.summary, result: payload.result, ...(payload.evidence ? { evidence: payload.evidence } : {}) }); break;
      }
      case 'review_accepted': {
        const payload = z.strictObject({ nodeId: z.string().min(1), baselineHash: z.string().min(1), producerSessionId: z.string().min(1),
          results: z.array(reviewResultSchema), assessments: z.record(z.string(), reviewAssessmentSchema) }).parse(event.payload);
        const node = flow.definition.nodes.find(n => n.id === payload.nodeId);
        if (node?.type !== 'review_group' || scheduler.snapshot().nodes[payload.nodeId]?.status !== 'running') {
          throw new Error('Review evidence must refer to a claimed review node');
        }
        const producer = [...attempts.values()].find(a => a.nodeId === node.targetNodeId && a.status === 'completed' &&
          a.sessionId === payload.producerSessionId && a.baselineHash === payload.baselineHash);
        if (!producer) throw new Error('Review producer session does not match a completed target attempt');
        const decision = evaluateReviews(node.reviewers.map(r => ({ id: r.id, required: r.required })), payload.results,
          payload.assessments, payload.baselineHash, payload.producerSessionId);
        if (decision.decision !== 'pass') throw new Error('Review evidence does not meet required acceptance');
        acceptedReviews.set(payload.nodeId, payload.baselineHash); break;
      }
      case 'git_commit_intent': {
        const intent = commitIntentSchema.parse(event.payload);
        if (flow.definition.nodes.find(n => n.id === intent.nodeId)?.type !== 'git_commit' || scheduler.snapshot().nodes[intent.nodeId]?.status !== 'running') {
          throw new Error('Git intent must refer to a claimed commit node');
        }
        if (acceptedReviews.get(intent.reviewNodeId) !== intent.baselineHash) throw new Error('Git intent must match an accepted review baseline');
        if (commits.has(intent.nodeId)) throw new Error('Duplicate Git commit intent');
        commits.set(intent.nodeId, { nodeId: intent.nodeId, requestId: event.requestId, baselineHash: intent.baselineHash,
          expectedParent: intent.expectedParent, expectedTree: intent.expectedTree, ...(intent.workspaceTree ? { workspaceTree: intent.workspaceTree } : {}), confirmed: false });
        break;
      }
      case 'git_workspace_bound': {
        const binding = z.strictObject({ nodeId: z.string().min(1), workspace: z.string().min(1), fence: z.number().int().positive() }).parse(event.payload);
        const commit = commits.get(binding.nodeId);
        if (!commit || commit.confirmed || commit.workspace || commit.requestId !== event.requestId) throw new Error('Unexpected Git workspace binding');
        commit.workspace = binding.workspace; commit.workspaceFence = binding.fence; break;
      }
      case 'git_commit_receipt': {
        const receipt = commitReceiptSchema.parse(event.payload), intent = commits.get(receipt.nodeId);
        if (!intent || intent.confirmed || intent.requestId !== event.requestId || intent.baselineHash !== receipt.baselineHash ||
            intent.expectedParent !== receipt.parent || intent.expectedTree !== receipt.tree) throw new Error('Git commit receipt does not match intent');
        intent.confirmed = true; intent.commit = receipt.commit; break;
      }
      case 'worker_scope_bound': {
        const binding = z.strictObject({ attemptId: z.string().min(1), ...scopeBindingIdentity }).parse(event.payload);
        const attempt = attempts.get(binding.attemptId);
        if (!attempt || attempt.requestId !== event.requestId || attempt.workerUnit || attempt.status !== 'unresolved') throw new Error('Unexpected worker scope binding');
        attempt.workerUnit = binding.unit; attempt.workerControlGroup = binding.controlGroup; break;
      }
      case 'reviewer_dispatch_bound': {
        const binding = z.strictObject({ attemptId: z.string().min(1), reviewerId: z.string().min(1), baselineHash: z.string().min(1) }).parse(event.payload);
        const attempt = attempts.get(binding.attemptId), node = flow.definition.nodes.find(n => n.id === attempt?.nodeId);
        if (!attempt || node?.type !== 'review_group' || attempt.requestId !== event.requestId || attempt.reviewerId ||
            !node.reviewers.some(r => r.id === binding.reviewerId) ||
            reviewerOutputs.some(item => item.nodeId === node.id && item.result.reviewerId === binding.reviewerId) ||
            [...attempts.values()].some(item => item.attemptId !== attempt.attemptId && item.nodeId === node.id && item.reviewerId === binding.reviewerId && item.status === 'unresolved')) throw new Error('Unexpected reviewer binding');
        attempt.reviewerId = binding.reviewerId; attempt.reviewBaselineHash = binding.baselineHash; break;
      }
      case 'workspace_dispatch_bound': {
        const binding = z.strictObject({ attemptId: z.string().min(1), workspace: z.string().min(1), fence: z.number().int().positive() }).parse(event.payload);
        const attempt = attempts.get(binding.attemptId);
        if (!attempt || attempt.requestId !== event.requestId || attempt.workspace || attempt.status !== 'unresolved') throw new Error('Unexpected workspace binding');
        attempt.workspace = binding.workspace; attempt.workspaceFence = binding.fence; break;
      }
      case 'codex_turn_bound': {
        const binding = z.strictObject({ attemptId: z.string().min(1), turnId: z.string().min(1) }).parse(event.payload);
        const attempt = attempts.get(binding.attemptId);
        if (!attempt || attempt.requestId !== event.requestId || attempt.runnerTurnId || attempt.status !== 'unresolved' ||
          [...attempts.values()].some(item => item.runnerTurnId === binding.turnId)) throw new Error('Unexpected or duplicate Codex turn binding');
        attempt.runnerTurnId = binding.turnId; break;
      }
      case 'dispatch_receipt': {
        const receipt = receiptSchema.parse(event.payload), attempt = attempts.get(receipt.attemptId);
        if (!attempt || attempt.receipt !== 'missing' || attempt.requestId !== event.requestId) throw new Error('Unexpected dispatch receipt');
        attempt.receipt = receipt.status;
        if (receipt.status === 'rejected') attempt.status = 'stopped';
        break;
      }
      case 'attempt_finished': {
        const result = finishedSchema.parse(event.payload), attempt = attempts.get(result.attemptId);
        if (!attempt || attempt.status !== 'unresolved' || attempt.receipt === 'rejected') throw new Error('Unexpected attempt result');
        attempt.status = result.status;
        if (result.baselineHash) attempt.baselineHash = result.baselineHash;
        break;
      }
      case 'branch_workspace_intent': {
        const payload = z.strictObject({ nodeId: z.string().min(1), workspace: z.string().min(1), baseCommit: gitObject }).parse(event.payload);
        if (!runtimeContext || payload.baseCommit !== runtimeContext.sourceHead || !layout.branchWriters.some(writer => writer.id === payload.nodeId) ||
          branchWorkspaces.has(payload.nodeId) || [...branchWorkspaces.values()].some(item => item.workspace === payload.workspace) || payload.workspace === runtimeContext.workspace) throw new Error('Invalid branch workspace intent');
        branchWorkspaces.set(payload.nodeId, { ...payload, requestId: event.requestId }); break;
      }
      case 'branch_workspace_bound': {
        const payload = z.strictObject({ nodeId: z.string().min(1), workspace: z.string().min(1), hostId: z.string().min(1), fence: z.number().int().positive() }).parse(event.payload);
        const branch = branchWorkspaces.get(payload.nodeId);
        if (!branch || branch.requestId !== event.requestId || branch.fence !== undefined || branch.workspace !== payload.workspace) throw new Error('Unexpected branch workspace binding');
        branch.hostId = payload.hostId; branch.fence = payload.fence; break;
      }
      case 'integration_intent': {
        const payload = z.strictObject({ nodeId: z.string().min(1), baseCommit: gitObject, mergedTree: gitObject, conflicts: z.array(z.string().min(1)),
          branches: z.array(z.strictObject({ nodeId: z.string().min(1), commit: gitObject, tree: gitObject, baselineHash: z.string().min(1) })).min(1) }).parse(event.payload);
        const expected = layout.writersFor(payload.nodeId).map(writer => writer.id).sort();
        if (flow.definition.nodes.find(node => node.id === payload.nodeId)?.type !== 'integration' || scheduler.snapshot().nodes[payload.nodeId]?.status !== 'running' ||
          integrations.has(payload.nodeId) || !runtimeContext || payload.baseCommit !== runtimeContext.sourceHead ||
          JSON.stringify(payload.branches.map(branch => branch.nodeId).sort()) !== JSON.stringify(expected)) throw new Error('Invalid integration intent');
        for (const branch of payload.branches) {
          const workspace = branchWorkspaces.get(branch.nodeId), latest = [...attempts.values()].filter(item => item.nodeId === branch.nodeId).at(-1);
          if (workspace?.fence === undefined || latest?.status !== 'completed' || latest.baselineHash !== branch.baselineHash || latest.workspace !== workspace.workspace) throw new Error('Integration branch does not match a completed branch attempt');
        }
        integrations.set(payload.nodeId, { ...payload, requestId: event.requestId }); break;
      }
      case 'integration_applied': {
        const payload = z.strictObject({ nodeId: z.string().min(1), baselineHash: z.string().min(1) }).parse(event.payload), integration = integrations.get(payload.nodeId);
        if (!integration || integration.requestId !== event.requestId || integration.baselineHash || !runtimeContext) throw new Error('Unexpected integration result');
        integration.baselineHash = payload.baselineHash;
        const attemptId = `integration:${payload.nodeId}`;
        attempts.set(attemptId, { round: repairRounds.length, nodeId: payload.nodeId, attemptId, sessionId: 'core-integration', requestId: event.requestId, receipt: 'accepted',
          status: 'completed', baselineHash: payload.baselineHash, workspace: runtimeContext.workspace, workspaceFence: runtimeContext.lease.fence, core: true });
        break;
      }
      case 'review_carried_forward': {
        const payload = z.strictObject({ nodeId: z.string().min(1), reviewerId: z.string().min(1), toBaselineHash: z.string().min(1),
          receipt: z.strictObject({ fromBaselineHash: z.string().min(1), oldTree: gitObject, newTree: gitObject, changedPaths: z.array(z.string().min(1)).min(1), scopes: z.array(z.string().min(1)).min(1), ruleVersion: z.literal(IMPACT_RULE_VERSION) }) }).parse(event.payload);
        const node = flow.definition.nodes.find(item => item.id === payload.nodeId), round = repairRounds.at(-1), prior = priorOutputs.get(payload.nodeId) ?? [];
        const reviewer = node?.type === 'review_group' ? node.reviewers.find(item => item.id === payload.reviewerId) : undefined;
        const previous = prior.find(item => item.result.reviewerId === payload.reviewerId);
        if (node?.type !== 'review_group' || !reviewer || !round || !previous || previous.result.verdict !== 'pass' || round.reviewedTree !== payload.receipt.oldTree ||
          round.baselineHash !== payload.receipt.fromBaselineHash || JSON.stringify(reviewer.scope) !== JSON.stringify(payload.receipt.scopes) ||
          reviewerOutputs.some(item => item.nodeId === node.id && item.result.reviewerId === reviewer.id)) throw new Error('Review cannot be carried forward');
        // Recompute the rule: the reviewer must not be selected for the changed paths, and nothing shared may have changed.
        const selection = selectReviewersForChanges(node.reviewers.map(item => ({ id: item.id, required: item.required, scopes: item.scope })), payload.receipt.changedPaths,
          prior.filter(item => item.result.verdict !== 'pass').map(item => item.result.reviewerId), sharedImpactPaths(payload.receipt.changedPaths).length === 0);
        if (selection.reason !== 'scoped' || selection.reviewerIds.includes(reviewer.id)) throw new Error('Impact receipt does not exempt this reviewer');
        reviewerOutputs.push({ ...structuredClone(previous), result: { ...previous.result, baselineHash: payload.toBaselineHash }, carried: payload.receipt }); break;
      }
      case 'commit_scope_selected': {
        const { nodeId } = z.strictObject({ nodeId: z.string().min(1), includeImported: z.literal(true) }).parse(event.payload);
        if (flow.definition.nodes.find(node => node.id === nodeId)?.type !== 'git_commit' || !runtimeContext?.imported || commits.has(nodeId) || includeImported.has(nodeId)) throw new Error('Commit scope can only widen an imported run before its commit');
        includeImported.add(nodeId); break;
      }
      case 'checkout_apply_intent': {
        const payload = z.strictObject({ tree: gitObject, paths: z.array(z.string().min(1)).min(1), patchHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(event.payload);
        const finished = flow.definition.nodes.some(node => node.type === 'finish' && scheduler.snapshot().nodes[node.id]?.status === 'succeeded');
        if (!finished || workspaceCleanup || flow.definition.nodes.some(node => node.type === 'git_commit') || checkoutApply?.applied || (checkoutApply && checkoutApply.patchHash !== payload.patchHash)) throw new Error('Only a finished run without a commit applies its changes, once');
        checkoutApply = { ...payload, applied: false }; break;
      }
      case 'checkout_applied': {
        const { patchHash } = z.strictObject({ patchHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(event.payload);
        if (!checkoutApply || checkoutApply.applied || checkoutApply.patchHash !== patchHash) throw new Error('Checkout apply receipt does not match its intent');
        checkoutApply.applied = true; break;
      }
      case 'workspace_cleanup_intent': {
        const payload = z.strictObject({ workspaces: z.array(z.string().min(1)).min(1), refs: z.array(z.strictObject({ ref: z.string().startsWith('refs/neomind/'), commit: gitObject })),
          discarded: z.array(z.string().min(1)) }).parse(event.payload);
        // Only a run that has stopped for good, with nothing in flight, gives up its worktrees.
        if (!runtimeState || !['completed', 'cancelled'].includes(runtimeState.phase) || workspaceCleanup || [...attempts.values()].some(item => item.status === 'unresolved')
          || [...commits.values()].some(item => !item.confirmed) || (checkoutApply && !checkoutApply.applied)) throw new Error('Only a finished run with nothing in flight cleans its workspaces, once');
        workspaceCleanup = { ...payload, cleaned: false }; break;
      }
      case 'workspace_cleaned': {
        z.strictObject({}).parse(event.payload);
        if (!workspaceCleanup || workspaceCleanup.cleaned) throw new Error('Workspace cleanup receipt without its intent');
        workspaceCleanup.cleaned = true; break;
      }
      default: throw new Error(`Unknown run event type: ${event.type}`);
    }
  }
  const list = [...attempts.values()];
  return { ...(runtimeContext ? { runtimeContext } : {}), ...(runtimeState ? { runtimeState } : {}), graph: scheduler.snapshot(), bindingSelections, timeExtensionsMs, usage: { totalTokens: usageAttempts.size ? Object.values(usageBySession).reduce((sum, usage) => sum + usage.totalTokens, 0) : null, partial: usageReset || usageAttempts.size < list.filter(item => !item.core).length, reportedAttemptIds: [...usageAttempts], bySession: usageBySession, costUSD: null }, reviewValidationRetries, planRevisions, artifacts, continuationBaselines, repairRounds: structuredClone(repairRounds), plans: structuredClone([...plans.values()]), approvals: structuredClone(approvals), reviewerOutputs: structuredClone(reviewerOutputs), acceptedReviews: [...acceptedReviews].map(([nodeId, baselineHash]) => ({ nodeId, baselineHash })), checks: structuredClone([...checks.values()]), unresolvedCheckIds: [...checks.values()].filter(item => item.status === 'unresolved').map(item => item.checkId), attempts: structuredClone(list),
    unresolvedAttemptIds: list.filter(a => a.status === 'unresolved').map(a => a.attemptId),
    commits: structuredClone([...commits.values()]), unresolvedCommitNodeIds: [...commits.values()].filter(c => !c.confirmed).map(c => c.nodeId),
    branchWorkspaces: structuredClone([...branchWorkspaces.values()]), integrations: structuredClone([...integrations.values()]),
    unresolvedIntegrationNodeIds: [...integrations.values()].filter(item => !item.baselineHash).map(item => item.nodeId),
    includeImportedCommitNodeIds: [...includeImported], ...(checkoutApply ? { checkoutApply: structuredClone(checkoutApply) } : {}), ...(workspaceCleanup ? { workspaceCleanup: structuredClone(workspaceCleanup) } : {}), priorReviewerOutputs: structuredClone(Object.fromEntries(priorOutputs)),
    requiresUserContinue: true };
}
