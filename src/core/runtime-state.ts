import { z } from 'zod';

export const runtimeContextSchema = z.strictObject({
  projectRoot: z.string().min(1), workspace: z.string().min(1), task: z.string().min(1),
  sourceHead: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), initialBaselineHash: z.string().min(1),
  lease: z.strictObject({ workspace: z.string().min(1), runId: z.string().min(1), hostId: z.string().min(1), fence: z.number().int().positive() }),
  memory: z.strictObject({ root: z.string().min(1), text: z.string().max(40000) }).optional(),
});
export const runtimeStateSchema = z.strictObject({
  phase: z.enum(['running', 'waiting_approval', 'paused', 'blocked', 'completed', 'cancelled', 'recovering', 'stopping']),
  reason: z.string(), activeMs: z.number().int().nonnegative(),
  sessions: z.record(z.string(), z.string().min(1)),
});
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export const runtimeArtifactSchema = z.strictObject({ nodeId: z.string().min(1), kind: z.enum(['agent', 'check', 'summary']), text: z.string().max(100000), attemptId: z.string().min(1).optional(), baselineHash: z.string().min(1).optional() });
export type RuntimeArtifact = z.infer<typeof runtimeArtifactSchema>;
