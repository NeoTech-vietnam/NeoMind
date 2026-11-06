import type { Flow, FlowNode } from './schema.js';
import type { Plan } from './approval.js';
import { branchLayout } from './branches.js';

/** Numbered items (`1.` or `1)`) of a plan approach, in order; prose without a numbered list yields none. */
export function planSteps(approach: string): { number: number; text: string }[] {
  return approach.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d{1,3})[.)]\s+(.+?)\s*$/.exec(line);
    return match ? [{ number: Number(match[1]), text: match[2]! }] : [];
  });
}

/** A branch is reviewed against its own criteria; integration/final review still requires the full approved plan. */
export function reviewRequirements(flow: Flow, node: Extract<FlowNode, { type: 'review_group' }>, plan?: Plan) {
  const branch = branchLayout(flow).branchWriters.some(writer => writer.id === node.targetNodeId);
  const steps = !branch && node.planStepCriteria && plan ? planSteps(plan.approach).map(step => `Plan step ${step.number}: ${step.text}`) : [];
  return { branch, criteria: [...new Set([...node.criteria, ...(branch ? [] : plan?.acceptanceCriteria ?? []), ...steps])],
    checks: [...new Set([...(branch ? [] : plan?.checks ?? []), ...(node.checks ?? [])])] };
}
