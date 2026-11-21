import type { ReactNode } from 'react';
import { FileText, Lock, ScrollText } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { Badge, Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCost, formatDuration, formatTokens, kindLabel, shortTime, stepStateInfo, totalTokens } from './format';
import { sourceLabel, stepRounds, stepUsage, tokenBreakdown } from './usage';
import type { HistoryEvent, MemoryEntry, RunDetail, StepInfo, StepState } from './types';
import { asRecorded } from './catalog/api';
import { openCatalog } from './catalog/nav';
import { RunBindingSection, StepBindingSection, type RanWith } from './catalog/StepBinding';
import { RetryModeBadge } from './catalog/BindingBadges';

/** Phase 2b: the binding a step ran with: info[step].binding, else its last start event (a worker node: its first worker). */
function recordedBinding(info: { binding?: unknown }, history: HistoryEvent[], node: string) {
  if (asRecorded(info.binding)) return info.binding;
  const base = node.endsWith('_worker') ? node.slice(0, -'_worker'.length) : null;
  const start = [...history].reverse().find(event => event.event === 'start' && event.binding !== undefined && (event.step === node || (base !== null && event.step?.startsWith(`${base}[`))));
  return start?.binding;
}

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;

/** Native phase 1 + 2: what a step ran with besides its binding: role_mode / contract / skill_mode / retry_mode (start
 *  event), role_channel / skill_channel / skills_loaded / resumes / denials (done event) and the skills that fell back
 *  (`native fallback` events after the last start). A worker node reads its workers' events (view.step_states keeps
 *  only the start fields for them); `denials` is read from the done event for every node (view does not copy it). */
function ranWith(info: StepInfo, history: HistoryEvent[], node: string, agent: string | undefined): RanWith & { skill_mode: string | null; retry_mode: string | null; resumes: number | null; denials: number | null; resume_failed: number; resumed_rounds: number } {
  const base = node.endsWith('_worker') ? node.slice(0, -'_worker'.length) : null;
  const mine = (event: HistoryEvent) => event.step === node || (base !== null && !!event.step?.startsWith(`${base}[`));
  const lastStart = history.reduce((at, event, index) => event.event === 'start' && mine(event) ? index : at, -1);
  const since = lastStart < 0 ? [] : history.slice(lastStart).filter(mine);
  const start = lastStart < 0 ? undefined : history[lastStart];
  const done = [...since].reverse().find(event => event.event === 'done');
  const fallbacks = since.filter(event => event.event === 'native fallback');
  const fellBack = info.native_fallback ?? [...new Set(fallbacks.flatMap(event => strings(event.skills) ?? []))];
  const fallbackVia = [...fallbacks].reverse().find(event => typeof event.via === 'string')?.via as string | undefined;
  const num = (value: unknown) => typeof value === 'number' ? value : null;
  return {
    agent: agent ?? null,
    role_mode: info.role_mode ?? (typeof start?.role_mode === 'string' ? start.role_mode : null),
    contract: info.contract ?? (typeof start?.contract === 'boolean' ? start.contract : null),
    role_channel: info.role_channel ?? (typeof done?.role_channel === 'string' ? done.role_channel : null),
    skill_mode: info.skill_mode ?? (typeof start?.skill_mode === 'string' ? start.skill_mode : null),
    retry_mode: info.retry_mode ?? (typeof start?.retry_mode === 'string' ? start.retry_mode : null),
    skill_channel: info.skill_channel ?? (typeof done?.skill_channel === 'string' ? done.skill_channel : null),
    skills_loaded: info.skills_loaded ?? strings(done?.skills_loaded),
    resumes: info.resumes ?? num(done?.resumes),
    denials: num(done?.denials) ?? info.denials ?? null,
    native_fallback: fellBack, fallback_via: fallbackVia ?? null,
    resume_failed: since.filter(event => event.event === 'resume failed').length,
    resumed_rounds: since.filter(event => event.event === 'check failed' && event.resumed === true).length,
  };
}

