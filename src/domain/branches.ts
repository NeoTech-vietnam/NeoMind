import type { Flow, FlowNode } from './schema.js';

/** Graph facts about fork branches, shared by preflight, approval and the executor. */
export function branchLayout(flow: Flow) {
  const nodes = flow.definition.nodes, edges = flow.definition.edges;
  const closure = (start: string, next: (id: string) => string[]) => {
    const seen = new Set<string>(), stack = [...next(start)];
    while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); stack.push(...next(id)); }
    return seen;
  };
  const parents = (id: string) => edges.filter(edge => edge.to === id).map(edge => edge.from);
  const children = (id: string) => edges.filter(edge => edge.from === id).map(edge => edge.to);
  const typeOf = (id: string) => nodes.find(node => node.id === id)?.type;
  const ancestors = new Map(nodes.map(node => [node.id, closure(node.id, parents)]));
  const descendants = new Map(nodes.map(node => [node.id, closure(node.id, children)]));
  /** Between a fork and its join: may run concurrently with sibling branches. */
  const insideBranch = (id: string) => [...ancestors.get(id)!].some(item => typeOf(item) === 'fork') && [...descendants.get(id)!].some(item => typeOf(item) === 'join');
  const isWriter = (node: FlowNode) => node.type === 'agent_task' && node.permissions.write;
  const branchWriters = nodes.filter(node => isWriter(node) && insideBranch(node.id)) as Extract<FlowNode, { type: 'agent_task' }>[];
  const integrations = nodes.filter(node => node.type === 'integration') as Extract<FlowNode, { type: 'integration' }>[];
  return { ancestors, descendants, insideBranch, isWriter, branchWriters, integrations,
    /** Branch writers merged by an integration node: those upstream of it. */
    writersFor: (integrationId: string) => branchWriters.filter(writer => ancestors.get(integrationId)!.has(writer.id)) };
}
