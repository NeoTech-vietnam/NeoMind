import type { Flow, FlowNode, Binding } from './schema.js';
import { jsonChanges } from './json-diff.js';

export type FlowDiff = {
  nodes: { added: FlowNode[]; removed: FlowNode[]; changed: { id: string; before: FlowNode; after: FlowNode }[] };
  edges: { added: Flow['definition']['edges']; removed: Flow['definition']['edges'] };
  bindings: { id: string; before?: Binding; after?: Binding }[];
  limits: { field: string; before: number | null; after: number | null }[];
};

/** Structural diff shared by the session, CLI, API and editor. */
export function diffFlows(before: Flow | null, after: Flow): FlowDiff {
  const previous = new Map((before?.definition.nodes ?? []).map(node => [node.id, node]));
  const current = new Map(after.definition.nodes.map(node => [node.id, node]));
  const changed = (a: unknown, b: unknown) => jsonChanges(a, b, 1).changes.length > 0;
  const edgeKey = (edge: Flow['definition']['edges'][number]) => JSON.stringify([edge.from, edge.to, edge.outcome]);
  const previousEdges = new Set((before?.definition.edges ?? []).map(edgeKey));
  const currentEdges = new Set(after.definition.edges.map(edgeKey));
  const keys = new Set([...Object.keys(before?.definition.bindings ?? {}), ...Object.keys(after.definition.bindings)]);
  return {
    nodes: {
      added: after.definition.nodes.filter(node => !previous.has(node.id)),
      removed: (before?.definition.nodes ?? []).filter(node => !current.has(node.id)),
      changed: after.definition.nodes.flatMap(node => { const old = previous.get(node.id); return old && changed(old, node) ? [{ id: node.id, before: old, after: node }] : []; }),
    },
    edges: { added: after.definition.edges.filter(edge => !previousEdges.has(edgeKey(edge))), removed: (before?.definition.edges ?? []).filter(edge => !currentEdges.has(edgeKey(edge))) },
    bindings: [...keys].flatMap(id => {
      const old = before?.definition.bindings[id], next = after.definition.bindings[id];
      return changed(old, next) ? [{ id, ...(old ? { before: old } : {}), ...(next ? { after: next } : {}) }] : [];
    }),
    // Optional limits (maxTokens) can appear or disappear, so compare the keys of both sides.
    limits: ([...new Set([...Object.keys(before?.definition.limits ?? {}), ...Object.keys(after.definition.limits)])] as (keyof Flow['definition']['limits'])[]).flatMap(field => before?.definition.limits[field] === after.definition.limits[field] ? [] : [{ field, before: before?.definition.limits[field] ?? null, after: after.definition.limits[field] ?? null }]),
  };
}
