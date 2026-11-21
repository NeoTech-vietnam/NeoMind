/** Dashboard: per-workflow runs, success rate, time, cost, tokens, gate reject rates, per-step numbers and series (GET /api/stats). */
import { useState, type ReactNode } from 'react';
import { BarChart3, CircleAlert, RefreshCw } from 'lucide-react';
import { api, enc } from './api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { usePoll } from '@/lib/poll';
import { formatCost, formatDuration, formatPercent, formatTokens, kindLabel, runStatusInfo } from './format';
import type { Stats, WorkflowStats } from './types';

const ALL = '__all__';
const th = 'px-2.5 py-1.5 font-semibold', td = 'px-2.5 py-1.5';

/** Runs that ended (not running, not waiting) and the share of them that finished. */
function successRate(stats: Pick<WorkflowStats, 'runs' | 'by_status'>): { rate: number | null; ended: number } {
  const open = (stats.by_status.running ?? 0) + (stats.by_status.waiting ?? 0), ended = stats.runs - open;
  return { rate: ended > 0 ? (stats.by_status.done ?? 0) / ended : null, ended };
}
const seconds = (value: number | null | undefined) => value === null || value === undefined ? '—' : formatDuration(value * 1000);

function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border bg-card px-3.5 py-3">
    <span className="text-[11.5px] text-muted-foreground">{label}</span>
    <span className="truncate text-[19px] font-semibold tabular-nums leading-tight">{value}</span>
    {hint && <span className="truncate text-[11px] text-faint">{hint}</span>}
  </div>;
}

/** A thin bar for a share (0..1); neutral color, the number carries the meaning. */
function Bar({ value }: { value: number | null }) {
  return <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-muted align-middle"><span className="block h-full rounded-full bg-fg-2" style={{ width: `${Math.round((value ?? 0) * 100)}%` }} /></span>;
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <section className="flex flex-col gap-1.5"><h3 className="m-0 text-[13px] font-semibold">{title}{count !== undefined && <span className="ml-1.5 font-normal text-faint">{count}</span>}</h3>{children}</section>;
}

function Cards({ stats }: { stats: Pick<WorkflowStats, 'runs' | 'by_status' | 'median_seconds' | 'total_cost_usd' | 'total_tokens' | 'guardrail_rounds' | 'transient_retries'> }) {
  const { rate, ended } = successRate(stats);
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
    <StatCard label="Số run" value={stats.runs} hint={Object.entries(stats.by_status).filter(([, n]) => n).map(([status, n]) => `${n} ${runStatusInfo(status).label.toLocaleLowerCase()}`).join(' · ')} />
    <StatCard label="Tỉ lệ xong" value={formatPercent(rate)} hint={`trên ${ended} run đã kết thúc`} />
    <StatCard label="Thời gian (trung vị)" value={seconds(stats.median_seconds)} hint={stats.median_seconds === null ? 'xem từng workflow' : 'từ lúc bắt đầu đến lúc kết thúc'} />
    <StatCard label="Chi phí" value={formatCost(stats.total_cost_usd) || '—'} hint={stats.runs ? `TB ${formatCost((stats.total_cost_usd ?? 0) / stats.runs) || '—'}/run` : undefined} />
    <StatCard label="Tokens" value={formatTokens(stats.total_tokens) || '—'} />
    <StatCard label="Vòng check · thử lại" value={`${stats.guardrail_rounds} · ${stats.transient_retries}`} hint="sửa theo check · lỗi tạm thời" />
  </div>;
}

