/**
 * Top-down layered layout for a workflow graph (the API gives no positions): back edges (a loop's "again") are set
 * aside, every node goes one layer below its lowest parent (longest path), and each layer is ordered by the mean
 * position of its parents to keep crossings down.
 */
import type { Graph } from './types';

export const NODE_W = 184, NODE_H = 50, TERMINAL_W = 64, LAYER_GAP = 84, COL_GAP = 36, LR_LAYER_GAP = 64, LR_ROW_GAP = 26;
export const isTerminal = (kind: string) => kind === 'start' || kind === 'end';

/** TB: top-down (layers are rows). LR: left to right (layers are columns), better for long flows on a wide screen. */
export type Direction = 'TB' | 'LR';
export type Layout = { positions: Record<string, { x: number; y: number }>; back: Set<number>; layer: Record<string, number>; dir: Direction; width: number; height: number;
  /** LR wrapped like a snake: nodes on a right-to-left row (their flow enters right, leaves left), and the row of each node. */
  reversed: Set<string>; row: Record<string, number> };

/** perRow (LR only): wrap after that many layers, the next row running back the other way (snake), so a long flow
 *  fits the panel width instead of stretching to the right. */
export function layoutGraph(graph: Graph, dir: Direction = 'TB', perRow = 0): Layout {
  const ids = graph.nodes.map(node => node.id), kinds = new Map(graph.nodes.map(node => [node.id, node.kind]));
  const out = new Map<string, number[]>(ids.map(id => [id, []]));
  graph.edges.forEach((edge, index) => { if (out.has(edge.source) && out.has(edge.target)) out.get(edge.source)!.push(index); });

  // Back edges: a loop's "again", or any edge that closes a cycle in a depth-first walk from the start.
  const back = new Set<number>(), state = new Map<string, 1 | 2>();
  graph.edges.forEach((edge, index) => { if (edge.label === 'again') back.add(index); });
  const visit = (id: string) => {
    state.set(id, 1);
    for (const index of out.get(id) ?? []) {
      if (back.has(index)) continue;
      const target = graph.edges[index]!.target, seen = state.get(target);
      if (seen === 1) back.add(index); else if (!seen) visit(target);
    }
    state.set(id, 2);
  };
  for (const id of ids.includes('__start__') ? ['__start__', ...ids] : ids) if (!state.has(id)) visit(id);

  // Longest-path layers over the remaining DAG (Kahn order).
  const forward = graph.edges.map((edge, index) => ({ ...edge, index })).filter(edge => !back.has(edge.index) && out.has(edge.source) && out.has(edge.target));
  const indegree = new Map(ids.map(id => [id, 0])), layer = new Map(ids.map(id => [id, 0]));
  for (const edge of forward) indegree.set(edge.target, indegree.get(edge.target)! + 1);
  const queue = ids.filter(id => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of forward.filter(item => item.source === id)) {
      layer.set(edge.target, Math.max(layer.get(edge.target)!, layer.get(id)! + 1));
      indegree.set(edge.target, indegree.get(edge.target)! - 1);
      if (indegree.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  // The end node always sits on the last layer.
  if (layer.has('__end__')) layer.set('__end__', Math.max(...ids.filter(id => id !== '__end__').map(id => layer.get(id)! + 1), 0));

  const layers: string[][] = [];
  for (const id of ids) (layers[layer.get(id)!] ??= []).push(id);
  const rank = new Map<string, number>();
  const place = (row: string[]) => row.forEach((id, index) => rank.set(id, index - (row.length - 1) / 2));
  layers.forEach(row => row && place(row));
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const row of layers) {
      if (!row) continue;
      const mean = (id: string) => {
        const parents = forward.filter(edge => edge.target === id).map(edge => rank.get(edge.source)!);
        return parents.length ? parents.reduce((sum, value) => sum + value, 0) / parents.length : rank.get(id)!;
      };
      const keys = new Map(row.map(id => [id, mean(id)]));
      row.sort((a, b) => keys.get(a)! - keys.get(b)!);
      place(row);
    }
  }

  const positions: Layout['positions'] = {}, reversed = new Set<string>(), rowOf: Record<string, number> = {};
  const wrap = dir === 'LR' && perRow > 0 ? perRow : Number.MAX_SAFE_INTEGER;
  // each band (row of the snake) is as tall as its widest layer; bands stack with a gap for the U-turn edges
  const bandRanks: { min: number; max: number }[] = [];
  layers.forEach((row, depth) => row?.forEach(id => {
    const band = Math.floor(depth / wrap), r = rank.get(id)!;
    const b = (bandRanks[band] ??= { min: r, max: r }); b.min = Math.min(b.min, r); b.max = Math.max(b.max, r);
  }));
  const bandTop: number[] = [];
  bandRanks.forEach((b, i) => { bandTop[i] = i === 0 ? 0 : bandTop[i - 1]! + (bandRanks[i - 1]!.max - bandRanks[i - 1]!.min + 1) * (NODE_H + LR_ROW_GAP) + 40; });
  layers.forEach((row, depth) => row?.forEach(id => {
    const terminal = isTerminal(kinds.get(id) ?? ''), width = terminal ? TERMINAL_W : NODE_W;
    if (dir === 'TB') {
      const center = rank.get(id)! * (NODE_W + COL_GAP);
      positions[id] = { x: center - width / 2, y: depth * LAYER_GAP + (terminal ? (NODE_H - 28) / 2 : 0) };
    } else {
      const band = Math.floor(depth / wrap), back = band % 2 === 1, col = depth % wrap, span = wrap === Number.MAX_SAFE_INTEGER ? 0 : wrap - 1;
      if (back) reversed.add(id);
      rowOf[id] = band;
      positions[id] = { x: (back ? span - col : col) * (NODE_W + LR_LAYER_GAP) + (terminal ? (NODE_W - TERMINAL_W) / 2 : 0),
        y: (bandTop[band] ?? 0) + (rank.get(id)! - (bandRanks[band]?.min ?? 0)) * (NODE_H + LR_ROW_GAP) + (terminal ? (NODE_H - 28) / 2 : 0) };
    }
  }));
  const xs = Object.values(positions).map(p => p.x), ys = Object.values(positions).map(p => p.y);
  const width = xs.length ? Math.max(...xs) - Math.min(...xs) + NODE_W : 0, height = ys.length ? Math.max(...ys) - Math.min(...ys) + NODE_H : 0;
  return { positions, back, layer: Object.fromEntries(layer), dir, width, height, reversed, row: rowOf };
}

