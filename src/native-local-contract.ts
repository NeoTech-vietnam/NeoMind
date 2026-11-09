import { z } from 'zod';

/** Shared by native domain operations, generated profiles and the Local tool.
 * The historical controlled/OpenCode contract is intentionally unchanged. */
export const nativeLocalContractVersion = 'vscode-native/v1' as const;
export const nativeSpecialists = ['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'] as const;
export const nativeRoles = ['WF.PM', ...nativeSpecialists] as const;
export type NativeLocalRole = (typeof nativeRoles)[number];
export type NativeSpecialist = (typeof nativeSpecialists)[number];
/** Professional role IDs stay stable; these are native execution profiles. */
export const nativeWorkerProfiles = Object.freeze(Object.fromEntries(nativeSpecialists.map(role => [role, `${role} Worker`])) as Record<NativeSpecialist, string>);
export const nativeRootRoleToolReferences = Object.freeze(Object.fromEntries(nativeSpecialists.map(role =>
  [role, `workforceRole${role.slice(3).replaceAll('-', '')}`])) as Record<NativeSpecialist, string>);

const brief = z.string().trim().min(1).max(20_000);
const path = z.string().trim().min(1).max(1_024);
export const nativeSkillNamesSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .describe('Exact installed workspace skill name; not a source path, package URL or ownership identity.')).max(8)
  .refine(names => new Set(names).size === names.length, 'Select each skill once.').meta({ uniqueItems: true });
const roleSkills = z.strictObject({ 'WF.FnD': nativeSkillNamesSchema.optional(), 'WF.Reviewer': nativeSkillNamesSchema.optional(),
  'WF.Tester': nativeSkillNamesSchema.optional() }).refine(roles => new Set(Object.values(roles).flatMap(names => names ?? [])).size <= 8,
    'Select at most eight distinct workspace skills for one request.');
export const nativeRequestOpenSchema = z.strictObject({
  requirement: brief,
  title: z.string().trim().min(1).max(200).optional(),
  context: z.array(path.describe('Project context path. Absolute paths inside the workspace and local file URIs are normalized by the backend.')).max(100).default([]),
});
export const nativePlanSchema = z.strictObject({
  summary: brief,
  requirements: z.array(z.string().trim().min(1).max(4_000)).min(1).max(100),
  design: brief,
  role_skills: roleSkills.describe('Optional explicit installed workspace skills assigned only to the named workers, at most eight distinct names across these roles. Missing or changed selections are not silently replaced. Omit to use ordinary project tools.').optional(),
  task_family: z.string().trim().min(1).max(200).optional(),
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.union([z.string(), z.number().finite(), z.boolean()])).optional(),
  outputs: z.array(path.describe('Product file path inside the workspace; the backend normalizes editor absolute paths or relative paths.')).min(1).max(100),
  checks: z.array(z.strictObject({
    title: z.string().trim().min(1).max(200),
    command: z.array(z.string().min(1).max(4_000)).min(1).max(100),
    level: z.enum(['unit', 'integration', 'system', 'acceptance']),
  })).min(1).max(100),
});
export const nativeReportSchema = z.strictObject({
  summary: brief,
  verdict: z.enum(['pass', 'findings']),
  findings: z.array(z.string().trim().min(1).max(4_000)).max(100).default([]),
});
export type NativeRequestOpenInput = z.input<typeof nativeRequestOpenSchema>;
export type NativeRequestPlan = z.infer<typeof nativePlanSchema>;
export type NativeProfessionalReport = z.infer<typeof nativeReportSchema>;

/** M3 software pilot: one professional plan, backend-issued identities. It is
 * not activated as the default request tool until Local acceptance succeeds. */
export const nativeLocalRequestSchema = nativeRequestOpenSchema.extend({ plan: nativePlanSchema });
export const nativeLocalRequestJsonSchema = z.toJSONSchema(nativeLocalRequestSchema, { io: 'input', target: 'draft-7' });
export const nativeRequestControlSchema = z.strictObject({
  request_key: z.string().regex(/^WF-R\d{4,}$/).describe('The public request key returned by WorkForce, not a record, task or assignment ID.'),
  action: z.enum(['status', 'recheck', 'resume']).describe('Inspect results; recheck unchanged independently reviewed products after an environment correction or confirmed ended checker interruption; or explicitly resume retained findings or a backend-reconciled editor interruption. Saved scope and repair allowance remain unchanged; unconfirmed effects are not blindly replayed.'),
});
export const nativeRequestControlJsonSchema = z.toJSONSchema(nativeRequestControlSchema, { io: 'input', target: 'draft-7' });
export const nativeLocalToolReferences = Object.freeze({ request: 'workforceNativeRequest', prepare: 'workforcePrepare',
  role: 'workforceRoleJob', control: 'workforceRequestControl', capabilities: 'workforceCapabilities' });

