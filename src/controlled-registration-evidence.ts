import { lstatSync, readFileSync } from 'node:fs';
import { hash } from './storage.js';
import { canonicalJson } from './routing.js';
import { resolveProcedure, validateProcedurePath, type ProcedureManifest } from './procedures.js';
import type { ControlledContract, ControlledSnapshot } from './controlled-workflow.js';

/** A current registry observation, not a signed execution receipt or a qualification decision. */
export function controlledRegistrationEvidence(root: string, run: ControlledSnapshot, contract?: ControlledContract) {
  const unavailable = (reason: string) => ({ kind: 'registration' as const, registered: false, reason,
    qualification: 'Not established by registration evidence.' });
  const expected = contract?.plan.procedure_candidate;
  if (!expected) return unavailable('NO_PLANNED_CANDIDATE');
  if (contract.workflow_id !== run.workflow_id || contract.epoch_id !== run.epoch_id)
    return unavailable('CONTRACT_BINDING_MISMATCH');
  if (!run.procedure_candidate_id || !run.procedure_candidate_version) return unavailable('CANDIDATE_NOT_REGISTERED');
  if (run.procedure_candidate_id !== `workflow-${hash(run.workflow_id).slice(0, 24)}`)
    return unavailable('CANDIDATE_BINDING_MISMATCH');
  const producer = run.attempts.findLast(attempt => attempt.stage === 'implementation');
  if (!producer?.invocation_id || producer.state !== 'completed' || producer.report?.outcome !== 'completed')
    return unavailable('COMPLETED_PRODUCER_REQUIRED');
  let manifest: ProcedureManifest;
  try { manifest = resolveProcedure(root, run.procedure_candidate_id, run.procedure_candidate_version); }
  catch { return unavailable('REGISTERED_MANIFEST_UNAVAILABLE'); }
  if (!['candidate', 'reviewed', 'eligible', 'suspended'].includes(manifest.status) ||
      typeof manifest.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.created_at) ||
      !Number.isFinite(Date.parse(manifest.created_at))) return unavailable('REGISTERED_METADATA_INVALID');
  if (manifest.author !== producer.invocation_id) return unavailable('REGISTERED_AUTHOR_MISMATCH');
  const { id, version, author, schema_version, script_sha256, verification_sha256, dependency_sha256,
    contract_hash, created_at, status, reason, reviews, runs, ...definition } = manifest;
  if (canonicalJson(definition) !== canonicalJson(expected)) return unavailable('REGISTERED_PLAN_MISMATCH');
  const currentHash = (path: string): string | null => {
    try {
      const full = validateProcedurePath(root, path), info = lstatSync(full);
      return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 2 * 1024 * 1024 ? hash(readFileSync(full)) : null;
    } catch { return null; }
  };
  const artifact = (path: string, registered_sha256: string) => {
    const current_sha256 = currentHash(path);
    return { path, registered_sha256, current_sha256, matches: current_sha256 === registered_sha256 };
  };
  const script = artifact(manifest.script, script_sha256), checker = artifact(manifest.verification_script, verification_sha256);
  const dependencies = manifest.dependencies.map(path => artifact(path, dependency_sha256[path]!));
  // Open manifest dictionaries may contain credentials even when schema-valid.
  // Compare them privately above; publish typed rules/counts, never raw values.
  const parameterEntries = Object.entries(manifest.parameters);
  const parameters = Object.fromEntries(parameterEntries.slice(0, 64).map(([name, rule]) => [name, {
    type: rule.type, required: rule.required !== false, path: rule.path ?? false,
    ...(rule.min !== undefined ? { min: rule.min } : {}), ...(rule.max !== undefined ? { max: rule.max } : {}),
    default_present: rule.default !== undefined, enum_count: rule.enum?.length ?? 0, pattern_present: rule.pattern !== undefined,
  }]));
  const environment = {
    platforms: [...new Set(manifest.environment.platforms)], clients: [...new Set(manifest.environment.clients)],
    ...(manifest.environment.node_major_min !== undefined ? { node_major_min: manifest.environment.node_major_min } : {}),
    arch_constraint_count: manifest.environment.archs?.length ?? 0, mode_constraint_count: manifest.environment.modes?.length ?? 0,
    assurance_constraint_count: manifest.environment.assurance?.length ?? 0,
    tool_requirement_count: Object.keys(manifest.environment.tools ?? {}).length,
  };
  return {
    kind: 'registration' as const, registered: true,
    workflow_id: run.workflow_id, task_id: contract.task_id,
    id, version, created_at, contract_hash, status,
    author_matches_latest_producer: true, immutable_plan_matches: true,
    current_code_matches: [script, checker, ...dependencies].every(item => item.matches),
    script, verification_script: checker, dependencies,
    parameters, parameter_count: parameterEntries.length, parameter_rules_truncated: parameterEntries.length > 64,
    outputs: manifest.outputs, environment,
    effects: manifest.effects, timeout_ms: manifest.timeout_ms, max_output_bytes: manifest.max_output_bytes,
    history_counts: { reviews: reviews.length, runs: runs.length,
      local_process_successes: runs.filter(item => item.status === 'succeeded' && item.observation === 'local-process').length,
      fixture_runs: runs.filter(item => item.observation === 'fixture').length },
    qualification: 'Registration is not independent review, successful representative reuse, or qualification. This observation does not qualify or execute the candidate.',
  };
}
