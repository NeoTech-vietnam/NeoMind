import { api } from './api';
import { RunLessons } from './RunLessons';
import { useEffect, useState } from 'react';
import type { Flow } from '../../src/domain/schema';
type MaterializedRun = { configuration: { flow: Flow; bindings: Record<string, { values: { runner: string; provider: string; model: string; reasoning: string } }> } };
type Plan = { goal: string; approach: string; scope: string[]; acceptanceCriteria: string[]; checks: string[]; riskChanges: string[] };

type Run = { bindingSelections: { key: string; values: { model: string; reasoning: string }; reason: string }[]; timeLimitMs?: number; timeExtensionsMs: number; usage: { totalTokens: number | null; partial: boolean }; unresolvedCommitNodeIds: string[]; acceptedReviews: { nodeId: string }[]; proposedPlanHash?: string; runId: string; busy: boolean; runtimeState?: { phase: string; reason: string; activeMs: number };
  runtimeContext?: { task: string; workspace: string }; snapshot?: MaterializedRun;
  graph: { nodes: Record<string, { status: string }> }; plans: { nodeId: string; plan: Plan }[];
  checks: { checkId: string; command: string; status: string }[];
  reviewerOutputs: { attemptId: string; summary: string; result: { reviewerId: string; verdict: string } }[];
  artifacts: { nodeId: string; kind: string; text: string }[] };
type Preview = { runtimeDiagnostics: string[]; snapshot: MaterializedRun; configurationHash: string; sourceHead: string; dirtyPaths: string[]; gitDelivery: string };
type Summary = { runId: string; task: string; phase: string; reason: string };
const phaseNames: Record<string, string> = { running: 'Đang chạy', waiting_approval: 'Chờ duyệt kế hoạch', paused: 'Tạm dừng', blocked: 'Cần xử lý', completed: 'Hoàn tất', cancelled: 'Đã hủy', recovering: 'Chờ tiếp tục', stopping: 'Đang dừng' };

