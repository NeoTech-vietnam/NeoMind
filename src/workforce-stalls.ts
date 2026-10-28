export type ProviderStallAction = 'retry-provider' | 'escalate' | 'diagnose' | 'incident';
export interface ProviderStallHistory {
  checkpoint: string;
  attempts: { invocation_id: string; model: string; action: ProviderStallAction; at: string }[];
}
/** A fresh health nonce is transport evidence, not progress on the failed task.
 * Only a different authoritative task checkpoint opens a new strategy history. */
export function workforceProviderStallDecision(history: ProviderStallHistory[], input: {
  checkpoint: string; invocation_id: string; model: string; can_escalate: boolean; at: string;
}): { history: ProviderStallHistory[]; action: ProviderStallAction; replayed: boolean } {
  const result = structuredClone(history), entry = result.find(value => value.checkpoint === input.checkpoint)
    ?? { checkpoint: input.checkpoint, attempts: [] };
  if (!result.includes(entry)) result.push(entry);
  const previous = entry.attempts.find(value => value.invocation_id === input.invocation_id);
  if (previous) return { history: result, action: previous.action, replayed: true };
  const used = new Set(entry.attempts.map(value => value.action));
  const action: ProviderStallAction = input.can_escalate && !used.has('escalate') ? 'escalate'
    : !used.has('retry-provider') ? 'retry-provider' : !used.has('diagnose') ? 'diagnose' : 'incident';
  entry.attempts.push({ invocation_id: input.invocation_id, model: input.model, action, at: input.at });
  return { history: result, action, replayed: false };
}
