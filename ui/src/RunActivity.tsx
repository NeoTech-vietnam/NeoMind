import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { formatDuration, formatTokens } from './format';
import { modelLabel, runnerLabel } from './runners';
import { bindingLabel, type Run } from './runTypes';
import type { TranscriptEvent, TranscriptSummary } from '../../src/core/transcript-types';
import type { Flow } from '../../src/domain/schema';

/** An attempt without a NeoMind transcript (older runs): only the runner's own history can show it. */
type HistoryAttempt = { attemptId: string; nodeId: string; key: string; sessionId: string; attemptStatus: string; runnerTurnId?: string };
type Summary = TranscriptSummary & { attemptStatus: string | null };
export type Listing = { transcripts: Summary[]; history: HistoryAttempt[] };
type Source = 'neomind' | 'runner';
type EventPage = { source: Source; recorded: boolean; events: TranscriptEvent[]; note?: string; runner?: string };
/** What the session viewer opens: an attempt and the source to read it from. */
export type SessionTarget = { attemptId: string; key: string; source: Source };

const roleLabel: Record<string, string> = { plan: 'Lập kế hoạch', read: 'Nghiên cứu', write: 'Sửa code', review: 'Review' };
const time = (t?: number) => t ? new Date(t).toLocaleTimeString('vi-VN', { hour12: false }) : '';
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

