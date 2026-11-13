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
/**
 * Which pinned memory one agent step receives (types, tags, how many records, or none). Omitted: the flow's
 * `memoryDefaults` decides (role defaults for flows created from templates, the shared block for older flows).
 */
export const stepMemorySchema = z.strictObject({ types: z.array(z.enum(['context', 'decision', 'lesson'])).min(1).optional(),
  tags: z.array(z.string().min(1)).optional(), maxRecords: z.number().int().min(0).max(30).optional(), off: z.boolean().optional() });
const reviewer = z.strictObject({
  id, profileId: id, profileVersion: z.number().int().min(1), sessionGroup: id, required: z.boolean(),
  scope: z.array(z.string().min(1)).min(1), instructionsOverride: z.string().optional(), skillsOverride: z.array(skillReferenceSchema).optional(),
  memory: stepMemorySchema.optional(),
});

export const nodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('start') }),
  z.strictObject({ ...base, type: z.literal('finish') }),
  // `auto`: NeoMind approves the plan itself (a flow exception the project policy can forbid).
  z.strictObject({ ...base, type: z.literal('approval'), purpose: z.string().min(1), mode: z.enum(['user', 'auto']).optional() }),
  z.strictObject({ ...base, type: z.literal('fork') }),
  z.strictObject({ ...base, type: z.literal('join'), requiredBranches: z.array(id).min(1) }),
  z.strictObject({ ...base, type: z.literal('condition'), field: z.string().min(1), operator: z.enum(['eq', 'ne', 'in', 'exists', 'all', 'any']), value: z.json().optional() }),
  // Agent fields are optional in the schema; executors that resolve conflicts or repairs require them.
  z.strictObject({ ...base, type: z.literal('integration'), writeScopes: z.array(z.string().min(1)).min(1),
    profileId: id.optional(), profileVersion: z.number().int().min(1).optional(), sessionGroup: id.optional(), bindingId: id.optional(),
    instructionsOverride: z.string().optional(), skillsOverride: z.array(skillReferenceSchema).optional(), memory: stepMemorySchema.optional() }),
  z.strictObject({ ...base, type: z.literal('git_commit') }),
  z.strictObject({ ...base, type: z.literal('agent_task'), goal: z.string().min(1), profileId: id, profileVersion: z.number().int().min(1),
    sessionGroup: id, bindingId: id, permissions: permissionsSchema,
    writeScopes: z.array(z.string().min(1)), outputContract: z.string().min(1),
    instructionsOverride: z.string().optional(), skillsOverride: z.array(skillReferenceSchema).optional(), memory: stepMemorySchema.optional() }),
  z.strictObject({ ...base, type: z.literal('review_group'), targetNodeId: id,
    reviewers: z.array(reviewer).min(1), criteria: z.array(z.string().min(1)).min(1), checks: z.array(z.string().min(1)).optional(),
    // Each numbered step of the approved plan's approach becomes a required criterion; omitted keeps older flows' reviews unchanged.
    planStepCriteria: z.boolean().optional() }),
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
    maxRepairRounds: z.number().int().min(0), activeTimeSeconds: z.number().int().min(1),
    // Total tokens the run may use before it pauses for the user, checked between steps; omitted means no token budget.
    maxTokens: z.number().int().min(1).optional() }),
  workspacePolicy: z.enum(['isolated', 'current', 'shared']),
  outputContract: z.string().min(1),
  // Explicit opt-in for OpenCode's web search and fetch tools; omitted leaves web access disabled.
  webAccess: z.boolean().optional(),
  // `human`: the user reviews the changes outside the flow, so the flow has no review gate and never commits.
  review: z.enum(['independent', 'human']).optional(),
  // `role`: a step without its own `memory` gets its role's default (plan/write: everything, review: decisions and lessons).
  // Omitted (`shared`) keeps older flows' behaviour: every step receives the run's whole memory block.
  memoryDefaults: z.enum(['shared', 'role']).optional(),
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
  maxActiveTimeSeconds: z.number().int().positive().optional(),
  // Exceptions require explicit opt-in when the corresponding project gate is required.
  allowAutoApproval: z.boolean().optional(), allowHumanReview: z.boolean().optional(),
  codexSandbox: z.enum(['enabled', 'disabled']).optional(),
  // Keep a run's worktrees after it delivered (commit or applied changes) instead of removing them; omitted means remove.
  keepRunWorktrees: z.boolean().optional(),
});

export const memorySelectionSchema = z.strictObject({
  scopes: z.array(z.string().min(1)).optional(), tags: z.array(z.string().min(1)).optional(),
  retrievalMode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
  requireTaskMatch: z.boolean().optional(), inferTaskPaths: z.boolean().optional(), maxRecords: z.number().int().min(0).max(30).optional(),
  maxBodyBytes: z.number().int().min(0).max(16000).optional(),
});

export const projectSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, policyVersion: z.number().int().min(1),
  policy: projectPolicySchema,
  memorySelection: memorySelectionSchema.optional(),
  ai: z.strictObject({ flowPublish: z.enum(['allow', 'draft-only', 'deny']).optional(), profilePublish: z.enum(['allow', 'draft-only', 'deny']).optional(),
    // Whether session tools may create, edit or delete neomind/skills; omitted means allow.
    skillEdit: z.enum(['allow', 'deny']).optional() }).optional(),
  roleDefaults: z.record(id, z.strictObject({ runner: z.string().min(1), provider: z.string().min(1),
    model: z.string().min(1), reasoning: z.string().min(1) })),
});

export type Flow = z.infer<typeof flowSchema>;
export type FlowNode = z.infer<typeof nodeSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;
export type Profile = z.infer<typeof profileSchema>;
export type StepMemory = z.infer<typeof stepMemorySchema>;

export function flowJsonSchema(): unknown {
  return z.toJSONSchema(flowSchema, { target: 'draft-2020-12' });
}
export function profileJsonSchema(): unknown {
  return z.toJSONSchema(profileSchema, { target: 'draft-2020-12' });
}
