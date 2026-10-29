import { api } from './api';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, applyNodeChanges,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import type { Binding, Flow, FlowNode } from '../../src/domain/schema';
import { RunPanel } from './RunPanel';
import { ProfilePanel } from './ProfilePanel';
import { MemoryPanel } from './MemoryPanel';

type FlowMeta = { flowId: string; name: string; archived: boolean };
type Bootstrap = { projectName: string; projectRoot: string; flows: FlowMeta[]; templates: string[]; runtimeAvailable: boolean };
type Diagnostic = { code: string; message: string; nodeId?: string };
type GraphNode = Node<{ label: string; kind: FlowNode['type']; detail: string }, 'studio'>;
type Kind = FlowNode['type'];
type BindingField = 'runner' | 'provider' | 'model' | 'reasoning';

const kindInfo: Record<Kind, { label: string; icon: string; tone: string }> = {
  start: { label: 'Bắt đầu', icon: '↗', tone: 'mint' }, finish: { label: 'Hoàn tất', icon: '✓', tone: 'mint' },
  agent_task: { label: 'Agent task', icon: '✦', tone: 'violet' }, approval: { label: 'Duyệt', icon: '◇', tone: 'amber' },
  fork: { label: 'Phân nhánh', icon: '⑂', tone: 'blue' }, join: { label: 'Hợp nhánh', icon: '⑃', tone: 'blue' },
  condition: { label: 'Điều kiện', icon: '⋄', tone: 'amber' }, integration: { label: 'Tích hợp', icon: '⊞', tone: 'blue' },
  review_group: { label: 'Review', icon: '◎', tone: 'rose' }, repair_scope: { label: 'Vòng sửa', icon: '↻', tone: 'amber' },
  git_commit: { label: 'Commit local', icon: '⌘', tone: 'mint' },
};
const palette: Kind[] = ['agent_task', 'approval', 'fork', 'join', 'condition', 'integration', 'review_group', 'repair_scope', 'git_commit', 'finish'];
const outcomes = ['completed', 'pass', 'needs_changes', 'blocked', 'true', 'false'] as const;

function StudioNode({ data, selected }: NodeProps<GraphNode>) {
  const info = kindInfo[data.kind];
  return <div className={`graph-card tone-${info.tone} ${selected ? 'graph-card-selected' : ''}`}>
    {data.kind !== 'start' && <Handle type="target" position={Position.Left} />}
    <div className="graph-head"><span className="graph-icon">{info.icon}</span><span className="graph-kind">{info.label}</span><span className="graph-dots">···</span></div>
    <strong>{data.label}</strong><div className="graph-detail">{data.detail}</div>
    {data.kind !== 'finish' && <Handle type="source" position={Position.Right} />}
  </div>;
}
const nodeTypes: NodeTypes = { studio: StudioNode };

