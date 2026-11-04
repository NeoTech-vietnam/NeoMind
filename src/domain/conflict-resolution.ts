import { z } from 'zod';
export const conflictResolutionSchema = z.strictObject({ summary: z.string().min(1), resolutions: z.array(z.strictObject({
  path: z.string().min(1), action: z.enum(['edited', 'kept', 'deleted']), rationale: z.string().min(1),
})).min(1) });
export function validateConflictResolutions(text: string, conflicts: string[]) {
  const result = conflictResolutionSchema.parse(JSON.parse(text) as unknown);
  const paths = result.resolutions.map(item => item.path);
  if (paths.length !== new Set(paths).size || paths.length !== conflicts.length || conflicts.some(file => !paths.includes(file))) throw new Error('Resolution manifest must account for every conflict exactly once');
  return result;
}
