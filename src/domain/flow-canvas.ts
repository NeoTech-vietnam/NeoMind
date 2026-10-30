import { z } from 'zod';
import { resolveBinding, type BindingValues } from './resolve.js';
import { flowSchema, nodeSchema, type Flow, type FlowNode, type ProjectConfig } from './schema.js';

/**
 * Two-way conversion between a NeoMind flow and a JSON Canvas 1.0 board (`.canvas`, opened by Nimbalyst and
 * Obsidian). The board is the visual layout: one text card per step, one edge per transition. What a step does
 * stays NeoMind data: each card carries its node under `x-neomind`, and on import the current draft wins for every
 * step that still exists, so a canvas editor that drops unknown keys loses no configuration.
 *
 * Each card is a step (not an agent); its second line names the kind and who does it. Editable on the board: card
 * position, step name (first line), step kind (start of the second line, e.g. "Review"), deleting
 * cards, adding a card whose second line names a kind, and edges with their outcome as label. Other cards (notes,
 * groups, files, links) are ignored on import.
 */
export const FLOW_CANVAS_FORMAT = 'neomind-flow-canvas';
type Kind = FlowNode['type'];
type Outcome = Flow['definition']['edges'][number]['outcome'];
type Actor = 'agent' | 'reviewer' | 'user' | 'system';

/** Card color follows who does the step: orange agent, purple independent reviewer, yellow you, green NeoMind. */
const actorColor: Record<Actor, string> = { agent: '2', reviewer: '6', user: '3', system: '4' };
const kinds: Record<Kind, { label: string; actor: Actor; does: string }> = {
  start: { label: 'Bắt đầu', actor: 'system', does: 'NeoMind nhận yêu cầu' }, finish: { label: 'Hoàn tất', actor: 'system', does: 'NeoMind kết thúc run' },
  git_commit: { label: 'Commit local', actor: 'system', does: 'NeoMind tạo commit' }, approval: { label: 'Duyệt', actor: 'user', does: 'Bạn duyệt' },
  repair_scope: { label: 'Vòng sửa', actor: 'system', does: 'NeoMind điều phối sửa lại' }, agent_task: { label: 'Agent task', actor: 'agent', does: 'Agent' },
  review_group: { label: 'Review', actor: 'reviewer', does: 'Agent review độc lập' }, fork: { label: 'Phân nhánh', actor: 'system', does: 'NeoMind chia nhánh song song' },
  join: { label: 'Hợp nhánh', actor: 'system', does: 'NeoMind chờ các nhánh' }, condition: { label: 'Điều kiện', actor: 'system', does: 'NeoMind rẽ nhánh' },
  integration: { label: 'Tích hợp', actor: 'system', does: 'NeoMind ghép thay đổi' },
};
const outcomes: Outcome[] = ['completed', 'pass', 'needs_changes', 'blocked', 'true', 'false'];
const runnerNames: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };
const modelNames: Record<string, string> = { 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-opus-5-5': 'Opus 5.5',
  'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6.1-sol': 'GPT-6.1 Sol' };
const effortNames: Record<string, string> = { low: 'suy luận thấp', medium: 'suy luận vừa', high: 'suy luận cao' };
/** Edges drawn only to explain the flow (the repair loop); import never turns them into transitions. */
export const ILLUSTRATIVE_EDGE = '↺';
const boardCards = new Set(['neomind-info', 'neomind-legend']);
// Canvas cards are larger than studio cards; positions are spread on export and folded back on import.
const SCALE = 1.4, GRID = 20, CARD = { width: 280, height: 140 };
const snap = (value: number) => Math.round(value / GRID) * GRID;

const canvasNode = z.looseObject({ id: z.string().min(1), type: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  text: z.string().optional(), 'x-neomind': z.looseObject({ node: z.unknown().optional(), role: z.string().optional() }).optional() });
const canvasEdge = z.looseObject({ id: z.string().min(1), fromNode: z.string().min(1), toNode: z.string().min(1), label: z.string().optional(),
  'x-neomind': z.looseObject({ outcome: z.string().optional(), illustrative: z.boolean().optional() }).optional() });
const canvasSchema = z.looseObject({ nodes: z.array(canvasNode), edges: z.array(canvasEdge).default([]),
  'x-neomind': z.looseObject({ format: z.string().optional(), flow: z.unknown().optional(), draftRevision: z.string().optional() }).optional() });
