import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { atomicWrite, getRecord, hash, now, safePath, withOperationLock } from './storage.js';
import { replaceWorkspaceFile, workspaceFileBytes, workspaceContentBytes, workspacePathLockKey } from './workspace.js';
import { registerProcedureSchema, procedureInputContractHint } from './procedures.js';
import { controlledReportSubmissionSchema } from './controlled-report-normalization.js';
import { controlledModelInput, controlledValidation, redactControlledValue } from './controlled-observability.js';
import { controlledCornellResearchSchema } from './controlled-cornell-sources.js';
import { controlledCornellSubmissionSchema, normalizeControlledCornellSubmission, controlledCornellSubmissionGuide } from './controlled-cornell-submission.js';
import { controlledRuntimeGuide, controlledGuidePath, controlledRuntimeQuerySchema, type ControlledRuntimeQuery } from './controlled-runtime-context.js';
import { controlledExecutionSchema, type ControlledExecutionInput, type ControlledExecutionDeclaration } from './controlled-execution.js';
import { controlledPayloadSchema, resolveControlledPayload, assertControlledPayloadCurrent, ControlledPayloadError, type ControlledPayloadSource } from './controlled-payload.js';
import { controlledPlanExecutionStepSubmissionSchema, controlledPlanCheckSubmissionSchema } from './controlled-plan-submission.js';
import { controlledPlanRequestSchemas, controlledPlanSubmissionGuide, type ControlledPlanRequestDefaults } from './controlled-plan-request.js';
import { controlledOperationDiagnostic, type ControlledDiagnosticPhase } from './controlled-operation-diagnostic.js';
import { controlledFileWriteProof } from './controlled-file-write-proof.js';
import { ControlledEvidenceScanTimeout } from './controlled-evidence-error.js';

