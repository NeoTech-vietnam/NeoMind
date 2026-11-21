/** Display helpers. Color is only ever one of the five states (running, attention, danger, success, idle). */
import type { Status } from '@/components/ui/badge';
import type { RunStatus, StepState } from './types';

const runStatuses: Record<string, { label: string; status: Status }> = {
  running: { label: 'Đang chạy', status: 'running' }, waiting: { label: 'Chờ duyệt', status: 'attention' },
  done: { label: 'Xong', status: 'success' }, failed: { label: 'Lỗi', status: 'danger' },
  rejected: { label: 'Bị từ chối', status: 'idle' }, stopped: { label: 'Dừng giữa chừng', status: 'attention' },
  cancelled: { label: 'Đã dừng', status: 'idle' },
};
export const runStatusInfo = (status: RunStatus | undefined) => runStatuses[status ?? ''] ?? { label: status || '?', status: 'idle' as Status };

const stepStates: Record<StepState, { label: string; status: Status }> = {
  done: { label: 'Xong', status: 'success' }, running: { label: 'Đang chạy', status: 'running' }, waiting: { label: 'Chờ duyệt', status: 'attention' },
  failed: { label: 'Lỗi', status: 'danger' }, rejected: { label: 'Bị từ chối', status: 'idle' }, todo: { label: 'Chưa chạy', status: 'idle' },
  cancelled: { label: 'Bị dừng', status: 'idle' },
};
export const stepStateInfo = (state: StepState | undefined) => stepStates[state ?? 'todo'] ?? stepStates.todo;

export const KIND_LABEL: Record<string, string> = {
  ai: 'AI', script: 'script', write: 'ghi file', gate: 'gate (người duyệt)', route: 'route', loop: 'kiểm tra vòng lặp',
  fanout: 'fan-out', worker: 'AI worker × N', parallel: 'song song', join: 'gộp', start: 'bắt đầu', end: 'kết thúc',
};
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

/** langflow writes local times as "YYYY-MM-DD HH:MM:SS". */
export function parseTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return new Date(value.includes('T') ? value : value.replace(' ', 'T')).getTime();
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} phút ${seconds % 60} giây` : `${minutes} phút`;
  return `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}

/** "12 phút trước", "hôm qua", "3 ngày trước"; older than two weeks falls back to the date. */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  const then = parseTime(value);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'hôm qua';
  return days < 14 ? `${days} ngày trước` : new Date(then).toLocaleDateString('vi-VN');
}

/** "HH:MM:SS" of a langflow time when it is today, else the full value. */
export function shortTime(value: string | null | undefined): string {
  if (!value) return '';
  const today = new Date().toLocaleDateString('en-CA');
  return value.startsWith(today) ? value.slice(11) : value;
}

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** "$0.42", "$0.003", "<$0.0001"; empty when unknown. */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '';
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`;
}
/** 950, 12.3k, 1.25M; empty when unknown. */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || Number.isNaN(count)) return '';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}
/** Every token an ai step used: input + cache read/write + output. */
export function totalTokens(usage: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number } | null | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
}
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export const formatPercent = (value: number | null | undefined) => value === null || value === undefined || Number.isNaN(value) ? '—' : `${Math.round(value * 100)}%`;
