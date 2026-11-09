import { dirname } from 'node:path';
import { z } from 'zod';
import { nativeRequestOpenSchema, nativeSpecialists } from './native-local-contract.js';
import { normalizeNativeProjectPaths } from './native-project-paths.js';
import { findRequestExperiences } from './request-experience.js';
import { prepareWork } from './procedure-reuse.js';
import { loadRecords, hash } from './storage.js';
import { resolveProcedure } from './procedures.js';
import { findAgentCapabilityCandidates } from './agent-capability-cache.js';
import { listWorkspaceSkillComponents } from './workspace-skill-components.js';

export const nativeWorkPrepareSchema = nativeRequestOpenSchema.pick({ requirement: true }).extend({
  role: z.enum(nativeSpecialists).describe('Optional professional role for advisory capability matching; this does not assign or invoke an agent.').optional(),
  task_family: z.string().trim().min(1).max(200).optional(),
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.union([z.string(), z.number().finite(), z.boolean()])).default({}),
  outputs: z.array(z.string().trim().min(1).max(1024)).max(100).default([]),
});
export const nativeWorkPrepareJsonSchema = z.toJSONSchema(nativeWorkPrepareSchema, { io: 'input', target: 'draft-7' });

const historicalSkillNames = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1).max(8)
  .refine(names => new Set(names).size === names.length);
const historicalCapabilitySchema = z.object({
  schema_version: z.literal(1),
  role_skills: z.partialRecord(z.enum(nativeSpecialists), historicalSkillNames)
    .refine(roles => Object.keys(roles).length > 0),
});
/** The accepted record hash is checked before this compact projection. Old
 * choices are advice only: current receipt/hash checks still own selection. */
function historicalCapabilityPlan(value: unknown) {
  const parsed = historicalCapabilitySchema.safeParse(value);
  return parsed.success ? { role_skills: parsed.data.role_skills, source: 'accepted-request-history' as const,
    current_eligibility: 'not-evaluated' as const, loaded: 'not-observed' as const,
    used: 'not-observed' as const, verified: 'not-observed' as const } : undefined;
}

function capabilityDiscovery(root: string, request: string, role?: z.infer<typeof nativeWorkPrepareSchema>['role']): ReturnType<typeof findAgentCapabilityCandidates> {
  try { return findAgentCapabilityCandidates(root, { request, ...(role ? { role } : {}), limit: 3 }); }
  catch { return { state: 'unavailable', candidates: [], issues: [{ code: 'CACHE_UNAVAILABLE' }],
    fallback: 'ordinary-work', authorization: 'not-granted', results_truncated: false }; }
}

function installedSkills(root: string, request: string): ReturnType<typeof listWorkspaceSkillComponents> {
  try { return listWorkspaceSkillComponents(root, { request, limit: 3 }); }
  catch { return { state: 'unavailable', components: [], issues: [{ code: 'READ_FAILED' }], results_truncated: false,
    fallback: 'ordinary-work', authorization: 'not-granted', execution: 'not-performed' }; }
}

/** Advisory retrieval only: text similarity is never execution authority. The
 * exact procedure eligibility checks remain in the existing registry/runner. */
