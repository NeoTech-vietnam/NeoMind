import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow, useNodesInitialized, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import { ArrowDownFromLine, ArrowRightFromLine, Crosshair, Maximize2, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { kindLabel, stepStateInfo } from './format';
import { collapse, GROUP_LABEL, GROUP_PREFIX, groupBindings, groupDetail, groupState, inferGroups, representative, type GroupBinding, type Groups } from './groups';
import { backPoints, backRoute, graphHeight, isTerminal, labelPoint, layoutGraph, LR_LAYER_GAP, NODE_H, NODE_W, roundedPath, TERMINAL_W, type BackRoute, type Direction } from './layout';
import type { Graph, StepInfo, StepState } from './types';
import { GroupBindingBadges, NodeBindingBadges } from './catalog/BindingBadges';

const ring: Record<string, string> = { success: 'border-success', running: 'border-running', attention: 'border-attention', danger: 'border-danger', idle: 'border-border' };
const fill: Record<string, string> = { success: 'bg-success/10', running: 'bg-running/10', attention: 'bg-attention/12', danger: 'bg-danger/10', idle: 'bg-card' };
const dot: Record<string, string> = { success: 'bg-success', running: 'bg-running animate-pulse', attention: 'bg-attention', danger: 'bg-danger', idle: 'bg-idle' };

type StepData = {
  id: string; label: string; kind: string; state: StepState; detail?: string | undefined; selected: boolean; dir: Direction; rev: boolean;
  group?: { kind: string } | undefined; collapsible?: string | undefined; toggle(group: string): void;
  /** Phase 2b: role and skills of an ai step (graph node fields). */
  binding?: { role?: string | null | undefined; skills?: string[] | null | undefined } | undefined;
  /** A collapsed group: the roles and skills of its inner ai steps. */
  groupBinding?: GroupBinding | undefined;
};

const handle = '!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent';
/** Main flow in/out along the direction; one side carries edges that skip layers, the other loops back. */
function Handles({ dir, rev = false }: { dir: Direction; rev?: boolean }) {
  const [inP, outP, skipP, backP] = dir === 'TB' ? [Position.Top, Position.Bottom, Position.Right, Position.Left]
    : rev ? [Position.Right, Position.Left, Position.Bottom, Position.Top] : [Position.Left, Position.Right, Position.Bottom, Position.Top];
  const at = (p: Position, f: string) => (p === Position.Left || p === Position.Right ? { top: f } : { left: f });
  return <>
    <Handle id="in" type="target" position={inP} className={handle} /><Handle id="out" type="source" position={outP} className={handle} />
    <Handle id="si" type="target" position={skipP} className={handle} style={at(skipP, '35%')} /><Handle id="so" type="source" position={skipP} className={handle} style={at(skipP, '65%')} />
    <Handle id="bi" type="target" position={backP} className={handle} style={at(backP, '35%')} /><Handle id="bo" type="source" position={backP} className={handle} style={at(backP, '65%')} />
  </>;
}

const StepNode = memo(function StepNode({ data }: NodeProps<Node<StepData>>) {
  const info = stepStateInfo(data.state), tone = data.state === 'rejected' ? 'idle' : info.status;
  if (isTerminal(data.kind)) return <div style={{ width: TERMINAL_W }} className="grid h-7 place-items-center rounded-full border bg-muted text-[11px] text-muted-foreground">
    <Handles dir={data.dir} rev={data.rev} />{data.kind}</div>;
  const group = data.group;
  return <div style={{ width: NODE_W, height: NODE_H }} title={`${data.label} · ${group ? GROUP_LABEL[group.kind as keyof typeof GROUP_LABEL] : kindLabel(data.kind)} · ${info.label}`}
    className={cn('relative flex flex-col justify-center rounded-md border-2 px-2.5 text-left', ring[tone], fill[data.state === 'todo' ? 'idle' : tone],
      data.kind === 'gate' && 'border-dashed', group && 'shadow-[3px_3px_0_0_var(--border)]', data.selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background')}>
    <Handles dir={data.dir} rev={data.rev} />
    <div className="flex items-center gap-1.5"><span className={cn('size-2 shrink-0 rounded-full', dot[tone])} /><span className="truncate font-mono text-[12px] font-semibold text-foreground">{data.label}</span></div>
    <div className="truncate pl-3.5 text-[11px] text-muted-foreground">{group ? GROUP_LABEL[group.kind as keyof typeof GROUP_LABEL] : kindLabel(data.kind)}{data.state !== 'todo' && ` · ${info.label}`}{data.detail && ` · ${data.detail}`}</div>
    {(group || data.collapsible) && <button type="button" aria-label={group ? `Mở nhóm ${data.label}` : `Gộp nhóm ${data.collapsible}`}
      className="nodrag absolute -top-2 -right-2 grid size-5 cursor-pointer place-items-center rounded-full border bg-background text-foreground shadow-sm hover:bg-accent"
      onClick={event => { event.stopPropagation(); data.toggle(group ? data.id.slice(GROUP_PREFIX.length) : data.collapsible!); }}>
      {group ? <Plus className="size-3" /> : <Minus className="size-3" />}</button>}
    {!group && data.binding && <NodeBindingBadges binding={data.binding} className="pointer-events-auto absolute -bottom-[9px] right-2 max-w-[calc(100%-16px)] rounded bg-background" />}
    {group && data.groupBinding && <GroupBindingBadges binding={data.groupBinding} className="pointer-events-auto absolute -bottom-[9px] right-2 max-w-[calc(100%-16px)] rounded bg-background" />}
  </div>;
});
const nodeTypes = { step: StepNode };

/** A loop's "again" (any back edge), routed through the gaps between nodes (layout.backRoute) instead of across them. */
function BackEdge({ sourceX, sourceY, targetX, targetY, data, markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding }: EdgeProps<Edge<{ route: BackRoute }>>) {
  const points = backPoints(data!.route, sourceX, sourceY, targetX, targetY), at = labelPoint(points);
  const rest = Object.fromEntries(Object.entries({ markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding }).filter(([, v]) => v !== undefined));
  return <BaseEdge path={roundedPath(points)} labelX={at.x} labelY={at.y} labelShowBg {...rest} />;
}
const edgeTypes = { back: BackEdge };

const readDir = (): Direction => { try { return localStorage.getItem('langflow.graphDir') === 'TB' ? 'TB' : 'LR'; } catch { return 'LR'; } };

/** Fits the view to the active step and its neighbours when the active step or the layout changes, never on a mere poll. */
function AutoFocus({ target, around, layoutKey }: { target: string | null; around: string[]; layoutKey: string }) {
  const flow = useReactFlow(), ready = useNodesInitialized(), last = useRef('');
  useEffect(() => {
    if (!ready) return;
    const key = `${layoutKey}|${target ?? ''}`;
    if (key === last.current) return;
    const opts = { duration: last.current === '' ? 0 : 300 };
    // a little later than the render: React Flow measures the new canvas size and node positions first
    const id = window.setTimeout(() => {
      last.current = key;
      if (target) void flow.fitView({ ...opts, nodes: [target, ...around].map(id => ({ id })), padding: 0.3, maxZoom: 1 });
      else void flow.fitView({ ...opts, padding: 0.08, maxZoom: 1 });
    }, 60);
    return () => window.clearTimeout(id);
  }, [ready, target, around, layoutKey, flow]);
  return null;
}

/**
 * The run's workflow as a graph laid out here, each step coloured by its state. Composite steps (parallel, fan-out,
 * loop, route) start collapsed into one node (+ opens, − closes). Left-to-right by default; the view follows the
 * active step. Dashed edges are conditional.
 */
export function RunGraph({ graph, states, info, details, selected, active, onSelect }: {
  graph: Graph; states: Record<string, StepState>; info: Record<string, StepInfo>; details?: Record<string, string>;
  selected: string | null; active: string | null; onSelect(id: string | null): void;
}) {
  const [dir, setDir] = useState<Direction>(readDir), [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<{ mode: 'active' | 'all'; tick: number }>({ mode: 'active', tick: 0 });
  useEffect(() => { try { localStorage.setItem('langflow.graphDir', dir); } catch { /* storage may be off */ } }, [dir]);
  const groups: Groups = useMemo(() => inferGroups(graph), [graph]);
  const shown = useMemo(() => collapse(graph, groups, expanded), [graph, groups, expanded]);
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width))); ro.observe(el); return () => ro.disconnect(); }, []);
  // snake rows: as many layers per row as fit the panel at about 0.85 zoom (at least 3)
  const perRow = dir === 'LR' && width > 0 ? Math.max(3, Math.floor((width - 30) / (0.85 * (NODE_W + LR_LAYER_GAP)))) : 0;
  const layout = useMemo(() => layoutGraph(shown, dir, perRow), [shown, dir, perRow]);
  const toggle = (group: string) => setExpanded(current => { const set = new Set(current); if (set.has(group)) { set.delete(group); for (const g of groups.list) if (g.parent === group) set.delete(g.id); } else set.add(group); return set; });
  const anchors = useMemo(() => new Map([...expanded].map(id => { const g = groups.byId.get(id); return [g?.head ?? `${id}_check`, id]; })), [expanded, groups]);
  const rep = (id: string | null) => (id ? representative(id, groups, expanded) : null);
  const target = rep(active), selectedRep = rep(selected);
  const nodes = useMemo<Node<StepData>[]>(() => shown.nodes.map(node => {
    const group = node.id.startsWith(GROUP_PREFIX) ? groups.byId.get(node.id.slice(GROUP_PREFIX.length)) : undefined;
    return { id: node.id, type: 'step', position: layout.positions[node.id] ?? { x: 0, y: 0 }, draggable: false, connectable: false,
      data: { id: node.id, label: group ? group.id : node.id, kind: group ? 'group' : node.kind, dir, rev: layout.reversed.has(node.id),
        state: group ? groupState(group, graph, states) : states[node.id] ?? 'todo',
        detail: group ? groupDetail(group, graph, states, info) : details?.[node.id], selected: node.id === selectedRep,
        group: group ? { kind: group.kind } : undefined, collapsible: anchors.get(node.id), toggle,
        binding: !group && (node.role || node.skills?.length) ? { role: node.role, skills: node.skills } : undefined,
        groupBinding: group ? groupBindings(group, graph) ?? undefined : undefined } };
  }), [shown, layout, groups, graph, states, info, details, selectedRep, anchors, dir]);
  const edges = useMemo<Edge[]>(() => {
    let skipCount = 0, backCount = 0;
    // a gate's reject goes straight to the end: drawn as a long detour across the snake, so it is left out (the
    // dashed gate border says it can stop the run)
    return shown.edges.flatMap((edge, index) => {
      if (edge.label === 'reject' && edge.target === '__end__') return [];
      const live = (nodes.find(n => n.id === edge.target)?.data.state === 'running') && (nodes.find(n => n.id === edge.source)?.data.state === 'done');
      const back = layout.back.has(index), skip = !back && (layout.layer[edge.target] ?? 0) - (layout.layer[edge.source] ?? 0) > 1;
      const route = back ? backRoute(layout, edge.source, edge.target, backCount++) : null;
      const side = back && route ? { sourceHandle: 'bo', targetHandle: 'bi', type: 'back', data: { route } }
        : back ? { sourceHandle: 'bo', targetHandle: 'bi', type: 'smoothstep', pathOptions: { offset: 22 + 12 * backCount, borderRadius: 10 } }
        : skip ? { sourceHandle: 'so', targetHandle: 'si', type: 'smoothstep', pathOptions: { offset: 22 + 12 * skipCount++, borderRadius: 10 } }
          : { sourceHandle: 'out', targetHandle: 'in', type: dir === 'LR' ? 'smoothstep' : 'default', pathOptions: { borderRadius: 10 } };
      return [{ id: `${index}`, source: edge.source, target: edge.target, animated: live, ...side,
        ...(edge.label ? { label: edge.label, labelStyle: { fontSize: 11, fill: 'var(--muted-foreground)' }, labelBgStyle: { fill: 'var(--background)' }, labelBgPadding: [4, 2] as [number, number] } : {}),
        style: { stroke: live ? 'var(--running)' : 'var(--muted-foreground)', strokeWidth: 1.4, ...(edge.conditional ? { strokeDasharray: '5 4' } : {}) },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: live ? 'var(--running)' : 'var(--muted-foreground)' } } as Edge];
    });
  }, [shown, layout, nodes, dir]);
  const around = useMemo(() => (target ? shown.edges.flatMap(e => (e.source === target ? [e.target] : e.target === target ? [e.source] : [])) : []), [shown, target]);
  const layoutKey = `${dir}|${perRow}|${[...expanded].sort().join(',')}|${view.mode}${view.tick}`;
  const allOpen = groups.list.length > 0 && groups.list.every(g => expanded.has(g.id));
  return <div className="flex flex-col gap-1.5">
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <div className="inline-flex rounded-md border p-0.5">
        <Tooltip label="Trái sang phải"><Button size="sm" variant="ghost" className={cn('h-6 px-2', dir === 'LR' && 'bg-accent text-foreground')} onClick={() => setDir('LR')}><ArrowRightFromLine />Ngang</Button></Tooltip>
        <Tooltip label="Trên xuống dưới"><Button size="sm" variant="ghost" className={cn('h-6 px-2', dir === 'TB' && 'bg-accent text-foreground')} onClick={() => setDir('TB')}><ArrowDownFromLine />Dọc</Button></Tooltip>
      </div>
      {groups.list.length > 0 && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setExpanded(allOpen ? new Set() : new Set(groups.list.map(g => g.id)))}>
        {allOpen ? <Minus /> : <Plus />}{allOpen ? 'Gộp tất cả nhóm' : `Mở tất cả nhóm (${groups.list.length})`}</Button>}
      <span className="ml-auto flex items-center gap-1">
        {target && <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setView(v => ({ mode: 'active', tick: v.tick + 1 }))}><Crosshair />Bước hiện tại</Button>}
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setView(v => ({ mode: 'all', tick: v.tick + 1 }))}><Maximize2 />Toàn bộ</Button>
      </span>
    </div>
    <div ref={box} style={{ height: graphHeight(layout) }} className="overflow-hidden rounded-md border bg-background" aria-label="Sơ đồ workflow của run">
      {(dir === 'TB' || width > 0) && <ReactFlow key={`${dir}|${perRow}|${[...expanded].sort().join(',')}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
        onNodeClick={(_, node) => { if (node.data.group) toggle(node.id.slice(GROUP_PREFIX.length)); else onSelect(isTerminal(node.data.kind) ? null : node.id); }}
        onPaneClick={() => onSelect(null)} fitView fitViewOptions={{ padding: 0.1, maxZoom: 1 }} minZoom={0.15} maxZoom={1.8} proOptions={{ hideAttribution: true }}>
        <Background gap={18} size={1} /><Controls showInteractive={false} />
        <AutoFocus target={view.mode === 'all' ? null : target} around={around} layoutKey={layoutKey} />
      </ReactFlow>}
    </div>
  </div>;
}
