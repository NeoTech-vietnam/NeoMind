import { randomUUID } from 'node:crypto';

export interface RouterRequestOptions {
  api_key?: string;
  signal?: AbortSignal;
  timeout_ms?: number;
}
export interface RouterModel { id: string; owned_by?: string }

/** Keep the local gateway boundary explicit, including redirects and URL credentials. */
export function routerBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' ||
      url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname))
    throw new Error('Router must target a local HTTP endpoint without credentials, query, or custom path.');
  return `${url.origin}/v1`;
}

async function routerRequest(baseUrl: string, path: string, options: RouterRequestOptions, body?: unknown): Promise<unknown> {
  const endpoint = new URL(path, routerBaseUrl(baseUrl));
  const key = options.api_key;
  if (key !== undefined && (!key.trim() || /[\r\n\0]/.test(key))) throw new Error('Invalid router API key.');
  const timeout = options.timeout_ms ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('Invalid router timeout.');
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(signal.aborted ? 'Router request cancelled or timed out.' : 'Router endpoint is unavailable.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Router request failed (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid router response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); throw new Error('Router response exceeds size limit.'); }
      chunks.push(part.value);
    }
  } catch {
    throw new Error(signal.aborted ? 'Router request cancelled or timed out.' : 'Router response could not be read within limits.');
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid router JSON response.'); }
}

export async function checkRouterHealth(baseUrl: string, options: RouterRequestOptions = {}): Promise<{ ok: true }> {
  const value = await routerRequest(baseUrl, '/api/health', options);
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).ok !== true)
    throw new Error('Router health response did not confirm readiness.');
  return { ok: true };
}

export async function listRouterModels(baseUrl: string, options: RouterRequestOptions = {}): Promise<RouterModel[]> {
  const value = await routerRequest(baseUrl, '/v1/models', options);
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).data))
    throw new Error('Invalid router model catalog.');
  const result = new Map<string, RouterModel>();
  for (const item of (value as { data: unknown[] }).data) {
    if (!item || typeof item !== 'object') throw new Error('Invalid router model entry.');
    const { id, owned_by } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\r\n\0]/.test(id))
      throw new Error('Invalid router model ID.');
    result.set(id, { id, ...(typeof owned_by === 'string' && owned_by.length <= 256 && !/[\r\n\0]/.test(owned_by)
      ? { owned_by } : {}) });
  }
  return [...result.values()];
}

/** An alias probe is diagnostic evidence, never a strict native invocation receipt. */
export interface RouterProbe {
  requested_alias: string;
  returned_model: string | null;
  response_id: string | null;
  completed: boolean;
  effort_confirmed: false;
  sandbox_confirmed: false;
}

export async function probeRouter(
  baseUrl: string,
  alias: string,
  signal?: AbortSignal,
  options: Omit<RouterRequestOptions, 'signal'> = {},
): Promise<RouterProbe> {
  routerBaseUrl(baseUrl);
  if (!alias.trim() || alias.length > 256 || /[\r\n\0]/.test(alias)) throw new Error('Invalid router alias.');
  const body = await routerRequest(baseUrl, '/v1/chat/completions', { ...options, signal }, {
      model: alias,
      messages: [{ role: 'user', content: `Reply OK only. Probe ${randomUUID()}` }],
      max_tokens: 16,
      stream: false,
    });
  if (!body || typeof body !== 'object') throw new Error('Invalid router response.');
  const value = body as Record<string, unknown>;
  const choices = value.choices;
  const completed =
    Array.isArray(choices) && choices.length > 0 && choices[0]?.finish_reason === 'stop';
  return {
    requested_alias: alias,
    returned_model: typeof value.model === 'string' && value.model.length <= 256 && !/[\r\n\0]/.test(value.model) ? value.model : null,
    response_id: typeof value.id === 'string' && value.id.length <= 256 && !/[\r\n\0]/.test(value.id) ? value.id : null,
    completed,
    effort_confirmed: false,
    sandbox_confirmed: false,
  };
}
