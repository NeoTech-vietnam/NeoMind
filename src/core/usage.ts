import { z } from 'zod';
export const tokenUsageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(), cacheWriteInputTokens: z.number().int().nonnegative().default(0),
  reasoningOutputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() });
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