/** Events of one attempt; NeoMind's transcript is fetched incrementally while the attempt runs. */
function useEvents(runId: string, attemptId: string, source: Source, following: boolean) {
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
type Row = TranscriptEvent & { result?: TranscriptEvent; live?: string };
function rows(events: TranscriptEvent[]): Row[] {
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

type Filter = 'all' | 'message' | 'edit' | 'command';
const filters: [Filter, string][] = [['all', 'Tất cả'], ['message', 'Tin nhắn'], ['edit', 'Sửa file'], ['command', 'Lệnh']];
const matches = (row: Row, filter: Filter) => filter === 'all' || (filter === 'message' ? ['message', 'reasoning', 'structured_output'].includes(row.kind)
  : filter === 'edit' ? row.kind === 'edit' : row.kind === 'command');

function Diff({ diff }: { diff: string }) {
  return <div className="mdiff">{diff.split('\n').map((line, index) => {
    const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'file' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    return <div key={index} className={`ln ${kind}`}>{line || ' '}</div>;
  })}</div>;
}

function EventRow({ row }: { row: Row }) {
  const truncated = row.truncated || row.result?.truncated ? <span className="ev-meta">· đã rút gọn</span> : null;
  const stamp = <time>{time(row.t)}</time>;
  switch (row.kind) {
    case 'prompt': return <li><span className="ev">›</span><details className="ev-body"><summary>Prompt gửi agent {truncated}</summary><pre className="peek">{row.text}</pre></details>{stamp}</li>;
    case 'message': return <li><span className="ev msg">“</span><div className="ev-body"><div className="ev-line ev-meta">{row.name === 'plan' ? 'Kế hoạch của agent' : 'Tin nhắn agent'}</div><div className="msg-bubble">{row.text}</div></div>{stamp}</li>;
    case 'reasoning': return <li><span className="ev think">∴</span><details className="ev-body reason"><summary>Tóm tắt suy luận</summary><p>{row.text}</p></details>{stamp}</li>;
    case 'read': return <li><span className="ev read">≡</span><details className="ev-body"><summary>Đọc <code>{row.path}</code> {row.text && <span className="ev-meta">{row.text}</span>}{row.result?.error && <span className="exit bad">lỗi</span>} {truncated}</summary>
      {row.result?.text ? <pre className="peek">{row.result.text}</pre> : <p className="ev-meta">Chưa có nội dung</p>}</details>{stamp}</li>;
    case 'search': return <li><span className="ev read">⌕</span><details className="ev-body"><summary>Tìm <code>{row.text}</code>{row.path && <span className="ev-meta">trong {row.path}</span>} {truncated}</summary>
      {row.result?.text && <pre className="peek">{row.result.text}</pre>}</details>{stamp}</li>;
    case 'edit': return <li><span className="ev edit">✎</span><details className="ev-body"><summary>{row.change === 'add' || row.change === 'write' ? 'Tạo/ghi' : row.change === 'delete' ? 'Xóa' : 'Sửa'} <code>{row.path}</code>
      {!!row.added && <span className="add-n">+{row.added}</span>}{!!row.removed && <span className="del-n">−{row.removed}</span>}{row.result?.error && <span className="exit bad">bị từ chối</span>} {truncated}</summary>
      {row.diff ? <Diff diff={row.diff} /> : null}{row.result?.error && <p className="ev-error">{row.result.text}</p>}</details>{stamp}</li>;
    case 'command': {
      const running = row.status === 'running' || row.status === 'inProgress', output = row.text ?? row.live ?? '';
      const label = row.action === 'read' ? <>Đọc <code>{row.path ?? row.command}</code></> : row.action === 'search' ? <>Tìm <code>{row.command}</code></> : <>Chạy <code>{row.command}</code></>;
      return <li><span className={`ev ${row.action === 'read' || row.action === 'search' ? 'read' : 'cmd'}`}>{row.action === 'read' ? '≡' : '$'}</span><details className="ev-body" open={running && !!output}>
        <summary>{label} {running ? <span className="exit run"><i className="pulse" />đang chạy</span> : row.result?.error ? <span className="exit bad">bị chặn / lỗi</span> : row.exitCode !== undefined && row.exitCode !== null && <span className={`exit ${row.exitCode === 0 ? 'ok' : 'bad'}`}>exit {row.exitCode}</span>}
          {row.durationMs !== undefined && <span className="ev-meta">{row.durationMs < 1000 ? `${row.durationMs} ms` : formatDuration(row.durationMs)}</span>} {truncated}</summary>
        {output ? <pre className="term">{output}</pre> : <p className="ev-meta">{running ? 'Chưa có output' : 'Không có output'}</p>}</details>{stamp}</li>;
    }
    case 'structured_output': return <li><span className="ev msg">{'{}'}</span><details className="ev-body"><summary>Kết quả có cấu trúc</summary><pre className="peek">{row.text}</pre></details>{stamp}</li>;
    case 'tool': return <li><span className="ev">•</span><details className="ev-body"><summary>{row.name ?? 'Công cụ'} {row.result?.error && <span className="exit bad">lỗi</span>}</summary><pre className="peek">{row.text}</pre>{row.result?.text && <pre className="peek">{row.result.text}</pre>}</details>{stamp}</li>;
    case 'gap': return <li className="gap"><span className="ev warn">!</span><div className="ev-body ev-line">Khoảng trống: {row.text}</div>{stamp}</li>;
    case 'end': {
      const ok = row.status === 'completed';
      return <li className={ok ? 'end' : 'end bad'}><span className={`ev ${ok ? 'edit' : 'warn'}`}>{ok ? '✓' : '✕'}</span><div className="ev-body ev-line">{ok ? 'Lượt kết thúc' : row.status === 'interrupted' ? 'Lượt bị dừng' : 'Lượt lỗi'}
        {row.usage && <span className="ev-meta"> · {formatTokens(row.usage.totalTokens)} tokens</span>}{row.text && <span className="ev-error"> {row.text}</span>}</div>{stamp}</li>;
    }
    default: return null;
  }
}

function Timeline({ events, filter, following, scroll }: { events: TranscriptEvent[]; filter: Filter; following: boolean; scroll: boolean }) {
  const list = useMemo(() => rows(events).filter(row => matches(row, filter)), [events, filter]), ref = useRef<HTMLOListElement>(null);
  useEffect(() => { if (scroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [list.length, scroll, events.length]);
  return <ol className="tl" ref={ref}>
    {list.map((row, index) => <EventRow key={`${row.i ?? index}-${row.id ?? ''}`} row={row} />)}
    {following && <li className="composing"><span className="ev now"><i /></span><span className="ev-body ev-line">agent đang làm việc<span className="typing"><i /><i /><i /></span></span></li>}
    {!list.length && !following && <li className="ev-meta empty">Không có sự kiện nào{filter !== 'all' ? ' thuộc loại này' : ''}.</li>}
  </ol>;
}

function FilterBar({ filter, setFilter, scroll, setScroll }: { filter: Filter; setFilter(value: Filter): void; scroll?: boolean; setScroll?(value: boolean): void }) {
  return <div className="lane-tools">
    <span className="segmented small">{filters.map(([value, label]) => <button type="button" key={value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>{label}</button>)}</span>
    {setScroll && <button type="button" className="autoscroll" onClick={() => setScroll(!scroll)}><span className={`switch ${scroll ? 'on' : ''}`} />Tự cuộn</button>}
  </div>;
}

const agentOf = (summary: Summary) => `${runnerLabel(summary.meta.runner)} · ${modelLabel(summary.meta.model)}`;
function stats(summary: Summary, now: number) {
  const elapsed = (summary.endedAt ?? now) - (summary.startedAt ?? now);
  return <><span>⏱ <b>{formatDuration(Math.max(0, elapsed))}</b></span>{summary.usage && <span><b>{formatTokens(summary.usage.totalTokens)}</b> tokens</span>}</>;
}
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

/** Live feed of one running attempt. */
function Lane({ runId, summary, flow, now, open }: { runId: string; summary: Summary; flow: Flow | undefined; now: number; open(target: SessionTarget): void }) {
  const [filter, setFilter] = useState<Filter>('all'), [scroll, setScroll] = useState(true);
  const { page } = useEvents(runId, summary.meta.attemptId, 'neomind', true);
  return <section className="lane">
    <div className="lane-head">
      <div className="lane-title"><strong>{bindingLabel(summary.meta.key, flow)}</strong><span className="badge tone-violet"><i className="pulse" />Trực tiếp</span></div>
      <div className="lane-sub"><span className="who">{agentOf(summary)} · {roleLabel[summary.meta.role]}</span></div>
      <div className="lane-stats">{stats(summary, now)}<button type="button" className="lane-open" onClick={() => open({ attemptId: summary.meta.attemptId, key: summary.meta.key, source: 'neomind' })}>Mở session đầy đủ ↗</button></div>
    </div>
    <FilterBar filter={filter} setFilter={setFilter} scroll={scroll} setScroll={setScroll} />
    <Timeline events={page?.events ?? []} filter={filter} following scroll={scroll} />
    <div className="lane-foot"><span className="ico">i</span>{summary.meta.runner === 'codex' ? 'Codex gửi từng sự kiện ngay khi xảy ra; output lệnh theo dòng.' : 'Claude Code gửi theo từng tin nhắn hoàn chỉnh: trễ vài giây.'}</div>
  </section>;
}

/** Collapsed line for a finished attempt: what it changed and ran, with a link to its session. */
function Done({ summary, flow, open }: { summary: Summary; flow: Flow | undefined; open(target: SessionTarget): void }) {
  const ok = summary.status === 'completed', parts = [
    summary.edits ? `${summary.files.length} file sửa${summary.added || summary.removed ? ` (+${summary.added} −${summary.removed})` : ''}` : '',
    summary.reads ? `${summary.reads} lần đọc` : '', summary.commands ? `${summary.commands} lệnh` : '',
    summary.usage ? `${formatTokens(summary.usage.totalTokens)} tokens` : '',
  ].filter(Boolean);
  return <div className="session-line"><span className={`dot tone-${ok ? 'green' : summary.status === 'interrupted' ? 'gray' : 'red'}`} />
    <div className="session-line-text"><strong>{bindingLabel(summary.meta.key, flow)}</strong><small>{agentOf(summary)} · {roleLabel[summary.meta.role]}{parts.length ? ` · ${parts.join(' · ')}` : ''}{ok ? '' : summary.status === 'interrupted' ? ' · bị dừng' : ' · lỗi'}</small>
      {summary.files.length > 0 && <small className="session-files">{summary.files.slice(0, 6).join(', ')}{summary.files.length > 6 ? ` +${summary.files.length - 6}` : ''}</small>}</div>
    <button type="button" className="secondary-btn small" onClick={() => open({ attemptId: summary.meta.attemptId, key: summary.meta.key, source: 'neomind' })}>Xem session</button></div>;
}

/** Running attempts: a transcript without an end is live only while the run itself is running. */
export function liveTranscripts(listing: Listing, active: boolean): Summary[] { return active ? listing.transcripts.filter(live) : []; }

/** Live activity of running agents: two lanes side by side, more as one-line rows the user can expand. */
export function LiveActivity({ run, flow, listing, active, open }: { run: Run; flow: Flow | undefined; listing: Listing; active: boolean; open(target: SessionTarget): void }) {
  const [expanded, setExpanded] = useState<string[]>([]), [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const running = liveTranscripts(listing, active);
  const lanes = running.filter((item, index) => index < 2 || expanded.includes(item.meta.attemptId)), folded = running.filter(item => !lanes.includes(item));
  if (!running.length) return null;
  return <div className="run-card live-card" id="live-activity">
    <div className="card-title"><h3>Hoạt động trực tiếp</h3><span className="muted-inline">{running.length} agent đang chạy · mới nhất ở dưới</span></div>
    <div className={`live-grid ${lanes.length === 1 ? 'single' : ''}`}>{lanes.map(item => <Lane key={item.meta.attemptId} runId={run.runId} summary={item} flow={flow} now={now} open={open} />)}</div>
    {folded.map(item => <div key={item.meta.attemptId} className="session-line folded"><span className="dot tone-violet" />
      <div className="session-line-text"><strong>{bindingLabel(item.meta.key, flow)}</strong><small>{agentOf(item)} · {lastLine(item)}</small></div>
      <button type="button" className="secondary-btn small" onClick={() => setExpanded(list => [...list, item.meta.attemptId])}>Mở luồng</button></div>)}
    <div className="live-foot"><span className="readonly"><i>i</i><span><b>Chỉ xem:</b> dùng Tạm dừng / Hủy run để dừng agent; không gửi chỉ dẫn giữa lượt.</span></span>
      <span className="recorded" title="runs/<runId>/transcripts/<attemptId>.jsonl">● Ghi bởi NeoMind · lưu cùng run</span></div>
  </div>;
}

/** Finished attempts as one-line summaries, and attempts of older runs that only the runner's history can show. */
export function AgentSessions({ flow, listing, active, open }: { flow: Flow | undefined; listing: Listing; active: boolean; open(target: SessionTarget): void }) {
  const running = liveTranscripts(listing, active), finished = listing.transcripts.filter(item => !running.includes(item)), history = listing.history;
  if (!finished.length && !history.length) return null;
  return <div className="run-card">
    <div className="card-title"><h3>Session của agent</h3><span className="muted-inline">{finished.length + history.length} lượt · chỉ xem</span></div>
    {finished.map(item => <Done key={item.meta.attemptId} summary={item} flow={flow} open={open} />)}
    {history.map(item => <div key={item.attemptId} className="session-line"><span className="dot tone-gray" />
      <div className="session-line-text"><strong>{bindingLabel(item.key, flow)}</strong><small>Run cũ: NeoMind chưa ghi transcript · đọc từ session gốc của runner</small></div>
      <button type="button" className="secondary-btn small" onClick={() => open({ attemptId: item.attemptId, key: item.key, source: 'runner' })}>Xem session</button></div>)}
  </div>;
}

/** Latest attempt of a step (its own key or one of its reviewers), for the stepper link. */
export function latestAttempt(listing: Listing, nodeId: string): SessionTarget | undefined {
  const own = (key: string) => key === nodeId || key.startsWith(`${nodeId}/`);
  const recorded = listing.transcripts.filter(item => own(item.meta.key)).at(-1);
  if (recorded) return { attemptId: recorded.meta.attemptId, key: recorded.meta.key, source: 'neomind' };
  const old = listing.history.filter(item => own(item.key)).at(-1);
  return old && { attemptId: old.attemptId, key: old.key, source: 'runner' };
}

/** Read-only viewer of one attempt, with the other attempts of the same step as tabs and a switch to the runner's own history. */
export function SessionDrawer({ run, flow, listing, target, setTarget, close }: { run: Run; flow: Flow | undefined; listing: Listing; target: SessionTarget; setTarget(target: SessionTarget): void; close(): void }) {
  const phase = run.runtimeState?.phase;
  const summary = listing.transcripts.find(item => item.meta.attemptId === target.attemptId);
  const following = target.source === 'neomind' && phase === 'running' && !!summary && !summary.status;
  const { page, error } = useEvents(run.runId, target.attemptId, target.source, following);
  const [filter, setFilter] = useState<Filter>('all');
  const turns = [...listing.transcripts.filter(item => item.meta.key === target.key).map(item => ({ attemptId: item.meta.attemptId, startedAt: item.startedAt, status: item.status ?? 'running' })),
    ...listing.history.filter(item => item.key === target.key).map(item => ({ attemptId: item.attemptId, startedAt: undefined, status: item.attemptStatus }))];
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [close]);
  const events = page?.events ?? [], ended = events.some(event => event.kind === 'end');
  // Gaps: no NeoMind record, a record cut off before its end, or a note from the runner history reader.
  const gap = target.source === 'neomind' && page && !page.recorded ? 'NeoMind không có bản ghi cho lượt này (run tạo trước khi có transcript).'
    : target.source === 'neomind' && page && !following && !ended && events.length > 0 ? 'Bản ghi dừng giữa chừng (tiến trình điều phối dừng trước khi lượt kết thúc).' : page?.note;
  return <div className="drawer-backdrop" onClick={close}>
    <aside className="drawer" role="dialog" aria-label="Session của agent" onClick={event => event.stopPropagation()}>
      <header className="drawer-head">
        <div><h3>{bindingLabel(target.key, flow)}</h3>
          <small>{summary ? `${agentOf(summary)} · ${roleLabel[summary.meta.role]}` : page?.runner ? runnerLabel(page.runner) : ''}{summary?.meta.sessionId && <> · session <code>{summary.meta.sessionId.slice(0, 8)}</code></>}</small></div>
        <button type="button" className="icon-btn" aria-label="Đóng" onClick={close}>×</button>
      </header>
      {turns.length > 1 && <div className="drawer-turns">{turns.map((turn, index) => <button type="button" key={turn.attemptId} className={turn.attemptId === target.attemptId ? 'on' : ''}
        onClick={() => setTarget({ ...target, attemptId: turn.attemptId })}>Lượt {index + 1}{turn.status === 'running' ? ' ●' : ''}</button>)}</div>}
      <div className="drawer-source">
        <span className="segmented small"><button type="button" className={target.source === 'neomind' ? 'on' : ''} onClick={() => setTarget({ ...target, source: 'neomind' })}>NeoMind ghi</button>
          <button type="button" className={target.source === 'runner' ? 'on' : ''} onClick={() => setTarget({ ...target, source: 'runner' })}>Session gốc của runner</button></span>
        <small>{target.source === 'neomind' ? 'Ghi trong lúc chạy, lưu cùng run.' : 'Đọc lại từ lịch sử Codex / Claude Code; có thể đã bị runner dọn.'}</small>
      </div>
      {summary && <div className="drawer-stats">{stats(summary, Date.now())}{summary.edits > 0 && <span>{summary.files.length} file sửa</span>}{summary.commands > 0 && <span>{summary.commands} lệnh</span>}</div>}
      {gap && <div className="callout tone-amber">{gap}{target.source === 'neomind' && <> <button type="button" className="link-btn" onClick={() => setTarget({ ...target, source: 'runner' })}>Xem session gốc</button></>}</div>}
      {error && <div className="callout tone-red">{error}</div>}
      <FilterBar filter={filter} setFilter={setFilter} />
      {!page && !error ? <p className="hint drawer-loading">{target.source === 'runner' ? 'Đang đọc session gốc của runner…' : 'Đang tải…'}</p>
        : <Timeline events={events} filter={filter} following={following} scroll={following} />}
      <footer className="drawer-foot"><span className="ev-meta">Chỉ xem. Không tiếp tục session từ đây: làm vậy agent sẽ chạy ngoài journal và ngoài giới hạn quyền của run.</span></footer>
    </aside>
  </div>;
}
