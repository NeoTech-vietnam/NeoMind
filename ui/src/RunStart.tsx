import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, GitCommitHorizontal, Info, Play, RotateCcw, TriangleAlert, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Callout, Skeleton } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { api } from './api';
import { formatDuration, formatTokens } from './format';
import { flowSteps } from './runSteps';
import { modelLabel, reasoningLabel, runnerLabel, useRunners, type RunnerModels } from './runners';
import { bindingLabel, type BindingValues, type Preview, type Run, type RunSummary } from './runTypes';
import { estimateFor, type EstimateGroup } from '../../src/domain/estimate';

type Limits = { activeTimeSeconds?: number; maxConcurrency?: number; maxTokens?: number };
type WorkspaceMode = 'isolated' | 'current' | 'shared' | '';
type MemoryPreview = { excluded?: { id: string; reason: string }[]; root: string | null; selectionPolicy?: Record<string, unknown>; inferredPaths?: string[]; records: { id: string; type: string; scope: string; revision: string; selectionReason: string }[] };
const templateFlows = [{ flowId: 'dev', name: 'Dev' }, { flowId: 'parallel', name: 'Dev song song' }, { flowId: 'fast', name: 'Fast' }, { flowId: 'research', name: 'Research' }];
const workspaceOptions = [{ value: 'flow', label: 'Theo flow' }, { value: 'isolated', label: 'Worktree riêng' }, { value: 'current', label: 'Checkout hiện tại' }, { value: 'shared', label: 'Workspace chung' }];
const maxCards = 6;

function Segmented({ value, options, label, onChange }: { value: string; options: { value: string; label: string }[]; label: string; onChange(value: string): void }) {
  return <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-md bg-muted p-0.5">{options.map(option =>
    <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
      className={cn('h-6 cursor-pointer whitespace-nowrap rounded-[5px] border-0 bg-transparent px-2.5 font-sans text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', value === option.value && 'bg-background font-semibold text-foreground shadow-sm')}>{option.label}</button>)}</div>;
}

