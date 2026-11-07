import type { AssistantMessage, Message, Part } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeClient } from './opencode-engine.js';
import { canonicalJson } from './routing.js';
import { hash } from './storage.js';
import type { OpenCodeProviderProgress } from './opencode-provider-stream.js';

export interface OpenCodeTurnIdentity { sessionID: string; messageID: string; directory: string; modelID: string; providerID: string }
export interface OpenCodeTurnResult { info: AssistantMessage; parts: Part[] }
export class OpenCodeTurnError extends Error {
  constructor(readonly code: 'OPENCODE_PROVIDER_STALLED' | 'OPENCODE_PROVIDER_ARGUMENT_LIMIT' | 'OPENCODE_PROVIDER_UNAVAILABLE' | 'OPENCODE_DELIVERY_UNKNOWN' | 'OPENCODE_TURN_IDENTITY' | 'MCP_DELIVERY_PROTOCOL', message: string) { super(message); this.name = 'OpenCodeTurnError'; }
}
export interface OpenCodeTurnOptions {
  signal: AbortSignal; assertCurrent(): void;
  onToolPart?(part: Part): void | Promise<void>;
  onObservation?(event: Record<string, unknown>): void | Promise<void>;
  /** Fixed metadata from the invocation-owned relay, never model-authored content. */
  providerFailure?(): { code: 'OPENCODE_PROVIDER_ARGUMENT_LIMIT'; message: string } | undefined;
  /** Owner policy/test clock only, never worker parameters or a retry allowance. */
  model_idle_ms?: number; poll_ms?: number; http_timeout_ms?: number; now?: () => number;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pause = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(done, milliseconds);
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});
/** Observes one already-issued user message. It never submits a prompt or owns
 * model/tool iteration. HTTP/SSE delivery is not inference completion. */
