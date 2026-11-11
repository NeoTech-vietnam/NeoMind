import { z } from 'zod';
import { memorySelectionSchema } from '../domain/schema.js';

export const runtimeContextSchema = z.strictObject({
  workspaceMode: z.enum(['isolated', 'current', 'shared']).optional(),
  codexSandbox: z.enum(['enabled', 'disabled']).optional(),
  initialIndexTree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  projectRoot: z.string().min(1), workspace: z.string().min(1), task: z.string().min(1),
  sourceHead: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), initialBaselineHash: z.string().min(1),
  lease: z.strictObject({ workspace: z.string().min(1), runId: z.string().min(1), hostId: z.string().min(1), fence: z.number().int().positive() }),
  memory: z.strictObject({ excluded: z.array(z.strictObject({ id: z.string(), reason: z.string() })).optional(), root: z.string().min(1), text: z.string().max(40000),
    selectionPolicy: memorySelectionSchema.optional(), inferredPaths: z.array(z.string().min(1)).optional(), records: z.array(z.strictObject({ id: z.string().min(1), type: z.enum(['context', 'decision', 'lesson']), scope: z.string().min(1),
      revision: z.string().min(1), sources: z.array(z.string()), selectionReason: z.string().min(1),
      // The record's own prompt block and tags (runs created before per-step memory lack them and keep the shared block).
      tags: z.array(z.string()).optional(), text: z.string().max(40000).optional() })).max(30).optional() }).optional(),
  /** The user's uncommitted changes copied in before the run: input to the run, never part of its commit by default. */
  /** The program phase this run executes; status is derived from runs, never stored in the program file. */
  programId: z.string().min(1).optional(), phaseId: z.string().min(1).optional(),
  /** Project rules pinned at creation; every agent must follow them and every review judges them. */
  rules: z.strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/), rules: z.array(z.strictObject({ id: z.string().min(1).max(32), text: z.string().min(1).max(2000) })).max(100) }).optional(),
  imported: z.strictObject({ sourceBaselineHash: z.string().min(1), tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), paths: z.array(z.string().min(1)).min(1) }).optional(),
});
export const runtimeStateSchema = z.strictObject({
  phase: z.enum(['running', 'waiting_approval', 'paused', 'blocked', 'completed', 'cancelled', 'recovering', 'stopping']),
  reason: z.string(), activeMs: z.number().int().nonnegative(),
  sessions: z.record(z.string(), z.string().min(1)),
  /** Active time when the open writer+review round began, and the active time the last finished round took. */
  roundStartMs: z.number().int().nonnegative().optional(), lastRoundMs: z.number().int().nonnegative().optional(),
});
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export const runtimeArtifactSchema = z.strictObject({ nodeId: z.string().min(1), kind: z.enum(['agent', 'check', 'summary']), text: z.string().max(100000), attemptId: z.string().min(1).optional(), baselineHash: z.string().min(1).optional() });
export type RuntimeArtifact = z.infer<typeof runtimeArtifactSchema>;
