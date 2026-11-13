import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { TurnResult } from '../adapters/codex-turn-events.js';
import { openCodeV2Result } from './opencode-v2-result.js';
import { verifyOpenCodeV2Session, type OpenCodeV2SessionSpec } from './opencode-v2-session.js';

type Transport = { request(method: 'GET' | 'POST', endpoint: string, body?: unknown, timeoutMs?: number): Promise<unknown> };
const admitted = z.object({ data: z.object({ id: z.string().min(1), sessionID: z.string(), type: z.literal('user') }) });
const page = z.object({ data: z.array(z.unknown()), cursor: z.object({ next: z.string().nullish() }) });

function parseStructuredOutput(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { /* Some models wrap the document in a Markdown fence. */ }
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
  if (fences.length !== 1 || (text.match(/```/g) ?? []).length !== 2) throw new Error('Ambiguous JSON output');
  return JSON.parse(fences[0]![1]!) as unknown;
}

async function readTimeline(server: Transport, session: string): Promise<{ data: unknown[]; cursor: { next: null } }> {
  const data: unknown[] = [], seen = new Set<string>();
  let query = '?order=asc';
  for (let count = 0; count < 100; count++) {
    const current = page.parse(await server.request('GET', `${session}/message${query}`));
    data.push(...current.data);
    const next = current.cursor.next;
    if (!next) return { data, cursor: { next: null } };
    if (seen.has(next)) throw new Error('OpenCode V2 repeated a message cursor');
    seen.add(next);
    query = `?cursor=${encodeURIComponent(next)}`;
  }
  throw new Error('OpenCode V2 message timeline exceeds page limit');
}

/** V2 has no native session schema mode: validate the entire returned JSON locally before accepting it. */
export async function dispatchOpenCodeV2Turn(server: Transport, input: { nativeId: string; spec: OpenCodeV2SessionSpec;
  prompt: string; turnId: string; outputSchema?: unknown }): Promise<TurnResult> {
  let validate: ((value: unknown) => boolean) | undefined;
  if (input.outputSchema !== undefined) {
    try { validate = new Ajv2020({ strict: true }).compile(z.json().parse(input.outputSchema) as object); }
    catch { throw new Error('OpenCode V2 cannot validate the requested JSON schema'); }
  }
  const session = `/api/session/${encodeURIComponent(input.nativeId)}`;
  verifyOpenCodeV2Session(await server.request('GET', session), input.spec, input.nativeId);
  const prompt = validate ? `${input.prompt}\n\nReturn only one JSON document matching this JSON Schema. Do not use Markdown fences.\n${JSON.stringify(input.outputSchema)}` : input.prompt;
  const receipt = admitted.parse(await server.request('POST', `${session}/prompt`, { text: prompt }));
  if (receipt.data.sessionID !== input.nativeId) throw new Error('OpenCode V2 prompt receipt session mismatch');
  await server.request('POST', `/api/experimental/session/${encodeURIComponent(input.nativeId)}/wait`, {}, 24 * 60 * 60 * 1000);
  const finalSession = await server.request('GET', session);
  verifyOpenCodeV2Session(finalSession, input.spec, input.nativeId);
  const outcome = z.object({ data: z.object({ outcome: z.string().optional() }) }).parse(finalSession).data.outcome;
  const response = await readTimeline(server, session);
  const result = openCodeV2Result({ response, outcome, userMessageId: receipt.data.id, sessionId: input.spec.logicalId,
    turnId: input.turnId, provider: input.spec.provider, model: input.spec.model, ...(input.spec.variant ? { variant: input.spec.variant } : {}) });
  if (validate && result.status === 'completed') {
    try {
      const value = parseStructuredOutput(result.messages.join('\n'));
      if (validate(value)) return { ...result, messages: [JSON.stringify(value)] };
    } catch { /* Invalid JSON is a failed turn, not a successful partial result. */ }
    return { threadId: input.spec.logicalId, turnId: input.turnId, status: 'failed', messages: [], error: 'OpenCode V2 output did not match the requested JSON schema' };
  }
  return result;
}