export class OpenCodeTurnObserver {
  private progress = new Map<string, string>();
  private runningTools = new Set<string>();
  private providerSequences = new Map<string, number>();
  private lastProgress: number;
  private lastReadable: number;
  private admitted = false;
  private readonly ownedParents = new Set<string>();
  private readonly compactionSummaries = new Set<string>();
  private sessionError?: unknown;
  private statusUnreadableSince?: number;
  private readonly clock: () => number;
  private readonly idle: number;
  private readonly poll: number;
  private readonly httpTimeout: number;
  constructor(private readonly client: OpenCodeClient, readonly identity: OpenCodeTurnIdentity, private readonly options: OpenCodeTurnOptions) {
    this.ownedParents.add(identity.messageID);
    this.clock = options.now ?? (() => performance.now());
    this.idle = options.model_idle_ms ?? 120000; this.poll = options.poll_ms ?? 2000; this.httpTimeout = options.http_timeout_ms ?? 5000;
    this.lastProgress = this.clock(); this.lastReadable = this.clock();
  }
  /** The original submission remains immutable. Only the pinned engine's
   * persisted automatic-compaction chain can add an internal parent. */
  ownsParent(messageID: string): boolean { return this.ownedParents.has(messageID); }
  private reconcileCompactions(rows: { info: Message; parts: Part[] }[]): void {
    const compactions = new Set<string>();
    const model = (info: Message) => info.role === 'assistant'
      ? info.providerID === this.identity.providerID && info.modelID === this.identity.modelID
      : info.model?.providerID === this.identity.providerID && info.model?.modelID === this.identity.modelID;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!, previous = rows[index - 1];
      if (row.info.sessionID !== this.identity.sessionID || !model(row.info)) continue;
      if (row.info.role === 'user' && previous?.info.role === 'assistant' &&
          previous.info.sessionID === this.identity.sessionID && model(previous.info) &&
          this.ownsParent(previous.info.parentID) && previous.info.time.completed && !previous.info.error &&
          row.parts.length === 1 && row.parts[0]?.type === 'compaction' && row.parts[0].auto === true &&
          row.parts[0].sessionID === this.identity.sessionID && row.parts[0].messageID === row.info.id)
        compactions.add(row.info.id);
      if (row.info.role === 'assistant' && row.info.summary === true && compactions.has(row.info.parentID) && previous?.info.id === row.info.parentID &&
          !row.info.error && row.info.time.completed && row.info.finish === 'stop' &&
          !row.parts.some(part => part.type === 'tool' && ['pending', 'running'].includes(part.state.status)))
        this.compactionSummaries.add(row.info.id);
      if (row.info.role === 'user' && previous?.info.role === 'assistant' && this.compactionSummaries.has(previous.info.id) &&
          row.parts.length > 0 && row.parts.every(part => part.type === 'text' && part.synthetic === true && !part.ignored && part.metadata?.compaction_continue === true &&
            part.sessionID === this.identity.sessionID && part.messageID === row.info.id))
        this.ownedParents.add(row.info.id);
    }
  }
  private signal() { return AbortSignal.any([this.options.signal, AbortSignal.timeout(this.httpTimeout)]); }
  private mark(key: string, value: unknown) {
    const fingerprint = hash(canonicalJson(value));
    if (this.progress.get(key) !== fingerprint) { this.progress.set(key, fingerprint); this.lastProgress = this.clock(); }
    if (this.progress.size > 4096) this.progress.delete(this.progress.keys().next().value!);
  }
  private part(value: unknown) {
    if (!record(value) || value.sessionID !== this.identity.sessionID || typeof value.id !== 'string') return;
    if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string' && value.text.length)
      this.mark(value.id, { type: value.type, text: value.text });
    if (value.type === 'tool' && record(value.state) && typeof value.callID === 'string') {
      const state = value.state;
      if (state.status === 'running') this.runningTools.add(value.callID);
      else if (state.status === 'completed' || state.status === 'error') this.runningTools.delete(value.callID);
      const raw = typeof state.raw === 'string' ? state.raw : '';
      const input = record(state.input) ? state.input : {};
      // A tool name/step/status heartbeat without arguments is not model progress.
      if (raw.length || Object.keys(input).length || state.status === 'completed' || state.status === 'error')
        this.mark(value.id, { input, raw, status: state.status, output: state.output ?? null, error: state.error ?? null });
    }
  }
  note(value: unknown) {
    if (!record(value) || !record(value.properties) || value.properties.sessionID !== this.identity.sessionID) return;
    const properties = value.properties;
    if (value.type === 'session.error') this.sessionError = properties.error;
    if (value.type === 'message.part.updated') this.part(properties.part);
    // Pinned event families may stream deltas before their saved part update.
    if (['message.part.delta', 'session.next.text.delta', 'session.next.reasoning.delta', 'session.next.tool.input.delta'].includes(String(value.type)) &&
        typeof properties.delta === 'string' && properties.delta.length) this.lastProgress = this.clock();
  }
  /** Only the invocation-owned provider relay calls this; SDK pending tool
   * parts in the pinned ordinary engine do not retain streamed arguments. */
  noteProviderProgress(value: OpenCodeProviderProgress): void {
    if (!record(value) || typeof value.request_id !== 'string' || !value.request_id.length || value.request_id.length > 128 ||
        !['text', 'reasoning', 'tool-arguments'].includes(value.kind) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
        !Number.isSafeInteger(value.sequence) || value.sequence <= (this.providerSequences.get(value.request_id) ?? 0)) return;
    this.providerSequences.set(value.request_id, value.sequence);
    this.lastProgress = this.clock();
  }
  private async status(): Promise<'idle' | 'busy' | 'retry'> {
    try {
      const response = await this.client.session.status({ directory: this.identity.directory }, { signal: this.signal() });
      if (!response.response.ok || !response.data || typeof response.data !== 'object') throw new Error('OpenCode status could not be reconciled.');
      this.statusUnreadableSince = undefined;
      return response.data[this.identity.sessionID]?.type ?? 'idle';
    } catch (error) { this.statusUnreadableSince ??= this.clock(); throw error; }
  }
  private async abortAndReconcile(code: 'OPENCODE_PROVIDER_STALLED' | 'OPENCODE_PROVIDER_ARGUMENT_LIMIT', message: string): Promise<never> {
    let response;
    try { response = await this.client.session.abort({ sessionID: this.identity.sessionID, directory: this.identity.directory }, { signal: this.signal() }); }
    catch { throw new OpenCodeTurnError('OPENCODE_DELIVERY_UNKNOWN', 'The owned-turn abort reply is unknown. Reconcile the actual session and side effects before replay.'); }
    if (!response.response.ok || response.data !== true)
      throw new OpenCodeTurnError('OPENCODE_DELIVERY_UNKNOWN', 'OpenCode did not acknowledge the owned-turn abort. Preserve actual messages and operation results before another dispatch.');
    const deadline = this.clock() + Math.max(10000, this.httpTimeout * 2);
    while (this.clock() < deadline) {
      let status;
      try { status = await this.status(); } catch { /* Abort delivery is not completion; keep its bounded reconciliation window. */ }
      if (status === 'idle') {
        await this.options.onObservation?.({ event: code === 'OPENCODE_PROVIDER_STALLED' ? 'model-progress-stalled' : 'model-arguments-limited', engine: 'opencode', owner: 'runtime',
          admission_observed: this.admitted, model_idle_ms: this.idle, abort_acknowledged: true, session_idle_observed: true });
        throw new OpenCodeTurnError(code, message + ' The engine acknowledged cancellation and returned idle; actual artifacts and messages remain.');
      }
      await pause(Math.min(this.poll, 250), this.options.signal);
    }
    throw new OpenCodeTurnError('OPENCODE_DELIVERY_UNKNOWN', 'The owned model abort has no observed idle state yet. Preserve actual messages and side effects instead of replaying an uncertain turn.');
  }
  async wait(): Promise<OpenCodeTurnResult> {
    const admissionStarted = this.clock();
    for (;;) {
      this.options.signal.throwIfAborted(); this.options.assertCurrent();
      const providerFailure = this.options.providerFailure?.();
      if (providerFailure) return this.abortAndReconcile(providerFailure.code, providerFailure.message);
      try {
        const response = await this.client.session.messages({ sessionID: this.identity.sessionID, directory: this.identity.directory, limit: 200 }, { signal: this.signal() });
        if (!response.response.ok || !response.data) throw new Error('OpenCode messages could not be reconciled.');
        this.lastReadable = this.clock();
        if (response.data.some(row => row.info.role === 'user' && row.info.id === this.identity.messageID)) {
          if (!this.admitted) { this.admitted = true; this.lastProgress = this.clock(); }
        }
        this.reconcileCompactions(response.data);
        const candidates = response.data.filter(row => row.info.role === 'assistant' && row.info.summary !== true && this.ownsParent(row.info.parentID))
          .sort((a, b) => a.info.time.created - b.info.time.created);
        this.runningTools.clear();
        for (const row of candidates) {
          if (row.info.role !== 'assistant' || row.info.sessionID !== this.identity.sessionID || row.info.providerID !== this.identity.providerID || row.info.modelID !== this.identity.modelID)
            throw new OpenCodeTurnError('OPENCODE_TURN_IDENTITY', 'The observed assistant does not match the owned session, user message and configured model.');
          for (const part of row.parts) { this.part(part); await this.options.onToolPart?.(part); }
        }
        const latest = candidates.at(-1);
        if (this.admitted && latest?.info.role === 'assistant' && (latest.info.error || latest.info.time.completed && latest.info.finish === 'stop') &&
            !latest.parts.some(part => part.type === 'tool' && ['pending', 'running'].includes(part.state.status)) && await this.status() === 'idle') {
          const failure = this.options.providerFailure?.();
          if (failure) return this.abortAndReconcile(failure.code, failure.message);
          return { info: latest.info, parts: latest.parts };
        }
        if (this.admitted && this.sessionError && await this.status() === 'idle') {
          const failure = this.options.providerFailure?.();
          if (failure) return this.abortAndReconcile(failure.code, failure.message);
          const provider = record(this.sessionError) && /APIError|ProviderAuth|Authentication|ModelNotFound/.test(String(this.sessionError.name));
          throw new OpenCodeTurnError(provider ? 'OPENCODE_PROVIDER_UNAVAILABLE' : 'OPENCODE_DELIVERY_UNKNOWN', provider
            ? 'The owned engine reported a provider failure and returned idle; current messages and artifacts remain.'
            : 'The owned engine reported a session error without a matching completed assistant. Preserve its actual messages and side effects.');
        }
      } catch (error) {
        if (this.options.signal.aborted || error instanceof OpenCodeTurnError) throw error;
        await this.options.onObservation?.({ event: 'engine-delivery-reconciling', engine: 'opencode', owner: 'runtime',
          ...(safeOpenCodeTransportError(error)), dispatch_replayed: false });
        if (this.clock() - this.lastReadable > 30000 || this.statusUnreadableSince !== undefined && this.clock() - this.statusUnreadableSince > 30000)
          throw new OpenCodeTurnError('OPENCODE_DELIVERY_UNKNOWN', 'The engine state could not be read after a delivery interruption. Preserve its exact user message and operation ledger; no prompt was resubmitted.');
      }
      if (!this.admitted && this.clock() - admissionStarted >= 30000)
        throw new OpenCodeTurnError('OPENCODE_DELIVERY_UNKNOWN', 'Prompt admission has not been established from the actual saved user message. No duplicate prompt was sent.');
      if (this.admitted && this.statusUnreadableSince === undefined && !this.runningTools.size && this.clock() - this.lastProgress >= this.idle) {
        return this.abortAndReconcile('OPENCODE_PROVIDER_STALLED', 'No meaningful model text, reasoning or tool arguments arrived within the owned progress deadline.');
      }
      await pause(this.poll, this.options.signal);
    }
  }
}

/** SDK/provider errors may contain credentials and request bodies. Retain only
 * a bounded cause chain of names/codes plus message fingerprints. */
export function safeOpenCodeTransportError(error: unknown): Record<string, unknown> {
  const causes: { name: string; code?: string; message_sha256?: string }[] = [], seen = new Set<unknown>();
  let current: unknown = error;
  for (let index = 0; index < 6 && current && !seen.has(current); index++) {
    seen.add(current); if (!record(current) && !(current instanceof Error)) break;
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    causes.push({ name: typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name) ? value.name : 'Error',
      ...(typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? { code: value.code } : {}),
      ...(typeof value.message === 'string' ? { message_sha256: hash(value.message) } : {}) });
    current = value.cause;
  }
  return { transport_causes: causes };
}
