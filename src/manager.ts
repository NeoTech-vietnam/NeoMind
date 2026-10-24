import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { executionModes, isNativeExecutionMode, savedWorkflowExecutionMode,
  type ExecutionMode, type NativeClient } from './execution-mode.js';
import { lightweightStatus } from './lightweight.js';
import {
  atomicWrite,
  createRecord,
  getRecord,
  hash,
  loadRecords,
  now,
  readConfig,
  safePath,
  saveWorkflowClosure,
  updateRecord,
  withLock,
  withOperationLock,
} from './storage.js';
import {
  acceptTask,
  recordFingerprint,
  requirementsFor,
  requirementScope,
  strings,
  verify,
  assignmentDocumentationProblems,
} from './engineering.js';
import { prepareContribution } from './packs.js';
import { validateCornellNote } from './notes.js';
import { submitContribution } from './contributions.js';
import type { ProjectRecord } from './types.js';
import { readRoutingPolicy, routingProblems, assertRouting, readInvocation } from './routing.js';
import {
  readArchivePolicy,
  prepareArchive,
  publishArchive,
  archiveStatus,
  acceptedArchiveForWorkflow,
  assertPrivateArchiveDestination,
} from './archives.js';

export interface WorkflowInput {
  execution_mode?: ExecutionMode;
  /** Native client for a new lightweight increment; saved backends are immutable. */
  native_client?: NativeClient;
  requirement?: string | null;
  requirements?: string[] | null;
  title?: string;
  invocation_id?: string;
  request_id?: string;
  change_type?: 'breaking' | 'breaking-change' | 'feature' | 'fix';
}

/** Strict tool clients may send explicit placeholders for every optional field. */
export function normalizeWorkflowInput<T extends WorkflowInput>(input: T): T {
  const normalized = { ...input };
  for (const key of Object.keys(normalized) as (keyof T)[])
    if (normalized[key] === null) delete normalized[key];
  if (normalized.requirement !== undefined) {
    if (typeof normalized.requirement !== 'string')
      throw new Error('Requirement must be text or an unused null placeholder.');
    if (!normalized.requirement.trim()) delete normalized.requirement;
  }
  if (normalized.requirements !== undefined) {
    if (!Array.isArray(normalized.requirements))
      throw new Error('Requirements must be an array or an unused null placeholder.');
    if (!normalized.requirements.length) delete normalized.requirements;
  }
  return normalized;
}

import { knowledgeResearchProblems } from './knowledge-reuse.js';
import { publishProjectKnowledge } from './project-knowledge.js';
import { readNativeSoftwareContract, currentNativeSoftwareNotes, nativeSoftwareClosureProblems, effectiveNativeSoftwareCriteria } from './native-software.js';

export interface AutomationPolicy {
  schema_version: 1;
  network_policy?: 'local-only' | 'remote-enabled';
  knowledge_research_required?: boolean;
  cornell_publication?: 'project-branch' | 'draft-pr';
  manager_enabled: boolean;
  execution_mode?: ExecutionMode;
  documentation_required: true;
  automatic_pr: boolean;
  upstream: string | null;
  max_discussion_rounds: number;
}
function basePolicy(): Omit<AutomationPolicy, 'execution_mode'> {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const repository =
    typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url;
  const upstream =
    typeof repository === 'string'
      ? (/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repository)?.[1] ??
        null)
      : null;
  return {
    schema_version: 1,
    manager_enabled: true,
    documentation_required: true,
    automatic_pr: true,
    upstream,
    max_discussion_rounds: 3,
  };
}
export function defaultAutomationPolicy(): AutomationPolicy {
  return basePolicy();
}
/**
 * New-project default: full engineering with honest unsigned native assurance. Existing
 * saved policies are never rewritten, so a configured strict or default project is preserved.
 */
