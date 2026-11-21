/**
 * Groups of a workflow graph, inferred from its shape (works for old runs too, no server field needed):
 *   parallel X / fanout X   X, X_join and every node on a path between them
 *   loop X                  X_check and every node on a path from the loop entry (target of "again") to X_check
 *   route R                 R and every node reachable from R before the first node all its branches reach
 * Groups nest (a route inside a loop). `collapse` maps the graph to one where each collapsed group is a single node.
 */
import type { Graph, GraphEdge, StepInfo, StepState } from './types';

export type Group = { id: string; kind: 'parallel' | 'fanout' | 'loop' | 'route'; head: string | null; members: Set<string>; parent: string | null; size: number };
export type Groups = { list: Group[]; byId: Map<string, Group>; chain: Map<string, string[]> };
export const GROUP_PREFIX = 'grp:';

export function inferGroups(graph: Graph): Groups {
  const ids = graph.nodes.map(node => node.id), kind = new Map(graph.nodes.map(node => [node.id, node.kind]));
  const forward = graph.edges.filter(edge => edge.label !== 'again');
  const next = new Map<string, string[]>(ids.map(id => [id, []])), prev = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const edge of forward) { next.get(edge.source)?.push(edge.target); prev.get(edge.target)?.push(edge.source); }
  const walk = (from: string, links: Map<string, string[]>) => {
    const seen = new Set<string>([from]), stack = [from];
    while (stack.length) for (const id of links.get(stack.pop()!) ?? []) if (!seen.has(id)) { seen.add(id); stack.push(id); }
    return seen;
  };
  const between = (from: string, to: string) => { const down = walk(from, next), up = walk(to, prev); return new Set([...down].filter(id => up.has(id))); };
  const list: Group[] = [];
  for (const node of graph.nodes) {
    if ((node.kind === 'parallel' || node.kind === 'fanout') && kind.has(`${node.id}_join`)) {
      list.push({ id: node.id, kind: node.kind, head: node.id, members: between(node.id, `${node.id}_join`), parent: null, size: 0 });
    } else if (node.kind === 'loop' && node.id.endsWith('_check')) {
      const entry = graph.edges.find(edge => edge.source === node.id && edge.label === 'again')?.target;
      if (entry) list.push({ id: node.id.slice(0, -'_check'.length), kind: 'loop', head: null, members: between(entry, node.id), parent: null, size: 0 });
    } else if (node.kind === 'route') {
      const branches = (next.get(node.id) ?? []).map(id => walk(id, next));
      const merge = ids.find(id => id !== '__end__' && branches.every(reach => reach.has(id))) ?? '__end__';
      const after = walk(merge, next);
      list.push({ id: node.id, kind: 'route', head: node.id, members: new Set([...walk(node.id, next)].filter(id => !after.has(id))), parent: null, size: 0 });
    }
  }
  for (const group of list) {
    group.size = group.members.size;
    const outer = list.filter(other => other !== group && other.members.size > group.members.size && [...group.members].every(id => other.members.has(id)));
    group.parent = outer.sort((a, b) => a.members.size - b.members.size)[0]?.id ?? null;
  }
  const byId = new Map(list.map(group => [group.id, group]));
  // chain: node -> its groups, innermost first
  const chain = new Map<string, string[]>();
  for (const id of ids) chain.set(id, list.filter(group => group.members.has(id)).sort((a, b) => a.members.size - b.members.size).map(group => group.id));
  return { list, byId, chain };
}

/** The node shown for `id`: itself, or the outermost collapsed group it belongs to. */
export function representative(id: string, groups: Groups, expanded: Set<string>): string {
  const outerFirst = [...(groups.chain.get(id) ?? [])].reverse();
  const collapsed = outerFirst.find(group => !expanded.has(group));
  return collapsed ? GROUP_PREFIX + collapsed : id;
}

export const STRUCTURAL = new Set(['parallel', 'join', 'loop', 'start', 'end']);
const isLeaf = (kind: string) => !STRUCTURAL.has(kind);

