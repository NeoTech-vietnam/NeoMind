import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRuntimeInfo } from './runtime-info.js';
import { prepareReportedAssignment, recoverPreparedAssignment, claimReportedAssignment, resolveReportedAssignment, authorizeReportedAssignment, delegateAssignment, AssignmentContextError, type ReportedAssignment } from './native-assignment.js';
import { followUpNativeAssignment } from './native-recovery.js';
import { nativeSoftwarePlanSchema, planNativeSoftware, nextNativeSoftware, nativeSoftwareTaskContract } from './native-software.js';
import { openAssignment, assignmentContext, assignmentProgress, assignmentResult, assignmentResultJsonSchema, AssignmentRuntimeError } from './assignment-runtime.js';
import { listProcedures, discoverProcedureScripts, resolveProcedure, registerProcedure, registerProcedureSchema, reviewProcedure, qualifyProcedure, suspendProcedure, runProcedure } from './procedures.js';
import { prepareWork, type WorkPrepareInput } from './procedure-reuse.js';
import { reportAgentActivity } from './agent-activity.js';
import { legacyAgentProfiles as agentProfiles } from './agent-profiles.js';
import { relative } from 'node:path';
import {
  createRecord,
  getRecord,
  loadRecords,
  readConfig,
  updateRecord,
  safePath,
  hash,
  withOperationLock,
} from './storage.js';
import {
  acceptTask,
  assignmentReport,
  archiveEvidence,
  contextPacket,
  reviewTask,
  reviewRecord,
  runCheck,
  inspectCheck,
  recordFingerprint,
  startTask,
  resumeTask,
  requestRepair,
  submitTask,
  traceRecord,
  verify,
  structuralFindings,
  nativeWorkflowRecord,
} from './engineering.js';
import { searchMemory } from './indexing.js';
import { listPacks, installPack, prepareContribution, suggestPacks } from './packs.js';
import { recordTypes } from './types.js';
import type { ProjectRecord, RecordType, Link } from './types.js';
import { doctor } from './installer.js';
import { submitContribution } from './contributions.js';
import {
  beginWorkflow,
  discussWorkflow,
  decideWorkflow,
  discussionRoles,
  finishWorkflow,
  workflowStatus,
  bindManagerInvocation,
  readAutomationPolicy,
  type WorkflowInput,
} from './manager.js';
import {
  startNative,
  nativeStatus,
  waitNative,
  interruptNative,
  resumeNative,
  shutdownNative,
} from './native.js';
import {
  readInvocation,
  readRoutingPolicy,
  strongRoles,
  workerRoles,
  type NativeReceipt,
} from './routing.js';
import {
  authorizeOperation,
  describeCapabilities,
  resolveCapabilities,
  invokeCapability,
  closeCapabilitySessions,
} from './tools.js';
import {
  prepareArchive,
  publishArchive,
  archiveStatus,
  restoreArchive,
  reassessArchive,
} from './archives.js';
import {
  createCornellNote,
  reviseCornellNote,
  validateCornellNote,
  cornellKinds,
  type CornellInput,
} from './notes.js';
import {
  listRecipes,
  resolveRecipe,
  prepareRecipe,
  runRecipe,
  reviseRecipe,
  normalizeCornellOwnership,
  type RecipeInput,
} from './recipes.js';
import { managedRun, type ManagedRunInput } from './managed.js';
import { controlledStatus, controlControlledWorkflow, hasControlledWorkflow, type ControlledSnapshot } from './controlled-workflow.js';
import { ControlledIntakeDeliveryError } from './controlled-intake-delivery.js';
import { controlledCommandReceipt, isControlledCommandSnapshot } from './controlled-command-receipt.js';
import { controlledLegacyStatusList, controlledStatusList, controlledStatusView } from './controlled-status-view.js';
import { workspaceWrite } from './workspace.js';
import { checkpointLightweight } from './lightweight.js';
import { validateEvidenceInputs, type EvidenceInputSnapshot } from './evidence-inputs.js';
import { readAgentMap } from './agent-map.js';
import { isNativeExecutionMode } from './execution-mode.js';
import { cornellResearchSchema, compileCornellResearch } from './cornell-workflow.js';
import { reaStatus } from './rea.js';
import { validatePlatform } from './platform-validation.js';
import { listUpstreams, discoverUpstreams, trackUpstream, checkUpstream, cloneUpstream, adoptUpstreamUpdate, readUpstreamInstructions } from './upstreams.js';

/** Resolve execution compatibility at the native-receipt/MCP procedure boundary. */
export function procedureExecutionClient(workflowMode: unknown, receipt?: Pick<NativeReceipt, 'issuer'> | null): 'codex' | 'copilot' {
  if (receipt) {
    if (receipt.issuer.endsWith('-codex-app-server')) return 'codex';
    if (receipt.issuer.endsWith('-vscode-lm')) return 'copilot';
    throw new Error('Procedure compatibility requires a recognized signed native client issuer.');
  }
  return workflowMode === 'codex-native' ? 'codex' : 'copilot';
}

const preparationText = z.string().regex(/\S/, 'Use a nonblank string.');
/** Advertise the authoritative parser's semantic fields without transforming original request or parameter bytes. */
const workPreparationSchema = z.strictObject({
  request: preparationText.max(20_000).describe('The complete original request. Preserve its text; workflow IDs are derived elsewhere and are not accepted here.'),
  request_id: preparationText.max(200).optional(),
  intent_id: preparationText.max(200).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(preparationText).max(100).optional(),
  outputs: z.array(preparationText).max(100).optional(),
  procedure_id: preparationText.max(200).optional(),
  procedure_version: preparationText.max(200).optional().describe('An optional exact version; requires procedure_id.'),
  environment: z.strictObject({
    platform: preparationText.optional(), arch: preparationText.optional(), client: preparationText.optional(),
    node: preparationText.optional(), tools: z.record(z.string(), preparationText).optional(),
  }).optional(),
  scope: z.strictObject({
    allowed_paths: z.array(preparationText).max(100).optional(), network: z.boolean().optional(),
    publication: z.boolean().optional(), mode: preparationText.optional(), assurance: preparationText.optional(),
  }).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}) satisfies z.ZodType<WorkPrepareInput>;

const cornellNoteSchema = z
  .object({
    topic: z.string().describe('The substantive engineering or learning topic.'),
    kind: z.enum(cornellKinds),
    path: z
      .string()
      .optional()
      .describe(
        'Visible project-relative note path using forward slashes. Explicitly required for task-bound native work; unbound legacy calls retain the core default.',
      ),
    owner: z
      .string()
      .optional()
      .describe('Legacy record owner; the native gateway supplies the actual bound role.'),
    date: z
      .string()
      .optional()
      .describe('Optional note date; the core supplies today when omitted.'),
    context: z.string(),
    constraints: z.array(z.string()),
    cues: z.array(z.string()),
    main_notes: z
      .string()
      .describe(
        'Source-cited notes labelled [observed], [source-reported], [expected], or [inferred].',
      ),
    sources: z.array(
      z
        .object({
          id: z
            .string()
            .describe('Citation identity such as S1, referenced as [S1] in the main notes.'),
          title: z.string(),
          uri: z
            .string()
            .describe('Official source URL, canonical local source path, or record:RECORD_ID.'),
          retrieved_at: z.string().describe('Actual ISO retrieval timestamp.'),
          locator: z.string().optional(),
          record_id: z.string().optional(),
          sha256: z.string().optional(),
        })
        .strict(),
    ),
    demonstration: z
      .object({
        body: z.string(),
        expected: z
          .string()
          .describe('Expected result stated separately from actual execution evidence.'),
        command: z
          .array(z.string())
          .optional()
          .describe(
            'Executable and individual arguments, for example ["node", "demo.mjs"]; never a shell-command string.',
          ),
        observed: z
          .string()
          .optional()
          .describe('Actual observation only; requires passing current evidence_ids.'),
        evidence_ids: z.array(z.string()).optional(),
      })
      .strict(),
    failure_cases: z.array(z.string()),
    practice: z
      .object({
        exercise_path: z
          .string()
          .describe('Canonical project-relative path of the separate practice exercise.'),
        exercise: z.string().describe('Substantive exercise artifact content.'),
        answer_path: z
          .string()
          .describe(
            'Canonical project-relative path of the separate answer artifact; distinct from exercise_path.',
          ),
        answer: z.string().describe('Substantive answer artifact content.'),
        command: z
          .array(z.string())
          .optional()
          .describe('Executable and individual arguments for runnable practice.'),
        mode: z.enum(['runnable', 'manual']).optional(),
        procedure: z.array(z.string()).optional(),
        solution_path: z
          .string()
          .optional()
          .describe(
            'Optional separate user solution path; existing authored solutions are preserved.',
          ),
        starter: z
          .string()
          .optional()
          .describe(
            'Initial solution content used only when solution_path does not already exist.',
          ),
      })
      .strict(),
    summary: z.string(),
    research: z.object({ schema_version: z.literal(1), input_hash: z.string(), requirement_id: z.string(),
      requirement_revision: z.number().int().positive(), requirement_fingerprint: z.string(), abstract: z.string(),
      learning_objectives: z.array(z.object({ id: z.string(), text: z.string() }).strict()) }).strict().optional(),
    requirement_ids: z.array(z.string()).optional(),
    problem_ids: z.array(z.string()).optional(),
    workflow_id: z.string().optional().describe(
      'Manager workflow ownership. For unsigned copilot-native calls, supply explicitly for source-only notes or omit only when linked records identify one workflow; all references must share that workflow.',
    ),
    root_cause: z
      .object({
        reproduction: z.string(),
        hypotheses: z.array(z.string()),
        eliminating_evidence: z.string(),
        conclusion: z.enum(['confirmed', 'unresolved']),
        cause: z.string(),
        repair: z.string(),
        regression: z.string(),
      })
      .strict()
      .optional()
      .describe(
        'Required by the core when kind is root-cause; distinguish confirmed diagnosis from unresolved hypotheses.',
      ),
  })
  .strict() satisfies z.ZodType<CornellInput>;

