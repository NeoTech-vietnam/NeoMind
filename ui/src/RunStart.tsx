import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { modelLabel, reasoningLabel, runnerLabel, useRunners } from './runners';
import { bindingLabel, type BindingValues, type Preview, type Run } from './runTypes';

type Limits = { activeTimeSeconds?: number; maxConcurrency?: number };
const templateFlows = [{ flowId: 'dev', name: 'Dev' }, { flowId: 'parallel', name: 'Dev song song' }, { flowId: 'fast', name: 'Fast' }, { flowId: 'research', name: 'Research' }];

/**
 * Start a run: pick a flow, describe the task, adjust runner/model per step. The effective configuration is previewed
 * automatically after every change; a run can only start from the configuration that is on screen.
 */
export function RunStart({ initialFlow, flows, started }: { initialFlow?: string; flows: { flowId: string; name: string; archived: boolean }[]; started(run: Run): void }) {
  const runners = useRunners();
  const [flowId, setFlowId] = useState(initialFlow ?? 'dev'), [task, setTask] = useState('');
  const [overrides, setOverrides] = useState<Record<string, Partial<BindingValues>>>({}), [limits, setLimits] = useState<Limits>({});
  const [preview, setPreview] = useState<Preview | null>(null), [loading, setLoading] = useState(false), [previewError, setPreviewError] = useState('');
  const [importDirty, setImportDirty] = useState(false), [starting, setStarting] = useState(false), [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => { if (initialFlow) chooseFlow(initialFlow); }, [initialFlow]);
  // Re-preview after each configuration change; only the newest answer is kept.
  useEffect(() => {
    const id = ++request.current; setLoading(true);
    const timer = setTimeout(() => {
      api<Preview>('/api/runs/preview', 'POST', { flowId, overrides, limits })
        .then(value => { if (id === request.current) { setPreview(value); setPreviewError(''); } })
        .catch(e => { if (id === request.current) { setPreview(null); setPreviewError(e instanceof Error ? e.message : String(e)); } })
        .finally(() => { if (id === request.current) setLoading(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [flowId, overrides, limits]);
  function chooseFlow(id: string) { setFlowId(id); setOverrides({}); setLimits({}); setImportDirty(false); }
  const choices = [...flows.filter(flow => !flow.archived), ...templateFlows.filter(item => !flows.some(flow => flow.flowId === item.flowId)).map(item => ({ ...item, name: `${item.name} · mẫu có sẵn`, archived: false }))];
  const definition = preview?.snapshot.configuration.flow;
  const bindings = Object.entries(preview?.snapshot.configuration.bindings ?? {});
  const values = (key: string, base: BindingValues): BindingValues => ({ ...base, ...overrides[key] });
  const usesClaude = bindings.some(([key, binding]) => values(key, binding.values).runner === 'claude-code');
  const parallel = definition?.definition.nodes.some(node => node.type === 'fork');
  const blockers = [...(preview?.runtimeDiagnostics ?? []), ...(preview?.runnerPreflight?.blockers ?? [])];
  const canImport = !!preview && preview.dirtyImport.changes.length > 0 && !preview.dirtyImport.blockers.length;
  const reason = !task.trim() ? 'Nhập yêu cầu để bắt đầu' : loading ? 'Đang cập nhật cấu hình…' : !preview ? 'Chưa có cấu hình hợp lệ' : blockers.length ? 'Cần xử lý các điểm chặn ở trên' : '';
  async function start() {
    if (!preview) return;
    setStarting(true); setError('');
    try {
      started(await api<Run>('/api/runs', 'POST', { flowId, task, overrides, limits, configurationHash: preview.configurationHash,
        ...(importDirty && canImport ? { importDirty: preview.dirtyImport.baselineHash } : {}) }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setStarting(false); }
  }

  return <div className="run-card start-card">
    <div className="card-title"><h2>Run mới</h2><p>Mô tả việc cần làm, chọn agent cho từng bước rồi bắt đầu. Agent sẽ lập kế hoạch và chờ bạn duyệt trước khi sửa file.</p></div>
    <div className="start-grid">
      <label className="form-field">Flow<select aria-label="Flow" value={flowId} onChange={e => chooseFlow(e.target.value)}>{choices.map(flow => <option key={flow.flowId} value={flow.flowId}>{flow.name}</option>)}</select>
        {definition?.description && <small>{definition.description}</small>}
        {(preview?.flowExceptions ?? []).length > 0 && <div className="callout tone-amber"><strong>Flow này khác Dev:</strong><ul>{preview!.flowExceptions!.map(note => <li key={note}>{note}</li>)}</ul></div>}</label>
      <label className="form-field">Yêu cầu<textarea aria-label="Yêu cầu" rows={4} value={task} onChange={e => setTask(e.target.value)} placeholder="Ví dụ: Thêm hàm power(a, b) vào calc.js và viết test cho nó" /></label>
    </div>

    <section className="start-section">
      <div className="section-head"><h3>Agent cho từng bước</h3>{loading && <span className="muted-inline">Đang cập nhật…</span>}</div>
      {previewError && <div className="callout tone-red">{previewError}</div>}
      {!preview && !previewError && <div className="skeleton-rows"><span /><span /><span /></div>}
      {preview && <div className="binding-table" role="table">
        <div className="binding-row binding-head" role="row"><span>Bước</span><span>Runner</span><span>Model</span><span>Mức suy luận</span></div>
        {bindings.map(([key, binding]) => {
          const current = values(key, binding.values), info = runners.find(item => item.runner === current.runner);
          const change = (value: Partial<BindingValues>) => setOverrides(all => ({ ...all, [key]: { ...all[key], ...value } }));
          return <div className="binding-row" role="row" key={key}>
            <span className="binding-step">{bindingLabel(key, definition)}<small>{key}</small></span>
            <div className="segmented" role="radiogroup" aria-label={`Runner · ${key}`}>{[...new Set([...runners.map(item => item.runner), current.runner])].map(id => {
              const next = runners.find(item => item.runner === id);
              return <button key={id} type="button" role="radio" aria-checked={current.runner === id} className={current.runner === id ? 'on' : ''}
                onClick={() => { if (next && id !== current.runner) change({ runner: id, provider: next.provider, model: next.models[0]! }); }}>{runnerLabel(id)}</button>;
            })}</div>
            <select aria-label={`Model · ${key}`} value={current.model} onChange={e => change({ model: e.target.value })}>{[...new Set([current.model, ...(info?.models ?? [])])].map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}</select>
            <select aria-label={`Mức suy luận · ${key}`} value={current.reasoning} onChange={e => change({ reasoning: e.target.value })}>{[...new Set([current.reasoning, ...(info?.reasoning ?? ['low', 'medium', 'high'])])].map(id => <option key={id} value={id}>{reasoningLabel(id)}</option>)}</select>
          </div>;
        })}
      </div>}
      {usesClaude && <p className="hint">Claude Code chạy bằng tài khoản Claude đang đăng nhập và chỉ được đọc, ghi file trong phạm vi được duyệt (không có shell). Checks vẫn chạy qua Codex.</p>}
    </section>

    {preview && <section className="start-section">
      <div className="section-head"><h3>Giới hạn và mã nguồn</h3></div>
      <div className="limits-row">
        <label className="form-field compact">Thời gian xử lý tối đa<span className="input-suffix"><input type="number" min="1" value={Math.round((limits.activeTimeSeconds ?? definition!.definition.limits.activeTimeSeconds) / 60)} onChange={e => setLimits(value => ({ ...value, activeTimeSeconds: Math.max(1, Number(e.target.value)) * 60 }))} /><em>phút</em></span></label>
        {parallel && <label className="form-field compact">Agent chạy đồng thời<input type="number" min="1" value={limits.maxConcurrency ?? definition!.definition.limits.maxConcurrency} onChange={e => setLimits(value => ({ ...value, maxConcurrency: Number(e.target.value) }))} /></label>}
        <div className="fact"><span>Vòng sửa tối đa</span><strong>{definition!.definition.limits.maxRepairRounds}</strong></div>
        <div className="fact"><span>Bắt đầu từ commit</span><code>{preview.sourceHead.slice(0, 10)}</code></div>
      </div>
      <p className="hint">Run làm việc trong worktree riêng; checkout của bạn không bị sửa. Kết quả là một commit local sau khi checks và review đạt (Git hooks không chạy).</p>
      {preview.dirtyImport.changes.length > 0 && <div className="callout tone-amber">
        <strong>Checkout có {preview.dirtyImport.changes.length} thay đổi chưa commit.</strong>
        {canImport ? <label className="check-line"><input type="checkbox" checked={importDirty} onChange={e => setImportDirty(e.target.checked)} /> Mang các thay đổi này vào run (commit của run chỉ chứa phần run làm)</label>
          : <span> {preview.dirtyImport.blockers.join(' ')}</span>}
        {!importDirty && <span> Nếu không chọn, run chỉ dùng commit HEAD.</span>}
        <details><summary>Xem danh sách</summary><ul className="file-list">{preview.dirtyImport.changes.map(item => <li key={item.path}><span className={`change change-${item.change}`}>{item.change === 'added' ? 'A' : item.change === 'deleted' ? 'D' : 'M'}</span>{item.path}</li>)}</ul></details>
      </div>}
    </section>}

    {blockers.length > 0 && <div className="callout tone-red"><strong>Chưa chạy được</strong><ul>{blockers.map(item => <li key={item}>{item}</li>)}</ul></div>}
    {error && <div className="callout tone-red" role="alert">{error}</div>}
    <div className="start-footer"><span className="muted-inline">{reason}</span>
      <button className="primary-btn large" disabled={starting || !!reason} onClick={() => void start()}>{starting ? 'Đang khởi động…' : '▶  Bắt đầu'}</button></div>
  </div>;
}