/** Canvas height (px): the whole graph at a readable zoom, kept within a band so a long flow never stretches the page. */
export function graphHeight(layout: Layout): number {
  return layout.dir === 'LR' ? Math.round(Math.min(560, Math.max(220, layout.height * 0.85 + 70)))
    : Math.round(Math.min(560, Math.max(300, layout.height * 0.9 + 60)));
}

/**
 * Corridors for a back edge (a loop's "again"), so it never runs through a node:
 *   LR: up from the source into the row gap, sideways into the column gap on the flow's earlier side (left on a
 *       left-to-right row, right on a snake's right-to-left row), up that gap to a lane just above the target's
 *       band, along the lane, down into the target. Column gaps line up across the snake's bands, so the climb
 *       crosses edges at most, never a node.
 *   TB: out of the source's left side, through the row gap above its layer (when a node sits to its left) to a lane
 *       left of every node between the two layers, up it, back in through the row gap above the target's layer.
 * `k` spreads several back edges apart. Coordinates are flow coordinates; the edge takes its end points from its
 * handles and only these corridor values from here.
 */
export type BackRoute =
  | { dir: 'LR'; stubY: number; gapX: number; laneY: number; entry: { x: number; y: number } | null }
  | { dir: 'TB'; stubX: number; laneX: number; aboveSource: number | null; aboveTarget: number | null };

