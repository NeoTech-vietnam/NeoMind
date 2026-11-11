import { api } from './api';
import { askText, confirmAction } from './dialog';
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, CircleAlert, CircleCheck, CirclePlay, Ellipsis, GitBranch, GitCommit, GitMerge, GitPullRequest, ListChecks, PanelRight, Plus, Redo2, Repeat2, Split, Undo2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AppRoot, Shell, type FlowMeta, type ShellKind, type View } from './shell/AppShell';
import { CreateFlowDialog, NoFlows, slug, type Template } from './shell/FlowStart';
import { Callout } from './components/ui/misc';
import { Tag } from './components/ui/badge';
import { useTheme } from './lib/theme';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, applyNodeChanges,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import type { Binding, Flow, FlowNode } from '../../src/domain/schema';
import { duplicateNodes } from '../../src/domain/duplicate-nodes';
import { RunPanel } from './RunPanel';
import { FlowVersions } from './FlowVersions';
import { StepSkills, flowProfileKeys, nodeSkillCount, useProfileSkills } from './SkillPicker';
import { StepMemoryField } from './StepMemoryField';
import { SkillsPanel, type SkillSource } from './SkillsPanel';
import { Dialog, SheetContent } from './components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { Tooltip } from './components/ui/tooltip';
import { Button } from './components/ui/button';
import { Field as BaseField, Input, Textarea } from './components/ui/input';
import { Select } from './components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { ProfilePanel } from './ProfilePanel';
import { MemoryPanel } from './MemoryPanel';
import { modelLabel, reasoningLabel, runnerLabel, useRunners, type RunnerModels } from './runners';

type Bootstrap = { projectName: string; projectRoot: string; flows: FlowMeta[]; templates: string[]; runtimeAvailable: boolean };
type Diagnostic = { code: string; message: string; nodeId?: string };
type GraphNode = Node<{ label: string; kind: FlowNode['type']; detail: string; agent?: string; problems?: string[]; skills?: number }, 'studio'>;
type Kind = FlowNode['type'];

const kindInfo: Record<Kind, { label: string; icon: string; tone: string }> = {
  start: { label: 'Bắt đầu', icon: '↗', tone: 'mint' }, finish: { label: 'Hoàn tất', icon: '✓', tone: 'mint' },
  agent_task: { label: 'Agent task', icon: '✦', tone: 'violet' }, approval: { label: 'Duyệt', icon: '◇', tone: 'amber' },
  fork: { label: 'Phân nhánh', icon: '⑂', tone: 'blue' }, join: { label: 'Hợp nhánh', icon: '⑃', tone: 'blue' },
  condition: { label: 'Điều kiện', icon: '⋄', tone: 'amber' }, integration: { label: 'Tích hợp', icon: '⊞', tone: 'blue' },
  review_group: { label: 'Review', icon: '◎', tone: 'rose' }, repair_scope: { label: 'Vòng sửa', icon: '↻', tone: 'amber' },
  git_commit: { label: 'Commit local', icon: '⌘', tone: 'mint' },
};
const palette: Kind[] = ['agent_task', 'approval', 'fork', 'join', 'condition', 'integration', 'review_group', 'repair_scope', 'git_commit', 'finish'];
const paletteGroups: { label: string; kinds: Kind[] }[] = [
  { label: 'Agent', kinds: ['agent_task', 'integration'] }, { label: 'Duyệt & review', kinds: ['approval', 'review_group', 'repair_scope'] },
  { label: 'Điều khiển', kinds: ['fork', 'join', 'condition', 'finish'] }, { label: 'Git', kinds: ['git_commit'] },
];
const outcomes = ['completed', 'pass', 'needs_changes', 'blocked', 'true', 'false'] as const;

const kindIcons: Record<Kind, typeof Bot> = {
  start: CirclePlay, finish: Check, agent_task: Bot, approval: ListChecks,
  fork: Split, join: GitMerge, condition: GitBranch, integration: GitMerge,
  review_group: GitPullRequest, repair_scope: Repeat2, git_commit: GitCommit,
};
function KindIcon({ kind }: { kind: Kind }) { const Icon = kindIcons[kind]; return <Icon size={15} aria-hidden="true" />; }

function StudioNode({ data, selected }: NodeProps<GraphNode>) {
  const info = kindInfo[data.kind];
  return <div className={`graph-card tone-${info.tone} ${selected ? 'graph-card-selected' : ''} ${data.problems?.length ? 'graph-card-error' : ''}`}>
    {data.kind !== 'start' && <Handle type="target" position={Position.Left} />}
    <div className="graph-head"><span className="graph-icon"><KindIcon kind={data.kind} /></span><span className="graph-kind">{info.label}</span></div>
    <strong>{data.label}</strong><div className="graph-detail">{data.detail}</div>{data.agent && <span className="graph-runner">{data.agent}</span>}{!!data.skills && <span className="graph-skills" title="Skill bước này nhận (của agent hoặc riêng cho bước)">{data.skills} skill</span>}{!!data.problems?.length && <div className="graph-error">{data.problems.length} lỗi cấu hình</div>}
    {data.kind !== 'finish' && <Handle type="source" position={Position.Right} />}
  </div>;
}
const nodeTypes: NodeTypes = { studio: StudioNode };

