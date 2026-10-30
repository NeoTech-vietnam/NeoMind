import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ReviewAssessment } from './review.js';
import { createHash } from 'node:crypto';

const sourceReference = z.strictObject({ kind: z.literal('source'), path: z.string().min(1), line: z.number().int().positive(), quote: z.string().min(1).max(2000) });
const checkReference = z.strictObject({ kind: z.literal('check'), command: z.string().min(1), outputHash: z.string().regex(/^[a-f0-9]{64}$/) });
/** Models miscopy 64-character hashes; a short core-issued receipt ID proves the same thing: the receipt came from core. */
const checkReceiptReference = z.strictObject({ kind: z.literal('check'), command: z.string().min(1), receiptId: z.string().regex(/^[a-f0-9]{12}$/) });
const artifactReference = z.strictObject({ kind: z.literal('artifact'), nodeId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), quote: z.string().min(1).max(2000) });
// Structured output supports anyOf; discriminatedUnion emits unsupported oneOf.
const reference = z.union([sourceReference, checkReceiptReference, checkReference, artifactReference]);
/** The receipt ID shown to reviewers for a core check receipt. */
export const checkReceiptId = (outputHash: string) => outputHash.slice(0, 12);
function citesReceipt(ref: z.infer<typeof checkReference> | z.infer<typeof checkReceiptReference>, check: { command: string; outputHash?: string }): boolean {
  if (check.command !== ref.command || !check.outputHash) return false;
  return 'receiptId' in ref ? checkReceiptId(check.outputHash) === ref.receiptId : check.outputHash === ref.outputHash;
}
export const reviewEvidenceSchema = z.strictObject({
  criteria: z.array(z.strictObject({ criterion: z.string().min(1), status: z.enum(['pass', 'fail', 'blocked']), references: z.array(reference) })),
  findings: z.array(z.strictObject({ id: z.string().min(1), criterion: z.string().min(1), explanation: z.string().min(1), references: z.array(reference).min(1) })),
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

type Reference = z.infer<typeof reference>;
type ReferenceContext = { baselineHash: string; checks: { command: string; baselineHash: string; status: string; outputHash?: string }[]; artifacts?: { nodeId: string; text: string }[] };

/** Why a reference does not hold against the current workspace and receipts, or undefined when it does. */
async function referenceProblem(ref: Reference, root: string, input: ReferenceContext): Promise<string | undefined> {
  if (ref.kind === 'artifact') return input.artifacts?.some(artifact => artifact.nodeId === ref.nodeId && createHash('sha256').update(artifact.text).digest('hex') === ref.sha256 && artifact.text.includes(ref.quote)) ? undefined : 'no supplied artifact has this nodeId, sha256 and quote';
  if (ref.kind === 'check') return input.checks.some(check => citesReceipt(ref, check) && check.baselineHash === input.baselineHash && ['passed', 'failed'].includes(check.status)) ? undefined : 'command and receiptId do not match a supplied receipt for this baseline';
  if (path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.split('/').includes('..')) return 'path must be workspace-relative with forward slashes';
  try {
    const file = await realpath(path.join(root, ref.path)), relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'path resolves outside the workspace';
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return 'path is not a readable source file';
    // CRLF checkouts (Git autocrlf on Windows) must cite the same lines as LF checkouts.
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/), quote = ref.quote.split(/\r?\n/);
    const at = (line: number) => lines.slice(line - 1, line - 1 + quote.length).join('\n') === quote.join('\n');
    if (at(ref.line)) return undefined;
    const found = lines.findIndex((_line, index) => at(index + 1));
    return found >= 0 ? `quote is not at line ${ref.line}; it starts at line ${found + 1}` : `quote does not appear verbatim in ${ref.path}`;
  } catch { return 'path does not exist in the workspace'; }
}

/** Human- and model-readable reasons for each rejected reference, used to guide a single validation retry. */
export async function referenceProblems(input: ReferenceContext & { workspace: string; evidence: ReviewEvidence | undefined }): Promise<string[]> {
  const parsed = reviewEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) return ['evidence does not match the required schema'];
  const root = await realpath(input.workspace), problems: string[] = [];
  const references = [...parsed.data.criteria.map(item => ({ owner: `criterion "${item.criterion}"`, references: item.references })),
    ...parsed.data.findings.map(item => ({ owner: `finding ${item.id}`, references: item.references }))];
  for (const { owner, references: refs } of references) for (const ref of refs) {
    const problem = await referenceProblem(ref, root, input);
    if (problem) problems.push(`${owner}: ${JSON.stringify(ref)}: ${problem}`);
  }
  return problems;
}

/** Structural reasons `assessReviewEvidence` rejects evidence whose references are all valid, phrased for a validation retry. */
export function structureProblems(evidence: ReviewEvidence | undefined, findingIds: string[]): string[] {
  const parsed = reviewEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return [];
  const problems: string[] = [], status = new Map(parsed.data.criteria.map(item => [item.criterion, item.status]));
  for (const item of parsed.data.criteria) if (item.status === 'blocked') problems.push(`criterion "${item.criterion}" is blocked; decide pass or fail from the supplied source, diff and receipts`);
  for (const finding of parsed.data.findings) {
    if (status.get(finding.criterion) !== 'fail') problems.push(`finding ${finding.id} is attached to criterion "${finding.criterion}", which is not failed; findings are only for failed criteria, so drop it or fail that criterion`);
    if (!findingIds.includes(finding.id)) problems.push(`finding ${finding.id} is missing from findingIds`);
  }
  for (const id of findingIds) if (!parsed.data.findings.some(finding => finding.id === id)) problems.push(`findingIds lists ${id} without a matching finding`);
  return problems;
}

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
  const valid = async (ref: Reference) => !await referenceProblem(ref, root, input);
  const criteriaCovered = expected.every(criterion => evidence.criteria.some(item => item.criterion === criterion));
  let evidenceValidated = criteriaCovered;
  for (const item of evidence.criteria) {
    if (!expected.includes(item.criterion) || item.status === 'blocked' || !item.references.length || !(await Promise.all(item.references.map(valid))).every(Boolean)) evidenceValidated = false;
    if (item.status === 'pass' && item.references.some(ref => ref.kind === 'check' && !input.checks.some(check => citesReceipt(ref, check) && check.status === 'passed'))) evidenceValidated = false;
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