export interface McpBinding {
  invocation_id?: string;
}
function privateProjectPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.split('/').some((part) => part === '.git' || part === 'node_modules') ||
    /^\.(?:verythinker|taskforces|neomind)\/(?:cache|tools|runs|native\/reported-assignments)(?:\/|$)/.test(lower) ||
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials?(?:\.json)?|private[^/]*\.pem|id_(?:rsa|ed25519)(?:\.pub)?)$/.test(
      lower,
    )
  );
}
export function projectRead(
  root: string,
  input: { path: string; max_chars?: number; start_line?: number },
  receipt: NativeReceipt | null = null,
): unknown {
  const maximum = input.max_chars ?? 12000;
  if (!Number.isSafeInteger(maximum) || maximum < 128 || maximum > 64000)
    throw new Error('Project read budget must be between 128 and 64000 characters.');
  if (
    input.start_line !== undefined &&
    (!Number.isSafeInteger(input.start_line) || input.start_line < 1)
  )
    throw new Error('Project read starting line must be positive.');
  const target = safePath(root, input.path),
    physicalPath = relative(root, target).replaceAll('\\', '/');
  const path = physicalPath.replace(/^\.(?:verythinker|taskforces|neomind)(?=\/|$)/, '.neomind');
  const lower = path.toLowerCase();
  if ((input.path.replace(/^\.(?:verythinker|taskforces)(?=\/|$)/, '.neomind') !== path && input.path !== physicalPath) || privateProjectPath(path))
    throw new Error(
      'Private credentials, raw sessions, runtime caches, and noncanonical paths are unavailable through project_read.',
    );
  const inputArtifacts = new Set<string>();
  const privateInputArtifacts = new Set<string>();
  if (receipt && (receipt.task_id || lower.startsWith('.neomind/evidence/inputs/'))) {
    const scope = recordScope(root, receipt);
    for (const evidence of loadRecords(root).filter(
      (record) => scope.has(record.meta.id) && record.meta.type === 'evidence',
    )) {
      const data = evidence.meta.data;
      if (!data.input_snapshot) continue;
      if (typeof data.task_id !== 'string') continue;
      const task = getRecord(root, data.task_id);
      if (
        (receipt.task_id && task.meta.id !== receipt.task_id) ||
        (receipt.workflow_id && task.meta.data.workflow_id !== receipt.workflow_id)
      )
        continue;
      const manifest = validateEvidenceInputs(root, data.input_snapshot as EvidenceInputSnapshot, {
        files: data.file_baseline as Record<string, string>,
        record_fingerprints: data.record_baseline as Record<string, string>,
        check_id: typeof data.check_id === 'string' ? data.check_id : undefined,
        check_fingerprint:
          typeof data.check_fingerprint === 'string' ? data.check_fingerprint : undefined,
      });
      inputArtifacts.add((data.input_snapshot as EvidenceInputSnapshot).manifest_path);
      for (const [originalPath, artifact] of [
        ...Object.entries(manifest.files),
        ...Object.entries(manifest.context_files),
        ...Object.values(manifest.records).map((artifact) => [artifact.path, artifact] as const),
      ]) {
        if (privateProjectPath(originalPath)) privateInputArtifacts.add(artifact.blob_path);
        else inputArtifacts.add(artifact.blob_path);
      }
    }
    for (const artifact of privateInputArtifacts) inputArtifacts.delete(artifact);
  }
  if (lower.startsWith('.neomind/evidence/inputs/') && !inputArtifacts.has(path))
    throw new Error('Captured input artifact is outside the assigned verified evidence scope.');
  if (receipt?.task_id) {
    const scope = recordScope(root, receipt),
      task = getRecord(root, receipt.task_id),
      permitted = new Set<string>(inputArtifacts),
      exactReferences = new Set<string>();
    const addPaths = (data: Record<string, unknown>) => {
      for (const key of ['verification_artifact_paths', 'oracle_paths'])
        if (Array.isArray(data[key]))
          for (const reference of data[key] as unknown[])
            if (typeof reference === 'string') exactReferences.add(reference);
      for (const key of [
        'allowed_paths',
        'baseline_paths',
        'documentation_paths',
        'protected_acceptance_paths',
      ])
        for (const item of Array.isArray(data[key]) ? (data[key] as unknown[]) : [])
          if (typeof item === 'string')
            permitted.add(relative(root, safePath(root, item)).replaceAll('\\', '/'));
    };
    addPaths(task.meta.data);
    for (const record of loadRecords(root).filter((record) => scope.has(record.meta.id))) {
      permitted.add(record.path);
      if (record.meta.type === 'check' || record.meta.type === 'design') addPaths(record.meta.data);
      if (record.meta.type === 'evidence')
        for (const key of [
          'log_path',
          'receipt_path',
          'archived_log_path',
          'archived_receipt_path',
        ])
          if (typeof record.meta.data[key] === 'string')
            permitted.add(String(record.meta.data[key]));
      for (const key of ['file_baseline', 'protected_file_hashes', 'documentation_snapshot'])
        if (
          (record.meta.type === 'check' ||
            record.meta.type === 'evidence' ||
            record.meta.type === 'design') &&
          record.meta.data[key] &&
          typeof record.meta.data[key] === 'object'
        )
          for (const file of Object.keys(record.meta.data[key] as object)) permitted.add(file);
    }
    if (
      !exactReferences.has(path) &&
      ![...permitted].some(
        (prefix) => path === prefix || path.startsWith(prefix.replace(/\/$/, '') + '/'),
      )
    )
      throw new Error('Project source path is outside the assigned task inputs and outputs.');
  }
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw new Error('project_read accepts text files up to 2 MiB.');
  const bytes = readFileSync(target);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Use an appropriate media tool for binary content.');
  const startLine = input.start_line ?? 1,
    excerpt = text
      .split(/\r?\n/)
      .slice(startLine - 1)
      .join('\n');
  return {
    path,
    sha256: hash(bytes),
    size_bytes: bytes.length,
    start_line: startLine,
    text: excerpt.slice(0, maximum),
    truncated: excerpt.length > maximum,
  };
}
export function assertTaskOutputPaths(
  root: string,
  receipt: { task_id?: string | null } | null | undefined,
  paths: unknown[],
): void {
  if (!receipt?.task_id) return;
  const task = getRecord(root, receipt.task_id);
  const allowed = ['allowed_paths', 'documentation_paths']
    .flatMap((key) =>
      Array.isArray(task.meta.data[key]) ? (task.meta.data[key] as unknown[]) : [],
    )
    .filter((path): path is string => typeof path === 'string');
  for (const path of paths) {
    if (typeof path !== 'string')
      throw new Error('Task-bound documentation requires explicit output paths.');
    const normalized = relative(root, safePath(root, path)).replaceAll('\\', '/');
    if (
      normalized !== path ||
      !allowed.some(
        (prefix) => normalized === prefix || normalized.startsWith(prefix.replace(/\/$/, '') + '/'),
      )
    )
      throw new Error('Documentation output path is outside the assigned task scope.');
  }
}
function recordScope(root: string, receipt: NativeReceipt): Set<string> {
  const records = loadRecords(root);
  const seed = receipt.task_id ?? receipt.workflow_id;
  if (!seed) return new Set(records.map((record) => record.meta.id));
  const assignedTask = receipt.task_id;
  const scope = new Set([seed]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      // A task may refer to its coordinator, but that structural reference must
      // not expand the packet into every sibling assignment in the increment.
      if (
        assignedTask &&
        ((record.meta.type === 'task' && record.meta.id !== assignedTask) ||
          record.meta.data.kind === 'manager-workflow' ||
          record.meta.data.kind === 'manager-decision' ||
          (record.meta.data.task_id && record.meta.data.task_id !== assignedTask))
      )
        continue;
      const links = assignedTask
        ? record.meta.links.filter((link) => link.target !== receipt.workflow_id)
        : record.meta.links;
      const linked = scope.has(record.meta.id) || links.some((link) => scope.has(link.target));
      if (!linked) continue;
      for (const id of [record.meta.id, ...links.map((link) => link.target)])
        if (!scope.has(id)) {
          scope.add(id);
          changed = true;
        }
    }
  }
  return scope;
}
function operationBinding(
  root: string,
  operation: string,
  input: any,
): { workflow_id?: string; task_id?: string } {
  const result: { workflow_id?: string; task_id?: string } = {};
  if (typeof input.workflow_id === 'string') result.workflow_id = input.workflow_id;
  if (typeof input.task_id === 'string' || typeof input.task === 'string')
    result.task_id = input.task_id ?? input.task;
  if (
    typeof input.id === 'string' &&
    !operation.startsWith('native_') &&
    !operation.startsWith('archive_') &&
    !operation.startsWith('recipe_resolve')
  ) {
    const record = getRecord(root, input.id);
    if (record.meta.type === 'task') result.task_id = record.meta.id;
    if (typeof record.meta.data.workflow_id === 'string')
      result.workflow_id = record.meta.data.workflow_id;
    if (typeof record.meta.data.task_id === 'string') result.task_id = record.meta.data.task_id;
  }
  return result;
}
function scopedRecord(
  root: string,
  receipt: NativeReceipt | null,
  id: string,
): ReturnType<typeof getRecord> {
  const record = getRecord(root, id);
  if (receipt && !recordScope(root, receipt).has(id))
    throw new Error('Record is outside the assigned native context.');
  return record;
}
function authoredData(
  receipt: NativeReceipt | null,
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!receipt) return data;
  return {
    ...data,
    invocation_id: receipt.id,
    author_invocation_id: receipt.id,
    invocation_role: receipt.role,
    routing_required: true,
    ...(receipt.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
    ...(receipt.task_id ? { task_id: receipt.task_id } : {}),
  };
}
export function canAuthor(role: string, type: string): boolean {
  if (type === 'knowledge' || type === 'problem' || type === 'change') return role !== 'reviewer';
  if (type === 'requirement') return role === 'requirements';
  if (type === 'design') return ['architect', 'component-owner'].includes(role);
  if (type === 'check') return role === 'verifier';
  if (type === 'task')
    return ['manager', 'architect', 'component-owner', 'verifier'].includes(role);
  return false;
}
export function assertRecordPreview(
  root: string,
  input: { type: RecordType; title?: string; links?: Link[]; data?: Record<string, unknown> },
  prior?: ProjectRecord,
): void {
  const records = loadRecords(root);
  const candidate: ProjectRecord = {
    path: prior?.path ?? '',
    body: prior?.body ?? '',
    meta: {
      schema_version: 1,
      id: prior?.meta.id ?? '__neomind_new_record_preview__',
      type: input.type,
      title: input.title ?? prior?.meta.title ?? 'Record preview',
      owner: prior?.meta.owner ?? 'system',
      status: prior?.meta.status ?? 'draft',
      revision: prior?.meta.revision ?? 1,
      created_at: prior?.meta.created_at ?? '',
      updated_at: prior?.meta.updated_at ?? '',
      links: input.links ?? prior?.meta.links ?? [],
      data: { ...prior?.meta.data, ...input.data },
    },
  };
  const existing = new Set(structuralFindings(records).map((finding) => JSON.stringify(finding)));
  const findings = structuralFindings([
    ...records.filter((record) => record.meta.id !== candidate.meta.id),
    candidate,
  ]).filter(
    (finding) =>
      (finding.record === candidate.meta.id &&
        ['broken-link', 'invalid-link-type', 'invalid-dependency', 'invalid-requirement'].includes(
          finding.code,
        )) ||
      !existing.has(JSON.stringify(finding)),
  );
  if (findings.length) throw new Error(findings.map((finding) => finding.message).join('\n'));
}
const executionFields = new Set([
  'invocation_id',
  'requested_model',
  'confirmed_model',
  'attempts',
  'repair_attempts',
  'repair_requested_at',
  'feedback',
  'escalation_required',
  'submission',
  'submission_revision',
  'prior_invocation_ids',
  'status',
  'started_at',
  'resumed_at',
  'blocked_reason',
  'submitted_at',
  'accepted_at',
  'escalation_attempt',
  'escalation_feedback_sha256',
  'work_record_id',
  'documentation_snapshot',
  'workspace_writes',
]);
export function taskAuthorData(
  receipt: NativeReceipt | null,
  data: Record<string, unknown> = {},
  task?: ReturnType<typeof getRecord>,
): Record<string, unknown> {
  if (!receipt) return data;
  if (Object.keys(data).some((key) => executionFields.has(key)))
    throw new Error(
      'Task execution, repair, submission, and acceptance fields require dedicated core operations.',
    );
  if (data.escalation_invocation_id !== undefined || data.escalation_reason !== undefined) {
    if (
      !['manager', 'architect', 'component-owner'].includes(receipt.role) ||
      typeof data.escalation_reason !== 'string' ||
      data.escalation_reason.trim().length < 24 ||
      data.escalation_reason.length > 8000 ||
      !task
    )
      throw new Error(
        'Escalation requires a bounded substantive diagnosis from its strategic author.',
      );
    data = {
      ...data,
      escalation_reason: data.escalation_reason.trim(),
      escalation_invocation_id: receipt.id,
      escalation_attempt: task.meta.data.attempts,
      escalation_feedback_sha256: hash(String(task.meta.data.feedback ?? '')),
    };
  }
  const { invocation_id, ...planning } = authoredData(receipt, data);
  return planning;
}
const reservedKinds = new Set([
  'knowledge-research',
  'lightweight-workflow',
  'manager-decision',
  'manager-discussion',
  'work-record',
  'recipe-instance',
]);