function detailFor(node: FlowNode): string {
  switch (node.type) {
    case 'agent_task': return node.permissions.write ? 'Được sửa file' : 'Chỉ đọc';
    case 'approval': return node.mode === 'auto' ? 'NeoMind tự duyệt' : 'Chờ người dùng duyệt';
    case 'review_group': return `${node.reviewers.length} reviewer · ${node.reviewers.filter(r => r.required).length} bắt buộc · ${node.targetNodeId}`;
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
/** Show pinned values and inherited settings without claiming to resolve project defaults. */
function agentFor(node: FlowNode, flow: Flow): { agent?: string } {
  const bindingId = node.type === 'agent_task' ? node.bindingId : node.type === 'integration' ? node.bindingId : undefined;
  const binding = bindingId ? flow.definition.bindings[bindingId] : undefined;
  if (!binding) return {};
  return { agent: binding.runner.mode === 'inherit' && binding.model.mode === 'inherit' ? 'Mặc định' : [binding.runner.mode === 'pinned' ? runnerLabel(binding.runner.value) : 'Mặc định',
    binding.model.mode === 'pinned' ? modelLabel(binding.model.value) : 'model mặc định'].join(' · ') };
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
    case 'integration': return { ...base, type: kind, writeScopes: ['.'], profileId: 'implementer', profileVersion: 1, sessionGroup: group, bindingId: binding };
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
const FieldLabel = createContext('');
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string | undefined }) {
  return <FieldLabel.Provider value={label}><BaseField label={label} {...(hint ? { help: hint } : {})} className="mb-3.5">{children}</BaseField></FieldLabel.Provider>;
}
// Existing option lists include an empty value for inherited settings; Radix reserves that value for its placeholder.
function StudioSelect({ value, onChange, children, 'aria-label': ariaLabel }: { value: string | number; onChange(event: { target: { value: string } }): void; children: ReactNode; 'aria-label'?: string }) {
  const fieldLabel = useContext(FieldLabel);
  const options: { value: string; label: string; disabled?: boolean }[] = [];
  const visit = (nodes: ReactNode) => Children.forEach(nodes, child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>(child)) return;
    if (child.type === 'option') {
      const label = Children.toArray(child.props.children).join('');
      options.push({ value: `v:${child.props.value ?? label}`, label, ...(child.props.disabled ? { disabled: true } : {}) });
    } else visit(child.props.children);
  });
  visit(children);
  return <Select label={ariaLabel ?? fieldLabel} value={`v:${value}`} options={options} onValueChange={next => onChange({ target: { value: next.slice(2) } })} />;
}
function NodeChoices({ label, nodes, selected, change }: { label: string; nodes: FlowNode[]; selected: string[]; change(ids: string[]): void }) {
  const choices = [...nodes.map(node => ({ id: node.id, label: node.label })), ...selected.filter(id => !nodes.some(node => node.id === id)).map(id => ({ id, label: `${id} (không còn phù hợp)` }))];
  return <fieldset className="studio-node-choices"><legend>{label}</legend>{choices.length ? choices.map(choice => <label key={choice.id}><input type="checkbox" checked={selected.includes(choice.id)} onChange={event => change(event.target.checked ? [...selected, choice.id] : selected.filter(id => id !== choice.id))} /><span>{choice.label}</span></label>) : <p>Chưa có bước phù hợp.</p>}</fieldset>;
}
function ScopeField({ scopes, change }: { scopes: string[]; change(value: string[]): void }) {
  const serialized = scopes.join(', '), [text, setText] = useState(serialized), focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(serialized); }, [serialized]);
  return <Field label="Phạm vi được sửa" hint="Thư mục hoặc file, phân tách bằng dấu phẩy; . là toàn bộ project.">
    <span className="studio-scopes">{scopes.map(scope => <span key={scope}>{scope}</span>)}</span>
    <Input value={text} onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setText(serialized); }} onChange={event => { const value = event.target.value; setText(value); change(value.split(',').map(item => item.trim()).filter(Boolean)); }} />
  </Field>;
}
function JsonSetting({ label, value, apply }: { label: string; value: unknown; apply(value: unknown): void }) {
  const serialized = JSON.stringify(value, null, 2), [text, setText] = useState(serialized), [error, setError] = useState('');
  useEffect(() => { setText(serialized); setError(''); }, [serialized]);
  return <Field label={label}><Textarea aria-label={label} rows={3} value={text} onChange={e => setText(e.target.value)} /><Button onClick={() => { try { apply(JSON.parse(text)); setError(''); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>Áp dụng JSON</Button>{error && <span role="alert" className="text-danger">{error}</span>}</Field>;
}
/**
 * Runner/model/reasoning of one flow-level binding. "Mặc định" leaves a field to the project's role defaults. Pinning
 * a runner pins its provider too; picking a model pins the runner that serves it, so the binding stays consistent.
 */
function BindingFields({ binding, runners, ariaSuffix, change }: { binding: Binding; runners: RunnerModels[]; ariaSuffix: string; change(fn: (target: Binding) => void): void }) {
  const provider = binding.provider.mode === 'pinned' ? binding.provider.value : undefined;
  const runner = binding.runner.mode === 'pinned' ? binding.runner.value : undefined, info = runners.find(item => item.runner === runner && (runner !== 'opencode' || item.provider === provider));
  const model = binding.model.mode === 'pinned' ? binding.model.value : '', reasoning = binding.reasoning.mode === 'pinned' ? binding.reasoning.value : '';
  const knownModel = !model || runners.some(item => item.models.includes(model));
  const chooseRunner = (id: string) => change(target => {
    if (id === 'inherit') { target.runner = { mode: 'inherit' }; target.provider = { mode: 'inherit' }; target.model = { mode: 'inherit' }; return; }
    const next = runners.find(item => item.runner === id);
    target.runner = { mode: 'pinned', value: id };
    if (next) target.provider = { mode: 'pinned', value: next.provider };
    if (next && target.model.mode === 'pinned' && !next.models.includes(target.model.value)) target.model = { mode: 'pinned', value: next.models[0]! };
  });
  return <div className="binding-panel">
    <Field label="Runner" hint={runner ? `Provider ${info?.provider ?? (binding.provider.mode === 'pinned' ? binding.provider.value : '')}${runner === 'claude-code' ? ' · checks vẫn chạy qua Codex' : ''}` : 'Dùng runner mặc định của project.'}><div className="studio-seg" role="radiogroup" aria-label={`runner${ariaSuffix}`}>
      {[{ id: 'inherit', label: 'Mặc định' }, ...[...new Set([...runners.map(item => item.runner), ...(runner ? [runner] : [])])].map(id => ({ id, label: runnerLabel(id) }))].map(option =>
        <button key={option.id} type="button" role="radio" aria-checked={(runner ?? 'inherit') === option.id} className={(runner ?? 'inherit') === option.id ? 'on' : ''} onClick={() => chooseRunner(option.id)}>{option.label}</button>)}</div>
      </Field>
    {runner === 'opencode' && <Field label="Provider"><StudioSelect aria-label={`provider${ariaSuffix}`} value={provider ?? ''} onChange={e => change(target => {
      const next = runners.find(item => item.runner === 'opencode' && item.provider === e.target.value);
      if (next?.models[0]) { target.provider = { mode: 'pinned', value: next.provider }; target.model = { mode: 'pinned', value: next.models[0] }; target.reasoning = { mode: 'pinned', value: next.reasoning[0] ?? 'medium' }; }
    })}>{runners.filter(item => item.runner === 'opencode').map(item => <option key={item.provider} value={item.provider}>{item.provider}</option>)}</StudioSelect></Field>}
    <Field label="Model"><StudioSelect aria-label={`model${ariaSuffix}`} value={model} onChange={e => change(target => {
      if (!e.target.value) { target.model = { mode: 'inherit' }; return; }
      target.model = { mode: 'pinned', value: e.target.value };
      const owner = runners.find(item => item.models.includes(e.target.value));
      if (owner && (target.runner.mode !== 'pinned' || target.runner.value !== owner.runner)) { target.runner = { mode: 'pinned', value: owner.runner }; target.provider = { mode: 'pinned', value: owner.provider }; }
    })}><option value="">Mặc định</option>{!knownModel && <option value={model}>{model}</option>}
      {info ? info.models.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)
        : runners.map(item => <optgroup key={item.runner} label={runnerLabel(item.runner)}>{item.models.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}</optgroup>)}</StudioSelect></Field>
    <Field label="Mức suy luận"><StudioSelect aria-label={`reasoning${ariaSuffix}`} value={reasoning} onChange={e => change(target => { target.reasoning = e.target.value ? { mode: 'pinned', value: e.target.value } : { mode: 'inherit' }; })}>
      <option value="">Mặc định</option>{[...new Set([...(reasoning ? [reasoning] : []), ...(info?.reasoning ?? ['low', 'medium', 'high'])])].map(id => <option key={id} value={id}>{reasoningLabel(id)}</option>)}</StudioSelect></Field>
  </div>;
}
function fallbackValues(value: unknown): Binding['fallback'] {
  if (!Array.isArray(value)) throw new Error('Danh sách thay thế phải là JSON array');
  return value.map(item => {
    if (!item || typeof item !== 'object' || ['runner', 'provider', 'model', 'reasoning'].some(key => typeof item[key] !== 'string' || !item[key].trim()) || Object.keys(item).some(key => !['runner', 'provider', 'model', 'reasoning'].includes(key))) throw new Error('Mỗi lựa chọn cần runner, provider, model và reasoning');
    return { runner: item.runner as string, provider: item.provider as string, model: item.model as string, reasoning: item.reasoning as string };
  });
}

/** The editor: `web` in the browser, `panel` inside Nimbalyst (no topbar or sidebar, theme follows the host). */
export default function App({ shell = 'web' }: { shell?: ShellKind }) {
  return <AppRoot shell={shell}><Workspace shell={shell} /></AppRoot>;
}

function Workspace({ shell }: { shell: ShellKind }) {
  const { theme } = useTheme();
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1099px)');
    const update = () => setNarrow(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const compact = shell === 'panel' || narrow;
  // Runs first: giving work to agents and following it is the daily task.
  const [view, setView] = useState<View>('runs');
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null), revision = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const copiedNodes = useRef<{ flow: Flow; ids: string[] } | null>(null);
  const pastedSelection = useRef<string[] | null>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [latestAuthor, setLatestAuthor] = useState<'human' | 'ai' | null>(null), [versionsReload, setVersionsReload] = useState(0);
  const [addOpen, setAddOpen] = useState(false), [problemOpen, setProblemOpen] = useState(false), [inspectorOpen, setInspectorOpen] = useState(false);
  const [connectMenu, setConnectMenu] = useState<{ source: string; x: number; y: number; position: { x: number; y: number } } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphInstance, setGraphInstance] = useState<ReactFlowInstance<GraphNode, Edge> | null>(null);
  const [past, setPast] = useState<Flow[]>([]), [future, setFuture] = useState<Flow[]>([]);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const runners = useRunners();
  const profileSkills = useProfileSkills(flowProfileKeys(flow));
  const [skillFocus, setSkillFocus] = useState<{ id: string; source: SkillSource; nonce: number } | undefined>(undefined);
  const openSkills = useCallback((id?: string, source: SkillSource = 'neomind') => { if (id) setSkillFocus({ id, source, nonce: Date.now() }); setView('skills'); }, []);
  const [createOpen, setCreateOpen] = useState(false), [createTemplate, setCreateTemplate] = useState<Template>('dev');
  const openCreate = useCallback((template: Template = 'dev') => { setCreateTemplate(template); setCreateOpen(true); }, []);
  const refresh = useCallback(async () => { const data = await api<Bootstrap>('/api/bootstrap'); setBoot(data); return data; }, []);
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [refresh]);
  useEffect(() => setConnectMenu(null), [flow?.flowId, view]);
  useEffect(() => {
    if (!flow?.flowId) { setLatestAuthor(null); return; }
    let current = true; setLatestAuthor(null);
    void api<{ versionInfo?: { author: { kind: 'human' | 'ai' } }[] }>(`/api/flows/${encodeURIComponent(flow.flowId)}/versions`)
      .then(data => { if (current) setLatestAuthor(data.versionInfo?.at(-1)?.author.kind ?? null); }).catch(() => { if (current) setLatestAuthor(null); });
    return () => { current = false; };
  }, [flow?.flowId, versionsReload]);
  // The Flows view always shows a flow when one exists; the template picker is only for projects with none.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    const first = view === 'flows' && !flow && !busy ? boot?.flows.find(item => !item.archived) : undefined;
    // Try each flow once, so a draft that fails to load shows its error instead of retrying forever.
    if (first && autoOpened.current !== first.flowId) { autoOpened.current = first.flowId; void openFlow(first.flowId); }
  }, [view, flow, boot, busy]);
  const active = flow?.definition.nodes.find(node => node.id === selected);

  useEffect(() => {
    if (!flow) { setGraphNodes([]); return; }
    const selectedIds = pastedSelection.current; pastedSelection.current = null;
    setGraphNodes(previous => flow.definition.nodes.map((node, index) => ({ id: node.id, type: 'studio',
      selected: selectedIds ? selectedIds.includes(node.id) : !!previous.find(item => item.id === node.id)?.selected,
      position: flow.layout[node.id] ?? { x: 80 + (index % 4) * 255, y: 110 + Math.floor(index / 4) * 165 },
      data: { label: node.label, kind: node.type, detail: detailFor(node), ...agentFor(node, flow), skills: nodeSkillCount(node, profileSkills), problems: diagnostics.filter(item => item.nodeId === node.id).map(item => item.message) } })));
  }, [flow, diagnostics, profileSkills]);
  const edges = useMemo<Edge[]>(() => (flow?.definition.edges ?? []).map((edge, index) => ({
    id: `edge-${index}`, source: edge.from, target: edge.to, label: edge.outcome === 'completed' ? '' : edge.outcome,
    type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--faint)' }, style: { stroke: 'var(--faint)', strokeWidth: 1.6, ...(edge.outcome === 'needs_changes' ? { strokeDasharray: '5 4' } : {}) },
    labelStyle: { fill: 'var(--muted-foreground)', fontSize: 11, fontWeight: 700 }, labelBgStyle: { fill: 'var(--card)' },
  })), [flow]);
  function edit(next: Flow) { if (flow) setPast(items => [...items, structuredClone(flow)].slice(-40)); setFuture([]); setFlow(next); setDirty(true); setDiagnostics([]); setMessage(''); }
  function mutate(fn: (draft: Flow) => void) { if (!flow) return; const next = structuredClone(flow); fn(next); edit(next); }
  function updateNode(fn: (node: FlowNode) => void) { mutate(next => { const node = next.definition.nodes.find(item => item.id === selected); if (node) fn(node); }); }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  /** Ask before an action would drop unsaved draft edits; `next` says what happens instead. */
  async function discardDraft(next: string): Promise<boolean> {
    return !dirty || confirmAction({ title: 'Bỏ thay đổi chưa lưu?', description: `Bản nháp của ${flow?.name ?? 'flow này'} có thay đổi chưa lưu. ${next}`, confirmLabel: 'Bỏ thay đổi', cancelLabel: 'Ở lại', danger: true });
  }
  async function openFlow(id: string) {
    setView('flows');
    if (id === flow?.flowId || !await discardDraft('Mở flow khác sẽ bỏ các thay đổi này.')) return;
    await action(async () => { const data = await api<{ draft: Flow; revision: string }>(`/api/flows/${encodeURIComponent(id)}/draft`); revision.current = data.revision; setFlow(data.draft); setSelected(null); setSelectedEdge(null); setPast([]); setFuture([]); setDirty(false); setDiagnostics([]); setMessage(''); });
  }
  async function createFlow(input: { id: string; name: string; template: Template }) {
    if (!await discardDraft('Tạo flow mới sẽ bỏ các thay đổi này.')) return;
    await action(async () => { const result = await api<{ draft: Flow; revision: string }>('/api/flows', 'POST', input);
      revision.current = result.revision; await refresh(); setFlow(result.draft); setView('flows'); setCreateOpen(false); setSelected(null); setDirty(false); setPast([]); setFuture([]); setMessage('Đã tạo bản nháp.'); });
  }
  async function manageFlow(operation: 'rename' | 'clone' | 'archive' | 'restore' | 'delete') {
    if (!flow) return;
    const current = flow;
    if (operation !== 'rename' && !await discardDraft('Tiếp tục sẽ bỏ các thay đổi này.')) return;
    let payload: Record<string, string> = {};
    if (operation === 'rename' || operation === 'clone') {
      const name = await askText(operation === 'rename' ? { title: 'Đổi tên flow', label: 'Tên mới', initial: current.name, confirmLabel: 'Đổi tên' }
        : { title: 'Sao chép flow', description: 'Bản sao là một flow mới, bắt đầu từ bản nháp hiện tại.', label: 'Tên flow mới', initial: `${current.name} copy`, confirmLabel: 'Sao chép' });
      if (!name?.trim()) return;
      payload = operation === 'rename' ? { name: name.trim() } : { name: name.trim(), targetId: slug(name) };
      if (operation === 'clone' && !payload.targetId) return;
    }
    if (operation === 'delete') {
      const name = await askText({ title: `Xóa vĩnh viễn flow ${current.name}?`, description: `Flow bị xóa khỏi thư viện và không khôi phục được. Nhập chính xác tên “${current.name}” để xác nhận.`,
        label: 'Tên flow', confirmLabel: 'Xóa vĩnh viễn', danger: true });
      if (name !== current.name) return;
      payload = { confirmedName: name };
    }
    await action(async () => {
      if (operation === 'rename') {
        // Save the draft first, then keep its display name aligned with the library metadata.
        await saveDraft();
        const renamed = { ...current, name: payload.name! };
        await saveDraft(renamed);
        await api(`/api/flows/${encodeURIComponent(current.flowId)}/rename`, 'POST', payload);
        setFlow(renamed); setDirty(false);
      } else if (operation === 'clone') {
        const result = await api<{ draft: Flow; revision: string }>(`/api/flows/${encodeURIComponent(current.flowId)}/clone`, 'POST', payload);
        revision.current = result.revision; setFlow(result.draft); setDirty(false); setSelected(null); setPast([]); setFuture([]);
      } else {
        await api(`/api/flows/${encodeURIComponent(current.flowId)}/${operation}`, 'POST', payload);
        if (operation === 'archive' || operation === 'delete') { setFlow(null); setSelected(null); setDirty(false); }
      }
      await refresh(); setMessage('Đã cập nhật thư viện flow.');
    });
  }
  /** Write the saved draft as a JSON Canvas board that Nimbalyst and Obsidian open; unsaved edits are saved first. */
  async function exportCanvas() {
    if (!flow) return;
    await action(async () => {
      if (dirty) await saveDraft();
      const result = await api<{ file: string }>(`/api/flows/${encodeURIComponent(flow.flowId)}/canvas-export`, 'POST', {});
      setMessage(`Đã xuất ${result.file}. Mở bằng Nimbalyst hoặc Obsidian để sửa, rồi chọn "Nhập từ .canvas".`);
    });
  }
  /** Apply the edited board to the draft (positions, names, kinds, added/removed steps, connections). */
  async function importCanvas() {
    if (!flow) return;
    if (!await discardDraft('Nhập từ .canvas sẽ thay bản nháp bằng nội dung của file canvas.')) return;
    await action(async () => {
      const result = await api<{ draft: Flow; revision: string; file: string; diagnostics: Diagnostic[]; report: { added: string[]; removed: string[]; renamed: string[]; retyped: string[]; moved: number; edges: number; notesIgnored: number; warnings: string[] } }>(`/api/flows/${encodeURIComponent(flow.flowId)}/canvas-import`, 'POST', {});
      revision.current = result.revision; setFlow(result.draft); setDirty(false); setPast([]); setFuture([]); setSelected(null); setSelectedEdge(null); setDiagnostics(result.diagnostics);
      const r = result.report, parts = [r.added.length && `thêm ${r.added.length} bước`, r.removed.length && `xóa ${r.removed.length}`, r.renamed.length && `đổi tên ${r.renamed.length}`, r.retyped.length && `đổi loại ${r.retyped.length}`, r.moved && `di chuyển ${r.moved}`, `${r.edges} kết nối`].filter(Boolean);
      setMessage(`Đã nhập ${result.file}: ${parts.join(', ')}.${r.notesIgnored ? ` Bỏ qua ${r.notesIgnored} ghi chú.` : ''}${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}${result.diagnostics.length ? ' Flow còn điểm cần chỉnh, xem thanh kiểm tra.' : ''}`);
    });
  }
  // The revision guards against overwriting a draft changed by another editor tab or the CLI since it was loaded.
  async function saveDraft(draft: Flow | null = flow): Promise<string | undefined> {
    if (!draft) return undefined;
    const saved = await api<{ revision: string }>(`/api/flows/${encodeURIComponent(draft.flowId)}/draft`, 'PUT', { draft, ...(revision.current ? { expectedRevision: revision.current } : {}) });
    revision.current = saved.revision; setDirty(false); return saved.revision;
  }
  function selectProblem(nodeId: string) {
    setSelected(nodeId); setSelectedEdge(null); setInspectorOpen(true);
    setGraphNodes(nodes => nodes.map(node => ({ ...node, selected: node.id === nodeId })));
    void graphInstance?.fitView({ nodes: [{ id: nodeId }], duration: 250, maxZoom: 1 });
  }
  async function validate(current: Flow) {
    const result = await api<{ valid: boolean; diagnostics?: Diagnostic[] }>(`/api/flows/${encodeURIComponent(current.flowId)}/validate`, 'POST', { draft: current });
    const issues = result.diagnostics ?? [];
    setDiagnostics(issues); setProblemOpen(true);
    if (!result.valid && issues[0]?.nodeId) selectProblem(issues[0].nodeId);
    return result.valid;
  }
  function addNode(kind: Kind, position?: { x: number; y: number }) { if (!flow) return; let index = 1; while (flow.definition.nodes.some(node => node.id === `${kind}-${index}`)) index++;
    const node = makeNode(kind, `${kind}-${index}`, flow); pastedSelection.current = [node.id]; mutate(next => { next.definition.nodes.push(node); next.layout[node.id] = position ?? { x: 120 + (next.definition.nodes.length % 4) * 180, y: 350 }; }); setSelected(node.id); setSelectedEdge(null); }
  function addAfterSelected(kind: Kind) {
    if (!flow) return;
    const source = flow.definition.nodes.find(node => node.id === selected && node.type !== 'finish');
    if (!source) { addNode(kind); setAddOpen(false); return; }
    let index = 1; while (flow.definition.nodes.some(node => node.id === `${kind}-${index}`)) index++;
    const node = makeNode(kind, `${kind}-${index}`, flow), position = flow.layout[source.id] ?? { x: 120, y: 350 };
    const outcome = source.type === 'approval' || source.type === 'review_group' ? 'pass' : source.type === 'condition' ? 'true' : 'completed';
    pastedSelection.current = [node.id]; mutate(next => { next.definition.nodes.push(node); next.layout[node.id] = { x: position.x + 260, y: position.y }; next.definition.edges.push({ from: source.id, to: node.id, outcome }); });
    setSelected(node.id); setSelectedEdge(null); setAddOpen(false); setInspectorOpen(true);
  }
  function addConnectedNode(kind: Kind) {
    if (!flow || !connectMenu) return;
    const source = flow.definition.nodes.find(node => node.id === connectMenu.source);
    if (!source || source.type === 'finish') { setConnectMenu(null); return; }
    let index = 1; while (flow.definition.nodes.some(node => node.id === `${kind}-${index}`)) index++;
    const node = makeNode(kind, `${kind}-${index}`, flow);
    const outcome = source.type === 'approval' || source.type === 'review_group' ? 'pass' : source.type === 'condition' ? 'true' : 'completed';
    pastedSelection.current = [node.id]; mutate(next => { next.definition.nodes.push(node); next.layout[node.id] = connectMenu.position; next.definition.edges.push({ from: source.id, to: node.id, outcome }); });
    setSelected(node.id); setSelectedEdge(null); setConnectMenu(null);
  }
  async function removeNode() {
    if (!flow) return;
    const chosen = graphNodes.filter(node => node.selected && node.id !== flow.definition.startNodeId).map(node => node.id);
    const ids = new Set(chosen.length ? chosen : active && active.type !== 'start' ? [active.id] : []);
    if (!ids.size) return;
    const count = flow.definition.edges.filter(edge => ids.has(edge.from) || ids.has(edge.to)).length;
    const references = flow.definition.nodes.filter(node => !ids.has(node.id) && ((node.type === 'review_group' && ids.has(node.targetNodeId))
      || (node.type === 'repair_scope' && (ids.has(node.targetReviewId) || node.ownerNodeIds.some(id => ids.has(id))))
      || (node.type === 'join' && node.requiredBranches.some(id => ids.has(id))))).map(node => node.label);
    if (!await confirmAction({ title: `Xóa ${ids.size} bước và ${count} kết nối?`, confirmLabel: 'Xóa', danger: true,
      description: `Có thể hoàn tác bằng Ctrl+Z.${references.length ? `\nCác bước còn tham chiếu tới bước bị xóa cần chỉnh lại: ${references.join(', ')}.` : ''}` })) return;
    mutate(next => { next.definition.nodes = next.definition.nodes.filter(node => !ids.has(node.id)); next.definition.edges = next.definition.edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to)); for (const id of ids) delete next.layout[id]; });
    setSelected(null); setSelectedEdge(null);
  }
  async function removeEdge(index: number) {
    if (!await confirmAction({ title: 'Xóa kết nối?', description: 'Có thể hoàn tác bằng Ctrl+Z.', confirmLabel: 'Xóa', danger: true })) return;
    mutate(next => { next.definition.edges.splice(index, 1); }); setSelectedEdge(null);
  }
  function undo() { if (!flow || !past.length) return; const previous = past[past.length - 1]!; setPast(past.slice(0, -1)); setFuture([structuredClone(flow), ...future]); setFlow(previous); setDirty(true); setDiagnostics([]); }
  function redo() { if (!flow || !future.length) return; setPast([...past, structuredClone(flow)]); setFlow(future[0]!); setFuture(future.slice(1)); setDirty(true); setDiagnostics([]); }
  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => { setGraphNodes(nodes => applyNodeChanges(changes, nodes)); }, []);
  function connect(connection: Connection) { if (!flow || !connection.source || !connection.target) return;
    const source = flow.definition.nodes.find(n => n.id === connection.source);
    const outcome = source?.type === 'approval' || source?.type === 'review_group' ? 'pass' : source?.type === 'condition' ? 'true' : 'completed';
    mutate(next => { next.definition.edges.push({ from: connection.source!, to: connection.target!, outcome }); }); }
  function changeBinding(bindingId: string, fn: (target: Binding) => void) { mutate(next => { const target = next.definition.bindings[bindingId]; if (target) fn(target); }); }
  const binding = active?.type === 'agent_task' ? flow?.definition.bindings[active.bindingId] : undefined;
  useEffect(() => {
    if (view !== 'flows' || !flow) return;
    function keyboard(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void action(async () => { await saveDraft(); setMessage('Đã lưu bản nháp.'); }); return; }
      const target = event.composedPath()[0] as HTMLElement | undefined;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (window.getSelection()?.toString()) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (key === '/' && !mod) { event.preventDefault(); setAddOpen(true); }
      else if (key === 'escape' && connectMenu) { event.preventDefault(); setConnectMenu(null); }
      else if (key === 'escape') { setSelected(null); setSelectedEdge(null); setGraphNodes(nodes => nodes.map(node => ({ ...node, selected: false }))); }
      else if (mod && key === 's') { event.preventDefault(); void action(async () => { await saveDraft(); setMessage('Đã lưu bản nháp.'); }); }
      else if (mod && key === 'a') { event.preventDefault(); setGraphNodes(nodes => nodes.map(node => ({ ...node, selected: true }))); }
      else if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (mod && key === 'y') { event.preventDefault(); redo(); }
      else if (mod && key === 'c') {
        const selectedIds = graphNodes.filter(node => node.selected && node.id !== flow!.definition.startNodeId).map(node => node.id);
        const ids = selectedIds.length ? selectedIds : active && active.type !== 'start' ? [active.id] : [];
        if (ids.length) { event.preventDefault(); copiedNodes.current = { flow: structuredClone(flow!), ids }; }
      } else if (mod && key === 'v' && copiedNodes.current?.flow.flowId === flow!.flowId) {
        event.preventDefault(); const result = duplicateNodes(flow!, copiedNodes.current.flow, copiedNodes.current.ids);
        if (result.ids.length) { pastedSelection.current = result.ids; copiedNodes.current = { flow: result.flow, ids: result.ids }; edit(result.flow); setSelected(result.ids[0]!); setSelectedEdge(null); }
      } else if ((key === 'delete' || key === 'backspace') && selectedEdge !== null) { event.preventDefault(); void removeEdge(selectedEdge);
      } else if ((key === 'delete' || key === 'backspace') && (active?.type !== 'start' || graphNodes.some(node => node.selected && node.id !== flow!.definition.startNodeId))) { event.preventDefault(); void removeNode(); }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [view, flow, active, past, future, graphNodes, connectMenu, selectedEdge]);

  const inspectorTitle = active ? <span className="studio-inspector-title"><Input aria-label="Tên bước" value={active.label} onChange={e => updateNode(node => { node.label = e.target.value; })} /><span><KindIcon kind={active.type} />{kindInfo[active.type].label}</span></span> : <span>{selectedEdge !== null ? 'Kết nối' : 'Cài đặt flow'}</span>;
  const inspector = flow && <aside className="inspector"><div className="inspector-head">{inspectorTitle}</div>
              {active ? <div className="inspector-scroll">{diagnostics.filter(item => item.nodeId === active.id).map((item, index) => <Callout tone="danger" key={`${item.code}-${index}`}>{item.message}</Callout>)}
                {active.type === 'agent_task' && <>
                  <Field label="Mục tiêu"><Textarea rows={3} value={active.goal} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.goal = e.target.value; })} /></Field>
                  <div className="section-rule" /><div className="inspector-section">Agent</div>
                  {binding && <BindingFields binding={binding} runners={runners} ariaSuffix="" change={fn => changeBinding(active.bindingId, fn)} />}
                  {binding && flow.definition.nodes.filter(node => node.type === 'agent_task' && node.bindingId === active.bindingId).length > 1 && <p className="my-2 text-[12.5px] leading-relaxed text-muted-foreground">Runner/model dùng chung với các bước khác cùng binding {active.bindingId}.</p>}
                  <div className="section-rule" /><div className="inspector-section">Quyền</div>
                  <label className="check-row"><input type="checkbox" checked={active.permissions.write} onChange={e => updateNode(node => { if (node.type === 'agent_task') { node.permissions.write = e.target.checked; node.writeScopes = e.target.checked ? ['.'] : []; } })} /> <span>Được sửa file<small>Cho phép agent thay đổi file trong phạm vi bên dưới.</small></span></label>
                  {active.permissions.write && <ScopeField key={active.id} scopes={active.writeScopes} change={value => updateNode(node => { if (node.type === 'agent_task') node.writeScopes = value; })} />}
                  <label className="check-row"><input type="checkbox" checked={active.permissions.checks} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.permissions.checks = e.target.checked; })} /> <span>Được đề xuất checks<small>Cho phép agent đề xuất lệnh kiểm tra.</small></span></label><p className="my-2 text-[12.5px] leading-relaxed text-muted-foreground">Checks chạy qua Codex theo chế độ sandbox của project.</p>
                  <div className="section-rule" /><StepSkills holder={active} onOpenSkills={() => openSkills()} onChange={skills => updateNode(node => { if (node.type === 'agent_task') { if (skills) node.skillsOverride = skills; else delete node.skillsOverride; } })} />
                  <div className="section-rule" /><StepMemoryField key={`memory-${active.id}`} memory={active.memory} roleDefaults={flow.definition.memoryDefaults === 'role'}
                    role={active.outputContract === 'plan' ? 'plan' : active.permissions.write ? 'write' : 'read'}
                    onChange={memory => updateNode(node => { if (node.type === 'agent_task') { if (memory) node.memory = memory; else delete node.memory; } })} />
                  <details className="advanced"><summary>Nâng cao</summary>
                    <Field label="Hướng dẫn bổ sung"><Textarea rows={2} value={active.instructionsOverride ?? ''} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.instructionsOverride = e.target.value; })} placeholder="Tùy chọn" /></Field>
                    <div className="field-grid"><Field label="Phiên bản"><Input type="number" min="1" value={active.profileVersion} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.profileVersion = Number(e.target.value); })} /></Field>
                      <Field label="Agent profile"><Input value={active.profileId} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.profileId = e.target.value; })} /></Field></div>
                    <Field label="Session group" hint="Các bước cùng session group nối tiếp một phiên agent."><Input value={active.sessionGroup} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.sessionGroup = e.target.value; })} /></Field>
                    <Field label="Binding" hint="Các bước cùng binding dùng chung runner/model."><StudioSelect value={active.bindingId} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.bindingId = e.target.value; })}>{Object.keys(flow.definition.bindings).map(key => <option key={key}>{key}</option>)}</StudioSelect></Field>
                    <Field label="Output contract"><Input value={active.outputContract} onChange={e => updateNode(node => { if (node.type === 'agent_task') node.outputContract = e.target.value; })} /></Field>
                    {binding && <JsonSetting label="Model thay thế (JSON)" value={binding.fallback} apply={value => { const fallback = fallbackValues(value); mutate(next => { const target = next.definition.bindings[active.bindingId]; if (target) target.fallback = fallback; }); }} />}
                  </details>
                </>}
                {active.type === 'approval' && <><Field label="Ai duyệt kế hoạch" hint={active.mode === 'auto' ? 'Agent sửa file ngay sau khi lập kế hoạch. Project cần cho phép (allowAutoApproval: true) khi yêu cầu người dùng duyệt.' : undefined}><StudioSelect value={active.mode ?? 'user'} onChange={e => updateNode(node => { if (node.type === 'approval') { if (e.target.value === 'auto') node.mode = 'auto'; else delete node.mode; } })}><option value="user">Bạn duyệt</option><option value="auto">NeoMind tự duyệt</option></StudioSelect></Field>
                  <Field label="Nội dung cần duyệt"><Textarea rows={3} value={active.purpose} onChange={e => updateNode(node => { if (node.type === 'approval') node.purpose = e.target.value; })} /></Field></>}
                {active.type === 'review_group' && <><Field label="Checks riêng của bước review (mỗi dòng một lệnh)" hint="Review nhánh chỉ chạy các checks này; review kết quả tích hợp luôn chạy toàn bộ checks của kế hoạch. Các lệnh phải có trong kế hoạch được duyệt."><Textarea value={(active.checks ?? []).join('\n')} onChange={event => updateNode(node => { if (node.type === 'review_group') node.checks = event.target.value.split('\n').map(value => value.trim()).filter(Boolean); })} /></Field><div className="section-rule" /><div className="inspector-section">Review</div>
                  <Field label="Kiểm tra output của"><StudioSelect value={active.targetNodeId} onChange={e => updateNode(node => { if (node.type === 'review_group') node.targetNodeId = e.target.value; })}>{flow.definition.nodes.filter(n => n.type === 'agent_task' || n.type === 'integration').map(n => <option key={n.id} value={n.id}>{n.label} · {n.id}</option>)}</StudioSelect></Field>
                  {active.reviewers.map((reviewer, index) => <div className="reviewer-box" key={index}><div className="reviewer-heading"><strong>Reviewer {index + 1}</strong><button className="cursor-pointer border-0 bg-transparent text-[12.5px] text-danger" onClick={() => updateNode(node => { if (node.type === 'review_group') node.reviewers.splice(index, 1); })}>Xóa</button></div>
                    <Field label="Tên reviewer"><Input value={reviewer.id} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].id = e.target.value; })} /></Field>
                    {(() => {
                      const group = flow.definition.sessionGroups.find(item => item.id === reviewer.sessionGroup);
                      const reviewerBinding = group && flow.definition.bindings[group.bindingId];
                      if (!group || !reviewerBinding) return <p className="my-2 text-[12.5px] leading-relaxed text-muted-foreground">Session group chưa có binding hợp lệ.</p>;
                      const shared = flow.definition.sessionGroups.filter(item => item.bindingId === group.bindingId).length > 1;
                      return <><BindingFields binding={reviewerBinding} runners={runners} ariaSuffix=" reviewer" change={fn => changeBinding(group.bindingId, fn)} />
                        {shared && <p className="my-2 text-[12.5px] leading-relaxed text-muted-foreground">Cấu hình này dùng chung với bước khác (binding {group.bindingId}). <button className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-foreground underline" onClick={() => mutate(next => { const target = next.definition.nodes.find(item => item.id === active.id); if (target?.type !== 'review_group' || !target.reviewers[index]) return; let n = 1; while (next.definition.sessionGroups.some(item => item.id === `${active.id}-reviewer-${n}`) || Object.hasOwn(next.definition.bindings, `${active.id}-binding-${n}`)) n++; const groupId = `${active.id}-reviewer-${n}`, bindingId = `${active.id}-binding-${n}`; next.definition.bindings[bindingId] = structuredClone(reviewerBinding); next.definition.sessionGroups.push({ id: groupId, bindingId }); target.reviewers[index].sessionGroup = groupId; })}>Tách riêng cho reviewer này</button></p>}
                        <label className="check-row"><input type="checkbox" checked={reviewer.required} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].required = e.target.checked; })} /> Bắt buộc đạt</label>
                        <Field label="Phạm vi review" hint="Thư mục hoặc file, phân tách bằng dấu phẩy; . là toàn bộ project."><Input value={reviewer.scope.join(', ')} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].scope = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>
                        <StepSkills holder={reviewer} label={`Skills của reviewer ${index + 1}`} onChange={skills => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) { if (skills) node.reviewers[index].skillsOverride = skills; else delete node.reviewers[index].skillsOverride; } })} />
                        <StepMemoryField key={`memory-${active.id}-${reviewer.id}`} memory={reviewer.memory} role="review" roleDefaults={flow.definition.memoryDefaults === 'role'}
                          onChange={memory => updateNode(node => { const target = node.type === 'review_group' ? node.reviewers[index] : undefined; if (target) { if (memory) target.memory = memory; else delete target.memory; } })} />
                        <details className="advanced"><summary>Nâng cao</summary>
                          <Field label="Hướng dẫn reviewer"><Textarea rows={2} value={reviewer.instructionsOverride ?? ''} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].instructionsOverride = e.target.value; })} placeholder="Tùy chọn" /></Field>
                          <div className="field-grid"><Field label="Phiên bản"><Input type="number" min="1" value={reviewer.profileVersion} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].profileVersion = Number(e.target.value); })} /></Field>
                            <Field label="Profile"><Input value={reviewer.profileId} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].profileId = e.target.value; })} /></Field></div>
                          <Field label="Session group"><StudioSelect value={reviewer.sessionGroup} onChange={e => updateNode(node => { if (node.type === 'review_group' && node.reviewers[index]) node.reviewers[index].sessionGroup = e.target.value; })}>{flow.definition.sessionGroups.map(g => <option key={g.id} value={g.id}>{g.id}</option>)}</StudioSelect></Field>
                          <Field label="Binding" hint="Các session cùng binding dùng chung runner/model."><StudioSelect value={group.bindingId} onChange={e => mutate(next => { const target = next.definition.sessionGroups.find(item => item.id === reviewer.sessionGroup); if (target) target.bindingId = e.target.value; })}>{Object.keys(flow.definition.bindings).map(key => <option key={key} value={key}>{key}</option>)}</StudioSelect></Field>
                          <JsonSetting label="Model thay thế (JSON)" value={reviewerBinding.fallback} apply={value => { const fallback = fallbackValues(value); mutate(next => { const target = next.definition.bindings[group.bindingId]; if (target) target.fallback = fallback; }); }} /></details></>;
                    })()}</div>)}
                  <Button className="mb-3.5 w-full" onClick={() => mutate(next => { const node = next.definition.nodes.find(n => n.id === active.id); if (node?.type !== 'review_group') return; let n = 1; while (next.definition.sessionGroups.some(item => item.id === `${active.id}-session-${n}`) || node.reviewers.some(item => item.id === `reviewer-${n}`)) n++; const groupId = `${active.id}-session-${n}`; const bindingId = Object.hasOwn(next.definition.bindings, 'verifier') ? 'verifier' : Object.keys(next.definition.bindings)[0] ?? 'verifier'; next.definition.sessionGroups.push({ id: groupId, bindingId }); node.reviewers.push({ id: `reviewer-${n}`, profileId: 'verifier', profileVersion: 1, sessionGroup: groupId, required: true, scope: ['.'] }); })}><Plus />Thêm reviewer</Button>
                  <Field label="Tiêu chí" hint="Phân tách bằng dấu phẩy"><Input value={active.criteria.join(', ')} onChange={e => updateNode(node => { if (node.type === 'review_group') node.criteria = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>
                  <label className="my-2 flex items-start gap-2 text-[12.5px]"><input type="checkbox" className="mt-0.5 accent-primary" checked={!!active.planStepCriteria} onChange={e => updateNode(node => { if (node.type === 'review_group') { if (e.target.checked) node.planStepCriteria = true; else delete node.planStepCriteria; } })} />
                    <span>Chấm từng bước đánh số của plan<span className="block text-muted-foreground">Mỗi bước "1. …" trong cách làm của plan đã duyệt thành tiêu chí bắt buộc "Plan step N".</span></span></label></>}
                {active.type === 'repair_scope' && <><Field label="Review cần kiểm tra lại"><StudioSelect value={active.targetReviewId} onChange={e => updateNode(node => { if (node.type === 'repair_scope') node.targetReviewId = e.target.value; })}>{flow.definition.nodes.filter(n => n.type === 'review_group').map(n => <option key={n.id} value={n.id}>{n.label} · {n.id}</option>)}</StudioSelect></Field>
                  <NodeChoices label="Agent sửa" nodes={flow.definition.nodes.filter(node => (node.type === 'agent_task' && node.permissions.write) || (node.type === 'integration' && !!node.bindingId))} selected={active.ownerNodeIds} change={ids => updateNode(node => { if (node.type === 'repair_scope') node.ownerNodeIds = ids; })} />
                  <Field label="Số vòng tối đa"><Input type="number" min="1" value={active.maxRounds} onChange={e => updateNode(node => { if (node.type === 'repair_scope') node.maxRounds = Number(e.target.value); })} /></Field></>}
                {active.type === 'join' && <NodeChoices label="Nhánh bắt buộc" nodes={flow.definition.nodes.filter(node => flow.definition.edges.some(edge => edge.to === active.id && edge.from === node.id))} selected={active.requiredBranches} change={ids => updateNode(node => { if (node.type === 'join') node.requiredBranches = ids; })} />}
                {active.type === 'integration' && <Field label="Session xử lý conflict/repair"><StudioSelect value={active.sessionGroup ?? ''} onChange={e => updateNode(node => {
                  if (node.type !== 'integration') return;
                  const group = flow.definition.sessionGroups.find(item => item.id === e.target.value);
                  if (!group) { delete node.sessionGroup; delete node.bindingId; delete node.profileId; delete node.profileVersion; return; }
                  node.sessionGroup = group.id; node.bindingId = group.bindingId; node.profileId ??= 'implementer'; node.profileVersion ??= 1;
                })}><option value="">Không có agent (chỉ gộp khi không conflict)</option>{flow.definition.sessionGroups.map(g => <option key={g.id} value={g.id}>{g.id}</option>)}</StudioSelect></Field>}
                {active.type === 'integration' && <Field label="Phạm vi tích hợp"><Input value={active.writeScopes.join(', ')} onChange={e => updateNode(node => { if (node.type === 'integration') node.writeScopes = e.target.value.split(',').map(v => v.trim()).filter(Boolean); })} /></Field>}
                {active.type === 'integration' && active.profileId && <><div className="section-rule" /><StepSkills holder={active} label="Skills khi xử lý conflict/repair" onOpenSkills={() => openSkills()} onChange={skills => updateNode(node => { if (node.type === 'integration') { if (skills) node.skillsOverride = skills; else delete node.skillsOverride; } })} />
                  <div className="section-rule" /><StepMemoryField key={`memory-${active.id}`} memory={active.memory} role="write" roleDefaults={flow.definition.memoryDefaults === 'role'}
                    onChange={memory => updateNode(node => { if (node.type === 'integration') { if (memory) node.memory = memory; else delete node.memory; } })} /></>}
                {active.type === 'condition' && <><Field label="Trường dữ liệu"><Input value={active.field} onChange={e => updateNode(node => { if (node.type === 'condition') node.field = e.target.value; })} /></Field><Field label="Toán tử"><StudioSelect value={active.operator} onChange={e => updateNode(node => { if (node.type === 'condition') node.operator = e.target.value as typeof node.operator; })}>{['eq', 'ne', 'in', 'exists', 'all', 'any'].map(v => <option key={v}>{v}</option>)}</StudioSelect></Field><details className="advanced"><summary>Nâng cao</summary><JsonSetting label="Giá trị điều kiện (JSON)" value={active.value ?? null} apply={value => updateNode(node => { if (node.type === 'condition') node.value = value as Exclude<typeof node.value, undefined>; })} /></details><p className="my-2 text-[12.5px] leading-relaxed text-muted-foreground">Trường: result, checks.passed, checks.results, review.accepted, repair.rounds hoặc node.ID.status/outcome.</p></>}
                <div className="section-rule" /><button className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-danger" onClick={() => void removeNode()}>⌫ &nbsp; Xóa bước này</button></div> : selectedEdge !== null && flow.definition.edges[selectedEdge] ? <div className="inspector-scroll"><div className="connection-summary">{flow.definition.edges[selectedEdge]!.from} <span>→</span> {flow.definition.edges[selectedEdge]!.to}</div><Field label="Điều kiện chuyển bước"><StudioSelect value={flow.definition.edges[selectedEdge]!.outcome} onChange={e => mutate(next => { const edge = next.definition.edges[selectedEdge]; if (edge) edge.outcome = e.target.value as typeof edge.outcome; })}>{outcomes.map(value => <option key={value}>{value}</option>)}</StudioSelect></Field><button className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-danger" onClick={() => void removeEdge(selectedEdge)}>⌫ &nbsp; Xóa kết nối</button></div> : <div className="inspector-scroll"><div className="inspector-section">Cài đặt flow</div>
                <Field label="Mô tả"><Textarea rows={3} value={flow.description} onChange={e => mutate(next => { next.description = e.target.value; })} /></Field>
                <Field label="Số agent đồng thời"><Input type="number" min="1" value={flow.definition.limits.maxConcurrency} onChange={e => mutate(next => { next.definition.limits.maxConcurrency = Number(e.target.value); })} /></Field>
                <Field label="Giới hạn sửa toàn run"><Input type="number" min="0" value={flow.definition.limits.maxRepairRounds} onChange={e => mutate(next => { next.definition.limits.maxRepairRounds = Number(e.target.value); })} /></Field>
                <Field label="Thời gian xử lý (giây)"><Input type="number" min="1" value={flow.definition.limits.activeTimeSeconds} onChange={e => mutate(next => { next.definition.limits.activeTimeSeconds = Number(e.target.value); })} /></Field>
                <Field label="Ngân sách token" hint="Run tạm dừng giữa các bước khi đạt mức này; để trống là không giới hạn."><Input type="number" min="1000" step="1000" placeholder="Không giới hạn" value={flow.definition.limits.maxTokens ?? ''} onChange={e => mutate(next => { const value = Math.round(Number(e.target.value)); if (value >= 1) next.definition.limits.maxTokens = value; else delete next.definition.limits.maxTokens; })} /></Field>
                <Field label="Review code" hint={flow.definition.review === 'human' ? 'Flow không có bước review và không được commit; khi xong bạn xem rồi áp dụng thay đổi vào checkout.' : undefined}><StudioSelect value={flow.definition.review ?? 'independent'} onChange={e => mutate(next => { if (e.target.value === 'human') next.definition.review = 'human'; else delete next.definition.review; })}><option value="independent">Agent review độc lập trong flow</option><option value="human">Bạn tự review ngoài flow</option></StudioSelect></Field>
                <Field label="Workspace"><StudioSelect value={flow.definition.workspacePolicy} onChange={e => mutate(next => { next.definition.workspacePolicy = e.target.value as 'isolated' | 'current' | 'shared'; })}><option value="isolated">Worktree riêng</option><option value="current">Checkout hiện tại</option><option value="shared">Workspace chung (tuần tự hóa thao tác ghi)</option></StudioSelect></Field></div>}
              <label className="studio-keyboard-select"><span>Chọn bước bằng bàn phím</span><StudioSelect aria-label="Chọn bước" value={selected ?? ''} onChange={event => { setSelected(event.target.value || null); setSelectedEdge(null); setGraphNodes(nodes => nodes.map(node => ({ ...node, selected: node.id === event.target.value })));  }}><option value="">Tổng quan</option>{flow.definition.nodes.map(node => <option key={node.id} value={node.id}>{node.label} · {node.id}</option>)}</StudioSelect></label>
              <label className="studio-keyboard-select"><span>Chọn kết nối bằng bàn phím</span><StudioSelect aria-label="Chọn kết nối" value={selectedEdge ?? ''} onChange={event => { setSelectedEdge(event.target.value === '' ? null : Number(event.target.value)); setSelected(null); setGraphNodes(nodes => nodes.map(node => ({ ...node, selected: false })));  }}><option value="">Không chọn</option>{flow.definition.edges.map((edge, index) => <option key={index} value={index}>{edge.from} → {edge.to} · {edge.outcome}</option>)}</StudioSelect></label>
            </aside>;
  const flows = boot?.flows ?? [], hasFlows = flows.some(item => !item.archived);
  const dismiss = (clear: () => void) => <button type="button" aria-label="Đóng" onClick={clear} className="-my-0.5 ml-2 inline-flex size-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3.5" /></button>;
  return <Shell shell={shell} view={view} onView={setView} projectName={boot?.projectName} projectRoot={boot?.projectRoot} flows={flows} currentFlowId={flow?.flowId}
    onOpenFlow={id => void openFlow(id)} onCreateFlow={() => openCreate()}>
    <div className={view === 'runs' ? 'flex h-full flex-col' : view === 'flows' && flow ? 'studio-page' : shell === 'panel' ? 'px-5 py-4' : 'px-7 py-5'}>
      {error && <Callout tone="danger" icon={<CircleAlert />} className={cn('mb-3', view === 'runs' && 'mx-6 mt-3')}><div className="flex items-start"><span className="flex-1">{error}</span>{dismiss(() => setError(''))}</div></Callout>}
      {message && <Callout tone="success" icon={<CircleCheck />} className={cn('mb-3', view === 'runs' && 'mx-6 mt-3')}><div className="flex items-start"><span className="flex-1">{message}</span>{dismiss(() => setMessage(''))}</div></Callout>}
      {view === 'memory' ? <MemoryPanel /> : view === 'profiles' ? <ProfilePanel onOpenSkill={openSkills} /> : view === 'skills' ? <SkillsPanel focus={skillFocus} /> : view === 'runs' ? <div className="min-h-0 flex-1"><RunPanel {...(flow ? { flowId: flow.flowId } : {})} flows={flows} /></div>
        : !flow ? (boot && !hasFlows ? <NoFlows onPick={openCreate} /> : null) : <>
        <div className="studio-header"><div className="studio-heading"><div className="studio-title"><h1>{flow.name}</h1>{latestAuthor === 'ai' && <Tag>AI</Tag>}<span className="studio-draft">Bản nháp{dirty ? ' · chưa lưu' : ''}</span></div><p>dựa trên {flow.version ? `v${flow.version}` : 'bản mới'} · {flow.definition.nodes.length} bước · {flow.definition.edges.length} kết nối</p></div>
          <div className="studio-actions"><Tooltip label="Hoàn tác"><Button variant="ghost" size="icon" aria-label="Hoàn tác" disabled={!past.length} onClick={undo}><Undo2 /></Button></Tooltip><Tooltip label="Làm lại"><Button variant="ghost" size="icon" aria-label="Làm lại" disabled={!future.length} onClick={redo}><Redo2 /></Button></Tooltip>
            {compact && <Tooltip label="Thuộc tính"><Button variant="ghost" size="icon" aria-label="Thuộc tính" onClick={() => setInspectorOpen(true)}><PanelRight /></Button></Tooltip>}
            <Button variant="outline" disabled={busy} onClick={() => void action(async () => { const valid = await validate(flow); setMessage(valid ? 'Flow hợp lệ.' : ''); })}>Kiểm tra</Button>
            <Button variant="primary" disabled={busy} onClick={() => void action(async () => { if (!await validate(flow)) return; const expectedRevision = await saveDraft(); const saved = await api<{ version: { version: number } }>(`/api/flows/${encodeURIComponent(flow.flowId)}/publish`, 'POST', { expectedRevision, author: { kind: 'human' } }); setVersionsReload(value => value + 1); setMessage(`Đã lưu phiên bản ${saved.version.version}.`); })}>Lưu phiên bản</Button>
            <DropdownMenu><Tooltip label="Quản lý flow"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Quản lý flow"><Ellipsis /></Button></DropdownMenuTrigger></Tooltip><DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setVersionsOpen(true)}>So sánh phiên bản</DropdownMenuItem>
              <DropdownMenuItem shortcut="Ctrl S" onSelect={() => void action(async () => { await saveDraft(); setMessage('Đã lưu bản nháp.'); })}>Lưu nháp</DropdownMenuItem><DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void exportCanvas()}>Xuất ra .canvas</DropdownMenuItem><DropdownMenuItem onSelect={() => void importCanvas()}>Nhập từ .canvas</DropdownMenuItem><DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void manageFlow('rename')}>Đổi tên</DropdownMenuItem><DropdownMenuItem onSelect={() => void manageFlow('clone')}>Sao chép</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void manageFlow(boot?.flows.find(item => item.flowId === flow.flowId)?.archived ? 'restore' : 'archive')}>{boot?.flows.find(item => item.flowId === flow.flowId)?.archived ? 'Khôi phục' : 'Lưu trữ'}</DropdownMenuItem><DropdownMenuItem danger onSelect={() => void manageFlow('delete')}>Xóa vĩnh viễn…</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu></div></div>
        <FlowVersions flow={flow} open={versionsOpen} onOpenChange={setVersionsOpen} />
        <div className="workspace">
          <div className="workspace-body"><div className="palette" aria-label="Thêm bước"><Popover open={addOpen} onOpenChange={setAddOpen}><PopoverTrigger asChild><button className="rail-add" aria-label="Thêm bước" title="Thêm bước (/)"><Plus size={17} /></button></PopoverTrigger>          <PopoverContent side="right" align="start" aria-label="Thêm bước" className="studio-add-dialog w-[344px] p-0" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { const kind = paletteGroups.flatMap(group => group.kinds).find(item => `${kindInfo[item].label} ${item} ${paletteGroups.find(group => group.kinds.includes(item))?.label ?? ''}`.toLocaleLowerCase().includes(paletteQuery.trim().toLocaleLowerCase())); if (kind) { event.preventDefault(); addAfterSelected(kind); } } }}>
            <Input autoFocus aria-label="Tìm bước" placeholder="Tìm bước…" className="mx-4 my-3 w-[calc(100%-32px)]" value={paletteQuery} onChange={e => setPaletteQuery(e.target.value)} />
            <div className="studio-add-list">{paletteGroups.map(group => { const kinds = group.kinds.filter(kind => `${kindInfo[kind].label} ${kind} ${group.label}`.toLocaleLowerCase().includes(paletteQuery.trim().toLocaleLowerCase())); return kinds.length ? <div key={group.label}><h3>{group.label}</h3>{kinds.map(kind => <button key={kind} onClick={() => addAfterSelected(kind)}><KindIcon kind={kind} />{kindInfo[kind].label}</button>)}</div> : null; })}</div>
          </PopoverContent></Popover>
            {palette.map(kind => <Tooltip key={kind} label={`Thêm ${kindInfo[kind].label}`}><button aria-label={`Thêm ${kindInfo[kind].label}`} draggable onDragStart={event => { event.dataTransfer.setData('application/neomind-node', kind); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addNode(kind)}><KindIcon kind={kind} /></button></Tooltip>)}
          </div>

            <div className="canvas" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={event => { event.preventDefault(); const kind = event.dataTransfer.getData('application/neomind-node') as Kind; if (palette.includes(kind) && graphInstance) addNode(kind, graphInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}><ReactFlow<GraphNode, Edge> nodes={graphNodes} edges={edges} nodeTypes={nodeTypes} onInit={setGraphInstance} onNodesChange={onNodesChange} onConnect={connect} onConnectEnd={(event, state) => {
                if (!graphInstance || state.isValid || state.toNode || state.fromHandle?.type !== 'source' || !state.fromNode) return;
                const point = 'changedTouches' in event ? event.changedTouches[0] : event;
                if (!point || !(event.target instanceof Element) || !event.target.closest('.react-flow__pane')) return;
                setConnectMenu({ source: state.fromNode.id, x: point.clientX, y: point.clientY, position: graphInstance.screenToFlowPosition({ x: point.clientX, y: point.clientY }) });
              }} onNodeClick={(_, node) => { setSelected(node.id); setSelectedEdge(null); setConnectMenu(null); setInspectorOpen(true); }}
              onEdgeClick={(_, edge) => { setSelectedEdge(Number(edge.id.replace('edge-', ''))); setSelected(null); setConnectMenu(null); setInspectorOpen(true); }} onPaneClick={() => { setSelected(null); setSelectedEdge(null); setConnectMenu(null); }}
              onNodeDragStop={(_, node, dragged) => mutate(next => { for (const item of dragged.length ? dragged : [node]) next.layout[item.id] = item.position; })} colorMode={theme} deleteKeyCode={null} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1 }} minZoom={0.25} maxZoom={1.8}>
              <Background color="var(--border)" gap={23} size={1.1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor="var(--muted-foreground)" maskColor="var(--overlay)" /></ReactFlow>
              {connectMenu && <div className="connect-menu" role="dialog" aria-label="Chọn bước để kết nối" style={{ left: Math.max(12, Math.min(connectMenu.x, window.innerWidth - 235)), top: Math.max(12, Math.min(connectMenu.y, window.innerHeight - 350)) }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setConnectMenu(null); } if (event.key === 'Tab') { const buttons = Array.from(event.currentTarget.querySelectorAll('button')); const target = event.target; if (event.shiftKey && target === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); } else if (!event.shiftKey && target === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); } } }}><strong>Thêm bước được kết nối</strong>{palette.map(kind => <button type="button" autoFocus={kind === palette[0]} key={kind} onClick={() => addConnectedNode(kind)}><KindIcon kind={kind} /> &nbsp; {kindInfo[kind].label}</button>)}<button type="button" onClick={() => setConnectMenu(null)}>Hủy</button></div>}
              <div className="studio-problems"><button className="studio-problems-toggle" onClick={() => setProblemOpen(!problemOpen)} aria-expanded={problemOpen}>Vấn đề ({diagnostics.length}) <span>{problemOpen ? '⌄' : '⌃'}</span></button>{problemOpen && <div className="studio-problems-list">{diagnostics.length ? diagnostics.map((item, index) => <button key={`${item.code}-${index}`} onClick={() => { if (item.nodeId) selectProblem(item.nodeId); }}><CircleAlert />{item.message}</button>) : <p>Không có vấn đề.</p>}</div>}</div></div>
            {compact ? <Dialog open={inspectorOpen} onOpenChange={setInspectorOpen}><SheetContent className="studio-inspector-sheet w-[320px]" title={inspectorTitle}>{inspector}</SheetContent></Dialog> : inspector}</div>

        </div>
      </>}
    </div>
    <CreateFlowDialog open={createOpen} onOpenChange={setCreateOpen} initialTemplate={createTemplate} busy={busy} onCreate={input => void createFlow(input)} />
  </Shell>;
}
