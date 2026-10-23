import { agentDelegation, coordinatorAgentName, nativeActivityInstructions } from './agent-profiles.js';
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
import { getRecord, updateRecord, hash, safePath } from './storage.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolveCapabilities, type ProviderId } from './tools.js';
import { lightweightRun } from './lightweight.js';

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
  if (input.execution_mode !== undefined && !['strict', 'lightweight', 'copilot-native'].includes(input.execution_mode))
    throw new Error('Invalid workflow execution mode.');
  const saved = input.workflow_id ? getRecord(root, input.workflow_id) : undefined;
  const savedMode =
    saved?.meta.data.kind === 'lightweight-workflow'
      ? 'lightweight'
      : saved?.meta.data.execution_mode === 'copilot-native'
        ? 'copilot-native'
        : saved
          ? 'strict'
          : undefined;
  if (saved && input.execution_mode && input.execution_mode !== savedMode)
    throw new Error('Saved workflow mode cannot be changed; create a new increment.');
  const mode = savedMode ?? input.execution_mode ?? policy.execution_mode ?? 'strict';
  if (mode === 'lightweight') {
    if (readRoutingPolicy(root)?.platform !== 'copilot')
      throw new Error('Lightweight native execution currently requires Copilot routing.');
    return lightweightRun(root, input);
  }
  if (mode === 'copilot-native') return nativeRun(root, input);
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
 * Copilot-native increment: start or resume a full engineering workflow and hand off to the
 * visible manager subagent. There is no signed bridge, no native receipt, and no fabricated
 * worker identity; the subagent drives the lifecycle with honest user-reported invocation IDs.
 * The increment's assurance is an unsigned native report, explicitly distinct from strict mode,
 * and this path can never reclassify a saved strict increment.
 */
export function nativeRun(root: string, input: ManagedRunInput): ManagedRunResult {
  const parent = input.workflow_id
    ? getRecord(root, input.workflow_id)
    : beginWorkflow(root, { ...input, execution_mode: 'copilot-native' });
  if (parent.meta.type !== 'knowledge' || parent.meta.data.kind !== 'manager-workflow')
    throw new Error('Native resumption requires an existing manager workflow.');
  if (parent.meta.data.execution_mode !== 'copilot-native' || parent.meta.data.routing_required === true)
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
  const prompt = `Continue directly as NeoMind Coordinator Agent for the existing NeoMind increment ${parent.meta.id} in copilot-native mode. This is the returned manager handoff.prompt and workflow: do not call manager_run again or launch NeoMind Coordinator Agent (yourself). Delegate bounded assignments through the standard VS Code agent tool by exact display name: ${agentDelegation} Use the specialists applicable to the authorized scope; record at least two separate specialist contributions. Manager may coordinate, consolidate and research, but must never perform production implementation or independent self-review. Wait for real delegate results and collect each actual invocation ID and seven-section assignment_report ID before consolidation; task producers also submit their task work record. Inline role impersonation, a proposed handoff or manager-authored specialist reports are not executed delegation. If a delegate cannot launch or its result/report is missing, report the blocker and next action rather than substituting inline work.
For engineering changes preserve every ASPICE/V-model gate: refine measurable requirements, define and independently review design and verification plans, dispatch bounded implementation tasks, collect real check evidence with immutable input capture, obtain an independent acceptance review by a different owner and invocation, write substantive seven-section documentation, and curate qualified knowledge. Analysis/research-only requests still require bounded specialist contributions and a meaningful saved Cornell note with sources, findings, rationale, limitations and applicable verification; do not invent production changes, builds, code reviews or SIL runs. Full engineering gates remain unchanged; any unsatisfied closure gates must remain explicit blockers, not be bypassed.
Resume this workflow under the current automation.json network_policy without changing its saved execution mode or publication route. New native policies default to local-only and automatic_pr: false; a missing network_policy retains legacy remote behavior. Under local-only make zero remote discovery, publication or archive requests; explicit remote tools reject. Inspect actual workspace evidence and local Cornell notes, search verified cache through knowledge_search, and save required knowledge_research inside the project before planning. Scope a local no-match explicitly as 'upstream not searched'; never describe a 401 or other failed request as no-match. Remote failures block that remote operation, not authorized local research; integrity failures still block reuse. Save research and Cornell locally and report remote work as deferred. Later publication requires user opt-in to remote-enabled plus independent current public-safety review and sanitization; automatic publication additionally requires automatic_pr: true. This deferral never waives checks, review or acceptance.
Before manager_finish and before the substantive user answer, save an evidence-linked Cornell note with note.workflow_id=${parent.meta.id} and requirement_ids from this workflow, using only same-workflow record references. Older external notes belong in historical source context, not current evidence or cross-workflow record bindings. Confirm its returned note ID and saved path, then deliver that note ID/path and meaningful Cornell findings alongside actual test reports. If saving fails, report the blocker without claiming Cornell delivery or closure. Run manager_finish only when its gates are satisfied; human release approval remains pending.
This mode is an unsigned native report: use honest reported invocation IDs for every manager_discuss, task_start, review and check. These IDs and model observations are not runtime attestations or signed receipts. Use manager_status for progress; native_status is for signed Bridge receipts, not this mode. Never fabricate a signed receipt or observed reasoning effort, and never resume an unrelated strict increment.${
    messages.length ? `\nSaved user clarifications:\n${JSON.stringify(messages)}` : ''
  }\nOriginal requirement batch:\n${JSON.stringify(originals, null, 2)}`;
  return {
    workflow: current,
    handoff: { agent: coordinatorAgentName, prompt: `${prompt}\n\n${nativeActivityInstructions}` },
  };
}
