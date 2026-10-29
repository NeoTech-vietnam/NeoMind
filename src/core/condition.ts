import type { FlowNode } from '../domain/schema.js';
import { hashJson } from '../domain/resolve.js';
export interface ConditionFacts {
  nodes: Record<string, { status: string; outcome?: string }>;
  incomingIds: string[]; checks: { status: string; command?: string }[]; acceptedReviewCount: number; repairRounds: number;
}
export function evaluateCondition(node: Extract<FlowNode, { type: 'condition' }>, facts: ConditionFacts): boolean {
  const checks = [...new Map(facts.checks.map((check, index) => [check.command ?? String(index), check])).values()];
  let actual: unknown;
  if (node.field === 'result') { const values = facts.incomingIds.map(id => facts.nodes[id]?.outcome); actual = values.length === 1 ? values[0] : values; }
  else if (node.field === 'checks.passed') actual = checks.length > 0 && checks.every(check => check.status === 'passed');
  else if (node.field === 'checks.results') actual = checks.map(check => check.status === 'passed');
  else if (node.field === 'review.accepted') actual = facts.acceptedReviewCount > 0;
  else if (node.field === 'repair.rounds') actual = facts.repairRounds;
  else if (/^node\..+\.(?:status|outcome)$/.test(node.field)) {
    const suffix = node.field.endsWith('.status') ? 'status' : 'outcome', id = node.field.slice(5, -(suffix.length + 1)); actual = facts.nodes[id]?.[suffix];
  } else throw new Error(`Unsupported condition field: ${node.field}`);
  if (node.operator === 'exists') return actual !== undefined && actual !== null;
  if (node.operator === 'eq' || node.operator === 'ne') {
    if (actual === undefined || node.value === undefined) throw new Error('Equality requires a defined field and value');
    const equal = hashJson(actual) === hashJson(node.value); return node.operator === 'eq' ? equal : !equal;
  }
  if (node.operator === 'in') { if (!Array.isArray(node.value) || actual === undefined) throw new Error('Membership requires an array value'); return node.value.some(value => hashJson(value) === hashJson(actual)); }
  if (!Array.isArray(actual) || actual.some(value => typeof value !== 'boolean')) throw new Error('all/any require a boolean array field');
  return node.operator === 'all' ? actual.length > 0 && actual.every(Boolean) : actual.some(Boolean);
}
