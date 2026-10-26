import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { hostRequest, readHost, bounded, bridgeProtocol, type HostDescriptor, type BridgeTimeoutOptions } from './vscode-wire.js';
import { canonicalJson, routingConfigurationHashes, observeInvocation, roleModelPolicy, requireRoutingPolicy, type NativeReceipt } from './routing.js';
import { roleCapabilities } from './tools.js';
import { vscodeSelection } from './vscode-policy.js';
import { ownedContext } from './controlled-context.js';
import { createControlledMcpServer, controlledToolNames } from './controlled-tools.js';
import { invocationPolicy, invocationConfigurationHashes } from './routing.js';
import { hash } from './storage.js';

export type ToolDeliveryPhase = 'scope' | 'prebinding' | 'mcp-call' | 'result-bounds' | 'postbinding' | 'host-result';
const privateHostOptions = Object.freeze({ prefer_local_dispatch: true });
function errorField(error: unknown, name: string): unknown {
  try { return error && typeof error === 'object' ? (error as Record<string, unknown>)[name] : undefined; } catch { return undefined; }
}
/** Fixed metadata and hashes only; SDK/provider text never enters the receipt. */
export function vscodeToolDeliveryDiagnostic(phase: ToolDeliveryPhase, error: unknown) {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'McpError', 'ZodError', 'ControlledToolError', 'AbortError']);
  const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
    'BRIDGE_CONNECTION_TIMEOUT', 'BRIDGE_RESPONSE_TIMEOUT', 'BRIDGE_CONNECTION_FAILED', 'BRIDGE_CANCELLED']);
  const protocolCodes = new Set(['BRIDGE_REFUSED']);
  const modules = new Set(['vscode-session.js', 'vscode-session.ts', 'vscode-wire.js', 'vscode-wire.ts', 'routing.js', 'routing.ts',
    'controlled-tools.js', 'controlled-tools.ts', 'controlled-payload.js', 'controlled-payload.ts']);
  let code: string | null = null, mcpCode: number | null = null, current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = errorField(current, 'code');
    if (typeof value === 'string' && (transportCodes.has(value) || protocolCodes.has(value))) code ??= value;
    if (typeof value === 'number' && [-32700, -32600, -32601, -32602, -32603, -32000, -32001].includes(value)) mcpCode ??= value;
    const next = errorField(current, 'cause'); if (next === current) break; current = next;
  }
  const name = errorField(error, 'name'), message = errorField(error, 'message'), stack = errorField(error, 'stack');
  const frames = typeof stack === 'string' ? [...stack.slice(0, 64000).matchAll(/(?:[\\/](?:src|dist)[\\/])([a-z0-9-]+\.(?:js|ts)):(\d+):(\d+)/gi)]
    .filter(match => modules.has(match[1]!)).slice(0, 8).map(match => ({ module: match[1], line: Number(match[2]), column: Number(match[3]) })) : [];
  const environment = (phase === 'host-result' || phase === 'mcp-call') && (!!code && transportCodes.has(code) || mcpCode === -32001);
  const kind = environment ? 'environment' as const : 'protocol' as const;
  return { phase, kind, code: code ?? (mcpCode === -32001 ? 'MCP_REQUEST_TIMEOUT' : 'MCP_DELIVERY_REJECTED'),
    name: typeof name === 'string' && names.has(name) ? name : 'Error', mcp_code: mcpCode,
    status_code: protocolCodes.has(code ?? '') && Number.isInteger(errorField(error, 'status_code')) &&
      Number(errorField(error, 'status_code')) >= 100 && Number(errorField(error, 'status_code')) <= 599 ? errorField(error, 'status_code') : null,
    message_sha256: hash(typeof message === 'string' ? message.slice(0, 64000) : 'Unclassified tool delivery failure'), frames,
    side_effects: ['scope', 'prebinding'].includes(phase) ? 'not-dispatched' : phase === 'mcp-call' ? 'outcome-not-confirmed' : 'tool-result-observed',
    rule: environment ? 'The tool delivery transport did not complete. Preserve actual operation results; no tool was automatically replayed.'
      : 'The invocation-bound delivery contract did not validate. Preserve actual operation results and reconcile the backend boundary; no tool was replayed.' };
}
class ToolDeliveryError extends Error {
  readonly diagnostic: ReturnType<typeof vscodeToolDeliveryDiagnostic>;
  constructor(phase: ToolDeliveryPhase, cause: unknown) { super('Invocation-bound tool delivery failed.'); this.diagnostic = vscodeToolDeliveryDiagnostic(phase, cause); }
}

