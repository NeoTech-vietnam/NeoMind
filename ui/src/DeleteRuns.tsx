/**
 * Deleting runs: one run from its header, several from the run list's select mode, and "Dọn run cũ" (prune by age,
 * status, newest N kept per workflow). A delete removes the run's status, log and page files, its runs/<run>/ folder,
 * checkpoints and OpenCode transcripts; the files the run wrote (outputs) and the series memory stay.
 * API: DELETE /api/runs/{run}[?force=1], POST /api/runs/prune.
 */
import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Eye, LoaderCircle, Trash2 } from 'lucide-react';
import { api, enc } from './api';
import { confirmAction } from './dialog';
import { pushToast } from './notify';
import { StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { relativeTime, runStatusInfo } from './format';
import type { DeleteResult, PruneRequest, PruneResult, RunStatus } from './types';

type RunLike = { run: string; status: RunStatus; busy: boolean; gate?: string | null; step?: string | null };

/** A run that is running (here or in another process) or that a server job holds cannot be deleted. */
export const deletable = (run: { status: RunStatus; busy: boolean }) => run.status !== 'running' && !run.busy;
/** A run waiting at a gate needs force=1: the gate is dropped. */
const needsForce = (run: { status: RunStatus }) => run.status === 'waiting';

export function deleteRun(run: string, force = false): Promise<DeleteResult> {
  return api<DeleteResult>(`/api/runs/${enc(run)}${force ? '?force=1' : ''}`, 'DELETE');
}

const WHAT = 'Xoá: file trạng thái, log và trang của run, thư mục runs/<run>/, checkpoint và transcript OpenCode.\nGiữ lại: các file run đã ghi (đầu ra) và series memory.\nKhông hoàn tác được.';
const summary = (result: DeleteResult) => [`${result.removed.length} file/thư mục`, `${result.checkpoints} checkpoint`, result.kept_outputs.length ? `giữ ${result.kept_outputs.length} đầu ra` : ''].filter(Boolean).join(' · ');

/** "Xoá run" in the run header; not shown while the run is running. */
export function DeleteRunButton({ run, onDeleted }: { run: RunLike; onDeleted(run: string): void }) {
  const [sending, setSending] = useState(false), [error, setError] = useState('');
  if (!deletable(run)) return null;
  const remove = async () => {
    const force = needsForce(run);
    const ok = await confirmAction({
      title: `Xoá run ${run.run}?`, danger: true, confirmLabel: 'Xoá run',
      description: `${force ? `Run đang chờ ở gate ${run.gate ?? run.step ?? ''}: xoá sẽ bỏ gate này (không duyệt, không từ chối).\n` : ''}${WHAT}`,
    });
    if (!ok) return;
    setSending(true); setError('');
    try {
      const result = await deleteRun(run.run, force);
      pushToast({ title: `Đã xoá run ${run.run}`, body: summary(result), tone: 'done' }, 8000);
      onDeleted(run.run);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSending(false); }
  };
  return <span className="inline-flex items-center gap-2">
    {error && <span role="alert" className="max-w-[360px] text-[12px] text-danger">{error}</span>}
    <Button size="sm" variant="danger" disabled={sending} onClick={() => void remove()}>{sending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Xoá run</Button>
  </span>;
}

/** Confirm and delete several runs one after another (waiting ones with force=1). Returns the runs deleted and the failures. */
export async function deleteSelected(items: RunLike[]): Promise<{ deleted: DeleteResult[]; failed: { run: string; error: string }[] } | null> {
  const list = items.filter(deletable);
  if (!list.length) return null;
  const waiting = list.filter(needsForce);
  const ok = await confirmAction({
    title: `Xoá ${list.length} run?`, danger: true, confirmLabel: `Xoá ${list.length} run`,
    description: <div className="flex flex-col gap-2">
      <ul className="m-0 max-h-48 list-none overflow-auto rounded-md border p-1.5 font-mono text-[11.5px] text-foreground">
        {list.map(item => <li key={item.run} className="flex items-center gap-2 py-0.5"><StatusDot status={runStatusInfo(item.status).status} />{item.run}
          {needsForce(item) && <span className="font-sans text-[11px] text-attention">chờ ở gate {item.gate ?? item.step ?? ''}: bỏ gate</span>}</li>)}
      </ul>
      {waiting.length > 0 && <span>{waiting.length} run đang chờ ở gate: xoá sẽ bỏ gate đó (không duyệt, không từ chối).</span>}
      <span>{WHAT}</span>
    </div>,
  });
  if (!ok) return null;
  const deleted: DeleteResult[] = [], failed: { run: string; error: string }[] = [];
  for (const item of list) {
    try { deleted.push(await deleteRun(item.run, needsForce(item))); }
    catch (e) { failed.push({ run: item.run, error: e instanceof Error ? e.message : String(e) }); }
  }
  if (deleted.length) pushToast({ title: `Đã xoá ${deleted.length} run`, body: deleted.map(result => result.run).join(', '), tone: 'done' }, 8000);
  return { deleted, failed };
}

// ---------------------------------------------------------------- "Dọn run cũ"

const PRUNE_STATUSES = ['done', 'failed', 'cancelled', 'rejected', 'stopped'] as const;
const DEFAULT_STATUSES = ['done', 'cancelled', 'failed', 'rejected'];
type Form = { days: string; statuses: string[]; keep: string; workflow: string };
const initialForm: Form = { days: '30', statuses: DEFAULT_STATUSES, keep: '3', workflow: 'all' };
const wholeNumber = (text: string) => /^\d+$/.test(text.trim());

function request(form: Form, dryRun: boolean): PruneRequest {
  return { ...(form.days.trim() ? { days: Number(form.days) } : {}), statuses: form.statuses, keep: form.keep.trim() ? Number(form.keep) : 0,
    ...(form.workflow !== 'all' ? { workflow: form.workflow } : {}), dry_run: dryRun };
}

function RunTable({ rows }: { rows: { run: string; workflow?: string; status?: RunStatus; updated?: string | null; note?: string }[] }) {
  return <div className="max-h-56 overflow-auto rounded-md border"><table className="w-full border-collapse text-[12px]">
    <tbody>{rows.map(row => <tr key={row.run} className="border-t first:border-t-0 align-top">
      <td className="px-2 py-1 font-mono text-[11.5px] text-foreground">{row.status && <StatusDot status={runStatusInfo(row.status).status} className="mr-1.5" />}{row.run}</td>
      {row.workflow !== undefined && <td className="px-2 py-1 text-muted-foreground">{row.workflow}</td>}
      {row.status !== undefined && <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">{runStatusInfo(row.status).label}</td>}
      {row.updated !== undefined && <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-faint">{relativeTime(row.updated)}</td>}
      {row.note !== undefined && <td className="px-2 py-1 text-fg-2">{row.note}</td>}
    </tr>)}</tbody>
  </table></div>;
}

/** "Dọn run cũ": choose by age, status, newest N kept per workflow and workflow; preview (dry run), then delete. */
export function PruneDialog({ open, onOpenChange, workflows, onDeleted }: { open: boolean; onOpenChange(open: boolean): void; workflows: string[]; onDeleted(runs: string[]): void }) {
  const [form, setForm] = useState<Form>(initialForm), [preview, setPreview] = useState<PruneResult | null>(null), [result, setResult] = useState<PruneResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'delete' | null>(null), [error, setError] = useState('');
  useEffect(() => { if (open) { setPreview(null); setResult(null); setError(''); } }, [open]);
  const change = (next: Partial<Form>) => { setForm(current => ({ ...current, ...next })); setPreview(null); setResult(null); setError(''); };
  const invalid = form.days.trim() && !wholeNumber(form.days) ? 'Số ngày phải là số nguyên ≥ 0.' : form.keep.trim() && !wholeNumber(form.keep) ? 'Số run giữ lại phải là số nguyên ≥ 0.'
    : !form.statuses.length ? 'Chọn ít nhất một trạng thái.' : '';
  const skippedNames = useMemo(() => new Set(preview?.skipped.map(item => item.run) ?? []), [preview]);
  const toDelete = preview ? preview.candidates.filter(item => !skippedNames.has(item.run)) : [];
  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'preview' : 'delete'); setError('');
    try {
      const answer = await api<PruneResult>('/api/runs/prune', 'POST', request(form, dryRun));
      if (dryRun) setPreview(answer);
      else { setResult(answer); setPreview(null); if (answer.deleted.length) onDeleted(answer.deleted.map(item => item.run)); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const options = [{ value: 'all', label: 'Tất cả workflow' }, ...workflows.map(value => ({ value, label: value }))];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="Dọn run cũ" className="w-[580px]" description="Xoá các run đã kết thúc theo tuổi và trạng thái. Đầu ra (file run đã ghi) và series memory được giữ lại.">
      {result ? <div className="mt-3 flex flex-col gap-3">
        <Callout tone={result.deleted.length ? 'success' : 'hint'}>{result.deleted.length ? `Đã xoá ${result.deleted.length} run.` : 'Không xoá run nào.'}</Callout>
        {result.deleted.length > 0 && <RunTable rows={result.deleted.map(item => ({ run: item.run, note: summary(item) }))} />}
        {result.skipped.length > 0 && <><span className="text-[12px] font-medium text-fg-2">Bỏ qua {result.skipped.length} run</span>
          <RunTable rows={result.skipped.map(item => ({ run: item.run, note: item.reason }))} /></>}
        <DialogActions><Button onClick={() => setResult(null)}>Dọn tiếp</Button><Button variant="primary" onClick={() => onOpenChange(false)}>Đóng</Button></DialogActions>
      </div> : <div className="mt-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Không cập nhật trong (ngày)" help="Để trống = không giới hạn tuổi.">
            <Input type="number" min={0} inputMode="numeric" value={form.days} onChange={event => change({ days: event.target.value })} /></Field>
          <Field label="Giữ N run mới nhất mỗi workflow" help="0 = không giữ run nào theo số lượng.">
            <Input type="number" min={0} inputMode="numeric" value={form.keep} onChange={event => change({ keep: event.target.value })} /></Field>
        </div>
        <div className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-fg-2">Trạng thái</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">{PRUNE_STATUSES.map(status => <label key={status} className="flex h-6 cursor-pointer items-center gap-2 text-[12.5px] text-fg-2">
            <input type="checkbox" className="size-3.5 accent-primary" checked={form.statuses.includes(status)}
              onChange={event => change({ statuses: event.target.checked ? [...form.statuses, status] : form.statuses.filter(item => item !== status) })} />
            <StatusDot status={runStatusInfo(status).status} />{runStatusInfo(status).label}</label>)}</div>
          <span className="text-[11.5px] text-muted-foreground">Run đang chạy hoặc đang chờ ở gate không bao giờ bị dọn.</span></div>
        <div className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-fg-2">Workflow</span>
          <Select label="Workflow cần dọn" value={form.workflow} onValueChange={workflow => change({ workflow })} options={options} /></div>
        {invalid && <span role="alert" className="text-[12px] text-danger">{invalid}</span>}
        {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
        {preview && <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2">{toDelete.length ? `Sẽ xoá ${toDelete.length} run` : 'Không có run nào khớp điều kiện.'}</span>
          {toDelete.length > 0 && <RunTable rows={toDelete} />}
          {preview.skipped.length > 0 && <><span className="text-[12px] font-medium text-fg-2">Bỏ qua {preview.skipped.length} run</span>
            <RunTable rows={preview.skipped.map(item => ({ run: item.run, note: item.reason }))} /></>}
        </div>}
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button disabled={!!invalid || !!busy} onClick={() => void run(true)}>{busy === 'preview' ? <LoaderCircle className="animate-spin" /> : <Eye />}Xem trước</Button>
          <Button variant="danger-solid" disabled={!!invalid || !!busy || !toDelete.length} onClick={() => void run(false)}
            title={preview ? undefined : 'Bấm “Xem trước” để xem danh sách trước khi xoá'}>{busy === 'delete' ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Xoá {toDelete.length} run</Button>
        </DialogActions>
      </div>}
    </DialogContent>
  </Dialog>;
}