function intakeArguments<T>(input: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as T;
}
export function assertGenericRecordMutation(
  record: ReturnType<typeof getRecord>,
  receipt: { role: string; task_id?: string | null },
): void {
  if (reservedKinds.has(String(record.meta.data.kind)))
    throw new Error(
      'Reserved workflow decisions, submissions, and frozen recipes must use their dedicated core operation.',
    );
  if (record.meta.data.kind === 'manager-workflow' && receipt.role !== 'manager')
    throw new Error('Only the manager can update its workflow clarification state.');
  if (
    [
      'researcher',
      'codebase-analyst',
      'curator',
      'developer',
      'check-executor',
      'release',
    ].includes(receipt.role) &&
    (record.meta.owner !== receipt.role ||
      (receipt.task_id && record.meta.data.task_id !== receipt.task_id))
  )
    throw new Error('Worker can update only its own assigned project documentation records.');
}

/**
 * Whether an unbound mutation targets a copilot-native increment. Native increments run the
 * full lifecycle with honest unsigned invocation IDs and therefore do not need a bound signed
 * MCP session even when the strict bridge is installed. A strict (routing_required) record
 * always resolves false, so this exception can never bypass the signed-session requirement.
 */
function nativeWorkflowMutation(root: string, name: string, input: Record<string, unknown>): boolean {
  if (['assignment_prepare', 'assignment_bootstrap', 'assignment_recover', 'assignment_claim', 'assignment_open'].includes(name)) return true;
  if (name.startsWith('upstream_'))
    return isNativeExecutionMode(readAutomationPolicy(root).execution_mode);
  if (name === 'manager_begin')
    return isNativeExecutionMode(input.execution_mode) ||
      (input.execution_mode === undefined && isNativeExecutionMode(readAutomationPolicy(root).execution_mode));
  if (name.startsWith('native_') || name === 'task_file_write' || name.startsWith('capability_'))
    return false;
  if (name === 'record_create') {
    const data = input.data as Record<string, unknown> | undefined;
    if (!data || reservedKinds.has(String(data.kind)) || data.kind === 'manager-workflow' ||
        ['evidence', 'review'].includes(String(input.type)) || typeof data.workflow_id !== 'string' ||
        ['intake_workflow_id', 'execution_mode', 'assurance', 'routing_required'].some((key) => Object.hasOwn(data, key)))
      return false;
    try {
      const parent = getRecord(root, data.workflow_id);
      return parent.meta.data.kind === 'manager-workflow' && nativeWorkflowRecord(root, parent) &&
        ((input.links ?? []) as { target: string }[]).every((link) => {
          const target = getRecord(root, link.target);
          return nativeWorkflowRecord(root, target) &&
            (target.meta.id === parent.meta.id || (target.meta.data.workflow_id ?? target.meta.data.intake_workflow_id) === parent.meta.id);
        });
    }
    catch { return false; }
  }
  if (name === 'archive_publish' || name === 'archive_restore') {
    try {
      const snapshot = archiveStatus(root, String(input.snapshot_id)) as { manifest?: { workflow_id?: string } };
      return !!snapshot.manifest?.workflow_id && nativeWorkflowRecord(root, getRecord(root, snapshot.manifest.workflow_id));
    } catch { return false; }
  }
  const ids = ['workflow_id', 'id', 'task', 'task_id', 'evidence_id', 'change_id', 'revision_id']
    .map((field) => input[field]).filter((value): value is string => typeof value === 'string');
  for (const field of ['target_ids', 'requirement_ids', 'task_ids', 'source_ids', 'knowledge_ids'])
    if (Array.isArray(input[field])) ids.push(...input[field] as string[]);
  if (Array.isArray(input.retired_candidates))
    ids.push(...(input.retired_candidates as { knowledge_id: string }[]).map((item) => item.knowledge_id));
  if (Array.isArray(input.links)) ids.push(...(input.links as { target: string }[]).map((link) => link.target));
  if (name === 'note_create' || (name === 'recipe_prepare' && input.recipe_id === 'cornell-evidence-note')) {
    // The transport normalizes and validates ownership fields before reaching this gateway.
    const note = (name === 'note_create' ? input.note : (input.parameters as { note: CornellInput }).note) as CornellInput;
    if (note.workflow_id) ids.push(note.workflow_id);
    ids.push(...(note.requirement_ids ?? []), ...(note.problem_ids ?? []),
      ...(note.demonstration?.evidence_ids ?? []),
      ...(note.sources ?? []).flatMap((source) => source.record_id ? [source.record_id] : []));
  }
  if (!ids.length) return false;
  try {
    const records = ids.map((id) => getRecord(root, id));
    const owners = records.map((record) => record.meta.data.kind === 'manager-workflow'
      ? record.meta.id : record.meta.data.workflow_id ?? record.meta.data.intake_workflow_id);
    return records.every((record) => nativeWorkflowRecord(root, record)) &&
      owners.every((id) => typeof id === 'string' && id === owners[0]);
  } catch { return false; }
}

import { discoverProjectKnowledge, searchProjectKnowledge, recordKnowledgeResearch } from './knowledge-reuse.js';
import { publishProjectKnowledge } from './project-knowledge.js';

