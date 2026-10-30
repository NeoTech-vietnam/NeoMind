import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TokenUsage } from './usage.js';
import type { TranscriptEvent, TranscriptMeta, TranscriptSummary } from './transcript-types.js';

export type { TranscriptEvent, TranscriptKind, TranscriptMeta, TranscriptSummary } from './transcript-types.js';

/** Size limits per event (decision: 200 output lines, 60 lines per file read, reasoning summaries only). */
export const TRANSCRIPT_LIMITS = { outputLines: 200, readLines: 60, diffLines: 400, textChars: 20000, promptChars: 40000, fileBytes: 8 * 1024 * 1024 };

/** First `max` lines. */
export function headLines(text: string, max: number): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  return lines.length <= max ? { text, truncated: false } : { text: lines.slice(0, max).join('\n'), truncated: true };
}
/** Last `max` lines (command output: the end holds the verdict and the errors). */
export function tailLines(text: string, max: number): { text: string; truncated: boolean } {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.length <= max ? { text, truncated: false } : { text: lines.slice(-max).join('\n'), truncated: true };
}
function clipChars(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}
/** `+`/`-` lines of a unified diff, excluding the file headers. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++; else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}
const lineCount = (text: string) => text ? text.replace(/\n$/, '').split('\n').length : 0;

/** Apply the limits to one event; every writer and every history reader goes through this. */
export function clipEvent(event: TranscriptEvent): TranscriptEvent {
  const out = { ...event };
  let truncated = !!event.truncated;
  if (out.text !== undefined) {
    const max = out.kind === 'prompt' ? TRANSCRIPT_LIMITS.promptChars : TRANSCRIPT_LIMITS.textChars;
    const lines = out.kind === 'command' || out.kind === 'output' ? tailLines(out.text, TRANSCRIPT_LIMITS.outputLines)
      : out.kind === 'result' ? headLines(out.text, TRANSCRIPT_LIMITS.readLines) : { text: out.text, truncated: false };
    const chars = clipChars(lines.text, max);
    out.text = chars.text; truncated ||= lines.truncated || chars.truncated;
  }
  if (out.diff !== undefined) {
    const lines = headLines(out.diff, TRANSCRIPT_LIMITS.diffLines), chars = clipChars(lines.text, TRANSCRIPT_LIMITS.textChars);
    out.diff = chars.text; truncated ||= lines.truncated || chars.truncated;
  }
  if (truncated) out.truncated = true;
  return out;
}

/** Workspace-relative, forward-slash path when `file` lies inside `workspace`; otherwise unchanged. */
export function relativePath(file: string, workspace: string): string {
  if (!path.isAbsolute(file)) return file.replace(/\\/g, '/');
  const relative = path.relative(workspace, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replace(/\\/g, '/') : file;
}

/**
 * Appends one attempt's transcript to `<runDir>/transcripts/<attemptId>.jsonl`. Writing never fails the run: an I/O
 * error or the size limit ends the transcript with a `gap` event (best effort) and later events are dropped.
 */
export class TranscriptWriter {
  private seq = 0;
  private bytes = 0;
  private stopped = false;
  private constructor(readonly file: string, readonly meta: TranscriptMeta) {}
  static open(directory: string, meta: TranscriptMeta): TranscriptWriter {
    const writer = new TranscriptWriter(path.join(directory, `${meta.attemptId}.jsonl`), meta);
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { writer.stopped = true; }
    writer.write({ kind: 'meta', meta });
    return writer;
  }
  write(event: TranscriptEvent): void {
    if (this.stopped) return;
    const clipped = clipEvent(event);
    if (clipped.path) clipped.path = relativePath(clipped.path, this.meta.workspace);
    const line = `${JSON.stringify({ ...clipped, i: this.seq, t: Date.now() })}\n`;
    const terminal = event.kind === 'end' || event.kind === 'usage';
    if (this.bytes + line.length > TRANSCRIPT_LIMITS.fileBytes && !terminal) {
      this.append(`${JSON.stringify({ kind: 'gap', text: 'Transcript đạt giới hạn kích thước; phần sau không được ghi', i: this.seq, t: Date.now() })}\n`);
      this.stopped = true; return;
    }
    this.append(line);
  }
  private append(line: string): void {
    try { appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 }); this.seq++; this.bytes += line.length; }
    catch { this.stopped = true; }
  }
  end(status: string, extra: Omit<TranscriptEvent, 'kind'> = {}): void { this.write({ ...extra, kind: 'end', status }); this.stopped = true; }
}

