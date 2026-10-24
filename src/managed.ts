import { agentProfiles, coordinatorAgentName, nativeActivityInstructions } from './agent-profiles.js';
import { executionModes, isNativeExecutionMode, nativeClientForMode, savedWorkflowExecutionMode } from './execution-mode.js';
import {
  beginWorkflow,
  bindManagerInvocation,
  workflowStatus,
  finishWorkflow,
  normalizeWorkflowInput,
  readAutomationPolicy,
  type WorkflowInput,
} from './manager.js';
import { nativeStatus, startNative, resumeNative, interruptNative } from './native.js';
import {
  invocationIsActive,
  ownerIsAlive,
  readInvocation,
  readRoutingPolicy,
  assertRouting,
  canonicalJson,
  routingConfigurationHashes,
  type NativeReceipt,
} from './routing.js';
import { getRecord, loadRecords, updateRecord, hash, safePath } from './storage.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolveCapabilities, type ProviderId } from './tools.js';
import { lightweightRun } from './lightweight.js';
import { prepareWork } from './procedure-reuse.js';

export interface ManagedRunInput extends WorkflowInput {
  workflow_id?: string;
  providers?: ProviderId[];
  message?: string;
}
export interface ManagedRunResult {
  workflow: unknown;
  invocation?: NativeReceipt;
  blocker?: string;
  handoff?: { agent: string; prompt: string };
}
/** Strict bridge coordinator or configured native-client lightweight handoff. */
export async function managedRun(
  root: string,
  input: ManagedRunInput,
  ownerToken?: string,
): Promise<ManagedRunResult> {
  input = normalizeWorkflowInput(input);
  const policy = readAutomationPolicy(root);
  if (!policy.manager_enabled) throw new Error('The project manager entrypoint is disabled.');
  if (input.execution_mode !== undefined && !executionModes.includes(input.execution_mode))
    throw new Error('Invalid workflow execution mode.');
  // An idempotent request is a resumption too: a later default-policy change
  // cannot duplicate it in another mode or select a different native backend.
  const saved = input.workflow_id ? getRecord(root, input.workflow_id)
    : typeof input.request_id === 'string' ? loadRecords(root).find(record =>
      ['manager-workflow', 'lightweight-workflow'].includes(String(record.meta.data.kind)) &&
      record.meta.data.request_id === input.request_id!.trim()) : undefined;
  const savedMode = saved ? savedWorkflowExecutionMode(saved.meta.data) : undefined;
  if (saved && input.execution_mode && input.execution_mode !== savedMode)
    throw new Error('Saved workflow mode cannot be changed; create a new increment.');
  const mode = savedMode ?? input.execution_mode ?? policy.execution_mode ?? 'strict';
  if (mode === 'lightweight') {
    return lightweightRun(root, input);
  }
  if (isNativeExecutionMode(mode)) return nativeRun(root, { ...input, execution_mode: mode });
  const parent = input.workflow_id
    ? getRecord(root, input.workflow_id)
    : beginWorkflow(root, input);
  if (parent.meta.type !== 'knowledge' || parent.meta.data.kind !== 'manager-workflow')
    throw new Error('Managed resumption requires an existing manager workflow.');
  const originals = parent.meta.data.original_requirements ?? [
    parent.meta.data.original_requirement,
  ];
  if (input.workflow_id && (input.requirement !== undefined || input.requirements !== undefined)) {
    if (input.requirement !== undefined && input.requirements !== undefined)
      throw new Error('Provide requirement or requirements, rather than both.');
    const provided = (input.requirements ?? [input.requirement!]).map((item) => item.trim());
    if (JSON.stringify(provided) !== JSON.stringify(originals))
      throw new Error(
        'Resumption requirements differ from the saved increment. Submit a new requirement or record a reviewed change.',
      );
  }
  const current = workflowStatus(root, parent.meta.id) as { phase?: string };
  if (current.phase === 'completed') return { workflow: current };
  let previous: NativeReceipt | undefined;
  const priorId = parent.meta.data.native_manager_attempt_id ?? parent.meta.data.invocation_id;
  if (typeof priorId === 'string')
    try {
      previous = readInvocation(root, priorId);
    } catch {
      /* Legacy or intake placeholder identities do not establish native execution. */
    }
  if (previous && invocationIsActive(previous) && ownerIsAlive(previous.owner_pid))
    return { workflow: current, invocation: previous };
  const intentPath = safePath(root, `.neomind/archive-intents/${hash(parent.meta.id)}.json`);
  const pendingIntent = existsSync(intentPath)
    ? typeof JSON.parse(readFileSync(intentPath, 'utf8')).snapshot_id === 'string'
    : false;
  if (
    ['awaiting-native-completion', 'completed-with-blockers'].includes(current.phase ?? '') ||
    ['awaiting-native-completion', 'completed-with-blockers'].includes(
      String(parent.meta.data.phase),
    ) ||
    pendingIntent
  ) {
    try {
      if (!previous || previous.state !== 'completed')
        throw new Error(
          'Saved completion requires its successfully completed native coordinator before publication recovery.',
        );
      assertRouting(root, 'manager', previous.id, { workflow_id: parent.meta.id });
      const result = finishWorkflow(root, parent.meta.id, {}) as {
        publication_blockers?: string[];
      };
      return {
        workflow: result,
        ...(result.publication_blockers?.length
          ? { blocker: result.publication_blockers.join('\n') }
          : {}),
      };
    } catch (error) {
      // Frozen snapshots retain the original coordinator and closure records.
      // Reassessment is explicit; a retry must not launch a replacement turn.
      return {
        workflow: workflowStatus(root, parent.meta.id),
        blocker: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    if (!readRoutingPolicy(root))
      throw new Error('Strict native routing must be installed before managed execution.');
    for (const provider of input.providers ?? [])
      await resolveCapabilities(root, {
        role: provider === 'playwright' ? 'developer' : 'manager',
        providers: [provider],
      });
    // Reconcile only absent local owners. A still-live transport or native refusal
    // remains a blocker, never an excuse to duplicate its outstanding work.
    for (const receipt of nativeStatus(root) as NativeReceipt[])
      if (
        receipt.workflow_id === parent.meta.id &&
        invocationIsActive(receipt) &&
        !ownerIsAlive(receipt.owner_pid)
      )
        await interruptNative(root, receipt.id);
    const prompt = `Continue the existing NeoMind workflow ${parent.meta.id}. Interpret the saved requirements, obtain scoped specialist contributions, establish measurable requirements and independently reviewed architecture/check definitions, delegate bounded implementation and check execution, collect Cornell documentation, perform independent review and acceptance, prepare the qualified project archive locally and report final decisions. Read automation.json network_policy before remote operations: local-only permits zero remote discovery, publication or archive requests, including explicit tools; absent policy retains legacy remote behavior. Inspect workspace evidence and local notes, search verified cache with knowledge_search, and save required knowledge_research locally; scope a local no-match as 'upstream not searched', never as a successful remote search or a 401 no-match. Remote failures block that operation, not authorized local work; integrity and engineering gates remain mandatory. Save Cornell with note.workflow_id=${parent.meta.id}, same-workflow record references and confirmed note ID/path; older external notes are historical context, not current evidence. Remote publication requires later user opt-in to remote-enabled and current independent public-safety review/sanitization; automatic publication also requires automatic_pr: true. Do not create another workflow or recursively call manager_run. Use project_read and approved core/recipe operations; installed instructions are preloaded. Use capability_describe/project_status for discovery; never call capability_resolve with empty provider lists. Resolve an external provider only when it is actually applicable. Original requirement batch:\n${JSON.stringify(originals, null, 2)}${input.message ? `\nUser clarification or continuation:\n${input.message}` : ''}`;
    if (input.request_id !== undefined &&
        (typeof input.request_id !== 'string' || !input.request_id.trim() || input.request_id.length > 256))
      throw new Error('Native request ID must be a non-empty bounded string.');
    const configuration = {
      routing_sha256: hash(canonicalJson(readRoutingPolicy(root))),
      configuration_hashes: routingConfigurationHashes(root),
    };
    // Intake identity stays on the workflow; native deduplication is configuration-specific.
    const requestId = `manager-${hash(canonicalJson({
      request_id: input.request_id ?? `manager-${parent.meta.id}-${previous?.id ?? 'initial'}`,
      workflow_id: parent.meta.id, ...configuration,
    }))}`;
    const configurationChanged = previous?.issuer === 'neomind-vscode-lm' &&
      (previous.routing_sha256 !== configuration.routing_sha256 ||
        canonicalJson(previous.configuration_hashes) !== canonicalJson(configuration.configuration_hashes));
    const receipt = previous?.native_thread_id && !configurationChanged
      ? await resumeNative(root, previous.id, { prompt, request_id: requestId }, ownerToken)
      : await startNative(
          root,
          { role: 'manager', workflow_id: parent.meta.id, prompt, request_id: requestId },
          ownerToken,
        );
    updateRecord(root, parent.meta.id, {
      data: {
        native_manager_attempt_id: receipt.id,
        native_manager_blocker: receipt.state === 'blocked' ? receipt.error : null,
      },
    });
    if (receipt.state === 'running' || receipt.state === 'completed')
      bindManagerInvocation(root, parent.meta.id, receipt.id);
    return {
      workflow: workflowStatus(root, parent.meta.id),
      invocation: receipt,
      ...(receipt.state === 'blocked'
        ? { blocker: receipt.error ?? 'Native coordinator could not start.' }
        : {}),
    };
  } catch (error) {
    const blocker = error instanceof Error ? error.message : String(error);
    updateRecord(root, parent.meta.id, { data: { native_manager_blocker: blocker } });
    return { workflow: workflowStatus(root, parent.meta.id), blocker };
  }
}

/**
 * Native-client increment: start or resume a full engineering workflow and hand off to the
 * visible manager subagent. There is no signed bridge, no native receipt, and no fabricated
 * worker identity; the subagent drives the lifecycle with honest user-reported invocation IDs.
 * The increment's assurance is an unsigned native report, explicitly distinct from strict mode,
 * and this path can never reclassify a saved strict increment.
 */
export function nativeRun(root: string, input: ManagedRunInput): ManagedRunResult {
  const saved = input.workflow_id ? getRecord(root, input.workflow_id) : undefined;
  const mode = input.execution_mode ?? (saved ? savedWorkflowExecutionMode(saved.meta.data) : 'copilot-native');
  if (!isNativeExecutionMode(mode))
    throw new Error('Native execution requires copilot-native or codex-native mode.');
  const client = nativeClientForMode(mode);
  if (input.native_client !== undefined && input.native_client !== client)
    throw new Error('Saved native client is immutable and must match the execution mode.');
  const parent = saved ?? beginWorkflow(root, { ...input, execution_mode: mode });
  if (parent.meta.type !== 'knowledge' || parent.meta.data.kind !== 'manager-workflow')
    throw new Error('Native resumption requires an existing manager workflow.');
  if (parent.meta.data.execution_mode !== mode || parent.meta.data.routing_required === true)
    throw new Error('Saved workflow mode cannot be changed; create a new increment.');
  const originals = parent.meta.data.original_requirements ?? [parent.meta.data.original_requirement];
  if (input.workflow_id && (input.requirement !== undefined || input.requirements !== undefined)) {
    if (input.requirement !== undefined && input.requirements !== undefined)
      throw new Error('Provide requirement or requirements, rather than both.');
    const provided = (input.requirements ?? [input.requirement!]).map((item) => item.trim());
    if (JSON.stringify(provided) !== JSON.stringify(originals))
      throw new Error(
        'Resumption requirements differ from the saved increment. Submit a new requirement or record a reviewed change.',
      );
  }
  const current = workflowStatus(root, parent.meta.id) as { phase?: string };
  if (current.phase === 'completed') {
    if (input.message !== undefined) throw new Error('Completed workflows reject new continuations; create a new increment.');
    return { workflow: current };
  }
  const messages = Array.isArray(parent.meta.data.continuations) ? [...parent.meta.data.continuations] : [];
  if (input.message !== undefined) {
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000)
      throw new Error('Continuation must contain between 1 and 20000 characters.');
    if (messages.at(-1) !== input.message.trim()) {
      messages.push(input.message.trim());
      updateRecord(root, parent.meta.id, { data: { continuations: messages } });
    }
  }
  const delegation = client === 'codex' ? agentProfiles.filter(profile => profile.id !== 'coordinator')
    .map(profile => `neomind-${profile.id} (${profile.name})`).join('; ') : agentProfiles.filter(profile => profile.id !== 'coordinator')
    .map(profile => profile.name).join('; ');
  const dispatch = client === 'codex' ? 'Codex spawn_agent tool by exact agent_type' : 'standard VS Code agent tool by exact display name';
  let reuseBrief: string;
  try {
    const reuse = prepareWork(root, { request: (originals as string[]).join('\n'),
      request_id: typeof parent.meta.data.request_id === 'string' ? parent.meta.data.request_id : parent.meta.id,
      environment: { client }, scope: { mode, assurance: String(parent.meta.data.assurance ?? ''),
        network: policyAllowsRemote(root), publication: false } });
    reuseBrief = `${reuse.manager_brief}\n${reuse.next_action}`;
  } catch (error) {
    reuseBrief = `Reuse inspection failed: ${error instanceof Error ? error.message : String(error)}. This is an integrity/availability issue, not a successful no-match. Continue the saved expert workflow without automatic procedure reuse; repair the index explicitly with procedure index after inspecting durable sources.`;
  }
  const prompt = `Continue directly as NeoMind Coordinator Agent for the existing NeoMind increment ${parent.meta.id} in ${mode} mode. This is the returned manager handoff.prompt and workflow: do not call manager_run again or launch NeoMind Coordinator Agent (yourself). Read the saved status, original requirement and existing substantive results before commissioning more planning. Delegate bounded assignments through the ${dispatch}: ${delegation}. Use only applicable specialists; record at least two separate specialist contributions where the saved full workflow requires them. Manager may coordinate, consolidate and research, but must never perform production implementation or independent self-review. Inline role impersonation, a proposed handoff or manager-authored specialist reports are not executed delegation.
For ordinary local software/tooling, use workflow_plan with process: software-tools, the actual bounded objective/criteria, product allowed_paths, separate independently owned verification_paths, documentation_paths, baseline_paths and real check argv. The backend derives requirement/design/task IDs, assignments and scope from the saved workflow; do not handcraft those records or reserved ownership/lifecycle fields. Then call workflow_next, launch its exact returned native agent/handoff through this client's actual delegate tool, and give workflow_next the actual delegate observation when it returns. Reuse saved research, requirements, plans and specialist results instead of repeating the intake or making every profile write a new planning document. Only call another preparatory specialist when a concrete unresolved question requires that expertise.
Wait for real delegate results. Each actual delegate opens its generated packet, keeps its own private handle and saves typed assignment_result; retain its returned report_id and any real task submission. The runtime renders the required work record. Requirement, design, workflow and descriptive labels are not task IDs: include task_id only when the backend supplies a genuine assigned task. For running or unknown native observations, wait or inspect the existing run without launching a duplicate. If a terminal delegate returns empty output, fails, is cancelled or lacks its own saved result, use assignment_followup (or the workflow_next recovery action) with the actual stopped observation and a stable observation_id. Reuse saved partial work and the returned bounded fresh handoff; only the real follow-up delegate may produce its report. Follow the server's lineage retry bound. A missing report triggers this recovery, not an immediate final blocker response. End unfinished work only for a concrete external prerequisite or exhausted bounded recovery, preserving the exact incomplete state and next action; never fabricate results or substitute manager implementation.
Choose the process that fits the actual scope. Full engineering gates remain unchanged for existing full-gate increments; strict/safety work keeps its required reviewed design, protected checks, immutable evidence and independent acceptance by a different owner and invocation. A software-tools plan tailors routine local tooling without imposing unrelated hardware lifecycle forms. It cannot change a strict ancestor, execution mode, assurance or protected acceptance rules. Analysis/research-only requests need actual bounded findings and applicable review; do not invent production changes, builds, code reviews or SIL runs.
Resume under automation.json network_policy without changing the saved publication route. Under local-only make zero remote discovery, publication or archive requests. Inspect existing tools, workspace evidence and local knowledge once; reuse same-workflow saved research and search verified cache when useful. Scope a local no-match as 'upstream not searched'; never describe a failed request or 401 as no-match. Remote failures defer that operation while authorized local work continues; integrity failures still block automatic procedure reuse. Remote publication requires later user opt-in, current independent public-safety review and sanitization; automatic publication additionally requires automatic_pr: true.
Only the Coordinator writes one final evidence-linked Cornell note after actual implementation/research and independent results, with note.workflow_id=${parent.meta.id} and same-workflow requirement/evidence references. Specialists return assignment_result rather than creating a Cornell note for each assignment. Preserve earlier notes as history. Confirm its returned note ID and saved path, then deliver them with actual results. If saving fails, report the blocker without claiming Cornell delivery or closure. Run manager_finish only when the backend's current completion gates are satisfied; existing release/publication approval remains applicable.
Use manager_status for progress snapshots and workflow_next for the next substantive action. assignment_progress is advisory for meaningful state changes; do not spend turns in progress-only narration or repeated heartbeats. This is an unsigned native report: actual local assignment identity and model configuration are not runtime attestations or signed receipts. Strict Bridge uses its signed invocation-bound tools; native_status/native_wait are not wait tools for arbitrary ${client} chat delegates. Never fabricate a signed receipt or observed model identity, and never resume an unrelated strict increment.${
    messages.length ? `\nSaved user clarifications:\n${JSON.stringify(messages)}` : ''
  }\nOriginal requirement batch:\n${JSON.stringify(originals, null, 2)}`;
  return {
    workflow: current,
    handoff: { agent: client === 'codex' ? 'neomind-coordinator' : coordinatorAgentName,
      prompt: `${client === 'codex' ? 'Read .neomind/guides/codex-native.md. Reuse existing source, local knowledge and applicable reviewed skills before new implementation.\n' : ''}${prompt}\n\nReuse assessment (advisory; retain the saved lifecycle):\n${reuseBrief}\n\n${nativeActivityInstructions}` },
  };
}

function policyAllowsRemote(root: string): boolean {
  return readAutomationPolicy(root).network_policy === 'remote-enabled';
}
