import { flowSchema, type Flow, type ProjectConfig } from './schema.js';

const inherit = { mode: 'inherit' } as const;
const bindings = {
  implementer: { runner: inherit, provider: inherit, model: inherit, reasoning: inherit, fallback: [] },
  verifier: { runner: inherit, provider: inherit, model: inherit, reasoning: inherit, fallback: [] },
};
const readOnly = { read: true, write: false, checks: true, gitCommit: false };
const write = { ...readOnly, write: true };

export const defaultProject: ProjectConfig = {
  schemaVersion: 1, projectId: 'example-project', policyVersion: 1,
  policy: { requireApprovalBeforeWrite: true, requireIndependentReviewForCode: true,
    allowGitCommit: true, maxConcurrency: 4, maxRepairRounds: 2 },
  roleDefaults: {},
};

/**
 * Fast: a short plan that NeoMind approves itself, then the agent implements. No agent review and no commit: the user
 * reviews the changes outside the flow and applies them to the checkout. Both exceptions are declared by the flow and
 * can be forbidden by the project policy.
 */
function fastTemplate(): Flow {
  return flowSchema.parse({
    schemaVersion: 1, flowId: 'fast', version: 1, name: 'Fast',
    description: 'Quick plan approved automatically, then implement; you review the changes and apply them to your checkout.',
    definition: {
      startNodeId: 'start', review: 'human',
      bindings: { ...bindings, 'fast-planner': { ...bindings.implementer, reasoning: { mode: 'pinned', value: 'low' } } },
      sessionGroups: [{ id: 'planning-session', bindingId: 'fast-planner' }, { id: 'implementation-session', bindingId: 'implementer' }],
      limits: { maxConcurrency: 2, maxRepairRounds: 0, activeTimeSeconds: 1200 },
      workspacePolicy: 'isolated', outputContract: 'code-changes-for-user-review',
      nodes: [
        { id: 'start', label: 'Start', type: 'start' },
        { id: 'plan', label: 'Quick plan', type: 'agent_task', profileId: 'implementer', profileVersion: 1,
          goal: 'Propose a short plan: what to change, which directories, and one check if the project has one. Keep the approach to a few sentences; work starts right after.',
          sessionGroup: 'planning-session', bindingId: 'fast-planner', permissions: readOnly, writeScopes: [], outputContract: 'plan' },
        { id: 'approval', label: 'Auto-approve plan', type: 'approval', mode: 'auto', purpose: 'NeoMind approves the plan so implementation starts right away' },
        { id: 'implement', label: 'Implement', type: 'agent_task', goal: 'Implement the approved plan', profileId: 'implementer', profileVersion: 1,
          sessionGroup: 'implementation-session', bindingId: 'implementer', permissions: write, writeScopes: ['.'], outputContract: 'code-artifacts' },
        { id: 'finish', label: 'Finish', type: 'finish' },
      ],
      edges: [
        { from: 'start', to: 'plan', outcome: 'completed' }, { from: 'plan', to: 'approval', outcome: 'completed' },
        { from: 'approval', to: 'implement', outcome: 'pass' }, { from: 'implement', to: 'finish', outcome: 'completed' },
      ],
    }, layout: {},
  });
}