export type FlowCanvas = z.infer<typeof canvasSchema>;

const agentName = (values: BindingValues) => [runnerNames[values.runner] ?? values.runner, modelNames[values.model] ?? values.model, effortNames[values.reasoning] ?? values.reasoning].join(' · ');
/** Runner/model a step really uses: resolved against the project's role defaults when the project is known. */
function agentLines(node: FlowNode, flow: Flow, project?: ProjectConfig): string[] {
  const resolve = (bindingId: string | undefined, profileId: string | undefined): string => {
    const binding = bindingId ? flow.definition.bindings[bindingId] : undefined;
    if (!binding) return 'chưa có binding';
    try { return agentName(resolveBinding(binding, flow.definition.bindingDefaults[bindingId!], project?.roleDefaults[profileId ?? ''] as BindingValues | undefined).values); }
    catch { return binding.runner.mode === 'pinned' ? runnerNames[binding.runner.value] ?? binding.runner.value : 'theo cấu hình project'; }
  };
  if (node.type === 'agent_task') return [resolve(node.bindingId, node.profileId)];
  if (node.type === 'integration' && node.bindingId) return [`Agent khi có xung đột: ${resolve(node.bindingId, node.profileId)}`];
  if (node.type === 'review_group') return node.reviewers.map(reviewer => `${reviewer.id}${reviewer.required ? '' : ' (không bắt buộc)'}: ${resolve(flow.definition.sessionGroups.find(group => group.id === reviewer.sessionGroup)?.bindingId, reviewer.profileId)}`);
  return [];
}
/** Second line: kind (read back on import), then who does the step and how. */
function actorLine(node: FlowNode): string {
  const kind = kinds[node.type];
  switch (node.type) {
    case 'approval': return `${kind.label} · ${node.mode === 'auto' ? 'NeoMind tự duyệt' : kind.does}`;
    case 'agent_task': return `${kind.label} · Agent ${node.permissions.write ? 'sửa code' : 'chỉ đọc'}`;
    case 'review_group': return `${kind.label} · ${kind.does} · ${node.reviewers.filter(item => item.required).length}/${node.reviewers.length} bắt buộc đạt`;
    case 'repair_scope': return `${kind.label} · ${kind.does}, tối đa ${node.maxRounds} vòng`;
    case 'join': return `${kind.label} · ${kind.does} (${node.requiredBranches.length} bắt buộc)`;
    case 'condition': return `${kind.label} · ${kind.does} theo ${node.field} ${node.operator}`;
    default: return `${kind.label} · ${kind.does}`;
  }
}
/** Plain-text card body: name, kind and who does it, then the agent(s) when the step has any. */
export function cardText(node: FlowNode, flow: Flow, project?: ProjectConfig): string {
  return [node.label, actorLine(node), ...agentLines(node, flow, project)].join('\n');
}
type Side = 'top' | 'right' | 'bottom' | 'left';
/** Connect cards along the way they are laid out: same row left/right, other rows bottom/top. */
function sides(from: { x: number; y: number }, to: { x: number; y: number }): { fromSide: Side; toSide: Side } {
  if (Math.abs(to.y - from.y) >= CARD.height) return to.y > from.y ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' };
  return to.x >= from.x ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' };
}

/** Height that fits the card text once it wraps at the card width (about 34 characters per line). */
function cardHeight(text: string): number {
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 34)), 0);
  return Math.max(CARD.height, Math.ceil((48 + lines * 22) / GRID) * GRID);
}
/**
 * Keep the studio arrangement but never let cards overlap: canvas cards are taller than studio cards, so a card that
 * lands on another (in reading order) is pushed below it.
 */
function separate<T extends { x: number; y: number; width: number; height: number }>(cards: T[]): T[] {
  const placed: T[] = [], gap = 40;
  for (const card of [...cards].sort((a, b) => a.y - b.y || a.x - b.x)) {
    for (let moved = true; moved;) {
      moved = false;
      for (const other of placed) {
        const overlaps = card.x < other.x + other.width + gap && other.x < card.x + card.width + gap && card.y < other.y + other.height + gap && other.y < card.y + card.height + gap;
        if (overlaps) { card.y = snap(other.y + other.height + gap); moved = true; }
      }
    }
    placed.push(card);
  }
  return cards;
}

