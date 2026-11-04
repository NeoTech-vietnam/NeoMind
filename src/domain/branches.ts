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
    const ancestors = new Map(nodes.map(node => [node.id, closure(node.id, parents)]));
  const descendants = new Map(nodes.map(node => [node.id, closure(node.id, children)]));
  // Pair a fork with the first join reachable from every outgoing branch. A later fork must not
  // make steps after an earlier join look like members of the earlier parallel region.
  const regions = nodes.filter(node => node.type === 'fork').flatMap(fork => {
    const starts = children(fork.id);
    const candidates = nodes.filter(node => node.type === 'join' && starts.every(start => start === node.id || descendants.get(start)!.has(node.id)));
    const first = candidates.filter(join => !candidates.some(other => other.id !== join.id && ancestors.get(join.id)!.has(other.id)));
    return first.map(join => ({ fork: fork.id, join: join.id }));
  });
  const insideBranch = (id: string) => regions.some(region => ancestors.get(id)!.has(region.fork) && descendants.get(id)!.has(region.join));
  const isWriter = (node: FlowNode) => node.type === 'agent_task' && node.permissions.write;
  const branchWriters = nodes.filter(node => isWriter(node) && insideBranch(node.id)) as Extract<FlowNode, { type: 'agent_task' }>[];
  const integrations = nodes.filter(node => node.type === 'integration') as Extract<FlowNode, { type: 'integration' }>[];
  return { ancestors, descendants, regions, insideBranch, isWriter, branchWriters, integrations,
    /** Branch writers merged by an integration node: those upstream of it. */
    writersFor: (integrationId: string) => branchWriters.filter(writer => ancestors.get(integrationId)!.has(writer.id) && !integrations.some(previous => previous.id !== integrationId && ancestors.get(integrationId)!.has(previous.id) && ancestors.get(previous.id)!.has(writer.id))) };
}
