import { z } from 'zod';
import type { ControlledReport } from './controlled-tools.js';

export const controlledFailureKinds = ['implementation', 'checker', 'protocol', 'environment', 'unknown'] as const;
type FailureKind = typeof controlledFailureKinds[number];
export interface ControlledDiagnosisClassification {
  failure_kind: FailureKind; source: 'explicit-field' | 'anchored-finding'; index?: number;
}
export class ControlledReportClassificationError extends Error {
  readonly code = 'DIAGNOSIS_CLASSIFICATION_INVALID';
}
const known = (value: unknown): value is FailureKind => typeof value === 'string' && controlledFailureKinds.includes(value as FailureKind);
const marker = /^\s*failure_kind:\s*(implementation|checker|protocol|environment|unknown)(?:\.(?:\s|$)|$)/;

/** Read-only interpretation of a professional enum. Never infer from summary prose, substrings or an error message. */
export function classifyControlledDiagnosisReport(value: unknown): ControlledDiagnosisClassification | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>, explicit = report.failure_kind;
  if (explicit !== undefined && !known(explicit))
    throw new ControlledReportClassificationError('Diagnosis failure_kind must use the declared professional classification enum.');
  let inferred: FailureKind | undefined, index: number | undefined;
  if (Array.isArray(report.findings)) for (const [at, finding] of report.findings.entries()) {
    if (typeof finding !== 'string' || !/^\s*failure_kind:/.test(finding)) continue;
    const match = marker.exec(finding), kind = match?.[1];
    if (!known(kind)) throw new ControlledReportClassificationError('An anchored diagnosis marker must use failure_kind: followed by one declared enum and a period or end of finding.');
    if (inferred !== undefined && inferred !== kind || explicit !== undefined && explicit !== kind)
      throw new ControlledReportClassificationError('Diagnosis classification fields and anchored findings conflict; preserve the report for explicit clarification.');
    inferred = kind; index ??= at;
  }
  if (known(explicit)) return { failure_kind: explicit, source: 'explicit-field' };
  return inferred === undefined ? undefined : { failure_kind: inferred, source: 'anchored-finding', index };
}

/** Live canonicalization is bound by the backend role/stage, never selected by model arguments. */
export function controlledReportSubmissionSchema(schema: z.ZodType<ControlledReport>, options: {
  requiresVerdict: boolean; requiresFailureKind: boolean;
}): z.ZodType<ControlledReport> {
  const required = schema.superRefine((report, context) => {
    if (report.outcome === 'completed' && options.requiresVerdict && report.verdict === undefined)
      context.addIssue({ code: 'custom', path: ['verdict'], message: 'A completed verification or review result requires an explicit verdict pass or fail. Blocked or failed findings may omit verdict.' });
    if (report.outcome === 'completed' && options.requiresFailureKind && report.failure_kind === undefined)
      context.addIssue({ code: 'custom', path: ['failure_kind'], message: 'A completed manager diagnosis requires failure_kind: implementation, checker, protocol, environment or unknown. Blocked or failed findings may omit the classification.' });
  });
  if (!options.requiresFailureKind) return required;
  return z.preprocess((value, context) => {
    // Incomplete findings are durable partial work, not a classification decision.
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).outcome !== 'completed') return value;
    try {
      const classification = classifyControlledDiagnosisReport(value);
      if (classification?.source === 'anchored-finding') return { ...(value as Record<string, unknown>), failure_kind: classification.failure_kind };
      return value;
    } catch (error) {
      context.addIssue({ code: 'custom', path: ['failure_kind'], message: error instanceof ControlledReportClassificationError
        ? error.message : 'The backend could not read an unambiguous diagnosis classification.' });
      return z.NEVER;
    }
  }, required);
}
