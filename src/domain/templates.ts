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

function codeTemplate(name: 'Dev' | 'Fast'): Flow {
  return flowSchema.parse({
    schemaVersion: 1, flowId: name.toLowerCase(), version: 1, name,
    description: `${name} code flow with user approval and independent verification.`,
    definition: {
      startNodeId: 'start', bindings,
      sessionGroups: [{ id: 'implementation-session', bindingId: 'implementer' },
        { id: 'verification-session', bindingId: 'verifier' }],
      limits: { maxConcurrency: name === 'Fast' ? 2 : 4, maxRepairRounds: 2, activeTimeSeconds: 1800 },
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
          reviewers: [{ id: 'source-reviewer', profileId: 'verifier', profileVersion: 1, sessionGroup: 'review-session', required: true, scope: ['sources'] }], criteria: ['sources', 'claims'] },
        { id: 'finish', label: 'Finish', type: 'finish' },
      ],
      edges: [{ from: 'start', to: 'research', outcome: 'completed' }, { from: 'research', to: 'review', outcome: 'completed' },
        { from: 'review', to: 'finish', outcome: 'pass' }],
    }, layout: {},
  });
}

export const templates: Record<'fast' | 'dev' | 'research', Flow> = {
  fast: codeTemplate('Fast'), dev: codeTemplate('Dev'), research: researchTemplate(),
};
