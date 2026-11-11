import { useMemo, useState } from 'react';
import { Filter, MoreHorizontal, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { needsYou, phaseInfo, relativeTime } from './format';
import type { RunSummary } from './runTypes';
import { RERUNNABLE_PHASES } from '../../src/domain/rerun';

const finished = (phase: string) => phase === 'completed' || phase === 'cancelled';
type Filters = { flow: string; phases: string[]; from: string; to: string };
const noFilters: Filters = { flow: 'all', phases: [], from: '', to: '' };
const day = (date: Date) => date.toLocaleDateString('en-CA');
const activeCount = (filters: Filters) => (filters.flow !== 'all' ? 1 : 0) + (filters.phases.length ? 1 : 0) + (filters.from || filters.to ? 1 : 0);

function applyFilters(items: RunSummary[], query: string, filters: Filters): RunSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => {
    const created = item.createdAt ? day(new Date(item.createdAt)) : '';
    return (!needle || `${item.task ?? ''} ${item.flowName ?? ''}`.toLocaleLowerCase().includes(needle))
      && (filters.flow === 'all' || item.flowId === filters.flow) && (!filters.phases.length || filters.phases.includes(item.phase))
      && (!filters.from || (!!created && created >= filters.from)) && (!filters.to || (!!created && created <= filters.to));
  });
}

function FilterPopover({ history, filters, setFilters, shown }: { history: RunSummary[]; filters: Filters; setFilters(filters: Filters): void; shown: number }) {
  const flows = [...new Map(history.filter(item => item.flowId).map(item => [item.flowId!, item.flowName || item.flowId!])).entries()];
  const phases = [...new Set(history.map(item => item.phase))].map(phase => ({ phase, count: history.filter(item => item.phase === phase).length }));
  const count = activeCount(filters), today = new Date();
  const lastDays = (days: number) => day(new Date(today.getTime() - (days - 1) * 86_400_000));
  const preset = (days: number) => filters.from === lastDays(days) && filters.to === day(today);
  const chip = (label: string, days: number) => <button type="button" key={label} aria-pressed={preset(days)} onClick={() => setFilters({ ...filters, ...(preset(days) ? { from: '', to: '' } : { from: lastDays(days), to: day(today) }) })}
    className={cn('h-6 cursor-pointer rounded-full border bg-transparent px-2.5 font-sans text-[11.5px] text-fg-2 hover:bg-accent', preset(days) && 'border-foreground font-semibold text-foreground')}>{label}</button>;
  return <Popover>
    <PopoverTrigger asChild><Button aria-label="Lọc run"><Filter />Lọc{count > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10.5px] font-semibold text-primary-foreground">{count}</span>}</Button></PopoverTrigger>
    <PopoverContent className="w-[300px]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5"><span className="text-[11.5px] font-semibold text-muted-foreground">Flow</span>
          <Select label="Lọc theo flow" value={filters.flow} onValueChange={flow => setFilters({ ...filters, flow })} options={[{ value: 'all', label: 'Tất cả flow' }, ...flows.map(([value, label]) => ({ value, label }))]} /></div>
        <div className="flex flex-col gap-1.5"><span className="text-[11.5px] font-semibold text-muted-foreground">Trạng thái</span>
          {phases.map(({ phase, count: total }) => <label key={phase} className="flex h-6 cursor-pointer items-center gap-2 text-[12.5px] text-fg-2">
            <input type="checkbox" className="size-3.5 accent-primary" checked={filters.phases.includes(phase)}
              onChange={event => setFilters({ ...filters, phases: event.target.checked ? [...filters.phases, phase] : filters.phases.filter(item => item !== phase) })} />
            <StatusDot status={phaseInfo(phase).status} />{phaseInfo(phase).label}<span className="ml-auto text-[11.5px] tabular-nums text-faint">{total}</span></label>)}
          <span className="text-[11.5px] text-muted-foreground">Không chọn mục nào = mọi trạng thái.</span></div>
        <div className="flex flex-col gap-1.5"><span className="text-[11.5px] font-semibold text-muted-foreground">Khoảng ngày</span>
          <div className="flex gap-1.5">{chip('Hôm nay', 1)}{chip('7 ngày', 7)}{chip('30 ngày', 30)}</div>
          <div className="flex items-center gap-1.5"><Input type="date" aria-label="Từ ngày" value={filters.from} max={filters.to || undefined} onChange={event => setFilters({ ...filters, from: event.target.value })} className="px-1.5 text-[12px]" />
            <span className="text-faint">–</span><Input type="date" aria-label="Đến ngày" value={filters.to} min={filters.from || undefined} onChange={event => setFilters({ ...filters, to: event.target.value })} className="px-1.5 text-[12px]" /></div></div>
        <div className="flex items-center gap-2 border-t pt-3"><Button variant="ghost" size="sm" disabled={count === 0} onClick={() => setFilters(noFilters)}>Xóa lọc</Button>
          <span className="ml-auto text-[11.5px] text-muted-foreground">{shown} run</span></div>
      </div>
    </PopoverContent>
  </Popover>;
}

