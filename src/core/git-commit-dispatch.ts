import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectPolicySchema, type ProjectPolicy } from '../domain/schema.js';
import { hashJson } from '../domain/resolve.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { WorkspaceCoordinator, type WorkspaceLease } from '../storage/coordination.js';
import { realpath } from 'node:fs/promises';
import { commitReviewedTree, inspectCommitOutcome } from '../workspace/git-commit.js';
import { replayRun } from './recovery.js';
import { buildReviewTree } from '../workspace/review-tree.js';

/** Serial caller must hold run and workspace leases; unknown outcomes require reconciliation. */
export class GitCommitDispatch {
  constructor(private readonly journal: OwnedJournal) {}
  usesJournal(journal: OwnedJournal) { return this.journal === journal; }
  private async append(type: string, payload: unknown, requestId: string = randomUUID()) {
    const events = await this.journal.read(), event = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.journal.runId,
      requestId, type, timestamp: new Date().toISOString(), payload: z.json().parse(payload) };
    replayRun([...events, { ...event, sequence: events.length + 1 }]); await this.journal.append(event, events.length);
  }
  /** Observe a prior intent only; never recreate a commit or move a ref. */
  async reconcile(nodeId: string, workspace: string, lease: WorkspaceLease, coordinator: WorkspaceCoordinator) {
    const report = replayRun(await this.journal.read()), intent = report.commits.find(item => item.nodeId === nodeId);
    if (!intent || intent.confirmed || lease.runId !== this.journal.runId || intent.workspace !== lease.workspace ||
        intent.workspaceFence !== lease.fence || await realpath(workspace) !== intent.workspace) throw new Error('Commit intent or workspace lease does not match');
    const outcome = await inspectCommitOutcome({ workspace, lease, coordinator, expectedParent: intent.expectedParent,
      expectedTree: intent.expectedTree, baselineHash: intent.baselineHash, ...(intent.workspaceTree ? { workspaceTree: intent.workspaceTree } : {}) });
    if (outcome.state === 'applied') {
      await this.append('git_commit_receipt', { nodeId, ...outcome.receipt }, intent.requestId);
      await this.append('node_completed', { nodeId, outcome: 'completed' });
    }
    return outcome;
  }
  /** Only an explicit user retry may abandon a proven unapplied intent. */
  async authorizeRetry(nodeId: string, workspace: string, lease: WorkspaceLease, coordinator: WorkspaceCoordinator) {
    const report = replayRun(await this.journal.read()), intent = report.commits.find(item => item.nodeId === nodeId);
    if (!intent || intent.confirmed || lease.runId !== this.journal.runId || intent.workspace !== lease.workspace || intent.workspaceFence !== lease.fence || await realpath(workspace) !== intent.workspace) throw new Error('Commit intent or workspace lease does not match');
    const outcome = await inspectCommitOutcome({ workspace, lease, coordinator, expectedParent: intent.expectedParent, expectedTree: intent.expectedTree, baselineHash: intent.baselineHash, ...(intent.workspaceTree ? { workspaceTree: intent.workspaceTree } : {}) });
    if (outcome.state !== 'not_applied' || (await buildReviewTree(workspace, intent.baselineHash)).tree !== (intent.workspaceTree ?? intent.expectedTree)) throw new Error('Git retry requires a verified unchanged and unapplied commit');
    await this.append('git_commit_abandoned', { nodeId }, intent.requestId);
  }
  async commit(input: { nodeId: string; reviewNodeId: string; workspace: string; lease: WorkspaceLease; coordinator: WorkspaceCoordinator;
    livePolicy: ProjectPolicy; baselineHash: string; parent: string; tree: string; message: string; requestId: string; authorized: boolean; signal?: AbortSignal; workspaceTree?: string }) {
    if (!input.authorized) throw new Error('Explicit user continuation required');
    if (input.lease.runId !== this.journal.runId) throw new Error('Workspace lease belongs to another run');
    const events = await this.journal.read(), report = replayRun(events);
    const initial = z.object({ policy: projectPolicySchema }).parse(events[0]?.payload);
    if (!input.livePolicy.allowGitCommit || hashJson(initial.policy) !== hashJson(input.livePolicy)) throw new Error('Commit is blocked by project policy');
    if (!report.acceptedReviews.some(item => item.nodeId === input.reviewNodeId && item.baselineHash === input.baselineHash)) throw new Error('Commit requires matching accepted review');
    if (report.unresolvedAttemptIds.length || report.unresolvedCommitNodeIds.length) throw new Error('Reconcile uncertain effects before commit');
    await this.append('node_claimed', { nodeId: input.nodeId });
    await this.append('git_commit_intent', { nodeId: input.nodeId, reviewNodeId: input.reviewNodeId, baselineHash: input.baselineHash,
      expectedParent: input.parent, expectedTree: input.tree, ...(input.workspaceTree && input.workspaceTree !== input.tree ? { workspaceTree: input.workspaceTree } : {}) }, input.requestId);
    await this.append('git_workspace_bound', { nodeId: input.nodeId, workspace: input.lease.workspace, fence: input.lease.fence }, input.requestId);
    const receipt = await commitReviewedTree({ workspace: input.workspace, lease: input.lease, coordinator: input.coordinator,
      expectedParent: input.parent, expectedTree: input.tree, baselineHash: input.baselineHash, message: input.message, ...(input.signal ? { signal: input.signal } : {}), ...(input.workspaceTree ? { workspaceTree: input.workspaceTree } : {}) });
    await this.append('git_commit_receipt', { nodeId: input.nodeId, ...receipt }, input.requestId);
    await this.append('node_completed', { nodeId: input.nodeId, outcome: 'completed' }); return receipt;
  }
}