export function RunPanel({ flowId, flows }: { flowId?: string; flows: { flowId: string; name: string; archived: boolean }[] }) {
  const [selectedFlow, setSelectedFlow] = useState(flowId ?? 'dev'), [task, setTask] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [configDirty, setConfigDirty] = useState(false);
  const [limits, setLimits] = useState<{ activeTimeSeconds?: number; maxConcurrency?: number; maxRepairRounds?: number }>({});
  const [overrides, setOverrides] = useState<Record<string, { model?: string; reasoning?: string }>>({});
  const [run, setRun] = useState<Run | null>(null), [history, setHistory] = useState<Summary[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [planFeedback, setPlanFeedback] = useState(''), [extraSeconds, setExtraSeconds] = useState(600);
  useEffect(() => { if (flowId) { setSelectedFlow(flowId); setPreview(null); setOverrides({}); setLimits({}); } }, [flowId]);
  async function refresh() {
    const list = await api<{ runs: Summary[] }>('/api/runs'); setHistory(list.runs.slice().reverse());
  }
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
  useEffect(() => {
    if (!run) return;
    let disposed = false, inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return; inFlight = true;
      void api<Run>(`/api/runs/${run.runId}`).then(value => { if (!disposed) { setRun(value); setHistory(items => items.map(item => item.runId === value.runId ? { ...item, phase: value.runtimeState?.phase ?? item.phase, reason: value.runtimeState?.reason ?? item.reason } : item)); } }).catch(e => { if (!disposed) setError(String(e)); }).finally(() => { inFlight = false; });
    }, 1200);
    return () => { disposed = true; clearInterval(timer); };
  }, [run?.runId]);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function loadPreview() {
    const value = await api<Preview>('/api/runs/preview', 'POST', { flowId: selectedFlow, overrides, limits }); setPreview(value); setConfigDirty(false);
  }
  const allFlows = [...flows.filter(flow => !flow.archived), ...['dev', 'fast', 'research'].filter(id => !flows.some(flow => flow.flowId === id)).map(id => ({ flowId: id, name: `${id} · template`, archived: false }))];
  const phase = run?.runtimeState?.phase ?? 'recovering';
  const plan = run?.plans.at(-1)?.plan;
  const timeLimitMs = run?.timeLimitMs ?? (run?.snapshot?.configuration.flow.definition.limits.activeTimeSeconds ?? 0) * 1000 + (run?.timeExtensionsMs ?? 0);
  const timeExhausted = !!run && timeLimitMs > 0 && (run.runtimeState?.activeMs ?? 0) >= timeLimitMs;
  return <section className="runs-page">
    <div className="page-heading"><div><h1>Chạy và theo dõi flow</h1><p>Chọn phiên bản đã lưu, xem cấu hình thực tế rồi bắt đầu.</p></div><button className="secondary-btn" onClick={() => { setRun(null); setPreview(null); }}>＋ Run mới</button></div>
    {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
    <div className="runs-layout"><aside className="runs-history"><h3>Lịch sử</h3>{history.length === 0 && <p>Chưa có run.</p>}{history.map(item => <button key={item.runId} className={`run-history-item ${run?.runId === item.runId ? 'selected' : ''}`} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${item.runId}`)); })}><strong>{item.task || item.runId}</strong><small>{phaseNames[item.phase] ?? item.phase}</small></button>)}</aside>
    <div className="run-content">{!run ? <div className="run-card"><h2>Bắt đầu công việc</h2><label>Flow<select aria-label="Flow" value={selectedFlow} onChange={e => { setSelectedFlow(e.target.value); setPreview(null); setOverrides({}); setLimits({}); }}>{allFlows.map(flow => <option key={flow.flowId} value={flow.flowId}>{flow.name}</option>)}</select></label>
      <label>Yêu cầu<textarea rows={4} value={task} onChange={e => setTask(e.target.value)} placeholder="Mô tả tính năng hoặc vấn đề cần xử lý…" /></label>
      <button className="secondary-btn" disabled={busy} onClick={() => void action(loadPreview)}>{configDirty ? 'Cập nhật cấu hình' : 'Xem cấu hình thực tế'}</button>
      {preview && <><div className="section-rule" /><h3>{preview.snapshot.configuration.flow.name} · v{preview.snapshot.configuration.flow.version}</h3>
        <label>Workspace<select aria-label="Workspace" value="isolated" onChange={() => {}}><option value="isolated">Tạo worktree riêng từ HEAD hiện tại</option></select></label>
        <div className="run-bindings"><label>Thời gian xử lý (giây)<input type="number" min="1" value={limits.activeTimeSeconds ?? preview.snapshot.configuration.flow.definition.limits.activeTimeSeconds} onChange={e => { setLimits(value => ({ ...value, activeTimeSeconds: Number(e.target.value) })); setConfigDirty(true); }} /></label><label>Agent đồng thời<input type="number" min="1" value={limits.maxConcurrency ?? preview.snapshot.configuration.flow.definition.limits.maxConcurrency} onChange={e => { setLimits(value => ({ ...value, maxConcurrency: Number(e.target.value) })); setConfigDirty(true); }} /></label></div>
        <p className="run-note">Baseline: {preview.sourceHead.slice(0, 12)}. Thời gian xử lý: {preview.snapshot.configuration.flow.definition.limits.activeTimeSeconds}s. Tối đa {preview.snapshot.configuration.flow.definition.limits.maxRepairRounds} vòng sửa.</p>
        {preview.dirtyPaths.length > 0 && <details><summary>{preview.dirtyPaths.length} thay đổi ở checkout hiện tại; worktree mới lấy từ commit HEAD</summary><pre>{preview.dirtyPaths.join('\n')}</pre></details>}
        <div className="run-bindings">{Object.entries(preview.snapshot.configuration.bindings).map(([key, binding]) => <div key={key} className="run-binding"><strong>{key}</strong><small>{binding.values.runner} · {binding.values.provider}</small><label>Model<select aria-label="Model" value={overrides[key]?.model ?? binding.values.model} onChange={e => { setOverrides(value => ({ ...value, [key]: { ...value[key], model: e.target.value } })); setConfigDirty(true); }}>{[...new Set([binding.values.model, 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'])].map(model => <option key={model}>{model}</option>)}</select></label><label>Mức suy luận<select aria-label="Mức suy luận" value={overrides[key]?.reasoning ?? binding.values.reasoning} onChange={e => { setOverrides(value => ({ ...value, [key]: { ...value[key], reasoning: e.target.value } })); setConfigDirty(true); }}>{[...new Set([binding.values.reasoning, 'low', 'medium', 'high'])].map(reasoning => <option key={reasoning}>{reasoning}</option>)}</select></label></div>)}</div>
        <p className="run-note">Chỉ commit local sau khi kiểm tra đạt. Commit dùng tree đã review; Git hooks không chạy trong đường thực thi này. Các checks trong kế hoạch được chạy trước review.</p>
        {preview.runtimeDiagnostics.length > 0 && <div className="alert error">{preview.runtimeDiagnostics.join(' ')}</div>}
        <button className="primary-btn" disabled={busy || configDirty || !task.trim() || preview.runtimeDiagnostics.length > 0} onClick={() => void action(async () => {
          setRun(await api<Run>('/api/runs', 'POST', { flowId: selectedFlow, task, overrides, limits, configurationHash: preview.configurationHash }));
        })}>{busy ? 'Đang chuẩn bị…' : '▶ Bắt đầu khảo sát'}</button></>}
    </div> : <>
      <div className="run-card"><div className="run-title"><div><span className={`run-phase phase-${phase}`}>{phaseNames[phase] ?? phase}</span><h2>{run.runtimeContext?.task}</h2></div><small>{Math.floor((run.runtimeState?.activeMs ?? 0) / 1000)}s xử lý · {run.usage.totalTokens === null ? 'token: chưa đo được' : `${run.usage.totalTokens.toLocaleString()} tokens${run.usage.partial ? ' (một phần)' : ''}`} · chi phí: chưa đo được</small></div><p>{run.acceptedReviews.length > 0 && phase !== 'completed' ? 'Kiểm tra đạt · ' : ''}{run.runtimeState?.reason}</p>
        <div>{run.bindingSelections.map((selection, index) => <p className="run-note" key={index}>{selection.key}: {selection.values.model} · {selection.values.reasoning}. {selection.reason}</p>)}</div><div className="run-controls">{run.unresolvedCommitNodeIds.length > 0 && <button className="primary-btn" disabled={busy || run.busy} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${run.runId}/retry_git`, 'POST')); })}>Thử commit lại</button>}{['paused', 'blocked', 'recovering'].includes(phase) && run.unresolvedCommitNodeIds.length === 0 && !timeExhausted && <button className="primary-btn" disabled={busy || run.busy} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${run.runId}/resume`, 'POST')); })}>Tiếp tục</button>}
          {phase === 'running' && <button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${run.runId}/pause`, 'POST')); })}>Tạm dừng</button>}
          {!['completed', 'cancelled'].includes(phase) && <button className="quiet-btn" disabled={busy} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${run.runId}/cancel`, 'POST')); })}>Hủy run · giữ thay đổi</button>}</div>
        {timeExhausted && !['completed', 'cancelled', 'running'].includes(phase) && <div><label>Thêm thời gian xử lý (giây)<input type="number" min="1" max="86400" value={extraSeconds} onChange={e => setExtraSeconds(Number(e.target.value))} /></label><button className="primary-btn" disabled={busy || run.busy || extraSeconds < 1} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${run.runId}/extend_time`, 'POST', { seconds: extraSeconds })); })}>Thêm thời gian và tiếp tục</button></div>}
        <details><summary>Workspace và cấu hình run</summary><p><code>{run.runtimeContext?.workspace}</code></p><pre>{JSON.stringify(run.snapshot?.configuration.bindings, null, 2)}</pre></details>
      </div>
      <div className="run-card"><h3>Các bước</h3><ol className="run-steps">{run.snapshot?.configuration.flow.definition.nodes.map(node => <li key={node.id} className={`step-${run.graph.nodes[node.id]?.status}`}><span>{run.graph.nodes[node.id]?.status === 'succeeded' ? '✓' : run.graph.nodes[node.id]?.status === 'running' ? '◉' : '○'}</span><strong>{node.label}</strong><small>{run.graph.nodes[node.id]?.status}</small></li>)}</ol></div>
      {plan && <div className="run-card"><h3>{phase === 'waiting_approval' ? 'Duyệt kế hoạch trước khi sửa file' : 'Kế hoạch'}</h3><p><strong>{plan.goal}</strong></p><p>{plan.approach}</p><p>Phạm vi: {plan.scope.join(', ')}</p><h4>Tiêu chí hoàn thành</h4><ul>{plan.acceptanceCriteria.map(item => <li key={item}>{item}</li>)}</ul><h4>Checks</h4><pre>{plan.checks.join('\n') || 'Chưa đề xuất check'}</pre>{plan.riskChanges.length > 0 && <p>Rủi ro mới: {plan.riskChanges.join('; ')}</p>}
        {phase === 'waiting_approval' && <><label>Yêu cầu điều chỉnh<textarea rows={2} value={planFeedback} onChange={e => setPlanFeedback(e.target.value)} placeholder="Nhập điểm cần thay đổi trong kế hoạch…" /></label><button className="secondary-btn" disabled={busy || run.busy || !planFeedback.trim()} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${run.runId}/changes`, 'POST', { feedback: planFeedback, planHash: run.proposedPlanHash })); setPlanFeedback(''); })}>Yêu cầu sửa kế hoạch</button> <button className="primary-btn" disabled={busy || run.busy} onClick={() => void action(async () => { setRun(await api<Run>(`/api/runs/${run.runId}/approve`, 'POST', { planHash: run.proposedPlanHash })); })}>Duyệt kế hoạch và thực hiện</button></>}</div>}
      {phase === 'completed' && <RunLessons runId={run.runId} />}
      {run.checks.length > 0 && <div className="run-card"><h3>Checks</h3>{run.checks.map(check => <p key={check.checkId}><strong>{check.status}</strong> · <code>{check.command}</code></p>)}</div>}
      {run.reviewerOutputs.map(output => <div className="run-card" key={output.attemptId}><h3>{output.result.reviewerId} · {output.result.verdict}</h3><p>{output.summary}</p></div>)}
      {run.artifacts.length > 0 && <div className="run-card"><h3>Kết quả và logs</h3>{run.artifacts.map((artifact, index) => <details key={index}><summary>{artifact.nodeId} · {artifact.kind}</summary><pre>{artifact.text}</pre></details>)}</div>}
    </>}</div></div>
  </section>;
}
