import type { BindingField, BindingValues } from './resolve.js';
import type { Flow } from './schema.js';

/** Every runner choice a run makes, keyed like the run snapshot (`node` or `node/reviewer`), with the flow binding it reads. */
export function bindingKeys(flow: Pick<Flow, 'definition'>): { key: string; bindingId: string }[] {
  const groups = new Map(flow.definition.sessionGroups.map(group => [group.id, group.bindingId]));
  return flow.definition.nodes.flatMap(node => node.type === 'agent_task' || (node.type === 'integration' && node.bindingId && node.profileId) ? [{ key: node.id, bindingId: node.bindingId! }]
    : node.type === 'review_group' ? node.reviewers.flatMap(reviewer => { const bindingId = groups.get(reviewer.sessionGroup); return bindingId ? [{ key: `${node.id}/${reviewer.id}`, bindingId }] : []; }) : []);
}

/** Values given for one step; unset fields keep what the binding had. */
export type BindingChoice = { [field in BindingField]?: string | undefined };
export type PinnedBinding = { bindingId: string; steps: string[]; values: Partial<BindingValues> };

/**
 * Pin runner/provider/model/reasoning chosen per step into the flow bindings those steps read. Steps that share a binding
 * (and usually a session) change together, so they are listed; giving them different values is refused instead of
 * splitting the binding, which would change how sessions are shared.
 */
export function pinBindings(flow: Flow, values: Record<string, BindingChoice>): { flow: Flow; pinned: PinnedBinding[] } {
  const keys = bindingKeys(flow), next = structuredClone(flow), chosen = new Map<string, { from: string; values: Partial<BindingValues> }>();
  for (const [key, given] of Object.entries(values)) {
    const bindingId = keys.find(item => item.key === key)?.bindingId;
    if (!bindingId) throw new Error(`Flow ${flow.flowId} has no step ${key}`);
    const fields = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) as Partial<BindingValues>;
    for (const [field, value] of Object.entries(fields)) if (typeof value !== 'string' || !value.trim()) throw new Error(`Empty ${field} for step ${key}`);
    const earlier = chosen.get(bindingId);
    if (earlier) {
      const clash = (Object.keys(fields) as BindingField[]).find(field => earlier.values[field] !== undefined && earlier.values[field] !== fields[field]);
      if (clash) throw new Error(`Steps ${earlier.from} and ${key} share binding ${bindingId} but chose a different ${clash}; choose the same value for both`);
      earlier.values = { ...earlier.values, ...fields };
    } else chosen.set(bindingId, { from: key, values: fields });
  }
  const pinned: PinnedBinding[] = [];
  for (const [bindingId, { values: fields }] of chosen) {
    const binding = next.definition.bindings[bindingId];
    if (!binding) throw new Error(`Flow ${flow.flowId} has no binding ${bindingId}`);
    for (const [field, value] of Object.entries(fields) as [BindingField, string][]) binding[field] = { mode: 'pinned', value };
    pinned.push({ bindingId, steps: keys.filter(item => item.bindingId === bindingId).map(item => item.key), values: fields });
  }
  return { flow: next, pinned };
}
