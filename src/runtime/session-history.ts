import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { claudeConfigDir } from '../adapters/claude-policy.js';
import { startWorkerScope, type WorkerScope } from '../adapters/worker-scope.js';
import { claudeTranscriptEvents, clipEvent, codexItemEvents, relativePath, type TranscriptEvent } from '../core/transcript.js';

/**
 * Reads an attempt's turn back from the runner's own session history, for runs recorded before NeoMind kept transcripts
 * and to compare with NeoMind's record. Read only: nothing here resumes or changes a session.
 */
export interface HistoryRequest { sessionId: string; workspace?: string; runnerTurnId?: string; prompt?: string; turnIndex?: number }
export interface HistoryResult { runner: 'codex' | 'claude-code'; events: TranscriptEvent[]; note?: string }

/** The stored Claude Code session file, wherever its cwd was (session ids are unique across projects). */
export function claudeSessionFile(sessionId: string, configDir = claudeConfigDir()): string | undefined {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return undefined;
  const projects = path.join(configDir, 'projects');
  let dirs: string[];
  try { dirs = readdirSync(projects); } catch { return undefined; }
  for (const dir of dirs) { const file = path.join(projects, dir, `${sessionId}.jsonl`); if (existsSync(file)) return file; }
  return undefined;
}

/**
 * One turn of a stored Claude Code session. A turn starts at a user prompt; the attempt's turn is the one whose prompt
 * matches NeoMind's, or else the `turnIndex`-th turn of the session (attempts of a session group in journal order).
 */
export function claudeHistoryEvents(file: string, request: HistoryRequest): HistoryResult {
  const turns: TranscriptEvent[][] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (record.isSidechain || record.isMeta || (record.type !== 'user' && record.type !== 'assistant')) continue;
    const t = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    for (const event of claudeTranscriptEvents(record)) {
      if (event.kind === 'prompt' || !turns.length) turns.push([]);
      turns.at(-1)!.push({ ...event, ...(Number.isFinite(t) ? { t } : {}) });
    }
  }
  const prompt = request.prompt?.trim();
  let index = prompt ? turns.findIndex(turn => turn[0]?.kind === 'prompt' && turn[0].text?.trim() === prompt) : -1;
  let note: string | undefined;
  if (index < 0 && request.turnIndex !== undefined && request.turnIndex < turns.length) { index = request.turnIndex; if (prompt) note = 'Không khớp được prompt; đang hiện lượt theo thứ tự trong session'; }
  if (index < 0) return { runner: 'claude-code', events: [], note: !prompt && request.turnIndex === undefined ? 'Bước này chưa bắt đầu lượt nào trong session (bị dừng trước khi gửi cho agent)'
    : `Session gốc có ${turns.length} lượt nhưng không tìm thấy lượt của bước này` };
  return { runner: 'claude-code', events: number(turns[index]!.map(event => clip(event, request.workspace))), ...(note ? { note } : {}) };
}

function clip(event: TranscriptEvent, workspace?: string): TranscriptEvent {
  const out = clipEvent(event);
  if (out.path && workspace) out.path = relativePath(out.path, workspace);
  return out;
}
const number = (events: TranscriptEvent[]) => events.map((event, i) => ({ ...event, i }));

const itemsPage = z.object({ data: z.array(z.object({ item: z.unknown(), turnId: z.string(), startedAtMs: z.number().nullish() })), nextCursor: z.string().nullish() });

/** The items of one Codex turn through the app-server API, read by a short-lived worker. */
export async function codexHistoryEvents(request: HistoryRequest, start: () => Promise<WorkerScope> = () => startWorkerScope(() => {}, () => {})): Promise<HistoryResult> {
  if (!request.runnerTurnId) return { runner: 'codex', events: [], note: 'Bước này chưa có turn Codex (có thể bị dừng trước khi bắt đầu)' };
  const scope = await start();
  try {
    const events: TranscriptEvent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const response = itemsPage.parse(await scope.transport.request('thread/items/list', { threadId: request.sessionId, turnId: request.runnerTurnId, limit: 100, ...(cursor ? { cursor } : {}) }));
      for (const entry of response.data) {
        if (entry.turnId !== request.runnerTurnId) continue;
        for (const event of codexItemEvents(entry.item, 'completed')) events.push({ ...clip(event, request.workspace), ...(entry.startedAtMs ? { t: entry.startedAtMs } : {}) });
      }
      cursor = response.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return { runner: 'codex', events: number(events) };
  } finally { await scope.stop(); }
}

/**
 * Position of an attempt's turn among the turns of its runner session: attempts of the same session in journal order,
 * counting only those that started a runner turn (one stopped before dispatch left nothing in the session).
 */
export function sessionTurnIndex(attempts: { attemptId: string; sessionId: string; runnerTurnId?: string; core?: true }[], attemptId: string): number | undefined {
  const attempt = attempts.find(item => item.attemptId === attemptId);
  if (!attempt?.runnerTurnId) return undefined;
  return attempts.filter(item => item.sessionId === attempt.sessionId && !item.core && item.runnerTurnId).findIndex(item => item.attemptId === attemptId);
}

/** Claude when its session file exists, otherwise Codex. */
export async function runnerHistory(request: HistoryRequest, runner?: string, configDir = claudeConfigDir()): Promise<HistoryResult> {
  const file = runner === 'codex' ? undefined : claudeSessionFile(request.sessionId, configDir);
  if (file) return claudeHistoryEvents(file, request);
  if (runner === 'claude-code') return { runner: 'claude-code', events: [], note: 'Claude Code không còn giữ session này (có thể đã bị dọn theo cleanupPeriodDays)' };
  return codexHistoryEvents(request);
}