/** The extra text of one step event in the "Sự kiện của bước" list (phase 2: native fallback, resumed retries). */
function eventDetail(event: HistoryEvent): ReactNode {
  const text = (value: unknown, length = 160) => typeof value === 'string' && value ? value.slice(0, length) : '';
  if (event.event === 'native fallback') return <><span className="text-attention"> {(strings(event.skills) ?? []).join(', ')} → {text(event.via) || '?'}</span></>;
  if (event.event === 'check failed') return <>{typeof event.attempt === 'number' ? ` #${event.attempt}` : ''}
    {typeof event.resumed === 'boolean' && <span className={event.resumed ? 'text-fg-2' : 'text-faint'}> · {event.resumed ? 'resumed' : 'fresh'}</span>}
    {text(event.feedback) && <span className="text-faint"> · {text(event.feedback)}</span>}</>;
  if (event.event === 'resume failed') return <span className="text-attention"> · gọi lại mới{text(event.error) ? `: ${text(event.error)}` : ''}</span>;
  if (event.event === 'retry') return <span className="text-faint">{typeof event.attempt === 'number' ? ` #${event.attempt}` : ''}{text(event.error) ? ` · ${text(event.error, 100)}` : ''}</span>;
  if (event.event === 'done' && typeof event.resumes === 'number' && event.resumes > 0) return <span className="text-faint"> · {event.resumes} resume</span>;
  return null;
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="m-0 min-w-0 break-words">{children}</dd></div>;
const Pre = ({ children }: { children: ReactNode }) => <pre className="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2 font-mono text-[11.5px]">{children}</pre>;
const show = (value: unknown) => value === null || value === undefined || value === '' ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Fan-out workers log as "<fanout>[i]"; the graph has one node "<fanout>_worker" for all of them. */
function workers(history: HistoryEvent[], node: string, transcripts: RunDetail['transcripts']) {
  if (!node.endsWith('_worker')) return [];
  const base = node.slice(0, -'_worker'.length), byIndex = new Map<string, { step: string; state: StepState; seconds?: number; transcript?: string; model?: string; error?: string }>();
  for (const event of history) {
    const match = event.step ? /^(.*)\[(\d+)\]$/.exec(event.step) : null;
    if (!match || match[1] !== base) continue;
    const item = byIndex.get(match[2]!) ?? { step: event.step!, state: 'running' as StepState };
    if (event.event === 'start') { item.state = 'running'; if (typeof event.model === 'string') item.model = event.model; }
    else if (event.event === 'done') { item.state = 'done'; if (typeof event.seconds === 'number') item.seconds = event.seconds; if (typeof event.transcript === 'string') item.transcript = event.transcript; }
    else if (event.event === 'failed') { item.state = 'failed'; if (typeof event.error === 'string') item.error = event.error; }
    byIndex.set(match[2]!, item);
  }
  return [...byIndex.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, item]) => ({ ...item, ...(transcripts?.[item.step] ? { transcript: transcripts[item.step]!.path } : {}) }));
}

