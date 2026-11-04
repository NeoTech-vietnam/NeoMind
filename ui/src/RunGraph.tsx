import { api } from './api';
type NodeData = { prompt: string; truncated: boolean; output?: { messages: string[]; truncated: boolean } };
import { useMemo, useState, useEffect } from 'react';
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { Run } from './runTypes';
import { statusInfo } from './format';

/** Read-only run snapshot: never consults or mutates the current flow draft. */
export function RunGraph({ run, openSession, hasSession }: { run: Run; openSession(nodeId: string): void; hasSession(nodeId: string): boolean }) {
  const [showData, setShowData] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const flow = run.snapshot?.configuration.flow;
  const nodes = useMemo<Node[]>(() => (flow?.definition.nodes ?? []).map((node, index) => {
    const state = run.graph.nodes[node.id], status = statusInfo(state?.status);
    const interrupted = state?.status === 'running' && !['running', 'stopping'].includes(run.runtimeState?.phase ?? '');
    return { id: node.id, position: flow?.layout[node.id] ?? { x: (index % 4) * 240, y: Math.floor(index / 4) * 140 },
      data: { label: `${node.label}\n${interrupted ? 'Dừng giữa chừng' : status.label}` },
      className: `run-graph-node tone-${interrupted ? 'amber' : status.tone}` };
  }), [flow, run.graph, run.runtimeState?.phase]);
  const edges = useMemo<Edge[]>(() => (flow?.definition.edges ?? []).map((edge, index) => ({
    id: `${index}`, source: edge.from, target: edge.to, label: edge.outcome === 'completed' ? undefined : edge.outcome,
    markerEnd: { type: MarkerType.ArrowClosed }, type: 'smoothstep',
  })), [flow]);
  const dataEdges = useMemo<Edge[]>(() => { const seen = new Set<string>(); return (run.nodeData ?? []).flatMap(item => item.sources.flatMap(source => { if (!source.fromNodeId || source.fromNodeId === item.nodeId) return []; const key = `${source.fromNodeId}/${item.nodeId}/${source.kind}`; if (seen.has(key)) return []; seen.add(key); return [{ id: `data:${key}`, source: source.fromNodeId, target: item.nodeId, label: source.kind, type: 'smoothstep', style: { stroke: '#82c9c0', strokeDasharray: '5 4' }, markerEnd: { type: MarkerType.ArrowClosed } }]; })); }, [run.nodeData]);
  if (!flow) return null;
  const node = flow.definition.nodes.find(item => item.id === selected), artifacts = run.artifacts.filter(item => item.nodeId === selected);
  const rawStatus = node ? run.graph.nodes[node.id]?.status : undefined;
  const displayStatus = rawStatus === 'running' && !['running', 'stopping'].includes(run.runtimeState?.phase ?? '') ? 'Dừng giữa chừng' : statusInfo(rawStatus).label;
  const reviews = run.reviewerOutputs.filter(item => item.nodeId === selected), plan = run.plans.filter(item => item.nodeId === selected).at(-1)?.plan;
  const incoming = flow.definition.edges.filter(edge => edge.to === selected), outgoing = flow.definition.edges.filter(edge => edge.from === selected);
  const label = (id: string) => flow.definition.nodes.find(item => item.id === id)?.label ?? id;
  return <section className="run-card run-graph-card"><div className="card-title"><h3>Flow của run</h3><p>Snapshot {flow.name} v{flow.version} · cạnh liền: điều khiển · cạnh đứt: nguồn dữ liệu đã dùng</p><label><input type="checkbox" checked={showData} onChange={e => setShowData(e.target.checked)} /> Hiện quan hệ dữ liệu</label></div>
    <div className="run-graph-layout"><div className="run-graph-canvas" aria-label="Sơ đồ snapshot của run">
      <ReactFlow nodes={nodes} edges={showData ? [...edges, ...dataEdges] : edges} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, item) => setSelected(item.id)} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.2} maxZoom={1.8}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow></div>
      <aside className="run-graph-detail" aria-live="polite">{node ? <><h4>{node.label}</h4><p>{displayStatus} · {node.type}</p>
        <button type="button" className="secondary-btn small" disabled={!hasSession(node.id)} onClick={() => openSession(node.id)}>Xem session gần nhất</button>
        <details><summary>Đầu vào và cấu hình đã ghim</summary>
          <strong>Yêu cầu gốc</strong><pre>{run.runtimeContext?.task ?? 'Không được ghi'}</pre>
          <strong>Định nghĩa bước</strong><pre>{JSON.stringify(node, null, 2)}</pre>
          {node.type === 'review_group' && <p>Review kết quả của: {label(node.targetNodeId)} ({node.targetNodeId})</p>}
          <strong>Bước trước trong graph</strong>{incoming.length ? incoming.map((edge, index) => <p key={index}>{label(edge.from)} → {edge.outcome}</p>) : <p>Không có</p>}
          <small>Đường nối thể hiện luồng điều khiển; không mặc định là dữ liệu đã được truyền.</small>
        </details>
        <details><summary>Đầu ra và bước tiếp theo</summary>
          <strong>Trạng thái đã ghi</strong><p>{displayStatus}</p>
          <strong>Bước tiếp theo trong graph</strong>{outgoing.length ? outgoing.map((edge, index) => <p key={index}>{edge.outcome} → {label(edge.to)}</p>) : <p>Không có</p>}
          {node.type === 'agent_task' && <p>Output contract: {node.outputContract}</p>}
          {run.delivery?.filter(item => item.nodeId === node.id).map(item => <div key={item.commit}><strong>Commit {item.commit}</strong><pre>{item.files.join('\n')}</pre></div>)}
        </details>
        {(run.nodeData ?? []).filter(item => item.nodeId === node.id).map(item => <NodeDataViewer key={item.attemptId} runId={run.runId} item={item} select={setSelected} />)}
        {plan && <details><summary>Kế hoạch đã ghi</summary><pre>{JSON.stringify(plan, null, 2)}</pre></details>}
        {reviews.map(review => <details key={review.attemptId}><summary>{review.result.reviewerId} · {review.result.verdict}</summary><p>{review.summary}</p><pre>{JSON.stringify({ result: review.result, evidence: review.evidence ?? null }, null, 2)}</pre></details>)}
        {artifacts.map((artifact, index) => <details key={index}><summary>{artifact.kind}</summary><pre>{artifact.text}</pre></details>)}
        {!plan && !reviews.length && !artifacts.length && <p>Chưa có kết quả được ghi cho bước này.</p>}
      </> : <p>Chọn một bước trên sơ đồ để xem trạng thái và kết quả đã ghi.</p>}</aside>
    </div></section>;
}


