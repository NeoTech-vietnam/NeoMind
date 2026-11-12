import { useState } from 'react';
import { BookmarkPlus, CircleSlash, CircleX, ThumbsUp } from 'lucide-react';
import { Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Disclosure } from '@/components/ui/disclosure';
import { Field, Textarea } from '@/components/ui/input';
import { Callout } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from './api';
import { bindingLabel, type MemoryRating, type MemoryUse, type Run } from './runTypes';
import { MemoryBody } from './MemoryBody';

const typeLabels: Record<string, string> = { context: 'Context', decision: 'Quyết định', lesson: 'Lesson' };
const ratings: { value: MemoryRating; label: string; icon: typeof ThumbsUp; tone: string }[] = [
  { value: 'helpful', label: 'Hữu ích', icon: ThumbsUp, tone: 'text-success' },
  { value: 'irrelevant', label: 'Không liên quan', icon: CircleSlash, tone: 'text-muted-foreground' },
  { value: 'wrong', label: 'Sai', icon: CircleX, tone: 'text-danger' },
];
type StoredRecord = { revision: string; body: string; header: { id: string; type: 'context' | 'decision' | 'lesson'; scope: string; sources: string[]; tags: string[]; expiresAt?: string; supersedes?: string[] } };

/** A pinned prompt block is `[type:id revision=…]`, a sources line, then the body. */
const pinnedBody = (text: string) => text.replace(/^\[[^\n]*\]\n/, '').replace(/^Sources: [^\n]*\n/, '');

/** The latest turn of each step: what it received is what the user rates. */
function latestPerStep(use: MemoryUse[]) {
  const latest = new Map<string, { item: MemoryUse; turns: number }>();
  for (const item of use) latest.set(item.key, { item, turns: (latest.get(item.key)?.turns ?? 0) + 1 });
  return [...latest.values()];
}

/**
 * "Memory đã dùng": per step, the pinned records its agent received and why, with Hữu ích / Không liên quan / Sai. A rating
 * is journaled in the run and moves the record in later runs' ranking; "Sai" opens the record to fix or expire it.
 */