export function backRoute(layout: Layout, source: string, target: string, k = 0): BackRoute | null {
  const s = layout.positions[source], t = layout.positions[target];
  if (!s || !t) return null;
  const ids = Object.keys(layout.positions);
  if (layout.dir === 'LR') {
    const band = layout.row[target] ?? 0, reversed = layout.reversed.has(source);
    const tops = ids.filter(id => (layout.row[id] ?? 0) === band).map(id => layout.positions[id]!.y);
    const side = (rev: boolean, x: number) => (rev ? x + NODE_W + LR_LAYER_GAP / 2 + 8 * k : x - LR_LAYER_GAP / 2 - 8 * k);
    // a node above the target in its column: come down the column gap beside it, then in through the row gap
    const covered = ids.some(id => id !== target && (layout.row[id] ?? 0) === band && layout.positions[id]!.x === t.x && layout.positions[id]!.y < t.y);
    return { dir: 'LR', stubY: s.y - LR_ROW_GAP / 2, gapX: side(reversed, s.x), laneY: Math.min(...tops) - 18 - 10 * k,
      entry: covered ? { x: side(layout.reversed.has(target), t.x), y: t.y - LR_ROW_GAP / 2 } : null };
  }
  const ls = layout.layer[source] ?? 0, lt = layout.layer[target] ?? 0, lo = Math.min(ls, lt), hi = Math.max(ls, lt);
  const span = ids.filter(id => (layout.layer[id] ?? 0) >= lo && (layout.layer[id] ?? 0) <= hi).map(id => layout.positions[id]!.x);
  const leftOf = (id: string, p: { x: number }) => ids.some(o => o !== id && layout.layer[o] === layout.layer[id] && layout.positions[o]!.x < p.x);
  const rowGap = (LAYER_GAP - NODE_H) / 2;
  return { dir: 'TB', stubX: 14, laneX: Math.min(...span) - 24 - 12 * k,
    aboveSource: leftOf(source, s) ? s.y - rowGap : null, aboveTarget: leftOf(target, t) ? t.y - rowGap : null };
}

/** The corner points of a back edge from its handle points (sx, sy) -> (tx, ty) and its corridors. */
export function backPoints(r: BackRoute, sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] {
  if (r.dir === 'LR') return [{ x: sx, y: sy }, { x: sx, y: r.stubY }, { x: r.gapX, y: r.stubY }, { x: r.gapX, y: r.laneY },
    ...(r.entry ? [{ x: r.entry.x, y: r.laneY }, { x: r.entry.x, y: r.entry.y }, { x: tx, y: r.entry.y }] : [{ x: tx, y: r.laneY }]), { x: tx, y: ty }];
  const pts = [{ x: sx, y: sy }, { x: sx - r.stubX, y: sy }];
  if (r.aboveSource !== null) pts.push({ x: sx - r.stubX, y: r.aboveSource }, { x: r.laneX, y: r.aboveSource }); else pts.push({ x: r.laneX, y: sy });
  if (r.aboveTarget !== null) pts.push({ x: r.laneX, y: r.aboveTarget }, { x: tx - r.stubX, y: r.aboveTarget }, { x: tx - r.stubX, y: ty }); else pts.push({ x: r.laneX, y: ty });
  pts.push({ x: tx, y: ty });
  return pts;
}

/** SVG path through orthogonal points with rounded corners (radius r, smaller on short segments). */
export function roundedPath(points: { x: number; y: number }[], r = 10): string {
  const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
  if (pts.length < 2) return '';
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const r1 = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const ux = Math.sign(b.x - a.x), uy = Math.sign(b.y - a.y), vx = Math.sign(c.x - b.x), vy = Math.sign(c.y - b.y);
    d += ` L ${b.x - ux * r1} ${b.y - uy * r1} Q ${b.x} ${b.y} ${b.x + vx * r1} ${b.y + vy * r1}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

/** Where a back edge's label goes: the middle of its longest segment (the lane). */
export function labelPoint(points: { x: number; y: number }[]): { x: number; y: number } {
  let best = 0, at = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) { best = len; at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  }
  return at;
}