function codeTemplate(name: 'Dev'): Flow {
  return flowSchema.parse({
    schemaVersion: 1, flowId: name.toLowerCase(), version: 1, name,
    description: `${name} code flow with user approval and independent verification.`,
    definition: {
      startNodeId: 'start', bindings,
      sessionGroups: [{ id: 'implementation-session', bindingId: 'implementer' },
        { id: 'verification-session', bindingId: 'verifier' }],
      limits: { maxConcurrency: 4, maxRepairRounds: 2, activeTimeSeconds: 1800 },
      workspacePolicy: 'isolated', outputContract: 'accepted-code-and-local-commit',
      nodes: [
        { id: 'start', label: 'Start', type: 'start' },
        { id: 'plan', label: 'Plan', type: 'agent_task', goal: 'Survey and propose a plan', profileId: 'implementer', profileVersion: 1,
          sessionGroup: 'implementation-session', bindingId: 'implementer', permissions: readOnly, writeScopes: [], outputContract: 'plan' },
        { id: 'approval', label: 'Approve plan', type: 'approval', purpose: 'Approve plan and scope before edits' },
        { id: 'implement', label: 'Implement', type: 'agent_task', goal: 'Implement the approved plan', profileId: 'implementer', profileVersion: 1,
          sessionGroup: 'implementation-session', bindingId: 'implementer', permissions: write, writeScopes: ['.'], outputContract: 'code-artifacts' },
        { id: 'repair', label: 'Bounded repair', type: 'repair_scope', targetReviewId: 'verify', ownerNodeIds: ['implement'], maxRounds: 2 },
        { id: 'verify', label: 'Independent review', type: 'review_group', targetNodeId: 'implement',
          reviewers: [{ id: 'required-reviewer', profileId: 'verifier', profileVersion: 1, sessionGroup: 'verification-session', required: true, scope: ['.'] }],
          criteria: ['approved plan', 'checks', 'regressions'] },
        { id: 'commit', label: 'Local commit', type: 'git_commit' },
        { id: 'finish', label: 'Finish', type: 'finish' },
      ],
      edges: [
        { from: 'start', to: 'plan', outcome: 'completed' }, { from: 'plan', to: 'approval', outcome: 'completed' },
        { from: 'approval', to: 'implement', outcome: 'pass' }, { from: 'implement', to: 'repair', outcome: 'completed' },
        { from: 'repair', to: 'verify', outcome: 'completed' }, { from: 'verify', to: 'commit', outcome: 'pass' },
        { from: 'commit', to: 'finish', outcome: 'completed' },
      ],
    }, layout: {},
  });
}

function researchTemplate(): Flow {
  return flowSchema.parse({
    schemaVersion: 1, flowId: 'research', version: 1, name: 'Research',
    description: 'Read-only research with an independent source review.',
    definition: {
      startNodeId: 'start', bindings,
      sessionGroups: [{ id: 'research-session', bindingId: 'implementer' }, { id: 'review-session', bindingId: 'verifier' }],
      limits: { maxConcurrency: 4, maxRepairRounds: 2, activeTimeSeconds: 1800 },
      workspacePolicy: 'isolated', outputContract: 'research-report',
      nodes: [
        { id: 'start', label: 'Start', type: 'start' },
        { id: 'research', label: 'Research', type: 'agent_task', goal: 'Research and cite sources', profileId: 'implementer', profileVersion: 1,
          sessionGroup: 'research-session', bindingId: 'implementer', permissions: readOnly, writeScopes: [], outputContract: 'research-report' },
        { id: 'review', label: 'Review sources', type: 'review_group', targetNodeId: 'research',
          reviewers: [{ id: 'source-reviewer', profileId: 'verifier', profileVersion: 1, sessionGroup: 'review-session', required: true, scope: ['.'] }], criteria: ['answers the task', 'sources', 'claims'] },
        { id: 'repair', label: 'Bounded repair', type: 'repair_scope', targetReviewId: 'review', ownerNodeIds: ['research'], maxRounds: 2 },
        { id: 'finish', label: 'Finish', type: 'finish' },
      ],
      edges: [{ from: 'start', to: 'research', outcome: 'completed' }, { from: 'research', to: 'repair', outcome: 'completed' },
        { from: 'repair', to: 'review', outcome: 'completed' }, { from: 'review', to: 'finish', outcome: 'pass' }],
    }, layout: {},
  });
}

