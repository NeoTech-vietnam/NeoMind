/**
 * Lịch: the project's scheduled runs (Windows Task Scheduler through langflow.schedule; GET/POST/DELETE /api/schedules).
 * A task starts `langflow start <workflow> <run> key=value …` at a time on some days; gates still wait for a person.
 */
import { useEffect, useState } from 'react';
import { CalendarClock, CircleAlert, RefreshCw, Trash2 } from 'lucide-react';
import { api, enc } from './api';
import { confirmAction } from './dialog';
import { Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Callout, EmptyState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/utils';
import { argSpecs, checkArgs, collectArgs, CommandPreview, quote, RunArgsFields, type ArgValues, type ExtraArg } from './RunArgs';
import type { Schedule, Workflow } from './types';

const DAYS = [['MON', 'T2'], ['TUE', 'T3'], ['WED', 'T4'], ['THU', 'T5'], ['FRI', 'T6'], ['SAT', 'T7'], ['SUN', 'CN']] as const;
type DayMode = 'DAILY' | 'MON-FRI' | 'PICK';
const dayModes: { value: DayMode; label: string }[] = [{ value: 'DAILY', label: 'Hằng ngày' }, { value: 'MON-FRI', label: 'Thứ 2 – thứ 6' }, { value: 'PICK', label: 'Chọn ngày' }];

const daysText = (days: Schedule['days']) => {
  if (!days) return '';
  const list = Array.isArray(days) ? days : String(days).split(/[,\s]+/).filter(Boolean);
  const label = (day: string) => DAYS.find(([code]) => code === day.toUpperCase().slice(0, 3))?.[1] ?? day;
  if (list.length === 1 && /^(DAILY|MON-FRI)$/i.test(list[0]!)) return list[0]!.toUpperCase() === 'DAILY' ? 'hằng ngày' : 'thứ 2 – thứ 6';
  return list.map(label).join(', ');
};

function AddForm({ workflows, onAdded }: { workflows: Workflow[]; onAdded(): void }) {
  const usable = workflows.filter(item => !item.error);
  const [name, setName] = useState(''), [time, setTime] = useState('08:00'), [mode, setMode] = useState<DayMode>('MON-FRI'), [picked, setPicked] = useState<string[]>(['MON']);
  const [workflow, setWorkflow] = useState(usable[0]?.name ?? ''), [run, setRun] = useState(''), [values, setValues] = useState<ArgValues>({}), [extra, setExtra] = useState<ExtraArg[]>([]);
  const [sending, setSending] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (!workflow && usable[0]) setWorkflow(usable[0].name); }, [usable.length]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRun(workflow ? `${workflow}-{date}` : ''); setValues({}); setExtra([]); if (workflow && !name) setName(workflow); }, [workflow]);  // eslint-disable-line react-hooks/exhaustive-deps
  const spec = usable.find(item => item.name === workflow);
  if (!usable.length) return <p className="m-0 text-[12.5px] text-muted-foreground">Chưa có workflow nào nạp được để hẹn giờ.</p>;
  const badName = !!name && !/^[\w-]+$/.test(name), badTime = !/^([01]\d|2[0-3]):[0-5]\d$/.test(time), badDays = mode === 'PICK' && !picked.length;
  const specs = argSpecs(spec), check = checkArgs(specs, values, extra), pairs = collectArgs(specs, values, extra);
  const days = mode === 'PICK' ? DAYS.map(([code]) => code).filter(code => picked.includes(code)).join(',') : mode;
  const args = ['start', workflow, run.trim(), ...pairs.map(([key, value]) => `${key}=${value}`)];
  const invalid = !name || badName || badTime || badDays || !spec || !run.trim() || !check.ok;
  const submit = async () => {
    if (invalid || sending) return;
    setSending(true); setError('');
    try { await api('/api/schedules', 'POST', { name, time, days, args }); onAdded(); setExtra([]); setValues({}); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSending(false); }
  };
  return <form className="flex flex-col gap-3.5" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
      <Field label="Tên task" help="Chữ, số, “-”, “_”; không trùng task khác." {...(badName ? { error: 'Tên chỉ gồm chữ, số, “-”, “_”' } : {})}>
        <Input value={name} onChange={event => setName(event.target.value)} className="font-mono" spellCheck={false} placeholder="morning-plan" /></Field>
      <Field label="Giờ chạy" {...(badTime ? { error: 'Dạng HH:MM' } : {})}><Input type="time" value={time} onChange={event => setTime(event.target.value)} className="tabular-nums" /></Field>
    </div>
    <div className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-fg-2">Ngày</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex rounded-md border p-0.5">{dayModes.map(item => <Button key={item.value} size="sm" variant="ghost" aria-pressed={mode === item.value}
          className={mode === item.value ? 'h-6 bg-accent px-2.5 text-foreground' : 'h-6 px-2.5'} onClick={() => setMode(item.value)}>{item.label}</Button>)}</div>
        {mode === 'PICK' && <div className="flex flex-wrap gap-1">{DAYS.map(([code, label]) => <label key={code} className={cn('inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[12px]', picked.includes(code) && 'bg-accent')}>
          <input type="checkbox" className="size-3 accent-primary" checked={picked.includes(code)} onChange={event => setPicked(event.target.checked ? [...picked, code] : picked.filter(item => item !== code))} />{label}</label>)}</div>}
      </div>
      {badDays && <span role="alert" className="text-[11.5px] text-danger">Chọn ít nhất một ngày.</span>}
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Workflow"><Select label="Workflow" value={workflow} onValueChange={setWorkflow} options={usable.map(item => ({ value: item.name, label: item.name }))} /></Field>
      <Field label="Tên run" help="Mỗi lần chạy cần tên mới: {date} → YYYYMMDD, {time} → HHMM."><Input value={run} onChange={event => setRun(event.target.value)} className="font-mono" spellCheck={false} /></Field>
    </div>
    {spec && <RunArgsFields workflow={spec} values={values} extra={extra} onValues={setValues} onExtra={setExtra} />}
    <CommandPreview workflow={workflow} run={run} pairs={pairs} />
    {error && <Callout tone="danger" icon={<CircleAlert />}><span className="whitespace-pre-wrap">{error}</span></Callout>}
    <div className="flex flex-wrap items-center gap-2.5"><Button type="submit" variant="primary" disabled={invalid || sending}><CalendarClock />{sending ? 'Đang tạo…' : 'Tạo lịch'}</Button>
      {check.note && <span className="text-[11.5px] text-muted-foreground">{check.note}</span>}</div>
  </form>;
}

