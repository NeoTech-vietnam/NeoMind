import { randomUUID } from 'node:crypto';

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
): Promise<RouterProbe> {
  const url = new URL('/v1/chat/completions', baseUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password
  )
    throw new Error('Router probe must target a local HTTP endpoint without credentials.');
  if (!alias || /[\r\n\0]/.test(alias)) throw new Error('Invalid router alias.');
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: alias,
      messages: [{ role: 'user', content: `Reply OK only. Probe ${randomUUID()}` }],
      max_tokens: 16,
      stream: false,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Router probe failed (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object') throw new Error('Invalid router response.');
  const value = body as Record<string, unknown>;
  const choices = value.choices;
  const completed =
    Array.isArray(choices) && choices.length > 0 && choices[0]?.finish_reason === 'stop';
  return {
    requested_alias: alias,
    returned_model: typeof value.model === 'string' ? value.model : null,
    response_id: typeof value.id === 'string' ? value.id : null,
    completed,
    effort_confirmed: false,
    sandbox_confirmed: false,
  };
}
