import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import { api } from './api';
import { statusInfo } from './format';
import type { Run } from './runTypes';

type NodeData = { prompt: string; truncated: boolean; output?: { messages: string[]; truncated: boolean } };

const border = { success: 'border-success', running: 'border-running', attention: 'border-attention', danger: 'border-danger', idle: 'border-border' };
const Pre = ({ children }: { children: React.ReactNode }) => <pre className="m-0 mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2 font-mono text-[11.5px]">{children}</pre>;
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <details className="border-t py-1.5 text-[12.5px] [&>summary]:cursor-pointer [&>summary]:py-1 [&>summary]:font-medium"><summary>{title}</summary><div className="pb-1.5">{children}</div></details>;

/** Read-only run snapshot as a graph: never consults or mutates the current flow draft. Sits in a collapsed row; the canvas is only built when it opens. */
export function RunGraph({ run, openSession, hasSession }: { run: Run; openSession(nodeId: string): void; hasSession(nodeId: string): boolean }) {
  const flow = run.snapshot?.configuration.flow;
  if (!flow) return null;
  return <Disclosure title="Sơ đồ flow của run" hint={`Snapshot ${flow.name} v${flow.version}`}><Canvas run={run} openSession={openSession} hasSession={hasSession} /></Disclosure>;
}

function Canvas({ run, openSession, hasSession }: { run: Run; openSession(nodeId: string): void; hasSession(nodeId: string): boolean }) {
  const [showData, setShowData] = useState(true), [selected, setSelected] = useState<string | null>(null);
  const flow = run.snapshot!.configuration.flow;
  const nodes = useMemo<Node[]>(() => flow.definition.nodes.map((node, index) => {
    const state = run.graph.nodes[node.id], status = statusInfo(state?.status);
    const interrupted = state?.status === 'running' && !['running', 'stopping'].includes(run.runtimeState?.phase ?? '');
    return { id: node.id, position: flow.layout[node.id] ?? { x: (index % 4) * 240, y: Math.floor(index / 4) * 140 },
      data: { label: `${node.label}\n${interrupted ? 'Dừng giữa chừng' : status.label}` },
      className: cn('!whitespace-pre-line !rounded-md !border-2 !bg-card !px-2.5 !py-2 !text-[12px] !text-foreground', border[interrupted ? 'attention' : status.status]) };
  }), [flow, run.graph, run.runtimeState?.phase]);
  const edges = useMemo<Edge[]>(() => flow.definition.edges.map((edge, index) => ({
    id: `${index}`, source: edge.from, target: edge.to, label: edge.outcome === 'completed' ? undefined : edge.outcome,
    markerEnd: { type: MarkerType.ArrowClosed }, type: 'smoothstep',
  })), [flow]);
  const dataEdges = useMemo<Edge[]>(() => { const seen = new Set<string>(); return (run.nodeData ?? []).flatMap(item => item.sources.flatMap(source => { if (!source.fromNodeId || source.fromNodeId === item.nodeId) return []; const key = `${source.fromNodeId}/${item.nodeId}/${source.kind}`; if (seen.has(key)) return []; seen.add(key); return [{ id: `data:${key}`, source: source.fromNodeId, target: item.nodeId, label: source.kind, type: 'smoothstep', style: { stroke: 'var(--muted-foreground)', strokeDasharray: '5 4' }, markerEnd: { type: MarkerType.ArrowClosed } }]; })); }, [run.nodeData]);
  const node = flow.definition.nodes.find(item => item.id === selected), artifacts = run.artifacts.filter(item => item.nodeId === selected);
  const rawStatus = node ? run.graph.nodes[node.id]?.status : undefined;
  const displayStatus = rawStatus === 'running' && !['running', 'stopping'].includes(run.runtimeState?.phase ?? '') ? 'Dừng giữa chừng' : statusInfo(rawStatus).label;
  const reviews = run.reviewerOutputs.filter(item => item.nodeId === selected), plan = run.plans.filter(item => item.nodeId === selected).at(-1)?.plan;
  const incoming = flow.definition.edges.filter(edge => edge.to === selected), outgoing = flow.definition.edges.filter(edge => edge.from === selected);
  const label = (id: string) => flow.definition.nodes.find(item => item.id === id)?.label ?? id;
  return <div className="flex flex-col gap-2.5">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground"><span>Cạnh liền: điều khiển · cạnh đứt: nguồn dữ liệu đã dùng</span>
      <label className="ml-auto flex cursor-pointer items-center gap-1.5"><input type="checkbox" className="size-3.5 accent-primary" checked={showData} onChange={e => setShowData(e.target.checked)} />Hiện quan hệ dữ liệu</label></div>
    <div className="@container"><div className="grid grid-cols-1 gap-3 @[760px]:grid-cols-[minmax(0,1fr)_300px]">
      <div className="h-[420px] overflow-hidden rounded-md border" aria-label="Sơ đồ snapshot của run">
        <ReactFlow nodes={nodes} edges={showData ? [...edges, ...dataEdges] : edges} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, item) => setSelected(item.id)} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.2} maxZoom={1.8}>
          <Background /><Controls showInteractive={false} />
        </ReactFlow></div>
      <aside className="max-h-[420px] overflow-auto rounded-md border p-3 text-[12.5px]" aria-live="polite">{node ? <>
        <h4 className="m-0 text-[13px] font-semibold">{node.label}</h4><p className="m-0 mt-0.5 text-muted-foreground">{displayStatus} · {node.type}</p>
        <Button size="sm" className="mt-2" disabled={!hasSession(node.id)} onClick={() => openSession(node.id)}>Xem session gần nhất</Button>
        <div className="mt-2">
          <Section title="Đầu vào và cấu hình đã ghim">
            <strong>Yêu cầu gốc</strong><Pre>{run.runtimeContext?.task ?? 'Không được ghi'}</Pre>
            <strong className="mt-2 block">Định nghĩa bước</strong><Pre>{JSON.stringify(node, null, 2)}</Pre>
            {node.type === 'review_group' && <p className="m-0 mt-2">Review kết quả của: {label(node.targetNodeId)} ({node.targetNodeId})</p>}
            <strong className="mt-2 block">Bước trước trong graph</strong>{incoming.length ? incoming.map((edge, index) => <p key={index} className="m-0">{label(edge.from)} → {edge.outcome}</p>) : <p className="m-0">Không có</p>}
            <small className="mt-1 block text-muted-foreground">Đường nối thể hiện luồng điều khiển; không mặc định là dữ liệu đã được truyền.</small>
          </Section>
          <Section title="Đầu ra và bước tiếp theo">
            <strong>Trạng thái đã ghi</strong><p className="m-0">{displayStatus}</p>
            <strong className="mt-2 block">Bước tiếp theo trong graph</strong>{outgoing.length ? outgoing.map((edge, index) => <p key={index} className="m-0">{edge.outcome} → {label(edge.to)}</p>) : <p className="m-0">Không có</p>}
            {node.type === 'agent_task' && <p className="m-0 mt-2">Output contract: {node.outputContract}</p>}
            {run.delivery?.filter(item => item.nodeId === node.id).map(item => <div key={item.commit}><strong>Commit {item.commit}</strong><Pre>{item.files.join('\n')}</Pre></div>)}
          </Section>
          {(run.nodeData ?? []).filter(item => item.nodeId === node.id).map(item => <NodeDataViewer key={item.attemptId} runId={run.runId} item={item} select={setSelected} />)}
          {plan && <Section title="Kế hoạch đã ghi"><Pre>{JSON.stringify(plan, null, 2)}</Pre></Section>}
          {reviews.map(review => <Section key={review.attemptId} title={`${review.result.reviewerId} · ${review.result.verdict}`}><p className="m-0">{review.summary}</p><Pre>{JSON.stringify({ result: review.result, evidence: review.evidence ?? null }, null, 2)}</Pre></Section>)}
          {artifacts.map((artifact, index) => <Section key={index} title={artifact.kind}><Pre>{artifact.text}</Pre></Section>)}
          {!plan && !reviews.length && !artifacts.length && <p className="m-0 border-t pt-2 text-muted-foreground">Chưa có kết quả được ghi cho bước này.</p>}
        </div></> : <p className="m-0 text-muted-foreground">Chọn một bước trên sơ đồ để xem trạng thái và kết quả đã ghi.</p>}</aside>
    </div></div>
  </div>;
}