export function transcriptDirectory(runDir: string): string { return path.join(runDir, 'transcripts'); }

function parseLines(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const value = JSON.parse(line) as TranscriptEvent; if (value && typeof value.kind === 'string') events.push(value); } catch { /* a torn last line is skipped */ }
  }
  return events;
}

/** Events with sequence number >= `after`. */
export function readTranscript(directory: string, attemptId: string, after = 0): TranscriptEvent[] | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(attemptId)) throw new Error('Invalid attempt id');
  let text: string;
  try { text = readFileSync(path.join(directory, `${attemptId}.jsonl`), 'utf8'); } catch { return undefined; }
  return parseLines(text).filter(event => (event.i ?? 0) >= after);
}

/** Summary of one transcript for the activity feed's collapsed line and the step summary. */
export function summarizeTranscript(events: TranscriptEvent[]): TranscriptSummary | undefined {
  const meta = events.find(event => event.kind === 'meta')?.meta;
  if (!meta) return undefined;
  const files = new Set<string>(); let reads = 0, edits = 0, commands = 0, added = 0, removed = 0, usage: TokenUsage | undefined, status: string | undefined, endedAt: number | undefined;
  let last: TranscriptEvent | undefined;
  const commandIds = new Set<string>();
  for (const event of events) {
    if (event.kind === 'read' || event.kind === 'command' && event.action === 'read') reads++;
    if (event.kind === 'command' && event.id && !commandIds.has(event.id)) { commandIds.add(event.id); if (event.action !== 'read') commands++; }
    if (event.kind === 'edit') { edits++; if (event.path) files.add(event.path); added += event.added ?? 0; removed += event.removed ?? 0; }
    if (event.kind === 'usage' && event.usage) usage = event.usage;
    if (event.kind === 'end') { status = event.status; endedAt = event.t; if (event.usage) usage = event.usage; }
    if (!['meta', 'turn', 'prompt', 'usage', 'end', 'output', 'result'].includes(event.kind)) last = event;
  }
  return { meta, ...(events[0]?.t ? { startedAt: events[0].t } : {}), ...(endedAt ? { endedAt } : {}), ...(status ? { status } : {}), events: events.length,
    reads, edits, commands, files: [...files], added, removed, ...(usage ? { usage } : {}), ...(last ? { last } : {}) };
}

/** Summaries of every transcript of a run, oldest first. */
export function listTranscripts(directory: string): TranscriptSummary[] {
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.endsWith('.jsonl')); } catch { return []; }
  const summaries: TranscriptSummary[] = [];
  for (const name of names) {
    const events = readTranscript(directory, name.slice(0, -'.jsonl'.length));
    const summary = events && summarizeTranscript(events);
    if (summary) summaries.push(summary);
  }
  return summaries.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

// ---------------------------------------------------------------- Claude Code

const textOf = (value: unknown): string => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('') : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/** Lines removed and added by an Edit tool call, as a small unified diff. */
function editDiff(oldText: string, newText: string): string {
  return [...oldText.split('\n').map(line => `-${line}`), ...newText.split('\n').map(line => `+${line}`)].join('\n');
}

/**
 * Transcript events for one Claude Code record: a `stream-json` event of a live turn, or a `user`/`assistant` entry of a
 * stored session file. Unknown record types and content parts are ignored (the session format is internal).
 */
