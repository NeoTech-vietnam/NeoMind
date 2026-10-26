import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveHost, exactRoot, bounded, bridgeProtocol } from './vscode-wire.js';
import { readInvocation, routingProblems, canonicalJson, routingConfigurationHashes, requireRoutingPolicy } from './routing.js';
import { roleCapabilities } from './tools.js';
import { vscodeSelection } from './vscode-policy.js';
import { resourceRoot, safePath } from './storage.js';
import { readRoleUpstreamInstructions } from './upstreams.js';
import { controlledInstructions, controlledToolNames } from './controlled-tools.js';
import { ownedContext, type OwnedContext } from './controlled-context.js';
import { invocationPolicy, invocationConfigurationHashes } from './routing.js';
import { vscodeProviderDiagnostic } from './vscode-provider-diagnostic.js';
import { controlledModelInput, controlledResultFailure, controlledLoopState, ControlledFailureLoop } from './controlled-observability.js';
import { ModelCallProgress, type ModelCallTerminalReason } from './vscode-model-progress.js';

// VS Code is supplied by extension host, not imported into CLI or added as dependency.
type VSCode = any;
interface Conversation { role: string; workflow: string | null; task: string | null; vendor: string; model: string; messages: any[] }
interface Turn {
  id: string; invocation: string; conversation: string; model: any; source: any;
  state: 'prepared' | 'running' | 'completed' | 'blocked' | 'interrupted';
  output: string; error: string | null; tools: any[]; events: any[];
  waiting: Map<string, { resolve(value: any): void; reject(error: Error): void }>;
  timer?: NodeJS.Timeout; lastSeen: number; configuration: string; checkpoint: number; observedTool: boolean;
  controlled?: OwnedContext; failureLoop?: ControlledFailureLoop;
  progress: ModelCallProgress;
}
function errorField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}
/** Fixed metadata only. Do not serialize provider objects or inspect messages,
 * stacks, headers or arbitrary nested values to identify transport failures. */
