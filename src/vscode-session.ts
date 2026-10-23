import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { hostRequest, readHost, bounded, bridgeProtocol, type HostDescriptor } from './vscode-wire.js';
import { canonicalJson, routingConfigurationHashes, readInvocation, roleModelPolicy, requireRoutingPolicy, type NativeReceipt } from './routing.js';
import { roleCapabilities } from './tools.js';
import { vscodeSelection } from './vscode-policy.js';

/** MCP remains in owning CLI process so manager and worker lifecycle APIs share ownership. */
export class VSCodeSession {
  private client = new Client({ name: 'taskforces-vscode-gateway', version: '1' });
  private server: any;
  private host!: HostDescriptor;
  private stopped = false;
  private controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private releaseDelay?: () => void;
  private polling: Promise<void> | null = null;
  private jobs = new Set<Promise<void>>();
  private closing: Promise<void> | null = null;
  constructor(readonly root: string, readonly receipt: NativeReceipt,
    readonly update: (patch: Partial<NativeReceipt>) => void,
    readonly complete: (state: 'completed' | 'blocked' | 'interrupted', error: string | null) => Promise<void>) {}
  async open(): Promise<void> {
    this.host = readHost(this.root);
    if (requireRoutingPolicy(this.root).vscode_effort_policy !== 'allow-unavailable')
      throw new Error('VS Code API cannot verify reasoning effort. Review compatibility ceiling and explicitly set vscode_effort_policy to allow-unavailable, or keep require-verified to block.');
    const { createMcpServer } = await import('./mcp.js');
    this.server = createMcpServer(this.root, { invocation_id: this.receipt.id });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await this.server.connect(serverTransport);
    await this.client.connect(clientTransport);
    const operations = roleCapabilities(this.receipt.role).operations;
    const listed = await this.client.listTools();
    const tools = listed.tools.filter((tool) => operations.includes(tool.name) && !['manager_run', 'manager_begin'].includes(tool.name));
    const spec = roleModelPolicy(this.root, this.receipt.role);
    for (;;) {
      const selected = vscodeSelection(this.root, this.receipt.role, this.receipt.requested_model);
      const ack = await hostRequest(this.host, 'open', { invocation_id: this.receipt.id, owner_pid: process.pid, tools });
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
    await hostRequest(this.host, 'run', this.input());
    this.polling = this.poll();
  }
  private input(): Record<string, unknown> { return { invocation_id: this.receipt.id, turn_id: this.receipt.native_turn_id }; }
  private async poll(): Promise<void> {
    try {
      while (!this.stopped) {
        if (canonicalJson(this.receipt.configuration_hashes) !== canonicalJson(routingConfigurationHashes(this.root)))
          throw new Error('Native configuration changed during VS Code inference.');
        const value = await hostRequest(this.host, 'poll', this.input(), this.controller.signal);
        if (!['prepared', 'running', 'completed', 'blocked', 'interrupted'].includes(value.state) ||
            !Array.isArray(value.events) || value.events.length > 32 || typeof value.output !== 'string' || value.output.length > 64000)
          throw new Error('VS Code host returned invalid bounded state.');
        if (value.output !== this.receipt.output) this.update({ output: value.output });
        for (const event of value.events) {
          // Do not block polling while native_wait or native_dispatch waits on another host turn.
          const job = this.tool(event).catch(() => {
            // Cleanup waits for jobs; never call it from inside a job that it must await.
            setImmediate(() => {
              if (!this.stopped) void this.complete('blocked', 'Invocation-bound MCP tool delivery failed.');
            });
          });
          this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
        }
        if (['completed', 'blocked', 'interrupted'].includes(value.state)) {
          if (value.events.length || this.jobs.size) throw new Error('Host ended while tool calls remain outstanding.');
          if (!this.stopped) await this.complete(value.state, value.error ? String(value.error).slice(0, 1000) : null);
          return;
        }
        await new Promise<void>((resolve) => {
          this.releaseDelay = resolve;
          this.timer = setTimeout(resolve, 50);
        });
        this.releaseDelay = undefined;
      }
    } catch (error) {
      if (!this.stopped) await this.complete('blocked', error instanceof Error ? error.message : 'VS Code host failed.');
    }
  }
  private async tool(event: any): Promise<void> {
    if (typeof event.call_id !== 'string' || event.call_id.length > 256 ||
        !this.receipt.native_tool_scope.includes(event.name) || ['manager_run', 'manager_begin'].includes(event.name))
      throw new Error('Host tool escapes invocation scope.');
    bounded(event.input);
    const current = readInvocation(this.root, this.receipt.id);
    if (current.state !== 'running') throw new Error('Invocation no longer running.');
    const result = await this.client.callTool({ name: event.name, arguments: event.input }, undefined,
      { timeout: 75000, signal: this.controller.signal });
    bounded(result);
    if (!this.stopped) await hostRequest(this.host, 'result', { ...this.input(), call_id: event.call_id, result }, this.controller.signal);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.stopped = true; this.controller.abort(); clearTimeout(this.timer); this.releaseDelay?.();
      if (this.host && this.receipt.native_turn_id)
        await hostRequest(this.host, 'cancel', this.input()).catch(() => {});
      await this.client.close(); await this.server?.close();
      await Promise.allSettled([...this.jobs]);
      // Do not await polling: successful completion calls close from inside polling.
    })();
    return this.closing;
  }
}