export function claudeTranscriptEvents(input: unknown): TranscriptEvent[] {
  const value = record(input), type = value.type, events: TranscriptEvent[] = [];
  const message = record(value.message), content = message.content;
  if (type === 'assistant' && Array.isArray(content)) {
    for (const part of content.map(record)) {
      if (part.type === 'text' && str(part.text)?.trim()) events.push({ kind: 'message', text: part.text as string });
      else if (part.type === 'thinking' && str(part.thinking)?.trim()) events.push({ kind: 'reasoning', text: headLines(part.thinking as string, 20).text });
      else if (part.type === 'tool_use') {
        const id = str(part.id), name = str(part.name) ?? 'tool', args = record(part.input), base = { ...(id ? { id } : {}), name };
        if (name === 'Read') events.push({ ...base, kind: 'read', path: str(args.file_path) ?? '', ...(typeof args.offset === 'number' ? { text: `từ dòng ${args.offset}` } : {}) });
        else if (name === 'Glob' || name === 'Grep') events.push({ ...base, kind: 'search', text: str(args.pattern) ?? '', ...(str(args.path) ? { path: args.path as string } : {}) });
        else if (name === 'Edit') {
          const oldText = str(args.old_string) ?? '', newText = str(args.new_string) ?? '';
          events.push({ ...base, kind: 'edit', path: str(args.file_path) ?? '', change: 'update', added: lineCount(newText), removed: lineCount(oldText), diff: editDiff(oldText, newText) });
        } else if (name === 'MultiEdit' && Array.isArray(args.edits)) {
          const edits = args.edits.map(record), oldText = edits.map(edit => str(edit.old_string) ?? '').join('\n'), newText = edits.map(edit => str(edit.new_string) ?? '').join('\n');
          events.push({ ...base, kind: 'edit', path: str(args.file_path) ?? '', change: 'update', added: lineCount(newText), removed: lineCount(oldText), diff: editDiff(oldText, newText) });
        } else if (name === 'Write') {
          const text = str(args.content) ?? '';
          events.push({ ...base, kind: 'edit', path: str(args.file_path) ?? '', change: 'write', added: lineCount(text), removed: 0, diff: text.split('\n').map(line => `+${line}`).join('\n') });
        } else if (name === 'StructuredOutput') events.push({ ...base, kind: 'structured_output', text: JSON.stringify(args, null, 2) });
        else if (name === 'Bash') events.push({ ...base, kind: 'command', command: str(args.command) ?? '', status: 'running' });
        else events.push({ ...base, kind: 'tool', text: JSON.stringify(args) });
      }
    }
  } else if (type === 'user') {
    if (typeof content === 'string' || Array.isArray(content) && content.every(part => record(part).type === 'text')) {
      // Only a stored session holds the user's prompt this way; a live turn's prompt is written by NeoMind itself.
      const text = textOf(content);
      if (text.trim()) events.push({ kind: 'prompt', text });
    } else if (Array.isArray(content)) {
      for (const part of content.map(record)) {
        if (part.type !== 'tool_result') continue;
        const id = str(part.tool_use_id);
        events.push({ kind: 'result', ...(id ? { id } : {}), text: textOf(part.content), ...(part.is_error ? { error: true } : {}) });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------- Codex

/** The script inside a shell wrapper Codex adds (`"…powershell.exe" -Command '…'`, `bash -lc '…'`), for display. */
export function shellCommand(command: string): string {
  const match = /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(['"])([\s\S]*)\1$/i.exec(command)
    ?? /^"?(?:\/[^"\s]*\/)?(?:ba|z)?sh"?\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command);
  return match ? match[1] === "'" ? match[2]!.replace(/''/g, "'") : match[2]! : command;
}

/** Transcript events for one Codex thread item (`item/started`, `item/completed`, or `thread/items/list`). */
export function codexItemEvents(input: unknown, phase: 'started' | 'completed'): TranscriptEvent[] {
  const item = record(input), id = str(item.id), base = id ? { id } : {};
  switch (item.type) {
    case 'userMessage': return phase === 'completed' ? [{ kind: 'prompt', text: textOf(item.content) }] : [];
    case 'agentMessage': return phase === 'completed' && str(item.text)?.trim() ? [{ ...base, kind: 'message', text: item.text as string }] : [];
    case 'plan': return phase === 'completed' && str(item.text)?.trim() ? [{ ...base, kind: 'message', name: 'plan', text: item.text as string }] : [];
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n') : '';
      return phase === 'completed' && summary.trim() ? [{ ...base, kind: 'reasoning', text: summary }] : [];
    }
    case 'commandExecution': {
      const actions = Array.isArray(item.commandActions) ? item.commandActions.map(record) : [];
      const action = actions.length && actions.every(entry => entry.type === actions[0]!.type) ? str(actions[0]!.type) : undefined;
      const target = action === 'read' ? str(actions[0]!.path) : action === 'search' ? str(actions[0]!.query) ?? undefined : undefined;
      const event: TranscriptEvent = { ...base, kind: 'command', command: shellCommand(str(item.command) ?? ''), status: phase === 'started' ? 'running' : str(item.status) ?? 'completed',
        ...(action && action !== 'unknown' ? { action } : {}), ...(action === 'read' && target ? { path: target } : {}), ...(action === 'search' && target ? { text: target } : {}) };
      if (phase === 'completed') {
        if (typeof item.exitCode === 'number' || item.exitCode === null) event.exitCode = item.exitCode as number | null;
        if (typeof item.durationMs === 'number') event.durationMs = item.durationMs;
        // The search query sits in `text` only for the started event; the completed one carries the output.
        if (str(item.aggregatedOutput)) event.text = item.aggregatedOutput as string;
      }
      return [event];
    }
    case 'fileChange': {
      if (phase !== 'completed' || !Array.isArray(item.changes)) return [];
      return item.changes.map(record).map((change, index) => {
        const diff = str(change.diff) ?? '', kind = str(record(change.kind).type) ?? 'update';
        return { kind: 'edit' as const, ...(id ? { id: `${id}:${index}` } : {}), path: str(change.path) ?? '', change: kind, ...diffStats(diff), diff, ...(str(item.status) ? { status: item.status as string } : {}) };
      });
    }
    case 'contextCompaction': return phase === 'completed' ? [{ ...base, kind: 'tool', name: 'contextCompaction', text: 'Codex đã nén ngữ cảnh' }] : [];
    case 'hookPrompt': case undefined: return [];
    default: return phase === 'completed' ? [{ ...base, kind: 'tool', name: String(item.type), text: JSON.stringify(item).slice(0, 2000) }] : [];
  }
}

/**
 * Maps Codex app-server notifications of one thread to transcript events. Command output deltas are forwarded until
 * the item has produced the line limit; the completed item carries the tail of the output in any case.
 */
export class CodexTranscriptMapper {
  private readonly outputLines = new Map<string, number>();
  accept(method: string, payload: unknown): TranscriptEvent[] {
    const value = record(payload);
    if (method === 'item/started' || method === 'item/completed') {
      // NeoMind writes the prompt itself; the echoed user message would repeat it.
      const events = codexItemEvents(value.item, method === 'item/started' ? 'started' : 'completed').filter(event => event.kind !== 'prompt');
      if (method === 'item/completed') { const id = str(record(value.item).id); if (id) this.outputLines.delete(id); }
      return events;
    }
    if (method === 'item/commandExecution/outputDelta') {
      const id = str(value.itemId), delta = str(value.delta);
      if (!id || !delta) return [];
      const seen = this.outputLines.get(id) ?? 0;
      if (seen >= TRANSCRIPT_LIMITS.outputLines) return [];
      this.outputLines.set(id, seen + (delta.match(/\n/g)?.length ?? 0));
      return [{ kind: 'output', id, text: delta }];
    }
    return [];
  }
}
