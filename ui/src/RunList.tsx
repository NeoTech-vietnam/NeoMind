import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CircleAlert, Eraser, Filter, ListChecks, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/misc';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { deletable, deleteSelected, PruneDialog } from './DeleteRuns';
import { formatCost, formatTokens, relativeTime, runStatusInfo, totalTokens } from './format';
import type { RunSummary } from './types';

type Filters = { workflow: string; statuses: string[] };
const noFilters: Filters = { workflow: 'all', statuses: [] };
const activeCount = (filters: Filters) => (filters.workflow !== 'all' ? 1 : 0) + (filters.statuses.length ? 1 : 0);

function applyFilters(items: RunSummary[], query: string, filters: Filters): RunSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => (!needle || `${item.run} ${item.workflow} ${item.series ?? ''} ${item.step ?? ''}`.toLocaleLowerCase().includes(needle))
    && (filters.workflow === 'all' || item.workflow === filters.workflow) && (!filters.statuses.length || filters.statuses.includes(item.status)));
}

function FilterPopover({ runs, filters, setFilters, shown }: { runs: RunSummary[]; filters: Filters; setFilters(filters: Filters): void; shown: number }) {
  const workflows = [...new Set(runs.map(item => item.workflow))].sort();
  const statuses = [...new Set(runs.map(item => item.status))].map(status => ({ status, count: runs.filter(item => item.status === status).length }));
  const count = activeCount(filters);
  return <Popover>
    <PopoverTrigger asChild><Button aria-label="Lọc run"><Filter />{count > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10.5px] font-semibold text-primary-foreground">{count}</span>}</Button></PopoverTrigger>
    <PopoverContent className="w-[280px]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5"><span className="text-[11.5px] font-semibold text-muted-foreground">Workflow</span>
          <Select label="Lọc theo workflow" value={filters.workflow} onValueChange={workflow => setFilters({ ...filters, workflow })}
            options={[{ value: 'all', label: 'Tất cả workflow' }, ...workflows.map(value => ({ value, label: value }))]} /></div>
        <div className="flex flex-col gap-1.5"><span className="text-[11.5px] font-semibold text-muted-foreground">Trạng thái</span>
          {statuses.map(({ status, count: total }) => <label key={status} className="flex h-6 cursor-pointer items-center gap-2 text-[12.5px] text-fg-2">
            <input type="checkbox" className="size-3.5 accent-primary" checked={filters.statuses.includes(status)}
              onChange={event => setFilters({ ...filters, statuses: event.target.checked ? [...filters.statuses, status] : filters.statuses.filter(item => item !== status) })} />
            <StatusDot status={runStatusInfo(status).status} />{runStatusInfo(status).label}<span className="ml-auto text-[11.5px] tabular-nums text-faint">{total}</span></label>)}
          <span className="text-[11.5px] text-muted-foreground">Không chọn mục nào = mọi trạng thái.</span></div>
        <div className="flex items-center gap-2 border-t pt-3"><Button variant="ghost" size="sm" disabled={count === 0} onClick={() => setFilters(noFilters)}>Xóa lọc</Button>
          <span className="ml-auto text-[11.5px] text-muted-foreground">{shown} run</span></div>
      </div>
    </PopoverContent>
  </Popover>;
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section className="mt-3 first:mt-1">
    <div className="flex h-6 items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}<span className="font-normal tabular-nums text-faint">{count}</span></div>
    <div className="flex flex-col gap-px">{children}</div>
  </section>;
}

type Pick = { checked: boolean; disabled: boolean; toggle(): void };

