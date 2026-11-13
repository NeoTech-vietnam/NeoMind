import { z } from 'zod';
import type { TurnResult } from '../adapters/codex-turn-events.js';

const messagesSchema = z.object({ data: z.array(z.object({ id: z.string(), type: z.string(), agent: z.string().optional(),
  model: z.object({ id: z.string(), providerID: z.string(), variant: z.string().optional() }).optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  finish: z.string().optional(), error: z.unknown().optional() })), cursor: z.object({ next: z.string().nullish() }) });

/** Accept only a terminal successful assistant message after the exact dispatched user message. */
export function openCodeV2Result(input: { response: unknown; outcome: unknown; userMessageId: string; sessionId: string; turnId: string;
  provider: string; model: string; variant?: string }): TurnResult {
  const failed = (error: string): TurnResult => ({ threadId: input.sessionId, turnId: input.turnId, status: 'failed', messages: [], error });
  if (input.outcome !== 'succeeded') return failed('OpenCode V2 execution did not succeed');
  const result = messagesSchema.parse(input.response);
  // A truncated timeline cannot establish which output belongs to this dispatch.
  if (result.cursor.next) return failed('OpenCode V2 message timeline is incomplete');
  const index = result.data.findIndex(item => item.id === input.userMessageId && item.type === 'user');
  if (index < 0) return failed('OpenCode V2 prompt message not found');
  const later = result.data.slice(index + 1);
  if (later.some(item => item.type === 'user')) return failed('OpenCode V2 session received another prompt');
  const reply = later.filter(item => item.type === 'assistant').at(-1);
  if (!reply || reply.error || reply.finish !== 'stop' || reply.agent !== 'build' || reply.model?.id !== input.model
    || reply.model.providerID !== input.provider || reply.model.variant !== input.variant) return failed('OpenCode V2 assistant result is not verified');
  const messages = (reply.content ?? []).filter(part => part.type === 'text' && part.text?.trim()).map(part => part.text!);
  if (!messages.length) return failed('OpenCode V2 returned no output');
  return { threadId: input.sessionId, turnId: input.turnId, status: 'completed', messages };
}
