import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, TriangleAlert, X } from 'lucide-react';
import { Callout } from '@/components/ui/misc';
import { confirmAction } from './dialog';
import { api } from './api';
import { RunList } from './RunList';
import { RunMonitor } from './RunMonitor';
import { RunStart } from './RunStart';
import { RunPrograms, type ProgramSummary } from './RunPrograms';
import type { Run, RunSummary } from './runTypes';
import { rerunDraft } from '../../src/domain/rerun';

const terminal = ['completed', 'cancelled'];

function Dismiss({ onClick }: { onClick(): void }) {
  return <button type="button" aria-label="Đóng" onClick={onClick} className="-my-0.5 ml-2 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3.5" /></button>;
}

/** Runs screen: the list of runs on the left, the selected run or the new-run form on the right (docs/design/mockups/13-runs-v2). */
export function RunPanel({ flowId, flows }: { flowId?: string; flows: { flowId: string; name: string; archived: boolean }[] }) {
  const [run, setRun] = useState<Run | null>(null), [history, setHistory] = useState<RunSummary[]>([]), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  // A blocked run restarts as a new run with its flow and task prefilled; the preview and plan approval happen again.
  const [rerun, setRerun] = useState<{ flowId: string; task: string } | null>(null);
  async function refresh() {
    setHistory((await api<{ runs: RunSummary[] }>('/api/runs')).runs.slice().reverse());
    // Programs are optional; an older backend or a broken program file must not hide the runs.
    setPrograms(await api<{ programs: ProgramSummary[] }>('/api/programs').then(value => value.programs, () => []));
  }
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
  /** Delete a run for good after the user confirms; the list then forgets it. */
  async function removeRun(item: RunSummary) {
    if (!await confirmAction({ title: 'Xóa run này?', description: `“${item.task ?? item.runId}”\n\nXóa hẳn journal, transcript, worktree và ref snapshot của run. Thay đổi chưa commit trong run sẽ mất. Không khôi phục được.`, confirmLabel: 'Xóa run', danger: true })) return;
    setError(''); setNotice('');
    try {
      await api(`/api/runs/${item.runId}/delete`, 'POST', {});
      if (run?.runId === item.runId) setRun(null);
      setNotice('Đã xóa run.'); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function removeFinished() {
    const count = history.filter(item => item.phase === 'completed' || item.phase === 'cancelled').length;
    if (!await confirmAction({ title: `Xóa ${count} run đã xong?`, description: 'Xóa hẳn journal, transcript, worktree và ref snapshot của mọi run đã hoàn tất hoặc đã hủy. Thay đổi chưa commit trong các run đó sẽ mất. Run đang chạy, chờ duyệt hoặc bị chặn không bị đụng tới.', confirmLabel: `Xóa ${count} run`, danger: true })) return;
    setCleaning(true); setError(''); setNotice('');
    try {
      const { results } = await api<{ results: { runId: string; status: string; reason?: string }[] }>('/api/runs/delete', 'POST', {});
      const kept = results.filter(item => item.status === 'kept'), deleted = results.length - kept.length;
      if (run && results.some(item => item.runId === run.runId && item.status === 'deleted')) setRun(null);
      setNotice(`Đã xóa ${deleted} run.${kept.length ? ` Không xóa được ${kept.length} run: ${kept.map(item => item.reason).filter(Boolean).slice(0, 2).join('; ')}` : ''}`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setCleaning(false); }
  }
  const rerunFrom = (draft: { flowId: string; task: string }) => { setRerun(draft); setRun(null); };
  async function open(runId: string) { setError(''); setRerun(null); try { setRun(await api<Run>(`/api/runs/${runId}`)); setStale(false); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }

  return <section className="grid h-full min-h-0 grid-cols-[272px_minmax(0,1fr)] min-[1200px]:grid-cols-[296px_minmax(0,1fr)]">
    <RunList history={history} selectedId={run?.runId} open={id => void open(id)} startNew={() => { setRerun(null); setRun(null); }} cleaning={cleaning} clean={() => void cleanFinished()} removeFinished={() => void removeFinished()}
      actions={{ rerun: item => { if (item.flowId && item.task) rerunFrom({ flowId: item.flowId, task: item.task }); }, remove: item => void removeRun(item) }}
      programs={<RunPrograms programs={programs} open={id => void open(id)} changed={id => { void refresh(); if (id) void open(id); }} />} />
    <div className="min-h-0 min-w-0 overflow-auto">
      <div className="mx-auto flex max-w-[1040px] flex-col gap-3 px-6 pb-0 pt-5">
        {error && <Callout tone="danger" icon={<CircleAlert />}><div className="flex items-start"><span className="flex-1">{error}</span><Dismiss onClick={() => setError('')} /></div></Callout>}
        {stale && <Callout tone="attention" icon={<TriangleAlert />}><span role="status">Mất kết nối cập nhật run. Trạng thái đang hiển thị có thể đã cũ; hệ thống sẽ thử đồng bộ lại.</span></Callout>}
        {notice && <Callout tone="success" icon={<CircleCheck />}><div className="flex items-start"><span className="flex-1" role="status">{notice}</span><Dismiss onClick={() => setNotice('')} /></div></Callout>}
        {run ? <RunMonitor key={run.runId} run={run} setRun={value => { setRun(value); void refresh(); }} rerun={() => { const draft = rerunDraft(run); if (draft) rerunFrom(draft); }}
          remove={() => void removeRun({ runId: run.runId, task: run.runtimeContext?.task, phase: run.runtimeState?.phase ?? '', reason: '' })} />
          : <RunStart key={rerun ? `rerun-${rerun.flowId}` : 'new'} {...rerun ? { initialFlow: rerun.flowId, initialTask: rerun.task } : flowId ? { initialFlow: flowId } : {}} flows={flows} history={history} started={value => { setRerun(null); setRun(value); void refresh(); }} />}
      </div>
    </div>
  </section>;
}
