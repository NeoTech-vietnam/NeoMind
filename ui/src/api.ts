/** How an API request reaches NeoMind: the editor's HTTP server by default, the extension backend inside Nimbalyst. */
export type ApiTransport = (endpoint: string, method: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

const http: ApiTransport = async (endpoint, method, body) => {
  const token = document.querySelector<HTMLMetaElement>('meta[name="neomind-token"]')?.content ?? '';
  const headers: Record<string, string> = method === 'GET' ? {} : { 'X-NeoMind-Token': token, 'Content-Type': 'application/json' };
  const response = await fetch(endpoint, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as unknown };
};
let transport: ApiTransport = http;
export function setApiTransport(next: ApiTransport): void { transport = next; }

export async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await transport(endpoint, method, body), data = response.body as T & { error?: string };
  if (response.status >= 400) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
}
