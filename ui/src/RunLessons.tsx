import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Badge, Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Callout } from '@/components/ui/misc';
import { api } from './api';

type Lesson = { proposal: { proposalId: string; origin?: string; reason?: string; record: { type?: string; body: string; sources: string[]; scope?: string; tags?: string[] } }; version: number; proposalHash: string; expectedRevision: string | null; promoted: boolean; rejected?: boolean };

export const typeLabels: Record<string, string> = { context: 'Context', decision: 'Quyết định', lesson: 'Lesson' };
/** Where a proposal came from, in the user's words; repaired review findings had no origin before other kinds existed. */
export const originLabels: Record<string, string> = { repair: 'Từ vòng sửa', plan_revision: 'Từ yêu cầu sửa kế hoạch', review_rule: 'Rule bị vi phạm', run_stopped: 'Run bị chặn', user_note: 'Bạn ghi nhớ', ai_session: 'AI đề xuất' };

/** Memory the run proposed (lessons, decisions, context): only a version the user approves is promoted. */
export function RunLessons({ runId, onPromoted, pendingOnly = false }: { runId: string; onPromoted?(): void; pendingOnly?: boolean }) {
  const [data, setData] = useState<{ memoryRoot: string | null; proposals: Lesson[] }>({ memoryRoot: null, proposals: [] });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null), [editedBody, setEditedBody] = useState('');
  const refresh = async () => setData(await api(`/api/runs/${runId}/lessons`));
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [runId]);
  /** Post one lesson action, then reload the queue. */
  function call(action: string, body: unknown, after?: () => void) {
    setBusy(true); setError('');
    void api(`/api/runs/${runId}/lessons/${action}`, 'POST', body).then(async () => { await refresh(); after?.(); onPromoted?.(); })
      .catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  }
  if (!data.proposals.length && !error) return null;
  const pending = data.proposals.filter(lesson => !lesson.promoted && !lesson.rejected).length;
  return <section className="overflow-hidden rounded-lg border bg-card">
    <div className="flex items-baseline gap-2 border-b px-4 py-3"><h3 className="m-0 text-[14px] font-semibold">Đề xuất memory</h3>
      <span className="text-[12px] text-muted-foreground">{pending ? `${pending} chờ duyệt · ` : ''}chỉ bản bạn duyệt mới được đưa vào memory dùng chung</span></div>
    {error && <div className="px-4 pt-3"><Callout tone="danger" icon={<CircleAlert />}>{error}</Callout></div>}
    {!data.memoryRoot && <p className="m-0 px-4 pt-3 text-[12.5px] text-muted-foreground">Mở mục Memory để chọn thư mục lưu trước khi duyệt.</p>}
    {data.proposals.filter(lesson => !pendingOnly || (!lesson.promoted && !lesson.rejected)).map(lesson => { const id = lesson.proposal.proposalId, open = !lesson.promoted && !lesson.rejected;
      return <div key={id} className="flex flex-col gap-2.5 border-b px-4 py-3 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2"><code className="font-mono text-[12.5px] font-semibold">{id}</code><span className="text-[11.5px] text-muted-foreground">v{lesson.version}</span><Tag>{typeLabels[lesson.proposal.record.type ?? 'lesson']}</Tag><Tag>{originLabels[lesson.proposal.origin ?? 'repair']}</Tag>{lesson.proposal.record.scope && <Tag>{lesson.proposal.record.scope}</Tag>}{lesson.proposal.record.tags?.map(tag => <Tag key={tag}>{tag}</Tag>)}
          {lesson.promoted && <Badge status="success">Đã lưu vào memory</Badge>}{lesson.rejected && <Badge status="idle">Đã từ chối</Badge>}</div>
        {editing === id ? <Textarea aria-label="Nội dung đề xuất" rows={6} value={editedBody} onChange={e => setEditedBody(e.target.value)} />
          : <p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-2">{lesson.proposal.record.body}</p>}
        {lesson.proposal.reason && <p className="m-0 text-[12px] text-muted-foreground">{lesson.proposal.reason}</p>}
        {lesson.proposal.record.sources.length > 0 && <p className="m-0 text-[11.5px] text-muted-foreground">Nguồn: {lesson.proposal.record.sources.join(', ')}</p>}
        {open && <div className="flex flex-wrap gap-2">{editing === id ? <>
          <Button disabled={busy || !editedBody.trim()} onClick={() => call('revise', { proposalId: id, proposalHash: lesson.proposalHash, body: editedBody }, () => setEditing(null))}>Lưu phiên bản mới</Button>
          <Button variant="ghost" onClick={() => setEditing(null)}>Hủy chỉnh sửa</Button></> : <>
          <Button disabled={busy || !!editing || !data.memoryRoot} onClick={() => call('approve', { proposalId: id, proposalHash: lesson.proposalHash, expectedRevision: lesson.expectedRevision, memoryRoot: data.memoryRoot })}>Duyệt</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setEditedBody(lesson.proposal.record.body); setEditing(id); }}>Chỉnh sửa</Button>
          <Button variant="ghost" className="text-danger hover:text-danger" disabled={busy || !!editing} onClick={() => call('reject', { proposalId: id, proposalHash: lesson.proposalHash })}>Từ chối</Button></>}</div>}
      </div>; })}
  </section>;
}