function SectionHead({ title, hint, children }: { title: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h3 className="m-0 text-[14px] font-semibold">{title}</h3>{children}{hint && <span className="ml-auto text-[12px] text-muted-foreground">{hint}</span>}</div>;
}

/** Effective runner of every binding must satisfy `wants` for a preset to count as applied. */
type Preset = { id: string; label: string; runner(key: string): string };
const presets: Preset[] = [
  { id: 'mixed', label: 'Claude viết · Codex review', runner: key => key.includes('/') ? 'codex' : 'claude-code' },
  { id: 'claude', label: 'Toàn Claude', runner: () => 'claude-code' },
  { id: 'codex', label: 'Toàn Codex', runner: () => 'codex' },
];

/**
 * Start a run: describe the task, pick a flow, adjust runner/model per step. The effective configuration is previewed
 * automatically after every change; a run can only start from the configuration that is on screen.
 */
export function RunStart({ initialFlow, initialTask, flows, history, started }: { initialFlow?: string; initialTask?: string; flows: { flowId: string; name: string; archived: boolean }[]; history: RunSummary[]; started(run: Run): void }) {
  const runners = useRunners();
  const [flowId, setFlowId] = useState(initialFlow ?? 'dev'), [task, setTask] = useState(initialTask ?? '');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('');
  const [overrides, setOverrides] = useState<Record<string, Partial<BindingValues>>>({}), [limits, setLimits] = useState<Limits>({});
  const [preview, setPreview] = useState<Preview | null>(null), [loading, setLoading] = useState(false), [previewError, setPreviewError] = useState('');
  const [importDirty, setImportDirty] = useState(false), [starting, setStarting] = useState(false), [error, setError] = useState('');
  const [memoryPreview, setMemoryPreview] = useState<MemoryPreview | null>(null), [memoryError, setMemoryError] = useState('');
  const [publishing, setPublishing] = useState(false), [publishError, setPublishError] = useState(''), [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  useEffect(() => { if (initialFlow) chooseFlow(initialFlow); }, [initialFlow]);
  useEffect(() => {
    if (!task.trim()) { setMemoryPreview(null); setMemoryError(''); return; }
    let current = true; setMemoryPreview(null); setMemoryError('');
    const timer = setTimeout(() => { void api<MemoryPreview>('/api/memory/preview', 'POST', { task })
      .then(value => { if (current) { setMemoryPreview(value); setMemoryError(''); } })
      .catch(e => { if (current) { setMemoryPreview(null); setMemoryError(e instanceof Error ? e.message : String(e)); } }); }, 350);
    return () => { current = false; clearTimeout(timer); };
  }, [task]);
  // Re-preview after each configuration change; only the newest answer is kept.
  useEffect(() => {
    const id = ++request.current; setLoading(true);
    const timer = setTimeout(() => {
      api<Preview>('/api/runs/preview', 'POST', { flowId, overrides, limits, ...(workspaceMode ? { workspaceMode } : {}) })
        .then(value => { if (id === request.current) { setPreview(value); setPreviewError(''); } })
        .catch(e => { if (id === request.current) { setPreview(null); setPreviewError(e instanceof Error ? e.message : String(e)); } })
        .finally(() => { if (id === request.current) setLoading(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [flowId, overrides, limits, workspaceMode, refresh]);
  function chooseFlow(id: string) { setFlowId(id); setOverrides({}); setLimits({}); setImportDirty(false); setPublishError(''); }
  const choices = [...flows.filter(flow => !flow.archived).map(flow => ({ ...flow, template: false })),
    ...templateFlows.filter(item => !flows.some(flow => flow.flowId === item.flowId)).map(item => ({ ...item, archived: false, template: true }))];
  const definition = preview?.snapshot.configuration.flow;
  const bindings = Object.entries(preview?.snapshot.configuration.bindings ?? {});
  const values = (key: string, base: BindingValues): BindingValues => ({ ...base, ...overrides[key] });
  const usesClaude = bindings.some(([key, binding]) => values(key, binding.values).runner === 'claude-code');
  const usesOpenCode = bindings.some(([key, binding]) => values(key, binding.values).runner === 'opencode');
  const parallel = definition?.definition.nodes.some(node => node.type === 'fork');
  const blockers = [...(preview?.runtimeDiagnostics ?? []), ...(preview?.runnerPreflight?.blockers ?? [])];
  const canImport = !!preview && preview.dirtyImport.changes.length > 0 && !preview.dirtyImport.blockers.length;
  const shared = !!definition && definition.definition.workspacePolicy !== 'isolated';
  const reason = shared && canImport && !importDirty ? 'Xác nhận baseline có sẵn trước khi chạy trong checkout' : !task.trim() ? 'Nhập yêu cầu để bắt đầu' : loading ? 'Đang cập nhật cấu hình…' : !preview ? 'Chưa có cấu hình hợp lệ' : blockers.length ? 'Cần xử lý các điểm chặn ở trên' : '';
  const unpublished = /Publish the flow before starting a run/i.test(previewError);
  const steps = useMemo(() => flowSteps(definition), [definition]);
  // Medians of earlier finished runs with this flow and the same runners (run-stats); nothing until there are enough of them.
  const [statGroups, setStatGroups] = useState<EstimateGroup[]>([]);
  useEffect(() => {
    let live = true;
    void api<{ byFlowRunners: EstimateGroup[] }>(`/api/stats?flow=${encodeURIComponent(flowId)}`).then(value => { if (live) setStatGroups(value.byFlowRunners); }, () => { if (live) setStatGroups([]); });
    return () => { live = false; };
  }, [flowId, history.length]);
  const runnerSet = useMemo(() => Object.entries(preview?.snapshot.configuration.bindings ?? {}).map(([key, binding]) => ({ ...binding.values, ...overrides[key] }).runner), [preview, overrides]);
  const estimate = useMemo(() => estimateFor(statGroups, flowId, runnerSet), [statGroups, flowId, runnerSet]);

  const edited = (key: string) => !!overrides[key] && Object.keys(overrides[key]!).length > 0;
  const setRunner = (key: string, base: BindingValues, runner: string) => {
    const next = runners.find(item => item.runner === runner);
    if (!next || runner === values(key, base).runner) return;
    setOverrides(all => ({ ...all, [key]: { ...all[key], runner, provider: next.provider, model: next.models[0]!, ...runner === 'opencode' ? { reasoning: next.reasoning[0] ?? 'medium' } : {} } }));
  };
  const applyPreset = (preset: Preset) => setOverrides(() => Object.fromEntries(bindings.flatMap(([key]) => {
    const runner = preset.runner(key), next = runners.find(item => item.runner === runner);
    return next ? [[key, { runner, provider: next.provider, model: next.models[0]! }]] : [];
  })));
  const activePreset = bindings.length ? presets.find(preset => bindings.every(([key, binding]) => values(key, binding.values).runner === preset.runner(key)))?.id : undefined;

  async function publish() {
    setPublishing(true); setPublishError('');
    try { await api(`/api/flows/${encodeURIComponent(flowId)}/publish`, 'POST', {}); setRefresh(value => value + 1); }
    catch (e) { setPublishError(e instanceof Error ? e.message : String(e)); } finally { setPublishing(false); }
  }
  async function start() {
    if (!preview || reason) return;
    setStarting(true); setError('');
    try {
      started(await api<Run>('/api/runs', 'POST', { flowId, task, overrides, limits, configurationHash: preview.configurationHash, ...(workspaceMode ? { workspaceMode } : {}),
        ...(importDirty && canImport ? { importDirty: preview.dirtyImport.baselineHash } : {}) }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setStarting(false); }
  }
  const card = (flow: { flowId: string; name: string; template: boolean }) => {
    const selected = flow.flowId === flowId;
    return <label key={flow.flowId} className={cn('flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-card p-3 hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', selected && 'border-foreground bg-card ring-1 ring-foreground')}>
      <input type="radio" name="flow" className="sr-only" checked={selected} onChange={() => chooseFlow(flow.flowId)} />
      <span className="flex items-baseline gap-2"><strong className="text-[13.5px]">{flow.name}</strong>
        {flow.template ? <small className="text-[11.5px] text-muted-foreground">mẫu có sẵn</small> : selected && unpublished && <small className="text-[11.5px] text-muted-foreground">chưa publish</small>}
        <span className={cn('ml-auto grid size-4 shrink-0 place-items-center rounded-full border border-input', selected && 'border-foreground')}>{selected && <span className="size-2 rounded-full bg-foreground" />}</span></span>
      {selected && definition && <>
        {definition.description && <span className="text-[12px] leading-snug text-muted-foreground">{definition.description}</span>}
        <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11.5px] text-fg-2">{steps.map((step, index) => <span key={step.id} className="inline-flex items-center gap-1">
          {index > 0 && <ChevronRight className="size-3 text-faint" />}
          {step.node.type === 'approval' && step.node.mode !== 'auto' && <UserRound className="size-3 text-muted-foreground" />}
          <span className={cn(step.node.type === 'approval' && step.node.mode !== 'auto' && 'font-semibold text-foreground')}>{step.label}{step.branches ? ` ×${step.branches}` : ''}</span></span>)}</span></>}
    </label>;
  };

  return <div className="flex flex-col gap-6 pb-0">
    <div className="flex flex-wrap items-start gap-3">
      <div><h2 className="m-0 text-[18px] font-semibold tracking-tight">Run mới</h2><p className="m-0 mt-1 text-[12.5px] text-muted-foreground">Agent lập kế hoạch trước và chờ bạn duyệt rồi mới sửa file.</p></div>
      {preview && <Tooltip label="Run bắt đầu từ commit này của checkout"><span className="ml-auto inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-fg-2"><GitCommitHorizontal className="size-3.5 text-muted-foreground" />HEAD <code className="font-mono">{preview.sourceHead.slice(0, 7)}</code></span></Tooltip>}
    </div>

    <Field label="Yêu cầu" help={<span className="flex justify-between gap-3"><span>Nói rõ cần làm gì, ở file nào, xong khi nào.</span><span className="hidden shrink-0 sm:inline">Ctrl + Enter để bắt đầu</span></span>}>
      <Textarea aria-label="Yêu cầu" rows={4} autoFocus value={task} onChange={e => setTask(e.target.value)} placeholder="Ví dụ: Thêm hàm power(a, b) vào calc.js và viết test cho nó"
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void start(); } }} className="min-h-24" />
    </Field>

    <section className="flex flex-col gap-2.5">
      <SectionHead title="Flow" hint="Chuỗi bước agent sẽ đi qua" />
      {choices.length <= maxCards ? <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] items-start gap-2.5" role="radiogroup" aria-label="Flow">{choices.map(card)}</div>
        : <div className="flex flex-col gap-2"><Select label="Flow" value={flowId} onValueChange={chooseFlow} options={choices.map(flow => ({ value: flow.flowId, label: flow.template ? `${flow.name} · mẫu có sẵn` : flow.name }))} />
          {definition?.description && <span className="text-[12px] text-muted-foreground">{definition.description}</span>}</div>}
      {unpublished && <Callout tone="hint" icon={<Info />}><div className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1">Flow này chưa có phiên bản publish nên chưa chạy được. Publish bản nháp hiện tại để bắt đầu run.</span>
        <Button size="sm" disabled={publishing} onClick={() => void publish()}>{publishing ? 'Đang publish…' : 'Publish flow'}</Button></div></Callout>}
      {publishError && <Callout tone="danger" icon={<CircleAlert />}>Không publish được: {publishError}</Callout>}
      {previewError && !unpublished && <Callout tone="danger" icon={<CircleAlert />}>{previewError}</Callout>}
      {preview?.codexSandbox === 'disabled' && <Callout tone="attention" icon={<TriangleAlert />}>Sandbox Codex đang tắt cho agent và checks. Worktree và cơ chế dừng process vẫn được giữ; quyền chỉ đọc và phạm vi ghi không được hệ điều hành bảo đảm.</Callout>}
      {usesOpenCode && <Callout tone="attention" icon={<TriangleAlert />}>OpenCode chạy với quyền của tài khoản hiện tại; phạm vi ghi không được bảo đảm, kể cả khi dùng worktree. NeoMind vẫn quản lý và xác nhận dừng tiến trình.</Callout>}
      {(preview?.flowExceptions ?? []).length > 0 && <Callout tone="attention" icon={<TriangleAlert />}><strong className="font-semibold text-foreground">Flow này khác Dev:</strong><ul className="m-0 mt-1 list-disc pl-4">{preview!.flowExceptions!.map(note => <li key={note}>{note}</li>)}</ul></Callout>}
    </section>

    {(preview || (!previewError && loading)) && <section className="flex flex-col gap-2.5">
      <SectionHead title="Agent cho từng bước" hint="Checks chạy qua Codex">{loading && <span className="text-[12px] text-muted-foreground">Đang cập nhật…</span>}</SectionHead>
      <div className="flex flex-wrap items-center gap-1.5"><span className="mr-1 text-[12px] font-medium text-fg-2">Thiết lập nhanh</span>
        {presets.map(preset => <button key={preset.id} type="button" aria-pressed={activePreset === preset.id} disabled={!preview || runners.length === 0} onClick={() => applyPreset(preset)}
          className={cn('h-6 cursor-pointer rounded-full border bg-transparent px-2.5 font-sans text-[12px] text-fg-2 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45', activePreset === preset.id && 'border-foreground font-semibold text-foreground')}>{preset.label}</button>)}
        {Object.keys(overrides).length > 0 && <>{!activePreset && <Tag className="ml-0.5">Tùy chỉnh</Tag>}<Button variant="ghost" size="sm" onClick={() => setOverrides({})}><RotateCcw />Khôi phục</Button></>}</div>
      {!preview ? <div className="flex flex-col gap-3 rounded-lg border p-4"><Skeleton className="w-1/3" /><Skeleton className="w-2/3" /><Skeleton className="w-1/2" /></div>
        : <div className="overflow-hidden rounded-lg border bg-card" role="table" aria-label="Agent cho từng bước">
          <div role="row" className="grid grid-cols-[minmax(96px,1fr)_156px_minmax(0,136px)_minmax(0,92px)] gap-x-3 border-b px-3.5 py-2 text-[11.5px] text-muted-foreground">
            <span>Bước</span><span>Runner</span><span>Model</span><span>Mức suy luận</span></div>
          {bindings.map(([key, binding]) => {
            // OpenCode lists one entry per connected provider, so its models are looked up by provider too.
            const current = values(key, binding.values), info: RunnerModels | undefined = runners.find(item => item.runner === current.runner && (current.runner !== 'opencode' || item.provider === current.provider));
            const change = (value: Partial<BindingValues>) => setOverrides(all => ({ ...all, [key]: { ...all[key], ...value } }));
            return <div role="row" key={key} className="grid grid-cols-[minmax(96px,1fr)_156px_minmax(0,136px)_minmax(0,92px)] items-center gap-x-3 border-b px-3.5 py-2 last:border-b-0">
              <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium"><span className="truncate">{bindingLabel(key, definition)}</span>
                {edited(key) && <Tooltip label="Đã đổi so với mặc định của flow"><span aria-label="Đã đổi" className="size-1.5 shrink-0 rounded-full bg-foreground" /></Tooltip>}</span>
              <Segmented label={`Runner · ${key}`} value={current.runner} onChange={runner => setRunner(key, binding.values, runner)}
                options={[...new Set([...runners.map(item => item.runner), current.runner])].map(id => ({ value: id, label: runnerLabel(id) }))} />
              <div className="flex min-w-0 flex-col gap-1">
                {current.runner === 'opencode' && <Select label={`Provider · ${key}`} value={current.provider} onValueChange={provider => { const next = runners.find(item => item.runner === 'opencode' && item.provider === provider); if (next?.models[0]) change({ provider, model: next.models[0], reasoning: next.reasoning[0] ?? 'medium' }); }}
                  options={runners.filter(item => item.runner === 'opencode').map(item => ({ value: item.provider, label: item.provider }))} />}
                <Select label={`Model · ${key}`} value={current.model} onValueChange={model => change({ model })} options={[...new Set([current.model, ...(info?.models ?? [])])].map(id => ({ value: id, label: modelLabel(id) }))} />
              </div>
              <Select label={`Mức suy luận · ${key}`} value={current.reasoning} onValueChange={reasoning => change({ reasoning })} options={[...new Set([current.reasoning, ...(info?.reasoning ?? ['low', 'medium', 'high'])])].map(id => ({ value: id, label: reasoningLabel(id) }))} />
            </div>;
          })}
        </div>}
      {usesClaude && <p className="m-0 flex gap-2 text-[12px] leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />Claude Code chạy bằng tài khoản Claude đang đăng nhập và chỉ được đọc, ghi file trong phạm vi được duyệt (không có shell). Checks vẫn chạy qua Codex.</p>}
      {!runners.some(item => item.runner === 'opencode') && <p className="m-0 text-[12px] text-muted-foreground">OpenCode xuất hiện khi NeoMind tìm thấy phiên bản được hỗ trợ và provider đã kết nối.</p>}
    </section>}

    {preview && <section className="flex flex-col gap-3">
      <div className="rounded-lg border bg-card">
        <Disclosure title="Nâng cao" hint={`${workspaceMode ? workspaceOptions.find(item => item.value === workspaceMode)?.label : shared ? 'Chạy trong checkout' : 'Worktree riêng'} · tối đa ${Math.round((limits.activeTimeSeconds ?? definition!.definition.limits.activeTimeSeconds) / 60)} phút`}>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4">
            <Field label="Workspace" help="Checkout và workspace chung giữ một quyền ghi cho mỗi run; các writer dùng chung chạy tuần tự.">
              <Select label="Workspace khi chạy" value={workspaceMode || 'flow'} onValueChange={value => { setWorkspaceMode(value === 'flow' ? '' : value as WorkspaceMode); setImportDirty(false); }} options={workspaceOptions} /></Field>
            <Field label="Thời gian xử lý tối đa"><span className="relative block"><Input type="number" min="1" value={Math.round((limits.activeTimeSeconds ?? definition!.definition.limits.activeTimeSeconds) / 60)} onChange={e => setLimits(value => ({ ...value, activeTimeSeconds: Math.max(1, Number(e.target.value)) * 60 }))} className="pr-12" />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">phút</span></span></Field>
            {parallel && <Field label="Agent chạy đồng thời"><Input type="number" min="1" value={limits.maxConcurrency ?? definition!.definition.limits.maxConcurrency} onChange={e => setLimits(value => ({ ...value, maxConcurrency: Number(e.target.value) }))} /></Field>}
            <Field label="Ngân sách token" help="Run tạm dừng giữa các bước khi tổng token đạt mức này; để trống là không giới hạn.">
              <Input type="number" min="1000" step="1000" placeholder="Không giới hạn" value={limits.maxTokens ?? definition!.definition.limits.maxTokens ?? ''}
                onChange={e => setLimits(value => { const next = { ...value }; if (Number(e.target.value) >= 1) next.maxTokens = Math.round(Number(e.target.value)); else delete next.maxTokens; return next; })} /></Field>
          </div>
          <p className="m-0 mt-3 text-[12px] text-muted-foreground">Vòng sửa tối đa <strong className="text-foreground">{definition!.definition.limits.maxRepairRounds}</strong> (theo flow) · Bắt đầu từ commit <code className="font-mono">{preview.sourceHead.slice(0, 10)}</code></p>
          <p className="m-0 mt-1.5 text-[12px] text-muted-foreground">{shared ? 'Run sửa trực tiếp checkout, giữ staging có sẵn và commit chỉ thay đổi của run.' : 'Run làm việc trong worktree riêng; checkout chỉ đổi khi bạn áp dụng kết quả.'} Commit local không chạy Git hooks.</p>
        </Disclosure>
      </div>
      {preview.dirtyImport.changes.length > 0 && <Callout tone="attention" icon={<TriangleAlert />}>
        <strong className="font-semibold text-foreground">Checkout có {preview.dirtyImport.changes.length} thay đổi chưa commit.</strong>
        <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-x-4 gap-y-0.5 p-0 font-mono text-[12px]">{preview.dirtyImport.changes.slice(0, 8).map(item => <li key={item.path}><span className="mr-1.5 text-muted-foreground">{item.change === 'added' ? 'A' : item.change === 'deleted' ? 'D' : 'M'}</span>{item.path}</li>)}
          {preview.dirtyImport.changes.length > 8 && <li className="text-muted-foreground">+{preview.dirtyImport.changes.length - 8} file</li>}</ul>
        {canImport ? <label className="mt-2 flex cursor-pointer items-start gap-2 text-[12.5px] text-foreground"><input type="checkbox" className="mt-0.5 size-3.5 accent-primary" checked={importDirty} onChange={e => setImportDirty(e.target.checked)} />
          <span>{shared ? 'Dùng các thay đổi này làm baseline của run' : 'Đưa các thay đổi này vào worktree của run'}<span className="block text-[12px] text-muted-foreground">Commit của run chỉ chứa phần run làm.{!shared && !importDirty && ' Nếu không chọn, run chỉ dùng commit HEAD.'}</span></span></label>
          : <span className="mt-1 block">{preview.dirtyImport.blockers.join(' ')}</span>}
      </Callout>}
    </section>}

    {preview?.rules && (preview.rules.rules.length > 0 || preview.rules.warnings.length > 0) && <section className="flex flex-col gap-2.5">
      <SectionHead title="Rules của project" hint="Bắt buộc với mọi agent; reviewer chấm từng rule. Đọc từ neomind/rules.md khi bắt đầu run" />
      {preview.rules.rules.length > 0 && <ul className="m-0 flex list-none flex-col overflow-hidden rounded-lg border bg-card p-0">{preview.rules.rules.map(rule =>
        <li key={rule.id} className="flex items-start gap-2.5 border-b px-3 py-2 text-[12.5px] last:border-b-0"><code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">{rule.id}</code><span className="min-w-0 flex-1 text-fg-2">{rule.text}</span></li>)}</ul>}
      {preview.rules.warnings.length > 0 && <Callout tone="attention" icon={<TriangleAlert />}>{preview.rules.warnings.map(item => <span key={item} className="block">{item}</span>)}</Callout>}
    </section>}

    <section className="flex flex-col gap-2.5">
      <SectionHead title="Memory dự kiến" hint={memoryPreview?.root && memoryPreview.records.length ? `${memoryPreview.records.length} bản ghi sẽ được ghim khi bắt đầu` : 'NeoMind ghim nội dung và revision thực tế khi bắt đầu run'} />
      {memoryError && <Callout tone="danger" icon={<CircleAlert />}>Không đọc được memory: {memoryError}</Callout>}
      {!task.trim() && <p className="m-0 text-[12.5px] text-muted-foreground">Nhập yêu cầu để xem NeoMind sẽ chọn những memory nào.</p>}
      {task.trim() && !memoryPreview && !memoryError && <Skeleton className="w-1/2" />}
      {memoryPreview && (memoryPreview.root ? (memoryPreview.records.length ? <div className="overflow-hidden rounded-lg border bg-card">{memoryPreview.records.map(record =>
        <div key={`${record.type}/${record.id}`} className="flex items-center gap-2.5 border-b px-3.5 py-2 text-[12.5px] last:border-b-0"><Tag>{record.type}</Tag>
          <strong className="font-mono text-[12.5px]">{record.id}</strong><span className="min-w-0 flex-1 truncate text-muted-foreground">{record.scope} · {record.selectionReason}</span>
          <code className="font-mono text-[11px] text-faint">{record.revision.slice(0, 8)}</code></div>)}</div> : <p className="m-0 text-[12.5px] text-muted-foreground">Không có bản ghi được chọn.</p>)
        : <p className="m-0 text-[12.5px] text-muted-foreground">Project chưa cấu hình memory.</p>)}
      {memoryPreview?.inferredPaths && <p className="m-0 text-[12px] text-muted-foreground">Đường dẫn tìm thấy trong yêu cầu: {memoryPreview.inferredPaths.length ? memoryPreview.inferredPaths.map(item => <code key={item} className="mr-1.5 font-mono">{item}</code>) : 'không có; không lọc theo path'}</p>}
      {(memoryPreview?.excluded?.length || memoryPreview?.selectionPolicy) && <div className="rounded-lg border bg-card">
        {memoryPreview.excluded?.length ? <Disclosure title="Memory bị loại khỏi context" count={memoryPreview.excluded.length}>{memoryPreview.excluded.map(item => <p key={item.id} className="m-0 text-[12.5px] text-muted-foreground"><code className="font-mono text-foreground">{item.id}</code>: {item.reason}</p>)}</Disclosure> : null}
        {memoryPreview.selectionPolicy && <Disclosure className={memoryPreview.excluded?.length ? 'border-t' : ''} title="Policy chọn memory"><pre className="m-0 overflow-auto rounded-md bg-code p-3 font-mono text-[11.5px]">{JSON.stringify(memoryPreview.selectionPolicy, null, 2)}</pre></Disclosure>}</div>}
    </section>

    {blockers.length > 0 && <Callout tone="danger" icon={<CircleAlert />}><strong className="font-semibold text-foreground">Chưa chạy được</strong><ul className="m-0 mt-1 list-disc pl-4">{blockers.map(item => <li key={item}>{item}</li>)}</ul></Callout>}
    {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
    <div className="sticky bottom-0 -mx-6 mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-background px-6 py-3">
      <div className="min-w-0 text-[12.5px]">{estimate && <><strong className="font-semibold">{[estimate.activeSeconds !== null ? `~${formatDuration(Math.round(estimate.activeSeconds / 60) * 60_000 || 60_000)}` : '', estimate.tokens !== null ? `~${formatTokens(estimate.tokens)} token` : '', estimate.costUSD !== null ? `~$${estimate.costUSD.toFixed(2)}` : ''].filter(Boolean).join(' · ')}</strong><span className="block text-[11.5px] text-muted-foreground">trung vị {estimate.runs} run {definition?.name ?? 'cùng flow'} đã xong, cùng runner</span></>}</div>
      <span className="ml-auto text-[12.5px] text-muted-foreground">{reason}</span>
      <Button variant="primary" size="lg" disabled={starting || !!reason} onClick={() => void start()}><Play />{starting ? 'Đang khởi động…' : 'Bắt đầu'}</Button>
    </div>
  </div>;
}
