import { createControlledMcpServer, controlledInstructions, controlledToolNames } from './controlled-tools.js';
import { randomBytes } from 'node:crypto';
import { ownedContext } from './controlled-context.js';
import { canonicalJson, invocationConfigurationHashes, readInvocation, type NativeReceipt } from './routing.js';
import { hash } from './storage.js';
import { closeWorkForceCapabilities } from './workforce-plugin-gateway.js';
import { OpenCodeToolFailureGuard, type OpenCodeToolObservation } from './opencode-tool-observation.js';
import { OpenCodeTurnObserver, OpenCodeTurnError, safeOpenCodeTransportError, type OpenCodeTurnIdentity, type OpenCodeTurnOptions } from './opencode-turn.js';
import { createOpenCodeGateway, openCodeConfiguration, openCodeEndpoint, openCodeError, openCodeBinary, opencodeProtocol,
  opencodeProviderId, opencodeRuntimeVersion, opencodeRuntimeIntegrity, openCodeStorageFailure, startOpenCodeEngine, type OpenCodeEngine, type OpenCodeGateway } from './opencode-engine.js';

/** Only local control transport before prompt admission. Retrying the model or
 * replaying an uncertain submitted prompt is never authorized by this error. */
class OpenCodeControlSetupError extends Error {
  constructor() {
    super('The local engine control connection failed before any model prompt was submitted. Its owned engine was closed; preserve the exact assignment for bounded backend session reconciliation.');
    this.name = 'OPENCODE_CONTROL_SETUP_FAILED';
  }
}
function setupTransportFailure(operation: string, error: unknown): boolean {
  return ['session-create', 'mcp-status', 'tool-list', 'event-subscribe'].includes(operation) &&
    error instanceof TypeError && error.message === 'fetch failed';
}

/** OpenCode owns inference/tool iteration. This adapter binds one execution to the engineering runtime. */
export function openCodeSystemText(instructions: string, tools: readonly string[]): string {
  return `${instructions}\nOpenCode tool names have the wf_ prefix. ` +
    (tools.includes('workflow_plan') ? 'Use wf_workflow_plan for the bound semantic plan. ' : '') +
    (tools.includes('assignment_report') ? 'Use wf_assignment_report for your substantive role result. ' : '') +
    'The backend owns every internal identity and stage transition.';
}
export class OpenCodeSession {
  private engine?: OpenCodeEngine;
  private gateway?: OpenCodeGateway;
  private controller = new AbortController();
  private sessionId?: string;
  private messageId?: string;
  private tools: string[] = [];
  private instructions = '';
  private stopped = false;
  private running?: Promise<void>;
  private closing?: Promise<void>;
  private turn?: OpenCodeTurnObserver;
  private failures?: OpenCodeToolFailureGuard;
  private resultSaved = false;
  constructor(readonly root: string, readonly receipt: NativeReceipt,
    readonly update: (patch: Partial<NativeReceipt>) => void,
    readonly complete: (state: 'completed' | 'blocked' | 'interrupted', error: string | null) => Promise<void>) {}

