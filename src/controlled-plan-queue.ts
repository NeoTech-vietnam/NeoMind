import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hash, safePath } from './storage.js';
import { readCheckReconciliations, unresolvedControlledChecks } from './controlled-check-reconciliation.js';
import type { ControlledPlan } from './controlled-tools.js';

export interface ControlledPlanConflict { workflow_id: string; paths: string[] }
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const overlaps = (left: string, right: string) => key(left) === key(right) || key(left).startsWith(`${key(right)}/`) || key(right).startsWith(`${key(left)}/`);
const readPaths = (plan: ControlledPlan) => [...new Set([...(plan.preservation_paths ?? []), ...(plan.input_paths ?? []),
  ...(plan.checks ?? []).flatMap(check => [...(check.baseline_paths ?? []), ...(check.negative_controls ?? []).flatMap(control => control.baseline_paths ?? [])]),
  ...(plan.execution_steps ?? []).flatMap(step => [...(step.input_paths ?? []), ...(step.command[1] === '--version' ? [] : [step.command[1]!])])])];
/** Only committed live writers reserve scope; unfrozen proposals cannot deadlock one another. */
export function controlledPlanConflicts(root: string, workflow: string, plan: ControlledPlan): ControlledPlanConflict[] {
  const directory = safePath(root, '.neomind/controlled/workflows');
  if (!existsSync(directory)) return [];
  const reads = readPaths(plan), candidateWrites = [...plan.allowed_paths, ...plan.verification_paths];
  const conflicts: ControlledPlanConflict[] = [];
  for (const name of readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const state = JSON.parse(readFileSync(safePath(root, `.neomind/controlled/workflows/${name}`), 'utf8'));
    const pendingDirect = state.local_executions?.some((operation: { state: string }) => operation.state !== 'completed');
    const pendingChecks = state.check_intents?.some((operation: { state: string }) => operation.state !== 'completed');
    const live = ['queued', 'running', 'waiting'].includes(state.status);
    if (state.workflow_id === workflow || !state.contract_hash || !live && !pendingDirect && !pendingChecks) continue;
    const bytes = readFileSync(safePath(root, `.neomind/controlled/workflows/${hash(state.workflow_id)}.${state.epoch_id}.contract.json`));
    if (hash(bytes) !== state.contract_hash) throw new Error('A live writer contract changed while admitting a plan.');
    const contract = JSON.parse(bytes.toString('utf8'));
    if (contract.workflow_id !== state.workflow_id || contract.epoch_id !== state.epoch_id || contract.plan_hash !== hash(JSON.stringify(contract.plan)))
      throw new Error('A live writer has an invalid immutable scope contract.');
    const pendingEffects = pendingDirect || pendingChecks &&
      unresolvedControlledChecks(state, readCheckReconciliations(root, state, contract)).length > 0;
    if (state.phase === 'completed' && !pendingEffects || !live && !pendingEffects) continue;
    const writes = [...contract.plan.allowed_paths, ...contract.plan.verification_paths, ...(contract.knowledge_directory ? [contract.knowledge_directory] : [])];
    const otherReads = readPaths(contract.plan);
    const paths = [...new Set([...reads.filter(path => writes.some(scope => overlaps(path, scope))),
      ...candidateWrites.filter(path => otherReads.some(scope => overlaps(path, scope)))])];
    if (paths.length) conflicts.push({ workflow_id: state.workflow_id, paths });
  }
  return conflicts.sort((left, right) => left.workflow_id.localeCompare(right.workflow_id));
}
