import { useMemo } from 'react';
import { BookOpen, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { kindLabel, shortTime, stepStateInfo } from './format';
import { GROUP_LABEL, groupBindings, groupDetail, groupState, inferGroups, type Group, type GroupBinding } from './groups';
import { GroupBindingBadges, NodeBindingBadges } from './catalog/BindingBadges';
import type { Graph, StepInfo, StepState } from './types';

const tone: Record<string, string> = { success: 'bg-success', running: 'bg-running animate-pulse', attention: 'bg-attention', danger: 'bg-danger', idle: 'bg-idle' };
const chipTone: Record<string, string> = { success: 'border-success/60 bg-success/10', running: 'border-running bg-running/10', attention: 'border-attention bg-attention/12', danger: 'border-danger bg-danger/10', idle: 'border-border bg-card' };
const CHIP_KINDS = new Set(['ai', 'script', 'write', 'gate', 'worker', 'route', 'fanout']);

type Row = { id: string; label: string; kind: string; state: StepState; detail: string; start?: string | undefined; end?: string | undefined; group?: Group; chips: string[];
  /** Phase 2b: the step's role and skills, or a group's summary of its inner steps. */
  binding?: { role?: string | null | undefined; skills?: string[] | null | undefined } | undefined; groupBinding?: GroupBinding | undefined };

/**
 * Compact progress view: one row per top-level step in run order; a composite step (parallel, fan-out, loop, route)
 * is one row with its inner steps as small chips. Stays short however long the workflow is.
 */
export function Stepper({ graph, states, info, details, selected, active, onSelect }: {
  graph: Graph; states: Record<string, StepState>; info: Record<string, StepInfo>; details?: Record<string, string>;
  selected: string | null; active: string | null; onSelect(id: string): void;
}) {
  const groups = useMemo(() => inferGroups(graph), [graph]);
  const kinds = useMemo(() => new Map(graph.nodes.map(node => [node.id, node.kind])), [graph]);
  const byId = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph]);
  const bindingText = (id: string) => { const n = byId.get(id); return [n?.role ? `role ${n.role}` : '', n?.skills?.length ? `skill ${n.skills.join(', ')}` : ''].filter(Boolean).join(' · '); };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [], emitted = new Set<string>();
    for (const node of graph.nodes) {
      if (node.kind === 'start' || node.kind === 'end') continue;
      const outer = (groups.chain.get(node.id) ?? []).at(-1);
      if (!outer) {
        const i = info[node.id] ?? {};
        out.push({ id: node.id, label: node.id, kind: node.kind, state: states[node.id] ?? 'todo', detail: details?.[node.id] ?? '', start: i.start, end: i.end, chips: [],
          binding: node.role || node.skills?.length ? { role: node.role, skills: node.skills } : undefined });
      } else if (!emitted.has(outer)) {
        emitted.add(outer);
        const group = groups.byId.get(outer)!;
        const members = graph.nodes.map(n => n.id).filter(id => group.members.has(id) && CHIP_KINDS.has(kinds.get(id) ?? '') && !(group.kind === 'parallel' && id === group.head));
        const times = [...group.members].map(id => info[id] ?? {});
        const starts = times.map(t => t.start).filter(Boolean).sort(), ends = times.map(t => t.end).filter(Boolean).sort();
        out.push({ id: group.head ?? `${group.id}_check`, label: group.id, kind: 'group', state: groupState(group, graph, states), detail: groupDetail(group, graph, states, info),
          start: starts[0], end: ends.at(-1), group, chips: members, groupBinding: groupBindings(group, graph) ?? undefined });
      }
    }
    return out;
  }, [graph, groups, kinds, states, info, details]);
  const workerOf = (id: string | null) => (id ? id.replace(/\[\d+\]$/, '_worker') : null);
  const act = workerOf(active), sel = workerOf(selected);
  return <ol className="m-0 flex list-none flex-col rounded-md border p-0">
    {rows.map((row, index) => {
      const info2 = stepStateInfo(row.state), t = row.state === 'rejected' ? 'idle' : info2.status;
      const isActive = act !== null && (row.id === act || row.chips.includes(act) || (row.group?.members.has(act) ?? false));
      return <li key={row.label} className={cn('flex items-start gap-3 border-t px-3 py-2 first:border-t-0', isActive && 'bg-attention/8', (sel === row.id || row.chips.includes(sel ?? '')) && 'bg-accent')}>
        <span className="mt-1 flex w-5 shrink-0 flex-col items-center"><span className={cn('size-2.5 rounded-full', tone[t])} /></span>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => onSelect(row.id)} className="flex w-full cursor-pointer flex-wrap items-baseline gap-x-2 border-0 bg-transparent p-0 text-left">
            <span className="text-[11px] tabular-nums text-faint">{index + 1}</span>
            <span className="font-mono text-[12.5px] font-semibold text-foreground">{row.label}</span>
            <span className="text-[11.5px] text-muted-foreground">{row.group ? GROUP_LABEL[row.group.kind] : kindLabel(row.kind)} · {info2.label}{row.detail && ` · ${row.detail}`}</span>
            {row.binding && <NodeBindingBadges binding={row.binding} className="self-center" />}
            {row.groupBinding && <GroupBindingBadges binding={row.groupBinding} className="self-center" />}
            <span className="ml-auto text-[11px] tabular-nums text-faint">{[shortTime(row.start), shortTime(row.end)].filter(Boolean).join(' → ')}</span>
          </button>
          {row.chips.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{row.chips.map(id => {
            const s = states[id] ?? 'todo', c = stepStateInfo(s), ct = s === 'rejected' ? 'idle' : c.status;
            const bt = bindingText(id);
            return <button key={id} type="button" title={`${id} · ${kindLabel(kinds.get(id) ?? '')} · ${c.label}${info[id]?.workers ? ` · ${info[id]!.workers}` : ''}${bt ? ` · ${bt}` : ''}`} onClick={() => onSelect(id)}
              className={cn('inline-flex h-6 cursor-pointer items-center gap-1 rounded border px-1.5 font-mono text-[11px] text-foreground', chipTone[ct], sel === id && 'ring-2 ring-ring')}>
              <span className={cn('size-1.5 rounded-full', tone[ct])} />{id}{info[id]?.workers ? ` (${info[id]!.workers})` : ''}
              {bt && (byId.get(id)?.role ? <Bot aria-label={bt} className="size-3 text-muted-foreground" /> : <BookOpen aria-label={bt} className="size-3 text-muted-foreground" />)}</button>;
          })}</div>}
        </div>
      </li>;
    })}
  </ol>;
}
