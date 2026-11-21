import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleSlash, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import { api, enc } from './api';
import { confirmAction } from './dialog';
import { CopyButton } from '@/components/CopyButton';
import { Badge, Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout, EmptyState } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { usePoll } from '@/lib/poll';
import { formatDuration, kindLabel, parseTime, relativeTime, runStatusInfo, shortTime, stepStateInfo, fileName } from './format';
import { GateCard } from './GateCard';
import { LiveLog } from './LiveLog';
import { MemoryTable, useRunMemory } from './MemoryTable';
import { RunGraph } from './RunGraph';
import { Stepper } from './Stepper';
import { StepPanel } from './StepPanel';
import { TranscriptSheet } from './Transcript';
import { OutputsTab, useOutputs } from './Outputs';
import { costTitle, sourceLabel, stepRounds, stepUsage, TotalsChips } from './usage';
import { formatCost, formatTokens, totalTokens } from './format';
import type { MemoryEntry, RunDetail, StepInfo } from './types';
import { BindingSummary } from './catalog/StepBinding';
import { DeleteRunButton } from './DeleteRuns';

const jobNames: Record<string, string> = { start: 'bắt đầu run', answer: 'trả lời gate', continue: 'chạy tiếp' };

export const isActive = (run: { status: string; busy: boolean }) => run.busy || run.status === 'running' || run.status === 'waiting';

