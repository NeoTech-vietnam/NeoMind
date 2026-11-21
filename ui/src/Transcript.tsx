/**
 * Timeline of one agent step's transcript (Claude, Codex or OpenCode session file), from NeoMind's SessionTimeline:
 * messages as cards with a preview, tool calls as compact rows with their result folded underneath.
 * The server sends a readable summary, [{role, kind, text}]; unknown kinds are shown as plain rows.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleX, Info, ListChecks, MessageSquare, Sparkles, Wrench } from 'lucide-react';
import { api, enc } from './api';
import { CopyButton } from '@/components/CopyButton';
import { Tag } from '@/components/ui/badge';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { Transcript as TranscriptData, TranscriptEvent } from './types';

type Kind = 'prompt' | 'message' | 'answer' | 'reasoning' | 'tool' | 'result' | 'error' | 'cut' | 'other';
function classify(event: TranscriptEvent): Kind {
  const kind = (event.kind ?? '').toLowerCase(), role = (event.role ?? '').toLowerCase();
  if (kind.includes('error')) return 'error';
  if (kind === 'cut') return 'cut';
  if (kind === 'answer' || kind === 'structured_output') return 'answer';
  if (kind.includes('reason') || kind.includes('think')) return 'reasoning';
  if (kind.includes('result') || kind.includes('output') || role === 'tool') return 'result';
  if (kind.includes('tool') || kind.includes('call') || kind.includes('command') || kind === 'exec') return 'tool';
  if (kind === 'prompt' || role === 'user') return 'prompt';
  if (role === 'assistant' || kind === 'text' || kind === 'message' || kind === 'answer') return 'message';
  return 'other';
}

type Row = { kind: Kind; event: TranscriptEvent; result?: TranscriptEvent };
function rows(events: TranscriptEvent[]): Row[] {
  const out: Row[] = [];
  for (const event of events) {
    const kind = classify(event), last = out.at(-1);
    if (kind === 'result' && last?.kind === 'tool' && !last.result) { last.result = event; continue; }
    out.push({ kind, event });
  }
  return out;
}

type Filter = 'all' | 'message' | 'tool';
const filterLabels: Record<Filter, string> = { all: 'Tất cả', message: 'Tin nhắn', tool: 'Công cụ' };
const matches = (row: Row, filter: Filter) => filter === 'all' || (filter === 'message' ? ['prompt', 'message', 'answer', 'reasoning'].includes(row.kind) : ['tool', 'result', 'error'].includes(row.kind));

const Pre = ({ children, className }: { children: ReactNode; className?: string }) => <pre className={cn('m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2.5 font-mono text-[11.5px] leading-relaxed', className)}>{children}</pre>;

function Entry({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone?: 'danger' | undefined }) {
  return <li className="relative flex gap-2.5 py-1">
    <span className={cn('relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center bg-background text-muted-foreground [&_svg]:size-[15px]', tone === 'danger' && 'text-danger')}>{icon}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </li>;
}

function Op({ summary, detail }: { summary: ReactNode; detail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!detail) return <div className="flex min-h-[24px] flex-wrap items-center gap-x-2 text-[12.5px] text-fg-2">{summary}</div>;
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex min-h-[24px] w-full cursor-pointer items-center gap-x-2 border-0 bg-transparent p-0 text-left font-sans text-[12.5px] text-fg-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span className="min-w-0 flex-1 truncate">{summary}</span><ChevronRight className={cn('size-3.5 shrink-0 text-faint transition-transform', open && 'rotate-90')} /></button>
    {open && <div className="mt-1.5 flex flex-col gap-1.5">{detail}</div>}
  </div>;
}

function Milestone({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false), long = text.length > 240 || text.split('\n').length > 4;
  return <div className="rounded-lg border bg-card px-3 py-2.5">
    <div className="flex items-center gap-2 text-[13px] font-semibold">{title}<span className="ml-auto"><CopyButton text={text} label="Sao chép" /></span></div>
    {open || !long ? <p className="m-0 mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg-2">{text}</p>
      : <p className="m-0 mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg-2">{text}</p>}
    {long && <button type="button" onClick={() => setOpen(value => !value)} className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 font-sans text-[12px] text-muted-foreground hover:text-foreground">{open ? 'Thu gọn' : 'Xem đầy đủ'}</button>}
  </div>;
}

/** Pretty-print a JSON answer; other text stays as it is. */
function pretty(text: string): string { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }

const firstLine = (text: string | undefined) => (text ?? '').split('\n').find(line => line.trim())?.trim() ?? '';

