/**
 * How an API request reaches `langflow web`. The web page calls the server directly with the token the server put in
 * <meta name="langflow-token">; inside Nimbalyst the extension swaps the transport for its backend tool (which adds
 * the token and `X-Langflow-Channel: panel` itself).
 */
export type ApiResult = { status: number; body: unknown };
export type ApiTransport = (endpoint: string, method: string, body?: unknown) => Promise<ApiResult>;

/** Token for the web page: the meta tag `langflow web` injects; `?token=` in the URL for `npm run dev` through the proxy. */
export function pageToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="langflow-token"]')?.content;
  if (meta) return meta;
  try { return new URLSearchParams(location.search).get('token') ?? ''; } catch { return ''; }
}

export const httpTransport: ApiTransport = async (endpoint, method, body) => {
  const headers: Record<string, string> = { 'X-Langflow-Token': pageToken(), 'X-Langflow-Channel': 'web' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(endpoint, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) as unknown : null; } catch { data = { error: text.slice(0, 300) || `HTTP ${response.status}` }; }
  return { status: response.status, body: data };
};

let transport: ApiTransport = httpTransport;
export function setApiTransport(next: ApiTransport): void { transport = next; }

/** An API error keeps the HTTP status, so callers can tell a 409 (busy, not waiting) from the rest. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await transport(endpoint, method, body), data = response.body as T & { error?: string };
  if (response.status >= 400) throw new ApiError(data?.error ?? `HTTP ${response.status}`, response.status);
  return data;
}

export const enc = encodeURIComponent;