export function vscodeModelErrorDiagnostic(error: unknown): { error_class: string; cause_class: string | null; transport_code: string | null } {
  const names = new Set(['Error', 'AbortError', 'TypeError', 'RangeError', 'ReferenceError', 'CancellationError', 'Canceled', 'Cancelled', 'LanguageModelError']);
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED']);
  const known = (value: unknown, allowed: Set<string>) => typeof value === 'string' && value.length <= 64 && allowed.has(value) ? value : null;
  const result = { error_class: known(errorField(error, 'name'), names) ?? 'unclassified error', cause_class: null as string | null,
    transport_code: null as string | null };
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth <= 4 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    result.transport_code ??= known(errorField(current, 'code'), codes);
    if (depth > 0) result.cause_class ??= known(errorField(current, 'name'), names);
    current = errorField(current, 'cause');
  }
  return result;
}
export async function enableVSCodeHost(vscode: VSCode, workspaceRoot: string): Promise<{ close(): Promise<void> }> {
  if (!vscode.workspace.isTrusted) throw new Error('VS Code Workspace Trust is required.');
  const root = exactRoot(workspaceRoot);
  const enabled = () => vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.some(
    (folder: any) => folder.uri.scheme === 'file' && exactRoot(folder.uri.fsPath) === root);
  if (!enabled()) throw new Error('Bridge root must be an exact open workspace folder.');
  const turns = new Map<string, Turn>(), conversations = new Map<string, Conversation>();
  let instance = '', closed = false;
  async function traceControlled(turn: Turn, event: Record<string, unknown>): Promise<void> {
    if (!turn.controlled) return;
    try { await turn.controlled.callbacks.trace?.({ ...event, stage: turn.controlled.binding.stage, at: new Date().toISOString(),
      backend_binding: { workflow_id: turn.controlled.binding.workflow_id, task_id: turn.controlled.binding.task_id ?? null,
        invocation_id: turn.invocation }, owner: 'runtime' }); } catch { /* Observability cannot replay a persisted operation. */ }
  }
  function stop(turn: Turn, state: 'blocked' | 'interrupted', error: string, reason: ModelCallTerminalReason = 'model-or-host-error'): void {
    if (['completed', 'blocked', 'interrupted'].includes(turn.state)) return;
    turn.state = state; turn.error = error;
    turn.progress.finish(state === 'interrupted' ? 'cancelled' : 'error', reason);
    turn.source.cancel();
    clearTimeout(turn.timer);
    for (const waiting of turn.waiting.values()) waiting.reject(new Error(error));
    turn.waiting.clear(); turn.events = [];
    const conversation = conversations.get(turn.conversation);
    if (conversation) {
      conversation.messages.length = turn.checkpoint;
      conversation.messages.push(vscode.LanguageModelChatMessage.User('Previous host turn interrupted. Reinspect durable MCP state before continuing; previous tools may have persisted changes.'));
    }
  }
  function check(turn: Turn, validateBinding = true): void {
    if (closed || !enabled() || turn.source.token.isCancellationRequested || turn.state !== 'running')
      throw new Error('Host permission or invocation ended.');
    // Stream fragments cannot mutate the project. Verify signed binding at request,
    // stream completion and every tool boundary instead of rehashing it per token.
    if (!validateBinding) return;
    const receipt = readInvocation(root, turn.invocation);
    if (receipt.host_instance !== instance || receipt.native_turn_id !== turn.id ||
        receipt.native_thread_id !== turn.conversation || receipt.confirmed_model !== turn.model.id ||
        receipt.model_provider !== turn.model.vendor)
      throw new Error('Host turn differs from signed invocation.');
    if (turn.configuration !== canonicalJson(invocationConfigurationHashes(root, receipt)) ||
        routingProblems(root, receipt.role, turn.invocation, { require_completed: false }).length)
      throw new Error('Invocation policy changed.');
  }
  async function generate(turn: Turn): Promise<void> {
    let phase = 'preflight';
    try {
      const conversation = conversations.get(turn.conversation)!;
      for (let round = 0; round < 128; round++) {
        phase = 'preflight';
        turn.progress.beginRound(round + 1);
        check(turn);
        if (Buffer.byteLength(bounded(conversation.messages)) > 768000) throw new Error('Conversation limit reached.');
        turn.checkpoint = conversation.messages.length;
        phase = 'request';
        turn.progress.request();
        const response = await turn.model.sendRequest(conversation.messages, {
          tools: turn.tools, toolMode: vscode.LanguageModelChatToolMode.Auto,
          justification: 'Run explicitly enabled NeoMind workflow using only invocation-bound engineering tools.',
        }, turn.source.token);
        phase = 'response-stream';
        // This is the SDK response handle, not an HTTP-header or upstream-model attestation.
        turn.progress.handleReceived();
        const parts: any[] = [], calls: any[] = [];
        let dataBytes = 0;
        for await (const part of response.stream) {
          check(turn, false);
          turn.progress.part(part instanceof vscode.LanguageModelTextPart ? 'text'
            : part instanceof vscode.LanguageModelToolCallPart ? 'tool-call'
            : typeof vscode.LanguageModelDataPart === 'function' && part instanceof vscode.LanguageModelDataPart ? 'data' : 'other',
          part instanceof vscode.LanguageModelTextPart ? Buffer.byteLength(part.value)
            : typeof vscode.LanguageModelDataPart === 'function' && part instanceof vscode.LanguageModelDataPart ? part.data.byteLength : 0);
          if (parts.length >= 4096) throw new Error('Response part limit reached.');
          if (part instanceof vscode.LanguageModelTextPart) {
            if (turn.output.length + part.value.length > 64000) throw new Error('Output limit reached.');
            turn.output += part.value; parts.push(part);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            if (calls.length >= 32 || !turn.tools.some((tool) => tool.name === part.name) ||
                calls.some((call) => call.callId === part.callId) || typeof part.callId !== 'string' || part.callId.length > 256)
              throw new Error('Model requested an invalid or unscoped tool.');
            bounded(part.input); calls.push(part); parts.push(part);
          } else if (typeof vscode.LanguageModelDataPart === 'function' && part instanceof vscode.LanguageModelDataPart) {
            if (part.data.byteLength > 768000 || (dataBytes += Buffer.byteLength(JSON.stringify(part))) > 768000)
              throw new Error('Response data limit reached.');
            parts.push(part);
          } else throw new Error('Unsupported model response part.');
        }
        check(turn);
        conversation.messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
        if (!calls.length) {
          if (!turn.observedTool) throw new Error('Model did not demonstrate required tool calling.');
          turn.state = 'completed'; turn.progress.endRound(); turn.progress.finish('completed'); clearTimeout(turn.timer); return;
        }
        phase = 'tool-results';
        turn.progress.executingTools();
        const results = [];
        for (const call of calls) {
          check(turn);
          if (turn.controlled) {
            const state = controlledLoopState(root, { ...turn.controlled.binding, invocation_id: turn.invocation });
            if (turn.failureLoop!.blocked(call.name, call.input, state)) {
              await traceControlled(turn, { event: 'tool-loop-stopped', tool: call.name,
                model_input: controlledModelInput(call.name, call.input), code: 'CONTROLLED_TOOL_LOOP',
                validation: { rule_id: 'controlled.identical_failure_loop', owner: 'runtime',
                  rule: 'Two identical requests already failed the same validation in unchanged runtime state. The third identical request was not dispatched.' } });
              stop(turn, 'blocked', 'CONTROLLED_TOOL_LOOP: The same semantic request failed the same validation twice in unchanged runtime state. A third identical call was refused before dispatch. Correct the request or reconcile runtime state before resuming.', 'loop-stopped');
              return;
            }
            await traceControlled(turn, { event: 'model-tool-request', tool: call.name, model_input: controlledModelInput(call.name, call.input) });
          }
          const result = await new Promise<any>((resolve, reject) => {
            turn.waiting.set(call.callId, { resolve, reject });
            turn.events.push({ call_id: call.callId, name: call.name, input: call.input });
          });
          check(turn);
          turn.progress.toolResult();
          if (turn.controlled) {
            const validation = controlledResultFailure(result);
            turn.failureLoop!.observe(call.name, call.input, result,
              controlledLoopState(root, { ...turn.controlled.binding, invocation_id: turn.invocation }));
            await traceControlled(turn, { event: 'model-tool-result', tool: call.name, status: validation ? 'failed' : 'succeeded',
              ...(validation ? { code: validation.code, validation } : {}) });
          }
          results.push(new vscode.LanguageModelToolResultPart(call.callId,
            [new vscode.LanguageModelTextPart(bounded(result))]));
        }
        conversation.messages.push(vscode.LanguageModelChatMessage.User(results));
        turn.observedTool = true;
        turn.checkpoint = conversation.messages.length;
        turn.progress.endRound();
      }
      throw new Error('Tool round limit reached.');
    } catch (error) {
      // Provider errors can contain endpoint secrets. Persist only fixed allowlisted diagnostics.
      const codes: Record<string, string> = {
        NoPermissions: 'model access denied; review the extension model-access consent in VS Code',
        Blocked: 'model request blocked by VS Code or provider policy',
        NotFound: 'selected model is no longer available',
        Unknown: 'VS Code reported an unspecified language-model error',
        Canceled: 'model request was cancelled', Cancelled: 'model request was cancelled',
      };
      const metadata = vscodeModelErrorDiagnostic(error), rawCode = errorField(error, 'code');
      const code = typeof rawCode === 'string' && rawCode.length <= 64 && Object.hasOwn(codes, rawCode) ? rawCode : null;
      const name = metadata.error_class;
      const hostErrors = [
        'Host permission or invocation ended.', 'Host turn differs from signed invocation.',
        'Invocation policy changed.', 'Conversation limit reached.', 'Response part limit reached.',
        'Response data limit reached.', 'Output limit reached.', 'Model requested an invalid or unscoped tool.',
        'Unsupported model response part.', 'Model did not demonstrate required tool calling.', 'Tool round limit reached.',
      ];
      const rawMessage = errorField(error, 'message');
      const hostError = hostErrors.find(message => message === rawMessage);
      const provider = vscodeProviderDiagnostic(error);
      const detail = hostError ?? (provider ? `${provider.code}: ${provider.message}` :
        code ? `${code}: ${codes[code]}` : `${name}; inspect VS Code Copilot and extension-host logs`);
      const fixed = [name === 'unclassified error' ? null : `SDK ${name}`,
        metadata.cause_class ? `cause ${metadata.cause_class}` : null,
        metadata.transport_code ? `transport ${metadata.transport_code}` : null].filter(Boolean);
      stop(turn, 'blocked', `VS Code model request blocked during ${phase}: ${detail}${fixed.length ? ` [${fixed.join('; ')}]` : ''}. No raw provider error was persisted.`);
    }
  }
  const server = await serveHost(root, async (operation, input) => {
    if (closed || !enabled()) throw new Error('Workspace trust or workspace folder changed.');
    if (['controlled-start', 'controlled-control', 'controlled-status'].includes(operation)) {
      const { dispatchControlledHost } = await import('./controlled-workflow.js');
      return dispatchControlledHost(root, operation, input);
    }
    if (operation === 'open') {
      if (turns.size >= 256 || conversations.size >= 256) throw new Error('Host session limit reached; re-enable bridge.');
      const receipt = readInvocation(root, input.invocation_id);
      if (receipt.issuer !== 'neomind-vscode-lm' || receipt.owner_pid !== input.owner_pid || receipt.state !== 'starting')
        throw new Error('Host requires a starting signed invocation.');
      if (requireRoutingPolicy(root).vscode_effort_policy !== 'allow-unavailable')
        throw new Error('VS Code API cannot verify reasoning effort. Explicit allow-unavailable policy required.');
      if (canonicalJson(receipt.configuration_hashes) !== canonicalJson(invocationConfigurationHashes(root, receipt)))
        throw new Error('Configuration changed before host selection.');
      if ([...turns.values()].some((turn) => turn.invocation === receipt.id))
        throw new Error('Invocation already owns a host turn.');
      const selector = vscodeSelection(root, receipt.role, receipt.requested_model, invocationPolicy(root, receipt));
      let selectionTimer: NodeJS.Timeout | undefined;
      let models: any[];
      try {
        models = await Promise.race([vscode.lm.selectChatModels(selector), new Promise((_, reject) => {
          selectionTimer = setTimeout(() => reject(new Error('VS Code model selection timed out.')), 10000);
        })]) as any[];
      } finally { clearTimeout(selectionTimer); }
      if (closed || !enabled()) throw new Error('Host closed during model selection.');
      if (!models.length) return { unavailable: true };
      if (models.length !== 1 || models[0].id !== selector.id || models[0].vendor !== selector.vendor)
        throw new Error(`VS Code model selection is ambiguous or mismatched for ${selector.vendor}/${selector.id}; require exactly one matching live model.`);
      const controlled = ownedContext(root, receipt.request_id);
      if (receipt.controlled_execution && !controlled) throw new Error('Controlled invocation lost its runtime owner.');
      const allowed = controlled ? controlledToolNames(controlled.binding) : roleCapabilities(receipt.role).operations;
      if (!Array.isArray(input.tools) || input.tools.length > 256 || !input.tools.length ||
          input.tools.some((tool: any) => !allowed.includes(tool.name) || ['manager_run', 'manager_begin'].includes(tool.name)))
        throw new Error('Host tools escape role contract.');
      const tools = input.tools.map((tool: any) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
      const support = models[0].capabilities?.toolCalling;
      // Stable LanguageModelChat need not expose capabilities. An observed scoped tool round proves tool calling locally.
      if (support === false || support === 0 || (typeof support === 'number' && support < tools.length)) throw new Error('Selected model does not support required tools.');
      let conversationId = `vscode-host:conversation:${randomUUID()}`;
      let conversation: Conversation;
      if (receipt.prior_invocation_id) {
        const prior = readInvocation(root, receipt.prior_invocation_id);
        conversationId = prior.native_thread_id!;
        const old = conversations.get(conversationId);
        if (prior.host_instance !== instance || !old || old.role !== receipt.role || old.workflow !== receipt.workflow_id ||
            old.task !== receipt.task_id || old.vendor !== selector.vendor || old.model !== selector.id ||
            [...turns.values()].some((turn) => turn.conversation === conversationId && ['running', 'prepared'].includes(turn.state)))
          throw new Error('Host conversation stale or mismatched. Start fresh invocation.');
        conversation = old;
      } else {
        const instructions = controlled ? controlledInstructions(controlled.binding) : [`roles/${receipt.role}.md`, 'guides/workflow.md', ...(receipt.role === 'manager' ? ['guides/manager.md'] : [])]
          .map((path) => {
            const installed = safePath(root, `.neomind/${path}`);
            const source = existsSync(installed) ? installed : join(resourceRoot, path);
            return existsSync(source) ? readFileSync(source, 'utf8') : '';
          }).join('\n').slice(0, 32000) + '\n' + readRoleUpstreamInstructions(root, receipt.role);
        conversation = { role: receipt.role, workflow: receipt.workflow_id, task: receipt.task_id, vendor: selector.vendor, model: selector.id,
          messages: [vscode.LanguageModelChatMessage.User(controlled ? instructions : `NeoMind invocation ${receipt.id}. Role ${receipt.role}; workflow ${receipt.workflow_id}; task ${receipt.task_id}. Only supplied invocation-bound MCP tools exist. No builtin shell or filesystem tools. Never recursively start manager_run, manager_begin or another manager. Use project_read for hashes, task_file_write for assigned edits, check_run for prescribed checks. Before ending call assignment_report with substantive seven-section Cornell work_record, or task_submit with full work_record. Do not fabricate evidence. Installed instructions:\n${instructions}`)] };
        conversations.set(conversationId, conversation);
      }
      conversation.messages.push(vscode.LanguageModelChatMessage.User(receipt.input_text));
      const id = `vscode-host:turn:${randomUUID()}`;
      const turn: Turn = { id, invocation: receipt.id, conversation: conversationId, model: models[0],
        source: new vscode.CancellationTokenSource(), state: 'prepared', output: '', error: null, tools, events: [], waiting: new Map(),
        configuration: canonicalJson(receipt.configuration_hashes), lastSeen: Date.now(), checkpoint: conversation.messages.length, observedTool: false,
        progress: new ModelCallProgress(root, receipt.id, models[0].id, models[0].vendor),
        ...(controlled ? { controlled, failureLoop: new ControlledFailureLoop() } : {}) };
      turns.set(id, turn);
      return { protocol: bridgeProtocol, host_instance: instance, vendor: models[0].vendor, model: models[0].id,
        conversation_id: conversationId, turn_id: id, reasoning_effort: null, sandbox: null, version: vscode.version };
    }
    const turn = turns.get(input.turn_id);
    if (!turn || turn.invocation !== input.invocation_id) throw new Error('Unknown host invocation.');
    turn.lastSeen = Date.now();
    if (operation === 'run') {
      if (turn.state !== 'prepared') throw new Error('Turn already started.');
      turn.state = 'running'; check(turn);
      turn.timer = setTimeout(() => stop(turn, 'blocked', 'VS Code invocation exceeded 30 minute limit.', 'deadline-exceeded'), 1800000);
      // Respond first: manager receipt and workflow binding must exist before any scoped tool executes.
      setImmediate(() => { void generate(turn); });
      return { state: turn.state };
    }
    if (operation === 'poll') {
      const events = turn.events.splice(0);
      return { state: turn.state, output: turn.output, error: turn.error, events };
    }
    if (operation === 'result') {
      check(turn);
      const waiting = turn.waiting.get(input.call_id);
      if (!waiting) throw new Error('Unknown or duplicate tool response.');
      turn.waiting.delete(input.call_id); waiting.resolve(input.result);
      return { ok: true };
    }
    if (operation === 'cancel') { stop(turn, 'interrupted', 'VS Code invocation interrupted.', 'owner-cancel'); return { ok: true }; }
    throw new Error('Unknown host operation.');
  });
  instance = server.instance;
  const watchdog = setInterval(() => {
    for (const turn of turns.values()) if (!enabled() || Date.now() - turn.lastSeen > 90000)
      stop(turn, 'blocked', 'VS Code host lost invocation owner or workspace trust.', 'owner-or-trust-lost');
  }, 5000);
  watchdog.unref();
  return { close: async () => {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    for (const turn of turns.values()) { stop(turn, 'interrupted', 'VS Code bridge disabled.', 'host-close'); turn.source.dispose(); }
    turns.clear(); conversations.clear(); await server.close();
  } };
}
