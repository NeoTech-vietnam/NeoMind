import type { Flow, FlowNode } from '../../src/domain/schema';
import { stepName } from './format';
import type { Run } from './runTypes';

/**
 * One step of the run as the user sees it: a flow node, or the writers between a fork and its join folded into one
 * "Thực hiện · N nhánh" step. Fork, join, condition, start and finish nodes are plumbing and never shown.
 */
export type Step = { id: string; label: string; nodeIds: string[]; node: FlowNode; branches?: number };

const hidden = new Set(['start', 'finish', 'fork', 'join', 'condition']);

/** Nodes between a fork and its join, found by following edges until a join. */
function branchNodes(flow: Flow, forkId: string): string[] {
  const out = new Set<string>(), queue = flow.definition.edges.filter(edge => edge.from === forkId).map(edge => edge.to);
  while (queue.length) {
    const id = queue.shift()!, node = flow.definition.nodes.find(item => item.id === id);
    if (!node || node.type === 'join' || out.has(id)) continue;
    out.add(id);
    for (const edge of flow.definition.edges) if (edge.from === id) queue.push(edge.to);
  }
  return [...out];
}

export function flowSteps(flow: Flow | undefined): Step[] {
  if (!flow) return [];
  const folded = new Map<string, string[]>(), skip = new Set<string>();
  for (const node of flow.definition.nodes) if (node.type === 'fork') { const ids = branchNodes(flow, node.id); folded.set(ids[0] ?? '', ids); ids.forEach(id => skip.add(id)); }
  const steps: Step[] = [];
  for (const node of flow.definition.nodes) {
    const group = folded.get(node.id);
    if (group) steps.push({ id: `branches:${node.id}`, label: 'Thực hiện', nodeIds: group, node, branches: group.length });
    else if (!hidden.has(node.type) && !skip.has(node.id)) steps.push({ id: node.id, label: stepName(node.label), nodeIds: [node.id], node });
  }
  // A repair scope is listed after the review that sends work back to it, which is the order things happen in.
  for (const repair of steps.filter(step => step.node.type === 'repair_scope')) {
    const target = steps.findIndex(step => step.id === (repair.node as { targetReviewId: string }).targetReviewId);
    if (target < 0) continue;
    steps.splice(steps.indexOf(repair), 1);
    steps.splice(steps.findIndex(step => step.id === (repair.node as { targetReviewId: string }).targetReviewId) + 1, 0, repair);
  }
  return steps;
}

export type StepState = { status: string; interrupted: boolean };

/** Status of a step from the run's graph; a step recorded as running is only live while the run itself is running. */
export function stepState(step: Step, run: Run): StepState {
  const phase = run.runtimeState?.phase, live = phase === 'running' || phase === 'stopping';
  const statuses = step.nodeIds.map(id => run.graph.nodes[id]?.status ?? 'pending');
  const pick = (name: string) => statuses.includes(name);
  const status = pick('failed') ? 'failed' : pick('running') ? 'running' : pick('waiting') ? 'waiting' : statuses.every(item => item === 'succeeded') ? 'succeeded'
    : statuses.every(item => item === 'skipped') ? 'skipped' : pick('succeeded') ? 'running' : pick('ready') ? 'ready' : 'pending';
  return { status, interrupted: status === 'running' && !live };
}

/** Repair rounds spent so far: every review after the first of a reviewer means the writer was sent back once. */
export function repairRounds(run: Run, flow: Flow | undefined): { used: number; max: number; nodeId: string } | null {
  const repair = flow?.definition.nodes.find(node => node.type === 'repair_scope');
  if (!flow || repair?.type !== 'repair_scope') return null;
  const perReviewer = new Map<string, number>();
  for (const output of run.reviewerOutputs) if (output.nodeId === repair.targetReviewId) perReviewer.set(output.result.reviewerId, (perReviewer.get(output.result.reviewerId) ?? 0) + 1);
  const max = Math.min(repair.maxRounds, flow.definition.limits.maxRepairRounds);
  return { used: Math.min(max, Math.max(0, ...[...perReviewer.values()].map(count => count - 1))), max, nodeId: repair.id };
}