function Row({ item, selected, open, pick }: { item: RunSummary; selected: boolean; open(): void; pick?: Pick | undefined }) {
  const info = runStatusInfo(item.status), time = relativeTime(item.updated ?? item.started);
  const cost = formatCost(item.totals?.cost_usd), tokens = totalTokens(item.totals);
  const where = item.status === 'waiting' ? `gate ${item.gate ?? item.step ?? ''}` : item.status === 'running' || item.status === 'failed' ? item.step ?? '' : '';
  const body = <>
    <StatusDot status={item.busy && item.status !== 'waiting' ? 'running' : info.status} className="mt-[5px]" />
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5"><span className="truncate text-[13px] font-medium text-foreground">{item.run}</span>
        {item.status === 'waiting' && <span className="ml-auto shrink-0 rounded-full bg-attention/12 px-1.5 text-[10.5px] font-semibold text-attention">chờ bạn</span>}
        {cost && <span className={cn('shrink-0 rounded bg-muted px-1 text-[10.5px] tabular-nums text-fg-2', item.status !== 'waiting' && 'ml-auto')} title={`Chi phí AI của run${tokens ? ` · ${formatTokens(tokens)} tokens` : ''}`}>{cost}</span>}</span>
      <span className="block truncate text-[11.5px] text-muted-foreground">{[item.workflow, item.status === 'done' ? '' : info.label, where, time].filter(Boolean).join(' · ')}</span>
    </span>
  </>;
  const rowClass = 'flex w-full items-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left font-sans outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring';
  // Select mode: the whole row toggles its checkbox; a running run cannot be picked.
  if (pick) return <label className={cn(rowClass, pick.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer', pick.checked && 'bg-accent')}
    title={pick.disabled ? 'Run đang chạy: dừng nó trước khi xoá' : undefined}>
    <input type="checkbox" className="mt-[3px] size-3.5 shrink-0 accent-primary" checked={pick.checked} disabled={pick.disabled} onChange={pick.toggle} aria-label={`Chọn ${item.run}`} />
    {body}
  </label>;
  return <button type="button" onClick={open} aria-current={selected ? 'true' : undefined} className={cn(rowClass, 'cursor-pointer', selected && 'bg-accent')}>{body}</button>;
}

/** Left column of the Runs screen: runs waiting at a gate first, then running ones, then everything else. */
export function RunList({ runs, selected, open, startNew, loaded, onDeleted }: {
  runs: RunSummary[]; selected: string | undefined; open(run: string): void; startNew(): void; loaded: boolean; onDeleted(runs: string[]): void }) {
  const [query, setQuery] = useState(''), [filters, setFilters] = useState<Filters>(noFilters);
  const visible = useMemo(() => applyFilters(runs, query, filters), [runs, query, filters]);
  // Select mode (checkboxes) for "Xoá đã chọn"; "Dọn run cũ" dialog.
  const [selecting, setSelecting] = useState(false), [picked, setPicked] = useState<string[]>([]), [deleting, setDeleting] = useState(false);
  const [failures, setFailures] = useState<{ run: string; error: string }[]>([]), [pruning, setPruning] = useState(false);
  // Drop picks that vanished or started running since they were checked.
  useEffect(() => {
    setPicked(current => { const next = current.filter(name => { const item = runs.find(run => run.run === name); return !!item && deletable(item); }); return next.length === current.length ? current : next; });
  }, [runs]);
  const pickable = visible.filter(deletable), allPicked = pickable.length > 0 && pickable.every(item => picked.includes(item.run));
  const stopSelecting = () => { setSelecting(false); setPicked([]); };
  const removePicked = async () => {
    setDeleting(true); setFailures([]);
    try {
      const outcome = await deleteSelected(runs.filter(item => picked.includes(item.run)));
      if (!outcome) return;
      setFailures(outcome.failed);
      if (outcome.deleted.length) onDeleted(outcome.deleted.map(item => item.run));
      if (!outcome.failed.length) stopSelecting(); else setPicked(outcome.failed.map(item => item.run));
    } finally { setDeleting(false); }
  };
  const workflowNames = useMemo(() => [...new Set(runs.map(item => item.workflow))].sort(), [runs]);
  const waiting = visible.filter(item => item.status === 'waiting'), live = visible.filter(item => item.status === 'running' || (item.busy && item.status !== 'waiting'));
  const recent = visible.filter(item => !waiting.includes(item) && !live.includes(item));
  const toggle = (name: string) => setPicked(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  const row = (item: RunSummary) => <Row key={item.run} item={item} selected={item.run === selected} open={() => open(item.run)}
    pick={selecting ? { checked: picked.includes(item.run), disabled: !deletable(item), toggle: () => toggle(item.run) } : undefined} />;
  return <aside className="flex min-h-0 flex-col gap-2.5 border-r px-3 py-3" aria-label="Danh sách run">
    <Button className="w-full" onClick={startNew}><Plus />Run mới</Button>
    <div className="flex gap-1.5">
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Tìm run" placeholder="Tìm run…" value={query} onChange={event => setQuery(event.target.value)} className="pl-8" /></div>
      <FilterPopover runs={runs} filters={filters} setFilters={setFilters} shown={visible.length} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon" aria-label="Thêm thao tác với run"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled={!runs.length} onSelect={() => { setSelecting(true); setFailures([]); }}><ListChecks />Chọn nhiều run để xoá</DropdownMenuItem>
          <DropdownMenuItem disabled={!runs.length} onSelect={() => setPruning(true)}><Eraser />Dọn run cũ…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {selecting && <div className="flex flex-col gap-1.5 rounded-md border bg-muted/50 px-2.5 py-2">
      <div className="flex items-center gap-2 text-[12px] text-fg-2">
        <label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" className="size-3.5 accent-primary" checked={allPicked} disabled={!pickable.length}
          onChange={event => setPicked(event.target.checked ? [...new Set([...picked, ...pickable.map(item => item.run)])] : picked.filter(name => !pickable.some(item => item.run === name)))} />Chọn tất cả</label>
        <span className="ml-auto tabular-nums text-muted-foreground">{picked.length} đã chọn</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="danger" disabled={!picked.length || deleting} onClick={() => void removePicked()}><Trash2 />Xoá đã chọn</Button>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={deleting} onClick={stopSelecting}>Xong</Button>
      </div>
      <span className="text-[11px] text-muted-foreground">Run đang chạy không chọn được.</span>
    </div>}
    {failures.length > 0 && <Callout tone="danger" icon={<CircleAlert />}>
      <div className="flex flex-col gap-1"><span>Không xoá được {failures.length} run:</span>
        {failures.map(item => <span key={item.run} className="break-words"><code className="font-mono">{item.run}</code>: {item.error}</span>)}</div></Callout>}
    <div className="-mx-1 min-h-0 flex-1 overflow-auto px-1">
      {loaded && runs.length === 0 && <p className="m-0 px-2.5 py-3 text-[12.5px] text-muted-foreground">Chưa có run nào. Bấm “Run mới” để chạy một workflow.</p>}
      {runs.length > 0 && visible.length === 0 && <div className="px-2.5 py-3 text-[12.5px] text-muted-foreground">Không có run khớp.{' '}
        <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[12.5px] text-foreground underline" onClick={() => { setQuery(''); setFilters(noFilters); }}>Xóa lọc</button></div>}
      {waiting.length > 0 && <Group title="Cần bạn" count={waiting.length}>{waiting.map(row)}</Group>}
      {live.length > 0 && <Group title="Đang chạy" count={live.length}>{live.map(row)}</Group>}
      {recent.length > 0 && <Group title="Gần đây" count={recent.length}>{recent.map(row)}</Group>}
    </div>
    <PruneDialog open={pruning} onOpenChange={setPruning} workflows={workflowNames} onDeleted={onDeleted} />
  </aside>;
}