function WorkflowDetail({ stats }: { stats: WorkflowStats }) {
  return <div className="flex flex-col gap-5">
    <Cards stats={stats} />
    <div className="flex flex-wrap gap-1.5">{Object.entries(stats.by_status).map(([status, count]) => <Badge key={status} status={runStatusInfo(status).status}>{runStatusInfo(status).label} {count}</Badge>)}</div>
    <Section title="Gate" count={stats.gates.length}>
      {stats.gates.length ? <div className="overflow-auto rounded-md border"><table className="w-full border-collapse text-[12.5px]">
        <thead><tr className="whitespace-nowrap bg-muted text-left text-[11.5px] text-muted-foreground"><th className={th}>Gate</th><th className={`${th} text-right`}>Duyệt</th><th className={`${th} text-right`}>Từ chối</th><th className={th}>Tỉ lệ từ chối</th></tr></thead>
        <tbody>{stats.gates.map(gate => <tr key={gate.gate} className="border-t">
          <td className={`${td} font-mono text-[11.5px]`}>{gate.gate}</td><td className={`${td} text-right tabular-nums`}>{gate.approve}</td><td className={`${td} text-right tabular-nums`}>{gate.reject}</td>
          <td className={`${td} whitespace-nowrap`}><Bar value={gate.reject_rate} /> <span className="ml-1.5 tabular-nums">{formatPercent(gate.reject_rate)}</span></td></tr>)}</tbody>
      </table></div> : <p className="m-0 text-[12.5px] text-muted-foreground">Workflow này chưa có câu trả lời gate nào.</p>}
    </Section>
    <Section title="Các bước" count={stats.steps.length}>
      {stats.steps.length ? <div className="overflow-auto rounded-md border"><table className="w-full border-collapse text-[12.5px]">
        <thead><tr className="whitespace-nowrap bg-muted text-left text-[11.5px] text-muted-foreground"><th className={th}>Bước</th><th className={th}>Loại</th><th className={`${th} text-right`}>Số lần</th>
          <th className={`${th} text-right`}>Thời gian (trung vị)</th><th className={`${th} text-right`}>Tokens (trung vị)</th><th className={`${th} text-right`}>Chi phí (tổng)</th><th className={`${th} text-right`}>Vòng check</th></tr></thead>
        <tbody>{stats.steps.map(step => <tr key={step.step} className="border-t">
          <td className={`${td} font-mono text-[11.5px]`}>{step.step}</td><td className={`${td} text-muted-foreground`}>{kindLabel(step.kind)}</td><td className={`${td} text-right tabular-nums`}>{step.runs}</td>
          <td className={`${td} whitespace-nowrap text-right tabular-nums`}>{seconds(step.median_seconds)}</td><td className={`${td} text-right tabular-nums`}>{formatTokens(step.median_tokens) || '—'}</td>
          <td className={`${td} text-right tabular-nums`}>{formatCost(step.total_cost_usd) || '—'}</td><td className={`${td} text-right tabular-nums`}>{step.guardrail_rounds || ''}</td></tr>)}</tbody>
      </table></div> : <p className="m-0 text-[12.5px] text-muted-foreground">Chưa có số liệu theo bước.</p>}
    </Section>
    <Section title="Series" count={stats.series.length}>
      {stats.series.length ? <div className="flex flex-wrap gap-1.5">{stats.series.map(item => <Tooltip key={item.series} label={`${item.runs} run (bản sửa) trong series này`}>
        <span className="inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[12px]"><code className="font-mono">{item.series}</code><span className="tabular-nums text-faint">{item.runs}</span></span></Tooltip>)}</div>
        : <p className="m-0 text-[12.5px] text-muted-foreground">Workflow này chưa chạy theo series.</p>}
    </Section>
  </div>;
}

