import { createHash, randomUUID } from 'node:crypto';
import { routerBaseUrl } from './router-probe.js';
import { ManagedGatewayError } from './managed-gateway-artifact.js';
import { sanitizeManagedGatewayQuota, managedGatewayTokenSavingPolicy, type ManagedGatewayTokenSavingMode } from './managed-gateway-policy.js';

export interface ManagedGatewayModel {
  id: string; name: string; family: string; owned_by: string | null; context_length: number | null; max_output_tokens: number | null;
  capabilities: { tools: boolean | null; vision: boolean | null; reasoning: boolean | null };
  capability_source: 'upstream-catalog-declaration' | 'upstream-and-user-declaration'; user_declared_fields?: readonly string[];
  observed_at: string; kind: 'model' | 'combo' | 'alias'; upstream_identity: 'not-observed';
}
export interface ManagedGatewayModelDeclaration { context_length?: number; max_output_tokens?: number; tools?: boolean; vision?: boolean }
export interface ManagedGatewayPolicy {
  /** Exact allowed router IDs, not guessed top/worker aliases. */
  models?: readonly string[];
  combos?: Readonly<Record<string, readonly string[]>>;
  vision_fallback?: string;
}
export interface ManagedGatewayEndpoint { baseUrl: string; generation: string }
export type ManagedGatewayChatEvent =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'usage'; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; source: 'gateway-response'; observed_at: string }
  | { type: 'routing'; requested_model: string; selected_model: string; returned_model: string | null; reason: 'selected' | 'authorized-vision-fallback'; upstream_verified: false }
  | { type: 'token-saving'; policy: ReturnType<typeof managedGatewayTokenSavingPolicy> }
  | { type: 'done'; finish_reason: string; request_id: string; request_sha256: string; raw_tool_results_preserved: true };