export type ControlledStage = 'planning' | 'implementation' | 'verification' | 'review' | 'diagnosis' | 'synthesis';
export type ControlledReviewPurpose = 'checker-readiness' | 'final-product';
export const controlledConsultationRoles = ['explorer', 'planner', 'architect', 'researcher', 'curator', 'component-owner'] as const;
export interface ControlledBinding {
  workflow_id: string; task_id?: string; invocation_id?: string;
  stage: ControlledStage; role: string;
  /** Saved workflow metadata supplied by its owning backend, never by a worker. */
  plan_defaults?: ControlledPlanRequestDefaults;
  /** Backend-owned opt-in from the original request or committed legacy contract. */
  procedure_registration_required?: boolean;
  /** Backend-owned review scope; workers never select or mutate this purpose. */
  review_purpose?: ControlledReviewPurpose;
  /** Backend-owned verification scope; selected command count does not define final acceptance. */
  verification_purpose?: 'product-checkpoint' | 'final-contract';
  implementation_paths: string[]; verification_paths: string[];
  read_paths?: string[]; protected_paths?: string[]; check_titles?: string[];
  approved_inputs?: string[];
  execution_steps?: ControlledExecutionDeclaration[];
  procedure_bound?: boolean;
  cornell_starter_allowed?: boolean;
  cornell_bound?: boolean;
  /** Backend-only primary compiler source from the immutable contract. */
  cornell_source?: { path: string; sha256: string };
  /** Compiler-owned renderings. A worker supplies semantic compiler input instead of raw bytes. */
  generated_artifact_paths?: string[];
  evidence_documentation?: boolean;
  evidence_documentation_source_hash?: string;
}
const text = z.string().trim().min(1).max(8000);
const paths = z.array(z.string().min(1).max(1024)).max(128);
export const controlledPlanSchema = z.strictObject({
  title: text.max(256), objective: text, rationale: text,
  acceptance_criteria: z.array(text).min(1).max(32),
  allowed_paths: paths.min(1).describe('Producer-owned implementation files or directories, disjoint from verification_paths. Use project-relative paths.'),
  verification_paths: paths.min(1).describe('Verifier-owned checker scripts, negative fixtures and verifier-authored reports, disjoint from producer paths. Directory scopes are allowed. Declare the checker here and in checks[].command, not in producer outputs. The backend captures its baseline.'),
  outputs: paths.min(1).describe('Producer deliverables only, within allowed_paths: product code, requested notes and producer documentation. Verifier checker scripts, negative fixtures and verifier-authored reports belong to verification_paths, not outputs; backend check baselines and the Verifier report retain those artifacts.'),
  documentation_paths: paths.default([]).describe('Producer-authored documentation within allowed_paths. Read-only source references and Verifier-owned checker reports are not producer documentation outputs.'),
  evidence_report_paths: paths.optional().describe('Final factual execution reports written after independent checks. Exact paths must also be producer outputs and documentation_paths; primary Cornell note/exercises/answers remain their own deliverables. Backend schedules this documentation handoff and fresh verification without a failed-review retry.'),
  execution_steps: z.array(z.lazy(() => controlledPlanExecutionStepSubmissionSchema())).max(16).optional().describe('Each item is {title,command,output_paths}, with optional exact input_paths and limits. Example: {"title":"Generate the result","command":["node","scripts/generate.cjs"],"output_paths":["generated/result.json"]}. Only direct local script execution or fixed --version observations are available. Native tools cornell_research_compile and procedure_run are not OS executables. Request them through cornell_output_dir or reuse. For prepared JSON, the later task_run call supplies {title,input_path}; the backend sends JSON on stdin. Do not declare stdin_path or node -e/--eval wrappers. Independent checks remain in checks under Verifier ownership.'),
  checks: z.array(controlledPlanCheckSubmissionSchema(z.strictObject({ title: text.max(256),
    purpose: z.enum(['self-check', 'intended-use']).optional(),
    after_evidence_reports: z.boolean().optional().describe('A check of the final factual report, deferred until actual product-check evidence is available and the report has been written. Declare at least one nondeferred product check first. Final acceptance still requires this check and its negative controls through a fresh Verifier.'),
    command: z.array(z.string().min(1).max(8000)).min(2).max(128).describe('Exact argument array [executable, verifier-owned-checker-script, ...inputs]. The checker script must be inside verification_paths. Negative controls invoke this same executable and script with deliberately invalid verifier-owned inputs.'),
    baseline_paths: paths.default([]).describe('Optional additional check inputs within write scopes, or exact existing ordinary files under public preservation_paths or approved hidden input_paths. Read-only baselines must name needed files, not directories; never move them into write scopes merely to capture them. The backend adds delivered outputs and actual checker argv paths before freezing a new plan; committed check baselines remain unchanged.'), expected_exit_code: z.number().int().min(0).max(255).optional(),
    timeout_ms: z.number().int().min(1).max(600000).optional(),
    negative_controls: z.array(controlledPlanCheckSubmissionSchema(z.strictObject({ title: text.max(256),
      command: z.array(z.string().min(1).max(8000)).min(2).max(128),
      baseline_paths: paths.default([]).describe('Optional additional fixture/dependency inputs within write scopes, or exact existing ordinary files under public preservation_paths or approved hidden input_paths. Read-only baselines name files, not directories, and do not become writable. The backend adds the independent checker and verifier-owned fixture argv paths.'), expected_exit_code: z.number().int().min(1).max(255),
    }))).min(1).max(16).describe('Required for every check in the current process contract, including intended-use checks. Declare actual failing fixtures or --negative-control cases for the same independent checker; expected_exit_code must be nonzero.'),
  }))).min(1).max(16),
  risk: z.enum(['low', 'elevated', 'high']).optional(),
  reuse: z.strictObject({ procedure_id: text.max(80), version: text.max(80).optional(), parameters: z.record(z.string(), z.unknown()) }).optional()
    .describe('A currently eligible procedure selected through work_prepare. The backend supplies its bound procedure_run tool; this is not an OS command or execution_steps entry.'),
  procedure_candidate: registerProcedureSchema.omit({ id: true, version: true, author: true }).optional().describe('Reusable FUTURE-RUN manifest. script/verification_script/dependencies are tool INPUTS delivered or reused here. outputs are future generated exercise/note/report files, often destination-parameterized; they are NOT the delivered plan.outputs or executable scripts. Generated outputs must be new and covered by nonempty effects.write_roots. Backend supplies registration identity; do not invent IDs.'),
  cornell_output_dir: z.string().min(1).max(1024).optional()
    .describe('Requested primary Cornell bundle directory; include its note.md, exercises.md and answers.md in producer outputs. Backend supplies cornell_research_compile directly. Do not add the native tool as an execution_steps command.'),
  cornell_input_path: z.string().min(1).max(1024).optional()
    .describe('Existing public prepared research JSON for the primary Cornell bundle, outside every write scope. Backend preserves its bytes, binds its frozen hash and loads it for the Implementer automatically. Use this semantic source path instead of a native compiler execution_steps entry; do not supply hashes or identities.'),
  input_paths: paths.optional().describe('Exact hidden read-only skill assets/scripts only: .agents/skills/<skill>/(assets|scripts)/<file> or .github/skills/<skill>/(assets|scripts)/<file>. Put hidden canonical templates and validators here, not in preservation_paths; the backend fingerprints these inputs too. Ordinary public source paths are already readable and need no approval. Never list private client configuration, credentials or entire hidden directories.'),
  preservation_paths: paths.optional().describe('Narrow existing public files or small public trees that must remain unchanged, outside producer/checker write scopes. Hidden skill templates and validator scripts belong in input_paths instead. Prefer exact exercised files and public canonical assets; avoid repository roots, dependency trees and caches. These baselines grant no extra read or write permissions.'),
  specialists: z.array(z.strictObject({ role: z.enum(controlledConsultationRoles)
    .describe('Optional bounded consultation role only. Reviewer and Verifier are backend-owned workflow stages, not consultation roles.'),
    objective: text })).max(4).optional().describe('Optional consultations for a concrete expert question. Do not add Reviewer or Verifier here; the backend preserves and schedules all required independent verification, pre-check review and final review gates.'),
});
export type ControlledPlan = z.infer<typeof controlledPlanSchema>;
export const controlledReportSchema = z.strictObject({
  outcome: z.enum(['completed', 'blocked', 'failed']), summary: text,
  artifacts: paths.optional().describe('Actual delivered files inside this workflow implementation/checker/Cornell output scopes. Preserved inputs and files only read are not deliverables; discuss their preservation in findings instead.'), findings: z.array(text).max(64).optional(),
  failure_kind: z.enum(['implementation', 'checker', 'protocol', 'environment', 'unknown']).optional()
    .describe('Professional failure classification. A completed manager diagnosis requires this field; use unknown when the actual cause remains uncertain.'),
  verdict: z.enum(['pass', 'fail']).optional(), negative_controls: z.array(text).max(32).optional(),
  limitations: z.array(text).max(32).optional(),
});
export type ControlledReport = z.infer<typeof controlledReportSchema>;
export interface ControlledCallbacks {
  /** Check authoritative invocation, epoch and current policy; writers recheck synchronously at commit. */
  assertActive(): void | Promise<void>;
  submitPlan?(plan: ControlledPlan, source?: ControlledPayloadSource): unknown | Promise<unknown>;
  saveReport(report: ControlledReport, source?: ControlledPayloadSource): unknown | Promise<unknown>;
  runCheck?(title?: string): unknown | Promise<unknown>;
  prepareWork?(query: { request: string; parameters?: Record<string, unknown> }): unknown | Promise<unknown>;
  runProcedure?(parameters?: Record<string, unknown>): unknown | Promise<unknown>;
  runtimeContext?(query: ControlledRuntimeQuery): unknown | Promise<unknown>;
  runTask?(input: ControlledExecutionInput, source?: ControlledPayloadSource): unknown | Promise<unknown>;
  compileResearch?(input: Record<string, unknown>, source?: ControlledPayloadSource): unknown | Promise<unknown>;
  readEvidence?(title?: string, kind?: 'execution' | 'registration' | 'workflow'): unknown | Promise<unknown>;
  trace?(event: Record<string, unknown>): void | Promise<void>;
}
/** Only explicitly public controller diagnostics cross the model-facing error seam. */
export class ControlledToolError extends Error {
  constructor(readonly code: string, message: string,
    readonly ownership?: { target_owner: 'developer' | 'verifier' | 'protected-acceptance' | 'outside-scope'; next_action: string;
      rule?: 'ROLE_HANDOFF_REQUIRED'; target_path?: string; missing_paths?: string[] }) { super(message); }
}
interface ToolState {
  schema_version: 1; binding_hash: string;
  reads: Record<string, string | null>;
  writes: { operation: string; path: string; previous_hash: string | null; sha256: string; completed: boolean }[];
}
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const covers = (scope: string, path: string) => scope === '.' || key(path) === key(scope) || key(path).startsWith(`${key(scope)}/`);
function canonical(path: string, directory = false): string {
  if (directory && path === '.') return path;
  if (!path || path.startsWith('/') || /[\\:\x00-\x1f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)))
    throw new ControlledToolError('INVALID_PATH', 'Use a canonical project-relative path with forward slashes.');
  return path;
}
function privatePath(path: string): boolean {
  return path.toLowerCase().split('/').some(part =>
    ['.git', '.neomind', '.verythinker', '.taskforces', '.codex', '.claude', '.vscode', '.agents', '.cursor', 'node_modules'].includes(part) ||
    /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|pfx|p12))$/.test(part));
}
/** Shared with plan intake so redundant public references never become hidden-file approvals. */
export function controlledPublicReferencePath(path: string): boolean { return !privatePath(path); }
export function controlledSkillInputPath(path: string): boolean {
  return /^\.(?:agents|github)\/skills\/[^/]+\/(?:assets|scripts)\/.+\.(?:md|py|mjs|cjs|js|json)$/i.test(path) &&
    !privatePath(path.split('/').slice(4).join('/'));
}
function publicTarget(root: string, path: string, approved: string[] = []): string {
  canonical(path, true);
  if (privatePath(path) && !approved.includes(path)) throw new ControlledToolError('PRIVATE_PATH', 'Private runtime, credentials and client configuration are unavailable to workers.');
  const target = safePath(root, path);
  let current = resolve(root);
  for (const component of path === '.' ? [] : path.split('/')) {
    current = resolve(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new ControlledToolError('INVALID_PATH', 'Worker file tools do not follow symbolic links.');
  }
  return target;
}
function assertReadable(binding: ControlledBinding, path: string, directory = false): void {
  const scopes = binding.read_paths ?? ['.'];
  if (!scopes.some(scope => covers(scope, path) || (directory && covers(path, scope))))
    throw new ControlledToolError('SCOPE_DENIED', 'This path is outside the assigned readable inputs.');
}
function assertWritable(binding: ControlledBinding, path: string): void {
  canonical(path);
  if (binding.generated_artifact_paths?.some(artifact => key(artifact) === key(path)))
    throw new ControlledToolError('GENERATED_ARTIFACT', 'This file is a compiler-owned Cornell rendering. Submit the corrected professional content through cornell_research_compile; its backend writer preserves revisions and synchronizes all three artifacts.');
  const scopes = binding.stage === 'implementation' && binding.role === 'developer' ? binding.implementation_paths
    : binding.stage === 'verification' && ['verifier', 'check-executor'].includes(binding.role) ? binding.verification_paths : [];
  const other = binding.stage === 'implementation' ? binding.verification_paths : binding.implementation_paths;
  const protectedTarget = (binding.protected_paths ?? []).some(scope => covers(scope, path));
  if (!scopes.some(scope => covers(scope, path)) || other.some(scope => covers(scope, path)) || protectedTarget) {
    const target_owner = protectedTarget ? 'protected-acceptance' : binding.verification_paths.some(scope => covers(scope, path)) ? 'verifier'
      : binding.implementation_paths.some(scope => covers(scope, path)) ? 'developer' : 'outside-scope';
    const producerHandoff = binding.stage === 'implementation' && binding.role === 'developer' && target_owner === 'verifier';
    const verifierProduct = binding.stage === 'verification' && target_owner === 'developer';
    const next_action = producerHandoff
      ? 'Finish only your assigned implementation outputs. When they are ready, save assignment_report with outcome completed. Missing checker files and negative-control fixtures are expected: the backend dispatches the independent Verifier next.'
      : verifierProduct ? 'Do not edit implementation files. Report the concrete product defect with failure_kind implementation; the backend dispatches the implementation repair.'
      : protectedTarget ? 'Preserve the protected acceptance artifact. Report the constraint for backend reconciliation; this role cannot widen its scope.'
      : !scopes.length ? 'This role is read-only. Inspect the assigned artifacts and evidence, then report your findings; route required changes to their owning role.'
      : 'Use only your assigned writable paths. Report any required scope change to the backend instead of editing another role\'s files.';
    throw new ControlledToolError('SCOPE_DENIED', `Write denied. Target owner: ${target_owner}. ${next_action}`,
      { target_owner, target_path: path, next_action, ...(producerHandoff ? { rule: 'ROLE_HANDOFF_REQUIRED' } : {}) });
  }
}
export function controlledToolNames(binding: ControlledBinding): string[] {
  return ['runtime_context', 'project_read', 'project_list', 'project_search', 'assignment_report',
    ...(binding.stage === 'planning' ? ['workflow_plan', 'work_prepare'] : []),
    ...((binding.stage === 'implementation' && binding.role === 'developer') ||
      (binding.stage === 'verification' && ['verifier', 'check-executor'].includes(binding.role)) ? ['task_file_write'] : []),
    ...(binding.stage === 'implementation' && binding.procedure_bound !== false ? ['procedure_run'] : []),
    ...(binding.stage === 'implementation' && (binding.execution_steps === undefined || binding.execution_steps.length) ? ['task_run'] : []),
    ...(['implementation', 'synthesis'].includes(binding.stage) && !binding.evidence_documentation && binding.cornell_bound !== false ? ['cornell_research_compile'] : []),
    ...(['implementation', 'verification', 'review', 'synthesis', 'diagnosis'].includes(binding.stage) ? ['check_evidence'] : []),
    ...(binding.stage === 'verification' ? ['check_run'] : [])];
}
/** Both Bridge prompt layers use the same scope so precheck cannot inherit final acceptance duties. */
export function controlledReviewInstructions(purpose: ControlledReviewPurpose): string {
  return purpose === 'checker-readiness'
    ? 'Review purpose: checker-readiness. Independently inspect the exact checker source/argv, oracle, protected cases and negative controls against the unchanged criteria. Judge checker adequacy and safe bounded execution in the declared scope and disposable pilot workspace when required, including any generator or product code the planned commands execute. This review precedes execution: not-yet-run evidence is expected, and an empty check_evidence result is not a readiness failure. Product defects that the planned checker can safely diagnose belong in findings and limitations; they are not final acceptance decisions. Fail readiness for an unsound/incomplete checker or a real execution-safety defect, including scope escape, destructive effects or unauthorized data access/publication. Classify the actual cause with failure_kind. Do not execute checks in this read-only review. Save assignment_report with verdict pass or fail; readiness approval does not establish product correctness or workflow completion.'
    : 'Review purpose: final-product. Independently inspect the delivered artifacts against all unchanged acceptance criteria. Require fresh positive and negative execution evidence, required intended-use pilot receipts and the requested Cornell output. A producer-authored Cornell deliverable is independently checked without rewriting its captured bytes to embed future proof IDs; a separately assigned post-verification knowledge bundle must satisfy its evidence-derived synthesis obligations. Read check_evidence for actual stdout/stderr and intended-use build/run results; absent, stale or failing required evidence cannot support a pass. When registration is required, read check_evidence({kind:"registration"}) for the actual bound registry manifest and current code-hash comparisons; registered candidate is not qualification. Do not infer missing registration from the absence of a separate signed receipt or try private registry files. Private runtime files remain unavailable. Save assignment_report with verdict pass or fail and substantive findings; pre-execution checker readiness is not final product acceptance.';
}
export function controlledInstructions(binding: ControlledBinding): string {
  const available = new Set(controlledToolNames(binding));
  const documentation = binding.stage === 'implementation' && binding.evidence_documentation === true;
  const writable = binding.stage === 'implementation' && binding.role === 'developer' ? binding.implementation_paths
    : binding.stage === 'verification' && ['verifier', 'check-executor'].includes(binding.role) ? binding.verification_paths : [];
  const ownership = { your_role: binding.role, your_stage: binding.stage, your_writable_paths: writable,
    ...(documentation ? { assignment_purpose: 'evidence-documentation' } : {}),
    ...(binding.stage === 'review' ? { review_purpose: binding.review_purpose ?? 'final-product' } : {}),
    ...(binding.stage === 'verification' ? { verification_purpose: binding.verification_purpose ?? 'final-contract' } : {}),
    implementation: { owner: 'developer', paths: binding.implementation_paths }, verification: { owner: 'verifier', paths: binding.verification_paths } };
  const duties: Record<ControlledStage, string> = {
    planning: 'Inspect relevant files and existing reusable tools. Submit one bounded semantic workflow_plan with acceptance criteria, separate implementation/checker paths and actual check commands. Positive and negative baseline_paths may include public dependencies declared in preservation_paths and exact approved hidden input_paths; those inputs remain read-only. Do not move preserved scripts into allowed_paths or verification_paths merely to capture their bytes. Declare negative_controls using the same checker with verifier-owned deliberately invalid fixtures/inputs and their expected nonzero exits; runtime executes them as evidence. Elevate risk or suggest a bounded specialist only when needed. Allowed consultation roles are explorer, planner, architect, researcher, curator and component-owner. Reviewer and Verifier are backend-owned stages; do not add them as consultations or remove their required gates.',
    implementation: documentation
      ? 'Complete only the requested final report files in your writable paths. Read the bound check_evidence and the supplied independent verification checkpoint, then describe the observed commands, results and limitations accurately. Use task_file_write after reading the current report. Implementation code, checker files and Cornell bundles remain read-only. The backend schedules fresh independent verification and required review after this report; the workflow is not yet accepted or closed.'
      : available.has('task_file_write')
      ? 'Read existing files before editing. Write only ordinary assigned source and report files with task_file_write. Backend handles file versions, operation identity and task lifecycle. Preserve independent checker and acceptance files.'
      : 'Inspect the assigned implementation and report your professional findings. This session has no source-write operation; the backend retains implementation ownership.',
    verification: 'Inspect the delivered implementation. Author and repair only the independent checker paths, including deliberately invalid fixtures for the prescribed negative_controls. Run the prescribed checks with check_run; backend executes both positive and negative commands. Report prose alone is not negative-control evidence. Distinguish a product defect from a checker or environment failure. ' +
      (binding.verification_purpose === 'product-checkpoint'
        ? 'Your verdict covers the product checkpoint before the promised factual execution report. Judge all current product/checker obligations honestly. The producer report is an expected handoff until these executions exist; its missing future execution results alone are not a product-checkpoint defect. Record that final-report obligation as pending, not satisfied. A checkpoint pass is not a final-contract pass; backend authorizes only the report handoff, then a fresh full Verifier and required Reviewer still judge every unchanged criterion.'
        : 'This is full final-contract verification. Assess every unchanged criterion, including the promised factual report and every earlier professional finding. Report authoring alone does not resolve a non-report defect or turn an earlier fail into pass.'),
    review: controlledReviewInstructions(binding.review_purpose ?? 'final-product'),
    diagnosis: 'Inspect available evidence and identify the root cause. Classify failure_kind as implementation, checker, protocol, environment or unknown and recommend one bounded recovery action.',
    synthesis: 'Derive the final requested Cornell research note from actual artifacts and independent evidence. Use cornell_research_compile to preserve the standard format and separate practice/answers. For a planned reusable candidate, read check_evidence({kind:"registration"}) for actual registry provenance and current code hashes; registration does not establish qualification. Record limitations and actual sources, then assignment_report. Source implementation and checker files are read-only.',
  };
  return `Authoritative role ownership: ${JSON.stringify(ownership)}\n` +
    (binding.stage === 'implementation' ? documentation
      ? 'This is the normal report handoff after an independent verification checkpoint. Save one completed assignment_report when the promised report files accurately reflect that checkpoint. The backend owns the following fresh verification and review; this assignment cannot create a passing verdict or close the workflow.\n'
      : 'Complete only your implementation outputs. The independent Verifier owns all checker files and negative-control fixtures; missing verifier artifacts are EXPECTED at this handoff. Do not create them or mark your work blocked because a later role has not run. When your own outputs are ready, save outcome completed; the backend advances to Verifier. Report blocked only for a real blocker to your assigned implementation.\n' : '') +
    `You are a NeoMind-owned ${binding.role} session in the ${binding.stage} stage. ${duties[binding.stage]}\n` +
    (binding.stage === 'planning' && binding.plan_defaults
      ? 'The backend supplies omitted plan title and objective from the saved user request. Focus on the professional rationale, unchanged acceptance criteria, scoped outputs and independent check design. You may provide an explicit title or objective when useful; never invent workflow identities or repeat metadata to establish ownership.\n'
      : '') +
    `Available operations: ${[...available].join(', ')}. Their actor, workflow, task, scope and authorization are already bound by the runtime. Supply semantic content and project-relative file paths.\n` +
    (binding.stage === 'verification' || binding.stage === 'diagnosis'
      ? 'For prepared UTF-8 JSON, read the actual file and JSON.parse it exactly once. Its parsed field strings are already semantic content. Never apply transport-unescaping, JSON-string decoding or blanket replacements of escaped quotes, backslashes or literal \\n to those strings or comparison fixtures. Preserve literal code fences and JSON/code escape sequences; compare actual decoded source content with actual rendered artifacts, not the serialized project_read/MCP display wrapper.\n'
      : '') +
    'Your bound worker already executes through the enabled Bridge. runtime_context supplies one session snapshot when execution facts are needed; after preflight_complete, continue professional work without repeating unchanged queries. Optional executable paths must come from actual project configuration or documentation; never guess locations. Missing optional toolchains do not invalidate the session. Existing AGENTS/profile setup instructions address the parent intake client; credentials and workflow IDs remain private.\n' +
    (binding.stage === 'planning'
      ? 'Declare execution_steps only for required direct local scripts or fixed version observations. Native cornell_research_compile and procedure_run tools are not OS executables: request them through cornell_output_dir or eligible reuse, not command argv. Keep producer outputs separate from checker/fixture/report files in verification_paths. Put exact hidden skill assets and validators in input_paths; preservation_paths describes public unchanged files. Bind reuse {procedure_id,version,parameters} only after work_prepare reports exact eligibility. For requested Cornell notes declare cornell_output_dir and all three note.md/exercises.md/answers.md outputs. If research is supplied as a prepared JSON file, name cornell_input_path; backend binds and loads that exact source for the worker. When a requested final execution report needs actual independent results, declare its exact evidence_report_paths within both outputs and documentation_paths. The backend schedules report completion after a verification checkpoint and then fresh verification; keep the primary Cornell trio out of these report paths.\n' +
        (binding.procedure_registration_required
          ? 'The original request or committed contract requires reusable procedure registration. Supply procedure_candidate with the actual producer/checker scripts; runtime registers it after checked completion without claiming qualification.\n'
          : 'Deliver the requested product and independent checks without adding future automation or registry work.\n')
      : '') +
    (binding.stage === 'planning' ? controlledPlanSubmissionGuide(controlledPlanSchema) + '\n' : '') +
    (available.has('task_run')
      ? 'Use task_run for a scoped direct local execution bound to your plan. For prepared JSON data, send {"title":"<declared step title>","input_path":"project/prepared-input.json"}; the backend reads and parses that JSON object and supplies it to the declared script on stdin. Use input instead only for directly authored semantic data. Do not change the saved command or invent node -e, wrapper scripts or stdin_path to read the payload file. Direct execution is separate from qualified automatic procedure reuse and never qualifies a registry candidate.\n'
      : '') +
    (available.has('procedure_run')
      ? 'Use procedure_run for the saved qualified procedure rather than recreating its generator. The backend binds its identity, execution key and output paths.\n'
      : '') +
    (available.has('cornell_research_compile')
      ? 'The canonical Cornell note.md, exercises.md and answers.md are compiler-owned generated artifacts. Author their professional content through cornell_research_compile semantic input; do not create, patch or overwrite this managed trio with task_file_write. Ordinary implementation/report files remain separate.\n' + (binding.cornell_source
        ? `The primary Cornell source is already backend-bound to ${binding.cornell_source.path}. Call cornell_research_compile with {} or its exact input_path; do not copy, rewrite or override the prepared research. Backend verifies the frozen input hash and supplies the content.\n`
        : 'Use cornell_research_compile for the requested Cornell bundle with substantive research content; its output folder and provenance are backend-bound. When the semantic research is already saved as scoped JSON, send only {input_path:"project/prepared-research.json"}; the backend reads and parses the current file. Direct research fields are a separate form for new content. Preserve real prose newlines and literal escape sequences in examples rather than copying serialized tool text or rewriting escapes.\n')
      : '') +
    (binding.stage === 'planning' && binding.procedure_registration_required || available.has('procedure_run') ? procedureInputContractHint() : '') +
    'Before ending, save one compact assignment_report with outcome, summary, artifacts and findings. ' +
    (binding.stage === 'diagnosis' && binding.role === 'manager'
      ? 'For a completed diagnosis, provide top-level failure_kind as implementation, checker, protocol, environment or unknown. Use unknown when evidence does not establish the cause; summary prose alone is not a structured classification. '
      : ['verification', 'review'].includes(binding.stage)
      ? 'For outcome completed, include your explicit verdict pass or fail. Blocked or failed findings may omit verdict and are still retained. '
      : '') +
    'A blocked or failed report preserves useful work and does not submit a task. Reported prose is distinct from observed execution evidence. Runtime events supply progress and advance the workflow; focus on the assigned work.';
}

/** Each server belongs to one actual invocation; no model-provided identity can rebind it. */
export function createControlledMcpServer(root: string, input: ControlledBinding, callbacks: ControlledCallbacks): McpServer {
  const binding = structuredClone(input);
  for (const path of binding.approved_inputs ?? [])
    if (!controlledSkillInputPath(path))
      throw new Error('Approved hidden inputs must be bounded skill assets or script sources, never client/runtime configuration.');
  if (!binding.invocation_id || !binding.workflow_id || !binding.role ||
      !['planning', 'implementation', 'verification', 'review', 'diagnosis', 'synthesis'].includes(binding.stage))
    throw new Error('Controlled MCP requires a backend-bound actual invocation.');
  for (const scope of [...binding.implementation_paths, ...binding.verification_paths, ...(binding.read_paths ?? []), ...(binding.protected_paths ?? [])])
    canonical(scope, true);
  const bindingHash = hash(JSON.stringify(binding));
  const base = `.neomind/controlled-tools/${hash(binding.invocation_id)}`;
  const statePath = `${base}/state.json`;
  const server = new McpServer({ name: 'neomind-controlled-worker', version: '2' }, { maxToolInputElements: 8000 });
  let closed = false;
  const originalClose = server.close.bind(server);
  server.close = async () => { closed = true; await originalClose(); };
  function loadState(): ToolState {
    const path = safePath(root, statePath);
    const state: ToolState = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
      : { schema_version: 1, binding_hash: bindingHash, reads: {}, writes: [] };
    if (state.schema_version !== 1 || state.binding_hash !== bindingHash || !state.reads || !Array.isArray(state.writes))
      throw new ControlledToolError('STATE_UNCERTAIN', 'The saved tool journal differs from this bound invocation; runtime reconciliation is required.');
    return state;
  }
  function saveState(state: ToolState): void { atomicWrite(safePath(root, statePath), `${JSON.stringify(state, null, 2)}\n`); }
  function locked<T>(action: (state: ToolState) => T): T {
    return withOperationLock(root, `controlled-tools-${hash(binding.invocation_id!).slice(0, 32)}`, () => action(loadState()));
  }
  function activeAtCommit(): void {
    if (closed) throw new ControlledToolError('ACTOR_INACTIVE', 'This worker session has ended.');
    const result = callbacks.assertActive();
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch(() => {});
      throw new ControlledToolError('PROTOCOL_ERROR', 'File commits require a synchronous authoritative invocation check.');
    }
  }
  function completeWrite(entry: ToolState['writes'][number]): void {
    try {
      const proof = controlledFileWriteProof(root, binding.invocation_id!, bindingHash, entry, false);
      const path = safePath(root, proof.completion_path);
      if (!existsSync(path)) atomicWrite(path, proof.completion);
    } catch {
      throw new ControlledToolError('STATE_UNCERTAIN', 'The immutable file operation history is missing or changed; runtime reconciliation is required.');
    }
    entry.completed = true;
  }
  async function trace(event: Record<string, unknown>): Promise<void> {
    // Observability cannot turn a successfully persisted operation into a model retry.
    try { await callbacks.trace?.({ ...event, stage: binding.stage, at: now(),
      backend_binding: { workflow_id: binding.workflow_id, task_id: binding.task_id ?? null, invocation_id: binding.invocation_id },
      owner: 'runtime' }); } catch { /* advisory */ }
  }
  async function prepared<T>(schema: z.ZodType<T>, args: any,
    action: (value: T, source?: ControlledPayloadSource) => unknown | Promise<unknown>): Promise<unknown> {
    const payload = locked(state => resolveControlledPayload(root,
      Object.hasOwn(args, 'input_path') ? { input_path: args.input_path } : { input: args }, {
        sourceAllowed(path) { publicTarget(root, path, binding.approved_inputs); assertReadable(binding, path); return true; },
        readHash: path => state.reads[key(path)],
        recordRead(path, sha256) { state.reads[key(path)] = sha256; saveState(state); },
        parse: value => schema.parse(value),
      }));
    await trace({ event: 'payload-resolved', source: payload.source ?? null,
      backend_input: controlledModelInput('prepared-payload', payload.input),
      validation: { rule: 'Semantic content normalized and validated against the assigned tool schema; prepared source is parsed once, and identity remains backend-bound.' }, owner: 'runtime' });
    activeAtCommit();
    if (payload.source) assertControlledPayloadCurrent(root, payload.source);
    return action(payload.input, payload.source);
  }
  function register(name: string, description: string, schema: z.ZodType, readOnly: boolean,
    action: (args: any) => unknown | Promise<unknown>): void {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, async (args: any) => {
      let phase: ControlledDiagnosticPhase = 'assert-active';
      try {
        if (closed) throw new ControlledToolError('ACTOR_INACTIVE', 'This worker session has ended.');
        await callbacks.assertActive();
        phase = 'request-encoding';
        await trace({ event: 'tool-request', tool: name, model_input: controlledModelInput(name, args), owner: 'runtime',
          backend_binding: { workflow_id: binding.workflow_id, task_id: binding.task_id ?? null, invocation_id: binding.invocation_id } });
        phase = 'operation';
        const result = await action(args);
        phase = 'result-encoding';
        const encoded = JSON.stringify(result ?? { saved: true });
        await trace({ event: 'tool-result', tool: name, status: 'succeeded' });
        return { content: [{ type: 'text' as const, text: encoded }] };
      } catch (error) {
        const known = error instanceof ControlledToolError || error instanceof ControlledPayloadError || error instanceof ControlledEvidenceScanTimeout;
        const validation = error instanceof z.ZodError ? controlledValidation('SCHEMA_INVALID', undefined, error.issues)
          : controlledValidation(known ? error.code : undefined, known ? error.message : undefined);
        const ownership = error instanceof ControlledToolError && error.ownership ? redactControlledValue(error.ownership) as Record<string, unknown> : {};
        await trace({ event: 'tool-result', tool: name, status: 'failed', code: validation.code, validation,
          request_sha256: hash(JSON.stringify(args)), ...ownership,
          ...(!known && !(error instanceof z.ZodError) ? { diagnostic: controlledOperationDiagnostic(phase, name, error) } : {}) });
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: validation.rule, code: validation.code,
          validation, ...ownership }) }] };
      }
    });
  }
  register('project_read', 'Read an assigned UTF-8 file. The backend retains its version for subsequent scoped edits.',
    z.strictObject({ path: z.string().min(1).max(1024), max_chars: z.number().int().min(128).max(64000).optional(),
      start_line: z.number().int().min(1).optional() }), true, args => {
      if (args.path === controlledGuidePath) return controlledRuntimeGuide(args.start_line ?? 1, args.max_chars ?? 64000);
      const approved = binding.stage === 'planning' && controlledSkillInputPath(args.path)
        ? [...(binding.approved_inputs ?? []), args.path] : binding.approved_inputs;
      const target = publicTarget(root, args.path, approved); assertReadable(binding, args.path);
      if (!existsSync(target)) {
        locked(state => { state.reads[key(args.path)] = null; saveState(state); });
        return { path: args.path, exists: false, text: null };
      }
      const info = lstatSync(target);
      if (!info.isFile() || info.nlink > 1 || info.size > 2 * 1024 * 1024)
        throw new ControlledToolError('INVALID_FILE', 'Read an ordinary, unlinked text file up to 2 MiB.');
      const bytes = readFileSync(target);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new ControlledToolError('INVALID_FILE', 'The file is not valid UTF-8 text.'); }
      if (content.includes('\0')) throw new ControlledToolError('INVALID_FILE', 'Binary files require an appropriate artifact tool.');
      locked(state => { state.reads[key(args.path)] = hash(bytes); saveState(state); });
      const start = args.start_line ?? 1, excerpt = content.split(/\r?\n/).slice(start - 1).join('\n'), maximum = args.max_chars ?? 64000;
      return { path: args.path, exists: true, size_bytes: bytes.length, start_line: start,
        text: excerpt.slice(0, maximum), truncated: excerpt.length > maximum };
    });
  register('runtime_context', 'Read one backend-attested session snapshot with actual toolchain versions. Completed preflight leads to professional work, not repeated discovery. Identical queries reuse that snapshot. Optional executable paths must come from observed configuration; only fixed --version is executed. Invalid optional paths return per-tool diagnostics without invalidating the session.',
    controlledRuntimeQuerySchema, true, query => {
      if (!callbacks.runtimeContext) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Runtime observations require an active backend-owned session.');
      return callbacks.runtimeContext(query);
    });
  function walk(directory: string, limit = 200): { files: string[]; truncated: boolean } {
    const target = publicTarget(root, directory); assertReadable(binding, directory, true);
    if (!existsSync(target)) return { files: [], truncated: false };
    const files: string[] = [], queue = [directory]; let examined = 0;
    while (queue.length && files.length < limit && examined < 5000) {
      const parent = queue.shift()!;
      for (const entry of readdirSync(publicTarget(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = parent === '.' ? entry.name : `${parent}/${entry.name}`;
        if (++examined > 5000 || files.length >= limit) return { files, truncated: true };
        if (privatePath(path) || entry.isSymbolicLink()) continue;
        try { canonical(path); publicTarget(root, path); assertReadable(binding, path, entry.isDirectory()); }
        catch { continue; }
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile()) files.push(path);
      }
    }
    return { files, truncated: !!queue.length || examined >= 5000 };
  }
  register('project_list', 'List readable project files; private runtime, credential and dependency directories are excluded.',
    z.strictObject({ path: z.string().min(1).max(1024).default('.'), limit: z.number().int().min(1).max(1000).default(200) }), true,
    args => walk(args.path, args.limit));
  register('project_search', 'Find literal text in one readable project file or a public readable directory tree without invoking a shell. An exact approved hidden skill input can be searched as a file; its approval never permits directory traversal or sibling files.',
    z.strictObject({ query: z.string().min(1).max(1000), path: z.string().min(1).max(1024).default('.'),
      max_matches: z.number().int().min(1).max(100).default(40) }), true, args => {
      const selected = publicTarget(root, args.path, binding.approved_inputs);
      assertReadable(binding, args.path, true);
      const info = lstatSync(selected);
      if (info.isDirectory()) publicTarget(root, args.path); // Exact file approvals never authorize private traversal.
      assertReadable(binding, args.path, info.isDirectory());
      if (!info.isFile() && !info.isDirectory() || info.isFile() && (info.nlink !== 1 || info.size > 2 * 1024 * 1024))
        throw new ControlledToolError('INVALID_FILE', 'Search an ordinary unlinked text file up to 2 MiB, or a readable directory.');
      const found = info.isFile() ? { files: [args.path], truncated: false } : walk(args.path, 1000);
      const matches: { path: string; line: number; text: string }[] = [];
      for (const path of found.files) {
        const target = publicTarget(root, path, binding.approved_inputs), info = lstatSync(target);
        if (info.size > 2 * 1024 * 1024 || info.nlink > 1) continue;
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(target)); } catch { continue; }
        if (content.includes('\0')) continue;
        for (const [line, value] of content.split(/\r?\n/).entries()) if (value.includes(args.query)) {
          matches.push({ path, line: line + 1, text: value.slice(0, 1000) });
          if (matches.length >= args.max_matches) return { matches, truncated: true };
        }
      }
      return { matches, truncated: found.truncated };
    });
  if (controlledToolNames(binding).includes('task_file_write'))
    register('task_file_write', 'Write complete UTF-8 content within this stage scope. Read existing files first; the backend binds their versions and records recoverable operations.',
      z.strictObject({ path: z.string().min(1).max(1024), content: z.string().max(128 * 1024) }), false, args => {
        publicTarget(root, args.path); assertWritable(binding, args.path);
        try { workspaceContentBytes(args.content); }
        catch { throw new ControlledToolError('INVALID_FILE', 'Write valid UTF-8 text up to 128 KiB without binary control characters.'); }
        return locked(state => withOperationLock(root, workspacePathLockKey(args.path), () => {
          activeAtCommit();
          let current: Buffer | null;
          try { current = workspaceFileBytes(root, args.path); }
          catch { throw new ControlledToolError('INVALID_FILE', 'This target is not an ordinary editable UTF-8 project file.'); }
          const currentHash = current === null ? null : hash(current), nextHash = hash(args.content);
          const priorWrite = state.writes.findLast(item => item.path === args.path && item.sha256 === nextHash);
          if (priorWrite && currentHash === nextHash) {
            completeWrite(priorWrite); state.reads[key(args.path)] = nextHash; saveState(state);
            return { path: args.path, saved: true, replayed: true };
          }
          const observed = state.reads[key(args.path)];
          if (observed === undefined && current !== null)
            throw new ControlledToolError('READ_REQUIRED', 'Read the existing file before editing it; its current content will be preserved.');
          if ((observed ?? null) !== currentHash)
            throw new ControlledToolError('INPUT_CHANGED', 'This file changed after the last read. Read it again and preserve the new edits.');
          const operation = hash(JSON.stringify({ binding_hash: bindingHash, path: args.path, previous_hash: currentHash, sha256: nextHash }));
          const folder = `${base}/writes/${operation}`;
          const intent = { schema_version: 1, operation, binding_hash: bindingHash, path: args.path,
            previous_hash: currentHash, sha256: nextHash };
          for (const [path, bytes] of [[`${folder}/intent.json`, Buffer.from(`${JSON.stringify(intent, null, 2)}\n`)],
            [`${folder}/next.utf8`, Buffer.from(args.content)],
            ...(current === null ? [] : [[`${folder}/previous.utf8`, current] as const])] as const) {
            const target = safePath(root, path);
            if (existsSync(target) && !readFileSync(target).equals(bytes))
              throw new ControlledToolError('STATE_UNCERTAIN', 'The immutable file operation history changed; runtime reconciliation is required.');
            if (!existsSync(target)) atomicWrite(target, bytes);
          }
          let entry = state.writes.find(item => item.operation === operation);
          if (!entry) { entry = { operation, path: args.path, previous_hash: currentHash, sha256: nextHash, completed: false }; state.writes.push(entry); saveState(state); }
          try { replaceWorkspaceFile(root, { path: args.path, content: args.content, expected_hash: currentHash,
            authorize: () => { activeAtCommit(); assertWritable(binding, args.path); } }); }
          catch (error) {
            if (error instanceof ControlledToolError || error instanceof ControlledEvidenceScanTimeout) throw error;
            throw new ControlledToolError('INPUT_CHANGED', 'File replacement could not complete safely. Current edits and the operation history were preserved; read the file again.');
          }
          completeWrite(entry); state.reads[key(args.path)] = nextHash; saveState(state);
          return { path: args.path, saved: true, replayed: false };
        }));
      });
  if (binding.stage === 'planning') {
    const schema = binding.procedure_registration_required
      ? controlledPlanSchema.required({ procedure_candidate: true })
      : controlledPlanSchema.omit({ procedure_candidate: true });
    const submission = controlledPlanRequestSchemas(schema, binding.plan_defaults);
    register('workflow_plan', 'Save one semantic plan or send input_path alone for a prepared JSON plan. Backend supplies missing title and objective from this saved workflow when bound, normalizes unambiguous content, creates and links records and applies the minimum risk policy. Supply the professional rationale, scopes, deliverables and independent check design.\n' + controlledPlanSubmissionGuide(controlledPlanSchema), controlledPayloadSchema(submission.schema),
      false, args => prepared(submission.parseSchema, args, (plan, source) => {
        if (!callbacks.submitPlan) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Planning is unavailable in this invocation.');
        return callbacks.submitPlan(plan, source);
      }));
    register('work_prepare', 'Inspect reusable procedure applicability. Matching is advisory; the controller authorizes execution.',
      z.strictObject({ request: text.max(20000), parameters: z.record(z.string(), z.unknown()).optional() }), true, query => {
        if (!callbacks.prepareWork) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Reuse discovery is unavailable in this invocation.');
        return callbacks.prepareWork(query);
      });
  }
  if (binding.stage === 'verification')
    register('check_run', 'Run a prescribed independent check. The backend selects its saved command and captures execution evidence.',
      z.strictObject({ title: text.max(256).optional() }), false, args => {
        if (args.title && binding.check_titles && !binding.check_titles.includes(args.title))
          throw new ControlledToolError('INVALID_CHECK', 'Choose one of the prescribed check titles supplied in the assignment.');
        if (!callbacks.runCheck) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Check execution is unavailable in this invocation.');
        return callbacks.runCheck(args.title);
      });
  if (['implementation', 'verification', 'review', 'synthesis', 'diagnosis'].includes(binding.stage))
    register('check_evidence', 'Read actual bound independent-check and producer-execution evidence (default execution kind). Omit title for all assigned evidence, or select an exact frozen check or producer execution_steps title. Entries identify their distinct provenance; a successful producer operation is not independent verification. Use kind workflow for original preservation and report lifecycle, or kind registration for the bound manifest. No private registry access or caller-provided identities.',
      z.strictObject({ title: text.max(256).optional().describe('Exact assigned check or producer operation title. Omit to inspect all bound execution evidence; unknown selectors return available canonical titles.'), kind: z.enum(['execution', 'registration', 'workflow']).default('execution') }), true, args => {
        if (!callbacks.readEvidence) throw new ControlledToolError('NO_CHECK_EVIDENCE', 'No bound check evidence is available in this session.');
        return callbacks.readEvidence(args.title, args.kind);
      });
  if (binding.stage === 'implementation') {
    if (binding.execution_steps === undefined || binding.execution_steps.length) {
    const schema = binding.execution_steps === undefined ? controlledExecutionSchema.extend({ input: z.record(z.string(), z.unknown()).optional(), input_path: z.string().min(1).max(1024).optional() }) : z.strictObject({
      title: text.max(256).describe('Choose a declared execution_steps title. Backend supplies its argv, inputs, outputs and limits.'),
      input: z.record(z.string(), z.unknown()).optional().describe('Direct semantic JSON data; runtime supplies all internal identity.'),
      input_path: z.string().min(1).max(1024).optional().describe('Readable prepared JSON data file. Backend reads, parses and captures its input baseline; use instead of input, without recopying serialized tool text.') });
    register('task_run', 'Execute a scoped direct local script or fixed version observation. Backend validates the plan/role, supplies cwd/identity/hashes, retains the actual bounded result and prevents duplicate effects. This is not procedure qualification or independent acceptance evidence.',
      schema, false, async args => {
        if (!callbacks.runTask) throw new ControlledToolError('UNSUPPORTED_STAGE', 'Direct execution is unavailable in this invocation.');
        const step = binding.execution_steps?.find(step => step.title === args.title);
        if (binding.execution_steps !== undefined && !step) throw new ControlledToolError('INVALID_EXECUTION', 'Choose one of the declared execution step titles.');
        if (args.input_path !== undefined && args.input !== undefined)
          throw new ControlledToolError('INVALID_PAYLOAD', 'Use input_path or direct input, never both.');
        const { input_path: sourcePath, ...direct } = args;
        let source: ControlledPayloadSource | undefined;
        let input = args.input;
        if (sourcePath !== undefined) await prepared(z.record(z.string(), z.unknown()), { input_path: sourcePath }, (value, observed) => { input = value; source = observed; });
        const request = controlledExecutionSchema.parse(step ? { ...step, ...(input === undefined ? {} : { input }) } : { ...direct, ...(input === undefined ? {} : { input }) });
        const script = request.command.length > 1 && request.command[1] !== '--version' ? request.command[1] : undefined;
        if (script) locked(state => {
          const path = publicTarget(root, script, binding.approved_inputs); assertReadable(binding, script);
          const bytes = readFileSync(path);
          if (state.reads[key(script)] !== hash(bytes)) throw new ControlledToolError('READ_REQUIRED', 'Read the exact current project script before authorizing its local execution.');
        });
        activeAtCommit();
        if (source) assertControlledPayloadCurrent(root, source);
        return callbacks.runTask(request, source);
      });
    }
    if (binding.procedure_bound !== false) {
    register('procedure_run', 'Run only the qualified procedure bound in the plan; backend derives identity, scope and execution key.',
      z.strictObject({ parameters: z.record(z.string(), z.unknown()).optional() }), false, args => {
        if (!callbacks.runProcedure) throw new ControlledToolError('NO_BOUND_PROCEDURE', 'The plan has no currently eligible exact procedure.');
        return callbacks.runProcedure(args.parameters);
      });
    }
  }
  if (['implementation', 'synthesis'].includes(binding.stage) && !binding.evidence_documentation && binding.cornell_bound !== false) {
    const allowObserved = binding.stage === 'synthesis', allowStarter = binding.stage === 'synthesis' || binding.cornell_starter_allowed === true;
    const researchSchema = controlledCornellResearchSchema(allowObserved, allowStarter);
    const submissionSchema = controlledCornellSubmissionSchema(allowObserved, allowStarter);
    const boundSource = binding.stage === 'implementation' ? binding.cornell_source : undefined;
    const compile = (input: Record<string, unknown>, source?: ControlledPayloadSource) => {
      if (!callbacks.compileResearch) throw new ControlledToolError('NO_CORNELL_OUTPUT', 'The plan does not request Cornell output.');
      if (boundSource && (source?.path !== boundSource.path || source.sha256 !== boundSource.sha256))
        throw new ControlledToolError('INPUT_CHANGED', 'The prepared primary Cornell source differs from its immutable backend binding.');
      return callbacks.compileResearch(input, source);
    };
    if (boundSource) {
      register('cornell_research_compile', 'Compile the prepared primary Cornell source already bound by the backend. Call with {} or its exact input_path; the backend supplies the content and detects source changes. Do not copy or override research fields.',
        z.strictObject({ input_path: z.literal(boundSource.path).optional() }), false,
        () => prepared(researchSchema, { input_path: boundSource.path }, compile));
    } else {
    register('cornell_research_compile', (binding.stage === 'implementation'
      ? 'Compile the primary research deliverable with an expected worked example and separate questions/answers inside the assigned folder. Independent Verifier runs next. Observed-result fields and evidence identities are backend-owned at this stage; do not submit placeholder observations.'
      : 'Compile post-verification research using actual current independent evidence, with separate questions and answers inside the assigned note folder.') + controlledCornellSubmissionGuide,
      controlledPayloadSchema(submissionSchema), false,
      args => prepared(submissionSchema, args, (input, source) => compile(normalizeControlledCornellSubmission(input, allowObserved, allowStarter,
        input.date === undefined ? getRecord(root, binding.workflow_id).meta.created_at.slice(0, 10) : undefined), source)));
    }
  }
  const requiresVerdict = ['verification', 'review'].includes(binding.stage);
  const requiresFailureKind = binding.stage === 'diagnosis' && binding.role === 'manager';
  const reportSchema = controlledReportSubmissionSchema(controlledReportSchema, { requiresVerdict, requiresFailureKind });
  // The SDK needs a concrete root object. Role normalization/validation runs
  // after raw capture and prepared-source loading, before any report is saved.
  let reportInput = controlledPayloadSchema(controlledReportSchema);
  if (requiresVerdict || requiresFailureKind) {
    const metadata = reportInput.meta() ?? {};
    reportInput = reportInput.meta({ ...metadata, allOf: [...(Array.isArray(metadata.allOf) ? metadata.allOf : []), {
      if: { properties: { outcome: { const: 'completed' } }, required: ['outcome'] },
      then: { required: [requiresFailureKind ? 'failure_kind' : 'verdict'] },
    }] });
  }
  register('assignment_report', 'Persist one substantive compact result. Incomplete findings are retained without submitting the task.' +
    (binding.stage === 'planning' ? ' Planning reports do not claim delivered filesystem artifacts: omit artifacts; the backend binds its actual saved plan and records.' : '') +
    (requiresVerdict ? ' A completed verification or review must include an explicit verdict pass or fail; blocked or failed findings may omit it.' : '') +
    (requiresFailureKind ? ' A completed manager diagnosis must include failure_kind: implementation, checker, protocol, environment or unknown; use unknown when evidence remains inconclusive. Blocked or failed findings may omit it.' : ''),
    reportInput, false, args => prepared(reportSchema, args, (report, source) => {
      if (binding.stage === 'planning' && report.artifacts !== undefined) report = { ...report, artifacts: [] };
      for (const path of report.artifacts ?? []) { publicTarget(root, path, binding.approved_inputs); assertReadable(binding, path); }
      return callbacks.saveReport(report, source);
    }));
  return server;
}
