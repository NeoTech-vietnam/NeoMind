import { createControlledMcpServer, controlledInstructions, controlledToolNames } from './controlled-tools.js';
import { randomBytes } from 'node:crypto';
import { ownedContext } from './controlled-context.js';
import { canonicalJson, invocationConfigurationHashes, readInvocation, type NativeReceipt } from './routing.js';
import { hash } from './storage.js';
import { closeWorkForceCapabilities } from './workforce-plugin-gateway.js';
import { OpenCodeToolFailureGuard } from './opencode-tool-observation.js';
import { createOpenCodeGateway, openCodeConfiguration, openCodeEndpoint, openCodeError, openCodeBinary, opencodeProtocol,
  opencodeProviderId, opencodeRuntimeVersion, opencodeRuntimeIntegrity, openCodeStorageFailure, startOpenCodeEngine, type OpenCodeEngine, type OpenCodeGateway } from './opencode-engine.js';

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
    this.gateway = await createOpenCodeGateway(() => createControlledMcpServer(this.root, binding, context.callbacks),
      () => this.assertCurrent());
    try {
      this.engine = await startOpenCodeEngine(this.root, this.receipt.id,
        openCodeConfiguration(endpoint, this.gateway, this.tools), this.controller.signal, { onPrepared: supervision => {
          this.update({ host_instance: supervision.instance,
            opencode: { version: opencodeRuntimeVersion, binary_sha256: openCodeBinary().sha256,
              gateway_instance: supervision.instance, supervision } });
        } });
      const permission = [{ permission: '*', pattern: '*', action: 'deny' as const },
        ...this.tools.map(name => ({ permission: `wf_${name}`, pattern: '*', action: 'allow' as const }))];
      const session = await this.engine.client.session.create({ directory: this.engine.directory,
        title: `WorkForce ${this.receipt.role}`, agent: 'workforce', permission });
      if (!session.data?.id) throw new Error('OpenCode did not return a session identity.');
      this.sessionId = session.data.id;
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
    } catch (error) { const storageFailure = this.engine?.failure; await this.close();
      if (storageFailure) throw new Error(storageFailure.message);
      throw error;
    }
  }

  async run(): Promise<void> {
    if (!this.engine || !this.sessionId || this.stopped) throw new Error('OpenCode session is not open.');
    this.running = this.perform();
    // NativeSession waits on completion; it does not hold the submitting MCP request open.
    void this.running.catch(() => {});
  }

  private async perform(): Promise<void> {
    const engine = this.engine!, sessionID = this.sessionId!;
    try {
      const endpoint = openCodeEndpoint(this.root, this.receipt);
      const listed = await engine.client.tool.ids({ directory: engine.directory });
      const allowed = new Set(this.tools.map(name => `wf_${name}`));
      const toolMask = Object.fromEntries((listed.data ?? []).map(name => [name, allowed.has(name)]));
      for (const name of allowed) toolMask[name] = true;
      this.assertCurrent();
      const eventStream = await engine.client.event.subscribe({ directory: engine.directory }, { signal: this.controller.signal });
      void this.observeEvents(eventStream.stream).catch(() => {});
      const response = await engine.client.session.prompt({ sessionID, messageID: this.messageId, directory: engine.directory,
        agent: 'workforce', model: { providerID: opencodeProviderId, modelID: endpoint.model }, tools: toolMask,
        system: openCodeSystemText(this.instructions, this.tools),
        parts: [{ type: 'text', text: this.receipt.input_text }] }, { signal: this.controller.signal });
      if (this.stopped) return;
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
      const text = response.data.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      this.update({ output: text.slice(0, 64000) });
      await this.complete('completed', null);
    } catch (error) {
      try { await ownedContext(this.root, this.receipt.request_id)?.callbacks.trace?.({ event: 'engine-failure', engine: 'opencode',
        owner: 'runtime', error_name: error instanceof Error ? error.name : 'Error',
        message_sha256: hash(error instanceof Error ? error.message : 'Unknown engine failure') }); } catch { /* No diagnostic is an authorization or retry. */ }
      if (!this.stopped) await this.complete('blocked', this.engine?.failure?.message ?? openCodeError(error));
    }
  }

  private async observeEvents(stream: AsyncIterable<unknown>): Promise<void> {
    const observed = new Set<string>();
    const failures = new OpenCodeToolFailureGuard(this.sessionId!, this.tools);
    for await (const item of stream) {
      if (this.stopped || !item || typeof item !== 'object') return;
      const event = item as { id?: string; type?: string; properties?: Record<string, any> };
      const properties = event.properties;
      if (!properties || properties.sessionID !== this.sessionId || !event.id || observed.has(event.id)) continue;
      observed.add(event.id); if (observed.size > 4096) observed.delete(observed.values().next().value!);
      const context = ownedContext(this.root, this.receipt.request_id);
      const observation = failures.observe(event);
      if (observation) {
        await context?.callbacks.trace?.({ event: 'engine-tool', engine: 'opencode', ...observation });
        if (observation.halt && !this.stopped) {
          await this.complete('blocked', 'MCP_DELIVERY_PROTOCOL: the same bound tool input and error recurred twice without distinct committed work. WorkForce stopped this session to reconcile the payload; current artifacts remain.');
          return;
        }
      }
      if (event.type === 'session.status' || event.type === 'session.error') {
        await context?.callbacks.trace?.({ event: 'engine-session', engine: 'opencode', event_id: event.id,
          engine_event: event.type, ...(event.type === 'session.status' ? { status: properties.status?.type }
            : { error_name: properties.error?.name ?? 'UnknownError' }) });
        if (event.type === 'session.error' && !this.stopped) {
          const storage = openCodeStorageFailure(JSON.stringify(properties.error ?? {}));
          const provider = /APIError|Authentication|ModelNotFound|ProviderAuth/.test(properties.error?.name ?? '');
          await this.complete('blocked', storage?.message ?? (provider
            ? 'OPENCODE_PROVIDER_UNAVAILABLE: the private engine reported a provider failure. Current artifacts and operation evidence are retained.'
            : 'OPENCODE_SESSION_ERROR: the private engine reported an execution failure. Current artifacts and operation evidence are retained.'));
          return;
        }
      }
    }
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
