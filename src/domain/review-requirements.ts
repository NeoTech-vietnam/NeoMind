import type { Flow, FlowNode } from './schema.js';
import type { Plan } from './approval.js';
import { branchLayout } from './branches.js';

/** A branch is reviewed against its own criteria; integration/final review still requires the full approved plan. */
export function reviewRequirements(flow: Flow, node: Extract<FlowNode, { type: 'review_group' }>, plan?: Plan) {
  const branch = branchLayout(flow).branchWriters.some(writer => writer.id === node.targetNodeId);
  return { branch, criteria: [...new Set([...node.criteria, ...(branch ? [] : plan?.acceptanceCriteria ?? [])])],
    checks: [...new Set([...(branch ? [] : plan?.checks ?? []), ...(node.checks ?? [])])] };
}