export function flowToCanvas(flow: Flow, draftRevision?: string, project?: ProjectConfig): FlowCanvas {
  const fallback = (index: number) => ({ x: 80 + (index % 4) * 255, y: 110 + Math.floor(index / 4) * 165 });
  const nodes = separate(flow.definition.nodes.map((node, index) => {
    const position = flow.layout[node.id] ?? fallback(index), text = cardText(node, flow, project);
    return { id: node.id, type: 'text', x: snap(position.x * SCALE), y: snap(position.y * SCALE), width: CARD.width, height: cardHeight(text),
      color: actorColor[node.type === 'approval' && node.mode === 'auto' ? 'system' : kinds[node.type].actor], text, 'x-nimbalyst': { reference: { kind: 'native', nativeKind: 'text' } }, 'x-neomind': { node } };
  }));
  const at = new Map(nodes.map(node => [node.id, node]));
  const top = Math.min(...nodes.map(node => node.y)), left = Math.min(...nodes.map(node => node.x));
  const info = { id: 'neomind-info', type: 'text', x: left, y: top - 220, width: 760, height: 180, color: '5',
    text: `${flow.name} (${flow.flowId}) · flow NeoMind\nMỗi thẻ là một BƯỚC của flow, không phải một agent. Dòng 2 cho biết ai làm bước đó.\nSửa được: kéo thẻ, đổi tên (dòng 1), đổi loại bước (chữ đầu dòng 2), xóa thẻ, thêm thẻ (dòng 2 ghi loại bước, ví dụ "Review"), nối mũi tên với nhãn là kết quả (pass, needs_changes, …; để trống là xong thì đi tiếp).\nMũi tên ${ILLUSTRATIVE_EDGE} chỉ minh họa. Nhập lại: Flow studio › Quản lý › Nhập từ .canvas.`,
    'x-nimbalyst': { reference: { kind: 'native', nativeKind: 'sticky' } }, 'x-neomind': { role: 'info' } };
  const legend = { id: 'neomind-legend', type: 'text', x: left + 800, y: top - 220, width: 420, height: 180, color: '5',
    text: 'Chú giải màu\nCam: agent làm (lập kế hoạch, viết code)\nTím: agent review độc lập\nVàng: bạn duyệt\nXanh lá: NeoMind tự làm (bắt đầu, vòng sửa, commit, kết thúc)',
    'x-nimbalyst': { reference: { kind: 'native', nativeKind: 'sticky' } }, 'x-neomind': { role: 'info' } };
  const edges: Record<string, unknown>[] = flow.definition.edges.map(edge => ({ id: `e-${edge.from}-${edge.to}-${edge.outcome}`, fromNode: edge.from, toNode: edge.to,
    ...(at.has(edge.from) && at.has(edge.to) ? sides(at.get(edge.from)!, at.get(edge.to)!) : {}),
    ...(edge.outcome === 'completed' ? {} : { label: edge.outcome }), 'x-neomind': { outcome: edge.outcome } }));
  // The repair loop is a rule of the repair step, not a transition: draw it so the board reads like the run behaves.
  for (const repair of flow.definition.nodes) {
    if (repair.type !== 'repair_scope' || !at.has(repair.targetReviewId)) continue;
    for (const owner of repair.ownerNodeIds.filter(id => at.has(id))) {
      edges.push({ id: `loop-${repair.targetReviewId}-${owner}`, fromNode: repair.targetReviewId, toNode: owner, ...sides(at.get(repair.targetReviewId)!, at.get(owner)!),
        label: `${ILLUSTRATIVE_EDGE} chưa đạt: sửa lại (tối đa ${repair.maxRounds} vòng)`, color: '3', 'x-neomind': { illustrative: true } });
    }
  }
  const { layout: _layout, ...rest } = flow;
  return { nodes: [info, legend, ...nodes], edges: edges as FlowCanvas['edges'], 'x-nimbalyst': { version: 1, meta: { name: `Flow · ${flow.name}`, description: 'Sơ đồ flow NeoMind; sửa ở đây rồi nhập lại vào NeoMind' } },
    'x-neomind': { format: FLOW_CANVAS_FORMAT, flow: { ...rest, definition: { ...rest.definition, nodes: [], edges: [] } }, ...(draftRevision ? { draftRevision } : {}) } };
}

