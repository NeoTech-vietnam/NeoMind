import { z } from 'zod';
import type { TokenUsage } from '../core/usage.js';

/** Effective session configuration reported by Claude Code before the first model call. */
export interface ClaudeInit { sessionId: string; model: string; tools: string[]; mcpServers: unknown[]; permissionMode: string; cwd: string; version?: string }
export interface ClaudePermissionDenial { tool: string; toolUseId?: string }
/** The terminal `result` event of a Claude Code turn. */
export interface ClaudeFinal {
  sessionId: string; subtype: string; isError: boolean; result?: string; structuredOutput?: unknown;
  usage?: TokenUsage; costUsd?: number; permissionDenials: ClaudePermissionDenial[];
}

const nonNegative = z.number().int().nonnegative();
const rawUsage = z.object({ input_tokens: nonNegative.default(0), output_tokens: nonNegative.default(0),
  cache_read_input_tokens: nonNegative.nullish(), cache_creation_input_tokens: nonNegative.nullish(),
  output_tokens_details: z.object({ thinking_tokens: nonNegative.nullish() }).nullish() });
const init = z.object({ type: z.literal('system'), subtype: z.literal('init'), session_id: z.string().min(1), model: z.string().min(1),
  tools: z.array(z.string()), mcp_servers: z.array(z.unknown()), permissionMode: z.string().min(1), cwd: z.string().min(1),
  claude_code_version: z.string().optional() });
const content = z.array(z.object({ type: z.string(), text: z.string().optional(), is_error: z.boolean().optional(), content: z.unknown().optional() }).loose());
const assistant = z.object({ type: z.literal('assistant'), session_id: z.string(), parent_tool_use_id: z.string().nullish(),
  message: z.object({ model: z.string().optional(), content }) });
const user = z.object({ type: z.literal('user'), session_id: z.string(), parent_tool_use_id: z.string().nullish(), message: z.object({ content: z.union([z.string(), content]) }) });
const result = z.object({ type: z.literal('result'), subtype: z.string().min(1), is_error: z.boolean(), session_id: z.string().min(1),
  result: z.string().optional(), structured_output: z.unknown().optional(), usage: rawUsage.optional(), total_cost_usd: z.number().nonnegative().optional(),
  permission_denials: z.array(z.object({ tool_name: z.string(), tool_use_id: z.string().optional() }).loose()).default([]) });

/**
 * Claude reports prompt tokens split by cache state; NeoMind follows the Codex convention where input includes the
 * cached part. `inputTokens` is therefore uncached + cache read + cache write, and `totalTokens` adds the output.
 */
export function claudeUsage(raw: z.infer<typeof rawUsage>): TokenUsage {
  const cachedInputTokens = raw.cache_read_input_tokens ?? 0, cacheWriteInputTokens = raw.cache_creation_input_tokens ?? 0;
  const inputTokens = raw.input_tokens + cachedInputTokens + cacheWriteInputTokens;
  return { inputTokens, outputTokens: raw.output_tokens, cachedInputTokens, cacheWriteInputTokens,
    reasoningOutputTokens: raw.output_tokens_details?.thinking_tokens ?? 0, totalTokens: inputTokens + raw.output_tokens };
}

const textOf = (value: unknown): string => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(part => typeof part === 'object' && part && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : '';

/**
 * Parses `claude -p --output-format stream-json --verbose` output for one turn. Protocol violations throw: events
 * before `system/init`, a second init or result, events after the result, a foreign session id, or any message from
 * a sub-agent (delegation must be impossible, so its traces are a fault rather than noise).
 */
export class ClaudeStream {
  init?: ClaudeInit;
  final?: ClaudeFinal;
  /** Top-level assistant text blocks, in order. */
  readonly messages: string[] = [];
  /** Text of tool results Claude Code marked as errors (permission denials, failed reads). */
  readonly toolErrors: string[] = [];
  /** Models named by top-level assistant messages. */
  readonly models = new Set<string>();
  private bytes = 0;

  accept(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error('Malformed Claude stream event'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Malformed Claude stream event');
    const record = event as Record<string, unknown>, type = record.type;
    if (this.final) throw new Error('Claude stream continued after its result');
    if (type === 'system' && record.subtype === 'init') {
      if (this.init) throw new Error('Duplicate Claude init event');
      const value = init.parse(event);
      this.init = { sessionId: value.session_id, model: value.model, tools: value.tools, mcpServers: value.mcp_servers, permissionMode: value.permissionMode,
        cwd: value.cwd, ...(value.claude_code_version ? { version: value.claude_code_version } : {}) };
      return;
    }
    if (type !== 'assistant' && type !== 'user' && type !== 'result') return;
    if (!this.init) throw new Error(`Claude ${String(type)} event arrived before init`);
    if (record.session_id !== this.init.sessionId) throw new Error('Claude event belongs to another session');
    if (type === 'assistant') {
      const value = assistant.parse(event);
      if (value.parent_tool_use_id) throw new Error('Claude reported a delegated sub-agent message');
      if (value.message.model) this.models.add(value.message.model);
      for (const block of value.message.content) if (block.type === 'text' && block.text) this.keep(this.messages, block.text);
    } else if (type === 'user') {
      const value = user.parse(event);
      if (value.parent_tool_use_id) throw new Error('Claude reported a delegated sub-agent message');
      if (typeof value.message.content === 'string') return;
      for (const block of value.message.content) if (block.type === 'tool_result' && block.is_error) this.keep(this.toolErrors, textOf(block.content).slice(0, 2000));
    } else {
      const value = result.parse(event);
      this.final = { sessionId: value.session_id, subtype: value.subtype, isError: value.is_error,
        ...(value.result !== undefined ? { result: value.result } : {}), ...(value.structured_output !== undefined ? { structuredOutput: value.structured_output } : {}),
        ...(value.usage ? { usage: claudeUsage(value.usage) } : {}), ...(value.total_cost_usd !== undefined ? { costUsd: value.total_cost_usd } : {}),
        permissionDenials: value.permission_denials.map(denial => ({ tool: denial.tool_name, ...(denial.tool_use_id ? { toolUseId: denial.tool_use_id } : {}) })) };
    }
  }
  private keep(target: string[], text: string): void {
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > 1024 * 1024) throw new Error('Turn event buffer limit exceeded');
    target.push(text);
  }
}
