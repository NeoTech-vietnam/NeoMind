import { z } from 'zod';
import { flowSchema, projectPolicySchema } from '../domain/schema.js';
import { approvalMatches, approvalSchema, planSchema } from '../domain/approval.js';
import { GraphScheduler, type Outcome, type SchedulerSnapshot } from './graph-scheduler.js';
import { evaluateReviews } from './review.js';
import { runEventSchema, type RunEvent } from '../storage/journal.js';

const createdSchema = z.strictObject({ flow: z.unknown(), policy: projectPolicySchema });
const nodeSchema = z.strictObject({ nodeId: z.string().min(1), writeScopes: z.array(z.string().min(1)).optional() });
const outcomeSchema = z.enum(['completed', 'pass', 'needs_changes', 'blocked', 'true', 'false']);
const intentSchema = z.strictObject({ nodeId: z.string().min(1), attemptId: z.string().min(1), sessionId: z.string().min(1) });
const receiptSchema = z.strictObject({ attemptId: z.string().min(1), status: z.enum(['accepted', 'unknown', 'rejected']) });
const finishedSchema = z.strictObject({ attemptId: z.string().min(1), status: z.enum(['completed', 'stopped']), baselineHash: z.string().min(1).optional() });
const gitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const commitIntentSchema = z.strictObject({ nodeId: z.string().min(1), reviewNodeId: z.string().min(1),
  baselineHash: z.string().min(1), expectedParent: gitObject, expectedTree: gitObject });
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
  nodeId: string; attemptId: string; sessionId: string; requestId: string;
  receipt: 'missing' | 'accepted' | 'unknown' | 'rejected';
  status: 'unresolved' | 'completed' | 'stopped';
  baselineHash?: string;
}
export interface RecoveredCommit { nodeId: string; requestId: string; baselineHash: string; expectedParent: string; expectedTree: string; confirmed: boolean }
export interface RecoveryReport {
  graph: SchedulerSnapshot;
  attempts: RecoveredAttempt[];
  unresolvedAttemptIds: string[];
  commits: RecoveredCommit[];
  unresolvedCommitNodeIds: string[];
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
  const scheduler = new GraphScheduler(initial.flow, initial.policy);
  const attempts = new Map<string, RecoveredAttempt>();
  const requests = new Set<string>();
  const approvedNodes = new Set<string>();
  const approvedScopes: string[][] = [];
  const acceptedReviews = new Map<string, string>();
  const commits = new Map<string, RecoveredCommit>();
  for (const event of events.slice(1)) {
    if (event.runId !== first.runId) throw new Error('Journal contains another run');
    switch (event.type) {
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
        attempts.set(intent.attemptId, { ...intent, requestId: event.requestId, receipt: 'missing', status: 'unresolved' });
        requests.add(event.requestId); break;
      }
      case 'approval_recorded': {
        const payload = z.strictObject({ nodeId: z.string().min(1), plan: planSchema, approval: approvalSchema }).parse(event.payload);
        const node = flow.definition.nodes.find(n => n.id === payload.nodeId);
        if (node?.type !== 'approval' || scheduler.snapshot().nodes[payload.nodeId]?.status !== 'running') {
          throw new Error('Approval must refer to a claimed approval node');
        }
        if (!approvalMatches(payload.approval, payload.plan, initial.policy)) throw new Error('Approval does not match plan and policy');
        approvedNodes.add(payload.nodeId); approvedScopes.push(payload.plan.scope); break;
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
          expectedParent: intent.expectedParent, expectedTree: intent.expectedTree, confirmed: false });
        break;
      }
      case 'git_commit_receipt': {
        const receipt = commitReceiptSchema.parse(event.payload), intent = commits.get(receipt.nodeId);
        if (!intent || intent.confirmed || intent.requestId !== event.requestId || intent.baselineHash !== receipt.baselineHash ||
            intent.expectedParent !== receipt.parent || intent.expectedTree !== receipt.tree) throw new Error('Git commit receipt does not match intent');
        intent.confirmed = true; break;
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
      default: throw new Error(`Unknown run event type: ${event.type}`);
    }
  }
  const list = [...attempts.values()];
  return { graph: scheduler.snapshot(), attempts: structuredClone(list),
    unresolvedAttemptIds: list.filter(a => a.status === 'unresolved').map(a => a.attemptId),
    commits: structuredClone([...commits.values()]), unresolvedCommitNodeIds: [...commits.values()].filter(c => !c.confirmed).map(c => c.nodeId),
    requiresUserContinue: true };
}
