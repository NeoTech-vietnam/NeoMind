import { createHash } from 'node:crypto';
import { z } from 'zod';
export const dataSourceSchema = z.strictObject({ kind: z.enum(['task', 'memory', 'plan', 'artifact', 'check', 'code']),
  id: z.string().min(1), fromNodeId: z.string().min(1).optional(), hash: z.string().min(1) });
export const nodeInputSchema = z.strictObject({ nodeId: z.string().min(1), attemptId: z.string().min(1), workspace: z.string().min(1),
  prompt: z.string().max(1000000), promptHash: z.string().regex(/^[a-f0-9]{64}$/), truncated: z.boolean(), sources: z.array(dataSourceSchema) });
export const nodeOutputSchema = z.strictObject({ attemptId: z.string().min(1), threadId: z.string().min(1), turnId: z.string().min(1),
  messages: z.array(z.string()).max(10000), outputHash: z.string().regex(/^[a-f0-9]{64}$/), truncated: z.boolean() });
export type NodeData = z.infer<typeof nodeInputSchema> & { output?: z.infer<typeof nodeOutputSchema> };
export const textHash = (value: string) => createHash('sha256').update(value).digest('hex');