export interface ManagedGatewayClientOptions {
  getApiKey(): string | undefined | Promise<string | undefined>;
  getAdminCookie?(): string | undefined | Promise<string | undefined>;
  policy?: ManagedGatewayPolicy;
  /** Host-supplied User settings only. Model input and workspace settings are not authority. */
  modelDeclarations?: unknown;
  tokenSaving?: ManagedGatewayTokenSavingMode;
  fetch?: typeof globalThis.fetch;
  prepareCombo?(name: string, members: readonly string[], signal?: AbortSignal): Promise<string>;
  validateCombo?(shadowName: string): Promise<boolean>;
}
const catalogCaches = new WeakMap<typeof globalThis.fetch, Map<string, { expires: number; models: ManagedGatewayModel[] }>>();
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
export function validateManagedGatewayModelDeclarations(value: unknown): Readonly<Record<string, Readonly<ManagedGatewayModelDeclaration>>> {
  if (value === undefined) return Object.freeze({});
  const plain = (row: unknown): row is Record<string, unknown> => object(row) && [Object.prototype, null].includes(Object.getPrototypeOf(row));
  if (!plain(value) || Object.keys(value).length > 1024) throw new ManagedGatewayError('GATEWAY_MODEL_DECLARATION', 'User model declarations must map exact gateway IDs to bounded capacity and boolean capabilities.');
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([id, row]) => {
    if (!label(id) || !plain(row) || Object.keys(row).some(key => !['context_length', 'max_output_tokens', 'tools', 'vision'].includes(key)))
      throw new ManagedGatewayError('GATEWAY_MODEL_DECLARATION', 'Each User declaration accepts only exact model capacity, tool and vision fields.');
    const output: ManagedGatewayModelDeclaration = {};
    for (const field of ['context_length', 'max_output_tokens'] as const) if (row[field] !== undefined) {
      if (!Number.isSafeInteger(row[field]) || Number(row[field]) < 1 || Number(row[field]) > 1_000_000_000)
        throw new ManagedGatewayError('GATEWAY_MODEL_DECLARATION', 'Declared model capacities must be positive bounded safe integers.');
      output[field] = Number(row[field]);
    }
    for (const field of ['tools', 'vision'] as const) if (row[field] !== undefined) {
      if (typeof row[field] !== 'boolean') throw new ManagedGatewayError('GATEWAY_MODEL_DECLARATION', 'Declared model tool and vision capabilities must be booleans.');
      output[field] = row[field];
    }
    if (output.context_length !== undefined && output.max_output_tokens !== undefined && output.context_length <= output.max_output_tokens)
      throw new ManagedGatewayError('GATEWAY_MODEL_DECLARATION', 'Declared output capacity must be smaller than total context capacity.');
    return [id, Object.freeze(output)] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}
function failure(status: number): ManagedGatewayError {
  const code = status === 401 || status === 403 ? 'GATEWAY_AUTHORIZATION' : status === 429 ? 'GATEWAY_QUOTA' :
    status === 404 ? 'GATEWAY_MODEL_UNAVAILABLE' : status >= 500 ? 'GATEWAY_PROVIDER_UNAVAILABLE' : 'GATEWAY_REQUEST_REJECTED';
  return new ManagedGatewayError(code, status === 429 ? 'The selected provider reported a quota or rate limit.' :
    status === 401 || status === 403 ? 'The managed gateway or provider requires valid authorization.' : `The gateway request failed (HTTP ${status}).`);
}
export function createManagedGatewayClient(endpoint: ManagedGatewayEndpoint, options: ManagedGatewayClientOptions) {
  const base = routerBaseUrl(endpoint.baseUrl), origin = new URL(base).origin, request = options.fetch ?? globalThis.fetch;
  const declarations = validateManagedGatewayModelDeclarations(options.modelDeclarations);
  if (options.tokenSaving !== undefined && !['off', 'upstream-rtk'].includes(options.tokenSaving))
    throw new ManagedGatewayError('GATEWAY_TOKEN_POLICY', 'Choose off or upstream-rtk in User settings.');
  const declarationFingerprint = createHash('sha256').update(JSON.stringify(declarations)).digest('hex');
  async function headers(admin = false): Promise<Record<string, string>> {
    const key = await options.getApiKey(), cookie = admin ? await options.getAdminCookie?.() : undefined;
    if (key !== undefined && (!label(key) || /\s/.test(key))) throw new ManagedGatewayError('GATEWAY_AUTHORIZATION', 'The managed gateway key is unavailable or invalid.');
    return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(cookie ? { cookie } : {}) };
  }
  async function call(path: string, init: RequestInit = {}, admin = false): Promise<Response> {
    let response;
    try { response = await request(`${origin}${path}`, { ...init, redirect: 'error', headers: { ...await headers(admin), ...init.headers } }); }
    catch { throw new ManagedGatewayError(init.signal?.aborted ? 'GATEWAY_CANCELLED' : 'GATEWAY_CONNECTION',
      init.signal?.aborted ? 'The gateway request was cancelled.' : 'The managed gateway connection is unavailable.'); }
    if (!response.ok) { await response.body?.cancel(); throw failure(response.status); }
    return response;
  }
  async function json(path: string, init: RequestInit = {}, admin = false): Promise<any> {
    const response = await call(path, init, admin), reader = response.body?.getReader();
    if (!reader) throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway returned no response body.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway response exceeded its bounded catalog size.'); } chunks.push(item.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway returned invalid JSON.'); }
  }
  async function listModels(signal?: AbortSignal, refresh = false): Promise<ManagedGatewayModel[]> {
    const key = `${origin}/${endpoint.generation}/${createHash('sha256').update(await options.getApiKey() ?? '').digest('hex')}/${declarationFingerprint}`;
    let cache = catalogCaches.get(request); if (!cache) { cache = new Map(); catalogCaches.set(request, cache); }
    const saved = cache.get(key); if (!refresh && saved && saved.expires > Date.now()) return structuredClone(saved.models);
    const body = await json('/v1/models', { signal });
    if (!Array.isArray(body?.data)) throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway model catalog is invalid.');
    const seen = new Set<string>(), observed_at = new Date().toISOString();
    const models: ManagedGatewayModel[] = body.data.flatMap((row: any) => {
      if (!object(row) || !label(row.id) || seen.has(row.id)) return [];
      seen.add(row.id);
      const caps = object(row.capabilities) ? row.capabilities : {};
      const declared = Object.hasOwn(declarations, row.id) ? declarations[row.id] : undefined, userFields: string[] = [];
      const fill = <T>(upstream: T | null, user: T | undefined, field: string): T | null => {
        if (upstream !== null || user === undefined) return upstream;
        userFields.push(field); return user;
      };
      const contextLength = fill(integer(row.context_length ?? caps.contextWindow), declared?.context_length, 'context_length');
      const outputTokens = fill(integer(row.max_completion_tokens ?? caps.maxOutput), declared?.max_output_tokens, 'max_output_tokens');
      const tools = fill(typeof caps.tools === 'boolean' ? caps.tools : null, declared?.tools, 'tools');
      const vision = fill(typeof caps.vision === 'boolean' ? caps.vision : null, declared?.vision, 'vision');
      return [{ id: row.id, name: label(row.name) ? row.name : row.id, family: label(row.family) ? row.family : label(row.owned_by) ? row.owned_by : '9router',
        owned_by: label(row.owned_by) ? row.owned_by : null,
        context_length: contextLength, max_output_tokens: outputTokens,
        capabilities: { tools, vision,
          reasoning: typeof caps.reasoning === 'boolean' ? caps.reasoning : null }, capability_source: 'upstream-catalog-declaration' as const,
        ...(userFields.length ? { capability_source: 'upstream-and-user-declaration' as const, user_declared_fields: userFields } : {}),
        observed_at, kind: row.owned_by === 'combo' || row.kind === 'combo' ? 'combo' as const : row.kind === 'alias' ? 'alias' as const : 'model' as const,
        upstream_identity: 'not-observed' as const }];
    });
    cache.set(key, { expires: Date.now() + 30000, models }); return structuredClone(models);
  }
  function allowed(id: string): boolean { return options.policy?.models === undefined || options.policy.models.includes(id); }
  async function selectedModel(requested: string, messages: any[], signal?: AbortSignal): Promise<{ id: string; reason: 'selected' | 'authorized-vision-fallback'; shadow?: string }> {
    if (!label(requested) || !allowed(requested)) throw new ManagedGatewayError('GATEWAY_MODEL_NOT_APPROVED', 'Choose a model authorized for this WorkForce gateway connection.');
    let catalog = await listModels(signal);
    if (!catalog.some(model => model.id === requested)) catalog = await listModels(signal, true);
    const declared = catalog.find(model => model.id === requested);
    if (!declared) throw new ManagedGatewayError('GATEWAY_MODEL_UNAVAILABLE', 'The selected route is absent from the current upstream catalog; no model request was sent.');
    const members = options.policy?.combos?.[requested];
    const isCombo = declared?.kind === 'combo' || !!members;
    const declarations = isCombo ? await json('/api/combos', { signal }, true) : undefined;
    const actualCombo = (Array.isArray(declarations?.combos) ? declarations.combos : []).find((row: any) => row?.name === requested);
    if (isCombo && !members) throw new ManagedGatewayError('GATEWAY_COMBO_NOT_APPROVED', 'Authorize the exact combo fallback members before selecting this route.');
    if (members && (!members.length || members.some(model => !allowed(model)))) throw new ManagedGatewayError('GATEWAY_COMBO_NOT_APPROVED', 'Every combo fallback member must be explicitly authorized.');
    if (isCombo && (!actualCombo || !Array.isArray(actualCombo.models) || actualCombo.models.some((model: unknown) => typeof model !== 'string') ||
        JSON.stringify(actualCombo.models) !== JSON.stringify(members))) throw new ManagedGatewayError('GATEWAY_COMBO_CHANGED', 'The upstream combo changed from the authorized member snapshot; no model request was sent.');
    if (isCombo && (!options.prepareCombo || !options.validateCombo)) throw new ManagedGatewayError('GATEWAY_COMBO_NOT_PREPARED', 'The owned gateway must freeze the approved combo before inference.');
    const selected = { id: isCombo ? await options.prepareCombo!(requested, members!, signal) : requested, reason: 'selected' as const };
    const hasImage = messages.some(message => Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'image_url' || part?.type === 'input_image'));
    if (!hasImage) return { ...selected, ...(isCombo ? { shadow: selected.id } : {}) };
    const models = catalog, model = models.find(model => model.id === requested);
    if (model?.capabilities.vision === true && (!isCombo || members!.every(id => catalog.find(row => row.id === id)?.capabilities.vision === true)))
      return { ...selected, ...(isCombo ? { shadow: selected.id } : {}) };
    const fallback = options.policy?.vision_fallback;
    const fallbackModel = models.find(model => model.id === fallback);
    if (fallback && allowed(fallback) && fallbackModel?.capabilities.vision === true && fallbackModel.kind !== 'combo' && !options.policy?.combos?.[fallback])
      return { id: fallback, reason: 'authorized-vision-fallback' };
    throw new ManagedGatewayError('GATEWAY_VISION_UNAVAILABLE', 'This route has no declared vision capability or authorized vision fallback. Images were not sent or discarded.');
  }
  async function* chat(input: { model: string; messages: any[]; tools?: any[]; tool_choice?: unknown; temperature?: number; max_tokens?: number }, signal?: AbortSignal): AsyncGenerator<ManagedGatewayChatEvent> {
    if (!object(input) || !Array.isArray(input.messages)) throw new ManagedGatewayError('GATEWAY_REQUEST_REJECTED', 'Supply a model and native chat messages.');
    const selection = await selectedModel(input.model, input.messages, signal), requestId = randomUUID();
    // Keep original tool results and media intact. RTK belongs to upstream's
    // explicitly configured compression; this adapter never replaces evidence.
    const body = JSON.stringify({ ...input, model: selection.id, stream: true, stream_options: { include_usage: true } });
    const digest = createHash('sha256').update(body).digest('hex');
    const tokenSaving = managedGatewayTokenSavingPolicy(input.messages, options.tokenSaving);
    const response = await call('/v1/chat/completions', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-9router-token-saver': tokenSaving.header }, body });
    yield { type: 'token-saving', policy: tokenSaving };
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) { await response.body?.cancel(); throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway did not return a streaming response.'); }
    const reader = response.body?.getReader();
    if (!reader) throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway returned no stream.');
    const decoder = new TextDecoder(), tools = new Map<number, { id: string; name: string; args: string }>();
    let buffer = '', finish: string | null = null, semantic = false, returnedModel: string | null = null, done = false;
    try {
      for (;;) {
        const next = await reader.read();
        buffer = (buffer + decoder.decode(next.value, { stream: !next.done })).replaceAll('\r\n', '\n');
        if (buffer.length > 8 * 1024 * 1024) throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'A gateway stream frame exceeded its safe size.');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (data === '[DONE]') { done = true; break; }
          let value: any;
          try { value = JSON.parse(data); } catch { throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway returned an invalid event frame.'); }
          if (value.error) throw new ManagedGatewayError('GATEWAY_PROVIDER_ERROR', 'The provider reported a streaming error; the request was not replayed.');
          if (label(value.model)) returnedModel = value.model;
          if (object(value.usage)) yield { type: 'usage', input_tokens: integer(value.usage.prompt_tokens), output_tokens: integer(value.usage.completion_tokens),
            total_tokens: integer(value.usage.total_tokens), source: 'gateway-response', observed_at: new Date().toISOString() };
          for (const choice of Array.isArray(value.choices) ? value.choices : []) {
            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content) { semantic = true; yield { type: 'text', text: delta.content }; }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
            for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
              if (!Number.isSafeInteger(item.index) || item.index < 0) throw new ManagedGatewayError('GATEWAY_PROTOCOL', 'The gateway returned an invalid tool-call index.');
              const call = tools.get(item.index) ?? { id: '', name: '', args: '' };
              if (typeof item.id === 'string') call.id += item.id;
              if (typeof item.function?.name === 'string') call.name += item.function.name;
              if (typeof item.function?.arguments === 'string') call.args += item.function.arguments;
              if (call.args.length > 8 * 1024 * 1024) throw new ManagedGatewayError('GATEWAY_TOOL_ARGUMENTS', 'The gateway tool-call arguments exceeded the supported size.');
              tools.set(item.index, call);
            }
            if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
          }
        }
        if (next.done || done) break;
      }
      if (!finish) throw new ManagedGatewayError('GATEWAY_INCOMPLETE_RESPONSE', 'The provider stream ended without a final response marker; no tool calls were accepted. It was not replayed.');
      if (selection.shadow && !await options.validateCombo!(selection.shadow)) throw new ManagedGatewayError('GATEWAY_COMBO_CHANGED', 'The owned combo changed during inference; no tool calls or completed response were accepted.');
      const ids = new Set<string>();
      for (const call of tools.values()) {
        let args; try { args = JSON.parse(call.args); } catch { throw new ManagedGatewayError('GATEWAY_TOOL_ARGUMENTS', 'The selected model returned incomplete tool-call JSON.'); }
        if (!label(call.id) || !label(call.name) || ids.has(call.id) || !object(args)) throw new ManagedGatewayError('GATEWAY_TOOL_ARGUMENTS', 'The selected model returned invalid or duplicated tool calls.');
        ids.add(call.id); semantic = true; yield { type: 'tool-call', id: call.id, name: call.name, args };
      }
      if (!finish || !semantic) throw new ManagedGatewayError('GATEWAY_INCOMPLETE_RESPONSE', 'The provider stream ended without a usable final response or tool call. It was not replayed.');
      yield { type: 'routing', requested_model: input.model, selected_model: selection.id, returned_model: returnedModel, reason: selection.reason, upstream_verified: false };
      yield { type: 'done', finish_reason: finish, request_id: requestId, request_sha256: digest, raw_tool_results_preserved: true };
    } catch (error) {
      if (error instanceof ManagedGatewayError) throw error;
      throw new ManagedGatewayError(signal?.aborted ? 'GATEWAY_CANCELLED' : 'GATEWAY_CONNECTION', signal?.aborted ? 'The gateway stream was cancelled.' : 'The gateway stream was interrupted; observed output was retained and the request was not replayed.');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function providerStatus(signal?: AbortSignal) {
    const value = await json('/api/providers', { signal }, true), observed_at = new Date().toISOString();
    return { observed_at, source: 'owned-upstream-admin-api', connections: (Array.isArray(value?.connections) ? value.connections : []).flatMap((row: any) =>
      label(row.id) && label(row.provider) ? [{ id: row.id, provider: row.provider, name: label(row.name) ? row.name : row.provider,
        active: row.isActive === true || row.isActive === 1, status: label(row.testStatus) ? row.testStatus : 'unknown',
        prefix: label(row.providerSpecificData?.prefix) ? row.providerSpecificData.prefix : null, quota: 'unknown' }] : []) };
  }
  async function listUsableModels(signal?: AbortSignal) {
    const [models, providers, routing, comboData] = await Promise.all([listModels(signal), providerStatus(signal),
      json('/api/models', { signal }, true), json('/api/combos', { signal }, true)]);
    const enabled = providers.connections.filter((row: any) => row.active && !['error', 'failed', 'expired', 'invalid', 'disabled'].includes(row.status));
    const routes = new Set<string>(), aliases = new Set<string>();
    for (const connection of enabled) {
      // Prefix is explicit connection metadata used by upstream itself, not a
      // provider-name guess. Canonical routes/aliases come from its admin API.
      if (connection.prefix) for (const model of models) if (model.owned_by === connection.prefix || model.id.startsWith(`${connection.prefix}/`)) routes.add(model.id);
      for (const row of Array.isArray(routing?.models) ? routing.models : []) if (row.provider === connection.provider || row.provider === connection.prefix) {
        if (label(row.routedModel)) routes.add(row.routedModel);
        if (label(row.fullModel)) routes.add(row.fullModel);
        if (label(row.alias)) aliases.add(row.alias);
      }
      for (const model of models) if (model.owned_by === connection.provider) routes.add(model.id);
    }
    const combos = new Map((Array.isArray(comboData?.combos) ? comboData.combos : []).filter((row: any) => label(row.name)).map((row: any) => [row.name, row]));
    return models.flatMap(model => {
      const combo = combos.get(model.id) as any, members = options.policy?.combos?.[model.id];
      const admitted = combo ? members && JSON.stringify(combo.models) === JSON.stringify(members) && members.length && members.every(id => routes.has(id) && allowed(id)) :
        (routes.has(model.id) || aliases.has(model.id)) && allowed(model.id);
      if (!admitted) return [];
      return [{ ...model, kind: combo ? 'combo' as const : aliases.has(model.id) && !routes.has(model.id) ? 'alias' as const : model.kind,
        availability: 'connection-enabled-not-inference-tested', connection_source: 'owned-upstream-admin-api', connection_observed_at: providers.observed_at }];
    });
  }
  async function usage(signal?: AbortSignal) {
    const value = await json('/api/usage/stats?period=all', { signal }, true);
    const stats = object(value) ? value : {};
    return { observed_at: new Date().toISOString(), source: 'owned-gateway-only', requests: integer(stats.totalRequests ?? stats.requests),
      input_tokens: integer(stats.totalPromptTokens ?? stats.totalInputTokens ?? stats.inputTokens), output_tokens: integer(stats.totalCompletionTokens ?? stats.totalOutputTokens ?? stats.outputTokens),
      errors: integer(stats.totalErrors ?? stats.errors), estimated_cost: typeof stats.totalCost === 'number' && Number.isFinite(stats.totalCost) ? stats.totalCost : null,
      quota: 'unknown', quota_reset: null };
  }
  async function quota(connectionId: string, signal?: AbortSignal) {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(connectionId)) throw new ManagedGatewayError('GATEWAY_CONNECTION_ID', 'Select an observed upstream provider connection.');
    return { connection_id: connectionId, ...sanitizeManagedGatewayQuota(await json(`/api/usage/${encodeURIComponent(connectionId)}`, { signal }, true)) };
  }
  async function status(signal?: AbortSignal) { return { providers: await providerStatus(signal), usage: await usage(signal),
    catalog_source: 'upstream-catalog-declaration', upstream_identity: 'not-observed' }; }
  return { listModels, listUsableModels, chat, providerStatus, usage, quota, status, dashboardUrl: `${origin}/dashboard`,
    /** Host-only administrative seam. Never expose this as a model tool. */
    adminJson: (path: string, init: RequestInit = {}) => {
      if (!/^\/api\/(providers|provider-nodes|models|combos|usage(?:\/[^?#]*)?|oauth\/(codex|github|claude)\/(authorize|device-code|poll|poll-status|start-proxy|exchange)|settings|keys(?:\/[a-zA-Z0-9-]+)?)$/.test(path.split('?')[0]!))
        throw new ManagedGatewayError('GATEWAY_ADMIN_PATH', 'Use the owned upstream connection, combo, settings or usage API.');
      if (init.method && init.method !== 'GET') catalogCaches.get(request)?.clear();
      return json(path, init, true);
    } };
}
