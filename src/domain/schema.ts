import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const choice = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('inherit') }),
  z.strictObject({ mode: z.literal('pinned'), value: z.string().min(1) }),
]);

export const bindingSchema = z.strictObject({
  runner: choice,
  provider: choice,
  model: choice,
  reasoning: choice,
  fallback: z.array(z.strictObject({
    runner: z.string().min(1), provider: z.string().min(1),
    model: z.string().min(1), reasoning: z.string().min(1),
  })).default([]),
});

export const permissionsSchema = z.strictObject({
  read: z.boolean(), write: z.boolean(), checks: z.boolean(),
  gitCommit: z.boolean(),
});

const relativePath = z.string().min(1).regex(/^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/, 'Path must be workspace-relative');
export const skillReferenceSchema = z.strictObject({ id, path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) });

export const profileSchema = z.strictObject({
  schemaVersion: z.literal(1), profileId: id, version: z.number().int().min(1),
  name: z.string().min(1), instructions: z.string(),
  skills: z.array(skillReferenceSchema),
  requestedPermissions: permissionsSchema,
  outputDefaults: z.record(z.string(), z.json()),
});

const base = { id, label: z.string().min(1) };
const reviewer = z.strictObject({
  id, profileId: id, profileVersion: z.number().int().min(1), sessionGroup: id, required: z.boolean(),
  scope: z.array(z.string().min(1)).min(1), instructionsOverride: z.string().optional(), skillsOverride: z.array(skillReferenceSchema).optional(),
});

export const nodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('start') }),
  z.strictObject({ ...base, type: z.literal('finish') }),
  z.strictObject({ ...base, type: z.literal('approval'), purpose: z.string().min(1) }),
  z.strictObject({ ...base, type: z.literal('fork') }),
  z.strictObject({ ...base, type: z.literal('join'), requiredBranches: z.array(id).min(1) }),
  z.strictObject({ ...base, type: z.literal('condition'), field: z.string().min(1), operator: z.enum(['eq', 'ne', 'in', 'exists', 'all', 'any']), value: z.json().optional() }),
  z.strictObject({ ...base, type: z.literal('integration'), writeScopes: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ ...base, type: z.literal('git_commit') }),
  z.strictObject({ ...base, type: z.literal('agent_task'), goal: z.string().min(1), profileId: id, profileVersion: z.number().int().min(1),
    sessionGroup: id, bindingId: id, permissions: permissionsSchema,
    writeScopes: z.array(z.string().min(1)), outputContract: z.string().min(1),
    instructionsOverride: z.string().optional(), skillsOverride: z.array(skillReferenceSchema).optional() }),
  z.strictObject({ ...base, type: z.literal('review_group'), targetNodeId: id,
    reviewers: z.array(reviewer).min(1), criteria: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ ...base, type: z.literal('repair_scope'), targetReviewId: id,
    ownerNodeIds: z.array(id).min(1), maxRounds: z.number().int().min(1) }),
]);

export const edgeSchema = z.strictObject({
  from: id, to: id,
  outcome: z.enum(['completed', 'pass', 'needs_changes', 'blocked', 'true', 'false']),
});

export const flowDefinitionSchema = z.strictObject({
  startNodeId: id,
  nodes: z.array(nodeSchema).min(2),
  edges: z.array(edgeSchema).min(1),
  bindings: z.record(id, bindingSchema),
  bindingDefaults: z.record(id, bindingSchema).default({}),
  sessionGroups: z.array(z.strictObject({ id, bindingId: id })).min(1),
  limits: z.strictObject({ maxConcurrency: z.number().int().min(1),
    maxRepairRounds: z.number().int().min(0), activeTimeSeconds: z.number().int().min(1) }),
  workspacePolicy: z.enum(['isolated', 'shared']),
  outputContract: z.string().min(1),
});

export const flowSchema = z.strictObject({
  schemaVersion: z.literal(1), flowId: id, version: z.number().int().min(1),
  name: z.string().min(1), description: z.string(),
  definition: flowDefinitionSchema,
  layout: z.record(id, z.strictObject({ x: z.number(), y: z.number() })),
});

export const projectPolicySchema = z.strictObject({
  requireApprovalBeforeWrite: z.boolean(), requireIndependentReviewForCode: z.boolean(),
  allowGitCommit: z.boolean(), maxConcurrency: z.number().int().min(1),
  maxRepairRounds: z.number().int().min(0),
});

export const projectSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, policyVersion: z.number().int().min(1),
  policy: projectPolicySchema,
  roleDefaults: z.record(id, z.strictObject({ runner: z.string().min(1), provider: z.string().min(1),
    model: z.string().min(1), reasoning: z.string().min(1) })),
});

export type Flow = z.infer<typeof flowSchema>;
export type FlowNode = z.infer<typeof nodeSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;
export type Profile = z.infer<typeof profileSchema>;

export function flowJsonSchema(): unknown {
  return z.toJSONSchema(flowSchema, { target: 'draft-2020-12' });
}
export function profileJsonSchema(): unknown {
  return z.toJSONSchema(profileSchema, { target: 'draft-2020-12' });
}
