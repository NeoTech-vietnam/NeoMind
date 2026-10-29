export interface BudgetState {
  runRoundsUsed: number;
  scopesUsed: Record<string, number>;
  allocations: Record<string, string[]>;
}

/** Pure decision function; persist the returned state atomically before dispatching work. */
export function allocateRepairRound(
  prior: BudgetState, roundId: string, scopeIds: string[],
  runLimit: number, scopeLimits: Record<string, number>,
): BudgetState {
  if (!roundId || scopeIds.length === 0 || new Set(scopeIds).size !== scopeIds.length) throw new Error('Invalid repair allocation');
  if (!Number.isInteger(runLimit) || runLimit < 0 || !Number.isInteger(prior.runRoundsUsed) || prior.runRoundsUsed < 0) throw new Error('Invalid run budget');
  const existing = prior.allocations[roundId];
  const normalized = [...scopeIds].sort();
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error('Round ID was reused with different scopes');
    return structuredClone(prior);
  }
  if (prior.runRoundsUsed >= runLimit) throw new Error('Run repair budget exhausted');
  for (const scope of normalized) {
    const limit = scopeLimits[scope];
    const used = prior.scopesUsed[scope] ?? 0;
    if (limit === undefined || !Number.isInteger(limit) || limit < 0 || !Number.isInteger(used) || used < 0 || used >= limit) {
      throw new Error(`Repair budget exhausted or missing for ${scope}`);
    }
  }
  const next = structuredClone(prior);
  next.runRoundsUsed++;
  for (const scope of normalized) next.scopesUsed[scope] = (next.scopesUsed[scope] ?? 0) + 1;
  next.allocations[roundId] = normalized;
  return next;
}