function kindOf(line: string | undefined): Kind | undefined {
  const head = (line ?? '').split('·')[0]!.trim().toLowerCase();
  if (!head) return undefined;
  return (Object.keys(kinds) as Kind[]).find(kind => kind === head || kinds[kind].label.toLowerCase() === head);
}
function slug(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
/** A new step of `kind` with the defaults the studio uses when a step is added from the palette. */
export function defaultNode(kind: Kind, id: string, label: string, flow: Flow): FlowNode {
  const group = flow.definition.sessionGroups[0]?.id ?? 'implementation-session', binding = flow.definition.sessionGroups[0]?.bindingId ?? 'implementer';
  const writer = flow.definition.nodes.find(node => node.type === 'agent_task' && node.permissions.write)?.id ?? 'implement';
  const base = { id, label };
  switch (kind) {
    case 'start': case 'finish': case 'fork': case 'git_commit': return { ...base, type: kind };
    case 'approval': return { ...base, type: kind, purpose: 'Duyệt kế hoạch trước khi thực hiện' };
    case 'join': return { ...base, type: kind, requiredBranches: [writer] };
    case 'condition': return { ...base, type: kind, field: 'result', operator: 'eq', value: 'pass' };
    case 'integration': return { ...base, type: kind, writeScopes: ['.'], profileId: 'implementer', profileVersion: 1, sessionGroup: group, bindingId: binding };
    case 'repair_scope': return { ...base, type: kind, targetReviewId: flow.definition.nodes.find(node => node.type === 'review_group')?.id ?? 'review', ownerNodeIds: [writer], maxRounds: 2 };
    case 'review_group': {
      const producer = flow.definition.nodes.find(node => node.id === writer);
      const reviewerGroup = flow.definition.sessionGroups.find(item => producer?.type !== 'agent_task' || item.id !== producer.sessionGroup)?.id ?? group;
      return { ...base, type: kind, targetNodeId: writer, criteria: ['Yêu cầu và bằng chứng'],
        reviewers: [{ id: 'reviewer-1', profileId: 'verifier', profileVersion: 1, sessionGroup: reviewerGroup, required: true, scope: ['.'] }] };
    }
    case 'agent_task': return { ...base, type: kind, goal: 'Mô tả công việc', profileId: 'implementer', profileVersion: 1, sessionGroup: group, bindingId: binding,
      permissions: { read: true, write: false, checks: true, gitCommit: false }, writeScopes: [], outputContract: 'result' };
  }
}

export interface CanvasImportReport {
  added: string[]; removed: string[]; renamed: string[]; retyped: string[]; moved: number; edges: number;
  notesIgnored: number; warnings: string[];
}

/**
 * Apply a board to a flow. `current` is the stored draft (the source of step configuration); without one the
 * flow embedded in the board is used. Throws when the result is not a structurally valid flow.
 */
export function canvasToFlow(input: unknown, current?: Flow, currentRevision?: string): { flow: Flow; report: CanvasImportReport } {
  const canvas = canvasSchema.parse(input);
  const embedded = flowSchema.safeParse(withPlaceholderGraph(canvas['x-neomind']?.flow));
  if (!current && !embedded.success) throw new Error('Canvas không có dữ liệu flow NeoMind (x-neomind) và chưa có draft để áp vào');
  const boardFlowId = (canvas['x-neomind']?.flow as { flowId?: unknown } | undefined)?.flowId;
  if (current && typeof boardFlowId === 'string' && boardFlowId !== current.flowId) throw new Error(`Canvas thuộc flow khác (${boardFlowId})`);
  // Without a draft, steps come only from the cards (the embedded flow carries settings, not the graph).
  const base: Flow = current ? structuredClone(current) : { ...embedded.data!, definition: { ...embedded.data!.definition, nodes: [], edges: [] }, layout: {} };
  const report: CanvasImportReport = { added: [], removed: [], renamed: [], retyped: [], moved: 0, edges: 0, notesIgnored: 0, warnings: [] };
  if (current && canvas['x-neomind']?.draftRevision && currentRevision && canvas['x-neomind'].draftRevision !== currentRevision) {
    report.warnings.push('Draft đã đổi sau khi xuất canvas; cấu hình bước lấy theo draft hiện tại, canvas chỉ đổi bố cục, tên, loại và kết nối');
  }
  const existing = new Map(base.definition.nodes.map(node => [node.id, node]));
  const nodes: FlowNode[] = [], layout: Flow['layout'] = {}, idFor = new Map<string, string>(), used = new Set<string>();
  for (const card of canvas.nodes) {
    if (card.type !== 'text' || boardCards.has(card.id) || card['x-neomind']?.role === 'info') { if (card.type === 'text' && !boardCards.has(card.id) && card['x-neomind']?.role !== 'info') report.notesIgnored++; continue; }
    const lines = (card.text ?? '').split(/\r?\n/).map(line => line.trim());
    const stored = nodeSchema.safeParse(card['x-neomind']?.node);
    const known = existing.get(card.id) ?? (stored.success && stored.data.id === card.id ? stored.data : undefined);
    const kind = kindOf(lines[1]) ?? known?.type;
    if (!kind) { report.notesIgnored++; continue; }
    const label = lines[0] || known?.label || kinds[kind].label;
    let id = card.id;
    if (!known) {
      // New card: canvas editors use random ids; name the step after its label instead.
      id = slug(label) || kind; let n = 2;
      while (existing.has(id) || used.has(id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) id = `${slug(label) || kind}-${n++}`;
    }
    if (used.has(id)) { report.warnings.push(`Thẻ trùng bước ${id}; bỏ thẻ sau`); continue; }
    used.add(id); idFor.set(card.id, id);
    let node: FlowNode;
    if (!known) { node = defaultNode(kind, id, label, base); report.added.push(id); }
    else if (known.type !== kind) { node = defaultNode(kind, id, label, base); report.retyped.push(id); }
    else { node = structuredClone(known); if (node.label !== label) { node.label = label; report.renamed.push(id); } }
    nodes.push(node);
    const position = { x: Math.round(card.x / SCALE), y: Math.round(card.y / SCALE) }, before = base.layout[id];
    if (!before || Math.abs(before.x - position.x) > GRID / SCALE || Math.abs(before.y - position.y) > GRID / SCALE) report.moved++;
    layout[id] = before && Math.abs(before.x - position.x) <= GRID / SCALE && Math.abs(before.y - position.y) <= GRID / SCALE ? before : position;
  }
  report.removed = base.definition.nodes.filter(node => !used.has(node.id)).map(node => node.id);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges: Flow['definition']['edges'] = [], seen = new Set<string>();
  for (const edge of canvas.edges) {
    const from = idFor.get(edge.fromNode), to = idFor.get(edge.toNode);
    if (!from || !to) continue;
    const label = edge.label?.trim();
    if (edge['x-neomind']?.illustrative || label?.startsWith(ILLUSTRATIVE_EDGE)) continue;
    const source = byId.get(from)!;
    const fallback: Outcome = source.type === 'approval' || source.type === 'review_group' ? 'pass' : source.type === 'condition' ? 'true' : 'completed';
    const outcome = (outcomes as string[]).includes(label ?? '') ? label as Outcome : (outcomes as string[]).includes(edge['x-neomind']?.outcome ?? '') && !label ? edge['x-neomind']!.outcome as Outcome : fallback;
    if (label && !(outcomes as string[]).includes(label)) report.warnings.push(`Nhãn "${label}" trên cạnh ${from} → ${to} không phải kết quả hợp lệ; dùng ${outcome}`);
    const key = `${from}|${to}|${outcome}`;
    if (seen.has(key)) continue;
    seen.add(key); edges.push({ from, to, outcome });
  }
  report.edges = edges.length;
  const startNodeId = byId.has(base.definition.startNodeId) ? base.definition.startNodeId : nodes.find(node => node.type === 'start')?.id ?? base.definition.startNodeId;
  const flow = flowSchema.parse({ ...base, definition: { ...base.definition, startNodeId, nodes, edges }, layout });
  return { flow, report };
}
/** The embedded flow has its graph moved to the cards; give the schema a placeholder graph to validate the rest. */
function withPlaceholderGraph(flow: unknown): unknown {
  if (!flow || typeof flow !== 'object' || !('definition' in flow)) return flow;
  const value = flow as { definition: Record<string, unknown> };
  return { ...value, layout: {}, definition: { ...value.definition, nodes: [{ id: 'a', label: 'a', type: 'start' }, { id: 'b', label: 'b', type: 'finish' }], edges: [{ from: 'a', to: 'b', outcome: 'completed' }] } };
}
