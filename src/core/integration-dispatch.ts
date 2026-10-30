import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { flowSchema } from '../domain/schema.js';
import { branchLayout } from '../domain/branches.js';
import { OwnedJournal } from '../storage/owned-journal.js';
import { WorkspaceCoordinator, type WorkspaceLease } from '../storage/coordination.js';
import { captureBaseline } from '../workspace/baseline.js';
import { applyTreeToWorkspace, commitBranch, filesWithConflictMarkers, inspectIntegration, mergeBranchCommits, prepareBranchWorktree } from '../workspace/integration.js';
import { replayRun } from './recovery.js';

/** Core-owned branch workspaces and merges. The caller serializes calls and holds the run owner lease. */
export class IntegrationDispatch {
  constructor(private readonly journal: OwnedJournal) {}
  usesJournal(journal: OwnedJournal) { return this.journal === journal; }
  private async append(type: string, payload: unknown, requestId: string = randomUUID()) {
    const events = await this.journal.read(), event = { schemaVersion: 1 as const, eventId: randomUUID(), runId: this.journal.runId,
      requestId, type, timestamp: new Date().toISOString(), payload: z.json().parse(payload) };
    replayRun([...events, { ...event, sequence: events.length + 1 }]); await this.journal.append(event, events.length);
  }
  private async state() {
    const events = await this.journal.read(), report = replayRun(events);
    const flow = z.object({ flow: flowSchema }).parse(events[0]?.payload).flow;
    if (!report.runtimeContext) throw new Error('Run has no runtime workspace');
    return { report, flow, context: report.runtimeContext };
  }

  /** Create (or adopt after a crash) the branch writer's worktree at the run base and hold its writer lease. */
  async prepareBranch(nodeId: string, coordinator: WorkspaceCoordinator, hostId: string): Promise<WorkspaceLease> {
    const { report, flow, context } = await this.state();
    if (!branchLayout(flow).branchWriters.some(writer => writer.id === nodeId)) throw new Error(`${nodeId} is not a branch writer`);
    let branch = report.branchWorkspaces.find(item => item.nodeId === nodeId);
    if (!branch) {
      // Siblings of the run workspace, never inside it: a nested path would appear as untracked content.
      const workspace = path.join(realpathSync.native(path.dirname(context.workspace)), `${this.journal.runId}--${nodeId}`);
      branch = { nodeId, requestId: randomUUID(), workspace, baseCommit: context.sourceHead };
      await this.append('branch_workspace_intent', { nodeId, workspace, baseCommit: context.sourceHead }, branch.requestId);
    }
    const workspace = await prepareBranchWorktree(context.workspace, branch.workspace, branch.baseCommit);
    if (workspace !== branch.workspace) throw new Error('Branch workspace path changed');
    if (branch.fence !== undefined && branch.hostId) {
      const lease = { workspace, runId: this.journal.runId, hostId: branch.hostId, fence: branch.fence };
      if (!coordinator.isCurrent(lease)) throw new Error('Branch workspace lease is stale');
      return lease;
    }
    const held = coordinator.getWriter(workspace);
    if (held && held.runId !== this.journal.runId) throw new Error('Branch workspace is held by another run');
    const lease = held ? { workspace, runId: held.runId, hostId: held.hostId, fence: held.fence } : coordinator.acquire(workspace, this.journal.runId, hostId);
    await this.append('branch_workspace_bound', { nodeId, workspace, hostId: lease.hostId, fence: lease.fence }, branch.requestId);
    return lease;
  }

