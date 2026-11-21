import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, CircleAlert, Hand, X } from 'lucide-react';
import { api, enc } from './api';
import { confirmAction } from './dialog';
import { FileTabs } from './FilePreview';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Callout } from '@/components/ui/misc';
import type { RunDetail } from './types';

/**
 * The gate a run waits at. Answering needs the run name typed again (the server checks it too), so a click on the
 * wrong run's card cannot approve it. A reject asks once more, because it ends the run.
 */
export function GateCard({ run, approver, answeredAs, onAnswered }: { run: RunDetail; approver?: string | undefined; answeredAs?: string | undefined; onAnswered(): void }) {
  const [note, setNote] = useState(''), [confirm, setConfirm] = useState(''), [sending, setSending] = useState<'approve' | 'reject' | null>(null), [error, setError] = useState('');
  const [showFiles, setShowFiles] = useState(true), files = useMemo(() => run.gate_files ?? [], [run.gate_files?.join('\n')]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setNote(''); setConfirm(''); setError(''); setShowFiles(true); }, [run.run, run.gate]);
  const matches = confirm.trim() === run.run, blocked = run.busy || !!sending;
  const answer = async (decision: 'approve' | 'reject') => {
    if (!matches || blocked) return;
    if (decision === 'reject' && !await confirmAction({ title: `Từ chối run ${run.run}?`, description: 'Từ chối kết thúc run tại gate này; các bước sau sẽ không chạy.', confirmLabel: 'Từ chối và kết thúc run', danger: true })) return;
    setSending(decision); setError('');
    try {
      await api(`/api/runs/${enc(run.run)}/answer`, 'POST', { decision, note: note.trim() || null, confirm: confirm.trim() });
      onAnswered();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSending(null); }
  };
  return <section className="rounded-lg border-2 border-attention/60 bg-attention/5 p-4" aria-label={`Gate ${run.gate}`}>
    <div className="flex items-center gap-2"><Hand className="size-4 text-attention" />
      <h3 className="m-0 text-[14px] font-semibold">Chờ duyệt tại gate <code className="font-mono text-[13px]">{run.gate}</code></h3>
      {approver && <span className="ml-auto text-[12px] text-muted-foreground">Người duyệt: {approver}</span>}</div>
    <p className="m-0 mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{run.question || 'Không có câu hỏi.'}</p>
    {files.length > 0 && <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-2"><span className="text-[12px] font-medium text-fg-2">Nội dung cần duyệt <span className="font-normal text-faint">{files.length} file</span></span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowFiles(value => !value)}>{showFiles ? <><ChevronUp />Thu gọn</> : <><ChevronDown />Mở</>}</Button></div>
      {showFiles && <FileTabs paths={files} version={`${run.gate}|${run.started ?? ''}`} bodyClassName="max-h-[460px]" />}
    </div>}
    <form className="mt-3 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void answer('approve'); }}>
      <Field label="Ghi chú (không bắt buộc)" help="Bước sau và các run sau cùng series sẽ đọc ghi chú này.">
        <Textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Ví dụ: thêm một ví dụ cụ thể; bỏ phần giá" rows={3} />
      </Field>
      <Field label={<>Gõ tên run <code className="font-mono">{run.run}</code> để xác nhận</>} {...(confirm && !matches ? { error: 'Tên run chưa khớp' } : {})}>
        <Input value={confirm} onChange={event => setConfirm(event.target.value)} placeholder={run.run} autoComplete="off" spellCheck={false} className="font-mono" />
      </Field>
      {run.busy && <Callout tone="hint" icon={<CircleAlert />}>Server đang xử lý run này; chờ một chút rồi trả lời.</Callout>}
      {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={!matches || blocked}><Check />{sending === 'approve' ? 'Đang gửi…' : 'Duyệt'}</Button>
        <Button variant="danger" disabled={!matches || blocked} onClick={() => void answer('reject')}><X />{sending === 'reject' ? 'Đang gửi…' : 'Từ chối'}</Button>
        <span className="text-[11.5px] text-muted-foreground">Lịch sử run ghi câu trả lời là của <code className="font-mono">{answeredAs ?? 'web:<bạn>'}</code>.</span>
      </div>
    </form>
  </section>;
}