/** Everything the run recorded about one step: model, times, file written, gate answer, error, memory, transcript. */
export function StepPanel({ run, node, memory, openTranscript }: { run: RunDetail; node: string; memory: (MemoryEntry & { key: string })[]; openTranscript(step: string): void }) {
  const kind = run.graph?.nodes.find(item => item.id === node)?.kind ?? '?', state = run.states[node] ?? 'todo', info = run.info[node] ?? {};
  const history = run.history ?? [], events = history.filter(event => event.step === node);
  const start = [...events].reverse().find(event => event.event === 'start');
  const agent = info.agent ?? run.transcripts?.[node]?.agent ?? (typeof start?.agent === 'string' ? start.agent : undefined), argv = Array.isArray(start?.argv) ? (start.argv as string[]) : undefined;
  const error = info.error ?? (run.status === 'failed' && run.step === node ? run.error : undefined);
  const locks = (run.locks ?? []).filter(lock => lock.until === node), stepMemory = memory.filter(entry => entry.step === node), list = workers(history, node, run.transcripts);
  const transcript = run.transcripts?.[node]?.path ?? info.transcript;
  const stateInfo = stepStateInfo(state), usage = stepUsage(run, node), rounds = stepRounds(run, node);
  const isAi = kind === 'ai' || kind === 'worker', binding = isAi ? recordedBinding(info, history, node) : undefined, ran = !!asRecorded(binding);
  const drift = info.binding_changes ?? undefined;  // workers: compared with the catalog in RunBindingSection
  const ranInfo = isAi ? ranWith(info, history, node, agent) : null;
  return <div className="flex flex-col gap-3 text-[12.5px]">
    <div>
      <div className="flex items-center gap-2"><h4 className="m-0 truncate font-mono text-[13px] font-semibold">{node}</h4><Badge status={state === 'rejected' ? 'idle' : stateInfo.status}>{stateInfo.label}</Badge></div>
      <p className="m-0 mt-0.5 text-muted-foreground">{kindLabel(kind)}{agent && ` · ${agent}`}</p>
    </div>
    {transcript && <Button size="sm" className="self-start" onClick={() => openTranscript(node)}><ScrollText />Xem transcript</Button>}
    <dl className="m-0 grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1">
      {info.model && <Row label="Model">{info.model}</Row>}
      {info.effort && <Row label="Effort">{info.effort}</Row>}
      {info.start && <Row label="Bắt đầu">{shortTime(info.start)}</Row>}
      {info.end && <Row label="Kết thúc">{shortTime(info.end)}</Row>}
      {info.seconds !== undefined && <Row label="Thời gian">{formatDuration(info.seconds * 1000)}</Row>}
      {show(info.hooks) && <Row label="Hooks">{show(info.hooks)}</Row>}
      {info.session && <Row label="Session"><span className="font-mono text-[11.5px]">{info.session}</span></Row>}
      {info.route && <Row label="Route">→ {info.route}</Row>}
      {info.round !== undefined && <Row label="Vòng">{info.round}</Row>}
      {info.passed !== undefined && <Row label="Đạt">{info.passed ? 'có' : 'không'}</Row>}
      {info.decision && <Row label="Quyết định">{info.decision}</Row>}
      {info.items !== undefined && <Row label="Số item">{info.items}</Row>}
      {info.collected !== undefined && <Row label="Đã gộp">{info.collected}</Row>}
      {info.workers && <Row label="Workers">{info.workers}</Row>}
      {info.by && <Row label="Trả lời bởi">{info.by}</Row>}
      {state === 'cancelled' && <Row label="Bị dừng">{info.end ? shortTime(info.end) : 'có'}{info.cancelled_by ? ` · bởi ${info.cancelled_by}` : ''}</Row>}
      {info.note && <Row label="Ghi chú">{info.note}</Row>}
      {info.attempt !== undefined && <Row label="Lần sửa">{info.attempt}</Row>}
      {info.feedback && <Row label="Check">{info.feedback}</Row>}
      {usage && <Row label="Tokens"><span className="tabular-nums">{formatTokens(totalTokens(usage))}</span>{tokenBreakdown(usage) && <span className="block text-[11.5px] text-muted-foreground">{tokenBreakdown(usage)}</span>}</Row>}
      {usage && <Row label="Chi phí"><span className="tabular-nums">{usage.costKnown ? formatCost(usage.cost_usd) : 'chưa biết'}</span>
        <span className="block text-[11.5px] text-muted-foreground">{usage.costKnown ? sourceLabel(usage.sources) : 'agent không báo; thêm [pricing."<model>"] vào config.toml'}{usage.calls > 1 ? ` · ${usage.calls} lần gọi` : ''}</span></Row>}
      {info.attempts !== undefined && info.attempts > 1 && <Row label="Số lần chạy">{info.attempts}</Row>}
      {rounds.checks > 0 && <Row label="Vòng check">{rounds.checks} lần sửa theo check{rounds.lastFeedback && <span className="block text-[11.5px] text-muted-foreground">gần nhất: {rounds.lastFeedback.slice(0, 200)}</span>}</Row>}
      {ranInfo && (ranInfo.retry_mode === 'resume' || (ranInfo.resumes ?? 0) > 0) && <Row label="Resume"><span className="inline-flex flex-wrap items-center gap-1.5">
        <RetryModeBadge mode="resume" /><span className={ranInfo.resumes ? '' : 'text-muted-foreground'}>{ranInfo.resumes ?? 0} lần gọi tiếp tục session</span></span>
        <span className="block text-[11.5px] text-muted-foreground">lần chạy gần nhất của bước{ranInfo.resumed_rounds ? ` · ${ranInfo.resumed_rounds} vòng check chọn resume` : ' · chưa có vòng check nào'}</span>
        {ranInfo.resume_failed > 0 && <span className="block text-[11.5px] text-attention">{ranInfo.resume_failed} lần resume lỗi → gọi lại mới với cả prompt</span>}</Row>}
      {ranInfo?.skills_loaded && ranInfo.skills_loaded.length > 0 && <Row label="Skill đã nạp"><span className="font-mono text-[11.5px]">{ranInfo.skills_loaded.join(', ')}</span>
        <span className="block text-[11.5px] text-muted-foreground">skill native CLI đã nạp (kiểm tra sau lần gọi)</span></Row>}
      {ranInfo?.denials ? <Row label="Bị từ chối"><span className="text-attention">{ranInfo.denials} lần dùng tool bị từ chối quyền</span></Row> : null}
      {rounds.retries > 0 && <Row label="Thử lại"><span className="text-attention">{rounds.retries} lần do lỗi tạm thời</span>
        {rounds.lastRetryError && <span className="block text-[11.5px] text-muted-foreground">gần nhất{rounds.lastRetryWait !== undefined ? ` (chờ ${rounds.lastRetryWait} s)` : ''}: {rounds.lastRetryError.slice(0, 200)}</span>}</Row>}
    </dl>
    {isAi && ran && <RunBindingSection binding={binding} serverChanges={drift} onOpenCatalog={openCatalog()} {...(ranInfo ? { ran: ranInfo } : {})} />}
    {isAi && <StepBindingSection workflow={run.workflow} step={node} onOpenCatalog={openCatalog()} {...(ran ? { title: 'Role và skill hiện tại', note: 'Áp dụng khi bước này chạy lại (chạy tiếp) hoặc ở run sau.' } : {})} />}
    {info.path && <div><strong className="flex items-center gap-1.5"><FileText className="size-3.5" />File đã ghi</strong>
      <div className="mt-1 flex items-center gap-1"><code className="min-w-0 flex-1 break-all font-mono text-[11.5px]">{info.path}</code><CopyButton text={info.path} label="Sao chép đường dẫn" /></div></div>}
    {argv && <div><strong>Lệnh</strong><Pre>{argv.join(' ')}</Pre></div>}
    {state === 'waiting' && run.question && <div><strong>Câu hỏi ở gate</strong><p className="m-0 mt-1 whitespace-pre-wrap">{run.question}</p></div>}
    {error && <div><strong className="text-danger">Lỗi</strong><Pre>{error}</Pre></div>}
    {locks.map((lock, index) => <div key={index} className="rounded-md border px-2.5 py-2"><strong className="flex items-center gap-1.5"><Lock className="size-3.5" />Khóa đến khi gate này được duyệt</strong>
      <p className="m-0 mt-1 text-muted-foreground">{lock.reason}</p>
      {lock.paths.length > 0 && <p className="m-0 mt-1 font-mono text-[11px]">{lock.paths.join(', ')}</p>}
      {lock.commands.length > 0 && <p className="m-0 mt-1 font-mono text-[11px]">{lock.commands.join(', ')}</p>}
      <p className="m-0 mt-1">{run.passed?.includes(node) ? 'Đã mở (gate đã duyệt).' : 'Đang khóa.'}</p></div>)}
    {list.length > 0 && <div><strong>Workers</strong><ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">{list.map(item => {
      const workerInfo = stepStateInfo(item.state);
      return <li key={item.step} className="flex items-center gap-2"><Badge status={workerInfo.status}>{workerInfo.label}</Badge><code className="font-mono text-[11.5px]">{item.step}</code>
        {item.seconds !== undefined && <span className="text-muted-foreground">{formatDuration(item.seconds * 1000)}</span>}
        {item.transcript && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openTranscript(item.step)}><ScrollText />Transcript</Button>}</li>;
    })}</ul></div>}
    {stepMemory.length > 0 && <div><strong>Memory bước này ghi</strong><ul className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0">{stepMemory.map(entry =>
      <li key={entry.key} className="rounded-md border px-2.5 py-1.5"><div className="flex items-center gap-1.5"><code className="font-mono text-[11.5px]">{entry.key}</code><Tag>{entry.scope ?? 'run'}</Tag></div><p className="m-0 mt-0.5 leading-relaxed">{entry.text}</p></li>)}</ul></div>}
    {events.length > 0 && <details className="border-t pt-1.5"><summary className="cursor-pointer py-1 font-medium">Sự kiện của bước <span className="font-normal text-faint">{events.length}</span></summary>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-[11px]">{events.map((event, index) => <li key={index} className="break-words"><span className="text-faint">{shortTime(event.time)}</span> {event.kind} {event.event}{eventDetail(event)}</li>)}</ul></details>}
    {!events.length && state === 'todo' && <p className="m-0 text-muted-foreground">Bước này chưa chạy.</p>}
  </div>;
}
