import { useMemo, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { Run } from './runTypes';
import { statusInfo } from './format';

/** Read-only run snapshot: never consults or mutates the current flow draft. */
export function RunGraph({ run, openSession, hasSession }: { run: Run; openSession(nodeId: string): void; hasSession(nodeId: string): boolean }) {
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
  if (!flow) return null;
  const node = flow.definition.nodes.find(item => item.id === selected), artifacts = run.artifacts.filter(item => item.nodeId === selected);
  const rawStatus = node ? run.graph.nodes[node.id]?.status : undefined;
  const displayStatus = rawStatus === 'running' && !['running', 'stopping'].includes(run.runtimeState?.phase ?? '') ? 'Dừng giữa chừng' : statusInfo(rawStatus).label;
  const reviews = run.reviewerOutputs.filter(item => item.nodeId === selected), plan = run.plans.filter(item => item.nodeId === selected).at(-1)?.plan;
  return <section className="run-card run-graph-card"><div className="card-title"><h3>Flow của run</h3><p>Snapshot {flow.name} v{flow.version} · chọn bước để xem kết quả</p></div>
    <div className="run-graph-layout"><div className="run-graph-canvas" aria-label="Sơ đồ snapshot của run">
      <ReactFlow nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, item) => setSelected(item.id)} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.2} maxZoom={1.8}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow></div>
      <aside className="run-graph-detail" aria-live="polite">{node ? <><h4>{node.label}</h4><p>{displayStatus} · {node.type}</p>
        <button type="button" className="secondary-btn small" disabled={!hasSession(node.id)} onClick={() => openSession(node.id)}>Xem session gần nhất</button>
        {plan && <><strong>Kế hoạch</strong><p>{plan.goal}</p><p>{plan.approach}</p></>}
        {reviews.map(review => <div key={review.attemptId}><strong>{review.result.reviewerId} · {review.result.verdict}</strong><p>{review.summary}</p></div>)}
        {artifacts.map((artifact, index) => <details key={index}><summary>{artifact.kind}</summary><pre>{artifact.text}</pre></details>)}
        {!plan && !reviews.length && !artifacts.length && <p>Chưa có kết quả được ghi cho bước này.</p>}
      </> : <p>Chọn một bước trên sơ đồ để xem trạng thái và kết quả đã ghi.</p>}</aside>
    </div></section>;
}