export function prepareNativeWork(root: string, input: z.input<typeof nativeWorkPrepareSchema>) {
  const parsed = nativeWorkPrepareSchema.parse(input);
  const outputs = normalizeNativeProjectPaths(root, parsed.outputs);
  // Local pinned metadata is advisory, separate from qualified procedure
  // eligibility. Discovery never downloads, installs, grants tools or calls a model.
  const capability_discovery = capabilityDiscovery(root, parsed.requirement, parsed.role);
  const installed_skill_components = installedSkills(root, parsed.requirement);
  const history = findRequestExperiences(root, { request: parsed.requirement, task_family: parsed.task_family, limit: 5 });
  // This synchronous advisory operation needs one fresh source snapshot, not
  // two whole-project scans per candidate. Never reuse it across operations or
  // as execution/acceptance authority. Missing source data simply drops advice.
  let historyRecords: Map<string, ReturnType<typeof loadRecords>[number]> | undefined;
  if (history.candidates.length) {
    try { historyRecords = new Map(loadRecords(root).map(record => [record.meta.id, record])); }
    catch { /* Optional history remains unavailable; ordinary work continues. */ }
  }
  const matches = history.candidates.flatMap(candidate => {
    try {
      const record = historyRecords?.get(candidate.acceptance.record_id), request = historyRecords?.get(candidate.workflow_id);
      if (!request || !record || request.meta.status !== 'accepted' || record.meta.status !== 'accepted' || record.meta.revision !== candidate.acceptance.revision ||
          hash(JSON.stringify({ meta: record.meta, body: record.body })) !== candidate.record_snapshot_sha256) return [];
      const capability_plan = historicalCapabilityPlan(record.meta.data.native_capability_plan);
      return [{ request_key: candidate.request_key, task_family: candidate.task_family, summary: candidate.summary.slice(0, 800),
        artifact_paths: candidate.artifact_paths.slice(0, 12), procedures: candidate.procedures,
        ...(capability_plan ? { capability_plan } : {}) }];
    } catch { return []; }
  });
  try {
    const allowed = [...new Set(outputs.map(path => dirname(path).replaceAll('\\', '/') === '.' ? path : dirname(path).replaceAll('\\', '/')))];
    const applicability = { request: parsed.requirement, intent_id: parsed.task_family,
      parameters: parsed.parameters, outputs, environment: { client: 'copilot', platform: process.platform, arch: process.arch, node: process.versions.node },
      scope: { allowed_paths: allowed, network: false, publication: false, mode: 'vscode-native', assurance: 'observed-native-local' } };
    const prepared = prepareWork(root, applicability);
    const strategy = prepared.decision === 'exact' ? 'qualified-procedure' as const : prepared.decision === 'adapt' ? 'adapt' as const : 'ordinary' as const;
    // A new companion product need not make the worker regenerate an already
    // qualified format. Recheck the complete procedure against its exact subset;
    // no other adaptation (environment, qualification, parameters) grants this.
    let subset: { procedure: NonNullable<typeof prepared.selected_procedure>; procedure_outputs: string[]; remaining_outputs: string[] } | undefined;
    const selected = prepared.candidates[0];
    if (strategy === 'adapt' && selected?.status === 'eligible' && selected.reasons.length &&
        selected.reasons.every(reason => reason.code === 'OUTPUT_MISMATCH')) {
      const manifest = resolveProcedure(root, selected.id, selected.version);
      const provided = normalizeNativeProjectPaths(root, manifest.outputs.map(output =>
        output.path.replace(/\{([a-z][a-z0-9_]*)\}/g, (_token, key: string) => String(prepared.parameters[key]))));
      if (provided.length && provided.every(path => outputs.includes(path))) {
        const exact = prepareWork(root, { ...applicability, outputs: provided, procedure_id: selected.id, procedure_version: selected.version });
        if (exact.decision === 'exact' && exact.selected_procedure) subset = { procedure: exact.selected_procedure,
          procedure_outputs: provided, remaining_outputs: outputs.filter(path => !provided.includes(path)) };
      }
    }
    const tools = prepared.candidates.slice(0, 3).flatMap(candidate => {
      try {
        const manifest = resolveProcedure(root, candidate.id, candidate.version);
        return [{ id: candidate.id, version: candidate.version, eligible: candidate.compatible && manifest.status === 'eligible',
          script: manifest.script, verifier: manifest.verification_script, parameters: manifest.parameters,
          output_templates: manifest.outputs.map(output => output.path), effects: manifest.effects }];
      } catch { return []; }
    });
    return { strategy, capability_discovery, installed_skill_components,
      history_state: history.state, matches, procedure_search: prepared.decision === 'blocked' ? 'ineligible' as const : prepared.decision,
      registry_state: prepared.registry?.state ?? 'available', parameters: prepared.parameters,
      ...(strategy === 'qualified-procedure' && prepared.selected_procedure ? { procedure: prepared.selected_procedure } : {}),
      ...subset,
      candidates: prepared.candidates.slice(0, 3), tools, brief: strategy === 'qualified-procedure'
        ? 'A project procedure is currently eligible for the proposed parameters and scope. Preparation has not executed it. Reuse still requires an actual host run and fresh independent checks.'
        : subset ? 'A qualified procedure covers only procedure_outputs and may be run by the host after fresh eligibility checks. Implement only remaining_outputs and any requested semantic differences; preserve the existing tooling. Independent review and current checks cover the full request.'
        : strategy === 'adapt' ? 'Relevant project tooling exists with eligibility differences. Continue ordinary implementation in the declared scope and validate only the needed differences.'
        : 'No eligible procedure was selected. Continue ordinary implementation with existing project scripts. Optional registry/cache issues do not stop this request.',
      execution: 'not-executed' as const, execution_authorized: false as const };
  } catch {
    return { strategy: 'ordinary' as const, capability_discovery, installed_skill_components, history_state: history.state, matches, registry_state: 'unavailable',
      brief: 'Optional procedure discovery is unavailable. Inspect existing project scripts and continue ordinary implementation; no procedure has been authorized or executed.',
      execution: 'not-executed' as const, execution_authorized: false as const };
  }
}
