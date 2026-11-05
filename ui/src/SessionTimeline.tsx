/**
 * Timeline of one agent turn, shared by the live activity feed and the session sheet (docs/design/mockups/10-session-viewer-v2).
 * Three tiers: milestones (prompt, plan, structured result) as cards with a preview; operations (read, search, edit,
 * command) as compact rows, consecutive reads folded into one; and a closing line for the end of the turn.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, FileText, ListChecks, MessageSquare, Pencil, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react';
import { StatusDot } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from './api';
import { formatClock, formatDuration } from './format';
import type { TranscriptEvent } from '../../src/core/transcript-types';

export type Source = 'neomind' | 'runner';
export type EventPage = { source: Source; recorded: boolean; events: TranscriptEvent[]; note?: string; runner?: string };

/** Events of one attempt; NeoMind's transcript is fetched incrementally while the attempt runs. */
export function useEvents(runId: string, attemptId: string, source: Source, following: boolean) {
  const [page, setPage] = useState<EventPage | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, next = 0, inFlight = false;
    setPage(null); setError('');
    const load = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const value = await api<EventPage>(`/api/runs/${runId}/transcripts/${attemptId}?source=${source}&after=${next}`);
        if (disposed) return;
        if (value.events.length) next = (value.events.at(-1)!.i ?? next) + 1;
        setPage(current => current && source === 'neomind' ? { ...value, events: [...current.events, ...value.events] } : value);
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); } finally { inFlight = false; }
    };
    void load();
    if (!following || source !== 'neomind') return () => { disposed = true; };
    const timer = setInterval(() => void load(), 1200);
    return () => { disposed = true; clearInterval(timer); };
  }, [runId, attemptId, source, following]);
  return { page, error };
}

/** One row of the timeline: an event with the results, output and completion that belong to it. */
export type Row = TranscriptEvent & { result?: TranscriptEvent; live?: string };
export function rows(events: TranscriptEvent[]): Row[] {
  const out: Row[] = [], byId = new Map<string, Row>();
  for (const event of events) {
    if (['meta', 'turn', 'usage'].includes(event.kind)) continue;
    const row = event.id ? byId.get(event.id) : undefined;
    if (event.kind === 'result') {
      if (!row) continue;
      row.result = event;
      // A Claude tool call has no completion event of its own: its result settles it.
      if (row.kind === 'command' && row.status === 'running') { row.status = event.error ? 'failed' : 'completed'; if (row.text === undefined) row.text = event.text ?? ''; }
      continue;
    }
    if (event.kind === 'output') { if (row && row.text === undefined) row.live = (row.live ?? '') + (event.text ?? ''); continue; }
    if (event.kind === 'command' && row) { Object.assign(row, event, { t: row.t }); continue; }
    const item: Row = { ...event };
    out.push(item); if (event.id) byId.set(event.id, item);
  }
  return out;
}

export type Filter = 'all' | 'message' | 'edit' | 'command';
export const filterLabels: Record<Filter, string> = { all: 'Tất cả', message: 'Tin nhắn', edit: 'Sửa file', command: 'Lệnh' };
const messageKinds = ['prompt', 'message', 'reasoning', 'structured_output'];
export const matches = (row: Row, filter: Filter) => filter === 'all' || (filter === 'message' ? messageKinds.includes(row.kind) : filter === 'edit' ? row.kind === 'edit' : row.kind === 'command' && row.action !== 'read');
/** Counts for the filter tabs. Live mode shows operations only, so milestones are not counted there. */
export function countRows(list: Row[], live: boolean): Record<Filter, number> {
  const shown = live ? list.filter(row => !isMilestone(row) && row.kind !== 'reasoning' && row.kind !== 'end') : list;
  return { all: shown.length, message: shown.filter(row => matches(row, 'message')).length, edit: shown.filter(row => row.kind === 'edit').length, command: shown.filter(row => matches(row, 'command')).length };
}

const isMilestone = (row: Row) => row.kind === 'prompt' || row.kind === 'message' || row.kind === 'structured_output';
const isRead = (row: Row) => row.kind === 'read' || (row.kind === 'command' && row.action === 'read');
const readPath = (row: Row) => row.path ?? row.command ?? '';

type Item = { type: 'reads'; rows: Row[] } | { type: 'row'; row: Row };
function items(list: Row[]): Item[] {
  const out: Item[] = [];
  for (const row of list) {
    if (!isRead(row)) { out.push({ type: 'row', row }); continue; }
    const last = out.at(-1);
    if (last?.type === 'reads') last.rows.push(row); else out.push({ type: 'reads', rows: [row] });
  }
  return out;
}