function Overview({ list, pick }: { list: WorkflowStats[]; pick(workflow: string): void }) {
  const sum = list.reduce((acc, item) => {
    acc.runs += item.runs; acc.guardrail_rounds += item.guardrail_rounds; acc.transient_retries += item.transient_retries;
    if (item.total_cost_usd !== null) acc.total_cost_usd = (acc.total_cost_usd ?? 0) + item.total_cost_usd;
    if (item.total_tokens !== null) acc.total_tokens = (acc.total_tokens ?? 0) + item.total_tokens;
    for (const [status, n] of Object.entries(item.by_status)) acc.by_status[status] = (acc.by_status[status] ?? 0) + n;
    return acc;
  }, { runs: 0, by_status: {} as Record<string, number>, median_seconds: null as number | null, total_cost_usd: null as number | null, total_tokens: null as number | null, guardrail_rounds: 0, transient_retries: 0 });
  return <div className="flex flex-col gap-5">
    <Cards stats={sum} />
    <Section title="Theo workflow" count={list.length}>
      <div className="overflow-auto rounded-md border"><table className="w-full border-collapse text-[12.5px]">
        <thead><tr className="whitespace-nowrap bg-muted text-left text-[11.5px] text-muted-foreground"><th className={th}>Workflow</th><th className={`${th} text-right`}>Run</th><th className={`${th} text-right`}>Tỉ lệ xong</th>
          <th className={`${th} text-right`}>Thời gian (trung vị)</th><th className={`${th} text-right`}>Chi phí</th><th className={`${th} text-right`}>Tokens</th><th className={th}>Gate bị từ chối nhiều nhất</th></tr></thead>
        <tbody>{list.map(item => { const worst = [...item.gates].sort((a, b) => (b.reject_rate ?? 0) - (a.reject_rate ?? 0))[0];
          return <tr key={item.workflow} className="cursor-pointer border-t hover:bg-accent" onClick={() => pick(item.workflow)}>
            <td className={`${td} font-mono text-[11.5px]`}>{item.workflow}</td><td className={`${td} text-right tabular-nums`}>{item.runs}</td>
            <td className={`${td} text-right tabular-nums`}>{formatPercent(successRate(item).rate)}</td><td className={`${td} whitespace-nowrap text-right tabular-nums`}>{seconds(item.median_seconds)}</td>
            <td className={`${td} text-right tabular-nums`}>{formatCost(item.total_cost_usd) || '—'}</td><td className={`${td} text-right tabular-nums`}>{formatTokens(item.total_tokens) || '—'}</td>
            <td className={td}>{worst && worst.reject ? <span><code className="font-mono text-[11.5px]">{worst.gate}</code> <span className="text-muted-foreground">{formatPercent(worst.reject_rate)}</span></span> : <span className="text-faint">—</span>}</td></tr>; })}</tbody>
      </table></div>
      <span className="text-[11.5px] text-muted-foreground">Bấm một dòng để xem chi tiết workflow đó.</span>
    </Section>
  </div>;
}

export function DashboardPage() {
  const [workflow, setWorkflow] = useState(ALL), [stats, setStats] = useState<Stats | null>(null), [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState(''), [tick, setTick] = useState(0), [loading, setLoading] = useState(false);
  usePoll(async () => {
    setLoading(true);
    try {
      const value = await api<Stats>(workflow === ALL ? '/api/stats' : `/api/stats?workflow=${enc(workflow)}`);
      setStats(value); setError('');
      if (workflow === ALL) setNames(value.workflows.map(item => item.workflow));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }, 30000, [workflow, tick]);
  const list = stats?.workflows ?? [], current = workflow === ALL ? null : list.find(item => item.workflow === workflow) ?? null;
  const options = [{ value: ALL, label: 'Tất cả workflow' }, ...[...new Set([...names, ...(workflow === ALL ? [] : [workflow])])].sort().map(name => ({ value: name, label: name }))];
  return <div className="h-full overflow-auto"><div className="flex flex-col gap-4 px-6 py-5">
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="m-0 text-[17px] font-semibold">Dashboard</h2>
      <div className="ml-auto flex items-center gap-2">
        <Select label="Workflow" className="w-[240px]" value={workflow} onValueChange={setWorkflow} options={options} />
        <Tooltip label="Đọc lại số liệu"><Button size="icon" aria-label="Đọc lại" onClick={() => setTick(value => value + 1)}><RefreshCw className={loading ? 'animate-spin' : undefined} /></Button></Tooltip>
      </div>
    </header>
    {error && !stats && <EmptyState icon={<CircleAlert />} title="Không đọc được số liệu">{error}</EmptyState>}
    {error && stats && <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />{error}</p>}
    {!stats && !error && <p className="m-0 text-[12.5px] text-muted-foreground">Đang tính số liệu…</p>}
    {stats && !list.length && <EmptyState icon={<BarChart3 />} title="Chưa có run">Số liệu xuất hiện sau khi có run.</EmptyState>}
    {stats && list.length > 0 && (current ? <WorkflowDetail stats={current} /> : workflow === ALL ? <Overview list={list} pick={setWorkflow} /> : <p className="m-0 text-[12.5px] text-muted-foreground">Workflow này chưa có run.</p>)}
    <p className="m-0 text-[11.5px] text-faint">Chi phí: số agent báo (Claude) hoặc tính theo [pricing] trong config.toml; bước không biết giá không được cộng. Số liệu đọc lại mỗi 30 giây.</p>
  </div></div>;
}
