import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ReviewAssessment } from './review.js';
import { createHash } from 'node:crypto';

const sourceReference = z.strictObject({ kind: z.literal('source'), path: z.string().min(1), line: z.number().int().positive(), quote: z.string().min(1).max(2000) });
const checkReference = z.strictObject({ kind: z.literal('check'), command: z.string().min(1), outputHash: z.string().regex(/^[a-f0-9]{64}$/) });
const artifactReference = z.strictObject({ kind: z.literal('artifact'), nodeId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), quote: z.string().min(1).max(2000) });
// Structured output supports anyOf; discriminatedUnion emits unsupported oneOf.
const reference = z.union([sourceReference, checkReference, artifactReference]);
export const reviewEvidenceSchema = z.strictObject({
  criteria: z.array(z.strictObject({ criterion: z.string().min(1), status: z.enum(['pass', 'fail', 'blocked']), references: z.array(reference) })),
  findings: z.array(z.strictObject({ id: z.string().min(1), criterion: z.string().min(1), explanation: z.string().min(1), references: z.array(reference).min(1) })),
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

/** Verify references and coverage mechanically; the independent reviewer supplies the semantic judgment. */
export async function assessReviewEvidence(input: {
  workspace: string; criteria: string[]; evidence: ReviewEvidence | undefined; findingIds: string[];
  baselineHash: string; checks: { command: string; baselineHash: string; status: string; outputHash?: string }[];
  artifacts?: { nodeId: string; text: string }[];
}): Promise<ReviewAssessment> {
  const invalid: ReviewAssessment = { evidenceValidated: false, criteriaCovered: false, verifiedFindingIds: [], unresolvedDisagreement: false, mandatoryCriteriaFailed: false };
  if (!input.evidence) return invalid;
  const evidence = reviewEvidenceSchema.parse(input.evidence), root = await realpath(input.workspace);
  const expected = [...new Set(input.criteria)];
  if (new Set(evidence.criteria.map(item => item.criterion)).size !== evidence.criteria.length ||
      new Set(evidence.findings.map(item => item.id)).size !== evidence.findings.length) return invalid;
  async function valid(ref: z.infer<typeof reference>): Promise<boolean> {
    if (ref.kind === 'artifact') return input.artifacts?.some(artifact => artifact.nodeId === ref.nodeId && createHash('sha256').update(artifact.text).digest('hex') === ref.sha256 && artifact.text.includes(ref.quote)) ?? false;
    if (ref.kind === 'check') return input.checks.some(check => check.command === ref.command && check.baselineHash === input.baselineHash && ['passed', 'failed'].includes(check.status) && check.outputHash === ref.outputHash);
    if (path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.split('/').includes('..')) return false;
    try {
      const file = await realpath(path.join(root, ref.path)), relative = path.relative(root, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      const info = await stat(file);
      if (!info.isFile() || info.size > 1024 * 1024) return false;
      const lines = (await readFile(file, 'utf8')).split('\n');
      return lines.slice(ref.line - 1, ref.line - 1 + ref.quote.split('\n').length).join('\n') === ref.quote;
    } catch { return false; }
  }
  const criteriaCovered = expected.every(criterion => evidence.criteria.some(item => item.criterion === criterion));
  let evidenceValidated = criteriaCovered;
  for (const item of evidence.criteria) {
    if (!expected.includes(item.criterion) || item.status === 'blocked' || !item.references.length || !(await Promise.all(item.references.map(valid))).every(Boolean)) evidenceValidated = false;
    if (item.status === 'pass' && item.references.some(ref => ref.kind === 'check' && !input.checks.some(check => check.command === ref.command && check.outputHash === ref.outputHash && check.status === 'passed'))) evidenceValidated = false;
  }
  const verifiedFindingIds: string[] = [];
  for (const finding of evidence.findings) {
    const failed = evidence.criteria.some(item => item.criterion === finding.criterion && item.status === 'fail');
    if (failed && input.findingIds.includes(finding.id) && (await Promise.all(finding.references.map(valid))).every(Boolean)) verifiedFindingIds.push(finding.id);
    else evidenceValidated = false;
  }
  if (input.findingIds.some(id => !verifiedFindingIds.includes(id))) evidenceValidated = false;
  return { evidenceValidated, criteriaCovered, verifiedFindingIds, unresolvedDisagreement: false,
    mandatoryCriteriaFailed: evidence.criteria.some(item => expected.includes(item.criterion) && item.status === 'fail') };
}
