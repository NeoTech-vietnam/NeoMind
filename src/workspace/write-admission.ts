import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { approvalMatches, type Approval, type Plan } from '../domain/approval.js';
import type { ProjectPolicy } from '../domain/schema.js';
import { WorkspaceCoordinator, type WorkspaceLease } from '../storage/coordination.js';
import { primaryWorktree } from './worktree.js';
import { captureBaseline, type WorkspaceBaseline } from './baseline.js';

export interface WorkspaceWriteGrant { workspace: string; runId: string; fence: number; baseline: WorkspaceBaseline; writableRoots: string[]; planId: string; planVersion: number }
/**
 * Write scopes must be existing directories; file-only scopes cannot be safely bound by this adapter.
 * The trusted capability check must independently verify sandbox and stop behaviour.
 */
export async function admitIsolatedWorkspaceWrite(input: {
  workspace: string; lease: WorkspaceLease; coordinator: WorkspaceCoordinator;
  plan: Plan; approval: Approval; livePolicy: ProjectPolicy; expectedBaselineHash: string;
  sandboxVerified: boolean; stopVerified: boolean;
  repair?: { roundId: string; baselineHash: string };
  continuation?: { baselineHash: string };
}): Promise<WorkspaceWriteGrant> {
  if (!input.sandboxVerified || !input.stopVerified) throw new Error('Verified sandbox and stop capabilities required');
  if (!approvalMatches(input.approval, input.plan, input.livePolicy)) throw new Error('Approval does not match current plan and policy');
  const workspace = await realpath(input.workspace);
  if (workspace === primaryWorktree(workspace)) throw new Error('A separate Git worktree is required');
  if (workspace !== input.lease.workspace || !input.coordinator.isCurrent(input.lease)) throw new Error('Workspace writer lease is missing or stale');
  const writableRoots: string[] = [];
  for (const scope of input.plan.scope) {
    if (!scope || scope.includes('\\') || path.isAbsolute(scope) || scope.split('/').includes('..')) throw new Error('Invalid approved write scope');
    const candidate = path.resolve(workspace, scope), relative = path.relative(workspace, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Write scope escapes workspace');
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Write scopes must be real directories');
    const root = await realpath(candidate), resolved = path.relative(workspace, root);
    if (root !== candidate) throw new Error('Write scope cannot traverse symlinks');
    if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error('Write scope resolves outside workspace');
    writableRoots.push(root);
  }
  const baseline = await captureBaseline(workspace);
  if (baseline.baselineHash !== input.expectedBaselineHash) throw new Error('Workspace baseline changed since approval');
  if (input.repair && ((!input.continuation && input.repair.baselineHash !== baseline.baselineHash) || !input.repair.roundId)) throw new Error('Repair baseline does not match');
  if (input.continuation && input.continuation.baselineHash !== baseline.baselineHash) throw new Error('Continuation baseline does not match');
  if (!baseline.clean && !input.repair && !input.continuation) throw new Error('Isolated worktree must be clean before the first write');
  return { workspace, runId: input.lease.runId, fence: input.lease.fence, baseline, writableRoots,
    planId: input.plan.planId, planVersion: input.plan.version };
}
