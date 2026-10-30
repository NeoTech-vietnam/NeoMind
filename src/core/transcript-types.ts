import type { TokenUsage } from './usage.js';

/**
 * Runner-neutral record of what an agent did in one attempt: what it said, read, searched, edited and ran. Written by
 * NeoMind while the turn runs (from the runner's own event stream) and read by the editor for the live activity feed
 * and the session viewer. It is an observation log, never input to a decision: the journal stays authoritative.
 */
export type TranscriptKind =
  | 'meta' | 'turn' | 'prompt' | 'message' | 'reasoning' | 'read' | 'search' | 'edit' | 'command' | 'output' | 'tool' | 'result'
  | 'structured_output' | 'usage' | 'gap' | 'end';

export interface TranscriptMeta {
  attemptId: string; nodeId: string; key: string; role: 'plan' | 'read' | 'write' | 'review';
  runner: string; model: string; sessionId: string; workspace: string; reviewerId?: string;
}

export interface TranscriptEvent {
  kind: TranscriptKind;
  /** Sequence number in the file, from 0; assigned by the writer. */
  i?: number;
  /** Milliseconds since the epoch; assigned by the writer. */
  t?: number;
  /** Runner item or tool-use id; `result` and `output` events refer to the event with the same id. */
  id?: string;
  text?: string; path?: string; name?: string; command?: string; action?: string;
  added?: number; removed?: number; diff?: string; change?: string;
  exitCode?: number | null; status?: string; durationMs?: number; error?: boolean;
  /** Lines or characters were dropped to stay within the limits. */
  truncated?: boolean;
  usage?: TokenUsage; turnId?: string; meta?: TranscriptMeta;
}

export interface TranscriptSummary {
  meta: TranscriptMeta; startedAt?: number; endedAt?: number; status?: string; events: number;
  reads: number; edits: number; commands: number; files: string[]; added: number; removed: number; usage?: TokenUsage;
  /** Latest activity, for the collapsed one-line view. */
  last?: TranscriptEvent;
}