/** Two writers in separate worktrees, merged by integration; review and repair act on the integrated result. */
function parallelTemplate(): Flow {
  const writer = (id: string, label: string, sessionGroup: string) => ({ id, label, type: 'agent_task', goal: 'Implement your work packet of the approved plan',
    profileId: 'implementer', profileVersion: 1, sessionGroup, bindingId: 'implementer', permissions: write, writeScopes: ['.'], outputContract: 'code-artifacts' });
  return flowSchema.parse({
    schemaVersion: 1, flowId: 'parallel', version: 1, name: 'Dev song song',
    description: 'Two implementers work in parallel worktrees; their changes are integrated, independently reviewed and committed.',
    definition: {
      startNodeId: 'start', bindings,
      sessionGroups: [{ id: 'planning-session', bindingId: 'implementer' }, { id: 'branch-a-session', bindingId: 'implementer' },
        { id: 'branch-b-session', bindingId: 'implementer' }, { id: 'integration-session', bindingId: 'implementer' },
        { id: 'verification-session', bindingId: 'verifier' }],
      limits: { maxConcurrency: 4, maxRepairRounds: 2, activeTimeSeconds: 2400 },
      workspacePolicy: 'isolated', outputContract: 'accepted-code-and-local-commit',
      nodes: [
        { id: 'start', label: 'Start', type: 'start' },
        { id: 'plan', label: 'Plan', type: 'agent_task', goal: 'Survey and propose a plan split into one work packet per parallel implementer', profileId: 'implementer', profileVersion: 1,
          sessionGroup: 'planning-session', bindingId: 'implementer', permissions: readOnly, writeScopes: [], outputContract: 'plan' },
        { id: 'approval', label: 'Approve plan', type: 'approval', purpose: 'Approve plan, work packets and scope before edits' },
        { id: 'fork', label: 'Split work', type: 'fork' },
        writer('implement-a', 'Implement A', 'branch-a-session'),
        writer('implement-b', 'Implement B', 'branch-b-session'),
        { id: 'join', label: 'Join', type: 'join', requiredBranches: ['implement-a', 'implement-b'] },
        { id: 'integrate', label: 'Integrate', type: 'integration', writeScopes: ['.'], profileId: 'implementer', profileVersion: 1,
          sessionGroup: 'integration-session', bindingId: 'implementer' },
        { id: 'repair', label: 'Bounded repair', type: 'repair_scope', targetReviewId: 'verify', ownerNodeIds: ['integrate'], maxRounds: 2 },
        { id: 'verify', label: 'Independent review', type: 'review_group', targetNodeId: 'integrate',
          reviewers: [{ id: 'required-reviewer', profileId: 'verifier', profileVersion: 1, sessionGroup: 'verification-session', required: true, scope: ['.'] }],
          criteria: ['approved plan', 'checks', 'regressions'] },
        { id: 'commit', label: 'Local commit', type: 'git_commit' },
        { id: 'finish', label: 'Finish', type: 'finish' },
      ],
      edges: [
        { from: 'start', to: 'plan', outcome: 'completed' }, { from: 'plan', to: 'approval', outcome: 'completed' },
        { from: 'approval', to: 'fork', outcome: 'pass' }, { from: 'fork', to: 'implement-a', outcome: 'completed' },
        { from: 'fork', to: 'implement-b', outcome: 'completed' }, { from: 'implement-a', to: 'join', outcome: 'completed' },
        { from: 'implement-b', to: 'join', outcome: 'completed' }, { from: 'join', to: 'integrate', outcome: 'completed' },
        { from: 'integrate', to: 'repair', outcome: 'completed' }, { from: 'repair', to: 'verify', outcome: 'completed' },
        { from: 'verify', to: 'commit', outcome: 'pass' }, { from: 'commit', to: 'finish', outcome: 'completed' },
      ],
    }, layout: {},
  });
}

export const templates: Record<'fast' | 'dev' | 'parallel' | 'research', Flow> = {
  fast: fastTemplate(), dev: codeTemplate('Dev'), parallel: parallelTemplate(), research: researchTemplate(),
};