function RowView({ row }: { row: Row }) {
  const text = row.event.text ?? '', label = row.event.kind ?? row.event.role ?? '';
  switch (row.kind) {
    case 'prompt': return <Entry icon={<MessageSquare />}><Milestone title="Yêu cầu gửi agent" text={text} /></Entry>;
    case 'message': return <Entry icon={<MessageSquare />}><Milestone title="Tin nhắn của agent" text={text} /></Entry>;
    case 'answer': return <Entry icon={<ListChecks />}><Milestone title="Kết quả trả về" text={pretty(text)} /></Entry>;
    case 'cut': return <li className="my-1.5 flex items-center gap-2 pl-8 text-[11.5px] text-muted-foreground"><span className="h-px flex-1 border-t border-dashed" />{text || 'Một phần transcript bị lược'}<span className="h-px flex-1 border-t border-dashed" /></li>;
    case 'reasoning': return <Entry icon={<Sparkles />}><Op summary={<span>Suy luận <span className="text-muted-foreground">{firstLine(text).slice(0, 120)}</span></span>} detail={<p className="m-0 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">{text}</p>} /></Entry>;
    case 'tool': return <Entry icon={<Wrench />}><Op summary={<span><code className="font-mono text-[12px] text-foreground">{firstLine(text).slice(0, 160) || label}</code>{row.result && classify(row.result) === 'error' && <span className="ml-2 text-danger">lỗi</span>}</span>}
      detail={<>{text.includes('\n') || text.length > 160 ? <Pre>{text}</Pre> : null}{row.result?.text ? <Pre className="text-fg-2">{row.result.text}</Pre> : <p className="m-0 text-[12px] text-muted-foreground">Không có kết quả được ghi.</p>}</>} /></Entry>;
    case 'result': return <Entry icon={<Wrench />}><Op summary={<span>Kết quả <span className="text-muted-foreground">{firstLine(text).slice(0, 120)}</span></span>} detail={<Pre>{text}</Pre>} /></Entry>;
    case 'error': return <Entry icon={<CircleX />} tone="danger"><div className="rounded-lg bg-danger/12 px-3 py-2 text-[12.5px] text-fg-2"><strong className="text-danger">Lỗi</strong> <span className="whitespace-pre-wrap">{text}</span></div></Entry>;
    default: return <Entry icon={<Info />}><Op summary={<span><span className="text-muted-foreground">{label}</span> {firstLine(text).slice(0, 140)}</span>} {...(text.length > 140 || text.includes('\n') ? { detail: <Pre>{text}</Pre> } : {})} /></Entry>;
  }
}

/** Sheet with the transcript of one step; `step` may be a fan-out worker ("research[1]"). */
export function TranscriptSheet({ run, step, onClose }: { run: string; step: string | null; onClose(): void }) {
  const [data, setData] = useState<TranscriptData | null>(null), [error, setError] = useState(''), [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    if (!step) return;
    let current = true; setData(null); setError(''); setFilter('all');
    api<TranscriptData>(`/api/runs/${enc(run)}/transcript?step=${enc(step)}`).then(value => { if (current) setData(value); }).catch(e => { if (current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [run, step]);
  const all = useMemo(() => rows(data?.events ?? []), [data]);
  const shown = all.filter(row => matches(row, filter));
  return <Dialog open={!!step} onOpenChange={open => { if (!open) onClose(); }}>
    {step && <SheetContent className="w-[640px]" title={<>Transcript <code className="font-mono text-[13px]">{step}</code>{data?.agent && <Tag>{data.agent}</Tag>}</>}
      description={data?.path ? <span className="flex items-center gap-1"><span className="truncate font-mono text-[11px]" title={data.path}>{data.path}</span><CopyButton text={data.path} label="Sao chép đường dẫn" /></span> : `Run ${run}`}
      subheader={<div className="mt-2.5 flex gap-4 border-b-0">{(Object.keys(filterLabels) as Filter[]).map(item => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}
        className={cn('-mb-px cursor-pointer border-0 border-b-2 border-solid border-transparent bg-transparent px-0 pb-1 font-sans text-[12.5px] text-muted-foreground hover:text-foreground', filter === item && 'border-foreground font-semibold text-foreground')}>
        {filterLabels[item]} <small className="text-[11px] tabular-nums text-faint">{all.filter(row => matches(row, item)).length}</small></button>)}</div>}>
      <div className="px-4 py-3">
        {error && <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />{error}</p>}
        {!data && !error && <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc transcript…</p>}
        {data && <ol className="relative m-0 list-none p-0 before:absolute before:bottom-3 before:left-[9.5px] before:top-3 before:w-px before:bg-border">
          {shown.map((row, index) => <RowView key={index} row={row} />)}
          {!shown.length && <li className="py-3 pl-8 text-[12.5px] text-muted-foreground">Không có sự kiện nào{filter !== 'all' ? ' thuộc loại này' : ''}.</li>}
        </ol>}
      </div>
    </SheetContent>}
  </Dialog>;
}
