import { z } from 'zod';
import { tokenUsageSchema, type TokenUsage } from '../core/usage.js';

const item = z.object({ threadId: z.string().min(1), turnId: z.string().min(1),
  item: z.object({ type: z.string(), id: z.string().min(1), text: z.string().optional() }) });
const started = z.object({ threadId: z.string().min(1), turnId: z.string().min(1), item: z.object({ type: z.string(), id: z.string().min(1) }) });
const completed = z.object({ threadId: z.string().min(1), turn: z.object({ id: z.string().min(1),
  status: z.enum(['completed', 'failed', 'interrupted']), error: z.object({ message: z.string() }).nullish() }) });
export interface TurnResult { threadId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted'; messages: string[]; error?: string; usage?: TokenUsage }

/** Correlates terminal events and completed agent messages, including events received before binding. */
export class CodexTurnEvents {
  private readonly turns = new Map<string, { messages: Map<string, string>; commands: Set<string>; status?: TurnResult['status']; bytes: number; error?: string; usage?: TokenUsage }>();
  private key(threadId: string, turnId: string) { return JSON.stringify([threadId, turnId]); }
  accept(method: string, payload: unknown): void {
    if (method === 'thread/tokenUsage/updated') {
      const parsed = z.object({ threadId: z.string(), turnId: z.string(), tokenUsage: z.object({ total: tokenUsageSchema }) }).safeParse(payload);
      if (!parsed.success) return;
      const value = parsed.data, key = this.key(value.threadId, value.turnId);
      const state = this.turns.get(key) ?? { messages: new Map<string, string>(), commands: new Set<string>(), bytes: 0 };
      if (this.turns.size >= 1000 && !this.turns.has(key)) throw new Error('Turn event buffer limit exceeded');
      state.usage = value.tokenUsage.total; this.turns.set(key, state);
    } else if (method === 'item/started') {
      const parsed = started.safeParse(payload);
      if (!parsed.success || parsed.data.item.type !== 'commandExecution') return;
      const value = parsed.data, key = this.key(value.threadId, value.turnId);
      const state = this.turns.get(key) ?? { messages: new Map<string, string>(), commands: new Set<string>(), bytes: 0 };
      if (state.commands.has(value.item.id)) throw new Error('Duplicate command start');
      if (this.turns.size >= 1000 && !this.turns.has(key)) throw new Error('Turn event buffer limit exceeded');
      state.commands.add(value.item.id); this.turns.set(key, state);
    } else if (method === 'item/completed') {
      const parsed = item.safeParse(payload);
      if (!parsed.success) return;
      if (parsed.data.item.type === 'commandExecution') {
        const value = parsed.data, key = this.key(value.threadId, value.turnId), state = this.turns.get(key);
        if (!state || !state.commands.delete(value.item.id)) throw new Error('Command completion without observed start');
        return;
      }
      if (parsed.data.item.type !== 'agentMessage' || parsed.data.item.text === undefined) return;
      const value = parsed.data, text = parsed.data.item.text!, key = this.key(value.threadId, value.turnId);
      const state = this.turns.get(key) ?? { messages: new Map<string, string>(), commands: new Set<string>(), bytes: 0 };
      if (state.status || state.messages.has(value.item.id)) throw new Error('Unexpected or duplicate completed message');
      state.bytes += Buffer.byteLength(text, 'utf8');
      if (state.bytes > 1024 * 1024 || this.turns.size >= 1000 && !this.turns.has(key)) throw new Error('Turn event buffer limit exceeded');
      state.messages.set(value.item.id, text); this.turns.set(key, state);
    } else if (method === 'turn/completed') {
      const value = completed.parse(payload), key = this.key(value.threadId, value.turn.id);
      const state = this.turns.get(key) ?? { messages: new Map<string, string>(), commands: new Set<string>(), bytes: 0 };
      if (state.status) throw new Error('Duplicate terminal turn event');
      if (this.turns.size >= 1000 && !this.turns.has(key)) throw new Error('Turn event buffer limit exceeded');
      state.status = value.turn.status; this.turns.set(key, state);
      if (value.turn.error) state.error = value.turn.error.message.slice(0, 2000);
    }
  }
  result(threadId: string, turnId: string): TurnResult | undefined {
    const state = this.turns.get(this.key(threadId, turnId));
    if (!state?.status) return undefined;
    return { threadId, turnId, status: state.status, messages: [...state.messages.values()], ...(state.error ? { error: state.error } : {}), ...(state.usage ? { usage: state.usage } : {}) };
  }
  /** Settled command events are not proof that descendant processes have exited. */
  pendingCommands(threadId: string, turnId: string): number { return this.turns.get(this.key(threadId, turnId))?.commands.size ?? 0; }
  forget(threadId: string, turnId: string): void { this.turns.delete(this.key(threadId, turnId)); }
}