/** The open run, read every second while it is active (every 3 s once it ended). */
function useRun(name: string) {
  const [run, setRun] = useState<RunDetail | null>(null), [error, setError] = useState(''), [tick, setTick] = useState(0);
  useEffect(() => { setRun(null); setError(''); }, [name]);
  usePoll(async () => {
    try { setRun(await api<RunDetail>(`/api/runs/${enc(name)}`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, run && !isActive(run) ? 3000 : 1000, [name, tick]);
  return { run, error, refresh: () => setTick(value => value + 1) };
}

/** Short detail shown inside a graph node (route taken, loop round, workers). */
function nodeDetail(info: StepInfo): string | undefined {
  if (info.route) return `→ ${info.route}`;
  if (info.workers) return info.workers;
  if (info.round !== undefined) return `vòng ${info.round}`;
  if (info.seconds !== undefined) return `${Math.round(info.seconds)} s`;
  return undefined;
}

function detailText(info: StepInfo): string {
  const parts: string[] = [];
  if (info.model) parts.push(info.model);
  if (info.effort) parts.push(`effort ${info.effort}`);
  if (info.seconds !== undefined) parts.push(`${info.seconds} s`);
  if (info.route) parts.push(`route → ${info.route}`);
  if (info.round !== undefined) parts.push(`vòng ${info.round}`);
  if (info.decision) parts.push(info.decision);
  if (info.items !== undefined) parts.push(`${info.items} item`);
  if (info.collected !== undefined) parts.push(`gộp ${info.collected}`);
  if (info.workers) parts.push(`workers ${info.workers}`);
  if (info.by) parts.push(`bởi ${info.by}`);
  if (info.note) parts.push(`ghi chú: ${info.note}`);
  if (info.path) parts.push(fileName(info.path));
  if (info.error) parts.push(`lỗi: ${info.error.slice(0, 120)}`);
  return parts.join(' · ');
}

function StepsTable({ run, select }: { run: RunDetail; select(id: string): void }) {
  const nodes = (run.graph?.nodes ?? []).filter(node => node.kind !== 'start' && node.kind !== 'end');
  const th = 'px-2.5 py-1.5 font-semibold';
  return <div className="overflow-auto rounded-md border"><table className="w-full border-collapse text-[12.5px]">
    <thead><tr className="whitespace-nowrap bg-muted text-left text-[11.5px] text-muted-foreground"><th className={th}>#</th><th className={th}>Bước</th><th className={th}>Loại</th>
      <th className={th}>Role · skill</th><th className={th}>Trạng thái</th><th className={th}>Bắt đầu</th><th className={th}>Kết thúc</th>
      <th className={`${th} text-right`}>Tokens</th><th className={`${th} text-right`}>Chi phí</th>
      <th className={th}><Tooltip label="Lần sửa do check (guardrail) · lần thử lại do lỗi tạm thời (rate limit, mạng)"><span>Sửa · thử lại</span></Tooltip></th>
      <th className={th}>Chi tiết</th></tr></thead>
    <tbody>{nodes.map((node, index) => { const state = run.states[node.id] ?? 'todo', info = run.info[node.id] ?? {}, label = stepStateInfo(state);
      const usage = stepUsage(run, node.id), rounds = stepRounds(run, node.id);
      return <tr key={node.id} className="cursor-pointer border-t align-top hover:bg-accent" onClick={() => select(node.id)}>
        <td className="px-2.5 py-1.5 tabular-nums text-faint">{index + 1}</td><td className="px-2.5 py-1.5 font-mono text-[11.5px]">{node.id}</td><td className="px-2.5 py-1.5 text-muted-foreground">{kindLabel(node.kind)}</td>
        <td className="whitespace-nowrap px-2.5 py-1.5">{node.kind === 'ai' || node.kind === 'worker' ? <BindingSummary role={node.role} skills={node.skills} mode={info.role_mode} skillMode={info.skill_mode} resume={info.retry_mode === 'resume'} contractOff={info.contract === false && !!(node.role || node.skills?.length)} /> : ''}</td>
        <td className="px-2.5 py-1.5"><Badge status={state === 'rejected' ? 'idle' : label.status}>{label.label}</Badge></td>
        <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">{shortTime(info.start)}</td><td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">{shortTime(info.end)}</td>
        <td className="whitespace-nowrap px-2.5 py-1.5 text-right tabular-nums" title={usage ? costTitle(usage) : undefined}>{usage ? formatTokens(totalTokens(usage)) : ''}</td>
        <td className="whitespace-nowrap px-2.5 py-1.5 text-right tabular-nums" title={usage ? sourceLabel(usage.sources) : undefined}>{usage ? (usage.costKnown ? formatCost(usage.cost_usd) : '?') : ''}</td>
        <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">{rounds.checks || rounds.retries ? <span className={rounds.retries ? 'text-attention' : undefined}>{rounds.checks} · {rounds.retries}</span> : ''}</td>
        <td className="px-2.5 py-1.5 text-fg-2">{detailText(info)}</td></tr>; })}</tbody>
  </table></div>;
}

/** "Dừng run": running (the agent process is killed) or waiting at a gate (ends at once). */
function StopButton({ run, onStopped }: { run: RunDetail; onStopped(): void }) {
  const [sending, setSending] = useState(false), [requested, setRequested] = useState(false), [error, setError] = useState('');
  const stoppable = run.status === 'running' || run.status === 'waiting';
  useEffect(() => { if (!stoppable) { setRequested(false); setSending(false); } }, [stoppable]);
  if (!stoppable) return null;
  const stop = async () => {
    const waiting = run.status === 'waiting';
    const ok = await confirmAction({
      title: `Dừng run ${run.run}?`, danger: true, confirmLabel: 'Dừng run',
      description: waiting ? `Run đang chờ ở gate ${run.gate ?? ''}; dừng sẽ kết thúc nó ngay, không duyệt cũng không từ chối.\nSau đó vẫn có thể "Chạy tiếp" từ gate này.`
        : `Bước ${run.step ?? ''} đang chạy sẽ bị cắt (agent bị dừng cả cây tiến trình); phần việc dở của bước này mất.\nSau đó có thể "Chạy tiếp": bước bị cắt chạy lại từ đầu.`,
    });
    if (!ok) return;
    setSending(true); setError('');
    try { await api(`/api/runs/${enc(run.run)}/cancel`, 'POST'); setRequested(true); onStopped(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSending(false); }
  };
  return <span className="inline-flex items-center gap-2">
    <Button size="sm" variant="danger" disabled={sending || requested} onClick={() => void stop()}>{requested ? <LoaderCircle className="animate-spin" /> : <Square />}{requested ? 'Đang dừng…' : 'Dừng run'}</Button>
    {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
  </span>;
}

function Header({ run, onChanged, onDeleted }: { run: RunDetail; onChanged(): void; onDeleted(run: string): void }) {
  const info = runStatusInfo(run.status), started = parseTime(run.started), updated = parseTime(run.updated);
  const elapsed = !Number.isNaN(started) ? (isActive(run) ? Date.now() : Number.isNaN(updated) ? Date.now() : updated) - started : NaN;
  const args = Object.entries(run.args ?? {});
  return <header className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="m-0 font-mono text-[17px] font-semibold">{run.run}</h2><CopyButton text={run.run} label="Sao chép tên run" />
      <Badge status={info.status}>{info.label}</Badge><Tag>{run.workflow}</Tag>{run.series && <Tooltip label="Series memory dùng chung giữa các run"><Tag>series {run.series}</Tag></Tooltip>}
      <TotalsChips totals={run.totals} />
      {run.busy && <span className="inline-flex items-center gap-1 text-[12px] text-running"><LoaderCircle className="size-3.5 animate-spin" />server đang chạy run này</span>}
      <span className="ml-auto inline-flex items-center gap-2"><StopButton run={run} onStopped={onChanged} /><DeleteRunButton run={run} onDeleted={onDeleted} /></span>
    </div>
    <p className="m-0 text-[12px] text-muted-foreground">{[run.step && isActive(run) ? `bước hiện tại ${run.step}` : '', run.started ? `bắt đầu ${shortTime(run.started)}` : '',
      !Number.isNaN(elapsed) ? `${isActive(run) ? 'đã chạy' : 'chạy'} ${formatDuration(elapsed)}` : '', run.updated ? `cập nhật ${relativeTime(run.updated)}` : ''].filter(Boolean).join(' · ')}</p>
    {args.length > 0 && <div className="flex flex-wrap gap-1.5">{args.map(([key, value]) => <Tag key={key} className="h-auto max-w-full whitespace-normal break-all py-0.5 font-mono text-[11px]">{key}={typeof value === 'string' ? value : JSON.stringify(value)}</Tag>)}</div>}
  </header>;
}

/** One run: status, gate card, failure with "continue", graph with step details, live log, steps table and memory. */
export function RunView({ name, approver, answeredAs, onChanged, onDeleted }: { name: string; approver?: string | undefined; answeredAs?: string | undefined; onChanged(): void; onDeleted(run: string): void }) {
  const { run, error, refresh } = useRun(name), [selected, setSelected] = useState<string | null>(null), [transcript, setTranscript] = useState<string | null>(null);
  const [tab, setTab] = useState('log'), [continuing, setContinuing] = useState(false), [actionError, setActionError] = useState('');
  useEffect(() => { setSelected(null); setTranscript(null); setActionError(''); setTab('log'); }, [name]);
  const active = !!run && isActive(run), { memory, error: memoryError, refresh: refreshMemory } = useRunMemory(name, active);
  const { outputs, error: outputsError } = useOutputs(name, active);
  const memoryEntries = useMemo<(MemoryEntry & { key: string })[]>(() => {
    const own = Object.entries(memory?.run ?? {}).map(([key, entry]) => ({ ...entry, key }));
    const recent = (run?.memory_recent ?? []).filter(entry => entry.key && !own.some(item => item.key === entry.key)).map(entry => ({ ...entry, key: entry.key! }));
    return [...own, ...recent];
  }, [memory, run?.memory_recent]);
  const [graphView, setGraphView] = useState<'graph' | 'steps'>(() => { try { return localStorage.getItem('langflow.graphView') === 'steps' ? 'steps' : 'graph'; } catch { return 'graph'; } });
  useEffect(() => { try { localStorage.setItem('langflow.graphView', graphView); } catch { /* storage may be off */ } }, [graphView]);
  const details = useMemo(() => Object.fromEntries(Object.entries(run?.info ?? {}).flatMap(([id, info]) => { const text = nodeDetail(info); return text ? [[id, text]] : []; })), [run?.info]);
  if (!run) return error ? <EmptyState icon={<CircleAlert />} title="Không đọc được run">{error}</EmptyState> : <p className="m-0 p-6 text-[12.5px] text-muted-foreground">Đang mở run…</p>;
  const continueRun = async () => {
    setContinuing(true); setActionError('');
    try { await api(`/api/runs/${enc(run.run)}/continue`, 'POST'); refresh(); onChanged(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); } finally { setContinuing(false); }
  };
  const canContinue = (run.status === 'failed' || run.status === 'stopped' || run.status === 'cancelled') && !run.busy;
  const cancelled = run.status === 'cancelled' ? [...(run.history ?? [])].reverse().find(event => event.kind === 'run' && event.event === 'cancelled') : undefined;
  const rawActive = run.status === 'waiting' ? run.gate ?? run.step : run.status === 'running' || run.status === 'failed' ? (run.step ?? null) : null;
  const activeStep = rawActive ? rawActive.replace(/\[\d+\]$/, '_worker') : null;  // fan-out workers log as name[i]
  return <div className="flex flex-col gap-4 px-6 py-5">
    <Header run={run} onChanged={() => { refresh(); onChanged(); }} onDeleted={onDeleted} />
    {error && <Callout tone="danger" icon={<CircleAlert />}>Mất kết nối khi cập nhật: {error}</Callout>}
    {run.status === 'cancelled' && <Callout tone="hint" icon={<Square />}>
      <div className="flex flex-col gap-2">
        <span>Run đã bị dừng{run.step ? <> tại bước <code className="font-mono">{run.step}</code></> : null}{typeof cancelled?.by === 'string' && cancelled.by ? ` (bởi ${cancelled.by})` : ''}{cancelled?.time ? `, ${shortTime(cancelled.time)}` : ''}.</span>
        <div className="flex items-center gap-2"><Button size="sm" disabled={!canContinue || continuing} onClick={() => void continueRun()}>{continuing ? <RefreshCw className="animate-spin" /> : <Play />}Chạy tiếp từ bước bị cắt</Button>
          <span className="text-[11.5px] text-muted-foreground">Bước bị cắt chạy lại từ đầu; run chờ ở gate thì quay lại gate đó.</span></div>
        {actionError && <span className="text-danger">{actionError}</span>}
      </div></Callout>}
    {run.status === 'waiting' && <GateCard run={run} approver={approver ?? run.approver} answeredAs={answeredAs} onAnswered={() => { refresh(); onChanged(); }} />}
    {(run.status === 'failed' || run.status === 'stopped') && <Callout tone={run.status === 'failed' ? 'danger' : 'attention'} icon={<CircleAlert />}>
      <div className="flex flex-col gap-2">
        <span>{run.status === 'failed' ? <>Lỗi tại bước <code className="font-mono">{run.step}</code></> : <>Run dừng giữa chừng tại <code className="font-mono">{run.step}</code></>}</span>
        {run.error && <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px]">{run.error}</pre>}
        <div className="flex items-center gap-2"><Button variant="primary" size="sm" disabled={!canContinue || continuing} onClick={() => void continueRun()}>{continuing ? <RefreshCw className="animate-spin" /> : <Play />}Chạy tiếp từ bước này</Button>
          <span className="text-[11.5px] text-muted-foreground">Sửa nguyên nhân trước; bước lỗi sẽ chạy lại từ đầu.</span></div>
        {actionError && <span className="text-danger">{actionError}</span>}
      </div></Callout>}
    {run.job?.finished && run.job.message && (run.job.state === 'error' || (run.job.state === 'failed' && run.status !== 'failed')) && <Callout tone="attention" icon={<CircleAlert />}>
      Lần xử lý gần nhất của server ({jobNames[run.job.action] ?? run.job.action}, {shortTime(run.job.finished)}) không thành công: <span className="whitespace-pre-wrap">{run.job.message}</span></Callout>}
    {run.status === 'rejected' && <Callout tone="hint" icon={<CircleSlash />}>Run kết thúc vì bị từ chối ở gate.</Callout>}
    {run.status === 'running' && !run.busy && <Callout tone="hint" icon={<LoaderCircle />}>
      <div className="flex flex-col gap-2"><span>Server này không chạy run này: nó đang chạy trong một tiến trình khác (CLI hoặc TUI), hoặc tiến trình đó đã dừng giữa chừng. Trang này chỉ theo dõi.</span>
        <div><Button size="sm" disabled={continuing} onClick={() => void (async () => {
          if (await confirmAction({ title: `Chạy tiếp run ${run.run} từ server này?`, description: `Chỉ làm khi chắc chắn không còn tiến trình nào chạy run này; nếu không, bước ${run.step ?? ''} sẽ chạy hai lần cùng lúc.`, confirmLabel: 'Chạy tiếp', danger: true })) await continueRun();
        })()}><Play />Chạy tiếp (run bị cắt ngang)</Button></div>
        {actionError && <span className="text-danger">{actionError}</span>}</div></Callout>}
    {run.graph && <div className="@container"><div className="grid grid-cols-1 gap-3 @[820px]:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="inline-flex self-start rounded-md border p-0.5 text-[12px]">
          <Button size="sm" variant="ghost" className={graphView === 'graph' ? 'h-6 bg-accent px-2.5 text-foreground' : 'h-6 px-2.5'} onClick={() => setGraphView('graph')}>Sơ đồ</Button>
          <Button size="sm" variant="ghost" className={graphView === 'steps' ? 'h-6 bg-accent px-2.5 text-foreground' : 'h-6 px-2.5'} onClick={() => setGraphView('steps')}>Tiến độ</Button>
        </div>
        {graphView === 'graph'
          ? <RunGraph graph={run.graph} states={run.states} info={run.info} details={details} selected={selected} active={activeStep} onSelect={setSelected} />
          : <Stepper graph={run.graph} states={run.states} info={run.info} details={details} selected={selected} active={activeStep} onSelect={setSelected} />}
      </div>
      <aside className="max-h-[520px] overflow-auto rounded-md border p-3" aria-live="polite">
        {selected ? <StepPanel run={run} node={selected} memory={memoryEntries} openTranscript={setTranscript} />
          : <p className="m-0 text-[12.5px] text-muted-foreground">Chọn một bước trên sơ đồ để xem model, thời gian, file đã ghi, lỗi, memory và transcript.</p>}
      </aside>
    </div></div>}
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList><TabsTrigger value="log">Log</TabsTrigger><TabsTrigger value="steps" count={(run.graph?.nodes.length ?? 2) - 2}>Các bước</TabsTrigger>
        <TabsTrigger value="outputs" {...(outputs ? { count: outputs.length } : {})}>Đầu ra</TabsTrigger>
        <TabsTrigger value="memory" count={memoryEntries.length + (memory?.series.length ?? 0)}>Memory</TabsTrigger></TabsList>
      <TabsContent value="log" className="pt-3"><LiveLog run={run.run} active={active} /></TabsContent>
      <TabsContent value="steps" className="pt-3"><StepsTable run={run} select={id => setSelected(id)} /></TabsContent>
      <TabsContent value="outputs" className="pt-3"><OutputsTab run={run} outputs={outputs} error={outputsError} openTranscript={setTranscript} /></TabsContent>
      <TabsContent value="memory" className="pt-3"><MemoryTable run={run.run} workflow={run.workflow} memory={memory} error={memoryError} series={run.series} busy={run.busy} refresh={refreshMemory} /></TabsContent>
    </Tabs>
    <TranscriptSheet run={run.run} step={transcript} onClose={() => setTranscript(null)} />
  </div>;
}
