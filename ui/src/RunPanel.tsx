import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, TriangleAlert, X } from 'lucide-react';
import { Callout } from '@/components/ui/misc';
import { confirmAction } from './dialog';
import { api } from './api';
import { RunList } from './RunList';
import { RunMonitor } from './RunMonitor';
import { RunStart } from './RunStart';
import type { Run, RunSummary } from './runTypes';

const terminal = ['completed', 'cancelled'];

function Dismiss({ onClick }: { onClick(): void }) {
  return <button type="button" aria-label="Đóng" onClick={onClick} className="-my-0.5 ml-2 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3.5" /></button>;
}

/** Runs screen: the list of runs on the left, the selected run or the new-run form on the right (docs/design/mockups/13-runs-v2). */
export function RunPanel({ flowId, flows }: { flowId?: string; flows: { flowId: string; name: string; archived: boolean }[] }) {
  const [run, setRun] = useState<Run | null>(null), [history, setHistory] = useState<RunSummary[]>([]), [error, setError] = useState(''), [stale, setStale] = useState(false);
  async function refresh() { setHistory((await api<{ runs: RunSummary[] }>('/api/runs')).runs.slice().reverse()); }
  useEffect(() => {
    void refresh().catch(e => setError(String(e)));
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  const phase = run?.runtimeState?.phase;
  // Poll the open run while it can still change.
  useEffect(() => {
    if (!run || (phase && terminal.includes(phase) && !run.busy)) return;
    let disposed = false, inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return; inFlight = true;
      void api<Run>(`/api/runs/${run.runId}`).then(value => {
        if (disposed) return;
        setStale(false);
        setRun(value);
        setHistory(items => items.map(item => item.runId === value.runId ? { ...item, phase: value.runtimeState?.phase ?? item.phase, reason: value.runtimeState?.reason ?? item.reason, activeMs: value.runtimeState?.activeMs ?? item.activeMs } : item));
      }).catch(e => { if (!disposed) { setStale(true); setError(String(e)); } }).finally(() => { inFlight = false; });
    }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [run?.runId, phase, run?.busy]);
  const [notice, setNotice] = useState(''), [cleaning, setCleaning] = useState(false);
  /** Remove the worktrees of every finished run that has nothing unsaved; runs with unsaved changes are listed, not touched. */
  async function cleanFinished() {
    if (!await confirmAction({ title: 'Dọn worktree của các run đã xong?', description: 'Commit vẫn được giữ. Run còn thay đổi chưa lưu hoặc đang bận sẽ được bỏ qua và liệt kê lại.', confirmLabel: 'Dọn worktree' })) return;
    setCleaning(true); setError(''); setNotice('');
    try {
      const { results } = await api<{ results: { runId: string; status: string; reason?: string }[] }>('/api/runs/clean', 'POST', { force: false });
      const kept = results.filter(item => item.status === 'kept'), cleaned = results.length - kept.length;
      setNotice(results.length ? `Đã dọn worktree của ${cleaned} run.${kept.length ? ` Giữ ${kept.length} run còn thay đổi chưa lưu hoặc đang bận; mở từng run để dọn.` : ''}` : 'Không có run đã xong nào còn worktree.');
      if (run) setRun(await api<Run>(`/api/runs/${run.runId}`));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setCleaning(false); }
  }
  async function open(runId: string) { setError(''); try { setRun(await api<Run>(`/api/runs/${runId}`)); setStale(false); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }

  return <section className="grid h-full min-h-0 grid-cols-[272px_minmax(0,1fr)] min-[1200px]:grid-cols-[296px_minmax(0,1fr)]">
    <RunList history={history} selectedId={run?.runId} open={id => void open(id)} startNew={() => setRun(null)} cleaning={cleaning} clean={() => void cleanFinished()} />
    <div className="min-h-0 min-w-0 overflow-auto">
      <div className="mx-auto flex max-w-[1040px] flex-col gap-3 px-6 pb-0 pt-5">
        {error && <Callout tone="danger" icon={<CircleAlert />}><div className="flex items-start"><span className="flex-1">{error}</span><Dismiss onClick={() => setError('')} /></div></Callout>}
        {stale && <Callout tone="attention" icon={<TriangleAlert />}><span role="status">Mất kết nối cập nhật run. Trạng thái đang hiển thị có thể đã cũ; hệ thống sẽ thử đồng bộ lại.</span></Callout>}
        {notice && <Callout tone="success" icon={<CircleCheck />}><div className="flex items-start"><span className="flex-1" role="status">{notice}</span><Dismiss onClick={() => setNotice('')} /></div></Callout>}
        {run ? <RunMonitor key={run.runId} run={run} setRun={value => { setRun(value); void refresh(); }} />
          : <RunStart {...(flowId ? { initialFlow: flowId } : {})} flows={flows} history={history} started={value => { setRun(value); void refresh(); }} />}
      </div>
    </div>
  </section>;
}
