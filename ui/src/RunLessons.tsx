import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Callout } from '@/components/ui/misc';
import { api } from './api';

type Lesson = { proposal: { proposalId: string; record: { body: string; sources: string[] } }; version: number; proposalHash: string; expectedRevision: string | null; promoted: boolean; rejected?: boolean };

/** Lessons the run proposed for the shared memory: only a version the user approves is promoted. */
export function RunLessons({ runId, onPromoted }: { runId: string; onPromoted?(): void }) {
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
    <div className="flex items-baseline gap-2 border-b px-4 py-3"><h3 className="m-0 text-[14px] font-semibold">Lesson đề xuất</h3>
      <span className="text-[12px] text-muted-foreground">{pending ? `${pending} chờ duyệt · ` : ''}chỉ bản bạn duyệt mới được đưa vào memory dùng chung</span></div>
    {error && <div className="px-4 pt-3"><Callout tone="danger" icon={<CircleAlert />}>{error}</Callout></div>}
    {!data.memoryRoot && <p className="m-0 px-4 pt-3 text-[12.5px] text-muted-foreground">Mở mục Memory để chọn thư mục lưu trước khi duyệt.</p>}
    {data.proposals.map(lesson => { const id = lesson.proposal.proposalId, open = !lesson.promoted && !lesson.rejected;
      return <div key={id} className="flex flex-col gap-2.5 border-b px-4 py-3 last:border-b-0">
        <div className="flex items-center gap-2"><code className="font-mono text-[12.5px] font-semibold">{id}</code><span className="text-[11.5px] text-muted-foreground">v{lesson.version}</span>
          {lesson.promoted && <Badge status="success">Đã lưu vào memory</Badge>}{lesson.rejected && <Badge status="idle">Đã từ chối</Badge>}</div>
        {editing === id ? <Textarea aria-label="Nội dung lesson" rows={6} value={editedBody} onChange={e => setEditedBody(e.target.value)} />
          : <p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-2">{lesson.proposal.record.body}</p>}
        {lesson.proposal.record.sources.length > 0 && <p className="m-0 text-[11.5px] text-muted-foreground">Nguồn: {lesson.proposal.record.sources.join(', ')}</p>}
        {open && <div className="flex flex-wrap gap-2">{editing === id ? <>
          <Button disabled={busy || !editedBody.trim()} onClick={() => call('revise', { proposalId: id, proposalHash: lesson.proposalHash, body: editedBody }, () => setEditing(null))}>Lưu phiên bản mới</Button>
          <Button variant="ghost" onClick={() => setEditing(null)}>Hủy chỉnh sửa</Button></> : <>
          <Button disabled={busy || !!editing || !data.memoryRoot} onClick={() => call('approve', { proposalId: id, proposalHash: lesson.proposalHash, expectedRevision: lesson.expectedRevision, memoryRoot: data.memoryRoot })}>Duyệt lesson này</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setEditedBody(lesson.proposal.record.body); setEditing(id); }}>Chỉnh sửa</Button>
          <Button variant="ghost" className="text-danger hover:text-danger" disabled={busy || !!editing} onClick={() => call('reject', { proposalId: id, proposalHash: lesson.proposalHash })}>Từ chối</Button></>}</div>}
      </div>; })}
  </section>;
}
