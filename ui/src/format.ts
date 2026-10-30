/** Display helpers shared by the run screens. */
export type Tone = 'violet' | 'amber' | 'green' | 'red' | 'gray' | 'blue';

const phases: Record<string, { label: string; tone: Tone }> = {
  running: { label: 'Đang chạy', tone: 'violet' }, waiting_approval: { label: 'Chờ duyệt kế hoạch', tone: 'amber' },
  paused: { label: 'Tạm dừng', tone: 'gray' }, blocked: { label: 'Cần xử lý', tone: 'red' }, completed: { label: 'Hoàn tất', tone: 'green' },
  cancelled: { label: 'Đã hủy', tone: 'gray' }, recovering: { label: 'Chờ tiếp tục', tone: 'blue' }, stopping: { label: 'Đang dừng', tone: 'gray' },
};
export const phaseInfo = (phase: string) => phases[phase] ?? { label: phase, tone: 'gray' as Tone };

const statuses: Record<string, { label: string; tone: Tone; icon: string }> = {
  succeeded: { label: 'Xong', tone: 'green', icon: '✓' }, running: { label: 'Đang chạy', tone: 'violet', icon: '●' },
  ready: { label: 'Sẵn sàng', tone: 'blue', icon: '○' }, pending: { label: 'Chờ', tone: 'gray', icon: '○' },
  failed: { label: 'Lỗi', tone: 'red', icon: '✕' }, skipped: { label: 'Bỏ qua', tone: 'gray', icon: '–' },
};
export const statusInfo = (status: string | undefined) => statuses[status ?? 'pending'] ?? { label: status ?? '', tone: 'gray' as Tone, icon: '○' };

const verdicts: Record<string, { label: string; tone: Tone }> = {
  pass: { label: 'Đạt', tone: 'green' }, needs_changes: { label: 'Cần sửa', tone: 'amber' }, blocked: { label: 'Bị chặn', tone: 'red' }, inconclusive: { label: 'Chưa kết luận', tone: 'amber' },
  passed: { label: 'Đạt', tone: 'green' }, failed: { label: 'Lỗi', tone: 'red' }, unresolved: { label: 'Đang chạy', tone: 'violet' }, fail: { label: 'Không đạt', tone: 'red' },
};
export const verdictInfo = (verdict: string) => verdicts[verdict] ?? { label: verdict, tone: 'gray' as Tone };

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} phút ${seconds % 60} giây` : `${minutes} phút`;
  return `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

const artifactKinds: Record<string, string> = { agent: 'Output của agent', check: 'Output của check', summary: 'Tóm tắt run' };
export const artifactLabel = (kind: string) => artifactKinds[kind] ?? kind;