const fieldNames: Record<string, string> = { goal: 'Mục tiêu', approach: 'Cách làm', scope: 'Sẽ sửa', acceptanceCriteria: 'Tiêu chí', checks: 'Checks', riskChanges: 'Rủi ro', summary: 'Tóm tắt', verdict: 'Kết luận', findings: 'Phát hiện' };
function parseFields(text: string | undefined): [string, string[]][] | null {
  try {
    const value = JSON.parse(text ?? '') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.entries(value as Record<string, unknown>).map(([key, entry]): [string, string[]] => [fieldNames[key] ?? key,
      (Array.isArray(entry) ? entry : [entry]).map(item => typeof item === 'string' ? item : JSON.stringify(item))]);
  } catch { return null; }
}

function TimeCell({ row, start }: { row: Row; start: number | undefined }) {
  if (!row.t || start === undefined) return null;
  return <Tooltip label={new Date(row.t).toLocaleTimeString('vi-VN', { hour12: false })}><time className="shrink-0 pt-px text-[11px] tabular-nums text-faint">+{formatClock(row.t - start)}</time></Tooltip>;
}

/** One timeline entry: a gray icon on the time axis, content, and the relative time in a fixed right column. */
function Entry({ icon, children, time, tone }: { icon: ReactNode; children: ReactNode; time?: ReactNode; tone?: 'danger' | 'success' | 'running' | undefined }) {
  return <li className="relative flex gap-2.5 py-1">
    <span className={cn('relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center bg-background text-muted-foreground [&_svg]:size-[15px]', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success', tone === 'running' && 'text-running')}>{icon}</span>
    <div className="min-w-0 flex-1">{children}</div>{time}
  </li>;
}

/** A compact row that opens its detail below (diff, output, file list). */
function Op({ summary, detail, defaultOpen = false }: { summary: ReactNode; detail?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  if (!detail) return <div className="flex min-h-[24px] flex-wrap items-center gap-x-2 text-[12.5px] text-fg-2">{summary}</div>;
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex min-h-[24px] w-full cursor-pointer flex-wrap items-center gap-x-2 border-0 bg-transparent p-0 text-left font-sans text-[12.5px] text-fg-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {summary}<ChevronRight className={cn('size-3.5 text-faint transition-transform', open && 'rotate-90')} /></button>
    {open && <div className="mt-1.5">{detail}</div>}
  </div>;
}

const mono = 'font-mono text-[12px] text-foreground';
const Pre = ({ children, className }: { children: ReactNode; className?: string }) => <pre className={cn('m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2.5 font-mono text-[11.5px] leading-relaxed', className)}>{children}</pre>;

function Diff({ diff }: { diff: string }) {
  return <div className="max-h-72 overflow-auto rounded-md bg-code py-1 font-mono text-[11.5px] leading-relaxed">{diff.split('\n').map((line, index) => {
    const kind = line.startsWith('@@') ? 'text-faint' : line.startsWith('+++') || line.startsWith('---') ? 'text-muted-foreground' : line.startsWith('+') ? 'bg-success/12' : line.startsWith('-') ? 'bg-danger/12' : '';
    return <div key={index} className={cn('whitespace-pre px-2.5', kind)}>{line || ' '}</div>;
  })}</div>;
}

/** Milestone card: title, a short preview, and the full text on demand. */
function Milestone({ title, text, fields }: { title: string; text?: string | undefined; fields?: [string, string[]] [] | null }) {
  const [open, setOpen] = useState(false);
  const shown = fields ? (open ? fields : fields.slice(0, 3)) : null;
  return <div className="rounded-lg border bg-card px-3 py-2.5">
    <div className="text-[13px] font-semibold">{title}</div>
    {shown ? <dl className="m-0 mt-1.5 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">{shown.map(([name, values]) => <div key={name} className="contents"><dt className="text-muted-foreground">{name}</dt>
      <dd className={cn('m-0 min-w-0 break-words', !open && 'line-clamp-2')}>{open && values.length > 1 ? <ul className="m-0 list-disc pl-4">{values.map(value => <li key={value}>{value}</li>)}</ul> : values.join(', ')}</dd></div>)}</dl>
      : open ? <Pre className="mt-1.5 max-h-80 bg-transparent p-0 font-sans text-[12.5px]">{text}</Pre> : <p className="m-0 mt-1 line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-2">{text}</p>}
    {(fields ? fields.length > 3 || fields.some(([, values]) => values.length > 1) : (text ?? '').length > 160 || (text ?? '').split('\n').length > 3) &&
      <button type="button" onClick={() => setOpen(value => !value)} className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 font-sans text-[12px] text-muted-foreground hover:text-foreground">{open ? 'Thu gọn' : fields ? `Xem đầy đủ · ${fields.length} mục` : 'Xem đầy đủ'}</button>}
  </div>;
}

function RowView({ row, start }: { row: Row; start: number | undefined }) {
  const time = <TimeCell row={row} start={start} />;
  const truncated = row.truncated || row.result?.truncated ? <span className="text-[11.5px] text-muted-foreground">đã rút gọn</span> : null;
  switch (row.kind) {
    case 'prompt': return <Entry icon={<MessageSquare />} time={time}><Milestone title="Yêu cầu gửi agent" text={row.text} /></Entry>;
    case 'message': return <Entry icon={<MessageSquare />} time={time}><Milestone title={row.name === 'plan' ? 'Kế hoạch của agent' : 'Tin nhắn của agent'} text={row.text} /></Entry>;
    case 'structured_output': return <Entry icon={<ListChecks />} time={time}><Milestone title="Kết quả trả về" text={row.text} fields={parseFields(row.text)} /></Entry>;
    case 'reasoning': return <Entry icon={<Sparkles />} time={time}><Op summary={<span>Suy luận</span>} detail={<p className="m-0 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">{row.text}</p>} /></Entry>;
    case 'search': return <Entry icon={<Search />} time={time}><Op summary={<><span>Tìm <code className={mono}>{row.text}</code></span>{row.path && <span className="text-muted-foreground">trong {row.path}</span>}{truncated}</>} {...(row.result?.text ? { detail: <Pre>{row.result.text}</Pre> } : {})} /></Entry>;
    case 'edit': {
      const verb = row.change === 'add' || row.change === 'write' ? 'Tạo' : row.change === 'delete' ? 'Xóa' : 'Sửa';
      return <Entry icon={<Pencil />} time={time} tone={row.result?.error ? 'danger' : undefined}><Op summary={<><span>{verb} <code className={mono}>{row.path}</code></span>
        {!!row.added && <span className="font-mono text-[11.5px] text-success">+{row.added}</span>}{!!row.removed && <span className="font-mono text-[11.5px] text-danger">−{row.removed}</span>}
        {row.result?.error && <span className="text-danger">bị từ chối</span>}{truncated}</>}
        {...(row.diff || row.result?.error ? { detail: <>{row.diff ? <Diff diff={row.diff} /> : null}{row.result?.error && <p className="m-0 text-[12px] text-danger">{row.result.text}</p>}</> } : {})} /></Entry>;
    }
    case 'command': {
      const running = row.status === 'running' || row.status === 'inProgress', output = row.text ?? row.live ?? '';
      const search = row.action === 'search';
      return <Entry icon={search ? <Search /> : <SquareTerminal />} time={time} tone={row.result?.error ? 'danger' : undefined}><Op defaultOpen={running && !!output}
        summary={<><span>{search ? 'Tìm' : 'Chạy'} <code className={mono}>{row.command}</code></span>
          {running ? <span className="inline-flex items-center gap-1.5 text-[11.5px] text-running"><StatusDot status="running" className="size-1.5" />đang chạy</span>
            : row.result?.error ? <span className="text-danger">bị chặn / lỗi</span> : row.exitCode !== undefined && row.exitCode !== null && <span className={cn('text-[11.5px]', row.exitCode === 0 ? 'text-muted-foreground' : 'text-danger')}>exit {row.exitCode}</span>}
          {row.durationMs !== undefined && <span className="text-[11.5px] text-muted-foreground">{row.durationMs < 1000 ? `${row.durationMs} ms` : formatDuration(row.durationMs)}</span>}{truncated}</>}
        detail={output ? <Pre className="max-h-56 bg-code text-fg-2"><span className="text-faint">$ {row.command}{'\n'}</span>{output}</Pre> : <p className="m-0 text-[12px] text-muted-foreground">{running ? 'Chưa có output' : 'Không có output'}</p>} /></Entry>;
    }
    case 'tool': return <Entry icon={<Wrench />} time={time}><Op summary={<><span>{row.name ?? 'Công cụ'}</span>{row.result?.error && <span className="text-danger">lỗi</span>}</>} {...(row.text || row.result?.text ? { detail: <div className="flex flex-col gap-1.5">{row.text && <Pre>{row.text}</Pre>}{row.result?.text && <Pre>{row.result.text}</Pre>}</div> } : {})} /></Entry>;
    case 'gap': return <Entry icon={<CircleAlert />} tone="danger" time={time}><div className="text-[12.5px] text-fg-2">Khoảng trống: {row.text}</div></Entry>;
    case 'end': return null;
    default: return null;
  }
}

/** Closing line of the turn: how it ended and what it did; the tokens stay in the sheet header. */
function EndLine({ row, list, start }: { row: Row; list: Row[]; start: number | undefined }) {
  const ok = row.status === 'completed', reads = list.filter(isRead).length, edits = list.filter(item => item.kind === 'edit').length, commands = list.filter(item => item.kind === 'command' && item.action !== 'read').length;
  const did = [reads ? `đọc ${reads} file` : '', edits ? `sửa ${edits} file` : 'không sửa file', commands ? `chạy ${commands} lệnh` : 'không chạy lệnh'].filter(Boolean).join(', ');
  const after = row.t && start !== undefined ? ` sau ${formatDuration(row.t - start)}` : '';
  return <Entry icon={ok ? <CircleCheck /> : <CircleX />} tone={ok ? 'success' : 'danger'} time={<TimeCell row={row} start={start} />}>
    <div className={cn('rounded-lg border px-3 py-2 text-[12.5px]', ok ? 'bg-card text-fg-2' : 'border-transparent bg-danger/12 text-fg-2')}>
      <strong className="font-semibold text-foreground">{ok ? 'Lượt kết thúc' : row.status === 'interrupted' ? 'Lượt bị dừng' : 'Lượt lỗi'}</strong>{ok ? ` ${after.trim()} · ${did}.` : after}
      {row.text && <span className="mt-0.5 block text-danger">{row.text}</span>}</div>
  </Entry>;
}

/**
 * `mode: 'live'` is the feed in the run page: operations only, no messages, reasoning or end line (those stay in the
 * session sheet). `scroll` keeps the newest entry in view while the turn runs.
 */
export function Timeline({ events, filter, following, scroll, mode = 'session', start, maxHeight }: { events: TranscriptEvent[]; filter: Filter; following: boolean; scroll: boolean; mode?: 'live' | 'session'; start?: number | undefined; maxHeight?: string }) {
  const all = useMemo(() => rows(events), [events]), live = mode === 'live';
  const shown = useMemo(() => all.filter(row => matches(row, filter) && (!live || (!isMilestone(row) && row.kind !== 'reasoning' && row.kind !== 'end'))), [all, filter, live]);
  const list = useMemo(() => items(shown), [shown]), ref = useRef<HTMLDivElement>(null);
  const origin = start ?? events.find(event => event.t)?.t, end = filter === 'all' && !live ? all.find(row => row.kind === 'end') : undefined;
  useEffect(() => { if (scroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [list.length, scroll, events.length]);
  return <div ref={ref} className={cn(maxHeight && 'overflow-auto', maxHeight)}>
    <ol className="relative m-0 list-none p-0 before:absolute before:bottom-3 before:left-[9.5px] before:top-3 before:w-px before:bg-border">
      {list.map((item, index) => item.type === 'reads'
        ? <Entry key={`r${item.rows[0]!.i ?? index}`} icon={<FileText />} time={<TimeCell row={item.rows[0]!} start={origin} />}>
          {item.rows.length === 1 ? <Op summary={<span>Đọc <code className={mono}>{readPath(item.rows[0]!)}</code>{item.rows[0]!.result?.error && <span className="ml-2 text-danger">lỗi</span>}</span>}
            {...(item.rows[0]!.result?.text ? { detail: <Pre>{item.rows[0]!.result.text}</Pre> } : {})} />
            : <Op summary={<span className="font-medium text-foreground">Đọc {item.rows.length} file</span>} detail={<ul className="m-0 flex list-none flex-col gap-0.5 p-0">{item.rows.map((row, i) => <li key={i} className={mono}>{readPath(row)}</li>)}</ul>} />}</Entry>
        : <RowView key={`${item.row.i ?? index}-${item.row.id ?? ''}`} row={item.row} start={origin} />)}
      {end && <EndLine row={end} list={all} start={origin} />}
      {following && <Entry icon={<StatusDot status="running" />} tone="running"><div className="text-[12.5px] text-foreground">Agent đang làm việc</div></Entry>}
      {!list.length && !following && !end && <li className="py-3 pl-8 text-[12.5px] text-muted-foreground">Không có sự kiện nào{filter !== 'all' ? ' thuộc loại này' : ''}.</li>}
    </ol>
  </div>;
}
