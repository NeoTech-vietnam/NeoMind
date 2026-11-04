import type { Flow, FlowNode } from './schema.js';

/** Duplicate a subgraph into a draft. References and edges internal to the selection follow the copied nodes. */
export function duplicateNodes(target: Flow, source: Flow, nodeIds: string[]) {
  const selected = new Set(nodeIds), originals = source.definition.nodes.filter(node => selected.has(node.id) && node.type !== 'start');
  const next = structuredClone(target), used = new Set(next.definition.nodes.map(node => node.id)), mapped = new Map<string, string>();
  for (const node of originals) {
    let index = 1; while (used.has(`${node.type}-${index}`)) index++;
    const id = `${node.type}-${index}`; used.add(id); mapped.set(node.id, id);
  }
  const translate = (value: string) => mapped.get(value) ?? value;
  for (const original of originals) {
    const copy: FlowNode = { ...structuredClone(original), id: mapped.get(original.id)!, label: `${original.label} copy` };
    if (copy.type === 'review_group') copy.targetNodeId = translate(copy.targetNodeId);
    if (copy.type === 'repair_scope') { copy.targetReviewId = translate(copy.targetReviewId); copy.ownerNodeIds = copy.ownerNodeIds.map(translate); }
    if (copy.type === 'join') copy.requiredBranches = copy.requiredBranches.map(translate);
    next.definition.nodes.push(copy);
    const index = source.definition.nodes.findIndex(node => node.id === original.id);
    const pos = source.layout[original.id] ?? { x: 80 + (index % 4) * 255, y: 110 + Math.floor(index / 4) * 165 };
    next.layout[copy.id] = { x: pos.x + 36, y: pos.y + 36 };
  }
  for (const edge of source.definition.edges) if (mapped.has(edge.from) && mapped.has(edge.to)) {
    next.definition.edges.push({ ...edge, from: mapped.get(edge.from)!, to: mapped.get(edge.to)! });
  }
  return { flow: next, ids: [...mapped.values()] };
}
