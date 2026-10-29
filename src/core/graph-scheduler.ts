import { compileFlow, type Compilation } from '../domain/compiler.js';
import type { Flow, ProjectPolicy } from '../domain/schema.js';

export type NodeStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';
export type Outcome = 'completed' | 'pass' | 'needs_changes' | 'blocked' | 'true' | 'false';
export interface NodeState { status: NodeStatus; outcome?: Outcome; reason?: string }
export interface SchedulerSnapshot { nodes: Record<string, NodeState> }

/**
 * In-memory, deterministic graph readiness engine. It does not dispatch work,
 * validate agent outputs, persist events, acquire workspace leases or decide
 * acceptance. Production orchestration must supply those independently.
 */
export class GraphScheduler {
  private readonly flow: Flow;
  private readonly order: string[];
  private readonly state: SchedulerSnapshot;

  constructor(flow: unknown, policy: ProjectPolicy) {
    const result: Compilation = compileFlow(flow, policy);
    if (!result.ok) throw new Error(`Invalid flow: ${result.diagnostics.map(d => d.code).join(', ')}`);
    this.flow = result.flow; this.order = result.order;
    this.state = { nodes: Object.fromEntries(this.flow.definition.nodes.map(n => [n.id, { status: 'pending' as const }])) };
    this.state.nodes[this.flow.definition.startNodeId] = { status: 'ready' };
  }

  snapshot(): SchedulerSnapshot { return structuredClone(this.state); }
  ready(): string[] { return this.order.filter(id => this.state.nodes[id]?.status === 'ready'); }

  claim(nodeId: string): void {
    if (this.state.nodes[nodeId]?.status !== 'ready') throw new Error(`Node ${nodeId} is not ready`);
    this.state.nodes[nodeId] = { status: 'running' };
  }

  complete(nodeId: string, outcome: Outcome): void {
    if (this.state.nodes[nodeId]?.status !== 'running') throw new Error(`Node ${nodeId} is not running`);
    this.state.nodes[nodeId] = { status: 'succeeded', outcome };
    this.propagate();
  }

  fail(nodeId: string, reason: string): void {
    if (this.state.nodes[nodeId]?.status !== 'running') throw new Error(`Node ${nodeId} is not running`);
    this.state.nodes[nodeId] = { status: 'failed', reason };
    this.propagate();
  }

  private propagate(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of this.order) {
        if (this.state.nodes[id]?.status !== 'pending') continue;
        const node = this.flow.definition.nodes.find(n => n.id === id)!;
        const incoming = this.flow.definition.edges.filter(e => e.to === id);
        if (!incoming.length) continue;
        const relevant = node.type === 'join' ? incoming.filter(e => node.requiredBranches.includes(e.from)) : incoming;
        if (relevant.some(e => !['succeeded', 'failed', 'skipped'].includes(this.state.nodes[e.from]?.status ?? 'pending'))) continue;
        const matches = (edge: typeof incoming[number]) => {
          const predecessor = this.state.nodes[edge.from];
          return predecessor?.status === 'succeeded' && predecessor.outcome === edge.outcome;
        };
        if (node.type === 'join') {
          if (relevant.every(matches)) this.state.nodes[id] = { status: 'ready' };
          else this.state.nodes[id] = { status: 'waiting', reason: 'A required branch did not complete successfully' };
        } else if (incoming.some(matches)) this.state.nodes[id] = { status: 'ready' };
        else this.state.nodes[id] = { status: 'skipped', reason: 'No incoming outcome selected this path' };
        changed = true;
      }
    }
  }
}