  async open(): Promise<void> {
    const context = ownedContext(this.root, this.receipt.request_id);
    if (!context || context.binding.workflow_id !== this.receipt.workflow_id || context.binding.role !== this.receipt.role ||
        (context.binding.task_id ?? null) !== this.receipt.task_id) throw new Error('OpenCode requires its backend-owned controlled assignment.');
    context.bindInvocation(this.receipt.id);
    const binding = { ...context.binding, invocation_id: this.receipt.id };
    this.tools = controlledToolNames(binding);
    this.instructions = controlledInstructions(binding);
    const endpoint = openCodeEndpoint(this.root, this.receipt);
    const callbacks = { ...context.callbacks,
      saveReport: async (...args: Parameters<typeof context.callbacks.saveReport>) => {
        const result = await context.callbacks.saveReport(...args); this.resultSaved = true; return result;
      },
      ...(context.callbacks.submitPlan ? { submitPlan: async (...args: Parameters<NonNullable<typeof context.callbacks.submitPlan>>) => {
        const result = await context.callbacks.submitPlan!(...args);
        if (binding.planning_result === 'backend') this.resultSaved = true;
        return result;
      } } : {}),
      ...(context.callbacks.requestInput ? { requestInput: async (...args: Parameters<NonNullable<typeof context.callbacks.requestInput>>) => {
        const result = await context.callbacks.requestInput!(...args); this.resultSaved = true; return result;
      } } : {}),
    };
    this.gateway = await createOpenCodeGateway(() => createControlledMcpServer(this.root, binding, callbacks),
      () => this.assertCurrent());
    let operation = 'engine-start';
    try {
      this.engine = await startOpenCodeEngine(this.root, this.receipt.id,
        openCodeConfiguration(endpoint, this.gateway, this.tools), this.controller.signal, { onPrepared: supervision => {
          this.update({ host_instance: supervision.instance,
            opencode: { version: opencodeRuntimeVersion, binary_sha256: openCodeBinary().sha256,
              gateway_instance: supervision.instance, supervision } });
        } });
      const permission = [{ permission: '*', pattern: '*', action: 'deny' as const },
        ...this.tools.map(name => ({ permission: `wf_${name}`, pattern: '*', action: 'allow' as const }))];
      operation = 'session-create';
      const session = await this.engine.client.session.create({ directory: this.engine.directory,
        title: `WorkForce ${this.receipt.role}`, agent: 'workforce', permission });
      if (!session.data?.id) throw new Error('OpenCode did not return a session identity.');
      this.sessionId = session.data.id;
      operation = 'mcp-status';
      const mcp = await this.engine.client.mcp.status({ directory: this.engine.directory });
      if (mcp.data?.wf?.status !== 'connected') throw new Error('Bound WorkForce gateway is unavailable.');
      this.messageId = `msg_${randomBytes(16).toString('hex')}`;
      this.update({ confirmed_model: endpoint.model, model_provider: opencodeProviderId,
        host_instance: this.engine.instance, native_thread_id: this.sessionId, native_turn_id: this.messageId,
        client_version: opencodeRuntimeVersion, protocol_sha256: hash(opencodeProtocol),
        runtime_integrity: opencodeRuntimeIntegrity, server_pid: this.engine.pid,
        opencode: { version: opencodeRuntimeVersion, binary_sha256: this.engine.binary_sha256, gateway_instance: this.engine.instance,
          supervision: this.engine.supervision },
        confirmed_reasoning_effort: null, effort_support: 'unavailable', native_sandbox: null, native_tool_scope: this.tools });
    } catch (error) {
      try { await context.callbacks.trace?.({ event: 'engine-failure', engine: 'opencode', owner: 'runtime',
        control_operation: operation, ...safeOpenCodeTransportError(error) }); } catch { /* Diagnostics never authorize replay. */ }
      const setupFailure = !this.controller.signal.aborted && setupTransportFailure(operation, error);
      const storageFailure = this.engine?.failure; await this.close();
      if (storageFailure) throw new Error(storageFailure.message);
      if (setupFailure) throw new OpenCodeControlSetupError();
      throw error;
    }
  }

  async run(): Promise<void> {
    if (!this.engine || !this.sessionId || this.stopped) throw new Error('OpenCode session is not open.');
    this.running = this.perform();
    // NativeSession waits on completion; it does not hold the submitting MCP request open.
    void this.running.catch(() => {});
  }
  /** Narrow owner-policy seam for deterministic transport fault fixtures. */
  protected createTurnObserver(client: OpenCodeEngine['client'], identity: OpenCodeTurnIdentity, options: OpenCodeTurnOptions): OpenCodeTurnObserver {
    return new OpenCodeTurnObserver(client, identity, options);
  }