export function RunMemoryUsed({ run, setRun }: { run: Run; setRun(run: Run): void }) {
  const flow = run.snapshot?.configuration.flow, steps = latestPerStep(run.memoryUse ?? []);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [fixing, setFixing] = useState<StoredRecord | null>(null), [body, setBody] = useState('');
  const used = new Set(steps.flatMap(step => step.item.records.map(record => record.record)));
  // The text each record had when the run pinned it, which is what the agents received.
  const pinned = new Map((run.runtimeContext?.memory?.records ?? []).flatMap(record => record.text ? [[`${record.type}/${record.id}`, pinnedBody(record.text)] as [string, string]] : []));
  async function rate(step: MemoryUse, record: MemoryUse['records'][number], rating: MemoryRating) {
    setBusy(`${step.attemptId}:${record.record}`); setError('');
    try {
      await api(`/api/runs/${run.runId}/memory-feedback`, 'POST', { record: record.record, revision: record.revision, nodeId: step.nodeId, attemptId: step.attemptId, rating });
      setRun(await api<Run>(`/api/runs/${run.runId}`));
      if (rating === 'wrong') {
        const current = await api<{ record: StoredRecord }>(`/api/memory/records/${record.type}/${record.id}`).catch(() => undefined);
        if (current) { setFixing(current.record); setBody(current.record.body); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  }
  async function fix(action: 'save' | 'expire') {
    if (!fixing) return;
    setBusy('fix'); setError('');
    try {
      if (action === 'expire') await api('/api/memory/expire', 'POST', { type: fixing.header.type, id: fixing.header.id, expectedRevision: fixing.revision });
      else await api('/api/memory', 'POST', { record: { id: fixing.header.id, type: fixing.header.type, scope: fixing.header.scope, sources: fixing.header.sources, tags: fixing.header.tags, body,
        ...(fixing.header.expiresAt ? { expiresAt: fixing.header.expiresAt } : {}), ...(fixing.header.supersedes ? { supersedes: fixing.header.supersedes } : {}) }, expectedRevision: fixing.revision });
      setFixing(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  }
  if (!run.runtimeContext?.memory) return null;
  return <Disclosure title="Memory đã dùng" hint={steps.length ? `${used.size} bản ghi · ${steps.length} bước` : 'chưa bước nào nhận memory'}>
    <p className="m-0 mb-2.5 text-[12.5px] text-muted-foreground">Bản ghi mỗi bước thực sự nhận trong prompt. Đánh giá giúp NeoMind xếp hạng memory ở các run sau.</p>
    {error && <Callout tone="danger" className="mb-2.5">{error}</Callout>}
    {!steps.length && <p className="m-0 text-[12.5px] text-muted-foreground">Chưa có bước nào chạy, hoặc các bước không nhận memory.</p>}
    <div className="flex flex-col gap-3">{steps.map(({ item, turns }) => <div key={item.key} className="rounded-md border">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b px-3 py-2"><strong className="text-[13px] font-semibold">{bindingLabel(item.key, flow)}</strong>
        <span className="text-[11.5px] text-muted-foreground">{item.filter}{turns > 1 ? ` · lượt mới nhất trong ${turns} lượt` : ''}</span></div>
      {!item.records.length ? <p className="m-0 px-3 py-2 text-[12.5px] text-muted-foreground">Bước này không nhận bản ghi nào.</p>
        : item.records.map(record => <div key={record.record} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2 last:border-b-0">
          <div className="min-w-0 flex-1 basis-56"><div className="flex flex-wrap items-center gap-1.5"><code className="font-mono text-[12px] font-semibold">{record.id}</code><Tag>{typeLabels[record.type] ?? record.type}</Tag>{record.scope && <Tag>{record.scope}</Tag>}</div>
            {pinned.get(record.record) && <MemoryBody className="mt-1" lines={2} body={pinned.get(record.record)!} />}
            <span className="mt-0.5 block text-[11.5px] text-muted-foreground">{record.reason || 'Được ghim khi run bắt đầu'}</span></div>
          <div className="flex items-center gap-1" role="group" aria-label={`Đánh giá ${record.id}`}>{ratings.map(option => { const Icon = option.icon, active = record.rating === option.value;
            return <Tooltip key={option.value} label={option.label}><Button size="sm" variant={active ? 'outline' : 'ghost'} aria-pressed={active} aria-label={option.label} disabled={!!busy}
              className={cn('gap-1 px-2', active && option.tone)} onClick={() => void rate(item, record, option.value)}><Icon className="size-3.5" /><span className="hidden min-[1100px]:inline">{option.label}</span></Button></Tooltip>; })}</div>
        </div>)}
    </div>)}</div>
    <Dialog open={!!fixing} onOpenChange={open => { if (!open) setFixing(null); }}><DialogContent title={`Bản ghi sai: ${fixing?.header.id ?? ''}`} description="Sửa nội dung (lưu revision mới) hoặc đánh dấu hết hạn để các run sau không dùng nữa.">
      <div className="mt-3"><Field label="Nội dung"><Textarea aria-label="Nội dung bản ghi" rows={7} value={body} onChange={event => setBody(event.target.value)} /></Field></div>
      <DialogActions><Button variant="ghost" onClick={() => setFixing(null)}>Để sau</Button><Button variant="danger" disabled={busy === 'fix'} onClick={() => void fix('expire')}>Đánh dấu hết hạn</Button>
        <Button variant="primary" disabled={busy === 'fix' || !body.trim() || body === fixing?.body} onClick={() => void fix('save')}>Lưu bản sửa</Button></DialogActions>
    </DialogContent></Dialog>
  </Disclosure>;
}

/** "Ghi nhớ điều này": the user's sentence becomes a memory proposal whose source is this run; it waits for approval like any other. */
export function RememberButton({ runId, onCreated }: { runId: string; onCreated?(): void }) {
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [type, setType] = useState('lesson'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('');
  async function submit() {
    setBusy(true); setError('');
    try {
      const result = await api<{ created: boolean; message?: string }>(`/api/runs/${runId}/remember`, 'POST', { text, type });
      setDone(result.created ? 'Đã tạo đề xuất memory; duyệt ở trang Memory hoặc mục "Đề xuất memory" của run.' : result.message ?? 'Đã có nội dung này.');
      setText(''); onCreated?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <>
    <Button onClick={() => { setOpen(true); setDone(''); setError(''); }}><BookmarkPlus />Ghi nhớ điều này</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent title="Ghi nhớ điều này" description="Viết một câu agent nên biết ở các run sau. Câu này thành đề xuất memory có nguồn là run này và chỉ được dùng sau khi bạn duyệt.">
      <form className="mt-3 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
        {error && <Callout tone="danger">{error}</Callout>}{done && <Callout tone="success">{done}</Callout>}
        <Field label="Điều cần nhớ"><Textarea aria-label="Điều cần nhớ" autoFocus rows={4} value={text} onChange={event => setText(event.target.value)} placeholder="Ví dụ: Chạy npm run build:ui sau khi sửa giao diện." /></Field>
        <Field label="Loại"><Select label="Loại memory" value={type} onValueChange={setType} options={[{ value: 'lesson', label: 'Lesson (bài học)' }, { value: 'decision', label: 'Quyết định' }, { value: 'context', label: 'Context (sự thật về project)' }]} /></Field>
        <DialogActions><Button variant="ghost" onClick={() => setOpen(false)}>Đóng</Button><Button type="submit" variant="primary" disabled={busy || !text.trim()}>Tạo đề xuất</Button></DialogActions>
      </form>
    </DialogContent></Dialog>
  </>;
}
