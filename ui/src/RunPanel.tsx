import { useEffect, useState } from 'react';
import { api } from './api';
import { formatDuration, phaseInfo } from './format';
import { RunMonitor } from './RunMonitor';
import { RunStart } from './RunStart';
import type { Run, RunSummary } from './runTypes';

const terminal = ['completed', 'cancelled'];

export function RunPanel({ flowId, flows }: { flowId?: string; flows: { flowId: string; name: string; archived: boolean }[] }) {
  const [run, setRun] = useState<Run | null>(null), [history, setHistory] = useState<RunSummary[]>([]), [error, setError] = useState('');
  const [flowFilter, setFlowFilter] = useState(''), [phaseFilter, setPhaseFilter] = useState(''), [dateFilter, setDateFilter] = useState(''), [stale, setStale] = useState(false);
  const visibleHistory = history.filter(item => (!flowFilter || item.flowId === flowFilter) && (!phaseFilter || item.phase === phaseFilter)
    && (!dateFilter || (!!item.createdAt && new Date(item.createdAt).toLocaleDateString('en-CA') === dateFilter)));
  async function refresh() { setHistory((await api<{ runs: RunSummary[] }>('/api/runs')).runs.slice().reverse()); }
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
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
    setCleaning(true); setError(''); setNotice('');
    try {
      const { results } = await api<{ results: { runId: string; status: string; reason?: string }[] }>('/api/runs/clean', 'POST', { force: false });
      const kept = results.filter(item => item.status === 'kept'), cleaned = results.length - kept.length;
      setNotice(results.length ? `Đã dọn worktree của ${cleaned} run.${kept.length ? ` Giữ ${kept.length} run còn thay đổi chưa lưu hoặc đang bận; mở từng run để dọn.` : ''}` : 'Không có run đã xong nào còn worktree.');
      if (run) setRun(await api<Run>(`/api/runs/${run.runId}`));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setCleaning(false); }
  }
  async function open(runId: string) { setError(''); try { setRun(await api<Run>(`/api/runs/${runId}`)); setStale(false); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }

  return <section className="runs-page">
    <div className="page-heading"><div><h1>Runs</h1><p>Giao việc cho agent, duyệt kế hoạch và theo dõi tới khi có commit.</p></div></div>
    {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
    {stale && <div className="alert error" role="status">Mất kết nối cập nhật run. Trạng thái đang hiển thị có thể đã cũ; hệ thống sẽ thử đồng bộ lại.</div>}
    {notice && <div className="alert success" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}
    <div className="runs-layout">
      <aside className="runs-history">
        <button className={`new-run ${run ? '' : 'selected'}`} onClick={() => setRun(null)}>＋ Run mới</button>
        <div className="history-title">Lịch sử</div>
        <label>Flow<select aria-label="Lọc lịch sử theo flow" value={flowFilter} onChange={e => setFlowFilter(e.target.value)}><option value="">Tất cả flow</option>{[...new Map(history.filter(item => item.flowId).map(item => [item.flowId!, item.flowName || item.flowId!])).entries()].map(([id, name]) => <option key={id} value={id}>{name} · {id}</option>)}</select></label>
        <label>Trạng thái<select aria-label="Lọc lịch sử theo trạng thái" value={phaseFilter} onChange={e => setPhaseFilter(e.target.value)}><option value="">Tất cả trạng thái</option>{[...new Set(history.map(item => item.phase))].map(phase => <option key={phase} value={phase}>{phaseInfo(phase).label}</option>)}</select></label>
        <label>Ngày bắt đầu<input type="date" aria-label="Lọc lịch sử theo ngày bắt đầu" value={dateFilter} onChange={e => setDateFilter(e.target.value)} /></label>
        {history.some(item => terminal.includes(item.phase)) && <button type="button" className="history-clean" disabled={cleaning} onClick={() => void cleanFinished()}
          title="Xóa worktree của các run đã xong; commit vẫn giữ, run còn thay đổi chưa lưu thì bỏ qua">{cleaning ? 'Đang dọn…' : 'Dọn worktree run đã xong'}</button>}
        {history.length === 0 && <p className="muted-inline">Chưa có run nào.</p>}
        {visibleHistory.map(item => { const info = phaseInfo(item.phase);
          return <button key={item.runId} className={`run-history-item ${run?.runId === item.runId ? 'selected' : ''}`} onClick={() => void open(item.runId)}>
            <span className={`dot tone-${info.tone}`} /><span className="history-text"><strong>{item.task || item.runId}</strong>
              <small>{info.label}{item.flowName ? ` · ${item.flowName}` : ''}{item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString()}` : ''}{item.activeMs ? ` · ${formatDuration(item.activeMs)}` : ''}</small></span></button>; })}
      </aside>
      <div className="run-content">{run ? <RunMonitor run={run} setRun={value => { setRun(value); void refresh(); }} />
        : <RunStart {...(flowId ? { initialFlow: flowId } : {})} flows={flows} started={value => { setRun(value); void refresh(); }} />}</div>
    </div>
  </section>;
}