function detailFor(node: FlowNode): string {
  switch (node.type) {
    case 'agent_task': return `${node.profileId} · ${node.sessionGroup}`;
    case 'approval': return 'Chờ người dùng duyệt';
    case 'review_group': return `${node.reviewers.length} reviewer · ${node.reviewers.filter(r => r.required).length} bắt buộc`;
    case 'repair_scope': return `Tối đa ${node.maxRounds} vòng`;
    case 'fork': return 'Thực hiện song song';
    case 'join': return `${node.requiredBranches.length} nhánh bắt buộc`;
    case 'git_commit': return 'Sau kiểm tra đạt';
    case 'condition': return `${node.field} · ${node.operator}`;
    case 'integration': return 'Ghép thay đổi';
    case 'start': return 'Nhận yêu cầu';
    case 'finish': return 'Bàn giao kết quả';
  }
}
function slug(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
}
function makeNode(kind: Kind, id: string, flow: Flow): FlowNode {
  const base = { id, label: kindInfo[kind].label };
  const group = flow.definition.sessionGroups[0]?.id ?? 'implementation-session';
  const binding = flow.definition.sessionGroups[0]?.bindingId ?? 'implementer';
  const target = flow.definition.nodes.find(n => n.type === 'agent_task' && n.permissions.write)?.id ?? 'implement';
  switch (kind) {
    case 'start': case 'finish': case 'fork': case 'git_commit': return { ...base, type: kind };
    case 'approval': return { ...base, type: kind, purpose: 'Duyệt kế hoạch trước khi thực hiện' };
    case 'join': return { ...base, type: kind, requiredBranches: [target] };
    case 'condition': return { ...base, type: kind, field: 'result', operator: 'eq', value: 'pass' };
    case 'integration': return { ...base, type: kind, writeScopes: ['.'] };
    case 'repair_scope': return { ...base, type: kind, targetReviewId: flow.definition.nodes.find(n => n.type === 'review_group')?.id ?? 'review', ownerNodeIds: [target], maxRounds: 2 };
    case 'review_group': {
      const producer = flow.definition.nodes.find(n => n.id === target);
      const reviewerGroup = flow.definition.sessionGroups.find(g => producer?.type !== 'agent_task' || g.id !== producer.sessionGroup)?.id ?? group;
      return { ...base, type: kind, targetNodeId: target, criteria: ['Yêu cầu và bằng chứng'],
        reviewers: [{ id: 'reviewer-1', profileId: 'verifier', profileVersion: 1, sessionGroup: reviewerGroup, required: true, scope: ['.'] }] };
    }
    case 'agent_task': return { ...base, type: kind, goal: 'Mô tả công việc', profileId: 'implementer', profileVersion: 1,
      sessionGroup: group, bindingId: binding, permissions: { read: true, write: false, checks: true, gitCommit: false }, writeScopes: [], outputContract: 'result' };
  }
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function JsonSetting({ label, value, apply }: { label: string; value: unknown; apply(value: unknown): void }) {
  const serialized = JSON.stringify(value, null, 2), [text, setText] = useState(serialized), [error, setError] = useState('');
  useEffect(() => { setText(serialized); setError(''); }, [serialized]);
  return <div className="field"><label><span>{label}</span><textarea aria-label={label} rows={3} value={text} onChange={e => setText(e.target.value)} /></label><button className="dashed-btn" onClick={() => { try { apply(JSON.parse(text)); setError(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>Áp dụng JSON</button>{error && <small role="alert">{error}</small>}</div>;
}
function fallbackValues(value: unknown): Binding['fallback'] {
  if (!Array.isArray(value)) throw new Error('Danh sách thay thế phải là JSON array');
  return value.map(item => {
    if (!item || typeof item !== 'object' || ['runner', 'provider', 'model', 'reasoning'].some(key => typeof item[key] !== 'string' || !item[key].trim()) || Object.keys(item).some(key => !['runner', 'provider', 'model', 'reasoning'].includes(key))) throw new Error('Mỗi lựa chọn cần runner, provider, model và reasoning');
    return { runner: item.runner as string, provider: item.provider as string, model: item.model as string, reasoning: item.reasoning as string };
  });
}

export default function App() {
  const [view, setView] = useState<'flows' | 'runs' | 'profiles' | 'memory'>('flows');
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphInstance, setGraphInstance] = useState<ReactFlowInstance<GraphNode, Edge> | null>(null);
  const [past, setPast] = useState<Flow[]>([]), [future, setFuture] = useState<Flow[]>([]);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [dialog, setDialog] = useState(false), [newName, setNewName] = useState(''), [newId, setNewId] = useState(''), [template, setTemplate] = useState('dev');
  const refresh = useCallback(async () => { const data = await api<Bootstrap>('/api/bootstrap'); setBoot(data); return data; }, []);
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [refresh]);
  const active = flow?.definition.nodes.find(node => node.id === selected);

  useEffect(() => {
    if (!flow) { setGraphNodes([]); return; }
    setGraphNodes(flow.definition.nodes.map((node, index) => ({ id: node.id, type: 'studio',
      position: flow.layout[node.id] ?? { x: 80 + (index % 4) * 255, y: 110 + Math.floor(index / 4) * 165 },
      data: { label: node.label, kind: node.type, detail: detailFor(node) } })));
  }, [flow]);
  const edges = useMemo<Edge[]>(() => (flow?.definition.edges ?? []).map((edge, index) => ({
    id: `edge-${index}`, source: edge.from, target: edge.to, label: edge.outcome === 'completed' ? '' : edge.outcome,
    type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#8b87a0', strokeWidth: 1.6 },
    labelStyle: { fill: '#7b7289', fontSize: 10, fontWeight: 700 }, labelBgStyle: { fill: '#faf9fd' },
  })), [flow]);
  function edit(next: Flow) { if (flow) setPast(items => [...items, structuredClone(flow)].slice(-40)); setFuture([]); setFlow(next); setDirty(true); setDiagnostics([]); setMessage(''); }
  function mutate(fn: (draft: Flow) => void) { if (!flow) return; const next = structuredClone(flow); fn(next); edit(next); }
  function updateNode(fn: (node: FlowNode) => void) { mutate(next => { const node = next.definition.nodes.find(item => item.id === selected); if (node) fn(node); }); }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function openFlow(id: string) {
    setView('flows');
    if (dirty && !window.confirm('Bản nháp có thay đổi chưa lưu. Mở flow khác?')) return;
    await action(async () => { const data = await api<{ draft: Flow }>(`/api/flows/${encodeURIComponent(id)}/draft`); setFlow(data.draft); setSelected(null); setSelectedEdge(null); setPast([]); setFuture([]); setDirty(false); setDiagnostics([]); setMessage(''); });
  }
  async function createFlow(event: FormEvent) {
    event.preventDefault(); if (!newId || !newName) return;
    if (dirty && !window.confirm('Bản nháp có thay đổi chưa lưu. Tạo flow mới?')) return;
    await action(async () => { const result = await api<{ draft: Flow }>('/api/flows', 'POST', { id: newId, name: newName, template });
      await refresh(); setFlow(result.draft); setDialog(false); setSelected(null); setDirty(false); setPast([]); setFuture([]); setMessage('Đã tạo bản nháp.'); });
  }
  async function manageFlow(operation: 'rename' | 'clone' | 'archive' | 'restore' | 'delete') {
    if (!flow) return;
    const current = flow;
    if (operation !== 'rename' && dirty && !window.confirm('Bản nháp có thay đổi chưa lưu. Tiếp tục?')) return;
    let payload: Record<string, string> = {};
    if (operation === 'rename' || operation === 'clone') {
      const name = window.prompt(operation === 'rename' ? 'Tên mới của flow' : 'Tên flow mới', operation === 'rename' ? current.name : `${current.name} copy`);
      if (!name?.trim()) return;
      payload = operation === 'rename' ? { name: name.trim() } : { name: name.trim(), targetId: slug(name) };
      if (operation === 'clone' && !payload.targetId) return;
    }
    if (operation === 'delete') {
      const name = window.prompt(`Xóa vĩnh viễn flow. Nhập chính xác tên “${current.name}” để xác nhận:`);
      if (name !== current.name) return;
      payload = { confirmedName: name };
    }
    await action(async () => {
      if (operation === 'rename') {
        // Save the draft first, then keep its display name aligned with the library metadata.
        await saveDraft();
        const renamed = { ...current, name: payload.name! };
        await api(`/api/flows/${encodeURIComponent(current.flowId)}/draft`, 'PUT', { draft: renamed });
        await api(`/api/flows/${encodeURIComponent(current.flowId)}/rename`, 'POST', payload);
        setFlow(renamed); setDirty(false);
      } else if (operation === 'clone') {
        const result = await api<{ draft: Flow }>(`/api/flows/${encodeURIComponent(current.flowId)}/clone`, 'POST', payload);
        setFlow(result.draft); setDirty(false); setSelected(null); setPast([]); setFuture([]);
      } else {
        await api(`/api/flows/${encodeURIComponent(current.flowId)}/${operation}`, 'POST', payload);
        if (operation === 'archive' || operation === 'delete') { setFlow(null); setSelected(null); setDirty(false); }
      }
      await refresh(); setMessage('Đã cập nhật thư viện flow.');
    });
  }
  async function saveDraft() { if (!flow) return; await api(`/api/flows/${encodeURIComponent(flow.flowId)}/draft`, 'PUT', { draft: flow }); setDirty(false); }
  async function validate(current: Flow) { const result = await api<{ valid: boolean; diagnostics?: Diagnostic[] }>(`/api/flows/${encodeURIComponent(current.flowId)}/validate`, 'POST', { draft: current }); setDiagnostics(result.diagnostics ?? []); return result.valid; }
  function addNode(kind: Kind, position?: { x: number; y: number }) { if (!flow) return; let index = 1; while (flow.definition.nodes.some(node => node.id === `${kind}-${index}`)) index++;
    const node = makeNode(kind, `${kind}-${index}`, flow); mutate(next => { next.definition.nodes.push(node); next.layout[node.id] = position ?? { x: 120 + (next.definition.nodes.length % 4) * 180, y: 350 }; }); setSelected(node.id); setSelectedEdge(null); }
  function removeNode() { if (!flow || !active) return; const count = flow.definition.edges.filter(e => e.from === active.id || e.to === active.id).length;
    if (!window.confirm(`Xóa bước “${active.label}” và ${count} kết nối?`)) return;
    mutate(next => { next.definition.nodes = next.definition.nodes.filter(n => n.id !== active.id); next.definition.edges = next.definition.edges.filter(e => e.from !== active.id && e.to !== active.id); delete next.layout[active.id]; }); setSelected(null); }
  function undo() { if (!flow || !past.length) return; const previous = past[past.length - 1]!; setPast(past.slice(0, -1)); setFuture([structuredClone(flow), ...future]); setFlow(previous); setDirty(true); setDiagnostics([]); }
  function redo() { if (!flow || !future.length) return; setPast([...past, structuredClone(flow)]); setFlow(future[0]!); setFuture(future.slice(1)); setDirty(true); setDiagnostics([]); }
  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => { setGraphNodes(nodes => applyNodeChanges(changes, nodes)); }, []);
  function connect(connection: Connection) { if (!flow || !connection.source || !connection.target) return;
    const source = flow.definition.nodes.find(n => n.id === connection.source);
    const outcome = source?.type === 'approval' || source?.type === 'review_group' ? 'pass' : source?.type === 'condition' ? 'true' : 'completed';
    mutate(next => { next.definition.edges.push({ from: connection.source!, to: connection.target!, outcome }); }); }
  function updateBinding(field: BindingField, change: Binding[BindingField]) {
    if (!active || active.type !== 'agent_task') return;
    mutate(next => { const binding = next.definition.bindings[active.bindingId]; if (binding) binding[field] = change; });
  }
  const binding = active?.type === 'agent_task' ? flow?.definition.bindings[active.bindingId] : undefined;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">✳</span><span>neo<span className="brand-bold">mind</span></span><span className="brand-divider" /><span className="product-label">FLOW STUDIO</span></div>
      <div className="topbar-right"><span className="project-badge"><span className="project-dot" />{boot?.projectName ?? 'Đang tải'}</span><span className="avatar">N</span></div></header>
    <aside className="sidebar"><div className="sidebar-title"><span>WORKSPACE</span><button className="icon-btn" title="Tạo flow" onClick={() => setDialog(true)}>＋</button></div>
      <button className={`nav-item ${view === 'flows' ? 'active-nav' : ''}`} onClick={() => setView('flows')}><span>▧</span> Flow library <span className="nav-count">{boot?.flows.filter(item => !item.archived).length ?? 0}</span></button>
      <button className={`nav-item ${view === 'runs' ? 'active-nav' : ''}`} onClick={() => setView('runs')}><span>◌</span> Runs & history</button>
      <button className={`nav-item ${view === 'profiles' ? 'active-nav' : ''}`} onClick={() => setView('profiles')}><span>✦</span> Agent profiles</button>
      <button className={`nav-item ${view === 'memory' ? 'active-nav' : ''}`} onClick={() => setView('memory')}><span>◇</span> Project memory</button>
      <div className="sidebar-divider" /><div className="sidebar-subtitle">FLOWS <button className="icon-btn" title="Tạo flow" onClick={() => setDialog(true)}>＋</button></div>
      <div className="flow-list">{boot?.flows.filter(item => !item.archived).map(item => <button key={item.flowId} className={`flow-item ${flow?.flowId === item.flowId ? 'selected-flow' : ''}`} onClick={() => void openFlow(item.flowId)}><span className="flow-bullet">◈</span><span>{item.name}</span><span className="flow-item-more">›</span></button>)}
        {boot && boot.flows.filter(item => !item.archived).length === 0 && <p className="sidebar-empty">Chưa có flow nào.</p>}</div>
      {boot?.flows.some(item => item.archived) && <><div className="sidebar-subtitle">ĐÃ LƯU TRỮ</div><div className="flow-list">{boot.flows.filter(item => item.archived).map(item => <button key={item.flowId} className={`flow-item ${flow?.flowId === item.flowId ? 'selected-flow' : ''}`} onClick={() => void openFlow(item.flowId)}><span className="flow-bullet">◈</span><span>{item.name}</span></button>)}</div></>}
      <div className="sidebar-bottom"><div className="status-orb" /><div><strong>Flow Studio</strong><small>Thiết kế local</small></div><span>↗</span></div>
    </aside>
    <main className="main"><div className="breadcrumb"><span>Workspace</span><span>›</span><span>Flows</span>{flow && <><span>›</span><strong>{flow.name}</strong></>}</div>
      {error && <div className="alert error" role="alert"><span>ⓘ</span> {error}<button onClick={() => setError('')}>×</button></div>}
      {message && <div className="alert success"><span>✓</span> {message}<button onClick={() => setMessage('')}>×</button></div>}
      {view === 'memory' ? <MemoryPanel /> : view === 'profiles' ? <ProfilePanel /> : view === 'runs' ? <RunPanel {...(flow ? { flowId: flow.flowId } : {})} flows={boot?.flows ?? []} /> : !flow ? <div className="empty-stage"><div className="empty-art">✳<span>◇</span><i>✦</i></div><h1>Tạo flow đầu tiên</h1><p>Thiết kế cách các agent phối hợp, review và bàn giao công việc của bạn.</p><button className="primary-btn" onClick={() => setDialog(true)}>＋ &nbsp; Tạo flow mới</button><small>Chọn từ các mẫu Fast, Dev hoặc Research để bắt đầu.</small></div> : <>
        <div className="page-heading"><div><div className="title-line"><h1>{flow.name}</h1><span className="draft-badge"><span /> BẢN NHÁP</span>{dirty && <span className="unsaved">● Chưa lưu</span>}</div><p>Thiết kế quy trình và cấu hình cách các agent phối hợp.</p></div>
          <div className="heading-actions"><button className="quiet-btn" title="Đổi tên flow" onClick={() => void manageFlow('rename')}>Đổi tên</button><button className="quiet-btn" title="Sao chép flow" onClick={() => void manageFlow('clone')}>Sao chép</button><button className="quiet-btn" onClick={() => void manageFlow(boot?.flows.find(item => item.flowId === flow.flowId)?.archived ? 'restore' : 'archive')}>{boot?.flows.find(item => item.flowId === flow.flowId)?.archived ? 'Khôi phục' : 'Lưu trữ'}</button><button className="quiet-btn" title="Xóa vĩnh viễn" onClick={() => void manageFlow('delete')}>Xóa</button><button className="quiet-btn" title="Hoàn tác" disabled={!past.length} onClick={undo}>↶</button><button className="quiet-btn" title="Làm lại" disabled={!future.length} onClick={redo}>↷</button><span className="action-separator" />
            <button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { await saveDraft(); setMessage('Đã lưu bản nháp.'); })}>Lưu nháp</button>
            <button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { const valid = await validate(flow); setMessage(valid ? 'Flow hợp lệ.' : 'Flow còn điểm cần chỉnh.'); })}>Kiểm tra</button>
            <button className="primary-btn" disabled={busy} onClick={() => void action(async () => { await saveDraft(); if (!await validate(flow)) return; const saved = await api<{ version: { version: number } }>(`/api/flows/${encodeURIComponent(flow.flowId)}/publish`, 'POST'); setMessage(`Đã lưu phiên bản ${saved.version.version}.`); })}>Lưu phiên bản <span>↗</span></button></div></div>
        <div className="workspace"><div className="workspace-top"><div className="tab-active">Flow canvas</div><div className="tab-muted">Cấu hình <span>·</span> {flow.definition.nodes.length} bước</div><div className="workspace-top-right"><span className="legend-dot" /> Đang chỉnh sửa <button className="ghost-btn" disabled={!boot?.runtimeAvailable} onClick={() => setView('runs')} title="Chạy phiên bản đã lưu">▶ &nbsp; Run</button></div></div>
          <div className="workspace-body"><div className="palette"><div className="panel-heading">THÊM BƯỚC</div><p>Kéo ý tưởng thành quy trình.</p><div className="palette-items">{palette.map(kind => <button key={kind} draggable onDragStart={event => { event.dataTransfer.setData('application/neomind-node', kind); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addNode(kind)}><span className={`palette-icon tone-${kindInfo[kind].tone}`}>{kindInfo[kind].icon}</span><span>{kindInfo[kind].label}</span><span className="add-mark">＋</span></button>)}</div>
              <div className="palette-note"><span>✧</span><div><strong>Mẹo nhỏ</strong><p>Chọn bước để chỉnh agent, model và các thiết lập.</p></div></div></div>
            <div className="canvas" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={event => { event.preventDefault(); const kind = event.dataTransfer.getData('application/neomind-node') as Kind; if (palette.includes(kind) && graphInstance) addNode(kind, graphInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}><ReactFlow<GraphNode, Edge> nodes={graphNodes} edges={edges} nodeTypes={nodeTypes} onInit={setGraphInstance} onNodesChange={onNodesChange} onConnect={connect} onNodeClick={(_, node) => { setSelected(node.id); setSelectedEdge(null); }}
              onEdgeClick={(_, edge) => { setSelectedEdge(Number(edge.id.replace('edge-', ''))); setSelected(null); }} onPaneClick={() => { setSelected(null); setSelectedEdge(null); }}
              onNodeDragStop={(_, node) => mutate(next => { next.layout[node.id] = node.position; })} deleteKeyCode={null} fitView minZoom={0.25} maxZoom={1.8}>
              <Background color="#dcd9e5" gap={23} size={1.1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor="#b7a7e8" maskColor="#f3f1f880" /></ReactFlow>
              <div className="canvas-caption"><span>✧</span> Kéo để sắp xếp · Nối các cổng để tạo luồng</div></div>
            <aside className="inspector"><div className="inspector-head"><div><span className="panel-heading">THUỘC TÍNH</span><h3>{active ? 'Chi tiết bước' : selectedEdge !== null ? 'Kết nối' : 'Tổng quan flow'}</h3></div>{active && <span className={`inspector-icon tone-${kindInfo[active.type].tone}`}>{kindInfo[active.type].icon}</span>}</div>
              {active ? <div className="inspector-scroll"><Field label="Tên bước"><input value={active.label} onChange={e => updateNode(node => { node.label = e.target.value; })} /></Field><div className="type-pill">{kindInfo[active.type].icon} &nbsp; {kindInfo[active.type].label}</div>
                {active.type === 'agent_task' && <>
                  <Field label="Mục tiêu"><textarea rows={3} value={active.goal} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.goal = e.target.value; })} /></Field>
                  <div className="section-rule" /><div className="inspector-section">AGENT CONFIGURATION</div>
                  <Field label="Agent profile"><input value={active.profileId} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.profileId = e.target.value; })} /></Field>
                  <div className="field-grid"><Field label="Phiên bản"><input type="number" min="1" value={active.profileVersion} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.profileVersion = Number(e.target.value); })} /></Field>
                    <Field label="Session group"><input value={active.sessionGroup} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.sessionGroup = e.target.value; })} /></Field></div>
                  <Field label="Binding" hint="Các bước cùng binding chia sẻ cấu hình runner/model."><select value={active.bindingId} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.bindingId = e.target.value; })}>{Object.keys(flow.definition.bindings).map(key => <option key={key}>{key}</option>)}</select></Field>
                  {binding && <>{(['runner', 'provider', 'model', 'reasoning'] as const).map(key => <Field key={key} label={{ runner: 'Runner', provider: 'Provider', model: 'Model', reasoning: 'Mức suy luận' }[key]}>
                    <div className="binding-input"><select value={binding[key].mode} onChange={e => updateBinding(key, e.target.value === 'inherit' ? { mode: 'inherit' } : { mode: 'pinned', value: '' })}><option value="inherit">Kế thừa</option><option value="pinned">Ghim</option></select>
                      {binding[key].mode === 'pinned' && <input aria-label={`${key} value`} value={binding[key].value} onChange={e => updateBinding(key, { mode: 'pinned', value: e.target.value })} placeholder="Giá trị" />}</div></Field>)}<JsonSetting label="Model thay thế được phép (JSON)" value={binding.fallback} apply={value => { const fallback = fallbackValues(value); mutate(next => { const target = next.definition.bindings[active.bindingId]; if (target) target.fallback = fallback; }); }} /></>}
                  <Field label="Hướng dẫn bổ sung"><textarea rows={2} value={active.instructionsOverride ?? ''} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.instructionsOverride = e.target.value; })} placeholder="Tùy chọn" /></Field>
                  <label className="check-row"><input type="checkbox" checked={active.permissions.write} onChange={e => updateNode(node => { if (node.type === 'agent_task') { node.permissions.write = e.target.checked; node.writeScopes = e.target.checked ? ['.'] : []; } })} /> Cho phép sửa trong phạm vi</label>
                  {active.permissions.write && <Field label="Phạm vi ghi" hint="Phân tách bằng dấu phẩy"><input value={active.writeScopes.join(', ')} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.writeScopes = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>}
                  <label className="check-row"><input type="checkbox" checked={active.permissions.checks} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.permissions.checks = e.target.checked; })} /> Có thể chạy checks</label>
                  <Field label="Output contract"><input value={active.outputContract} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.outputContract = e.target.value; })} /></Field>
                </>}
                {active.type === 'approval' && <Field label="Nội dung cần duyệt"><textarea rows={3} value={active.purpose} onChange={e => updateNode(node => { if (node.type === 'approval') node.purpose = e.target.value; })} /></Field>}
                {active.type === 'review_group' && <><div className="section-rule" /><div className="inspector-section">REVIEW CONFIGURATION</div>
                  <Field label="Kiểm tra output của"><select value={active.targetNodeId} onChange={e => updateNode(node => { if (node.type === 'review_group') node.targetNodeId = e.target.value; })}>{flow.definition.nodes.filter(n => n.type === 'agent_task' || n.type === 'integration').map(n => <option key={n.id} value={n.id}>{n.label} · {n.id}</option>)}</select></Field>
                  {active.reviewers.map((reviewer, index) => <div className="reviewer-box" key={index}><div className="reviewer-heading"><strong>Reviewer {index + 1}</strong><button className="text-button" onClick={() => updateNode(node => { if (node.type === 'review_group') node.reviewers.splice(index, 1); })}>Xóa</button></div>
                    <Field label="ID"><input value={reviewer.id} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].id = e.target.value; })} /></Field>
                    <Field label="Profile"><input value={reviewer.profileId} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].profileId = e.target.value; })} /></Field>
                    <Field label="Session group"><select value={reviewer.sessionGroup} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].sessionGroup = e.target.value; })}>{flow.definition.sessionGroups.map(g => <option key={g.id} value={g.id}>{g.id}</option>)}</select></Field>
                    <Field label="Phiên bản profile"><input type="number" min="1" value={reviewer.profileVersion} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].profileVersion = Number(e.target.value); })} /></Field>
                    {(() => {
                      const group = flow.definition.sessionGroups.find(item => item.id === reviewer.sessionGroup);
                      const reviewerBinding = group && flow.definition.bindings[group.bindingId];
                      if (!group || !reviewerBinding) return <p>Session group chưa có binding hợp lệ.</p>;
                      return <><Field label="Binding reviewer" hint="Các session cùng binding dùng chung cấu hình model."><select value={group.bindingId} onChange={e => mutate(next => { const target = next.definition.sessionGroups.find(item => item.id === reviewer.sessionGroup); if (target) target.bindingId = e.target.value; })}>{Object.keys(flow.definition.bindings).map(key => <option key={key} value={key}>{key}</option>)}</select></Field>
                        {(['runner', 'provider', 'model', 'reasoning'] as const).map(key => <Field key={key} label={{ runner: 'Runner reviewer', provider: 'Provider reviewer', model: 'Model reviewer', reasoning: 'Mức suy luận reviewer' }[key]}><div className="binding-input"><select value={reviewerBinding[key].mode} onChange={e => mutate(next => { const target = next.definition.bindings[group.bindingId]; if (target) target[key] = e.target.value === 'inherit' ? { mode: 'inherit' } : { mode: 'pinned', value: '' }; })}><option value="inherit">Kế thừa</option><option value="pinned">Ghim</option></select>{reviewerBinding[key].mode === 'pinned' && <input aria-label={`${key} reviewer value`} value={reviewerBinding[key].value} onChange={e => mutate(next => { const target = next.definition.bindings[group.bindingId]; if (target) target[key] = { mode: 'pinned', value: e.target.value }; })} placeholder="Giá trị" />}</div></Field>)}
                        <JsonSetting label={`Model thay thế reviewer ${index + 1} (JSON)`} value={reviewerBinding.fallback} apply={value => { const fallback = fallbackValues(value); mutate(next => { const target = next.definition.bindings[group.bindingId]; if (target) target.fallback = fallback; }); }} /><button className="dashed-btn" onClick={() => mutate(next => { const target = next.definition.nodes.find(item => item.id === active.id); if (target?.type !== 'review_group' || !target.reviewers[index]) return; let n = 1; while (next.definition.sessionGroups.some(item => item.id === `${active.id}-reviewer-${n}`) || Object.hasOwn(next.definition.bindings, `${active.id}-binding-${n}`)) n++; const groupId = `${active.id}-reviewer-${n}`, bindingId = `${active.id}-binding-${n}`; next.definition.bindings[bindingId] = structuredClone(reviewerBinding); next.definition.sessionGroups.push({ id: groupId, bindingId }); target.reviewers[index].sessionGroup = groupId; })}>Tách cấu hình reviewer</button></>;
                    })()}
                    <Field label="Hướng dẫn reviewer"><textarea rows={2} value={reviewer.instructionsOverride ?? ''} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].instructionsOverride = e.target.value; })} /></Field>
                    <Field label="Phạm vi review"><input value={reviewer.scope.join(', ')} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].scope = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>
                    <label className="check-row"><input type="checkbox" checked={reviewer.required} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].required = e.target.checked; })} /> Bắt buộc đạt</label></div>)}
                  <button className="dashed-btn" onClick={() => mutate(next => { const node = next.definition.nodes.find(n => n.id === active.id); if (node?.type !== 'review_group') return; let n = 1; while (next.definition.sessionGroups.some(item => item.id === `${active.id}-session-${n}`) || node.reviewers.some(item => item.id === `reviewer-${n}`)) n++; const groupId = `${active.id}-session-${n}`; const bindingId = Object.hasOwn(next.definition.bindings, 'verifier') ? 'verifier' : Object.keys(next.definition.bindings)[0] ?? 'verifier'; next.definition.sessionGroups.push({ id: groupId, bindingId }); node.reviewers.push({ id: `reviewer-${n}`, profileId: 'verifier', profileVersion: 1, sessionGroup: groupId, required: true, scope: ['.'] }); })}>＋ Thêm reviewer</button>
                  <Field label="Tiêu chí" hint="Phân tách bằng dấu phẩy"><input value={active.criteria.join(', ')} onChange={e => updateNode(node => { if (node.type === 'review_group') node.criteria = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field></>}
                {active.type === 'repair_scope' && <><Field label="Review cần kiểm tra lại"><select value={active.targetReviewId} onChange={e => updateNode(node => { if (node.type === 'repair_scope') node.targetReviewId = e.target.value; })}>{flow.definition.nodes.filter(n => n.type === 'review_group').map(n => <option key={n.id} value={n.id}>{n.label} · {n.id}</option>)}</select></Field>
                  <Field label="Agent sửa (node ID)"><input value={active.ownerNodeIds.join(', ')} onChange={e => updateNode(node => { if (node.type === 'repair_scope') node.ownerNodeIds = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>
                  <Field label="Số vòng tối đa"><input type="number" min="1" value={active.maxRounds} onChange={e => updateNode(node => { if (node.type === 'repair_scope') node.maxRounds = Number(e.target.value); })} /></Field></>}
                {active.type === 'join' && <Field label="Nhánh bắt buộc (node IDs)"><input value={active.requiredBranches.join(', ')} onChange={e => updateNode(node => { if (node.type === 'join') node.requiredBranches = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>}
                {active.type === 'integration' && <Field label="Phạm vi tích hợp"><input value={active.writeScopes.join(', ')} onChange={e => updateNode(node => { if (node.type === 'integration') node.writeScopes = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>}
                {active.type === 'condition' && <><Field label="Trường dữ liệu"><input value={active.field} onChange={e => updateNode(node => { if (node.type === 'condition') node.field = e.target.value; })} /></Field><Field label="Toán tử"><select value={active.operator} onChange={e => updateNode(node => { if (node.type === 'condition') node.operator = e.target.value as typeof node.operator; })}>{['eq', 'ne', 'in', 'exists', 'all', 'any'].map(v => <option key={v}>{v}</option>)}</select></Field><JsonSetting label="Giá trị điều kiện (JSON)" value={active.value ?? null} apply={value => updateNode(node => { if (node.type === 'condition') node.value = value as Exclude<typeof node.value, undefined>; })} /><p className="run-note">Trường: result, checks.passed, checks.results, review.accepted, repair.rounds hoặc node.ID.status/outcome.</p></>}
                <div className="section-rule" /><button className="danger-link" onClick={removeNode}>⌫ &nbsp; Xóa bước này</button></div> : selectedEdge !== null && flow.definition.edges[selectedEdge] ? <div className="inspector-scroll"><div className="connection-summary">{flow.definition.edges[selectedEdge]!.from} <span>→</span> {flow.definition.edges[selectedEdge]!.to}</div><Field label="Điều kiện chuyển bước"><select value={flow.definition.edges[selectedEdge]!.outcome} onChange={e => mutate(next => { const edge = next.definition.edges[selectedEdge]; if (edge) edge.outcome = e.target.value as typeof edge.outcome; })}>{outcomes.map(value => <option key={value}>{value}</option>)}</select></Field><button className="danger-link" onClick={() => { mutate(next => { next.definition.edges.splice(selectedEdge, 1); }); setSelectedEdge(null); }}>⌫ &nbsp; Xóa kết nối</button></div> : <div className="inspector-scroll"><div className="overview-icon">◈</div><p className="inspector-intro">Chọn một bước hoặc kết nối trên canvas để xem và chỉnh cấu hình.</p><div className="section-rule" /><div className="inspector-section">FLOW SETTINGS</div>
                <Field label="Mô tả"><textarea rows={3} value={flow.description} onChange={e => mutate(next => { next.description = e.target.value; })} /></Field>
                <Field label="Số agent đồng thời"><input type="number" min="1" value={flow.definition.limits.maxConcurrency} onChange={e => mutate(next => { next.definition.limits.maxConcurrency = Number(e.target.value); })} /></Field>
                <Field label="Giới hạn sửa toàn run"><input type="number" min="0" value={flow.definition.limits.maxRepairRounds} onChange={e => mutate(next => { next.definition.limits.maxRepairRounds = Number(e.target.value); })} /></Field>
                <Field label="Thời gian xử lý (giây)"><input type="number" min="1" value={flow.definition.limits.activeTimeSeconds} onChange={e => mutate(next => { next.definition.limits.activeTimeSeconds = Number(e.target.value); })} /></Field>
                <Field label="Workspace"><select value={flow.definition.workspacePolicy} onChange={e => mutate(next => { next.definition.workspacePolicy = e.target.value as 'isolated' | 'shared'; })}><option value="isolated">Worktree riêng</option><option value="shared">Workspace chung</option></select></Field></div>}
            </aside></div>
          <div className={`validation-bar ${diagnostics.length ? 'has-errors' : ''}`}><div><span className="validation-icon">{diagnostics.length ? '!' : '✓'}</span><strong>{diagnostics.length ? `${diagnostics.length} điểm cần chỉnh` : 'Sẵn sàng thiết kế'}</strong><span>{diagnostics.length ? diagnostics[0]?.message : 'Kiểm tra flow trước khi lưu phiên bản.'}</span></div><button onClick={() => void action(async () => { const valid = await validate(flow); setMessage(valid ? 'Flow hợp lệ.' : 'Flow còn điểm cần chỉnh.'); })}>Kiểm tra flow ↗</button></div>
        </div><div className="footnote"><span>✳</span> NeoMind Flow Studio <span className="footnote-dot">·</span> Thay đổi bản nháp không ảnh hưởng phiên bản đã lưu.</div>
      </>}
    </main>
    {dialog && <div className="modal-backdrop" onMouseDown={() => setDialog(false)}><form className="modal" onSubmit={e => void createFlow(e)} onMouseDown={e => e.stopPropagation()}><div className="modal-head"><div className="modal-icon">✳</div><button type="button" className="icon-btn" onClick={() => setDialog(false)}>×</button></div><h2>Tạo flow mới</h2><p>Bắt đầu từ một mẫu và điều chỉnh theo cách bạn làm việc.</p>
      <Field label="Tên flow"><input autoFocus required value={newName} onChange={e => { setNewName(e.target.value); setNewId(slug(e.target.value)); }} placeholder="Ví dụ: Product development" /></Field><Field label="Flow ID" hint="Dùng chữ thường, số và dấu gạch ngang."><input required value={newId} onChange={e => setNewId(e.target.value)} placeholder="product-development" /></Field>
      <Field label="Bắt đầu từ mẫu"><select value={template} onChange={e => setTemplate(e.target.value)}><option value="dev">Dev · phát triển tính năng / sửa lỗi</option><option value="fast">Fast · tác vụ nhỏ gọn</option><option value="research">Research · nghiên cứu và kiểm tra nguồn</option></select></Field>
      <div className="modal-actions"><button type="button" className="secondary-btn" onClick={() => setDialog(false)}>Hủy</button><button className="primary-btn" disabled={busy || !newId || !newName}>Tạo bản nháp →</button></div></form></div>}
  </div>;
}