export function nativeAutomationPolicy(client: NativeClient = 'copilot'): AutomationPolicy {
  return { ...basePolicy(), execution_mode: client === 'codex' ? 'codex-native' : 'copilot-native',
    network_policy: 'local-only', automatic_pr: false,
    knowledge_research_required: true, cornell_publication: 'project-branch' };
}
export function readAutomationPolicy(root: string): AutomationPolicy {
  const path = safePath(root, '.neomind/automation.json');
  const policy = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : defaultAutomationPolicy();
  if (
    !policy ||
    policy.schema_version !== 1 ||
    typeof policy.manager_enabled !== 'boolean' ||
    (policy.network_policy !== undefined &&
      !['local-only', 'remote-enabled'].includes(policy.network_policy)) ||
    (policy.execution_mode !== undefined &&
      !executionModes.includes(policy.execution_mode)) ||
    policy.documentation_required !== true ||
    (policy.knowledge_research_required !== undefined && typeof policy.knowledge_research_required !== 'boolean') ||
    (policy.cornell_publication !== undefined && !['project-branch', 'draft-pr'].includes(policy.cornell_publication)) ||
    typeof policy.automatic_pr !== 'boolean' ||
    (policy.upstream !== null &&
      (typeof policy.upstream !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.upstream))) ||
    !Number.isInteger(policy.max_discussion_rounds) ||
    policy.max_discussion_rounds < 1 ||
    policy.max_discussion_rounds > 3
  )
    throw new Error('Invalid manager automation policy.');
  return policy;
}
/** Project-owned policy: upgrades never replace a configured upstream or an opt-out. */
export function ensureAutomationPolicy(root: string): AutomationPolicy {
  readConfig(root);
  return withLock(root, () => {
    const path = safePath(root, '.neomind/automation.json');
    if (!existsSync(path))
      atomicWrite(path, JSON.stringify(defaultAutomationPolicy(), null, 2) + '\n');
    return readAutomationPolicy(root);
  });
}
function text(value: string, name: string, maximum = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  return value.trim();
}
function workflow(root: string, id: string): ProjectRecord {
  const record = getRecord(root, id);
  if (record.meta.type !== 'knowledge' || record.meta.data.kind !== 'manager-workflow')
    throw new Error('Provide a manager workflow ID.');
  return record;
}
/** A native-client increment: full engineering, honest unsigned assurance, never the bridge. */
function isNativeWorkflow(parent: ProjectRecord): boolean {
  return (
    isNativeExecutionMode(parent.meta.data.execution_mode) &&
    parent.meta.data.routing_required !== true
  );
}
export function beginWorkflow(root: string, input: WorkflowInput): ProjectRecord {
  return withOperationLock(root, 'manager-intake', () =>
    beginWorkflowClaimed(root, normalizeWorkflowInput(input)),
  );
}
function beginWorkflowClaimed(root: string, input: WorkflowInput): ProjectRecord {
  const policy = ensureAutomationPolicy(root);
  if (!policy.manager_enabled) throw new Error('The project manager entrypoint is disabled.');
  if (input.requirement !== undefined && input.requirements !== undefined)
    throw new Error('Provide requirement or requirements, rather than both.');
  const originals = input.requirements ?? [input.requirement!];
  if (!Array.isArray(originals) || !originals.length || originals.length > 32)
    throw new Error('Provide between one and 32 requirements.');
  const requirements = originals.map((item, index) => text(item, `Requirement ${index + 1}`));
  const requirement =
    requirements.length === 1
      ? requirements[0]!
      : requirements.map((item, index) => `${index + 1}. ${item}`).join('\n');
  const changeType =
    input.change_type === 'breaking' ? 'breaking-change' : (input.change_type ?? 'feature');
  if (!['breaking-change', 'feature', 'fix'].includes(changeType))
    throw new Error('Invalid change classification.');
  const requestId = text(input.request_id ?? randomUUID(), 'Request ID', 256);
  const title = text(input.title ?? requirement.slice(0, 100), 'Title', 256);
  const requestedMode = input.execution_mode ?? policy.execution_mode ?? 'strict';
  if (!executionModes.includes(requestedMode))
    throw new Error('Invalid workflow execution mode.');
  if (requestedMode === 'lightweight')
    throw new Error(
      'Lightweight increments use the native-client checkpoint flow, not manager intake.',
    );
  const native = isNativeExecutionMode(requestedMode);
  let parent = loadRecords(root).find(
    (r) => ['manager-workflow', 'lightweight-workflow'].includes(String(r.meta.data.kind)) && r.meta.data.request_id === requestId,
  );
  if (parent) {
    if (parent.meta.data.kind !== 'manager-workflow')
      throw new Error('Saved lightweight workflow mode is immutable; resume its native-client checkpoint flow.');
    const savedMode = savedWorkflowExecutionMode(parent.meta.data);
    if (input.execution_mode !== undefined && input.execution_mode !== savedMode)
      throw new Error(
        'Saved workflow mode is immutable; create a new increment for a different execution mode.',
      );
  }
  if (
    parent &&
    (parent.meta.data.original_requirement !== requirement ||
      JSON.stringify(
        parent.meta.data.original_requirements ?? [parent.meta.data.original_requirement],
      ) !== JSON.stringify(requirements))
  )
    throw new Error('Request ID already belongs to a different requirement.');
  if (!parent)
    parent = createRecord(root, {
      type: 'knowledge',
      title: `Workflow: ${title}`,
      owner: 'manager',
      status: 'in-progress',
      data: {
        kind: 'manager-workflow',
        request_id: requestId,
        original_requirement: requirement,
        original_requirements: requirements,
        increment_id: randomUUID(),
        change_type: changeType,
        // Native increments never require a signed receipt even when the bridge is installed.
        routing_required: native ? false : readRoutingPolicy(root) !== null,
        knowledge_research_required: policy.knowledge_research_required === true,
        cornell_publication: policy.cornell_publication ?? 'draft-pr',
        ...(native
          ? { execution_mode: requestedMode, assurance: 'unsigned-native-report' }
          : {}),
        invocation_id: input.invocation_id ?? randomUUID(),
        phase: 'intake',
        task_ids: [],
        open_questions: [],
        created_by: 'natural-language-requirement',
      },
      body: `# Objective\n${requirement}\n\n# Resumption\nRead manager_status for the next action.\n`,
    });
  let rootRequirement = loadRecords(root).find(
    (r) =>
      r.meta.type === 'requirement' &&
      r.meta.data.intake_workflow_id === parent!.meta.id &&
      r.meta.data.batch_item === undefined,
  );
  if (!rootRequirement)
    rootRequirement = createRecord(root, {
      type: 'requirement',
      title,
      owner: 'requirements',
      data: { intake_workflow_id: parent.meta.id, acceptance_criteria: [], source: 'user-request' },
      body: `# Stakeholder requirement\n${requirement}\n\n# Acceptance criteria\nRefine measurable criteria from the request and clarification.\n`,
    });
  if (parent.meta.data.requirement_id !== rootRequirement.meta.id)
    parent = updateRecord(root, parent.meta.id, {
      data: { requirement_id: rootRequirement.meta.id },
      links: [{ type: 'documents', target: rootRequirement.meta.id }],
    });
  const leaves: string[] = [];
  if (requirements.length > 1) {
    for (const [index, item] of requirements.entries()) {
      let leaf = loadRecords(root).find(
        (record) =>
          record.meta.type === 'requirement' &&
          record.meta.data.intake_workflow_id === parent!.meta.id &&
          record.meta.data.batch_item === index,
      );
      if (!leaf)
        leaf = createRecord(root, {
          type: 'requirement',
          title: item.slice(0, 100),
          owner: 'requirements',
          data: {
            intake_workflow_id: parent.meta.id,
            batch_item: index,
            acceptance_criteria: [],
            source: 'user-request',
          },
          links: [{ type: 'derives-from', target: rootRequirement.meta.id }],
          body: `# Stakeholder requirement\n${item}\n\n# Acceptance criteria\nRefine measurable criteria for this independently verifiable outcome.\n`,
        });
      leaves.push(leaf.meta.id);
    }
  } else leaves.push(rootRequirement.meta.id);
  if (JSON.stringify(parent.meta.data.requirement_ids) !== JSON.stringify(leaves))
    parent = updateRecord(root, parent.meta.id, {
      data: { requirement_ids: leaves },
      links: [
        { type: 'documents', target: rootRequirement.meta.id },
        ...leaves
          .filter((target) => target !== rootRequirement.meta.id)
          .map((target) => ({ type: 'documents' as const, target })),
      ],
    });
  return parent;
}
export function bindManagerInvocation(
  root: string,
  id: string,
  invocationId: string,
): ProjectRecord {
  const parent = workflow(root, id);
  assertRouting(root, 'manager', invocationId, { workflow_id: id, require_completed: false });
  return updateRecord(root, id, { data: { invocation_id: invocationId } }, undefined, (current) => {
    if (current.meta.revision !== parent.meta.revision)
      throw new Error('Workflow changed before manager assignment.');
  });
}
/** Preserve intake identity while attributing new native decisions to the current claimed Coordinator. */
function managerInvocationIdentity(root: string, parent: ProjectRecord): unknown {
  const id = parent.meta.data.reported_manager_invocation_id;
  if (!isNativeWorkflow(parent) || id === undefined) return parent.meta.data.invocation_id;
  if (typeof id !== 'string' || !/^local-report-[a-f0-9]{40}$/.test(id)) throw new Error('Invalid reported manager identity.');
  const actor = JSON.parse(readFileSync(safePath(root, `.neomind/native/reported-assignments/${id}.json`), 'utf8'));
  if (actor.id !== id || actor.workflow_id !== parent.meta.id || actor.profile_id !== 'coordinator' || actor.role !== 'manager' ||
      actor.state !== 'claimed' || actor.assurance !== 'unsigned-local-assignment') throw new Error('Reported manager identity is not a claimed Coordinator assignment.');
  return id;
}
export const discussionRoles = [
  'researcher',
  'requirements',
  'architect',
  'component-owner',
  'developer',
  'verifier',
  'reviewer',
  'release',
  'curator',
  'manager',
  'codebase-analyst',
  'check-executor',
] as const;
export function discussWorkflow(
  root: string,
  id: string,
  input: {
    role: string;
    invocation_id: string;
    summary: string;
    rationale: string;
    risks?: string[];
    source_ids?: string[];
    round?: number;
  },
): ProjectRecord {
  const parent = workflow(root, id);
  const policy = readAutomationPolicy(root);
  if (!discussionRoles.includes(input.role as (typeof discussionRoles)[number]))
    throw new Error('Discussion role must match an installed role contract.');
  const invocationId = text(input.invocation_id, 'Invocation ID', 256);
  if (parent.meta.data.routing_required === true)
    assertRouting(root, input.role, invocationId, { workflow_id: id, require_completed: false });
  if (input.role !== 'manager' && [parent.meta.data.invocation_id, managerInvocationIdentity(root, parent)].includes(invocationId))
    throw new Error('Specialist discussion needs its own invocation identity.');
  const round = input.round ?? 1;
  if (!Number.isInteger(round) || round < 1 || round > policy.max_discussion_rounds)
    throw new Error('Discussion round exceeds the bounded project policy.');
  const sources = [...new Set(input.source_ids ?? [String(parent.meta.data.requirement_id)])];
  if (!sources.length || sources.length > 32)
    throw new Error('Discussion requires 1 to 32 inspected source record IDs.');
  const sourceBaseline = Object.fromEntries(
    sources.map((source) => {
      const r = getRecord(root, source);
      if (r.meta.data.kind === 'manager-workflow')
        throw new Error('Reference engineering inputs rather than mutable workflow state.');
      return [source, recordFingerprint(r)];
    }),
  );
  const risks = input.risks ?? [];
  if (risks.some((r) => typeof r !== 'string' || !r.trim()))
    throw new Error('Discussion risks must be nonempty strings.');
  return createRecord(root, {
    type: 'knowledge',
    title: `Discussion: ${input.role}`,
    owner: input.role,
    data: {
      kind: 'manager-discussion',
      workflow_id: id,
      invocation_id: invocationId,
      round,
      source_baseline: sourceBaseline,
      summary: text(input.summary, 'Summary'),
      rationale: text(input.rationale, 'Rationale'),
      risks,
    },
    links: [
      { type: 'documents', target: id },
      ...sources.map((target) => ({ type: 'references' as const, target })),
    ],
    body: `# Contribution\n${input.summary}\n\n# Rationale\n${input.rationale}\n\n# Risks\n${risks.length ? risks.join('\n') : 'No unresolved risk reported.'}\n\n# Sources\n${sources.join('\n')}\n`,
  });
}
function currentDiscussions(root: string, id: string): ProjectRecord[] {
  const latest = new Map<string, ProjectRecord>();
  for (const record of loadRecords(root)
    .filter((r) => r.meta.data.kind === 'manager-discussion' && r.meta.data.workflow_id === id)
    .sort((a, b) => a.meta.id.localeCompare(b.meta.id)))
    latest.set(record.meta.owner, record);
  return [...latest.values()].filter((record) => {
    const parent = workflow(root, id);
    if (
      parent.meta.data.routing_required === true &&
      routingProblems(root, record.meta.owner, String(record.meta.data.invocation_id), {
        workflow_id: id,
        require_completed: true,
      }).length
    )
      return false;
    const baseline = record.meta.data.source_baseline as Record<string, string>;
    return (
      baseline &&
      Object.entries(baseline).every(([source, fingerprint]) => {
        try {
          return recordFingerprint(getRecord(root, source)) === fingerprint;
        } catch {
          return false;
        }
      })
    );
  });
}
function taskContract(task: ProjectRecord): string {
  return hash(
    JSON.stringify({
      owner: task.meta.owner,
      requirements: requirementsFor(task),
      acceptance_criteria: task.meta.data.acceptance_criteria,
      allowed_paths: task.meta.data.allowed_paths,
      implementation_paths: task.meta.data.implementation_paths,
      verification_paths: task.meta.data.verification_paths,
      native_software_plan_hash: task.meta.data.native_software_plan_hash,
      dependencies: task.meta.data.dependencies,
      links: task.meta.links,
      documentation_paths: task.meta.data.documentation_paths,
      outputs: task.meta.data.outputs,
      documentation_required: task.meta.data.documentation_required,
      routing_required: task.meta.data.routing_required,
      workflow_id: task.meta.data.workflow_id,
      recipe_instance_ids: task.meta.data.recipe_instance_ids,
      protected_acceptance_paths: task.meta.data.protected_acceptance_paths,
      required_tools: task.meta.data.required_tools,
    }),
  );
}
function requirementAncestry(root: string, ids: string[]): string[] {
  return requirementScope(loadRecords(root), ids);
}
function allocatedTo(root: string, task: ProjectRecord, requirementId: string): boolean {
  return requirementAncestry(root, requirementsFor(task)).includes(requirementId);
}
export function decideWorkflow(
  root: string,
  id: string,
  input: {
    summary: string;
    rationale: string;
    task_ids: string[];
  },
): ProjectRecord {
  return withOperationLock(root, `manager-${hash(id)}`, () =>
    decideWorkflowClaimed(root, id, input),
  );
}
function decideWorkflowClaimed(
  root: string,
  id: string,
  input: {
    summary: string;
    rationale: string;
    task_ids: string[];
  },
): ProjectRecord {
  const parent = workflow(root, id);
  if (readRoutingPolicy(root) && parent.meta.data.routing_required !== true && !isNativeWorkflow(parent))
    throw new Error(
      'Legacy workflow planning requires alpha.3 migration and Sol reassessment; use a new increment for closed history.',
    );
  const software = readNativeSoftwareContract(root, id);
  if (software && (input.task_ids.length !== 1 || input.task_ids[0] !== software.task_id))
    throw new Error('An immutable software workflow decision must retain its exact contract-bound task.');
  const researchProblems = software ? [] : knowledgeResearchProblems(root, id, { check_workspace: true });
  if (researchProblems.length) throw new Error(researchProblems.join('\n'));
  const archiveIntent = safePath(root, `.neomind/archive-intents/${hash(id)}.json`);
  if (
    (parent.meta.data.archive &&
      (parent.meta.data.archive as { status?: string }).status !== 'deferred') ||
    acceptedArchiveForWorkflow(root, id) ||
    (existsSync(archiveIntent) && JSON.parse(readFileSync(archiveIntent, 'utf8')).snapshot_id)
  )
    throw new Error(
      'This increment has a frozen archive. Reconcile publication or start a new workflow increment; accepted history cannot be replanned.',
    );
  if (parent.meta.data.routing_required === true)
    assertRouting(root, 'manager', String(parent.meta.data.invocation_id), {
      workflow_id: id,
      require_completed: false,
    });
  const summary = text(input.summary, 'Summary');
  const rationale = text(input.rationale, 'Rationale');
  const rootRequirement = getRecord(root, String(parent.meta.data.requirement_id));
  if (!software && !strings(rootRequirement.meta.data.acceptance_criteria).length)
    throw new Error('Refine the stakeholder requirement into measurable acceptance criteria.');
  if (strings(parent.meta.data.open_questions).length)
    throw new Error('Resolve recorded product questions before deciding execution.');
  const participants = currentDiscussions(root, id).filter((r) => r.meta.owner !== 'manager');
  if (
    !software && (new Set(participants.map((r) => r.meta.owner)).size < 2 ||
    new Set(participants.map((r) => r.meta.data.invocation_id)).size < 2)
  )
    throw new Error(
      'Execution needs current contributions from two specialist roles in separate invocations.',
    );
  const ids = [...new Set(input.task_ids)];
  if (!ids.length) throw new Error('Decision needs at least one bounded task.');
  const replacedIds = strings(parent.meta.data.task_ids).filter((taskId) => !ids.includes(taskId));
  for (const taskId of replacedIds) {
    const prior = getRecord(root, taskId);
    if (prior.meta.data.workflow_id !== id)
      throw new Error('Prior assignment belongs to a different workflow.');
    if (prior.meta.status === 'in-progress')
      throw new Error(
        'Stop and hand off the active native worker before replacing its assignment.',
      );
  }
  const tasks = ids.map((taskId) => getRecord(root, taskId));
  const leafRequirements = strings(parent.meta.data.requirement_ids).length
    ? strings(parent.meta.data.requirement_ids)
    : [rootRequirement.meta.id];
  for (const requirementId of leafRequirements) {
    if (!software && !strings(getRecord(root, requirementId).meta.data.acceptance_criteria).length)
      throw new Error(
        `Refine measurable acceptance criteria for every requirement: ${requirementId}`,
      );
  }
  for (const task of tasks) {
    if (task.meta.type !== 'task' || !['draft', 'ready', 'blocked'].includes(task.meta.status))
      throw new Error('Plan tasks before implementation starts.');
    if (task.meta.data.workflow_id && task.meta.data.workflow_id !== id)
      throw new Error('Task already belongs to another workflow.');
    if (!allocatedTo(root, task, rootRequirement.meta.id))
      throw new Error(
        'Each task must trace to the stakeholder requirement or a derived requirement.',
      );
  }
  for (const requirementId of leafRequirements)
    if (!tasks.some((task) => allocatedTo(root, task, requirementId)))
      throw new Error(`Every requirement needs a bounded implementation task: ${requirementId}`);
  // Assign documentation responsibility before the task baseline is recorded.
  for (const task of tasks)
    updateRecord(root, task.meta.id, {
      data: {
        workflow_id: id,
        documentation_required: true,
        routing_required: parent.meta.data.routing_required === true,
        documentation_paths: task.meta.data.documentation_paths ?? [],
      },
    });
  const readyTasks = ids.map((taskId) => getRecord(root, taskId));
  for (const task of readyTasks) {
    // Dependencies inside this plan may be unaccepted; they gate dispatch, not planning.
    const report = verify(root, task.meta.id, 'design-ready');
    const failures = report.findings.filter(
      (f) => !['dependency-not-accepted', 'dependency-stale', 'blocked'].includes(f.code),
    );
    if (failures.length) throw new Error(failures.map((f) => f.message).join('\n'));
  }
  const requirementIds = requirementAncestry(root, [
    String(parent.meta.data.requirement_id),
    ...leafRequirements,
    ...readyTasks.flatMap(requirementsFor),
  ]);
  const requirements = Object.fromEntries(
    requirementIds.map((source) => [source, recordFingerprint(getRecord(root, source))]),
  );
  const taskContracts = Object.fromEntries(readyTasks.map(task => [task.meta.id, taskContract(task)]));
  const existingDecisions = software ? loadRecords(root).filter(record => record.meta.data.kind === 'manager-decision' &&
    record.meta.data.workflow_id === id && record.meta.data.summary === summary && record.meta.data.rationale === rationale &&
    JSON.stringify(record.meta.data.requirement_baseline) === JSON.stringify(requirements) &&
    JSON.stringify(record.meta.data.task_contracts) === JSON.stringify(taskContracts)) : [];
  if (existingDecisions.length > 1) throw new Error('Ambiguous interrupted software execution decisions; inspect history before continuing.');
  const decision = existingDecisions[0] ?? createRecord(root, {
    type: 'knowledge',
    title: 'Manager execution decision',
    owner: 'manager',
    data: {
      kind: 'manager-decision',
      workflow_id: id,
      invocation_id: managerInvocationIdentity(root, parent),
      ...(parent.meta.data.reported_manager_invocation_id ? { identity_assurance: 'unsigned-local-assignment', reported_assignment_id: parent.meta.data.reported_manager_invocation_id } : {}),
      summary,
      rationale,
      discussion_ids: participants.map((r) => r.meta.id),
      requirement_baseline: requirements,
      task_contracts: taskContracts,
    },
    links: [
      { type: 'documents', target: id },
      ...ids.map((target) => ({ type: 'references' as const, target })),
    ],
    body: `# Decision\n${summary}\n\n# Rationale\n${rationale}\n\n# Specialist contributions\n${participants.map((r) => r.meta.id).join('\n')}\n\n# Assignments\n${ids.join('\n')}\n`,
  });
  const history = Array.isArray(parent.meta.data.history) ? [...parent.meta.data.history] : [];
  if (parent.meta.data.decision_id)
    history.push({
      decision_id: parent.meta.data.decision_id,
      task_ids: parent.meta.data.task_ids,
      final_report_id: parent.meta.data.final_report_id ?? null,
      knowledge_ids: parent.meta.data.knowledge_ids ?? [],
      publications: parent.meta.data.publications ?? [],
      closed_at: parent.meta.data.closed_at ?? null,
    });
  for (const taskId of replacedIds) updateRecord(root, taskId, { status: 'superseded' });
  return updateRecord(
    root,
    id,
    {
      data: {
        phase: 'execution',
        task_ids: ids,
        decision_id: decision.meta.id,
        history,
        final_report_id: null,
        closed_at: null,
        knowledge_ids: [],
        no_lesson_reason: null,
        publications: [],
      },
      links: [
        { type: 'documents', target: String(parent.meta.data.requirement_id) },
        { type: 'references', target: decision.meta.id },
        ...ids.map((target) => ({ type: 'references' as const, target })),
        ...replacedIds.map((target) => ({ type: 'references' as const, target })),
      ],
    },
    undefined,
    (current) => {
      if (current.meta.revision !== parent.meta.revision)
        throw new Error(
          'Workflow changed during planning; reassess the current decision before retrying.',
        );
    },
  );
}
function decisionProblems(root: string, parent: ProjectRecord): string[] {
  const decisionId = parent.meta.data.decision_id;
  if (typeof decisionId !== 'string') return ['No integrated manager decision is recorded.'];
  const decision = getRecord(root, decisionId);
  if (
    decision.meta.data.kind !== 'manager-decision' ||
    decision.meta.data.workflow_id !== parent.meta.id
  )
    return ['Manager decision does not belong to this workflow.'];
  const problems: string[] = [];
  const leaves = strings(parent.meta.data.requirement_ids);
  for (const requirementId of leaves)
    if (
      !strings(parent.meta.data.task_ids).some((taskId) =>
        allocatedTo(root, getRecord(root, taskId), requirementId),
      )
    )
      problems.push(`Requirement no longer has implementation coverage: ${requirementId}`);
  for (const [id, fingerprint] of Object.entries(
    decision.meta.data.requirement_baseline as Record<string, string>,
  ))
    if (recordFingerprint(getRecord(root, id)) !== fingerprint)
      problems.push(`Requirement changed after the decision: ${id}`);
  for (const [id, fingerprint] of Object.entries(
    decision.meta.data.task_contracts as Record<string, string>,
  ))
    if (taskContract(getRecord(root, id)) !== fingerprint)
      problems.push(`Task contract changed after the decision: ${id}`);
  for (const id of strings(parent.meta.data.task_ids))
    if (!allocatedTo(root, getRecord(root, id), String(parent.meta.data.requirement_id)))
      problems.push(`Task no longer traces to the stakeholder requirement: ${id}`);
  return problems;
}
export function workflowStatus(root: string, id?: string): unknown {
  if (!id)
    return loadRecords(root)
      .filter((r) => ['manager-workflow', 'lightweight-workflow'].includes(String(r.meta.data.kind)))
      .map((r) => workflowStatus(root, r.meta.id));
  const record = getRecord(root, id);
  if (record.meta.data.kind === 'lightweight-workflow') return lightweightStatus(record);
  const parent = workflow(root, id);
  let recoveredArchive: ReturnType<typeof acceptedArchiveForWorkflow> = null;
  let archiveError: string | null = null;
  try {
    recoveredArchive = acceptedArchiveForWorkflow(root, id);
  } catch (error) {
    archiveError = String(error);
  }
  const intentPath = safePath(root, `.neomind/archive-intents/${hash(id)}.json`);
  const intent = existsSync(intentPath)
    ? (JSON.parse(readFileSync(intentPath, 'utf8')) as { snapshot_id?: string; error?: string })
    : null;
  const completionPath =
    typeof parent.meta.data.invocation_id === 'string' &&
    /^[a-f0-9-]{36}$/.test(parent.meta.data.invocation_id)
      ? safePath(root, `.neomind/native/completion/${parent.meta.data.invocation_id}.json`)
      : null;
  const completionError =
    completionPath && existsSync(completionPath)
      ? JSON.parse(readFileSync(completionPath, 'utf8')).error
      : null;
  const policy = readAutomationPolicy(root);
  const localOnly = policy.network_policy === 'local-only';
  const closureBlockers = [
    ...(!localOnly && intent?.error ? [intent.error] : []),
    ...(completionError ? [completionError] : []),
    ...(archiveError ? [archiveError] : []),
  ];
  const questions = strings(parent.meta.data.open_questions);
  const managerAttemptId =
    parent.meta.data.native_manager_attempt_id ?? parent.meta.data.invocation_id;
  let managerAttempt: ReturnType<typeof readInvocation> | null = null;
  if (typeof managerAttemptId === 'string')
    try {
      managerAttempt = readInvocation(root, managerAttemptId);
    } catch {
      // Historical intake identities are not native invocation observations.
    }
  const managerBlocker = recoveredArchive
    ? null
    : (parent.meta.data.native_manager_blocker ??
      (managerAttempt && ['blocked', 'waiting-native-permission'].includes(managerAttempt.state)
        ? (managerAttempt.error ?? managerAttempt.state)
        : null));
  const ids = strings(parent.meta.data.task_ids);
  const taskStates = ids.map((taskId) => {
    const task = getRecord(root, taskId);
    return {
      id: taskId,
      owner: task.meta.owner,
      status: task.meta.status,
      documentation_required: task.meta.data.documentation_required === true,
      ready: verify(root, taskId, 'ready'),
      accepted: verify(root, taskId, 'accepted'),
    };
  });
  const decisionFindings = parent.meta.data.decision_id ? decisionProblems(root, parent) : [];
  const nativeCompletionFindings =
    parent.meta.data.routing_required === true &&
    ['completed', 'awaiting-native-completion'].includes(String(parent.meta.data.phase))
      ? routingProblems(
          root,
          'manager',
          typeof parent.meta.data.invocation_id === 'string'
            ? parent.meta.data.invocation_id
            : undefined,
          { workflow_id: id },
        )
      : [];
  let nextAction: string;
  if (questions.length) nextAction = 'Clarify the recorded product questions with the user.';
  else if (managerBlocker)
    nextAction = 'Resolve the recorded native coordinator blocker and resume the saved increment.';
  else if (decisionFindings.length)
    nextAction = 'Reassess changed requirements/contracts and record a fresh specialist decision.';
  else if (!parent.meta.data.decision_id)
    nextAction =
      'Collect specialist contributions, measurable requirements, reviewed design, and bounded tasks; record the manager decision.';
  else if (taskStates.some((t) => t.status === 'blocked'))
    nextAction =
      'Resolve the recorded blocker internally or report the specific external dependency.';
  else if (taskStates.some((t) => t.status !== 'accepted' || !t.accepted.ok))
    nextAction =
      'Dispatch ready tasks, collect complete documentation/evidence, obtain separate reviews, and accept validated submissions.';
  else if (parent.meta.data.phase === 'completed-with-blockers' || closureBlockers.length)
    nextAction =
      'Retry the saved publication blocker when credentials or the upstream become available.';
  else if (nativeCompletionFindings.length)
    nextAction =
      'Wait for the native coordinator completion and automatic archive, or inspect its recorded blocker.';
  else if (parent.meta.data.phase === 'completed')
    nextAction =
      'Deliver the saved final report; resume only for a new requirement or changed baseline.';
  else
    nextAction =
      'Curate qualified lessons and run manager_finish to prepare/submit documentation PRs and write the final report.';
  const phase = questions.length
    ? 'clarification-required'
    : managerBlocker
      ? 'native-blocked'
      : decisionFindings.length
        ? 'reassessment-required'
        : parent.meta.data.decision_id &&
            taskStates.some((t) => t.status !== 'accepted' || !t.accepted.ok)
          ? 'execution'
          : closureBlockers.length
            ? 'completed-with-blockers'
            : nativeCompletionFindings.length
              ? 'awaiting-native-completion'
              : recoveredArchive
                ? 'completed'
                : parent.meta.data.phase;
  return {
    workflow_id: id,
    requirement_id: parent.meta.data.requirement_id,
    requirement_ids: parent.meta.data.requirement_ids ?? [parent.meta.data.requirement_id],
    increment_id: parent.meta.data.increment_id ?? null,
    change_type: parent.meta.data.change_type ?? 'feature',
    execution_mode: savedWorkflowExecutionMode(parent.meta.data),
    assurance:
      isNativeWorkflow(parent)
        ? 'unsigned-native-report'
        : parent.meta.data.routing_required === true
          ? 'signed-native-routing'
          : 'unsigned-legacy',
    phase,
    persisted_phase: parent.meta.data.phase,
    policy,
    open_questions: questions,
    decision_findings: decisionFindings,
    native_completion_findings: nativeCompletionFindings,
    native_manager_attempt_id: !isNativeWorkflow(parent) && typeof managerAttemptId === 'string' ? managerAttemptId : null,
    reported_manager_invocation_id: isNativeWorkflow(parent) ? managerInvocationIdentity(root, parent) : null,
    native_manager_state: managerAttempt?.state ?? null,
    native_manager_blocker: managerBlocker,
    archive: parent.meta.data.archive ?? recoveredArchive?.publication ?? null,
    closure_blockers: closureBlockers,
    ...(localOnly && intent?.error
      ? { deferred_remote_publication: { historical_archive_error: intent.error } }
      : {}),
    tasks: taskStates,
    next_action: nextAction,
    final_report_id: parent.meta.data.final_report_id ?? null,
    ...(isNativeWorkflow(parent) && typeof parent.meta.data.final_report_id === 'string'
      ? { final_report: getRecord(root, parent.meta.data.final_report_id).body,
          human_release: 'pending-human-approval' } : {}),
    history: parent.meta.data.history ?? [],
    publications: parent.meta.data.publications ?? [],
    publication_history: parent.meta.data.publication_history ?? [],
    publication_retirements: parent.meta.data.publication_retirements ?? [],
    orchestration:
      'The active native manager dispatches workers; this core records and validates state.',
  };
}
export function finishWorkflow(
  root: string,
  id: string,
  input: {
    knowledge_ids?: string[];
    no_lesson_reason?: string;
    retired_candidates?: { knowledge_id: string; reason: string }[];
  },
  publish: typeof submitContribution = submitContribution,
  archivePublisher: typeof publishArchive = publishArchive,
  projectKnowledgePublisher: typeof publishProjectKnowledge = publishProjectKnowledge,
): unknown {
  return withOperationLock(root, `manager-${hash(id)}`, () =>
    finishWorkflowClaimed(root, id, input, publish, archivePublisher, projectKnowledgePublisher),
  );
}
function finishWorkflowClaimed(
  root: string,
  id: string,
  input: {
    knowledge_ids?: string[];
    no_lesson_reason?: string;
    retired_candidates?: { knowledge_id: string; reason: string }[];
  },
  publish: typeof submitContribution,
  archivePublisher: typeof publishArchive,
  projectKnowledgePublisher: typeof publishProjectKnowledge,
): unknown {
  const parent = workflow(root, id);
  if (
    readRoutingPolicy(root) &&
    parent.meta.data.routing_required !== true &&
    !isNativeWorkflow(parent) &&
    (!['completed', 'completed-with-blockers'].includes(String(parent.meta.data.phase)) ||
      typeof parent.meta.data.final_report_id !== 'string')
  )
    throw new Error(
      'Pending legacy workflow requires alpha.3 migration and confirmed Sol coordination before closure.',
    );
  let managerCompleted = true;
  if (parent.meta.data.routing_required === true) {
    const receipt = assertRouting(
      root,
      'manager',
      typeof parent.meta.data.invocation_id === 'string'
        ? parent.meta.data.invocation_id
        : undefined,
      { workflow_id: id, require_completed: false },
    );
    managerCompleted = receipt!.state === 'completed' && receipt!.inference_completed;
  }
  if (strings(parent.meta.data.open_questions).length)
    throw new Error('Resolve outstanding product questions before closing the workflow.');
  const software = readNativeSoftwareContract(root, id);
  if (software && JSON.stringify(strings(parent.meta.data.task_ids)) !== JSON.stringify([software.task_id]))
    throw new Error('Software closure must retain its immutable contract-bound task.');
  const decisionFindings = [...decisionProblems(root, parent), ...(software ? nativeSoftwareClosureProblems(root, id) : knowledgeResearchProblems(root, id))];
  if (decisionFindings.length) throw new Error(decisionFindings.join('\n'));
  const taskIds = strings(parent.meta.data.task_ids);
  if (!taskIds.length) throw new Error('Workflow has no assigned tasks.');
  if (parent.meta.data.routing_required === true || isNativeWorkflow(parent)) {
    const problems = assignmentDocumentationProblems(root, id);
    if (problems.length) throw new Error(problems.join('\n'));
  }
  for (const taskId of taskIds) {
    const task = getRecord(root, taskId);
    if (task.meta.data.workflow_id !== id || task.meta.data.documentation_required !== true)
      throw new Error('Workflow assignments must retain their documentation contract.');
    const report = verify(root, taskId, 'accepted');
    if (!report.ok)
      throw new Error(report.findings.map((f) => `${taskId}: ${f.message}`).join('\n'));
  }
  const cornellNotes = software ? currentNativeSoftwareNotes(root, software) : isNativeWorkflow(parent) ? loadRecords(root).filter((record) =>
    record.meta.data.workflow_id === id && record.meta.data.format === 'cornell-v1') : [];
  if (isNativeWorkflow(parent) && !cornellNotes.length)
    throw new Error('Native closure requires an evidence-linked Cornell note. Call note_create with note.workflow_id and requirement_ids before manager_finish.');
  const requirementIds = new Set([
    ...strings(parent.meta.data.requirement_ids),
    String(parent.meta.data.requirement_id),
  ]);
  for (const note of cornellNotes) {
    const validation = validateCornellNote(root, note.meta.id);
    if (!validation.ok) throw new Error(validation.problems.join('\n'));
    if (!note.meta.links.some((link) => requirementIds.has(link.target) || taskIds.includes(link.target)))
      throw new Error('Final Cornell findings must link a requirement or task from this workflow.');
  }
  const cornellDelivery = cornellNotes.map((note) => ({ id: note.meta.id,
    path: String(note.meta.data.artifact_path),
    body: readFileSync(safePath(root, String(note.meta.data.artifact_path)), 'utf8') }));
  const testReports = cornellNotes.length ? loadRecords(root).filter((record) =>
    record.meta.type === 'evidence' && record.meta.data.workflow_id === id).map((record) => ({
      id: record.meta.id, result: record.meta.data.result, method: record.meta.data.method,
      exit_code: record.meta.data.exit_code, log_path: record.meta.data.log_path,
      receipt_path: record.meta.data.receipt_path, body: record.body,
    })) : [];
  const retired = input.retired_candidates ?? [];
  const previousIds = strings(parent.meta.data.knowledge_ids);
  const retiredIds = new Set<string>();
  for (const disposition of retired) {
    if (
      !previousIds.includes(disposition.knowledge_id) ||
      retiredIds.has(disposition.knowledge_id) ||
      input.knowledge_ids?.includes(disposition.knowledge_id)
    )
      throw new Error(
        'Retire each saved candidate once, without selecting it again for this closure.',
      );
    const reason = text(disposition.reason, 'Candidate retirement reason');
    if (reason.split(/\s+/).length < 4 || reason.length < 24)
      throw new Error(
        'Candidate retirement needs a specific documented replacement or withdrawal reason.',
      );
    retiredIds.add(disposition.knowledge_id);
  }
  const knowledgeIds = [
    ...new Set([
      ...previousIds.filter((candidate) => !retiredIds.has(candidate)),
      ...(input.knowledge_ids ?? []),
    ]),
  ];
  const noLessonReason =
    input.no_lesson_reason ?? (parent.meta.data.no_lesson_reason as string | undefined);
  if (!knowledgeIds.length && !noLessonReason?.trim())
    throw new Error('Closure requires qualified lessons or an explicit no-lesson rationale.');
  if (
    !knowledgeIds.length &&
    (noLessonReason!.trim().split(/\s+/).length < 8 || noLessonReason!.trim().length < 40)
  )
    throw new Error(
      'The no-lesson rationale must explain why this reviewed work adds no qualified reusable insight.',
    );
  for (const knowledgeId of knowledgeIds) {
    const candidate = getRecord(root, knowledgeId);
    if (
      candidate.meta.type !== 'knowledge' ||
      candidate.meta.data.workflow_id !== id ||
      !candidate.meta.links.some((l) => taskIds.includes(l.target))
    )
      throw new Error('A contribution must link this workflow and one of its reviewed tasks.');
    prepareContribution(root, knowledgeId);
  }
  const candidateBaseline = Object.fromEntries(
    knowledgeIds.map((knowledgeId) => [
      knowledgeId,
      recordFingerprint(getRecord(root, knowledgeId)),
    ]),
  );
  for (const taskId of taskIds)
    if (getRecord(root, taskId).meta.status !== 'accepted') acceptTask(root, taskId);
  const policy = readAutomationPolicy(root);
  const localOnly = policy.network_policy === 'local-only';
  const remoteArchiveEnabled = !localOnly && readArchivePolicy(root)?.enabled;
  const publications: Record<string, unknown>[] = [];
  const blockers: string[] = [];
  for (const knowledgeId of knowledgeIds) {
    if (localOnly || !policy.automatic_pr) {
      publications.push({
        knowledge_id: knowledgeId,
        status: 'prepared-locally',
        reason: localOnly
          ? 'Local-only policy defers remote knowledge publication. Set network_policy to "remote-enabled" in .neomind/automation.json to opt in.'
          : 'Project policy disables automatic knowledge publication.',
      });
    } else if (!policy.upstream) {
      blockers.push('Configure the shared knowledge upstream before publication.');
      publications.push({ knowledge_id: knowledgeId, status: 'blocked', reason: blockers.at(-1) });
    } else {
      try {
        const projectBranch = parent.meta.data.cornell_publication === 'project-branch';
        const submission = (projectBranch
          ? projectKnowledgePublisher(root, knowledgeId, policy.upstream)
          : publish(root, knowledgeId, policy.upstream)) as unknown as Record<string, unknown>;
        if (projectBranch ? (submission.status !== 'branch-published' || !submission.commit || !submission.branch)
          : (submission.status !== 'draft-pr-created' || typeof submission.upstream_pr !== 'string' || !submission.upstream_pr))
          throw new Error('Upstream submission did not confirm its publication identity.');
        publications.push({ knowledge_id: knowledgeId, ...submission });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blockers.push(message);
        publications.push({ knowledge_id: knowledgeId, status: 'blocked', reason: message });
      }
    }
  }
  function assertCurrent(current: ProjectRecord): void {
    if (
      current.meta.revision !== parent.meta.revision ||
      current.meta.data.decision_id !== parent.meta.data.decision_id
    )
      throw new Error(
        'Workflow changed during closure; preserve publication state and reassess the current decision.',
      );
    const currentSoftware = readNativeSoftwareContract(root, id);
    const findings = [...decisionProblems(root, current), ...(currentSoftware ? nativeSoftwareClosureProblems(root, id) : knowledgeResearchProblems(root, id))];
    if (currentSoftware && JSON.stringify(currentNativeSoftwareNotes(root, currentSoftware).map(note => note.meta.id)) !== JSON.stringify(cornellNotes.map(note => note.meta.id)))
      findings.push('Current evidence-linked final Cornell note selection changed during closure.');
    for (const note of cornellNotes) {
      if (recordFingerprint(getRecord(root, note.meta.id)) !== recordFingerprint(note))
        findings.push(`Cornell findings changed during closure: ${note.meta.id}`);
      findings.push(...validateCornellNote(root, note.meta.id).problems);
    }
    if (strings(current.meta.data.open_questions).length)
      findings.push('Outstanding product questions require clarification.');
    if (JSON.stringify(readAutomationPolicy(root)) !== JSON.stringify(policy))
      findings.push('Automation policy changed during closure.');
    for (const taskId of taskIds) {
      const report = verify(root, taskId, 'accepted');
      if (!report.ok) findings.push(...report.findings.map((f) => `${taskId}: ${f.message}`));
    }
    for (const [candidateId, fingerprint] of Object.entries(candidateBaseline)) {
      if (recordFingerprint(getRecord(root, candidateId)) !== fingerprint)
        findings.push(`Knowledge candidate changed during closure: ${candidateId}`);
      prepareContribution(root, candidateId);
    }
    if (findings.length) throw new Error(findings.join('\n'));
  }
  assertCurrent(workflow(root, id));
  const decision = getRecord(root, String(parent.meta.data.decision_id));
  const publicationHistory = Array.isArray(parent.meta.data.publication_history)
    ? [...parent.meta.data.publication_history]
    : [];
  for (const batch of [parent.meta.data.publications, publications]) {
    if (
      Array.isArray(batch) &&
      batch.length &&
      !publicationHistory.some(
        (entry) => JSON.stringify(entry.publications) === JSON.stringify(batch),
      )
    )
      publicationHistory.push({
        decision_id: parent.meta.data.decision_id,
        recorded_at: now(),
        publications: batch,
      });
  }
  const history = software?.historical_planning;
  const applicability = software ? effectiveNativeSoftwareCriteria(root, software).disposition : null;
  const historicalDisclosure = history ? `The explicit software-tools contract superseded pre-contract planning for this increment. Earlier administrative records ${history.administrative_records.map(record => record.id).join(', ') || '(none)'} and planning notes ${history.cornell_notes.map(record => record.id).join(', ') || '(none)'} remain historical; missing old actor reports are not retrospectively completed. Only the current scoped software process and its final evidence-linked Cornell findings are accepted. ` : '';
  const applicabilityDisclosure = applicability ? `A declared local administrative applicability policy (${applicability.input_hash}) retained behavioral acceptance, actual independent verification, negative controls and independent final review while replacing only its exact recorded historical ceremony clauses. Original criteria are preserved, not retrospectively marked fulfilled. ` : '';
  const assuranceNote = historicalDisclosure + applicabilityDisclosure + (isNativeWorkflow(parent)
    ? 'This increment is an unsigned native report: full engineering gates, independent review and immutable evidence capture apply, but no signed bridge receipt attests the executing model. '
    : '') + (localOnly
      ? 'Local-only policy defers remote knowledge and archive publication; local records are retained. '
      : '');
  const body = `# Objective\n${parent.meta.data.original_requirement}\n\n# Inputs and Sources\nRequirement: ${parent.meta.data.requirement_id}\nTasks: ${taskIds.join(', ')}\n\n# Decisions and Rationale\n${decision.meta.data.summary}\n${decision.meta.data.rationale}\nDecision record: ${decision.meta.id}\n\n# Results\nAll ${taskIds.length} assigned tasks passed current acceptance checks.\nDocumentation and separate review were validated before closure.\n\n# Evidence\n${taskIds.map((taskId) => `Trace ${taskId} for checked baselines, work records, evidence, and review.`).join('\n')}\n\n# Limitations\n${assuranceNote}${blockers.length ? blockers.join('\n') : 'Native model identity and execution capabilities are limited to recorded observations.'}\n\n# Lessons\n${knowledgeIds.length ? knowledgeIds.map((knowledgeId) => `${knowledgeId}: ${JSON.stringify(publications.find((p) => p.knowledge_id === knowledgeId))}`).join('\n') : noLessonReason}\n`;
  const finalBody = cornellDelivery.length ? `${body}\n# Test Reports\n${testReports.map((report) => `${report.id}: ${JSON.stringify(report)}\n`).join('\n')}\n# Cornell Findings\n${cornellDelivery.map((note) => `${note.id}: ${note.path}\n\n${note.body}`).join('\n\n')}\n# Human Release Gate\nPending human review of test reports and Cornell findings. Engineering acceptance does not authorize release.\n` : body;
  let reportId =
    typeof parent.meta.data.final_report_id === 'string' ? parent.meta.data.final_report_id : null;
  const closureIntentPath = safePath(root, `.neomind/archive-intents/${hash(id)}.json`);
  if (!reportId && remoteArchiveEnabled) {
    const intent = existsSync(closureIntentPath)
      ? JSON.parse(readFileSync(closureIntentPath, 'utf8'))
      : {};
    if (typeof intent.report_id === 'string') reportId = getRecord(root, intent.report_id).meta.id;
    else {
      const historicalReports = (
        Array.isArray(parent.meta.data.history) ? parent.meta.data.history : []
      ).map((item) => item.final_report_id);
      reportId =
        loadRecords(root).find(
          (record) =>
            record.meta.owner === 'manager' &&
            record.meta.title === 'Manager final report' &&
            record.meta.data.workflow_id === id &&
            !historicalReports.includes(record.meta.id),
        )?.meta.id ?? null;
    }
  }
  if (reportId) {
    if (getRecord(root, reportId).body !== finalBody) updateRecord(root, reportId, {}, finalBody);
  } else
    reportId = createRecord(root, {
      type: 'knowledge',
      title: 'Manager final report',
      owner: 'manager',
      data: { kind: 'work-record', workflow_id: id, invocation_id: managerInvocationIdentity(root, parent),
        ...(parent.meta.data.reported_manager_invocation_id ? { identity_assurance: 'unsigned-local-assignment', reported_assignment_id: parent.meta.data.reported_manager_invocation_id } : {}) },
      links: [{ type: 'documents', target: id }],
      body: finalBody,
    }).meta.id;
  if (remoteArchiveEnabled) {
    const intent = existsSync(closureIntentPath)
      ? JSON.parse(readFileSync(closureIntentPath, 'utf8'))
      : {};
    atomicWrite(
      closureIntentPath,
      JSON.stringify({ ...intent, workflow_id: id, report_id: reportId }, null, 2) + '\n',
    );
  }
  const recovered = acceptedArchiveForWorkflow(root, id);
  let archive: unknown = parent.meta.data.archive ?? recovered?.publication ?? null;
  if (localOnly && !archive)
    archive = {
      status: 'deferred',
      reason: 'Local-only policy preserves local records and defers remote archive publication. Set network_policy to "remote-enabled" in .neomind/automation.json to opt in.',
    };
  if (managerCompleted && remoteArchiveEnabled) {
    const intentPath = safePath(root, `.neomind/archive-intents/${hash(id)}.json`);
    try {
      assertCurrent(workflow(root, id));
      const priorSnapshot =
        (archive as { snapshot_id?: string } | null)?.snapshot_id ??
        (existsSync(intentPath)
          ? JSON.parse(readFileSync(intentPath, 'utf8')).snapshot_id
          : undefined);
      // Check destination setup before binding an immutable snapshot to it.
      // Injected publishers are offline transaction fixtures, not native publication proof.
      if (!priorSnapshot && archivePublisher === publishArchive)
        assertPrivateArchiveDestination(root);
      const snapshot = priorSnapshot
        ? (archiveStatus(root, priorSnapshot) as { snapshot_id: string })
        : prepareArchive(root, id, { disposition: 'accepted' });
      atomicWrite(
        intentPath,
        JSON.stringify(
          { workflow_id: id, report_id: reportId, snapshot_id: snapshot.snapshot_id },
          null,
          2,
        ) + '\n',
      );
      const publication = archivePublisher(root, snapshot.snapshot_id);
      archive = { ...publication };
    } catch (error) {
      blockers.push(`Project archive: ${error instanceof Error ? error.message : String(error)}`);
      if (existsSync(intentPath))
        atomicWrite(
          intentPath,
          JSON.stringify(
            { ...JSON.parse(readFileSync(intentPath, 'utf8')), error: blockers.at(-1), at: now() },
            null,
            2,
          ) + '\n',
        );
      // Publication intents live outside frozen records so an interrupted write can retry the same snapshot.
      return {
        ...(workflowStatus(root, id) as object),
        phase: 'completed-with-blockers',
        final_report: finalBody,
        cornell_notes: cornellDelivery,
        test_reports: testReports,
        publication_blockers: blockers,
      };
    }
  }
  saveWorkflowClosure(
    root,
    id,
    {
      status: 'verified',
      data: {
        phase: blockers.length
          ? 'completed-with-blockers'
          : managerCompleted
            ? 'completed'
            : 'awaiting-native-completion',
        closed_at: now(),
        final_report_id: reportId,
        knowledge_ids: knowledgeIds,
        no_lesson_reason: noLessonReason ?? null,
        publications,
        archive,
        publication_history: publicationHistory,
        publication_retirements: [
          ...(Array.isArray(parent.meta.data.publication_retirements)
            ? parent.meta.data.publication_retirements
            : []),
          ...retired.map((disposition) => ({
            ...disposition,
            retired_at: now(),
            previous_publications: publicationHistory
              .flatMap((entry) => entry.publications)
              .filter((p: Record<string, unknown>) => p.knowledge_id === disposition.knowledge_id),
          })),
        ],
      },
    },
    assertCurrent,
  );
  return {
    ...(workflowStatus(root, id) as object),
    final_report: finalBody,
    cornell_notes: cornellDelivery,
    test_reports: testReports,
    publication_blockers: blockers,
  };
}