const duties: Record<NativeLocalRole, string> = {
  'WF.PM': 'Understand the request, reuse project tools and coordinate verified delivery.',
  'WF.SWSD': 'Define requirements, scope and observable acceptance criteria.',
  'WF.P-RES': 'Define applicable design, interfaces and verification implications.',
  'WF.FnD': 'Implement and debug the scoped product with existing project tools.',
  'WF.Reviewer': 'Independently review the current product against its requirements and design.',
  'WF.Tester': 'Independently evaluate tests, behavior, edge cases and current verification evidence.',
};
const roleTools: Record<NativeLocalRole, readonly string[]> = {
  'WF.PM': ['read', 'search', ...Object.values(nativeLocalToolReferences)],
  'WF.SWSD': ['read', 'search'],
  'WF.P-RES': ['read', 'search'],
  'WF.FnD': ['read', 'search', 'edit', 'execute'],
  'WF.Reviewer': ['read', 'search'],
  'WF.Tester': ['read', 'search', 'execute'],
};
const roleProcedure: Record<NativeLocalRole, string> = {
  'WF.PM': `Use ${nativeLocalToolReferences.prepare} before planning to retrieve accepted experience and qualified project procedures. Read the requested files and the relevant existing scripts. Similar text is advisory; reuse requires current parameters, scope, script hashes and registry eligibility. An unavailable optional cache is not a reason to stop ordinary implementation.
When a role needs guidance beyond existing project tools, use ${nativeLocalToolReferences.capabilities} to search the approved catalog, inspect a relevant package and then inspect the selected skill's actual contents before installing it. Compare suitability for the role, dependencies and context cost. The host supplies approved sources, exact pins and license checks; provide only catalog/package/skill names and professional search text. Search is cache-first. When an optional capability returns ordinary-work fallback, follow its next_action and proceed with suitable existing tools. Repeating the same unsupported selection or varying skill names without new source evidence cannot repair a package layout. The capability tool cannot change permissions. After installation, bind the exact available skill name in the role plan and require its actual use and output checks. Installation alone is not proof of use.
Submit the ordinary requirement, context paths and a short professional plan through ${nativeLocalToolReferences.request}. Specify observable requirements, applicable design, exact product paths and existing compiler/test commands as executable-plus-argument arrays. When an available installed skill is needed, select its exact name in plan.role_skills for only the workers that need it. The host pins its receipt and files; discovery or installation alone does not prove loading/use. Omit optional skill selections for ordinary project tools. Use installed compilers and test runners directly; the host supplies compiler-local toolchain environment. Do not introduce Node or shell wrappers merely to launch an installed compiler. When reusable tooling is useful, deliver its generator, independent checker and an ordinary *.procedure.json file using .workforce/guides/native-reuse.md. The backend captures inspected candidates after acceptance; qualification remains separate and optional learning never blocks product delivery.
The Local adapter creates valid native specialist calls and saves their actual results. Submit once for the user's goal. Report the returned current artifacts, check results and acceptance; delivery is complete when the backend verifies the current revision. Never create a second request merely to retry, repair or verify an unfinished one, even with a different title or command wrapper. Use ${nativeLocalToolReferences.control} with its returned public request_key to inspect saved results, recheck unchanged reviewed products after an environment correction, or explicitly resume retained findings or an editor-interrupted request when asked to continue. The backend reconciles confirmed ended operations and preserves the saved scope, history and repair allowance; unknown effects need runtime reconciliation rather than guessed identities or repeated calls. Do not poll status while a native call is still running. A genuinely new user goal is a separate request.
When the user asks only for one named role, use ${nativeLocalToolReferences.role} with that role, the professional requirement and scoped project paths. A role-completed result completes only that assignment; whole-product acceptance still requires the software request path.`,
  'WF.SWSD': `Inspect the request and relevant project material. Define scope, assumptions and observable acceptance criteria. Identify a product decision only when it cannot be inferred from the supplied request or repository. Return the requested professional report.`,
  'WF.P-RES': `Inspect the requirements and relevant existing design. Describe the applicable interfaces, module decisions, change impact and corresponding checks. Scale the design to the product and risk. Return the requested professional report.`,
  'WF.FnD': `Implement the assigned product at its specified destinations, preserving unrelated user edits. Reuse the supplied scripts, templates and project conventions. Inspect diagnostics and repair the product when necessary. The backend captures its stated file baselines and runs the committed check commands directly, without a terminal shell. If native terminal startup fails, avoid repeated shell/environment probes. Report the implementation actually inspected; describe unavailable local execution in the summary. An unavailable terminal or pending host checks alone are not product findings. An observed product defect remains a finding. Your verdict covers implementation; independent review and final acceptance follow after your report. Return the requested professional report.`,
  'WF.Reviewer': `Read the current product independently against the supplied requirements and design. Assess correctness, missing behavior, maintainability and relevant risks. Return actionable findings or an explicit pass in the requested professional report. Product edits belong to WF.FnD.`,
  'WF.Tester': `Read the current product and its checks independently. Assess coverage, edge cases, oracle quality and whether the checks substantiate the acceptance criteria. Run the scoped verification commands through the native execution tool when execution is part of your assignment, and report their actual results and diagnostics. Do not edit the product or delegate verification. Identify product defects separately from checker defects. The backend also captures the committed command results against the current revision before whole-product acceptance. Return actionable findings or an explicit pass in the requested professional report.`,
};

