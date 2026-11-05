/** Display helpers shared by the run screens. Color is only ever one of the five states (docs/design/redesign-plan.md §2). */
import type { Status } from '@/components/ui/badge';

const phases: Record<string, { label: string; status: Status }> = {
  running: { label: 'Đang chạy', status: 'running' }, waiting_approval: { label: 'Chờ duyệt kế hoạch', status: 'attention' },
  paused: { label: 'Tạm dừng', status: 'idle' }, blocked: { label: 'Cần xử lý', status: 'attention' }, completed: { label: 'Xong', status: 'success' },
  cancelled: { label: 'Đã hủy', status: 'idle' }, recovering: { label: 'Chờ tiếp tục', status: 'idle' }, stopping: { label: 'Đang dừng', status: 'idle' },
};
export const phaseInfo = (phase: string) => phases[phase] ?? { label: phase, status: 'idle' as Status };

/** Runs that wait for the user come first in the list; the same phases drive the attention count in the shell. */
export const needsYou = (phase: string) => phase === 'waiting_approval' || phase === 'blocked';

const statuses: Record<string, { label: string; status: Status }> = {
  succeeded: { label: 'Xong', status: 'success' }, running: { label: 'Đang chạy', status: 'running' },
  ready: { label: 'Sẵn sàng', status: 'idle' }, pending: { label: 'Chờ', status: 'idle' },
  waiting: { label: 'Chờ bạn', status: 'attention' },
  failed: { label: 'Lỗi', status: 'danger' }, skipped: { label: 'Bỏ qua', status: 'idle' },
};
export const statusInfo = (status: string | undefined) => statuses[status ?? 'pending'] ?? { label: status ?? '', status: 'idle' as Status };

const verdicts: Record<string, { label: string; status: Status }> = {
  pass: { label: 'Đạt', status: 'success' }, needs_changes: { label: 'Cần sửa', status: 'attention' }, blocked: { label: 'Bị chặn', status: 'danger' }, inconclusive: { label: 'Chưa kết luận', status: 'attention' },
  passed: { label: 'Đạt', status: 'success' }, failed: { label: 'Lỗi', status: 'danger' }, unresolved: { label: 'Đang chạy', status: 'running' }, fail: { label: 'Không đạt', status: 'danger' },
};
export const verdictInfo = (verdict: string) => verdicts[verdict] ?? { label: verdict, status: 'idle' as Status };

/** Vietnamese names for the labels the built-in templates give their steps; labels a user wrote are shown as they are. */
const stepNames: Record<string, string> = {
  'Quick plan': 'Kế hoạch nhanh', Plan: 'Lập kế hoạch', 'Approve plan': 'Duyệt kế hoạch', 'Auto-approve plan': 'Tự duyệt kế hoạch', Implement: 'Thực hiện',
  'Implement A': 'Nhánh A', 'Implement B': 'Nhánh B', Integrate: 'Tích hợp', 'Bounded repair': 'Vòng sửa', 'Independent review': 'Review độc lập',
  'Local commit': 'Commit local', Research: 'Tìm hiểu', 'Review sources': 'Review nguồn', 'Split work': 'Chia việc', Join: 'Gộp nhánh',
};
export const stepName = (label: string) => stepNames[label] ?? label;

const workspaceNames: Record<string, string> = { isolated: 'worktree riêng', current: 'checkout hiện tại', shared: 'workspace chung' };
export const workspaceName = (mode: string | undefined) => workspaceNames[mode ?? 'isolated'] ?? 'worktree riêng';

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} phút ${seconds % 60} giây` : `${minutes} phút`;
  return `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}

/** Elapsed time as `m:ss` (or `h:mm:ss`), for the timeline's time column. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** "12 phút trước", "hôm qua", "3 ngày trước"; older than two weeks falls back to the date. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  const then = iso ? new Date(iso).getTime() : NaN;
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

const artifactKinds: Record<string, string> = { agent: 'Output của agent', check: 'Output của check', summary: 'Tóm tắt run' };
export const artifactLabel = (kind: string) => artifactKinds[kind] ?? kind;
