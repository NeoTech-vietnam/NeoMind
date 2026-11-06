/** Fewer finished runs than this give no estimate: one or two runs say too little about the next. */
export const ESTIMATE_MIN_RUNS = 3;

export interface EstimateGroup { key: string; completed: number; tokens: { median: number | null }; activeSeconds: { median: number | null }; costUSD: { median: number | null } | null }

/** Key of the statistics group for a flow run with this set of runners (`dev|claude-code+codex`). */
export const flowRunnersKey = (flowId: string, runners: Iterable<string>) => `${flowId}|${[...new Set(runners)].sort().join('+')}`;

/** Median time, tokens and cost of earlier finished runs of the same flow and runners, or null without enough of them. */
export function estimateFor(groups: EstimateGroup[], flowId: string, runners: Iterable<string>) {
  const group = groups.find(item => item.key === flowRunnersKey(flowId, runners));
  if (!group || group.completed < ESTIMATE_MIN_RUNS) return null;
  return { runs: group.completed, activeSeconds: group.activeSeconds.median, tokens: group.tokens.median, costUSD: group.costUSD?.median ?? null };
}
