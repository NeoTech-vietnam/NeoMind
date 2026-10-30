import type { Flow } from '../../src/domain/schema';

export type BindingValues = { runner: string; provider: string; model: string; reasoning: string };
export type MaterializedRun = { configuration: { flow: Flow; bindings: Record<string, { values: BindingValues }> } };
export type Plan = { goal: string; approach: string; scope: string[]; acceptanceCriteria: string[]; checks: string[]; riskChanges: string[] };
export type Evidence = { criteria: { criterion: string; status: string }[]; findings: { id: string; criterion: string; explanation: string }[] };

export type Run = {
  runId: string; busy: boolean; proposedPlanHash?: string; timeLimitMs?: number; timeExtensionsMs: number;
  runtimeState?: { phase: string; reason: string; activeMs: number };
  runtimeContext?: { task: string; workspace: string; sourceHead?: string };
  snapshot?: MaterializedRun;
  bindingSelections: { key: string; values: BindingValues; reason: string }[];
  usage: { totalTokens: number | null; partial: boolean };
  graph: { nodes: Record<string, { status: string }> };
  plans: { nodeId: string; plan: Plan }[];
  approvals?: { nodeId: string; approval: { source: string } }[];
  checks: { checkId: string; command: string; status: string }[];
  reviewerOutputs: { attemptId: string; nodeId: string; summary: string; result: { reviewerId: string; verdict: string; findingIds: string[] }; evidence?: Evidence }[];
  acceptedReviews: { nodeId: string }[];
  artifacts: { nodeId: string; kind: string; text: string }[];
  unresolvedCommitNodeIds: string[];
  delivery?: { nodeId: string; commit: string; parent: string; files: string[] }[];
  /** A finished flow without a commit: the files it changed for the user to review and apply. */
  handoff?: { files: string[]; applied: boolean };
  /** The run's worktrees were (or are being) removed; commits stay reachable through the listed refs. */
  workspaceCleanup?: { workspaces: string[]; refs: { ref: string; commit: string }[]; discarded: string[]; cleaned: boolean };
};

export type Preview = {
  runtimeDiagnostics: string[]; snapshot: MaterializedRun; configurationHash: string; sourceHead: string; dirtyPaths: string[]; gitDelivery: string;
  runnerPreflight?: { blockers: string[]; checks: { available: boolean; reason?: string } };
  flowExceptions?: string[];
  dirtyImport: { baselineHash: string; changes: { path: string; change: 'modified' | 'added' | 'deleted' }[]; blockers: string[] };
};

export type RunSummary = { runId: string; task?: string | undefined; flowName?: string | undefined; phase: string; reason: string; activeMs?: number | undefined };

/** Effective runner/model per binding: the latest recorded selection wins over the snapshot. */
export function effectiveBindings(run: Run): Map<string, BindingValues> {
  const values = new Map(Object.entries(run.snapshot?.configuration.bindings ?? {}).map(([key, binding]) => [key, binding.values]));
  for (const selection of run.bindingSelections) values.set(selection.key, selection.values);
  return values;
}

/** Human label of a binding key: `node` or `node/reviewer`, named after the flow step. */
export function bindingLabel(key: string, flow: Flow | undefined): string {
  const [nodeId, reviewerId] = key.split('/');
  const node = flow?.definition.nodes.find(item => item.id === nodeId);
  const label = node?.label ?? nodeId ?? key;
  return reviewerId ? `${label} · ${reviewerId}` : label;
}
