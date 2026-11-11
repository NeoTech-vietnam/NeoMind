import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Lock, MoreHorizontal, PanelRight } from 'lucide-react';
import { Badge, StatusDot, type Status } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Callout } from '@/components/ui/misc';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from './api';
import { formatClock, formatDuration, formatTokens } from './format';
import { modelLabel, runnerLabel } from './runners';
import { bindingLabel, type Run } from './runTypes';
import { countRows, filterLabels, rows, Timeline, useEvents, type Filter, type Source } from './SessionTimeline';
import type { TranscriptEvent, TranscriptSummary } from '../../src/core/transcript-types';
import type { Flow } from '../../src/domain/schema';

/** An attempt without a NeoMind transcript (older runs): only the runner's own history can show it. */
type HistoryAttempt = { attemptId: string; nodeId: string; key: string; sessionId: string; attemptStatus: string; runnerTurnId?: string };
type Summary = TranscriptSummary & { attemptStatus: string | null };
export type Listing = { transcripts: Summary[]; history: HistoryAttempt[] };
/** What the session sheet opens: an attempt and the source to read it from. */
export type SessionTarget = { attemptId: string; key: string; source: Source };

const live = (summary: Summary) => !summary.status;

/** Poll the run's transcript listing while the run can still change. */
export function useTranscripts(runId: string, active: boolean): Listing {
  const [listing, setListing] = useState<Listing>({ transcripts: [], history: [] });
  useEffect(() => {
    let disposed = false;
    const load = () => api<Listing>(`/api/runs/${runId}/transcripts`).then(value => { if (!disposed) setListing(value); }).catch(() => { /* the feed is optional */ });
    void load();
    if (!active) return () => { disposed = true; };
    const timer = setInterval(load, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [runId, active]);
  return listing;
}

const agentOf = (summary: Summary) => `${runnerLabel(summary.meta.runner)} · ${modelLabel(summary.meta.model)}`;
const elapsedOf = (summary: Summary, now: number) => Math.max(0, (summary.endedAt ?? now) - (summary.startedAt ?? now));
const lockNote = 'Chỉ xem. Không tiếp tục session từ đây: làm vậy agent sẽ chạy ngoài journal và ngoài giới hạn quyền của run.';

function lastLine(summary: Summary): string {
  const last = summary.last;
  if (!last) return 'Đang khởi động agent…';
  if (last.kind === 'edit') return `Sửa ${last.path}`;
  if (last.kind === 'read') return `Đọc ${last.path}`;
  if (last.kind === 'command') return last.action === 'read' ? `Đọc ${last.path ?? last.command}` : `Chạy ${last.command}`;
  if (last.kind === 'search') return `Tìm ${last.text}`;
  if (last.kind === 'message') return (last.text ?? '').slice(0, 140);
  if (last.kind === 'reasoning') return 'Đang suy luận';
  return last.kind;
}

/** Tab bar with a count per filter; a tab with nothing in it fades. */
function FilterTabs({ filter, setFilter, counts, kinds, className }: { filter: Filter; setFilter(value: Filter): void; counts: Record<Filter, number>; kinds: Filter[]; className?: string }) {
  return <Tabs value={filter} onValueChange={value => setFilter(value as Filter)}><TabsList className={className}>
    {kinds.map(kind => <TabsTrigger key={kind} value={kind} count={counts[kind]}>{filterLabels[kind]}</TabsTrigger>)}</TabsList></Tabs>;
}

/** Live feed of one running attempt; its events are also handed up so the card's tabs can count across lanes. */
function Lane({ runId, summary, flow, now, filter, scroll, open, report }: { runId: string; summary: Summary; flow: Flow | undefined; now: number; filter: Filter; scroll: boolean; open(target: SessionTarget): void; report(attemptId: string, events: TranscriptEvent[]): void }) {
  const { page } = useEvents(runId, summary.meta.attemptId, 'neomind', true), events = page?.events;
  useEffect(() => { if (events) report(summary.meta.attemptId, events); }, [events, report, summary.meta.attemptId]);
  const file = summary.last?.path;
  return <section className="flex min-w-0 flex-col gap-2 p-4">
    <div className="flex items-center gap-2"><StatusDot status="running" /><strong className="text-[13px]">{bindingLabel(summary.meta.key, flow)}</strong>
      {file && <code className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">{file}</code>}
      <Button className="ml-auto" variant="ghost" size="sm" onClick={() => open({ attemptId: summary.meta.attemptId, key: summary.meta.key, source: 'neomind' })}><PanelRight />Xem session</Button></div>
    <p className="m-0 pl-4 text-[11.5px] text-muted-foreground">{agentOf(summary)} · {formatClock(elapsedOf(summary, now))}{summary.usage ? ` · ${formatTokens(summary.usage.totalTokens)} tokens` : ''}</p>
    <Timeline events={events ?? []} filter={filter} following scroll={scroll} mode="live" start={summary.startedAt} maxHeight="max-h-[360px]" />
    <p className="m-0 pl-[30px] text-[11.5px] text-muted-foreground">{summary.meta.runner === 'codex' ? 'Codex gửi từng sự kiện ngay khi xảy ra; output lệnh theo dòng.' : summary.meta.runner === 'opencode' ? 'OpenCode được đọc lại mỗi giây; mỗi bước hiện khi đã xong.' : 'Claude Code gửi theo từng tin nhắn hoàn chỉnh: trễ vài giây.'}</p>
  </section>;
}

/** Running attempts: a transcript without an end is live only while the run itself is running. */
export function liveTranscripts(listing: Listing, active: boolean): Summary[] { return active ? listing.transcripts.filter(live) : []; }

const liveKinds: Filter[] = ['all', 'edit', 'command'];

/** Live activity of running agents: two lanes side by side, more as one-line rows the user can expand. Operations only. */
export function LiveActivity({ run, flow, listing, active, open }: { run: Run; flow: Flow | undefined; listing: Listing; active: boolean; open(target: SessionTarget): void }) {
  const [expanded, setExpanded] = useState<string[]>([]), [now, setNow] = useState(Date.now()), [filter, setFilter] = useState<Filter>('all'), [scroll, setScroll] = useState(true);
  const [feeds, setFeeds] = useState<Record<string, TranscriptEvent[]>>({});
  const report = useCallback((attemptId: string, events: TranscriptEvent[]) => setFeeds(current => current[attemptId] === events ? current : { ...current, [attemptId]: events }), []);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const running = liveTranscripts(listing, active);
  const lanes = running.filter((item, index) => index < 2 || expanded.includes(item.meta.attemptId)), folded = running.filter(item => !lanes.includes(item));
  const counts = useMemo(() => {
    const total: Record<Filter, number> = { all: 0, message: 0, edit: 0, command: 0 };
    for (const item of lanes) for (const [kind, value] of Object.entries(countRows(rows(feeds[item.meta.attemptId] ?? []), true))) total[kind as Filter] += value;
    return total;
  }, [feeds, lanes.map(item => item.meta.attemptId).join()]);
  if (!running.length) return null;
  return <section className="@container overflow-hidden rounded-lg border bg-card" id="live-activity">
    <div className="flex items-center gap-3 px-4 pt-3.5"><h3 className="m-0 text-[14px] font-semibold">Hoạt động trực tiếp</h3>
      <span className="text-[12px] text-muted-foreground">{running.length} agent đang chạy · mới nhất ở dưới</span>
      <button type="button" role="switch" aria-checked={scroll} onClick={() => setScroll(value => !value)} className="ml-auto flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 font-sans text-[12px] text-fg-2">
        <span className={cn('relative h-4 w-7 rounded-full bg-input transition-colors', scroll && 'bg-primary')}><span className={cn('absolute left-0.5 top-0.5 size-3 rounded-full bg-background transition-transform', scroll && 'translate-x-3 bg-primary-foreground')} /></span>Tự cuộn</button></div>
    <FilterTabs filter={filter} setFilter={setFilter} counts={counts} kinds={liveKinds} className="mt-2 border-b px-4" />
    <div className={cn('grid grid-cols-1', lanes.length > 1 && 'divide-y @[760px]:grid-cols-2 @[760px]:divide-x @[760px]:divide-y-0')}>
      {lanes.map(item => <Lane key={item.meta.attemptId} runId={run.runId} summary={item} flow={flow} now={now} filter={filter} scroll={scroll} open={open} report={report} />)}</div>
    {folded.map(item => <div key={item.meta.attemptId} className="flex items-center gap-2.5 border-t px-4 py-2.5"><StatusDot status="running" />
      <div className="min-w-0 flex-1 text-[12.5px]"><strong>{bindingLabel(item.meta.key, flow)}</strong><span className="ml-2 text-muted-foreground">{agentOf(item)} · {lastLine(item)}</span></div>
      <Button size="sm" onClick={() => setExpanded(list => [...list, item.meta.attemptId])}>Mở luồng</Button></div>)}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2.5 text-[11.5px] text-muted-foreground"><Lock className="size-3.5" />
      <span className="min-w-0 flex-1">Chỉ xem: dùng Tạm dừng hoặc Hủy run để dừng agent; không gửi chỉ dẫn giữa lượt.</span>
      <Tooltip label="runs/<runId>/transcripts/<attemptId>.jsonl"><span className="text-faint">Ghi bởi NeoMind · lưu cùng run</span></Tooltip></div>
  </section>;
}

/** One line per step that has a session: its latest agent, how many turns, and a way in. Rows only; the caller supplies the card. */
export function AgentSessions({ flow, listing, active, open }: { flow: Flow | undefined; listing: Listing; active: boolean; open(target: SessionTarget): void }) {
  const running = liveTranscripts(listing, active), finished = listing.transcripts.filter(item => !running.includes(item));
  const keys = [...new Set([...finished.map(item => item.meta.key), ...listing.history.map(item => item.key)])];
  if (!keys.length) return null;
  return <>{keys.map(key => {
    const turns = finished.filter(item => item.meta.key === key), last = turns.at(-1), old = listing.history.filter(item => item.key === key);
    const target: SessionTarget | undefined = last ? { attemptId: last.meta.attemptId, key, source: 'neomind' } : old.at(-1) && { attemptId: old.at(-1)!.attemptId, key, source: 'runner' };
    const count = turns.length + old.length, failed = last?.status && last.status !== 'completed' && last.status !== 'interrupted';
    return <button key={key} type="button" disabled={!target} onClick={() => target && open(target)} className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-4 py-2 text-left font-sans text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
      <PanelRight className="size-3.5 shrink-0 text-muted-foreground" /><span className="font-medium">{bindingLabel(key, flow)}</span>
      <span className="min-w-0 truncate text-[12px] text-muted-foreground">{last ? agentOf(last) : 'Run cũ · đọc từ session gốc của runner'} · {count} lượt{last?.edits ? ` · ${last.files.length} file sửa` : ''}{failed ? ' · lỗi' : ''}</span>
      <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">Xem session</span></button>;
  })}</>;
}

/** Latest attempt of a step (its own key or one of its reviewers), for the stepper link. */
export function latestAttempt(listing: Listing, nodeId: string): SessionTarget | undefined {
  const own = (key: string) => key === nodeId || key.startsWith(`${nodeId}/`);
  const recorded = listing.transcripts.filter(item => own(item.meta.key)).at(-1);
  if (recorded) return { attemptId: recorded.meta.attemptId, key: recorded.meta.key, source: 'neomind' };
  const old = listing.history.filter(item => own(item.key)).at(-1);
  return old && { attemptId: old.attemptId, key: old.key, source: 'runner' };
}

/** Badge of a turn: transcript statuses are completed/interrupted/failed, attempt statuses from the journal differ slightly. */
function turnBadge(status: string | undefined, following: boolean): { label: string; status: Status } {
  if (following || status === 'running') return { label: 'Đang chạy', status: 'running' };
  if (status === 'completed' || status === 'succeeded') return { label: 'Xong', status: 'success' };
  if (status === 'interrupted' || status === 'cancelled') return { label: 'Bị dừng', status: 'idle' };
  return status ? { label: 'Lỗi', status: 'danger' } : { label: 'Chưa rõ', status: 'idle' };
}

const sessionKinds: Filter[] = ['all', 'message', 'edit', 'command'];

/** Read-only viewer of one attempt, in a sheet on the right; the other attempts of the step are one menu away. */
export function SessionSheet({ run, flow, listing, target, setTarget, close }: { run: Run; flow: Flow | undefined; listing: Listing; target: SessionTarget; setTarget(target: SessionTarget): void; close(): void }) {
  const phase = run.runtimeState?.phase;
  const summary = listing.transcripts.find(item => item.meta.attemptId === target.attemptId);
  const following = target.source === 'neomind' && phase === 'running' && !!summary && !summary.status;
  const { page, error } = useEvents(run.runId, target.attemptId, target.source, following);
  const [filter, setFilter] = useState<Filter>('all');
  const turns = [...listing.transcripts.filter(item => item.meta.key === target.key).map(item => ({ attemptId: item.meta.attemptId, startedAt: item.startedAt, status: item.status ?? 'running' })),
    ...listing.history.filter(item => item.key === target.key).map(item => ({ attemptId: item.attemptId, startedAt: undefined as number | undefined, status: item.attemptStatus }))];
  const turnIndex = Math.max(0, turns.findIndex(turn => turn.attemptId === target.attemptId));
  const events = page?.events ?? [], ended = events.some(event => event.kind === 'end'), counts = useMemo(() => countRows(rows(events), false), [events]);
  // Gaps: no NeoMind record, a record cut off before its end, or a note from the runner history reader.
  const gap = target.source === 'neomind' && page && !page.recorded ? 'NeoMind không có bản ghi cho lượt này (run tạo trước khi có transcript).'
    : target.source === 'neomind' && page && !following && !ended && events.length > 0 ? 'Bản ghi dừng giữa chừng (tiến trình điều phối dừng trước khi lượt kết thúc).' : page?.note;
  const badge = turnBadge(turns[turnIndex]?.status, following);
  const sourceItem = (source: Source, label: string, help: string) => <DropdownMenuItem onSelect={() => setTarget({ ...target, source })} className="h-auto items-start py-1.5">
    <Check className={cn('mt-0.5 shrink-0', target.source !== source && 'invisible')} /><span><span className="block text-foreground">{label}</span><span className="block text-[11.5px] text-muted-foreground">{help}</span></span></DropdownMenuItem>;
  const meta = summary ? [modelLabel(summary.meta.model), formatDuration(elapsedOf(summary, Date.now())), summary.usage ? `${formatTokens(summary.usage.totalTokens)} tokens` : ''].filter(Boolean).join(' · ')
    : page?.runner ? runnerLabel(page.runner) : '';
  return <Dialog open onOpenChange={value => { if (!value) close(); }}>
    <SheetContent className="w-[580px]" title={<><span className="truncate">{bindingLabel(target.key, flow)}</span><Badge status={badge.status}>{badge.label}</Badge></>}
      actions={<><Tooltip label={lockNote}><span className="inline-grid size-7 place-items-center text-muted-foreground" aria-label={lockNote}><Lock className="size-4" /></span></Tooltip>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Tùy chọn session"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent className="w-72"><div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Nguồn ghi</div>
            {sourceItem('neomind', 'NeoMind ghi', 'Ghi trong lúc chạy, lưu cùng run.')}<DropdownMenuSeparator />
            {sourceItem('runner', 'Session gốc của runner', 'Đọc lại từ lịch sử Codex / Claude Code / OpenCode; có thể đã bị runner dọn.')}</DropdownMenuContent></DropdownMenu></>}
      subheader={<div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12.5px] text-muted-foreground">
        {turns.length > 1 && <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm">Lượt {turnIndex + 1}/{turns.length}<ChevronDown /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">{turns.map((turn, index) => { const state = turnBadge(turn.status, false);
            return <DropdownMenuItem key={turn.attemptId} onSelect={() => setTarget({ ...target, attemptId: turn.attemptId })}><Check className={cn(turn.attemptId !== target.attemptId && 'invisible')} />Lượt {index + 1}
              <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><StatusDot status={turn.status === 'running' ? 'running' : state.status} />{state.label}</span></DropdownMenuItem>; })}</DropdownMenuContent></DropdownMenu>}
        {target.source === 'runner' && <span className="rounded bg-muted px-1.5 text-[11.5px] text-fg-2">Session gốc</span>}
        {meta && <Tooltip label={`${summary ? agentOf(summary) : ''}${summary?.meta.sessionId ? ` · session ${summary.meta.sessionId.slice(0, 8)}` : ''}`.replace(/^ · /, '')}><span>{meta}</span></Tooltip>}</div>}>
      <div className="sticky top-0 z-10 border-b bg-background px-4 pt-1"><FilterTabs filter={filter} setFilter={setFilter} counts={counts} kinds={sessionKinds} className="border-b-0" /></div>
      <div className="flex flex-col gap-3 px-4 py-3">
        {gap && <Callout tone="attention">{gap}{target.source === 'neomind' && <> <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[12.5px] text-foreground underline" onClick={() => setTarget({ ...target, source: 'runner' })}>Xem session gốc</button></>}</Callout>}
        {error && <Callout tone="danger">{error}</Callout>}
        {!page && !error ? <p className="m-0 py-6 text-center text-[12.5px] text-muted-foreground">{target.source === 'runner' ? 'Đang đọc session gốc của runner…' : 'Đang tải…'}</p>
          : <Timeline events={events} filter={filter} following={following} scroll={following} start={summary?.startedAt} />}
      </div>
    </SheetContent>
  </Dialog>;
}