/** MCP remains in owning CLI process so manager and worker lifecycle APIs share ownership. */
export class VSCodeSession {
  private client = new Client({ name: 'neomind-vscode-gateway', version: '1' });
  private server: any;
  private host!: HostDescriptor;
  private stopped = false;
  private controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private releaseDelay?: () => void;
  private polling: Promise<void> | null = null;
  private jobs = new Set<Promise<void>>();
  private closing: Promise<void> | null = null;
  private activity = 0;
  private transportObserved = false;
  private readonly hostOptions: BridgeTimeoutOptions = { ...privateHostOptions, on_dispatch: transport => {
    if (this.transportObserved) return;
    this.transportObserved = true; delete this.hostOptions.on_dispatch;
    const context = ownedContext(this.root, this.receipt.request_id);
    try { void Promise.resolve(context?.callbacks.trace?.({ event: 'bridge-transport', transport,
      diagnostic_only: true, stage: context?.binding.stage, at: new Date().toISOString(), owner: 'runtime' })).catch(() => {}); }
    catch { /* Transport diagnostics never change invocation authority or work. */ }
  } };
  constructor(readonly root: string, readonly receipt: NativeReceipt,
    readonly update: (patch: Partial<NativeReceipt>) => void,
    readonly complete: (state: 'completed' | 'blocked' | 'interrupted', error: string | null) => Promise<void>) {}
  async open(): Promise<void> {
    this.host = readHost(this.root);
    if (requireRoutingPolicy(this.root).vscode_effort_policy !== 'allow-unavailable')
      throw new Error('VS Code API cannot verify reasoning effort. Review compatibility ceiling and explicitly set vscode_effort_policy to allow-unavailable, or keep require-verified to block.');
    const controlled = ownedContext(this.root, this.receipt.request_id);
    if (this.receipt.controlled_execution && !controlled) throw new Error('Controlled invocation lost its owning runtime context.');
    if (controlled) {
      controlled.bindInvocation(this.receipt.id);
      this.server = createControlledMcpServer(this.root, { ...controlled.binding, invocation_id: this.receipt.id }, controlled.callbacks);
    } else {
      const { createMcpServer } = await import('./mcp.js');
      this.server = createMcpServer(this.root, { invocation_id: this.receipt.id });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await this.server.connect(serverTransport);
    await this.client.connect(clientTransport);
    const operations = controlled ? controlledToolNames(controlled.binding) : roleCapabilities(this.receipt.role).operations;
    const listed = await this.client.listTools();
    const tools = listed.tools.filter((tool) => operations.includes(tool.name) && !['manager_run', 'manager_begin'].includes(tool.name));
    const spec = roleModelPolicy(this.root, this.receipt.role, invocationPolicy(this.root, this.receipt));
    for (;;) {
      const selected = vscodeSelection(this.root, this.receipt.role, this.receipt.requested_model, invocationPolicy(this.root, this.receipt));
      const ack = await hostRequest(this.host, 'open', { invocation_id: this.receipt.id, owner_pid: process.pid, tools }, undefined, this.hostOptions);
      if (ack.unavailable === true) {
        const index = spec.models.indexOf(this.receipt.requested_model);
        const next = !spec.strong ? spec.models[index + 1] : undefined;
        if (!next) throw new Error(`Configured VS Code model ${selected.vendor}/${selected.id} is unavailable from live model discovery. Enable that exact model and grant access in VS Code; no replacement model was selected.`);
        this.update({ requested_model: next, fallback_evidence: { model: this.receipt.requested_model,
          reason: 'VS Code selectChatModels returned no model for exact vendor/ID.', at: new Date().toISOString() } });
        continue;
      }
      if (ack.protocol !== bridgeProtocol || ack.host_instance !== this.host.instance ||
          ack.model !== selected.id || ack.vendor !== selected.vendor || ack.reasoning_effort !== null || ack.sandbox !== null ||
          typeof ack.version !== 'string' || !/^vscode-host:conversation:[a-f0-9-]{36}$/.test(ack.conversation_id) ||
          !/^vscode-host:turn:[a-f0-9-]{36}$/.test(ack.turn_id))
        throw new Error('VS Code host local attestation mismatches requested provider/model or protocol.');
      this.update({ confirmed_model: ack.model, model_provider: ack.vendor, host_instance: ack.host_instance,
        native_thread_id: ack.conversation_id, native_turn_id: ack.turn_id, client_version: ack.version,
        confirmed_reasoning_effort: null, native_sandbox: null, native_tool_scope: operations });
      return;
    }
  }
  async run(): Promise<void> {
    await hostRequest(this.host, 'run', this.input(), undefined, this.hostOptions);
    this.polling = this.poll();
  }
  private input(): Record<string, unknown> { return { invocation_id: this.receipt.id, turn_id: this.receipt.native_turn_id }; }
  private async poll(): Promise<void> {
    let emptyDelay = 50, previousState = this.receipt.state, observedActivity = this.activity;
    try {
      while (!this.stopped) {
        if (canonicalJson(this.receipt.configuration_hashes) !== canonicalJson(invocationConfigurationHashes(this.root, this.receipt)))
          throw new Error('Native configuration changed during VS Code inference.');
        const value = await hostRequest(this.host, 'poll', this.input(), this.controller.signal, this.hostOptions);
        if (!['prepared', 'running', 'completed', 'blocked', 'interrupted'].includes(value.state) ||
            !Array.isArray(value.events) || value.events.length > 32 || typeof value.output !== 'string' || value.output.length > 64000)
          throw new Error('VS Code host returned invalid bounded state.');
        const outputChanged = value.output !== this.receipt.output;
        const active = value.events.length > 0 || value.state !== previousState || outputChanged || observedActivity !== this.activity;
        previousState = value.state; observedActivity = this.activity;
        if (outputChanged) this.update({ output: value.output });
        for (const event of value.events) {
          // Do not block polling while native_wait or native_dispatch waits on another host turn.
          const job = this.tool(event).catch(error => {
            // Cleanup waits for jobs; never call it from inside a job that it must await.
            setImmediate(() => {
              if (!this.stopped) void this.deliveryFailed(event, error);
            });
          });
          this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
        }
        if (['completed', 'blocked', 'interrupted'].includes(value.state)) {
          if (value.events.length || this.jobs.size) throw new Error('Host ended while tool calls remain outstanding.');
          if (!this.stopped) await this.complete(value.state, value.error ? String(value.error).slice(0, 1000) : null);
          return;
        }
        if (this.stopped) return;
        const delay = active ? 50 : emptyDelay;
        emptyDelay = active ? 50 : Math.min(250, emptyDelay * 2);
        await new Promise<void>((resolve) => {
          this.releaseDelay = resolve;
          this.timer = setTimeout(() => this.wakeDelay(), delay);
        });
        this.releaseDelay = undefined;
      }
    } catch (error) {
      if (!this.stopped) await this.complete('blocked', error instanceof Error ? error.message : 'VS Code host failed.');
    }
  }
  private async deliveryFailed(event: any, error: unknown): Promise<void> {
    const diagnostic = error instanceof ToolDeliveryError ? error.diagnostic : vscodeToolDeliveryDiagnostic('scope', error);
    const context = ownedContext(this.root, this.receipt.request_id);
    try { await context?.callbacks.trace?.({ event: 'mcp-delivery-failed',
      tool: typeof event.name === 'string' && this.receipt.native_tool_scope.includes(event.name) ? event.name : '[unscoped]',
      delivery: diagnostic, stage: context?.binding.stage, at: new Date().toISOString(), owner: 'runtime' }); } catch { /* Diagnostic failure never replays an operation. */ }
    if (!this.stopped) await this.complete('blocked', `${diagnostic.kind === 'environment' ? 'MCP_DELIVERY_TRANSPORT' : 'MCP_DELIVERY_PROTOCOL'}: ${JSON.stringify(diagnostic)}`);
  }
  private async tool(event: any): Promise<void> {
    let phase: ToolDeliveryPhase = 'scope';
    try {
    if (typeof event.call_id !== 'string' || event.call_id.length > 256 ||
        !this.receipt.native_tool_scope.includes(event.name) || ['manager_run', 'manager_begin'].includes(event.name))
      throw new Error('Host tool escapes invocation scope.');
    bounded(event.input);
    phase = 'prebinding';
    this.assertCurrentInvocation();
    // The owned host already records a redacted semantic request before MCP
    // schema validation. Do not duplicate it here with raw path/key metadata.
    phase = 'mcp-call';
    const result = await this.client.callTool({ name: event.name, arguments: event.input }, undefined,
      { timeout: this.receipt.controlled_execution ? 660000 : 75000, signal: this.controller.signal });
    phase = 'result-bounds'; bounded(result);
    if (!this.stopped) {
      phase = 'postbinding';
      this.assertCurrentInvocation();
      phase = 'host-result';
      await hostRequest(this.host, 'result', { ...this.input(), call_id: event.call_id, result }, this.controller.signal, this.hostOptions);
      this.activity++; this.wakeDelay();
    }
    } catch (error) { throw new ToolDeliveryError(phase, error); }
  }
  private assertCurrentInvocation(): void {
    const observed = observeInvocation(this.root, this.receipt.role, this.receipt.id, {
      ...(this.receipt.workflow_id ? { workflow_id: this.receipt.workflow_id } : {}),
      ...(this.receipt.task_id ? { task_id: this.receipt.task_id } : {}), require_completed: false });
    const current = observed.receipt;
    if (!current || current.state !== 'running') throw new Error('Invocation no longer running.');
    if (canonicalJson(this.receipt.configuration_hashes) !== canonicalJson(observed.current_configuration_hashes))
      throw new Error('Native configuration changed during VS Code inference.');
    if (observed.problems.length) throw new Error('Invocation-bound routing changed during VS Code inference.');
    if (current.host_instance !== this.host.instance || current.native_thread_id !== this.receipt.native_thread_id ||
        current.native_turn_id !== this.receipt.native_turn_id || current.owner_pid !== this.receipt.owner_pid ||
        current.key_id !== this.receipt.key_id || current.workflow_id !== this.receipt.workflow_id || current.task_id !== this.receipt.task_id ||
        current.requested_model !== this.receipt.requested_model || current.confirmed_model !== this.receipt.confirmed_model ||
        current.model_provider !== this.receipt.model_provider ||
        current.controlled_execution?.epoch_id !== this.receipt.controlled_execution?.epoch_id ||
        current.controlled_execution?.stage !== this.receipt.controlled_execution?.stage ||
        canonicalJson(current.native_tool_scope) !== canonicalJson(this.receipt.native_tool_scope))
      throw new Error('Invocation-bound host identity changed during VS Code inference.');
  }
  private wakeDelay(): void {
    clearTimeout(this.timer); this.timer = undefined;
    const release = this.releaseDelay; this.releaseDelay = undefined; release?.();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.stopped = true; this.controller.abort(); this.wakeDelay();
      if (this.host && this.receipt.native_turn_id)
        await hostRequest(this.host, 'cancel', this.input(), undefined, this.hostOptions).catch(() => {});
      await this.client.close(); await this.server?.close();
      await Promise.allSettled([...this.jobs]);
      // Do not await polling: successful completion calls close from inside polling.
    })();
    return this.closing;
  }
}