function Group({ title, count, children, menu }: { title: string; count: number; children: React.ReactNode; menu?: React.ReactNode }) {
  return <section className="mt-3 first:mt-1">
    <div className="flex h-6 items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}<span className="font-normal tabular-nums text-faint">{count}</span>{menu && <span className="ml-auto">{menu}</span>}</div>
    <div className="flex flex-col gap-px">{children}</div>
  </section>;
}

export type RowActions = { rerun(item: RunSummary): void; remove(item: RunSummary): void };

function Row({ item, selected, open, actions }: { item: RunSummary; selected: boolean; open(): void; actions?: RowActions | undefined }) {
  const info = phaseInfo(item.phase), time = relativeTime(item.createdAt), quiet = ['completed', 'cancelled', 'running', 'waiting_approval', 'blocked'].includes(item.phase);
  const canRerun = !!item.flowId && !!item.task?.trim() && RERUNNABLE_PHASES.includes(item.phase), canDelete = finished(item.phase), menu = !!actions && (canRerun || canDelete);
  return <div className="group relative">
    <button type="button" onClick={open} aria-current={selected ? 'true' : undefined}
      className={cn('flex w-full cursor-pointer items-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left font-sans outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', selected && 'bg-accent', menu && 'pr-8')}>
      <StatusDot status={info.status} className="mt-[5px]" />
      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-foreground">{item.task || item.runId}</span>
        <span className="block truncate text-[11.5px] text-muted-foreground">{[quiet ? '' : info.label, item.flowName, time].filter(Boolean).join(' · ')}</span></span>
    </button>
    {menu && <span className="absolute right-1 top-1.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Tùy chọn run ${item.task ?? item.runId}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          {canRerun && <DropdownMenuItem onSelect={() => actions!.rerun(item)}><RotateCcw />Chạy lại</DropdownMenuItem>}
          {canDelete && <DropdownMenuItem danger onSelect={() => actions!.remove(item)}><Trash2 />Xóa run</DropdownMenuItem>}
        </DropdownMenuContent></DropdownMenu></span>}
  </div>;
}

/** Left column of the Runs screen: runs that need the user first, then the ones running, then everything else. */
export function RunList({ history, selectedId, open, startNew, cleaning, clean, removeFinished, actions, programs }: { history: RunSummary[]; selectedId: string | undefined; open(runId: string): void; startNew(): void; cleaning: boolean; clean(): void; removeFinished?(): void; actions?: RowActions; programs?: React.ReactNode }) {
  const [query, setQuery] = useState(''), [filters, setFilters] = useState<Filters>(noFilters);
  const visible = useMemo(() => applyFilters(history, query, filters), [history, query, filters]);
  const needs = visible.filter(item => needsYou(item.phase)), live = visible.filter(item => item.phase === 'running' || item.phase === 'stopping');
  const recent = visible.filter(item => !needs.includes(item) && !live.includes(item));
  const row = (item: RunSummary) => <Row key={item.runId} item={item} selected={item.runId === selectedId} open={() => open(item.runId)} actions={actions} />;
  return <aside className="flex min-h-0 flex-col gap-2.5 border-r px-3 py-3" aria-label="Danh sách run">
    <Button className="w-full" onClick={startNew} aria-current={selectedId ? undefined : 'page'}><Plus />Run mới</Button>
    <div className="flex gap-1.5">
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Tìm run" placeholder="Tìm run…" value={query} onChange={event => setQuery(event.target.value)} className="pl-8" /></div>
      <FilterPopover history={history} filters={filters} setFilters={setFilters} shown={visible.length} />
    </div>
    <div className="-mx-1 min-h-0 flex-1 overflow-auto px-1">
      {programs}
      {history.length === 0 && <p className="m-0 px-2.5 py-3 text-[12.5px] text-muted-foreground">Chưa có run nào. Bấm “Run mới” để giao việc đầu tiên.</p>}
      {history.length > 0 && visible.length === 0 && <div className="px-2.5 py-3 text-[12.5px] text-muted-foreground">Không có run khớp.{' '}
        <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[12.5px] text-foreground underline" onClick={() => { setQuery(''); setFilters(noFilters); }}>Xóa lọc</button></div>}
      {needs.length > 0 && <Group title="Cần bạn" count={needs.length}>{needs.map(row)}</Group>}
      {live.length > 0 && <Group title="Đang chạy" count={live.length}>{live.map(row)}</Group>}
      {recent.length > 0 && <Group title="Gần đây" count={recent.length} menu={history.some(item => finished(item.phase)) && <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Tùy chọn danh sách"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem disabled={cleaning} onSelect={clean}><Trash2 />{cleaning ? 'Đang dọn…' : 'Dọn worktree run đã xong'}</DropdownMenuItem>
          {removeFinished && <DropdownMenuItem danger disabled={cleaning} onSelect={removeFinished}><Trash2 />Xóa mọi run đã xong</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>}>{recent.map(row)}</Group>}
    </div>
  </aside>;
}
