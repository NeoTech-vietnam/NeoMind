import { useEffect, useState } from 'react';
import { BookPlus, CircleAlert, Database, Pencil, Trash2 } from 'lucide-react';
import { api, enc } from './api';
import { confirmAction } from './dialog';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Callout, EmptyState } from '@/components/ui/misc';
import { Tag } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { usePoll } from '@/lib/poll';
import { shortTime } from './format';
import type { MemoryEntry, ProposeConfig, ProposeResult, RunMemory } from './types';

export function useRunMemory(run: string, active: boolean) {
  const [memory, setMemory] = useState<RunMemory | null>(null), [error, setError] = useState(''), [tick, setTick] = useState(0);
  usePoll(async () => {
    try { setMemory(await api<RunMemory>(`/api/runs/${enc(run)}/memory`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, active ? 3000 : 15000, [run, tick]);
  return { memory, error, refresh: () => setTick(value => value + 1) };
}

/** `[memory.propose]` of the project; disabled when the server has no such endpoint or no command. */
export function useProposeConfig() {
  const [config, setConfig] = useState<ProposeConfig | null>(null);
  useEffect(() => {
    let current = true;
    api<ProposeConfig>('/api/memory/propose').then(value => { if (current) setConfig(value); }).catch(() => { if (current) setConfig({ enabled: false, fields: [] }); });
    return () => { current = false; };
  }, []);
  return config;
}

type Row = MemoryEntry & { key: string; scope: 'run' | 'series' };
const rowId = (entry: Row) => `${entry.scope}\u0000${entry.run ?? ''}\u0000${entry.key}`;

type RowActions = { selectable: boolean; selected: Set<string>; toggle(id: string): void; edit(entry: Row): void; remove(entry: Row): void; disabled: boolean };

export function MemoryRows({ entries, showRun = false, actions }: { entries: Row[]; showRun?: boolean; actions?: RowActions }) {
  const allSelected = !!actions && entries.length > 0 && entries.every(entry => actions.selected.has(rowId(entry)));
  return <div className="overflow-auto rounded-md border">
    <table className="w-full border-collapse text-[12.5px]">
      <thead><tr className="whitespace-nowrap bg-muted text-left text-[11.5px] text-muted-foreground">
        {actions?.selectable && <th className="w-7 px-2 py-1.5"><input type="checkbox" aria-label="Chọn tất cả" className="size-3.5 accent-primary" checked={allSelected}
          onChange={() => { for (const entry of entries) if (actions.selected.has(rowId(entry)) === allSelected) actions.toggle(rowId(entry)); }} /></th>}
        <th className="px-2.5 py-1.5 font-semibold">Key</th><th className="px-2.5 py-1.5 font-semibold">Phạm vi</th><th className="px-2.5 py-1.5 font-semibold">Bước</th>
        {showRun && <th className="px-2.5 py-1.5 font-semibold">Run</th>}<th className="px-2.5 py-1.5 font-semibold">Thời gian</th><th className="px-2.5 py-1.5 font-semibold">Nội dung</th><th /></tr></thead>
      <tbody>{entries.map(entry => { const id = rowId(entry); return <tr key={id} className="border-t align-top">
        {actions?.selectable && <td className="px-2 py-1.5"><input type="checkbox" aria-label={`Chọn ${entry.key}`} className="size-3.5 accent-primary" checked={actions.selected.has(id)} onChange={() => actions.toggle(id)} /></td>}
        <td className="max-w-[220px] break-all px-2.5 py-1.5 font-mono text-[11.5px]">{entry.key}</td>
        <td className="px-2.5 py-1.5"><Tag>{entry.scope}</Tag></td>
        <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11.5px]">{entry.step}</td>
        {showRun && <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11.5px]">{entry.run}</td>}
        <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-muted-foreground">{shortTime(entry.time ?? entry.updated)}</td>
        <td className="whitespace-pre-wrap px-2.5 py-1.5 leading-relaxed">{entry.text}</td>
        <td className="whitespace-nowrap px-1 py-1"><CopyButton text={entry.text} label="Sao chép nội dung" />
          {actions && <><Tooltip label="Sửa nội dung"><Button variant="ghost" size="icon-sm" aria-label={`Sửa ${entry.key}`} disabled={actions.disabled} onClick={() => actions.edit(entry)}><Pencil /></Button></Tooltip>
            <Tooltip label="Xóa mục này"><Button variant="ghost" size="icon-sm" aria-label={`Xóa ${entry.key}`} disabled={actions.disabled} onClick={() => actions.remove(entry)}><Trash2 /></Button></Tooltip></>}</td>
      </tr>; })}</tbody>
    </table>
  </div>;
}

function EditDialog({ entry, onClose, onSave }: { entry: Row | null; onClose(): void; onSave(entry: Row, text: string): Promise<void> }) {
  const [text, setText] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => { setText(entry?.text ?? ''); setError(''); }, [entry]);
  if (!entry) return null;
  const save = async () => {
    setSaving(true); setError('');
    try { await onSave(entry, text); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="w-[600px]" title={<>Sửa memory <code className="font-mono">{entry.key}</code></>}
      description={entry.scope === 'series' ? 'Mục của series: mọi run sau cùng series sẽ đọc nội dung mới.' : 'Mục của run này: các bước sau của run sẽ đọc nội dung mới.'}>
      <form className="mt-3 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(); }}>
        <Textarea aria-label="Nội dung" rows={8} value={text} onChange={event => setText(event.target.value)} autoFocus />
        {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
        <DialogActions><Button onClick={onClose}>Hủy</Button><Button type="submit" variant="primary" disabled={saving || !text.trim() || text === entry.text}>{saving ? 'Đang lưu…' : 'Lưu'}</Button></DialogActions>
      </form>
    </DialogContent>
  </Dialog>;
}

function ProposeDialog({ open, entries, config, onClose }: { open: boolean; entries: Row[]; config: ProposeConfig; onClose(done: boolean): void }) {
  const [fields, setFields] = useState<Record<string, string>>({}), [sending, setSending] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<ProposeResult | null>(null);
  useEffect(() => { if (open) { setError(''); setResult(null); } }, [open]);
  if (!open) return null;
  const missing = config.fields.filter(field => !(fields[field] ?? '').trim());
  const send = async () => {
    setSending(true); setError('');
    try {
      setResult(await api<ProposeResult>('/api/memory/propose', 'POST', {
        entries: entries.map(entry => ({ key: entry.key, text: entry.text, scope: entry.scope, ...(entry.run ? { run: entry.run } : {}), ...(entry.step ? { step: entry.step } : {}) })),
        fields: Object.fromEntries(config.fields.map(field => [field, (fields[field] ?? '').trim()])),
      }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSending(false); }
  };
  return <Dialog open onOpenChange={next => { if (!next) onClose(!!result?.ok); }}>
    <DialogContent className="w-[620px]" title="Đề xuất vào KB" description={config.description || 'Gửi các mục memory đã chọn thành một đề xuất; người duyệt KB xem và quyết định, không có gì được áp dụng tự động.'}>
      <div className="mt-3 flex flex-col gap-3">
        <div className="max-h-40 overflow-auto rounded-md border"><ul className="m-0 flex list-none flex-col p-0 text-[12px]">{entries.map(entry =>
          <li key={rowId(entry)} className="border-t px-2.5 py-1.5 first:border-t-0"><code className="font-mono text-[11.5px]">{entry.key}</code> <Tag>{entry.scope}</Tag>
            <p className="m-0 mt-0.5 line-clamp-2 text-muted-foreground">{entry.text}</p></li>)}</ul></div>
        {!result && <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (!missing.length) void send(); }}>
          {config.fields.map(field => <Field key={field} label={<code className="font-mono">{field}</code>}>
            <Input value={fields[field] ?? ''} onChange={event => setFields({ ...fields, [field]: event.target.value })} spellCheck={false} />
          </Field>)}
          {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
          <DialogActions><Button onClick={() => onClose(false)}>Hủy</Button>
            <Button type="submit" variant="primary" disabled={sending || missing.length > 0 || !entries.length}><BookPlus />{sending ? 'Đang gửi…' : `Gửi đề xuất (${entries.length})`}</Button></DialogActions>
        </form>}
        {result && <>
          <Callout tone={result.ok ? 'success' : 'danger'} icon={<CircleAlert />}>{result.ok ? 'Đã tạo đề xuất. Người duyệt KB cần xem lại trước khi áp dụng.' : `Lệnh đề xuất trả lỗi (exit ${result.exit ?? '?'}).`}</Callout>
          {result.output && <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2.5 font-mono text-[11.5px]">{result.output}</pre>}
          <DialogActions>{!result.ok && <Button onClick={() => setResult(null)}>Sửa và gửi lại</Button>}<Button variant="primary" onClick={() => onClose(result.ok)}>Đóng</Button></DialogActions>
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}

/** Run memory (shared by the steps of this run) and series memory (shared by every run of the same series), editable. */
export function MemoryTable({ run, workflow, memory, error, series, busy, refresh }: {
  run: string; workflow: string; memory: RunMemory | null; error: string; series?: string | null | undefined; busy: boolean; refresh(): void }) {
  const propose = useProposeConfig(), [selected, setSelected] = useState<Set<string>>(new Set()), [editing, setEditing] = useState<Row | null>(null);
  const [proposing, setProposing] = useState(false), [actionError, setActionError] = useState(''), [working, setWorking] = useState(false);
  useEffect(() => { setSelected(new Set()); setActionError(''); }, [run]);
  if (error && !memory) return <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />{error}</p>;
  if (!memory) return <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc memory…</p>;
  const runEntries: Row[] = Object.entries(memory.run).map(([key, entry]) => ({ ...entry, key, scope: 'run' }));
  const seriesEntries: Row[] = memory.series.map(entry => ({ ...entry, key: entry.key ?? '?', scope: 'series' }));
  if (!runEntries.length && !seriesEntries.length) return <EmptyState icon={<Database />} title="Chưa có memory">
    Các bước AI có khai báo memory, và ghi chú hoặc từ chối ở gate, sẽ được ghi ở đây.</EmptyState>;

  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const seriesBody = (entry: Row, text?: string) => ({ workflow, series: series ?? '', key: entry.key, ...(text === undefined ? {} : { text }) });
  const save = async (entry: Row, text: string) => {
    if (entry.scope === 'run') await api(`/api/runs/${enc(run)}/memory/${enc(entry.key)}`, 'PUT', { text });
    else await api('/api/memory/series', 'PUT', seriesBody(entry, text));
    refresh();
  };
  const remove = async (entry: Row) => {
    const ok = await confirmAction({ title: `Xóa memory ${entry.key}?`, danger: true, confirmLabel: 'Xóa mục này',
      description: entry.scope === 'series' ? `Mục này của series ${series ?? ''} sẽ mất với mọi run sau của series.` : 'Các bước sau của run này sẽ không còn đọc được mục này.' });
    if (!ok) return;
    setWorking(true); setActionError('');
    try {
      if (entry.scope === 'run') await api(`/api/runs/${enc(run)}/memory/${enc(entry.key)}`, 'DELETE');
      else await api('/api/memory/series', 'DELETE', seriesBody(entry));
      setSelected(current => { const next = new Set(current); next.delete(rowId(entry)); return next; });
      refresh();
    } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); } finally { setWorking(false); }
  };
  const actions: RowActions = { selectable: !!propose?.enabled, selected, toggle, edit: setEditing, remove: entry => void remove(entry), disabled: working };
  const chosen = [...runEntries, ...seriesEntries].filter(entry => selected.has(rowId(entry)));
  return <div className="flex flex-col gap-4">
    {(propose?.enabled || busy) && <div className="flex flex-wrap items-center gap-2">
      {busy && <span className="text-[11.5px] text-muted-foreground">Server đang chạy run này: sửa memory của run sẽ bị từ chối (409) cho tới khi bước hiện tại xong.</span>}
      {propose?.enabled && <Button className="ml-auto" disabled={!chosen.length} onClick={() => setProposing(true)}><BookPlus />Đề xuất vào KB{chosen.length ? ` (${chosen.length})` : ''}</Button>}
    </div>}
    {actionError && <Callout tone="danger" icon={<CircleAlert />}>{actionError}</Callout>}
    <section><h4 className="m-0 mb-1.5 text-[12.5px] font-semibold">Memory của run <span className="font-normal text-faint">{runEntries.length}</span></h4>
      {runEntries.length ? <MemoryRows entries={runEntries} actions={actions} /> : <p className="m-0 text-[12.5px] text-muted-foreground">Run này chưa ghi memory.</p>}</section>
    {(series || seriesEntries.length > 0) && <section><h4 className="m-0 mb-1.5 text-[12.5px] font-semibold">Memory của series <code className="font-mono font-normal">{series ?? '—'}</code> <span className="font-normal text-faint">{seriesEntries.length}</span></h4>
      {seriesEntries.length ? <MemoryRows entries={seriesEntries} showRun actions={series ? actions : { ...actions, disabled: true }} /> : <p className="m-0 text-[12.5px] text-muted-foreground">Series chưa có memory.</p>}</section>}
    <EditDialog entry={editing} onClose={() => setEditing(null)} onSave={save} />
    {propose?.enabled && <ProposeDialog open={proposing} entries={chosen} config={propose} onClose={done => { setProposing(false); if (done) setSelected(new Set()); }} />}
  </div>;
}