function NodeDataViewer({ runId, item, select }: { runId: string; item: NonNullable<Run['nodeData']>[number]; select(id: string): void }) {
  const [data, setData] = useState<NodeData | null>(null), [error, setError] = useState(''), [open, setOpen] = useState(false);
  useEffect(() => { if (!open) return; let current = true; setError(''); void api<NodeData>(`/api/runs/${runId}/node-data/${item.attemptId}`).then(value => { if (current) setData(value); }).catch(e => { if (current) setError(String(e)); }); return () => { current = false; }; }, [open, runId, item.attemptId, item.output?.outputHash]);
  return <details className="border-t py-1.5 text-[12.5px]" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer py-1 font-medium">Input / Output · {item.attemptId.slice(0, 8)}</summary>
    <p className="m-0">Workspace: <code className="font-mono">{item.workspace}</code></p>
    <strong className="mt-2 block">Nguồn đầu vào đã ghi</strong>
    {item.sources.map((source, index) => <p key={index} className="m-0 mt-1">{source.kind} · {source.fromNodeId ? <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[12.5px] text-foreground underline" onClick={() => select(source.fromNodeId!)}>{source.fromNodeId}</button> : source.id}<br /><code className="font-mono text-[11px] text-muted-foreground">{source.hash}</code></p>)}
    {error && <p role="alert" className="m-0 text-danger">{error}</p>}
    {data ? <><strong className="mt-2 block">Prompt gửi agent</strong>{data.truncated && <p className="m-0 text-muted-foreground">Đã rút gọn; hash thuộc nội dung đầy đủ.</p>}<Pre>{data.prompt}</Pre><strong className="mt-2 block">Output agent</strong>{data.output ? <>{data.output.truncated && <p className="m-0 text-muted-foreground">Output đã rút gọn.</p>}<Pre>{data.output.messages.join('\n\n')}</Pre></> : <p className="m-0 text-muted-foreground">Chưa ghi nhận output hoàn tất. Xem session để biết lỗi hoặc tiến trình.</p>}</> : !error && <p className="m-0 text-muted-foreground">Đang đọc dữ liệu…</p>}
  </details>;
}