/** A group's state from its members: failed > waiting > running > cancelled > rejected > done (exit reached) > todo. */
export function groupState(group: Group, graph: Graph, states: Record<string, StepState>): StepState {
  const members = [...group.members], st = (id: string) => states[id] ?? 'todo';
  if (members.some(id => st(id) === 'failed')) return 'failed';
  if (members.some(id => st(id) === 'waiting')) return 'waiting';
  if (members.some(id => st(id) === 'running')) return 'running';
  if (members.some(id => st(id) === 'cancelled')) return 'cancelled';
  if (members.some(id => st(id) === 'rejected')) return 'rejected';
  const exit = group.kind === 'loop' ? `${group.id}_check` : group.kind === 'route' ? null : `${group.id}_join`;
  if (exit) return st(exit) === 'done' ? 'done' : members.some(id => st(id) === 'done') ? 'running' : 'todo';
  // route: done once the head is done and some branch step finished (the other branches never run)
  return st(group.id) === 'done' && members.some(id => id !== group.id && st(id) === 'done') ? 'done'
    : members.some(id => st(id) === 'done') ? 'running' : 'todo';
}

/** "2/5 xong" over the group's leaf steps (fan-out workers from their own counter). */
export function groupDetail(group: Group, graph: Graph, states: Record<string, StepState>, info: Record<string, StepInfo>): string {
  if (group.kind === 'fanout') return info[`${group.id}_worker`]?.workers ?? info[group.id]?.items?.toString().concat(' item') ?? 'fan-out';
  const kinds = new Map(graph.nodes.map(node => [node.id, node.kind]));
  const leaves = [...group.members].filter(id => isLeaf(kinds.get(id) ?? '') && id !== group.head);
  const done = leaves.filter(id => states[id] === 'done').length;
  if (group.kind === 'loop') { const round = info[`${group.id}_check`]?.round; return `${done}/${leaves.length} xong${round ? ` · vòng ${round}` : ''}`; }
  if (group.kind === 'route') { const taken = info[group.id]?.route; return taken ? `→ ${taken}` : `${leaves.length} bước`; }
  return `${done}/${leaves.length} xong`;
}

export const GROUP_LABEL: Record<Group['kind'], string> = { parallel: 'song song', fanout: 'fan-out', loop: 'vòng lặp', route: 'rẽ nhánh' };

/** The graph as shown: collapsed groups replaced by one node each (edges remapped, inner edges dropped). */
export function collapse(graph: Graph, groups: Groups, expanded: Set<string>): Graph {
  const rep = (id: string) => representative(id, groups, expanded);
  const nodes: Graph['nodes'] = [], seen = new Set<string>();
  for (const node of graph.nodes) {
    const id = rep(node.id);
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push(id === node.id ? node : { id, kind: 'group' });
  }
  const edges: GraphEdge[] = [], keys = new Set<string>();
  for (const edge of graph.edges) {
    const source = rep(edge.source), target = rep(edge.target);
    if (source === target) continue;
    const label = source.startsWith(GROUP_PREFIX) && edge.label !== 'reject' ? null : edge.label;
    const key = `${source}>${target}>${label ?? ''}`;
    if (keys.has(key)) continue;
    keys.add(key);
    edges.push({ ...edge, source, target, label, conditional: edge.conditional && label !== null });
  }
  return { nodes, edges };
}

/** The roles and skills of a group's inner steps (graph node fields), for a collapsed group node and the Stepper. */
export type GroupBinding = { roles: string[]; skills: string[]; steps: { id: string; role: string | null; skills: string[] }[] };

export function groupBindings(group: Group, graph: Graph): GroupBinding | null {
  const steps = graph.nodes.filter(node => group.members.has(node.id) && (node.role || node.skills?.length))
    .map(node => ({ id: node.id, role: node.role ?? null, skills: node.skills ?? [] }));
  if (!steps.length) return null;
  return { roles: [...new Set(steps.flatMap(step => (step.role ? [step.role] : [])))], skills: [...new Set(steps.flatMap(step => step.skills))], steps };
}