export function createMcpServer(root: string, binding: McpBinding = {}): McpServer {
  const runtimeInfo = createRuntimeInfo(root);
  readConfig(root);
  if (!binding.invocation_id && readConfig(root).execution_engine === 'opencode') return createWorkForceMcpServer(root);
  const controlledParent = !binding.invocation_id && readAutomationPolicy(root).execution_mode === 'neomind-controlled';
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const server = new McpServer({ name: 'neomind', version: packageJson.version });
  const ownerToken = randomUUID();
  server.server.onclose = () => {
    void shutdownNative(root, ownerToken);
    void closeCapabilitySessions(root, binding.invocation_id);
  };
  const bound = () => (binding.invocation_id ? readInvocation(root, binding.invocation_id) : null);
  const reportedContext = new AsyncLocalStorage<ReportedAssignment>();
  const privateHandles = new AsyncLocalStorage<{ id: string; token: string }>();
  const reported = () => reportedContext.getStore();
  const reportedData = (data: Record<string, unknown> = {}, taskPlanning = false) => {
    const actor = reported();
    if (!actor) return data;
    const attributed: Record<string, unknown> = { ...data, ...(!taskPlanning ? { invocation_id: actor.id } : {}),
      author_invocation_id: actor.id, identity_assurance: actor.assurance, reported_assignment_id: actor.id,
      workflow_id: actor.workflow_id, ...(actor.task_id ? { task_id: actor.task_id } : {}) };
    if (taskPlanning) delete attributed.invocation_id;
    return attributed;
  };
  const output = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });
  const tool = (
    name: string,
    description: string,
    schema: Record<string, z.ZodType>,
    action: (input: any) => unknown,
    readOnly = true,
    external = false,
  ) => {
    // Creating/recovering packets requires no session; opening/claiming validates
    // packet credentials. Advertising a session here caused fabricated handles.
    const bootstrap = ['assignment_bootstrap', 'assignment_recover', 'assignment_open', 'assignment_claim'].includes(name);
    // Unbound management entrypoints accept user work regardless of the saved
    // execution mode; they do not authenticate a worker. Old clients can retain the former optional
    // credential field; strip it as unknown input instead of resolving it as an
    // assignment or teaching the parent model to construct another credential.
    const publicEntrypoint = !binding.invocation_id && ['manager_run', 'manager_status', 'manager_control'].includes(name);
    server.registerTool(
      name,
      {
        description,
        inputSchema: publicEntrypoint ? z.object(schema) : bootstrap ? z.strictObject(schema) : z.object({ ...schema,
          reported_assignment: z.object({ id: z.string().regex(/^local-report-[a-f0-9]{40}$/), token: z.string().min(1) }).strict().optional()
            .describe('Use only the private handle returned by assignment_open (or access credential from assignment_claim). Omit this entire field until that call succeeds. A packet claim_token is not an access token; never copy it here.') }).apply(schema => ['assignment_delegate', 'assignment_followup', 'assignment_start', 'assignment_check', 'assignment_review', 'workflow_plan', 'workflow_next'].includes(name) ? schema.strict() : schema),
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: external },
      },
      async (input: any) => {
        try {
          const credentialHandle = input.reported_assignment;
          if (['assignment_prepare', 'assignment_bootstrap'].includes(name) &&
              (input.task_id === null || (typeof input.task_id === 'string' && !input.task_id.trim()))) {
            input = { ...input };
            delete input.task_id;
          }
          if (name === 'note_create') {
            // Native tool clients can serialize absent optional revision fields as
            // null or blank text. Normalize only these placeholders before ownership
            // resolution; nonempty targets and all actual revision gates stay intact.
            input = { ...input };
            for (const field of ['revision_id', 'revision_reason'])
              if (input[field] === null ||
                  (typeof input[field] === 'string' && !input[field].trim()))
                delete input[field];
            if (input.expected_revision === null) delete input.expected_revision;
          }
          const receipt = bound();
          let actor: ReportedAssignment | undefined;
          if (input.reported_assignment) {
            if (receipt) throw new Error('Signed invocations cannot replace their identity with an unsigned local assignment.');
            try {
              actor = resolveReportedAssignment(root, input.reported_assignment);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/Invalid or unclaimed local assignment session|Invalid local reported assignment identity|ENOENT.*reported-assignments/i.test(message))
                throw error;
              throw new AssignmentRuntimeError('AUTH_REQUIRED', 'authenticate', message,
                'Coordinator: use credential-free assignment_bootstrap to prepare a bounded packet, or assignment_recover with workflow_id and packet_id for an existing unclaimed packet. Pass the returned handoff unchanged to the actual local delegate. The delegate calls assignment_open with exactly open_input; omit reported_assignment on bootstrap, recover, open and claim. Use only the returned handle on later scoped calls. Never use a claim token as an access token.');
            }
            const { reported_assignment: _credential, ...operationInput } = input;
            input = operationInput;
            if (name === 'record_create' && input.data?.workflow_id === undefined)
              input = { ...input, data: { ...input.data, workflow_id: actor.workflow_id } };
            authorizeReportedAssignment(root, actor, name, input, readOnly);
            if (['requested_model', 'confirmed_model'].some(key => input[key] !== undefined))
              throw new Error('A local assignment identity cannot attest model observations.');
            if (input.owner !== undefined && name !== 'record_create' && input.owner !== actor.role)
              throw new Error('A reported assignment cannot impersonate another record owner.');
            input = { ...input, invocation_id: actor.id, ...(['assignment_prepare', 'agent_activity'].includes(name) ? {} : { role: actor.role }) };
            if (name === 'agent_activity') delete input.role; // Authorization checked any explicit role; the activity contract derives it from profile.
            if (['record_review', 'task_review'].includes(name)) input.owner = actor.role;
          } else if ([input.invocation_id, input.data?.invocation_id, input.data?.author_invocation_id]
            .some(value => typeof value === 'string' && value.startsWith('local-report-'))) {
            throw new Error('Server-issued local assignment IDs require their reported_assignment credential; another actor cannot reuse them.');
          }
          const cornell = name === 'note_create' ||
            (name === 'recipe_prepare' && input.recipe_id === 'cornell-evidence-note');
          if (!receipt && cornell) {
            const parameters = input.parameters as Record<string, unknown> | undefined;
            const ownership = normalizeCornellOwnership(
              root,
              (name === 'note_create' ? input.note : parameters?.note) as CornellInput,
              input,
            );
            input = name === 'note_create'
              ? { ...input, note: ownership.note }
              : {
                  ...input,
                  ...(ownership.workflow_id ? { workflow_id: ownership.workflow_id } : {}),
                  parameters: { ...parameters, note: ownership.note },
                };
          }
          if (receipt) {
            if (name === 'agent_activity')
              throw new Error('Unsigned activity reporting requires the native client; signed sessions use their existing receipts.');
            if (name === 'lightweight_checkpoint')
              throw new Error('Lightweight checkpoints require the native client, not a signed worker session.');
            if (!readOnly && receipt.state !== 'running')
              throw new Error('New MCP mutations require a currently running native invocation.');
            if (name === 'manager_run' || name === 'manager_begin')
              throw new Error(
                'A bound invocation must resume its existing workflow; recursive intake is forbidden.',
              );
            authorizeOperation(root, receipt.id, name, operationBinding(root, name, input));
            if (
              typeof input.id === 'string' &&
              !name.startsWith('native_') &&
              !name.startsWith('archive_') &&
              !name.startsWith('recipe_resolve')
            )
              scopedRecord(root, receipt, input.id);
          } else if (
            !readOnly &&
            readRoutingPolicy(root) &&
            !['manager_run', 'manager_control', 'lightweight_checkpoint', 'agent_activity'].includes(name) &&
            !nativeWorkflowMutation(root, name, input) &&
            !(actor && (name.startsWith('procedure_') || name.startsWith('assignment_') || name.startsWith('workflow_')))
          ) {
            if (cornell) {
              const note = (name === 'note_create' ? input.note :
                (input.parameters as Record<string, unknown>).note) as CornellInput;
              if (!note.workflow_id)
                throw new Error(
                  'Cornell workflow ownership is missing. Supply note.workflow_id (or recipe_prepare.workflow_id), or link records owned by one workflow. Local source files do not identify a workflow; no latest workflow is selected.',
                );
              throw new Error(
                `Cornell workflow ${note.workflow_id} or its referenced records are strict/non-native. Use only same-workflow copilot-native records for an unsigned call; strict work requires its invocation-bound MCP session.`,
              );
            }
            throw new Error(
              'Strict managed mutations require an invocation-bound MCP session. Start ordinary requirements through manager_run and launch its returned handoff agent. Reported invocation IDs have no signed native_status receipt.',
            );
          }
          return output(await (actor ? reportedContext.run(actor, () =>
            privateHandles.run(credentialHandle, () => action(input))) : action(input)));
        } catch (error) {
          return {
            ...output({ error: error instanceof Error ? error.message : String(error),
              ...(error instanceof AssignmentRuntimeError ? { code: error.code, phase: error.phase,
                retryable: error.retryable, next_action: error.next_action } : {}),
              ...(error instanceof AssignmentContextError ? { code: error.code, retryable: false, next_action: error.next_action } : {}),
              ...(error instanceof ControlledIntakeDeliveryError ? { code: error.code, owner: error.owner,
                request_id: error.request_id, retryable: error.retryable, next_action: error.next_action } : {}) }),
            isError: true,
          };
        }
      },
    );
  };
  tool(
    'project_status',
    'Inspect native adapter capability observations and configuration.',
    {},
    () => doctor(root),
  );
  tool('agent_map', 'Read bounded saved agent activity, with provenance for each node and relationship.', {}, () => readAgentMap(root));
  tool('runtime_info', 'Inspect the running MCP instance and its startup build fingerprint; updated files require restarting this server.', {}, () => runtimeInfo);
  // High-level operations receive the already authenticated actor through a freshly
  // resolved private handle; the shared MCP connection never stores a current actor.
  tool('assignment_open', 'Actual delegate: open the exact prepared packet and keep its handle private. Omit reported_assignment during bootstrap. This does not launch an agent.', {
    packet: z.object({ id: z.string().regex(/^local-report-[a-f0-9]{40}$/), claim_token: z.string().min(1) }).strict(),
  }, input => {
    if (bound() || reported()) throw new Error('An existing actor cannot open another assignment. Pass the prepared packet to the actual delegate.');
    return openAssignment(root, { packet: input.packet });
  }, false);
  const currentHandle = () => {
    const handle = privateHandles.getStore();
    if (!handle) throw new Error('Use assignment_open with the prepared packet, then pass its private handle as reported_assignment. Strict sessions keep their signed lifecycle tools.');
    return handle;
  };
  const softwareTaskActor = (role: string, operation: string) => {
    const actor = resolveReportedAssignment(root, currentHandle());
    if (actor.role !== role || !actor.task_id)
      throw new AssignmentContextError('SCOPE_DENIED', 'This operation requires its actual task-bound specialist.', 'Use your own assigned role and private handle.');
    const task = getRecord(root, actor.task_id), contract = nativeSoftwareTaskContract(root, task);
    if (!contract) throw new AssignmentContextError('CONTEXT_MISMATCH', 'This derived operation requires a saved supporting-software contract.', 'Use the saved workflow process and its existing core lifecycle tools.');
    authorizeReportedAssignment(root, actor, operation, { id: task.meta.id });
    return { actor, task, contract };
  };
  tool('assignment_start', 'Actual Implementer: start your own assigned software task. Workflow, task and invocation are derived from your handle.', {}, () => {
    const { actor, task } = softwareTaskActor('developer', 'task_start');
    if (task.meta.status === 'in-progress' && task.meta.data.invocation_id === actor.id) return task;
    return task.meta.status === 'blocked' || task.meta.status === 'in-progress'
      ? resumeTask(root, task.meta.id, undefined, undefined, actor.id)
      : startTask(root, task.meta.id, undefined, undefined, actor.id);
  }, false);
  tool('assignment_check', 'Actual independent Verifier: execute all saved software check commands for your assigned task and collect current immutable evidence. No check/task IDs are supplied.', {}, () => {
    const { actor, task, contract } = softwareTaskActor('check-executor', 'check_run');
    return { task_id: task.meta.id, evidence: contract.check_ids.map(id => runCheck(root, id, task.meta.id, actor.id)),
      verification: verify(root, task.meta.id, 'verified') };
  }, false);
  tool('assignment_review', 'Actual independent Reviewer: save your decision on your assigned software task and current baseline. Task and reviewer identity are derived.', {
    decision: z.enum(['pass', 'fail']), findings: z.array(z.string().min(1)).max(128),
  }, input => {
    const { actor, task } = softwareTaskActor('reviewer', 'task_review');
    return reviewTask(root, task.meta.id, 'reviewer', input.decision, input.findings, actor.id);
  }, false);
  tool('workflow_plan', 'Coordinator: establish a bounded supporting-software contract. Backend creates and links requirements, task, check plans and decision; derives their IDs and applies only relevant gates. Existing strict/embedded behavior retains its full process.', nativeSoftwarePlanSchema.shape,
    input => planNativeSoftware(root, currentHandle(), Object.fromEntries(
      Object.keys(nativeSoftwarePlanSchema.shape).filter(key => input[key] !== undefined).map(key => [key, input[key]]),
    ) as Parameters<typeof planNativeSoftware>[2]), false);
  tool('workflow_next', 'Coordinator: obtain the next valid private handoff for implementation, independent verification or review. Pass an actual native callback observation after each delegate. Backend reuses saved results and returns derived closure references when complete.', {
    observation: z.object({ packet_id: z.string().regex(/^(?:local-report-[a-f0-9]{40}|\s*)$/).nullable().optional()
        .describe('Normally omit: the backend derives the current managed stage. Supply only an actual packet ID for callback compatibility; null or blank means absent.'),
      state: z.enum(['completed', 'completed-without-output', 'failed', 'cancelled', 'running', 'unknown']),
      observation_id: z.string().min(1).max(160) }).strict().nullable().optional(),
  }, input => nextNativeSoftware(root, currentHandle(), input.observation ? { observation: input.observation } : {}), false);
  tool('assignment_delegate', 'Coordinator: generate a valid private specialist handoff from the current authenticated workflow. Backend derives role, task and correlation. Dispatch the returned handoff through the actual native agent tool.', {
    profile_id: z.enum(agentProfiles.filter(profile => profile.id !== 'coordinator').map(profile => profile.id)),
    objective: z.string().min(20).max(4000), scope: z.enum(['workflow', 'task']).optional(),
    task_selector: z.string().nullable().optional().describe('Use only an opaque selector returned by assignment_context or this tool when multiple tasks are eligible. Null or blank means no selection; the backend derives a sole eligible task or returns choices.'),
  }, input => delegateAssignment(root, currentHandle(), {
    profile_id: input.profile_id, objective: input.objective,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.task_selector !== undefined ? { task_selector: input.task_selector } : {}),
  }), false);
  tool('assignment_followup', 'Coordinator: reconcile an actual delegate callback with its durable result. Reuse completed work; prepare at most two bounded follow-ups for missing/failed results. Running or unknown observations wait without duplicate dispatch.', {
    packet_id: z.string().regex(/^local-report-[a-f0-9]{40}$/),
    observation: z.enum(['completed', 'completed-without-output', 'failed', 'cancelled', 'running', 'unknown']),
    observation_id: z.string().min(1).max(160).describe('Stable correlation from the actual native agent call/callback.'),
  }, input => followUpNativeAssignment(root, currentHandle(), {
    packet_id: input.packet_id, observation: input.observation, observation_id: input.observation_id,
  }), false);
  tool('assignment_context', 'Read derived role, workflow/task scope, permitted operations and result obligations for your private assignment handle.', {},
    () => assignmentContext(root, currentHandle()));
  tool('assignment_progress', 'Report actual progress using only state and summary. Workflow, task, role and correlation are derived from your private handle.', {
    state: z.enum(['dispatched', 'running', 'waiting', 'blocked', 'completed', 'failed']), summary: z.string().min(1).max(240),
  }, input => assignmentProgress(root, currentHandle(), { state: input.state, summary: input.summary }), false);
  tool('assignment_result', 'Save substantive typed findings through the valid assignment context. Renders the work report and preserves current submission/verification gates.', {
    result: z.fromJSONSchema(JSON.parse(JSON.stringify(assignmentResultJsonSchema))),
  }, input => assignmentResult(root, currentHandle(), input.result), false);
  tool('procedure_list', 'List registered project procedures and their current qualification/drift status. Does not execute scripts.', {}, () => listProcedures(root));
  tool('procedure_discover', 'Find existing project Node scripts and package commands before writing new automation. Discovery executes nothing.', {}, () => discoverProcedureScripts(root));
  tool('procedure_resolve', 'Resolve a registered versioned procedure, its contract, checks and history.', {
    procedure_id: z.string(), version: z.string().optional(),
  }, input => resolveProcedure(root, input.procedure_id, input.version));
  tool('work_prepare', 'Match the original request against indexed procedures and return exact/adapt/new/blocked plus a compact reuse brief. Advisory only; never executes retrieved code.', {
    input: workPreparationSchema,
  }, input => prepareWork(root, input.input as Parameters<typeof prepareWork>[1]));
  const procedureActor = () => {
    const actor = reported() ?? bound();
    if (!actor) throw new Error('Procedure mutations require a current authenticated actor; use the CLI for explicit local administration.');
    return actor.id;
  };
  tool('procedure_register', 'Register an actual existing parameterized script and independent check as a candidate. Registration never qualifies or executes it.', {
    manifest: registerProcedureSchema.extend({ author: z.string().optional() }),
  }, input => {
    const actor = reported() ?? bound();
    const manifest = registerProcedure(root, { ...input.manifest, author: procedureActor() } as Parameters<typeof registerProcedure>[1]);
    if (!actor?.workflow_id) return manifest;
    const sourceWorkflow = actor.workflow_id;
    const sourceLinks: Link[] = [{ type: 'documents', target: sourceWorkflow }];
    if (actor.task_id) sourceLinks.push({ type: 'documents', target: actor.task_id });
    const capture = withOperationLock(root, `procedure-capture-${hash(`${sourceWorkflow}:${manifest.contract_hash}`)}`, () => {
      const existing = loadRecords(root).find(record => record.meta.data.kind === 'procedure-candidate' &&
        record.meta.data.workflow_id === actor.workflow_id && record.meta.data.procedure_contract_hash === manifest.contract_hash);
      return existing ?? createRecord(root, {
      type: 'knowledge', title: `Automation candidate: ${manifest.title}`, owner: actor.role,
      links: sourceLinks,
      data: { kind: 'procedure-candidate', workflow_id: actor.workflow_id, ...(actor.task_id ? { task_id: actor.task_id } : {}),
        invocation_id: actor.id, procedure_id: manifest.id, procedure_version: manifest.version,
        procedure_contract_hash: manifest.contract_hash, script: manifest.script, verification_script: manifest.verification_script,
        qualification: 'candidate-only', identity_assurance: reported() ? 'unsigned-local-assignment' : 'signed-native-routing' },
      body: `# Captured automation\n${manifest.description}\n\n# Applicability\n${manifest.task_family ?? 'Declared manifest contract'}\n\n# Next step\nIndependent contract review and checked representative pilots are required. Registration executes nothing and does not establish eligibility.\n`,
      });
    });
    return { ...manifest, candidate_record_id: capture.meta.id };
  }, false);
  tool('procedure_review', 'Record an independent review and negative-case evidence for the exact procedure contract.', {
    input: z.record(z.string(), z.unknown()),
  }, input => reviewProcedure(root, { ...input.input, reviewer: procedureActor() } as Parameters<typeof reviewProcedure>[1]), false);
  tool('procedure_qualify', 'Evaluate independent review and actual qualifying runs; does not manufacture maturity from catalog presence or search matches.', {
    procedure_id: z.string(), version: z.string().optional(),
  }, input => qualifyProcedure(root, { procedure_id: input.procedure_id, version: input.version, actor: procedureActor() }), false);
  tool('procedure_suspend', 'Disable automatic use of a registered procedure while preserving its run and review history.', {
    procedure_id: z.string(), version: z.string().optional(), reason: z.string().min(10),
  }, input => suspendProcedure(root, { procedure_id: input.procedure_id, version: input.version, actor: procedureActor(), reason: input.reason }), false);
  tool('procedure_run', 'Run a reviewed pilot or eligible procedure inside your current in-progress Developer task scope. Current engineering checks/review remain required after script execution.', {
    procedure_id: z.string(), version: z.string().optional(), parameters: z.record(z.string(), z.unknown()),
    request_id: z.string().min(1), mode: z.enum(['pilot', 'automatic']),
    tool_versions: z.record(z.string().max(100), z.string().max(200)).optional(),
  }, async input => {
    const actor = reported() ?? bound();
    if (!actor || actor.role !== 'developer' || !actor.task_id)
      throw new Error('Procedure execution requires the actual Developer assignment bound to an in-progress task.');
    const task = getRecord(root, actor.task_id);
    if (task.meta.type !== 'task' || task.meta.status !== 'in-progress' || task.meta.data.workflow_id !== actor.workflow_id)
      throw new Error('Procedure execution must retain the current same-workflow in-progress task.');
    if (task.meta.data.invocation_id !== actor.id)
      throw new Error('Only the current task producer can execute its procedure. Start or resume this task with the actual assigned Developer first.');
    const readiness = verify(root, task.meta.id, 'design-ready');
    if (!readiness.ok) throw new Error(`Procedure execution preserves task gates: ${readiness.findings.map(item => item.message).join('; ')}`);
    const parent = getRecord(root, actor.workflow_id!);
    const client = procedureExecutionClient(parent.meta.data.execution_mode, bound());
    return runProcedure(root, { procedure_id: input.procedure_id, version: input.version, parameters: input.parameters,
      request_id: input.request_id, actor: actor.id, client, mode: input.mode,
      workflow_mode: String(parent.meta.data.execution_mode ?? 'strict'), assurance: String(parent.meta.data.assurance ?? ''), tool_versions: input.tool_versions,
      authorized_effects: { write_roots: Array.isArray(task.meta.data.allowed_paths) ? task.meta.data.allowed_paths as string[] : [],
        network: readAutomationPolicy(root).network_policy === 'remote-enabled', publication: false } });
  }, false);
  const assignmentPreparationSchema = {
    workflow_id: z.string(), profile_id: z.enum(agentProfiles.map(profile => profile.id)), role: z.enum([...strongRoles, ...workerRoles]),
    assignment_id: z.string().min(1).max(160), objective: z.string().min(20).max(4000), task_id: z.string().nullable().optional(),
  };
  tool('assignment_bootstrap', 'Coordinator: prepare a bounded unsigned native assignment without credentials. Pass the returned handoff unchanged to the actual local delegate. Prepares only; never claims or launches an agent.', {
    ...assignmentPreparationSchema, task_id: z.string().nullable().optional(),
  }, input => {
    if (bound()) throw new Error('Signed assignments already have their native invocation identity.');
    const { task_id, ...packet } = input;
    return prepareReportedAssignment(root, { ...packet,
      ...(typeof task_id === 'string' && task_id.trim() ? { task_id } : {}),
    }, { requirePrepared: true });
  }, false);
  tool('assignment_recover', 'Coordinator: recover the private handoff for an existing unclaimed prepared packet in the same open unsigned native workflow. Requires no credentials; never claims, creates an identity or rotates the issuer key.', {
    workflow_id: z.string().min(1),
    packet_id: z.string().regex(/^local-report-[a-f0-9]{40}$/, 'Use the actual packet.id returned by assignment_bootstrap or assignment_prepare, not its correlation assignment_id.'),
  }, input => {
    if (bound()) throw new Error('Signed assignments already have their native invocation identity.');
    return recoverPreparedAssignment(root, input);
  }, false);
  tool('assignment_prepare', 'Prepare a bounded unsigned local assignment packet, optionally using an already opened Coordinator handle. Without a handle prefer assignment_bootstrap. Pass the returned handoff unchanged to the actual delegate; preparation does not launch or claim an agent.', assignmentPreparationSchema, input => {
    if (bound()) throw new Error('Signed assignments already have their native invocation identity.');
    const { invocation_id: _invocation, role, ...packet } = input;
    return prepareReportedAssignment(root, { ...packet, role });
  }, false);
  tool('assignment_claim', 'Called by the actual delegate before work: claim its local packet and retain the credential privately for scoped research, reports and reviews. This unsigned identity does not prove a platform process or model.', {
    assignment_id: z.string().regex(/^local-report-[a-f0-9]{40}$/, 'Use the actual packet.id returned by Coordinator, not the correlation assignment_id. Prefer assignment_open with the returned open_input.'),
    claim_token: z.string().regex(/^[a-f0-9]{64}$/, 'Use the real nonblank packet.claim_token from Coordinator. If it was lost, Coordinator must use assignment_recover; never invent a token.'),
  }, input => {
    if (bound() || reported()) throw new Error('An existing actor cannot claim another assignment. Launch the actual delegate with its packet.');
    return claimReportedAssignment(root, input.assignment_id, input.claim_token);
  }, false);
  tool('rea_status', 'Inspect pinned REA configuration and saved handshake observations without starting a server or downloading code.', {}, () => reaStatus(root));
  tool('platform_validate', 'Read-only local integration and reuse inspection. Separates configuration from actual observations and missing prerequisites.', {}, () => validatePlatform(root));
  tool('cornell_research_compile', 'Validate research against its current requirement and compile the consistent note, practice and answer format. Returns recipe_input for the existing recipe_prepare and recipe_run lifecycle; writes nothing.',
    { input: cornellResearchSchema }, i => {
      const receipt = bound();
      for (const id of [i.input.requirement_id, i.input.workflow_id, i.input.task_id,
        ...i.input.sources.map((source: { record_id?: string }) => source.record_id), ...(i.input.worked_example.evidence_ids ?? [])].filter((id): id is string => !!id)) scopedRecord(root, receipt, id);
      return compileCornellResearch(root, i.input);
    });
  tool('agent_activity', 'Low-level unsigned native telemetry with explicit actual identity fields. Opened assignments should use assignment_progress with their own handle, state and summary; its identity fields are derived. Does not run an agent, attest inference or change workflow gates.', {
    workflow_id: z.string().min(1), assignment_id: z.string().min(1).max(160),
    profile_id: z.enum(agentProfiles.map(profile => profile.id)),
    role: z.enum([...strongRoles, ...workerRoles]).optional().describe('Optional reported-assignment compatibility field; must match its claimed role and is removed before profile-derived activity persistence.'),
    state: z.enum(['dispatched', 'running', 'waiting', 'completed', 'blocked', 'failed']),
    summary: z.string().min(1).max(240), invocation_id: z.string().min(1).max(160).optional(),
    task_id: z.string().min(1).optional(),
  }, input => reportAgentActivity(root, input), false);
  tool('upstream_list', 'List tracked GitHub agent and skill packages, adopted pins and update observations.', {}, () => listUpstreams(root));
  tool('upstream_discover', 'Discover GitHub candidates sorted by stars; popularity is a discovery signal.', {
    query: z.string().min(1), min_stars: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(30).optional(),
  }, i => discoverUpstreams(root, i), true, true);
  tool('upstream_track', 'Track a GitHub source at a resolved exact commit, without executing repository code.', {
    upstream_id: z.string(), repository: z.string(), ref: z.string().optional(), commit: z.string().optional(), min_stars: z.number().int().min(0).optional(), role: z.string().optional(), instructions: z.array(z.string()).optional(),
  }, i => trackUpstream(root, { ...i, id: i.upstream_id }), false, true);
  tool('upstream_check', 'Observe upstream head movement while preserving the adopted commit and instructions.', {
    upstream_id: z.string(),
  }, i => checkUpstream(root, i.upstream_id), false, true);
  tool('upstream_clone', 'Cache the adopted commit with bare Git and verify selected instruction blobs. Executes no upstream scripts.', {
    upstream_id: z.string(),
  }, i => cloneUpstream(root, i.upstream_id), false, true);
  tool('upstream_adopt', 'Adopt an inspected exact update using an expected current commit; active signed invocations must be stopped first.', {
    upstream_id: z.string(), expected_commit: z.string(), commit: z.string(), instructions: z.array(z.string()).optional(),
  }, i => adoptUpstreamUpdate(root, i.upstream_id, i), false, true);
  tool('upstream_instructions', 'Read hash-verified selected upstream skill or agent text with provenance; grants no runtime capabilities.', {
    upstream_id: z.string(),
  }, i => readUpstreamInstructions(root, i.upstream_id));
  tool(
    'project_read',
    'Read bounded relevant project text with a content hash; credentials, private native keys, raw sessions and runtime caches are excluded.',
    {
      path: z.string(),
      max_chars: z.number().int().min(128).max(64000).optional(),
      start_line: z.number().int().min(1).optional(),
    },
    (i) => projectRead(root, i, bound()),
  );
  tool(
    'manager_run',
    'Submit or resume work. neomind-controlled returns a durable receipt quickly and runs the complete workflow in the enabled VS Code owner, independently of this chat. Other saved execution modes retain their original semantics. Supply requirement OR requirements; for resume provide the exact workflow_id. Do not reconstruct worker requests or credentials.',
    {
      requirement: z
        .string()
        .nullable()
        .optional()
        .describe('The full product goal, retaining all acceptance, process, scope, preservation and safety obligations. Copy the complete new user requirement verbatim; do not append runtime operating instructions, inferred review gates, extra criteria or invented report files. Use execution_mode for runtime dispatch, manager_status for status and manager_control with workflow_id/action for control; these operations are not product orchestration changes. Preserve actual authentication, storage, execution and orchestration requirements. Retain ambiguous mixed requests completely; opaque input remains conservative. Use null or omit when supplying requirements.'),
      requirements: z
        .array(z.string())
        .nullable()
        .optional()
        .describe('A batch of full product goals, each retaining all acceptance, process, scope, preservation and safety obligations. Copy each complete new user requirement verbatim; do not append runtime operating instructions, inferred review gates, extra criteria or invented report files. Client dispatch/status/control use execution_mode, manager_status and manager_control rather than product requirements. Preserve actual sensitive product changes and retain ambiguous mixed requests completely. Use null or omit when supplying requirement.'),
      workflow_id: z.string().nullable().optional(),
      execution_mode: z.enum(['strict', 'lightweight', 'copilot-native', 'codex-native', 'neomind-controlled']).nullable().optional(),
      native_client: z.enum(['copilot', 'codex']).nullable().optional(),
      message: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      request_id: z.string().nullable().optional(),
      change_type: z.enum(['breaking', 'feature', 'fix']).nullable().optional(),
      providers: z
        .array(z.enum(['codegraph', 'context7', 'playwright']))
        .nullable()
        .optional(),
    },
    async (i) => {
      const result = await managedRun(root, intakeArguments<ManagedRunInput>(i), ownerToken);
      return isControlledCommandSnapshot(result.workflow) ? { workflow: controlledCommandReceipt(result.workflow) } : result;
    },
    false,
  );
  tool(
    'manager_begin',
    'Start or recover a requirement workflow. Supply requirement OR requirements; set the unused field to null or omit it. In strict mode the active native manager owns execution and closure; in copilot-native mode the visible manager subagent drives the unsigned lifecycle.',
    {
      requirement: z.string().nullable().optional(),
      requirements: z.array(z.string()).nullable().optional(),
      execution_mode: z.enum(['strict', 'copilot-native', 'codex-native', 'neomind-controlled']).nullable().optional(),
      title: z.string().nullable().optional(),
      invocation_id: z.string().nullable().optional(),
      request_id: z.string().nullable().optional(),
    },
    (i) => beginWorkflow(root, intakeArguments<WorkflowInput>(i)),
    false,
  );
  tool(
    'manager_discuss',
    'Persist an actual specialist contribution with its invocation and inspected input baselines; bounded to three rounds.',
    {
      workflow_id: z.string(),
      role: z.enum(discussionRoles),
      invocation_id: z.string().optional(),
      summary: z.string(),
      rationale: z.string(),
      risks: z.array(z.string()).optional(),
      source_ids: z.array(z.string()).optional(),
      round: z.number().int().optional(),
    },
    (i) => {
      const receipt = bound();
      return discussWorkflow(root, i.workflow_id, {
        ...i,
        ...(receipt ? { role: receipt.role, invocation_id: receipt.id } : {}),
      });
    },
    false,
  );
  tool(
    'manager_decide',
    'Integrate two current specialist contributions and a reviewed plan. Assign documentation responsibilities and report decisions without routine approval.',
    {
      workflow_id: z.string(),
      summary: z.string(),
      rationale: z.string(),
      task_ids: z.array(z.string()),
    },
    (i) => decideWorkflow(root, i.workflow_id, i),
    false,
  );
  tool(
    'manager_status',
    'Read compact saved workflow status, acceptance-record states, final report IDs and blockers. Omit workflow_id for bounded discovery; select an exact ID for status. Use view:journal only when the full controlled execution journal is explicitly needed; the default summary stays readable in chat.',
    { workflow_id: z.string().optional(), view: z.enum(['summary', 'journal']).optional(),
      request_id: z.string().min(1).max(256).optional().describe('Filter discovery by the exact saved request_id, including a lost-admission receipt older than the recent workflow list. Does not submit or resume work.') },
    (i) => i.workflow_id && hasControlledWorkflow(root, i.workflow_id) ? i.view === 'journal' ? controlledStatus(root, i.workflow_id)
      : controlledStatusView(root, controlledStatus(root, i.workflow_id) as ControlledSnapshot)
      : controlledParent && !i.workflow_id ? {
        execution_mode: 'neomind-controlled', ...controlledStatusList(controlledStatus(root) as ControlledSnapshot[], i.request_id),
        // Discovery is a journal read, not a re-run of every historical gate.
        // Select a legacy ID explicitly to inspect its original acceptance.
        ...controlledLegacyStatusList(loadRecords(root).filter(record => record.meta.data.kind === 'manager-workflow' &&
          !hasControlledWorkflow(root, record.meta.id)), i.request_id),
      } : Object.assign({}, workflowStatus(root, i.workflow_id), controlledStatusList(controlledStatus(root) as ControlledSnapshot[])),
  );
  tool('manager_control', 'Pause, resume or cancel one exact controlled workflow through its enabled VS Code owner. Work is independent of this chat connection.', {
    workflow_id: z.string().min(1), action: z.enum(['pause', 'resume', 'cancel']),
  }, async i => controlledCommandReceipt(await controlControlledWorkflow(root, i)), false);
  tool(
    'lightweight_checkpoint',
    'Save a native-client lightweight report. No signed acceptance, strict task mutation, execution, publication or permission expansion.',
    {
      workflow_id: z.string(), expected_revision: z.number().int().min(1),
      phase: z.enum(['execution', 'blocked', 'completed']),
      risk: z.enum(['low', 'elevated', 'strict-required']),
      plan: z.array(z.string()).max(5), changed_files: z.array(z.string()).max(256),
      checks: z.array(z.object({ command: z.string(), result: z.enum(['passed', 'failed', 'not-run']), output: z.string() }).strict()).max(32),
      limitations: z.array(z.string()).max(32),
      review: z.object({ disposition: z.enum(['not-needed', 'pending', 'completed']), reason: z.string(), invocation_id: z.string().optional(), result: z.enum(['pass', 'fail']).optional() }).strict(),
      summary: z.string(), next_action: z.string().optional(),
    },
    (i) => checkpointLightweight(root, i),
    false,
  );
  tool(
    'manager_finish',
    'Validate and accept documented independently reviewed tasks, curate knowledge disposition, submit qualified draft PRs under the saved project policy, and persist the final report. Never merges.',
    {
      workflow_id: z.string(),
      knowledge_ids: z.array(z.string()).optional(),
      no_lesson_reason: z.string().optional(),
      retired_candidates: z
        .array(z.object({ knowledge_id: z.string(), reason: z.string() }))
        .optional(),
    },
    (i) => finishWorkflow(root, i.workflow_id, i),
    false,
    true,
  );
  tool(
    'record_list',
    'Read authoritative engineering records.',
    { type: z.enum(recordTypes).optional() },
    (i) => {
      const receipt = bound();
      const scope = receipt ? recordScope(root, receipt) : null;
      return loadRecords(root).filter(
        (r) => (!i.type || r.meta.type === i.type) && (!scope || scope.has(r.meta.id)),
      );
    },
  );
  tool(
    'record_get',
    'Read one scoped engineering record and its full current fingerprint. Select data_fields and include_body:false for bounded current-state inspection; omitted options preserve the complete record.',
    {
      id: z.string(),
      data_fields: z.array(z.string().min(1).max(256)).max(64).optional(),
      include_body: z.boolean().optional(),
    },
    (i) => {
      const record = scopedRecord(root, bound(), i.id);
      return {
        meta: {
          ...record.meta,
          data:
            i.data_fields === undefined
              ? record.meta.data
              : Object.fromEntries(
                  i.data_fields
                    .filter((key: string) => Object.hasOwn(record.meta.data, key))
                    .map((key: string) => [key, record.meta.data[key]]),
                ),
        },
        path: record.path,
        ...(i.include_body !== false ? { body: record.body } : {}),
        fingerprint: recordFingerprint(record),
        ...(i.data_fields !== undefined || i.include_body !== undefined
          ? {
              projection: {
                data_fields: i.data_fields ?? null,
                include_body: i.include_body !== false,
              },
            }
          : {}),
      };
    },
  );
  tool(
    'record_create',
    'Create a project record. Supply explicit acceptance criteria and typed links in data.',
    {
      type: z.enum(recordTypes),
      title: z.string(),
      owner: z.string(),
      body: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      links: z
        .array(
          z.object({
            type: z.enum([
              'derives-from',
              'satisfies',
              'implements',
              'verifies',
              'evidence-for',
              'reviews',
              'depends-on',
              'documents',
              'supersedes',
              'references',
            ]),
            target: z.string(),
          }),
        )
        .optional(),
    },
    (i) => {
      const receipt = bound();
      if (
        receipt &&
        (reservedKinds.has(String(i.data?.kind)) ||
          i.data?.kind === 'manager-workflow' ||
          ['review', 'evidence'].includes(i.type))
      )
        throw new Error(
          'Reserved engineering state must be created through its dedicated core operation.',
        );
      if (receipt && !canAuthor(receipt.role, i.type))
        throw new Error(`Role ${receipt.role} cannot author ${i.type} records.`);
      if (reported() && !canAuthor(reported()!.role, i.type))
        throw new Error(`Role ${reported()!.role} cannot author ${i.type} records.`);
      if (
        receipt &&
        i.links?.some((link: { target: string }) => !recordScope(root, receipt).has(link.target))
      )
        throw new Error('Record links escape the assigned context.');
      if (!receipt && i.type === 'task' && Object.keys(i.data ?? {}).some((key) => executionFields.has(key) || key === 'escalation_invocation_id' || key === 'escalation_reason'))
        throw new Error('Task execution, submission and acceptance fields require dedicated core operations.');
      assertRecordPreview(root, i);
      return createRecord(root, {
        ...i,
        ...(receipt || reported() ? { owner: i.type === 'task' ? i.owner : receipt?.role ?? reported()!.role } : {}),
        data: reportedData(i.type === 'task' ? taskAuthorData(receipt, i.data) : authoredData(receipt, i.data), i.type === 'task'),
      });
    },
    false,
  );
  tool(
    'record_update',
    'Update record data or body. Acceptance is handled by task_accept.',
    {
      id: z.string(),
      owner: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      body: z.string().optional(),
      links: z
        .array(
          z.object({
            type: z.enum([
              'derives-from',
              'satisfies',
              'implements',
              'verifies',
              'evidence-for',
              'reviews',
              'depends-on',
              'documents',
              'supersedes',
              'references',
            ]),
            target: z.string(),
          }),
        )
        .optional(),
    },
    (i) => {
      const receipt = bound();
      const record = scopedRecord(root, receipt, i.id);
      if (receipt) assertGenericRecordMutation(record, receipt);
      if (reported()) assertGenericRecordMutation(record, reported()!);
      if (!receipt && nativeWorkflowRecord(root, record) && record.meta.type === 'task' &&
          Object.keys(i.data ?? {}).some((key) => executionFields.has(key) || key === 'escalation_invocation_id' || key === 'escalation_reason'))
        throw new Error('Task execution, submission and acceptance fields require dedicated core operations.');
      if (!receipt && nativeWorkflowRecord(root, record) &&
          (['evidence', 'review'].includes(record.meta.type) ||
           reservedKinds.has(String(record.meta.data.kind)) ||
           Object.keys(i.data ?? {}).some((key) => ['kind', 'workflow_id', 'intake_workflow_id', 'routing_required', 'execution_mode', 'assurance', 'original_requirement', 'original_requirements', 'native_software_contract'].includes(key))))
        throw new Error('Native updates cannot rewrite workflow ownership, assurance, or reserved lifecycle state.');
      for (const link of i.links ?? []) {
        const target = scopedRecord(root, receipt, link.target);
        if (!receipt && nativeWorkflowRecord(root, record) && !nativeWorkflowRecord(root, target))
          throw new Error('Native updates cannot link strict or unrelated legacy records.');
      }
      if (
        i.owner !== undefined &&
        (record.meta.type !== 'task' ||
          !['draft', 'ready', 'blocked'].includes(record.meta.status) ||
          (receipt &&
            !['manager', 'architect', 'component-owner', 'verifier'].includes(receipt.role)))
      )
        throw new Error('Only a planning role can reassign a task before implementation starts.');
      if ((receipt || nativeWorkflowRecord(root, record)) && record.meta.data.kind === 'manager-workflow') {
        if (
          i.body !== undefined ||
          i.links !== undefined ||
          Object.keys(i.data ?? {}).some((key) => !['open_questions', 'change_type'].includes(key))
        )
          throw new Error(
            'Workflow updates expose clarification questions and reviewed release classification only.',
          );
        return updateRecord(root, i.id, { data: i.data });
      }
      if ((receipt || reported()) && !canAuthor(receipt?.role ?? reported()!.role, record.meta.type))
        throw new Error(`Role ${receipt?.role ?? reported()!.role} cannot author ${record.meta.type} records.`);
      assertRecordPreview(root, { type: record.meta.type, links: i.links, data: i.data }, record);
      return updateRecord(
        root,
        i.id,
        {
          data: reportedData(
            record.meta.type === 'task'
              ? taskAuthorData(receipt, i.data, record)
              : authoredData(receipt, i.data), record.meta.type === 'task'),
          ...(record.meta.type === 'task' && i.owner !== undefined
            ? { owner: i.owner }
            : receipt && record.meta.type !== 'task'
              ? { owner: receipt.role }
              : {}),
          ...(i.links !== undefined ? { links: i.links } : {}),
        },
        i.body,
      );
    },
    false,
  );
  tool(
    'task_start',
    'Start a ready task and record requested/confirmed model observations.',
    {
      id: z.string(),
      requested_model: z.string().optional(),
      confirmed_model: z.string().optional(),
      invocation_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      return startTask(
        root,
        i.id,
        receipt?.requested_model ?? i.requested_model,
        receipt?.confirmed_model ?? i.confirmed_model,
        receipt?.id ?? i.invocation_id,
      );
    },
    false,
  );
  tool(
    'task_resume',
    'Resume persisted interrupted work; repeated failure requires coordinator-selected model.',
    {
      id: z.string(),
      requested_model: z.string().optional(),
      confirmed_model: z.string().optional(),
      invocation_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      return resumeTask(
        root,
        i.id,
        receipt?.requested_model ?? i.requested_model,
        receipt?.confirmed_model ?? i.confirmed_model,
        receipt?.id ?? i.invocation_id,
      );
    },
    false,
  );
  tool(
    'task_repair',
    'Record feedback, permit one repair, and escalate repeated failure.',
    { id: z.string(), feedback: z.string() },
    (i) => requestRepair(root, i.id, i.feedback),
    false,
  );
  tool(
    'task_file_write',
    'Create or replace an assigned UTF-8 implementation/documentation file using its current SHA-256 (null for a new file). Requires the running native Developer producer, reviewed task scope, and unchanged protected acceptance artifacts. Records immutable previous bytes and idempotent operation history; Cornell artifacts use note_create instead.',
    {
      task_id: z.string(),
      workflow_id: z.string().optional(),
      path: z.string().describe('Project-relative file inside the reviewed task allowed_paths.'),
      content: z.string().describe('Complete UTF-8 replacement content, at most 128 KiB.'),
      expected_hash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .describe(
          'Current file SHA-256 from project_read, or null only when creating a missing file.',
        ),
      operation_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Reuse this UUID and identical payload to recover an interrupted or lost-response write.',
        ),
    },
    (i) => {
      const receipt = bound();
      if (!receipt)
        throw new Error('Task file writes require an invocation-bound native Developer session.');
      scopedRecord(root, receipt, i.task_id);
      return workspaceWrite(root, {
        ...i,
        workflow_id: i.workflow_id ?? receipt.workflow_id ?? '',
        invocation_id: receipt.id,
      });
    },
    false,
  );
  tool(
    'task_submit',
    'Persist worker submission and standard work history.',
    { id: z.string(), summary: z.string(), work_record: z.string().optional() },
    (i) => {
      const receipt = bound(),
        task = getRecord(root, i.id);
      if (
        receipt &&
        (receipt.role !== task.meta.owner || task.meta.data.invocation_id !== receipt.id)
      )
        throw new Error(
          'Task submission belongs to its active producer invocation; other assignments use assignment_report.',
        );
      return submitTask(root, i.id, i.summary, i.work_record);
    },
    false,
  );
  tool(
    'assignment_report',
    'Persist the seven-section account of this native assignment and any explicitly covered prior assignment of the same role and scope.',
    {
      target_ids: z.array(z.string()).min(1).max(32),
      body: z.string(),
      covered_invocation_ids: z.array(z.string()).optional(),
      invocation_id: z.string().min(1).optional(),
      role: z.string().min(1).optional(),
    },
    (i) => {
      const receipt = bound();
      if (!receipt && !(i.invocation_id && i.role && i.target_ids.every((id: string) => nativeWorkflowRecord(root, getRecord(root, id)))))
        throw new Error('Assignment reporting requires a bound invocation or reported native workflow identity.');
      for (const id of i.target_ids) scopedRecord(root, receipt, id);
      return assignmentReport(root, { ...i, role: receipt?.role ?? i.role, invocation_id: receipt?.id ?? i.invocation_id,
        ...(reported() ? { assurance: reported()!.assurance } : {}) });
    },
    false,
  );
  tool(
    'task_accept',
    'Accept a task only when current checks and independent review pass.',
    { id: z.string() },
    (i) => acceptTask(root, i.id),
    false,
  );
  tool(
    'task_context',
    'Build a bounded worker packet with source pointers and verification procedures.',
    { id: z.string(), max_chars: z.number().int().min(1000).max(100000).optional() },
    (i) => contextPacket(root, i.id, i.max_chars),
  );
  tool(
    'record_trace',
    'Inspect both directions of engineering links and change impact.',
    { id: z.string(), impact: z.boolean().optional() },
    (i) => traceRecord(root, i.id, i.impact),
  );
  tool(
    'verify',
    'Validate structural links and a task completion gate.',
    {
      id: z.string().optional(),
      gate: z.enum(['ready', 'design-ready', 'verified', 'accepted']).optional(),
    },
    (i) => verify(root, i.id, i.gate),
  );
  tool(
    'check_run',
    'Execute the project-defined verification command and collect real baseline-bound evidence.',
    { id: z.string(), task: z.string() },
    (i) => runCheck(root, i.id, i.task, bound()?.id ?? reported()?.id),
    false,
  );
  tool(
    'check_inspect',
    'Record actual observations for every item in a reviewed inspection plan. Sources must match current project file SHA-256 values or record fingerprints; gaps and failures remain failing evidence. This captures model-performed inspection with limits, independently reviewed later; it does not run an executable or establish automatic semantic proof.',
    {
      id: z.string(),
      task: z.string(),
      observations: z
        .array(
          z
            .object({
              item_id: z.string(),
              outcome: z.enum(['pass', 'fail', 'gap']),
              observation: z.string().min(24).max(8000),
              sources: z
                .array(
                  z.discriminatedUnion('kind', [
                    z
                      .object({
                        kind: z.literal('file'),
                        path: z.string(),
                        sha256: z.string().regex(/^[a-f0-9]{64}$/),
                        locator: z.string().optional(),
                      })
                      .strict(),
                    z
                      .object({
                        kind: z.literal('record'),
                        record_id: z.string(),
                        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
                        locator: z.string().optional(),
                      })
                      .strict(),
                  ]),
                )
                .min(1)
                .max(16),
            })
            .strict(),
        )
        .min(1)
        .max(64),
      limitations: z.array(z.string().min(8).max(2000)).min(1).max(32),
      invocation_id: z.string().min(1).optional(),
    },
    (i) => {
      const receipt = bound();
      if (!receipt && !(nativeWorkflowRecord(root, getRecord(root, i.task)) && i.invocation_id))
        throw new Error(
          'Inspection evidence requires an invocation-bound Check Executor or a native workflow with a reported invocation ID.',
        );
      scopedRecord(root, receipt, i.task);
      for (const item of i.observations)
        for (const source of item.sources) {
          if (source.kind === 'record') scopedRecord(root, receipt, source.record_id);
          else projectRead(root, { path: source.path, max_chars: 128 }, receipt);
        }
      return inspectCheck(
        root,
        i.id,
        i.task,
        { observations: i.observations, limitations: i.limitations },
        receipt?.id ?? i.invocation_id,
      );
    },
    false,
  );
  tool(
    'evidence_archive',
    'Preserve verification receipt and log outside private runs. Inspect content before sharing; historical baselines remain unchanged.',
    { id: z.string() },
    (i) => archiveEvidence(root, i.id),
    false,
  );
  tool(
    'task_review',
    'Record an independent task review against its current fingerprint. A pass requires no unresolved findings; record positive observations in assignment_report.',
    {
      id: z.string(),
      owner: z.string(),
      decision: z.enum(['pass', 'fail']),
      findings: z
        .array(z.string())
        .describe(
          'Unresolved defects only. Use [] for pass; document positive observations in assignment_report.',
        )
        .optional(),
      invocation_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      return reviewTask(
        root,
        i.id,
        receipt?.role ?? i.owner,
        i.decision,
        i.findings,
        receipt?.id ?? i.invocation_id,
      );
    },
    false,
  );
  tool(
    'record_review',
    'Record an independent review. Findings contain unresolved defects only; a pass requires an empty findings array. Put positive observations and rationale in assignment_report.',
    {
      id: z.string(),
      owner: z.string(),
      decision: z.enum(['pass', 'fail']),
      findings: z
        .array(z.string())
        .describe(
          'Unresolved defects only. Use [] for pass; document positive observations in assignment_report.',
        )
        .optional(),
      invocation_id: z.string().optional(),
      generalization_review: z.boolean().optional(),
      public_safe: z.boolean().optional(),
    },
    (i) =>
      reviewRecord(
        root,
        i.id,
        bound()?.role ?? i.owner,
        i.decision,
        i.findings,
        bound()?.id ?? i.invocation_id,
        i.generalization_review,
        i.public_safe,
      ),
    false,
  );
  tool(
    'memory_search',
    'Find project records using the local rebuildable FTS5 index.',
    { query: z.string() },
    (i) => {
      const receipt = bound();
      const results = searchMemory(root, i.query);
      if (!receipt || !receipt.task_id) return results;
      const scope = recordScope(root, receipt);
      return results.filter((result) => scope.has((result as { id: string }).id));
    },
  );
  const knowledgeSearch = { platforms: z.array(z.string()).min(1), frameworks: z.array(z.string()), query: z.string().optional() };
  tool('knowledge_discover', 'Fetch commit-pinned public Cornell sources from configured project knowledge branches; remote errors remain blockers.',
    { workflow_id: z.string(), ...knowledgeSearch },
    (i) => discoverProjectKnowledge(root, i), false, true);
  tool('knowledge_search', 'Search verified Cornell narratives using a rebuildable local SQLite index; matches require applicability review.',
    knowledgeSearch, (i) => searchProjectKnowledge(root, i));
  tool('knowledge_research', 'Record inspected workspace, selected prior framework knowledge and functional differences before planning.',
    { workflow_id: z.string(), ...knowledgeSearch, workspace_paths: z.array(z.string()).min(1),
      queries: z.array(z.string()).min(1), selected_sources: z.array(z.object({ source_id: z.string(), applicability: z.string(), differences: z.string() })),
      rejected_sources: z.array(z.object({ source_id: z.string(), reason: z.string() })).optional(),
      no_match_reason: z.string().optional(), summary: z.string() },
    (i) => recordKnowledgeResearch(root, i.workflow_id, i, reported()), false);
  tool('knowledge_publish', 'Publish independently reviewed public-safe Cornell findings to the configured stable project branch; never merge.',
    { id: z.string(), repository: z.string() }, (i) => publishProjectKnowledge(root, i.id, i.repository), false, true);
  tool('pack_list', 'Inspect available and locked knowledge packs.', {}, () => listPacks(root));
  tool(
    'pack_install',
    'Install an exact local or bundled knowledge pack; replacing a locked version requires a reviewed owner decision.',
    { source: z.string(), decision_id: z.string().optional() },
    (i) => installPack(root, i.source, i.decision_id),
    false,
  );
  tool(
    'pack_suggest',
    'Find pack candidates; compatibility and applicability still require review.',
    { terms: z.array(z.string()) },
    (i) => suggestPacks(root, i.terms),
  );
  tool(
    'contribution_prepare',
    'Prepare reviewed generalized material locally. Human approval applies to merging; manager_finish can submit a draft under the saved project policy.',
    { id: z.string() },
    (i) => prepareContribution(root, i.id),
    false,
  );
  tool(
    'contribution_submit',
    'Manually submit a draft to a specifically authorized repository; never merges. For automatic closure use manager_finish and its saved upstream policy.',
    { id: z.string(), repository: z.string() },
    (i) => submitContribution(root, i.id, i.repository),
    false,
    true,
  );
  const nativeRole = z.enum([...strongRoles, ...workerRoles]);
  tool(
    'native_dispatch',
    'Launch one bounded exact-model native worker using the role contract and existing native permissions.',
    {
      role: nativeRole,
      prompt: z.string(),
      workflow_id: z.string().optional(),
      task_id: z.string().optional(),
      request_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      if (receipt && i.role === 'manager')
        throw new Error('The existing coordinator cannot recursively launch another coordinator.');
      return startNative(
        root,
        {
          ...i,
          ...(receipt?.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
        },
        ownerToken,
      );
    },
    false,
  );
  const scopedInvocation = (id: string) => {
    const receipt = bound(),
      target = readInvocation(root, id);
    if (receipt && receipt.role !== 'manager' && target.id !== receipt.id)
      throw new Error('Worker can observe only its own native invocation.');
    if (receipt?.workflow_id && target.workflow_id !== receipt.workflow_id)
      throw new Error('Native invocation belongs to another workflow.');
    return target;
  };
  tool(
    'native_status',
    'Inspect persisted native model acknowledgment, lifecycle, permissions, and blockers.',
    { invocation_id: z.string().optional() },
    (i) => {
      const receipt = bound();
      if (i.invocation_id) return scopedInvocation(i.invocation_id);
      const all = nativeStatus(root) as NativeReceipt[];
      return all.filter(
        (target) =>
          !receipt ||
          (receipt.role === 'manager'
            ? target.workflow_id === receipt.workflow_id
            : target.id === receipt.id),
      );
    },
  );
  tool(
    'native_wait',
    'Wait at most 60 seconds for an owned invocation; returns persisted state and applicable workflow status.',
    { invocation_id: z.string(), wait_ms: z.number().int().min(0).max(60000).optional() },
    async (i) => {
      scopedInvocation(i.invocation_id);
      const receipt = await waitNative(root, i.invocation_id, i.wait_ms);
      return {
        invocation: receipt,
        ...(receipt.workflow_id ? { workflow: workflowStatus(root, receipt.workflow_id) } : {}),
      };
    },
  );
  tool(
    'native_interrupt',
    'Interrupt through the live transport owner. Orphaned transports must be reconciled before resuming.',
    { invocation_id: z.string() },
    (i) => {
      scopedInvocation(i.invocation_id);
      return interruptNative(root, i.invocation_id);
    },
    false,
  );
  tool(
    'native_resume',
    'Resume native history with a fresh acknowledged invocation and preserve the old receipt.',
    { invocation_id: z.string(), prompt: z.string().optional(), request_id: z.string().optional() },
    (i) => {
      const target = scopedInvocation(i.invocation_id);
      if (bound() && target.role === 'manager')
        throw new Error('Coordinator resumption requires external managed intake, not an invocation-bound tool.');
      return resumeNative(root, i.invocation_id, i, ownerToken);
    },
    false,
  );
  const provider = z.enum(['codegraph', 'context7', 'playwright', 'rea']);
  tool(
    'capability_describe',
    'Inspect role-specific approved tools, required capabilities, and enforcement limits.',
    { role: nativeRole.optional() },
    (i) => describeCapabilities(root, bound()?.role ?? i.role ?? 'manager'),
  );
  tool(
    'capability_resolve',
    'Resolve applicable approved providers and install pinned packages automatically under saved policy.',
    {
      role: nativeRole.optional(),
      providers: z.array(provider).optional(),
      required: z.array(provider).optional(),
    },
    (i) => {
      const receipt = bound();
      const role =
        receipt && receipt.role !== 'manager'
          ? receipt.role
          : (i.role ?? receipt?.role ?? 'manager');
      return resolveCapabilities(root, { ...i, role });
    },
    false,
    true,
  );
  tool(
    'capability_invoke',
    'Invoke only an observed approved provider tool within the bound role and task scope.',
    {
      provider,
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      workflow_id: z.string().optional(),
      task_id: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      if (!receipt) throw new Error('Capability invocation requires a bound native invocation.');
      return invokeCapability(root, {
        ...i,
        invocation_id: receipt.id,
        ...(receipt.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
        ...(receipt.task_id ? { task_id: receipt.task_id } : {}),
      });
    },
    false,
    true,
  );
  tool(
    'archive_prepare',
    'Prepare a byte-preserving private project snapshot with evidence inputs and public invocation proofs.',
    {
      workflow_id: z.string(),
      disposition: z.enum(['working', 'accepted']).optional(),
      source_paths: z.array(z.string()).optional(),
    },
    (i) => prepareArchive(root, i.workflow_id, i),
    false,
  );
  tool(
    'archive_publish',
    'Publish the validated snapshot to the saved private upstream, preserving immutable release and increment history.',
    { snapshot_id: z.string() },
    (i) => {
      const receipt = bound();
      if (receipt?.workflow_id) {
        const snapshot = archiveStatus(root, i.snapshot_id) as any;
        if (
          snapshot?.manifest?.workflow_id &&
          snapshot.manifest.workflow_id !== receipt.workflow_id
        )
          throw new Error('Snapshot belongs to another workflow.');
      }
      return publishArchive(root, i.snapshot_id);
    },
    false,
    true,
  );
  tool(
    'archive_status',
    'Inspect snapshot manifests and resumable publication stages.',
    { snapshot_id: z.string().optional() },
    (i) => archiveStatus(root, i.snapshot_id),
  );
  tool(
    'archive_reassess',
    'Retire only a demonstrably unpublished archive intent after independent review of a precise linked change, preserving its history.',
    { workflow_id: z.string(), change_id: z.string(), reason: z.string() },
    (i) => {
      scopedRecord(root, bound(), i.change_id);
      return reassessArchive(root, i.workflow_id, i);
    },
    false,
    true,
  );
  tool(
    'archive_restore',
    'Restore a snapshot into a new empty directory and preserve authoritative fingerprints and evidence.',
    { snapshot_id: z.string(), destination: z.string() },
    (i) => restoreArchive(root, i.snapshot_id, i.destination),
    false,
  );
  tool(
    'note_create',
    'Create Cornell documentation with one {note: {...}} envelope. Supply note.path for task-bound work and practice.exercise_path/answer_path; commands are argument arrays. Expected results and observed evidence remain separate.',
    {
      note: cornellNoteSchema,
      revision_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Existing draft Cornell record ID for an owned fixed-path repair; omit for creation. Null or blank means omitted.',
        ),
      expected_revision: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Required with revision_id; read the current record revision before repair.'),
      revision_reason: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Required substantive repair rationale with revision_id; prior bytes/native authorship remain immutable history.',
        ),
    },
    (i) => {
      const receipt = bound();
      if (i.revision_id) {
        const existing = scopedRecord(root, receipt, i.revision_id);
        if (receipt?.task_id && existing.meta.data.task_id !== receipt.task_id)
          throw new Error('Cornell revision belongs to a different assigned task.');
        if ((receipt?.workflow_id ?? i.note.workflow_id) !== existing.meta.data.workflow_id)
          throw new Error('Cornell revision must preserve workflow ownership.');
      } else if (i.expected_revision !== undefined || i.revision_reason !== undefined)
        throw new Error('Cornell revision fields require revision_id.');
      assertTaskOutputPaths(root, receipt ?? reported(), [
        i.note.path,
        i.note.practice?.exercise_path,
        i.note.practice?.answer_path,
        ...(i.note.practice?.solution_path ? [i.note.practice.solution_path] : []),
      ]);
      for (const id of [
        ...(i.note.requirement_ids ?? []),
        ...(i.note.problem_ids ?? []),
        ...(i.note.demonstration?.evidence_ids ?? []),
        ...(i.note.sources ?? []).flatMap((source: any) =>
          source.record_id ? [source.record_id] : [],
        ),
      ])
        scopedRecord(root, receipt, id);
      if (receipt)
        for (const source of i.note.sources)
          if (!source.record_id && !/^https:\/\//.test(source.uri))
            projectRead(root, { path: source.uri, max_chars: 128 }, receipt);
      const input = {
        ...i.note,
        ...(receipt ? { owner: receipt.role, workflow_id: receipt.workflow_id } : reported() ? { owner: reported()!.role, workflow_id: reported()!.workflow_id } : {}),
      } as CornellInput;
      const note = i.revision_id
        ? reviseCornellNote(root, i.revision_id, input, i.expected_revision, i.revision_reason)
        : createCornellNote(root, input);
      if (!receipt) {
        if (!reported()) return note;
        return updateRecord(root, note.meta.id, { data: reportedData(note.meta.data) }, undefined, current => {
          if (current.meta.revision !== note.meta.revision) throw new Error('Cornell note changed before reported assignment attribution; read it before retrying.');
        });
      }
      const attribution = authoredData(receipt);
      const links = [
        ...note.meta.links,
        ...(receipt.task_id &&
        !note.meta.links.some(
          (link) => link.type === 'documents' && link.target === receipt.task_id,
        )
          ? [{ type: 'documents' as const, target: receipt.task_id }]
          : []),
      ];
      if (
        Object.entries(attribution).every(
          ([key, value]) => JSON.stringify(note.meta.data[key]) === JSON.stringify(value),
        ) &&
        links.length === note.meta.links.length
      )
        return note;
      return updateRecord(
        root,
        note.meta.id,
        { data: attribution, links },
        undefined,
        (current) => {
          if (current.meta.revision !== note.meta.revision)
            throw new Error(
              'Cornell note changed before native attribution; read it before retrying.',
            );
        },
      );
    },
    false,
  );
  tool(
    'note_validate',
    'Validate Cornell structure, demonstration, practice, citations, links, and source freshness.',
    { id: z.string() },
    (i) => validateCornellNote(root, i.id),
  );
  tool(
    'recipe_list',
    'Inspect the three versioned parameterized engineering recipes and their demonstrated limitations.',
    {},
    () => listRecipes(),
  );
  tool(
    'recipe_resolve',
    'Resolve an exact recipe identity, version, generator hash, and parameter contract.',
    { recipe_id: z.string(), version: z.string().optional() },
    (i) => resolveRecipe(i.recipe_id, i.version),
  );
  tool(
    'recipe_prepare',
    'Prepare frozen parameters, implementation interfaces, verification cases, expected outputs, and oracle rationale for Sol review.',
    {
      recipe_id: z.string(),
      version: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).describe(
        'Recipe-specific parameters. Cornell retains the {note: {...}} envelope; arbitrary values are validated before preparation.',
      ),
      workflow_id: z.string().optional().describe(
        'For Cornell, must match parameters.note.workflow_id and all supplied record ownership. May be inferred from same-workflow requirements, task, or note references.',
      ),
      requirement_ids: z.array(z.string()),
      task_id: z.string().optional(),
      owner: z.string().optional(),
    },
    (i) => {
      const receipt = bound();
      if (receipt && i.requirement_ids.some((id: string) => !recordScope(root, receipt).has(id)))
        throw new Error('Recipe requirements escape the assigned context.');
      const before = new Set(loadRecords(root).map((record) => record.meta.id));
      const instance = prepareRecipe(root, {
        ...i,
        owner: reported()?.role ?? i.owner ?? 'developer',
        ...(receipt?.workflow_id ? { workflow_id: receipt.workflow_id } : {}),
        ...(receipt?.task_id ? { task_id: receipt.task_id } : {}),
      } as RecipeInput);
      if (receipt || reported())
        for (const record of loadRecords(root).filter((record) => !before.has(record.meta.id)))
          updateRecord(root, record.meta.id, { data: reportedData(authoredData(receipt, record.meta.data)) });
      return getRecord(root, instance.meta.id);
    },
    false,
  );
  tool(
    'recipe_run',
    'Execute the accepted parameterized generator and protected verification artifacts without weakening expectations.',
    { id: z.string() },
    (i) => runRecipe(root, i.id, bound()?.id ?? reported()?.id),
    false,
  );
  tool(
    'recipe_revise',
    'Apply a reviewed specification/oracle correction and require fresh review and evidence.',
    {
      id: z.string(),
      change_id: z.string(),
      parameters: z.record(z.string(), z.unknown()),
      reason: z.string(),
    },
    (i) => reviseRecipe(root, i.id, i),
    false,
  );
  return server;
}

export async function startMcp(root: string, binding: McpBinding = {}): Promise<void> {
  const server = createMcpServer(root, binding);
  await server.connect(new StdioServerTransport());
}
import { createWorkForceMcpServer } from './workforce-requests.js';