function NodeDataViewer({ runId, item, select }: { runId: string; item: NonNullable<Run['nodeData']>[number]; select(id: string): void }) {
  const [data, setData] = useState<NodeData | null>(null), [error, setError] = useState(''), [open, setOpen] = useState(false);
  useEffect(() => { if (!open) return; let current = true; setError(''); void api<NodeData>(`/api/runs/${runId}/node-data/${item.attemptId}`).then(value => { if (current) setData(value); }).catch(e => { if (current) setError(String(e)); }); return () => { current = false; }; }, [open, runId, item.attemptId, item.output?.outputHash]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Input / Output · {item.attemptId.slice(0, 8)}</summary>
    <p>Workspace: <code>{item.workspace}</code></p>
    <strong>Nguồn đầu vào đã ghi</strong>
    {item.sources.map((source, index) => <p key={index}>{source.kind} · {source.fromNodeId ? <button type="button" className="text-link" onClick={() => select(source.fromNodeId!)}>{source.fromNodeId}</button> : source.id}<br /><code>{source.hash}</code></p>)}
    {error && <p role="alert">{error}</p>}
    {data ? <><strong>Prompt gửi agent</strong>{data.truncated && <p>Đã rút gọn; hash thuộc nội dung đầy đủ.</p>}<pre>{data.prompt}</pre><strong>Output agent</strong>{data.output ? <>{data.output.truncated && <p>Output đã rút gọn.</p>}<pre>{data.output.messages.join('\n\n')}</pre></> : <p>Chưa ghi nhận output hoàn tất. Xem session để biết lỗi hoặc tiến trình.</p>}</> : !error && <p>Đang đọc dữ liệu…</p>}
  </details>;
}
