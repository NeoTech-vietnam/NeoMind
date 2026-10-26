import { posix } from 'node:path';
import type { ControlledContract, ControlledSnapshot } from './controlled-workflow.js';
import type { ProjectRecord } from './types.js';
import { evidenceRecordFingerprint } from './evidence-inputs.js';
import { latestControlledChecks, controlledCheckMatches } from './controlled-current-checks.js';

const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
function directory(value: string): string {
  if (!value || value === '.' || value !== posix.normalize(value) || value.startsWith('/') ||
      /[\\:\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)))
    throw new Error('Cornell destinations must be separate canonical project-relative directories.');
  return value;
}

/** A primary checked artifact cannot also be the post-verification knowledge artifact. */
export function controlledCornellDirectories(plan: Pick<ControlledContract['plan'], 'cornell_output_dir'>, knowledgeDirectory?: string) {
  const primary = plan.cornell_output_dir ? directory(plan.cornell_output_dir) : undefined;
  const knowledge = knowledgeDirectory ? directory(knowledgeDirectory) : undefined;
  if (primary && knowledge && key(primary) === key(knowledge))
    throw new Error('Primary Cornell and evidence-derived knowledge bundles require distinct destinations.');
  return { primary, knowledge };
}

/** Classify every tracked note; an unrelated or forged identity is never silently ignored. */
export function controlledCornellSelection(run: Pick<ControlledSnapshot, 'workflow_id' | 'cornell_note_ids'>,
  contract: Pick<ControlledContract, 'workflow_id' | 'plan' | 'knowledge_directory'>, recordAt: (id: string) => ProjectRecord) {
  if (run.workflow_id !== contract.workflow_id) throw new Error('Cornell selection requires the bound workflow.');
  const destinations = controlledCornellDirectories(contract.plan, contract.knowledge_directory);
  const primary: ProjectRecord[] = [], knowledge: ProjectRecord[] = [], ids = run.cornell_note_ids ?? [];
  if (new Set(ids).size !== ids.length) throw new Error('Tracked Cornell record identities must be unique.');
  for (const id of ids) {
    const note = recordAt(id), data = note.meta.data;
    if (note.meta.id !== id || note.meta.type !== 'knowledge' || data.format !== 'cornell-v1' || data.workflow_id !== contract.workflow_id ||
        note.meta.status === 'superseded')
      throw new Error('Tracked Cornell output is not a current same-workflow research record.');
    if (destinations.primary && data.artifact_path === `${destinations.primary}/note.md`) primary.push(note);
    else if (destinations.knowledge && data.artifact_path === `${destinations.knowledge}/note.md`) knowledge.push(note);
    else throw new Error('Tracked Cornell output is outside the declared primary and final knowledge bundles.');
  }
  if (primary.length > 1 || knowledge.length > 1)
    throw new Error('Multiple Cornell records claim one declared output bundle.');
  return { primary, knowledge };
}

export type ControlledKnowledgeReason = 'not-requested' | 'missing-bundle' | 'missing-verification' | 'stale-verification' |
  'incomplete-verification' | 'missing-generation' | 'changed-generation' | 'missing-current-evidence' | 'ready';

/** Routing checkpoint only. Acceptance still checks signed receipts, actual bytes
 * and evidence baselines. A stale bundle is not permission to overwrite edits:
 * the normal receipt-bound Cornell persistence guard remains authoritative. */
export function controlledKnowledgeFreshness(run: Pick<ControlledSnapshot,
  'workflow_id' | 'cornell_note_ids' | 'cornell_results' | 'attempts' | 'checks'>,
  contract: Pick<ControlledContract, 'workflow_id' | 'plan' | 'knowledge_directory'>,
  recordAt: (id: string) => ProjectRecord): { required: boolean; ready: boolean; reason: ControlledKnowledgeReason } {
  const selected = controlledCornellSelection(run, contract, recordAt);
  const result = (reason: ControlledKnowledgeReason) => ({ required: !!contract.knowledge_directory,
    ready: reason === 'not-requested' || reason === 'ready', reason });
  if (!contract.knowledge_directory) return result('not-requested');
  if (!selected.knowledge.length) return result('missing-bundle');
  const producerIndex = run.attempts.findLastIndex(attempt => attempt.stage === 'implementation' && attempt.purpose !== 'specialist');
  const verifierIndex = run.attempts.findLastIndex(attempt => attempt.stage === 'verification' && attempt.purpose !== 'specialist');
  if (verifierIndex < 0) return result('missing-verification');
  if (producerIndex < 0 || verifierIndex <= producerIndex) return result('stale-verification');
  const verifier = run.attempts[verifierIndex]!;
  if (verifier.state !== 'completed' || verifier.report?.outcome !== 'completed' || verifier.report.verdict !== 'pass')
    return result('incomplete-verification');
  const checks = latestControlledChecks(run.checks, verifier.id);
  const currentPositive: string[] = [];
  for (const planned of contract.plan.checks) {
    const expectations = [{ ...planned, negative: false }, ...(planned.negative_controls ?? []).map(check => ({ ...check, negative: true }))];
    for (const expected of expectations) {
      const check = checks.find(check => check.title === expected.title && controlledCheckMatches(check, expected));
      if (!check?.passed || check.cancelled || check.exit_code !== check.expected_exit_code || !check.evidence_id)
        return result('incomplete-verification');
      if (!check.negative) currentPositive.push(check.evidence_id);
    }
  }
  if (!currentPositive.length || checks.some(check => !check.passed || check.cancelled)) return result('incomplete-verification');
  const note = selected.knowledge[0]!, data = note.meta.data;
  const generated = run.cornell_results?.findLast(result => result.note_id === note.meta.id);
  if (!generated) return result('missing-generation');
  const research = data.research as { input_hash?: string } | undefined;
  const artifacts = data.artifact_hashes as Record<string, string> | undefined;
  if (generated.input_hash !== research?.input_hash || generated.record_fingerprint !== evidenceRecordFingerprint(note) || !artifacts ||
      Object.keys(artifacts).length !== Object.keys(generated.artifact_hashes).length ||
      Object.entries(generated.artifact_hashes).some(([path, hash]) => artifacts[path] !== hash))
    return result('changed-generation');
  const demonstration = data.demonstration as { evidence_ids?: unknown } | undefined;
  const evidenceIds = demonstration?.evidence_ids;
  if (!Array.isArray(evidenceIds) || currentPositive.some(id => !evidenceIds.includes(id)))
    return result('missing-current-evidence');
  return result('ready');
}