export function SchedulesPage({ workflows }: { workflows: Workflow[] | null }) {
  const [list, setList] = useState<Schedule[] | null>(null), [error, setError] = useState(''), [tick, setTick] = useState(0), [actionError, setActionError] = useState('');
  usePoll(async () => {
    try { setList(await api<Schedule[]>('/api/schedules')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, 30000, [tick]);
  const reload = () => setTick(value => value + 1);
  const remove = async (item: Schedule) => {
    if (!await confirmAction({ title: `Xóa lịch ${item.name}?`, description: 'Task trong Task Scheduler bị xóa; các run đã chạy không bị ảnh hưởng.', confirmLabel: 'Xóa lịch', danger: true })) return;
    setActionError('');
    try { await api(`/api/schedules/${enc(item.name)}`, 'DELETE'); reload(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
  };
  return <div className="h-full overflow-auto"><div className="flex flex-col gap-5 px-6 py-5">
    <header className="flex flex-wrap items-center gap-2"><h2 className="m-0 text-[17px] font-semibold">Lịch</h2>
      <span className="text-[12px] text-muted-foreground">Run tự chạy theo giờ (Windows Task Scheduler, chỉ khi bạn đang đăng nhập). Gate vẫn chờ người duyệt.</span>
      <Tooltip label="Đọc lại"><Button size="icon" className="ml-auto" aria-label="Đọc lại" onClick={reload}><RefreshCw /></Button></Tooltip></header>
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[13px] font-semibold">Lịch của project {list && <span className="font-normal text-faint">{list.length}</span>}</h3>
      {error && <Callout tone="danger" icon={<CircleAlert />}><span className="whitespace-pre-wrap">{error}</span></Callout>}
      {actionError && <Callout tone="danger" icon={<CircleAlert />}><span className="whitespace-pre-wrap">{actionError}</span></Callout>}
      {!list && !error && <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc lịch…</p>}
      {list && !list.length && <EmptyState icon={<CalendarClock />} title="Chưa có lịch">Tạo lịch ở form bên dưới.</EmptyState>}
      {list && list.length > 0 && <div className="overflow-auto rounded-md border"><table className="w-full border-collapse text-[12.5px]">
        <thead><tr className="whitespace-nowrap bg-muted text-left text-[11.5px] text-muted-foreground">
          <th className="px-2.5 py-1.5 font-semibold">Tên</th><th className="px-2.5 py-1.5 font-semibold">Khi nào</th><th className="px-2.5 py-1.5 font-semibold">Lần tới</th>
          <th className="px-2.5 py-1.5 font-semibold">Lần trước</th><th className="px-2.5 py-1.5 font-semibold">Kết quả</th><th className="px-2.5 py-1.5 font-semibold">Lệnh</th><th /></tr></thead>
        <tbody>{list.map(item => { const result = item.last_result === null || item.last_result === undefined ? '' : String(item.last_result);
          return <tr key={item.name} className="border-t align-top">
            <td className="px-2.5 py-1.5 font-mono text-[11.5px]">{item.name}</td>
            <td className="whitespace-nowrap px-2.5 py-1.5">{[item.time, daysText(item.days)].filter(Boolean).join(' · ') || item.schedule || ''}</td>
            <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">{item.next_run ?? ''}</td>
            <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-muted-foreground">{item.last_run ?? ''}</td>
            <td className="px-2.5 py-1.5">{result && <Tag className={result === '0' ? undefined : 'text-danger'}>{result === '0' ? 'ok (0)' : result}</Tag>}</td>
            <td className="max-w-[420px] break-all px-2.5 py-1.5 font-mono text-[11px] text-fg-2">{item.args?.length ? `langflow ${item.args.map(quote).join(' ')}` : item.command ?? ''}</td>
            <td className="px-1 py-1"><Tooltip label="Xóa lịch"><Button variant="ghost" size="icon-sm" aria-label={`Xóa lịch ${item.name}`} onClick={() => void remove(item)}><Trash2 /></Button></Tooltip></td>
          </tr>; })}</tbody>
      </table></div>}
    </section>
    <section className="flex max-w-[720px] flex-col gap-2 rounded-lg border p-4">
      <h3 className="m-0 text-[13px] font-semibold">Thêm lịch</h3>
      {workflows ? <AddForm workflows={workflows} onAdded={reload} /> : <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc workflow…</p>}
    </section>
  </div></div>;
}
