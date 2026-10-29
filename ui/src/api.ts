export async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const token = document.querySelector<HTMLMetaElement>('meta[name="neomind-token"]')?.content ?? '';
  const headers: Record<string, string> = method === 'GET' ? {} : { 'X-NeoMind-Token': token, 'Content-Type': 'application/json' };
  const response = await fetch(endpoint, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