  /** Merge every branch of this integration into the run workspace. Returns files left with conflicts for the integration agent. */
  async integrate(nodeId: string, coordinator: WorkspaceCoordinator, lease: WorkspaceLease): Promise<{ conflicts: string[] }> {
    const { report, flow, context } = await this.state();
    const node = flow.definition.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'integration') throw new Error('Not an integration node');
    if (lease.workspace !== context.workspace || !coordinator.isCurrent(lease)) throw new Error('Integration workspace lease is stale');
    let integration = report.integrations.find(item => item.nodeId === nodeId);
    if (integration?.baselineHash) throw new Error('Integration has already been applied');
    if (!integration) {
      const approved = report.approvals.at(-1)?.plan;
      if (!approved) throw new Error('Integration requires an approved plan');
      if (report.graph.nodes[nodeId]?.status === 'ready') await this.append('node_claimed', { nodeId, writeScopes: approved.scope });
      const branches = [];
      for (const writer of branchLayout(flow).writersFor(nodeId)) {
        const workspace = report.branchWorkspaces.find(item => item.nodeId === writer.id), attempt = report.attempts.filter(item => item.nodeId === writer.id).at(-1);
        if (!workspace || attempt?.status !== 'completed' || !attempt.baselineHash) throw new Error(`Branch ${writer.id} has no completed result`);
        const result = await commitBranch(workspace.workspace, attempt.baselineHash, context.sourceHead, `refs/neomind/${this.journal.runId}/${writer.id}`, `NeoMind ${this.journal.runId} ${writer.id}`);
        branches.push({ nodeId: writer.id, ...result, baselineHash: attempt.baselineHash });
      }
      const merged = await mergeBranchCommits(context.workspace, branches.map(branch => branch.commit));
      integration = { nodeId, requestId: randomUUID(), baseCommit: context.sourceHead, branches, mergedTree: merged.tree, conflicts: merged.conflicts };
      await this.append('integration_intent', { nodeId, baseCommit: integration.baseCommit, branches, mergedTree: merged.tree, conflicts: merged.conflicts }, integration.requestId);
    }
    await this.apply(integration.nodeId, integration.requestId, integration.baseCommit, integration.mergedTree, context.workspace, coordinator, lease);
    if (!integration.conflicts.length) await this.append('node_completed', { nodeId, outcome: 'completed' });
    return { conflicts: integration.conflicts };
  }

  /** Finish a journaled merge whose application was interrupted; never recomputes or merges anything new. */
  async reconcile(nodeId: string, coordinator: WorkspaceCoordinator, lease: WorkspaceLease): Promise<void> {
    const { report, context } = await this.state(), integration = report.integrations.find(item => item.nodeId === nodeId);
    if (!integration || integration.baselineHash) throw new Error('No interrupted integration to reconcile');
    await this.apply(nodeId, integration.requestId, integration.baseCommit, integration.mergedTree, context.workspace, coordinator, lease);
    if (!integration.conflicts.length && report.graph.nodes[nodeId]?.status === 'running') await this.append('node_completed', { nodeId, outcome: 'completed' });
  }

  private async apply(nodeId: string, requestId: string, baseCommit: string, tree: string, workspace: string, coordinator: WorkspaceCoordinator, lease: WorkspaceLease) {
    if (lease.workspace !== workspace || !coordinator.isCurrent(lease)) throw new Error('Integration workspace lease is stale');
    const state = await inspectIntegration(workspace, baseCommit, tree);
    if (state.state === 'unknown') throw new Error('Run workspace changed during integration; inspect it before continuing');
    const baselineHash = state.state === 'applied' ? state.baselineHash : await applyTreeToWorkspace(workspace, baseCommit, tree);
    await this.append('integration_applied', { nodeId, baselineHash }, requestId);
  }

  /** Accept the integration agent's result only when every conflicted file is free of markers. */
  async complete(nodeId: string): Promise<void> {
    const { report, context } = await this.state(), integration = report.integrations.find(item => item.nodeId === nodeId);
    const latest = report.attempts.filter(item => item.nodeId === nodeId).at(-1);
    if (!integration?.baselineHash || report.graph.nodes[nodeId]?.status !== 'running' || latest?.status !== 'completed' || !latest.baselineHash) throw new Error('Integration has no completed result to accept');
    if ((await captureBaseline(context.workspace)).baselineHash !== latest.baselineHash) throw new Error('Run workspace changed after the integration step');
    const remaining = await filesWithConflictMarkers(context.workspace, integration.conflicts);
    if (remaining.length) throw new Error(`Conflict markers remain in: ${remaining.join(', ')}`);
    await this.append('node_completed', { nodeId, outcome: 'completed' });
  }
}