/** Text contains only the native contract. Legacy claim/lifecycle guidance is
 * not copied into these profiles. No model preference means native inheritance. */
export function nativeLocalProfile(role: NativeLocalRole): string {
  const specialist = role !== 'WF.PM';
  const tools = specialist ? ['read', 'search', nativeRootRoleToolReferences[role]] : roleTools[role];
  const agents = specialist ? [nativeWorkerProfiles[role]] : Object.values(nativeWorkerProfiles);
  const procedure = specialist
    ? `Submit this ${role} request once through ${nativeRootRoleToolReferences[role]}. Supply the user's professional requirement, attached context paths and any requested product destinations as outputs. If the user or role plan selects installed workspace skills, supply their exact names in skills; omit optional selections for ordinary tools. The backend fixes the role, pins selected skill files and receipts, opens its scoped record and dispatches the dedicated worker. Report its returned summary, findings, artifacts and saved report. A role-completed result finishes only ${role}; whole-product acceptance is separate.`
    : roleProcedure[role];
  return `---
name: ${JSON.stringify(role)}
description: ${JSON.stringify(duties[role])}
tools: ${JSON.stringify(tools)}
agents: ${JSON.stringify(agents)}
user-invocable: true
disable-model-invocation: true
---

${procedure}

Execution contract: ${nativeLocalContractVersion}. Native Local owns the model and tool loop. WorkForce owns request membership, assignments, record IDs and verification state. Work on the professional content supplied in the handoff; the adapter saves its result.
Respect native workspace permissions. Requested model/provider and observed model/provider are separate facts; a gateway alias does not identify its upstream model.
`;
}

/** Only worker profiles carry professional edit/execute tools. Native tool and
 * subagent allowlists prevent recursive WorkForce requests independently of prose. */
export function nativeLocalWorkerProfile(role: NativeSpecialist): string {
  return `---
name: ${JSON.stringify(nativeWorkerProfiles[role])}
description: ${JSON.stringify(duties[role])}
tools: ${JSON.stringify(roleTools[role])}
agents: []
user-invocable: false
---

${roleProcedure[role]}

Execution contract: ${nativeLocalContractVersion}. Complete the supplied professional assignment and return its requested report; the host saves the actual outcome and owns subsequent lifecycle transitions.
`;
}

export function nativeProfessionalReportInstructions(): string {
  return `Return one JSON object with summary (string), verdict ("pass" or "findings"), and findings (array of concrete finding strings). Use an empty findings array for pass. Report only observed work and unresolved professional findings; the host supplies identities and saves the report.`;
}
