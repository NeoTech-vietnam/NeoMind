import { useEffect, useState } from 'react';
import { CircleAlert, Play, Workflow as WorkflowIcon } from 'lucide-react';
import { api, enc } from './api';
import { Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Callout, EmptyState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { RunGraph } from './RunGraph';
import { argSpecs, checkArgs, collectArgs, CommandPreview, RunArgsFields, type ArgValues, type ExtraArg } from './RunArgs';
import type { Graph, Workflow } from './types';
import { kindLabel } from './format';
import { useCatalog, useWorkflowBindings } from './catalog/api';
import { openCatalog } from './catalog/nav';
import { BindingSummary, StepBindingSection } from './catalog/StepBinding';

export const defaultRunName = (workflow: string) => `${workflow}-{date}-{time}`;

/** Start a run: name, the workflow's args (RunArgs: help, suggestions, optional section, reuse the last run's args), extra args and the command. */
export function StartRunDialog({ workflows, initial, open, onOpenChange, onStarted }: { workflows: Workflow[]; initial: string | null; open: boolean; onOpenChange(open: boolean): void; onStarted(run: string): void }) {
  const [chosen, setChosen] = useState<string | null>(null), [name, setName] = useState(''), [values, setValues] = useState<ArgValues>({}), [extra, setExtra] = useState<ExtraArg[]>([]);
  const [sending, setSending] = useState(false), [error, setError] = useState('');
  const pick = (next: string | null) => { setChosen(next); setName(next ? defaultRunName(next) : ''); setValues({}); setExtra([]); setError(''); };
  useEffect(() => { if (open) { pick(initial ?? workflows.find(item => !item.error)?.name ?? null); } }, [open, initial, workflows.length]);
  const workflow = workflows.find(item => item.name === chosen) ?? null;
  if (!open) return null;
  if (!workflow) return <Dialog open onOpenChange={onOpenChange}><DialogContent title="Run mới" description="Chưa đọc được danh sách workflow của project." /></Dialog>;
  const specs = argSpecs(workflow), check = checkArgs(specs, values, extra), pairs = collectArgs(specs, values, extra);
  const blocked = !name.trim() || !check.ok || sending;
  const submit = async () => {
    if (blocked) return;
    setSending(true); setError('');
    try {
      const result = await api<{ started: string }>('/api/runs', 'POST', { workflow: workflow.name, run: name.trim(), args: Object.fromEntries(pairs) });
      onOpenChange(false); onStarted(result.started);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSending(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[calc(100vh-32px)] w-[600px] overflow-auto" title={<>Run mới · <code className="font-mono">{workflow.name}</code></>} {...(workflow.description ? { description: workflow.description } : {})}>
      <form className="mt-4 flex flex-col gap-3.5" onSubmit={event => { event.preventDefault(); void submit(); }}>
        {workflows.length > 1 && <Field label="Workflow"><Select label="Workflow" value={workflow.name} onValueChange={pick} options={workflows.filter(item => !item.error).map(item => ({ value: item.name, label: item.description ? `${item.name} — ${item.description}` : item.name }))} /></Field>}
        <Field label="Tên run" help="Không dùng lại tên cũ. {date} → YYYYMMDD, {time} → HHMM.">
          <Input value={name} onChange={event => setName(event.target.value)} className="font-mono" spellCheck={false} autoFocus />
        </Field>
        <RunArgsFields workflow={workflow} values={values} extra={extra} onValues={setValues} onExtra={setExtra}
          extraHint={<span className="text-[11.5px] text-muted-foreground">Ví dụ: <code className="font-mono">model.&lt;bước&gt;=opus</code>, <code className="font-mono">effort.*=low</code>.</span>} />
        <CommandPreview workflow={workflow.name} run={name} pairs={pairs} />
        {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
        <DialogActions>
          {(check.note || !name.trim()) && <span className="mr-auto self-center text-[11.5px] text-muted-foreground">{!name.trim() ? 'Cần tên run. ' : ''}{check.note}</span>}
          <Button onClick={() => onOpenChange(false)}>Hủy</Button>
          <Button type="submit" variant="primary" disabled={blocked}><Play />{sending ? 'Đang bắt đầu…' : 'Bắt đầu run'}</Button>
        </DialogActions>
      </form>
    </DialogContent>
  </Dialog>;
}

/** The workflow's graph (with role / skill badges) and a step panel: the role and skills of the chosen ai step, with "Sửa". */
function GraphPreview({ name, step, onStep }: { name: string; step: string | null; onStep(step: string | null): void }) {
  const [graph, setGraph] = useState<Graph | null>(null), [error, setError] = useState('');
  const { version } = useCatalog();  // a saved binding reloads the catalog; the graph badges follow it
  const bindings = useWorkflowBindings(name);  // role_mode / contract / warnings for the ai step list
  useEffect(() => { setGraph(null); setError(''); }, [name]);
  useEffect(() => {
    let current = true;
    api<Graph>(`/api/workflows/${enc(name)}/graph`).then(value => { if (current) { setGraph(value); setError(''); } }).catch(e => { if (current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [name, version]);
  if (error && !graph) return <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />Không dựng được sơ đồ: {error}</p>;
  if (!graph) return <p className="m-0 text-[12.5px] text-muted-foreground">Đang dựng sơ đồ…</p>;
  const node = step ? graph.nodes.find(item => item.id === step) : undefined;
  const aiSteps = graph.nodes.filter(item => item.kind === 'ai' || item.kind === 'worker');
  return <div className="@container"><div className="grid grid-cols-1 gap-3 @[820px]:grid-cols-[minmax(0,1fr)_320px]">
    <div className="min-w-0"><RunGraph graph={graph} states={{}} info={{}} selected={node ? node.id : null} active={null} onSelect={onStep} /></div>
    <aside className="max-h-[560px] overflow-auto rounded-md border p-3 text-[12.5px]" aria-live="polite">
      {node ? <div className="flex flex-col gap-3">
        <div><h4 className="m-0 truncate font-mono text-[13px] font-semibold">{node.id}</h4><p className="m-0 mt-0.5 text-muted-foreground">{kindLabel(node.kind)}</p></div>
        {node.kind === 'ai' || node.kind === 'worker' || (node.kind === 'fanout' && graph.nodes.some(item => item.id === `${node.id}_worker`))
          ? <StepBindingSection workflow={name} step={node.id} onOpenCatalog={openCatalog()} />
          : <p className="m-0 text-muted-foreground">Chỉ bước AI mới có role và skill.</p>}
      </div> : <div className="flex flex-col gap-2">
        <p className="m-0 text-muted-foreground">Chọn một bước AI để xem và sửa role (agent) và skill của nó.</p>
        {aiSteps.length > 0 && <ul className="m-0 flex list-none flex-col gap-px p-0">{aiSteps.map(item => <li key={item.id}>
          <button type="button" onClick={() => onStep(item.id)} className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-sans hover:bg-accent">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{item.id}</span>{(() => { const row = bindings.row(item.id), warn = [...(row?.warnings ?? []), ...(row?.problems ?? [])];
              return <BindingSummary role={item.role} skills={item.skills} mode={row?.modes?.role_mode} skillMode={row?.modes?.skill_mode} resume={row?.modes?.retry_mode === 'resume'} contractOff={row?.modes?.contract === false && !!(item.role || item.skills?.length)} {...(warn.length ? { warn } : {})} />; })()}</button></li>)}</ul>}
      </div>}
    </aside>
  </div></div>;
}

/** Workflows of the project: description, required args, doc, diagram, and "start a run". */
export function WorkflowsPage({ workflows, error, startRun, selected: wanted, step, onSelect }: { workflows: Workflow[] | null; error: string; startRun(workflow: Workflow): void;
  /** Phase 2b: the parent may open a given workflow and step (from a catalog "dùng ở" chip) and keep them in the URL. */
  selected?: string | undefined; step?: string | undefined; onSelect?: ((workflow: string, step?: string) => void) | undefined }) {
  const [own, setOwn] = useState<{ workflow: string | null; step: string | null }>({ workflow: wanted ?? null, step: step ?? null });
  useEffect(() => { if (wanted) setOwn({ workflow: wanted, step: step ?? null }); }, [wanted, step]);
  const selected = own.workflow;
  const setSelected = (workflow: string, nextStep: string | null = null) => { setOwn({ workflow, step: nextStep }); onSelect?.(workflow, nextStep ?? undefined); };
  useEffect(() => { if (workflows?.length && !workflows.some(item => item.name === selected)) setOwn({ workflow: workflows[0]!.name, step: null }); }, [workflows, selected]);
  if (error && !workflows) return <EmptyState icon={<CircleAlert />} title="Không đọc được danh sách workflow">{error}</EmptyState>;
  if (!workflows) return <p className="m-0 p-6 text-[12.5px] text-muted-foreground">Đang đọc workflow…</p>;
  if (!workflows.length) return <EmptyState icon={<WorkflowIcon />} title="Chưa có workflow">Thêm file .py vào <code className="font-mono">.langflow/workflows/</code>.</EmptyState>;
  const current = workflows.find(item => item.name === selected) ?? workflows[0]!;
  return <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)]">
    <aside className="flex min-h-0 flex-col gap-px overflow-auto border-r px-3 py-3" aria-label="Danh sách workflow">
      {workflows.map(item => <button key={item.name} type="button" aria-current={item.name === current.name ? 'true' : undefined} onClick={() => setSelected(item.name)}
        className={cn('flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left font-sans hover:bg-accent', item.name === current.name && 'bg-accent')}>
        <span className="font-mono text-[13px] font-medium text-foreground">{item.name}</span>
        {item.error ? <span className="line-clamp-2 text-[11.5px] text-danger">Không nạp được</span> : item.description && <span className="line-clamp-2 text-[11.5px] text-muted-foreground">{item.description}</span>}
      </button>)}
    </aside>
    <div className="flex min-h-0 flex-col gap-4 overflow-auto px-6 py-5">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 font-mono text-[17px] font-semibold">{current.name}</h2>
        <Button variant="primary" className="ml-auto" disabled={!!current.error} onClick={() => startRun(current)}><Play />Bắt đầu run</Button>
      </header>
      {current.error && <Callout tone="danger" icon={<CircleAlert />}>Workflow này không nạp được:<pre className="m-0 mt-1 whitespace-pre-wrap font-mono text-[11.5px]">{current.error}</pre></Callout>}
      {current.description && <p className="m-0 text-[13px] text-fg-2">{current.description}</p>}
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">Tham số bắt buộc:
        {current.required.length ? current.required.map(key => <Tag key={key} className="font-mono" title={argSpecs(current).find(spec => spec.key === key)?.help ?? undefined}>{key}</Tag>) : <span>không có</span>}
        {argSpecs(current).some(spec => !spec.required) && <span className="ml-2">tuỳ chọn: {argSpecs(current).filter(spec => !spec.required).map(spec => spec.key).join(', ')}</span>}</div>
      {current.doc && <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-code p-3 font-mono text-[11.5px] leading-relaxed">{current.doc.trim()}</pre>}
      {!current.error && <GraphPreview name={current.name} step={current.name === own.workflow ? own.step : null} onStep={next => setSelected(current.name, next)} />}
    </div>
  </div>;
}
