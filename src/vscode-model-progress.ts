import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostPrivateDirectory, secureHostPrivateDirectory } from './vscode-wire.js';

type Phase = 'prepared' | 'preflight' | 'awaiting-sdk-handle' | 'response-stream' | 'executing-tools' |
  'round-completed' | 'completed' | 'error' | 'cancelled';
export type ModelCallTerminalReason = 'owner-cancel' | 'host-close' | 'owner-or-trust-lost' | 'deadline-exceeded' | 'model-or-host-error' | 'loop-stopped';
type PartKind = 'text' | 'data' | 'tool-call' | 'other';
interface Counts { parts: number; text_parts: number; text_bytes: number; data_parts: number; data_bytes: number; tool_calls: number; tool_results: number }
const counts = (): Counts => ({ parts: 0, text_parts: 0, text_bytes: 0, data_parts: 0, data_bytes: 0, tool_calls: 0, tool_results: 0 });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const alias = (value: string): string | null => /^[-\w./+]{1,128}$/.test(value) ? value : null;
const terminal = (phase: Phase) => ['completed', 'error', 'cancelled'].includes(phase);
const interval = 5000;

/** Best-effort private timing diagnostics. Never used for receipt authenticity, workflow completion, or acceptance. */
export class ModelCallProgress {
  private readonly path: string;
  private timer?: NodeJS.Timeout;
  private written = 0;
  private dirty = false;
  private disabled = false;
  private value: {
    schema_version: number; trust: 'diagnostic-only'; invocation_id: string; model_id: string | null; vendor: string | null;
    phase: Phase; round: number; started_at: string; updated_at: string; round_started_at: string | null;
    request_started_at: string | null; sdk_handle_received_at: string | null; first_stream_chunk_at: string | null;
    last_stream_chunk_at: string | null; tool_execution_started_at: string | null; round_ended_at: string | null;
    ended_at: string | null; terminal_reason: ModelCallTerminalReason | null; failure_phase: Phase | null;
    round_counts: Counts; totals: Counts; tool_calls_pending: number;
  };
  constructor(root: string, invocation: string, model: string, vendor: string) {
    if (!uuid.test(invocation)) throw new Error('Invalid diagnostic invocation.');
    const directory = join(hostPrivateDirectory(root), 'progress');
    this.path = join(directory, `${invocation}.json`);
    const at = new Date().toISOString();
    this.value = { schema_version: 1, trust: 'diagnostic-only', invocation_id: invocation, model_id: alias(model), vendor: alias(vendor),
      phase: 'prepared', round: 0, started_at: at, updated_at: at, round_started_at: null, request_started_at: null,
      sdk_handle_received_at: null, first_stream_chunk_at: null, last_stream_chunk_at: null, tool_execution_started_at: null,
      round_ended_at: null, ended_at: null, terminal_reason: null, failure_phase: null, round_counts: counts(), totals: counts(), tool_calls_pending: 0 };
    try {
      this.privateDirectory(hostPrivateDirectory(root));
      // A preexisting child may have explicit foreign Windows grants even when
      // its parent is private. Reuse the descriptor's actual ACL verifier.
      secureHostPrivateDirectory(directory);
      for (const name of readdirSync(directory)) {
        const parts = name.split('.json.');
        if (parts.length !== 2 || !uuid.test(parts[0]!) || !parts[1]!.endsWith('.tmp') || !uuid.test(parts[1]!.slice(0, -4))) continue;
        const path = join(directory, name), stat = lstatSync(path);
        // Only this writer's exact bounded temporary-file format is owned.
        // Never follow links or remove arbitrary files found in the directory.
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 8192 &&
          (process.platform === 'win32' || stat.uid === process.getuid!() && !(stat.mode & 0o077))) rmSync(path);
      }
      const old = readdirSync(directory).filter(name => uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
        .map(name => ({ name, stat: lstatSync(join(directory, name)) })).filter(item => item.stat.isFile() && !item.stat.isSymbolicLink())
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      // A host admits at most 256 turns; keep that same bounded diagnostic window across normal reloads.
      for (const item of old.slice(255)) if (item.name !== `${invocation}.json`) rmSync(join(directory, item.name));
      this.flush(true);
    } catch { this.disabled = true; }
  }
  private privateDirectory(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
      (stat.uid !== process.getuid!() || (stat.mode & 0o077)))) throw new Error('Diagnostic directory is not private.');
  }
  private flush(force = false): void {
    if (this.disabled || (!this.dirty && !force)) return;
    const remaining = interval - (Date.now() - this.written);
    if (!force && remaining > 0) {
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, remaining); this.timer.unref(); }
      return;
    }
    clearTimeout(this.timer); this.timer = undefined;
    let temporary: string | undefined;
    try {
      this.privateDirectory(join(this.path, '..'));
      if (existsSync(this.path)) { const stat = lstatSync(this.path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(); }
      const text = JSON.stringify(this.value) + '\n';
      if (Buffer.byteLength(text) > 8192) throw new Error();
      temporary = `${this.path}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path); temporary = undefined;
      this.written = Date.now(); this.dirty = false;
    } catch { this.disabled = true; }
    finally { if (temporary) try { rmSync(temporary); } catch { /* Diagnostic failure cannot affect a model request. */ } }
  }
  private update(phase: Phase): boolean {
    if (terminal(this.value.phase)) return false;
    this.value.phase = phase; this.value.updated_at = new Date().toISOString(); this.dirty = true; return true;
  }
  beginRound(round: number): void {
    if (!this.update('preflight')) return;
    this.value.round = round; this.value.round_started_at = this.value.updated_at;
    this.value.request_started_at = null; this.value.sdk_handle_received_at = null;
    this.value.first_stream_chunk_at = null; this.value.last_stream_chunk_at = null;
    this.value.tool_execution_started_at = null; this.value.round_ended_at = null;
    this.value.round_counts = counts(); this.value.tool_calls_pending = 0; this.flush(true);
  }
  request(): void { if (this.update('awaiting-sdk-handle')) { this.value.request_started_at = this.value.updated_at; this.flush(true); } }
  handleReceived(): void { if (this.update('response-stream')) { this.value.sdk_handle_received_at = this.value.updated_at; this.flush(true); } }
  part(kind: PartKind, bytes = 0): void {
    if (terminal(this.value.phase)) return;
    const first = this.value.first_stream_chunk_at === null;
    this.value.updated_at = this.value.last_stream_chunk_at = new Date().toISOString();
    if (first) this.value.first_stream_chunk_at = this.value.last_stream_chunk_at;
    for (const count of [this.value.round_counts, this.value.totals]) {
      count.parts++;
      if (kind === 'text') { count.text_parts++; count.text_bytes += bytes; }
      else if (kind === 'data') { count.data_parts++; count.data_bytes += bytes; }
      else if (kind === 'tool-call') count.tool_calls++;
    }
    this.value.tool_calls_pending = this.value.round_counts.tool_calls - this.value.round_counts.tool_results;
    this.dirty = true; this.flush(first);
  }
  executingTools(): void { if (this.update('executing-tools')) { this.value.tool_execution_started_at = this.value.updated_at; this.flush(true); } }
  toolResult(): void {
    if (terminal(this.value.phase)) return;
    this.value.round_counts.tool_results++; this.value.totals.tool_results++;
    this.value.tool_calls_pending = this.value.round_counts.tool_calls - this.value.round_counts.tool_results;
    this.value.updated_at = new Date().toISOString(); this.dirty = true; this.flush();
  }
  endRound(): void { if (this.update('round-completed')) { this.value.round_ended_at = this.value.updated_at; this.flush(true); } }
  finish(phase: 'completed' | 'error' | 'cancelled', reason: ModelCallTerminalReason | null = null): void {
    const previous = this.value.phase;
    if (!this.update(phase)) return;
    this.value.ended_at = this.value.updated_at; this.value.terminal_reason = reason;
    this.value.failure_phase = phase === 'completed' ? null : previous;
    this.flush(true); clearTimeout(this.timer); this.timer = undefined;
  }
}
