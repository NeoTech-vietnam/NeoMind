import { z } from 'zod';
import { hashJson } from './resolve.js';
import { projectPolicySchema, type ProjectPolicy } from './schema.js';

/** One branch writer's share of an approved plan; its scope bounds that writer's sandbox. */
export const workPacketSchema = z.strictObject({ nodeId: z.string().min(1), goal: z.string().min(1), scope: z.array(z.string().min(1)).min(1) });
const planFields = {
  planId: z.string().min(1), version: z.number().int().min(1), goal: z.string().min(1),
  scope: z.array(z.string().min(1)).min(1), approach: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1), checks: z.array(z.string().min(1)),
  riskChanges: z.array(z.string().min(1)),
};
/** Stored plans omit `workPackets` unless a flow has branch writers, so earlier plan hashes stay valid. */
export const planSchema = z.strictObject({ ...planFields, workPackets: z.array(workPacketSchema).min(1).optional() });
export type Plan = z.infer<typeof planSchema>;
export type WorkPacket = z.infer<typeof workPacketSchema>;
/** Structured-output schema for planners: every field is required; an empty packet list means none. */
export const plannerOutputSchema = z.strictObject({ ...planFields, workPackets: z.array(workPacketSchema) });
export function normalizePlan(input: unknown): Plan {
  const plan = plannerOutputSchema.partial({ workPackets: true }).parse(input);
  const { workPackets, ...rest } = plan;
  return planSchema.parse(workPackets?.length ? { ...rest, workPackets } : rest);
}

export const approvalSchema = z.strictObject({
  approvalId: z.string().min(1), actor: z.string().min(1), source: z.enum(['cli', 'ui', 'flow', 'session']),
  planId: z.string().min(1), planVersion: z.number().int().min(1), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/), scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approved', 'changes_requested', 'rejected']), timestamp: z.iso.datetime(),
});
export type Approval = z.infer<typeof approvalSchema>;

/** Call only from a trusted local user action, never from a worker's output. */
export function recordApproval(planInput: unknown, policyInput: unknown, action: {
  approvalId: string; actor: string; source: 'cli' | 'ui' | 'flow' | 'session'; decision: Approval['decision']; timestamp: string;
}): Approval {
  const plan = planSchema.parse(planInput);
  const policy = projectPolicySchema.parse(policyInput);
  return approvalSchema.parse({ ...action, planId: plan.planId, planVersion: plan.version,
    planHash: hashJson(plan), policyHash: hashJson(policy), scopeHash: hashJson(plan.scope) });
}

/** A record alone is not authentication; callers must also authorize the local user action. */
export function approvalMatches(approvalInput: unknown, planInput: unknown, livePolicy: ProjectPolicy): boolean {
  const approval = approvalSchema.safeParse(approvalInput);
  const plan = planSchema.safeParse(planInput);
  const policy = projectPolicySchema.safeParse(livePolicy);
  if (!approval.success || !plan.success || !policy.success) return false;
  return approval.data.decision === 'approved' && approval.data.planId === plan.data.planId &&
    approval.data.planVersion === plan.data.version && approval.data.planHash === hashJson(plan.data) &&
    approval.data.scopeHash === hashJson(plan.data.scope) && approval.data.policyHash === hashJson(policy.data);
}