  private async perform(): Promise<void> {
    const engine = this.engine!, sessionID = this.sessionId!;
    let operation = 'tool-list';
    try {
      const endpoint = openCodeEndpoint(this.root, this.receipt);
      const listed = await engine.client.tool.ids({ directory: engine.directory });
      const allowed = new Set(this.tools.map(name => `wf_${name}`));
      const toolMask = Object.fromEntries((listed.data ?? []).map(name => [name, allowed.has(name)]));
      for (const name of allowed) toolMask[name] = true;
      this.assertCurrent();
      this.failures = new OpenCodeToolFailureGuard(sessionID, this.tools);
      this.turn = this.createTurnObserver(engine.client, { sessionID, messageID: this.messageId!, directory: engine.directory,
        modelID: endpoint.model, providerID: opencodeProviderId }, {
        signal: this.controller.signal, assertCurrent: () => this.assertCurrent(),
        onToolPart: part => this.toolObservation(this.failures!.reconcile(part)),
        onObservation: event => ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.(event),
      });
      operation = 'event-subscribe';
      const eventStream = await engine.client.event.subscribe({ directory: engine.directory }, { signal: this.controller.signal });
      void this.observeEvents(eventStream.stream).catch(async error => {
        if (!this.stopped) await ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.({ event: 'engine-event-delivery-reconciling',
          engine: 'opencode', owner: 'runtime', ...safeOpenCodeTransportError(error), dispatch_replayed: false });
      });
      operation = 'prompt-admission';
      try {
        const admission = await engine.client.session.promptAsync({ sessionID, messageID: this.messageId, directory: engine.directory,
          agent: 'workforce', model: { providerID: opencodeProviderId, modelID: endpoint.model }, tools: toolMask,
          system: openCodeSystemText(this.instructions, this.tools),
          parts: [{ type: 'text', text: this.receipt.input_text }] }, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]) });
        await ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.({ event: 'engine-prompt-admission', engine: 'opencode', owner: 'runtime',
          acknowledged: admission.response.status === 204, status_code: admission.response.status, inference_completed: false });
      } catch (error) {
        if (this.stopped) return;
        await ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.({ event: 'engine-prompt-admission-unknown', engine: 'opencode', owner: 'runtime',
          ...safeOpenCodeTransportError(error), dispatch_replayed: false });
      }
      operation = 'turn-reconciliation';
      const response = { data: await this.turn.wait() };
      if (this.stopped) return;
      operation = 'result-validation';
      this.assertCurrent();
      if (response.data?.info.error) {
        const failure = response.data.info.error;
        const details = failure.data as { statusCode?: number; isRetryable?: boolean };
        await ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.({ event: 'engine-failure', engine: 'opencode',
          owner: 'runtime', error_name: failure.name,
          ...(Number.isInteger(details.statusCode) ? { status_code: details.statusCode } : {}),
          ...(typeof details.isRetryable === 'boolean' ? { retryable: details.isRetryable } : {}) });
        throw Object.assign(new Error('OpenCode provider did not complete the requested inference.'), { name: 'OpenCodeProviderError' });
      }
      if (!response.data || response.data.info.error || response.data.info.providerID !== opencodeProviderId ||
          response.data.info.modelID !== endpoint.model || response.data.info.sessionID !== sessionID ||
          response.data.info.parentID !== this.messageId)
        throw new Error('OpenCode response identity or inference result did not validate.');
      if (!this.gateway!.calls.size) throw new Error('OpenCode did not demonstrate invocation-bound tool execution.');
      if (!this.resultSaved) throw new OpenCodeTurnError('MCP_DELIVERY_PROTOCOL', 'The completed model turn did not persist its required bound professional result.');
      const text = response.data.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      this.update({ output: text.slice(0, 64000), opencode: { ...this.receipt.opencode!, response_message_id: response.data.info.id } });
      await this.complete('completed', null);
    } catch (error) {
      try { await ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.({ event: 'engine-failure', engine: 'opencode',
        owner: 'runtime', control_operation: operation, error_name: error instanceof Error ? error.name : 'Error', ...safeOpenCodeTransportError(error),
        message_sha256: hash(error instanceof Error ? error.message : 'Unknown engine failure') }); } catch { /* No diagnostic is an authorization or retry. */ }
      if (!this.stopped) {
        const setupFailure = !this.engine?.failure && !this.controller.signal.aborted && setupTransportFailure(operation, error);
        // A failed GET/SSE setup is not a provider outage. Close the engine
        // before reporting that no prompt or product operation was admitted.
        if (setupFailure) {
          try { await engine.close(); }
          catch {
            await this.complete('blocked', 'OPENCODE_DELIVERY_UNKNOWN: local control setup failed and owned-engine shutdown could not be authenticated. Preserve its assignment and effects before another dispatch.');
            return;
          }
          await this.complete('blocked', String(new OpenCodeControlSetupError()));
        }
        else await this.complete('blocked', this.engine?.failure?.message ?? (error instanceof OpenCodeTurnError ? `${error.code}: ${error.message}` : openCodeError(error)));
      }
    }
  }

  private async observeEvents(stream: AsyncIterable<unknown>): Promise<void> {
    const observed = new Set<string>();
    for await (const item of stream) {
      if (this.stopped || !item || typeof item !== 'object') return;
      const event = item as { id?: string; type?: string; properties?: Record<string, any> };
      const properties = event.properties;
      if (!properties || properties.sessionID !== this.sessionId || !event.id || observed.has(event.id)) continue;
      observed.add(event.id); if (observed.size > 4096) observed.delete(observed.values().next().value!);
      this.turn?.note(event);
      const context = ownedContext(this.root, this.receipt.request_id);
      await this.toolObservation(this.failures?.observe(event));
      if (event.type === 'session.status' || event.type === 'session.error') {
        await context?.callbacks.trace?.({ event: 'engine-session', engine: 'opencode', event_id: event.id,
          engine_event: event.type, ...(event.type === 'session.status' ? { status: properties.status?.type }
            : { error_name: properties.error?.name ?? 'UnknownError' }) });
        if (event.type === 'session.error' && !this.stopped) {
          const storage = openCodeStorageFailure(JSON.stringify(properties.error ?? {}));
          if (storage) { await this.complete('blocked', storage.message); return; }
          // Canonical messages/idle reconcile other engine errors. A lost
          // delivery or an owner-issued abort is not a provider verdict.
        }
      }
    }
  }
  private async toolObservation(observation?: OpenCodeToolObservation): Promise<void> {
    if (!observation || this.stopped) return;
    await ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.({ event: 'engine-tool', engine: 'opencode', ...observation });
    if (observation.halt && !this.stopped)
      await this.complete('blocked', observation.halt_reason === 'repeated-observation'
        ? 'CONTROLLED_OBSERVATION_LOOP: the same successful read-only input and content recurred three times without distinct committed work. WorkForce retained the established facts and stopped redundant observation.'
        : 'MCP_DELIVERY_PROTOCOL: the same bound tool input and error recurred twice in this owned session. WorkForce stopped redundant retries to reconcile the payload; current artifacts remain.');
  }

  private assertCurrent(): void {
    if (this.stopped) throw new Error('OpenCode actor has ended.');
    const current = readInvocation(this.root, this.receipt.id);
    if (!['starting', 'running'].includes(current.state) || current.owner_pid !== process.pid ||
        current.workflow_id !== this.receipt.workflow_id || current.task_id !== this.receipt.task_id ||
        current.request_id !== this.receipt.request_id || current.role !== this.receipt.role ||
        canonicalJson(current.native_tool_scope) !== canonicalJson(this.receipt.native_tool_scope) ||
        canonicalJson(invocationConfigurationHashes(this.root, current)) !== canonicalJson(current.configuration_hashes))
      throw new Error('OpenCode invocation binding is no longer current.');
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped = true;
      if (this.engine && this.sessionId) await this.engine.client.session.abort({ sessionID: this.sessionId,
        directory: this.engine.directory }, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      this.controller.abort();
      await closeWorkForceCapabilities(this.root, this.receipt.id);
      await this.gateway?.close();
      await this.engine?.close();
      // close may run inside perform's terminal callback; never await running here.
    })();
  }
}

export const openCodeAttestation = Object.freeze({ issuer: 'workforce-opencode', execution_mode: 'opencode-local',
  identity_provenance: 'local-opencode', runtime_version: opencodeRuntimeVersion, protocol: opencodeProtocol });
